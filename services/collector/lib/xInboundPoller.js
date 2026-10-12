'use strict';

/**
 * X (Twitter) inbound mention poller — X-PLUGIN P4.
 *
 * NO-ENV-ONLY-CONFIG (owner hard rule): X_INBOUND_POLL_ENABLED /
 * X_INBOUND_POLL_ORGS are today an operator-only env pair, exactly the shape
 * that rule forbids shipping to GA on its own — this is a dev/early-access
 * switch, not the final surface. Before GA this needs a dashboard-visible
 * Settings toggle (org-scoped, like QUOXFEED_ENABLED's
 * platformSettingsStore.getEffectiveFlag() precedent in feedScheduler.js)
 * plus docs/promo. Ships DARK by default: no timer is ever created unless
 * X_INBOUND_POLL_ENABLED === '1' AND X_INBOUND_POLL_ORGS lists at least one
 * org id.
 *
 * Shape mirrors lib/feedScheduler.js: a warmup setTimeout followed by a
 * recurring setInterval, both `.unref()`'d so neither holds the process open
 * or blocks a clean shutdown/test exit. Scoped down from feedScheduler's
 * multi-source dispatch table to this single job: poll get_mentions per
 * configured org and file an inbox info item per new mention.
 *
 * MANDATORY loop triad (house rule, 2026-08-30 CPU incident sweep —
 * embeddingBackfillScheduler.js 8e1a0958 / reflectionMiningScheduler.js
 * 88811f7f / feedScheduler.js's own cooldown are the same shape):
 *
 *  1. Failure counting DISTINCT from empty results — a get_mentions call
 *     (or credential resolution) that THROWS increments the org's
 *     failureStreak and this tick's orgsFailed counter. A successful call
 *     that returns zero new mentions is NOT a failure — it increments
 *     neither. Conflating the two would hide a dead credential/API outage
 *     behind an honest-looking "0 new mentions" log line forever.
 *  2. Capped backoff on zero-progress — an org whose poll FAILS is skipped
 *     for min(consecutiveFailures, FAILURE_COOLDOWN_CAP_TICKS) ticks
 *     (default cadence 15m -> a 1h backoff ceiling at the cap). A success
 *     (including a real zero-mentions result) clears the streak immediately.
 *     Benign "no new mentions this cycle" never triggers backoff — only
 *     genuine failures do; see point 1.
 *  3. Durable retirement of processed mention ids — every mention that gets
 *     an inbox item filed is recorded in x_inbound_seen_mentions
 *     (UNIQUE(org_id, mention_id)) BEFORE the org's since_id cursor
 *     (x_inbound_poll_state) is allowed to advance past it. Mentions are
 *     processed oldest-first and the loop stops at the first inbox-file
 *     failure for that org this tick, so since_id only ever advances to the
 *     last mention that was ACTUALLY filed — a mid-tick failure never
 *     silently loses a mention (it is retried, and de-duplicated by the seen
 *     table, next tick), and a mention that already has an inbox item can
 *     never resurface one.
 */

const { resolveConnectorCredentials } = require('./connectors/bridge');
const twitterConnector = require('./connectors/types/twitter.js');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// Warmup: first tick ~60s after boot (lets the collector finish its own
// boot/health-checking before this does network/DB work) — same default as
// feedScheduler.js's DEFAULT_WARMUP_MS.
const DEFAULT_WARMUP_MS = 60 * 1000;
// Interval: every 15 minutes.
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
// Per-org failure-streak cooldown cap — mirrors feedScheduler.js's
// SOURCE_FAILURE_COOLDOWN_CAP_TICKS (same rationale: bound how long a
// permanently-broken org's credential/API failure keeps burning a tick).
const FAILURE_COOLDOWN_CAP_TICKS = 4;

function initInboundPollStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_inbound_poll_state (
      org_id       TEXT PRIMARY KEY,
      since_id     TEXT,
      last_polled_at TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS x_inbound_seen_mentions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id     TEXT NOT NULL,
      mention_id TEXT NOT NULL,
      seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, mention_id)
    );
    CREATE INDEX IF NOT EXISTS idx_x_inbound_seen_org ON x_inbound_seen_mentions(org_id);
  `);

  // X-PLUGIN phase 11: last_polled_at is new. An instance created before this
  // phase already has the table, so CREATE TABLE IF NOT EXISTS above is a
  // no-op there and the column has to be added explicitly.
  try {
    const columns = db.prepare(`PRAGMA table_info(x_inbound_poll_state)`).all();
    if (!columns.some((c) => c.name === 'last_polled_at')) {
      db.exec(`ALTER TABLE x_inbound_poll_state ADD COLUMN last_polled_at TEXT`);
    }
  } catch {
    // A pragma/ALTER failure must not stop the collector booting; the due-check
    // below treats a missing timestamp as "due now", which is the safe read.
  }
}

function getSinceId(db, orgId) {
  const row = db.prepare(`SELECT since_id FROM x_inbound_poll_state WHERE org_id = ?`).get(orgId);
  return row ? row.since_id : null;
}

function setSinceId(db, orgId, sinceId) {
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO x_inbound_poll_state (org_id, since_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET since_id = excluded.since_id, updated_at = excluded.updated_at
  `).run(orgId, sinceId, nowIso);
}

function isMentionSeen(db, orgId, mentionId) {
  const row = db.prepare(`SELECT 1 FROM x_inbound_seen_mentions WHERE org_id = ? AND mention_id = ?`).get(orgId, mentionId);
  return Boolean(row);
}

function markMentionSeen(db, orgId, mentionId) {
  db.prepare(`
    INSERT OR IGNORE INTO x_inbound_seen_mentions (org_id, mention_id, seen_at)
    VALUES (?, ?, ?)
  `).run(orgId, mentionId, new Date().toISOString());
}

/* ─── Per-org opt-in and cadence (X-PLUGIN phase 11) ──────────────────────
 *
 * Owner-ratified 2026-09-12: mentions polling is a per-org choice with an
 * interval picker and a visible cost estimate, default OFF, because every
 * check spends a paid read.
 *
 * The two env vars keep their jobs, narrowed and written down:
 *   X_INBOUND_POLL_ENABLED  deployment-wide KILL SWITCH. Not '1' means no org
 *                           polls, whatever it has chosen. This is what an
 *                           operator reaches for when X billing has to stop
 *                           now, without editing any org's settings.
 *   X_INBOUND_POLL_ORGS     optional ALLOWLIST. When set, only these orgs may
 *                           poll even if they have opted in. When empty, any
 *                           org that has opted in may poll — which is the
 *                           point of making it a setting.
 *
 * An org is polled on a tick only when all four hold: the kill switch is on,
 * the allowlist permits it, X_MENTIONS_POLL_ENABLED is true for that org, and
 * its own interval has elapsed since its last poll. The base tick stays at 15
 * minutes (the finest interval offered); longer intervals are honoured by the
 * due-check, not by a second timer.
 */

/** Orgs that have switched mention polling ON, read from the settings table.
 * Best-effort: a missing table (fresh install) or a query failure is "no org
 * has opted in", which fails towards NOT spending money. */
function listOptedInOrgs(db) {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT org_id FROM org_platform_settings
      WHERE key = 'X_MENTIONS_POLL_ENABLED' AND value = 'true'
    `).all();
    return rows.map((r) => r.org_id).filter((id) => id && id !== '__instance__');
  } catch {
    return [];
  }
}

function getLastPolledAt(db, orgId) {
  try {
    const row = db.prepare(`SELECT last_polled_at FROM x_inbound_poll_state WHERE org_id = ?`).get(orgId);
    return row ? row.last_polled_at : null;
  } catch {
    return null;
  }
}

function setLastPolledAt(db, orgId, iso = new Date().toISOString()) {
  try {
    db.prepare(`
      INSERT INTO x_inbound_poll_state (org_id, last_polled_at, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(org_id) DO UPDATE SET last_polled_at = excluded.last_polled_at, updated_at = excluded.updated_at
    `).run(orgId, iso, new Date().toISOString());
  } catch {
    // A failure to record the timestamp makes the org look due next tick.
    // That costs one extra read at worst; refusing to poll would be worse.
  }
}

/**
 * Is this org due a poll now? Never polled = due. A clock that has gone
 * backwards (last_polled_at in the future) is treated as due rather than
 * locking the org out until the clock catches up.
 *
 * @returns {{ due: boolean, nextDueAt: string|null, intervalMinutes: number }}
 */
function isOrgDue(db, orgId, now = new Date()) {
  const xPostingStore = require('./xPostingStore.js');
  const { intervalMinutes } = xPostingStore.getOrgPollSettings(db, orgId);
  const last = getLastPolledAt(db, orgId);
  if (!last) return { due: true, nextDueAt: null, intervalMinutes };
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return { due: true, nextDueAt: null, intervalMinutes };
  const nextMs = lastMs + intervalMinutes * 60 * 1000;
  if (lastMs > now.getTime()) return { due: true, nextDueAt: null, intervalMinutes };
  return { due: now.getTime() >= nextMs, nextDueAt: new Date(nextMs).toISOString(), intervalMinutes };
}

/**
 * The orgs this tick should consider: opted-in, and inside the allowlist when
 * one is configured. Does NOT apply the due-check — runInboundPollTick does
 * that per org so it can log why an org was skipped.
 */
function resolvePollableOrgs(db, allowlist = []) {
  const optedIn = listOptedInOrgs(db);
  if (!allowlist.length) return optedIn;
  const permitted = new Set(allowlist);
  return optedIn.filter((orgId) => permitted.has(orgId));
}

/** Same idiom as feedScheduler.js's parseOrgIds — CSV env var to a clean list. */
function parseOrgIds(raw) {
  return String(raw || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** X's snowflake tweet ids exceed Number.MAX_SAFE_INTEGER — compare as BigInt
 * rather than risking float precision loss on a plain numeric compare. Falls
 * back to lexicographic (safe for same-length numeric-string ids) if either
 * value isn't BigInt-parseable, so a malformed id can never throw mid-tick. */
function higherMentionId(a, b) {
  if (!a) return b;
  if (!b) return a;
  try {
    return BigInt(a) > BigInt(b) ? a : b;
  } catch {
    return a > b ? a : b;
  }
}

/** Push one @mention as an INFO inbox item (never an approval — nothing here
 * needs a decide/execute step; "Draft reply" only deep-links into the
 * dashboard's X compose tab (`/x`), it does not draft or send anything
 * itself). Mirrors xTools.js's pushXApproval fetch/header shape and
 * discordWebhook.js's createInboxItem's kind:'info' shape. */
async function pushMentionInboxItem(orgId, mention) {
  if (!INTERNAL_SERVICE_KEY) {
    return { ok: false, error: 'INTERNAL_SERVICE_KEY not configured — cannot file inbox item' };
  }
  const handleLabel = mention.author_username ? `@${mention.author_username}` : 'a user';
  const link = `https://x.com/i/web/status/${mention.id}`;
  // Deep-link only — no auto-drafting tonight (X-PLUGIN P4 scope). Whether
  // /x actually reads `compose`/`reply_to_tweet_id` query params to prefill
  // anything is a frontend concern outside this poller's territory; today
  // this link just lands the owner on the X plugin tab.
  const composeLink = `/x?compose=reply&reply_to_tweet_id=${encodeURIComponent(mention.id)}`;

  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({
        kind: 'info',
        priority: 'normal',
        title: `@mention from ${handleLabel}`,
        body_md: [`> ${mention.text || ''}`, '', `[View on X](${link})`].join('\n'),
        payload: {
          source: 'x-plugin',
          mention_id: mention.id,
          custom_actions: [
            { action: 'open_link', label: 'Draft reply', style: 'primary', url: composeLink },
          ],
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `inbox API ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Polls ONE org's mentions and files an inbox item per new one. Throws on
 * credential-resolution or get_mentions fetch failure (the caller,
 * runInboundPollTick, is what turns that into the failure-streak/cooldown
 * bookkeeping) — an individual inbox-file failure inside the loop does NOT
 * throw, it stops the loop for this org this tick (see triad point 3 above)
 * and is reported back in the returned stats instead.
 *
 * @returns {{fetched:number, created:number, skippedSeen:number, failed:number}}
 */
async function pollOrgMentions(db, orgId, deps = {}) {
  const resolveCredentialsFn = deps.resolveConnectorCredentialsFn || resolveConnectorCredentials;
  const getToolsFn = deps.getToolsFn || twitterConnector.getTools;
  const pushItemFn = deps.pushMentionInboxItemFn || pushMentionInboxItem;

  const resolved = await resolveCredentialsFn(orgId, 'twitter');
  if (resolved.error) throw new Error(resolved.error);

  const tools = getToolsFn(resolved.credentials);
  const mentionsTool = tools.find((t) => t.name === 'get_mentions');
  if (!mentionsTool) throw new Error('get_mentions tool not registered on the twitter connector');

  const sinceId = getSinceId(db, orgId);
  const result = await mentionsTool.execute({ since_id: sinceId || undefined }, resolved.credentials, { orgId });
  const mentions = Array.isArray(result?.mentions) ? result.mentions : [];

  // Oldest-first so since_id advances monotonically and a mid-loop failure
  // leaves the durable cursor exactly at the last mention actually filed.
  const ordered = [...mentions].sort((a, b) => {
    try { return BigInt(a.id) > BigInt(b.id) ? 1 : -1; } catch { return a.id > b.id ? 1 : -1; }
  });

  let created = 0;
  let skippedSeen = 0;
  let failed = 0;
  let advancedSinceId = sinceId || null;

  for (const mention of ordered) {
    if (isMentionSeen(db, orgId, mention.id)) {
      skippedSeen++;
      advancedSinceId = higherMentionId(advancedSinceId, mention.id);
      continue;
    }

    const filed = await pushItemFn(orgId, mention);
    if (filed.ok) {
      markMentionSeen(db, orgId, mention.id);
      advancedSinceId = higherMentionId(advancedSinceId, mention.id);
      created++;
    } else {
      failed++;
      console.error(`[XInboundPoll] org=${orgId} mention=${mention.id}: failed to file inbox item — ${filed.error}`);
      // Stop here — do not advance since_id past an unfiled mention. It (and
      // anything after it) is retried next tick; already-filed ones above it
      // are safely skipped via the seen table, never re-filed.
      break;
    }
  }

  if (advancedSinceId && advancedSinceId !== sinceId) {
    setSinceId(db, orgId, advancedSinceId);
  }

  return { fetched: mentions.length, created, skippedSeen, failed };
}

function createCooldownState() {
  return { failureStreak: new Map(), cooldownTicks: new Map() };
}

/**
 * Runs one poll tick across every configured org. Never throws — every
 * per-org failure is caught, logged, and folded into that org's cooldown
 * state (see the module header's loop-triad comment).
 *
 * @returns {{orgsPolled:number, orgsSkipped:number, orgsFailed:number, totalCreated:number}}
 */
async function runInboundPollTick(db, orgIds, deps = {}, cooldownState = createCooldownState()) {
  let orgsPolled = 0;
  let orgsSkipped = 0;
  let orgsFailed = 0;
  let totalCreated = 0;

  for (const orgId of orgIds) {
    const cooldownRemaining = cooldownState.cooldownTicks.get(orgId) || 0;
    if (cooldownRemaining > 0) {
      orgsSkipped++;
      const nextRemaining = cooldownRemaining - 1;
      if (nextRemaining > 0) cooldownState.cooldownTicks.set(orgId, nextRemaining);
      else cooldownState.cooldownTicks.delete(orgId);
      console.log(`[XInboundPoll] org=${orgId}: cooling down after repeated failures — skipping (${nextRemaining} tick(s) remaining)`);
      continue;
    }

    // X-PLUGIN phase 11: an org on a 6-hourly interval is skipped on the 23
    // ticks between its polls. Counted as skipped, not failed — "not due" is
    // a healthy state, and conflating it with failure is exactly the lie the
    // loop-triad rule exists to prevent.
    const due = deps.skipDueCheck ? { due: true } : isOrgDue(db, orgId, deps.now instanceof Date ? deps.now : new Date());
    if (!due.due) {
      orgsSkipped++;
      console.log(`[XInboundPoll] org=${orgId}: not due (every ${due.intervalMinutes}m, next ${due.nextDueAt || 'unknown'}) — skipping`);
      continue;
    }

    try {
      const stats = await pollOrgMentions(db, orgId, deps);
      setLastPolledAt(db, orgId);
      orgsPolled++;
      totalCreated += stats.created;
      cooldownState.failureStreak.delete(orgId);
      cooldownState.cooldownTicks.delete(orgId);
      console.log(`[XInboundPoll] org=${orgId}: fetched=${stats.fetched} new=${stats.created} already-seen=${stats.skippedSeen} unfiled-failures=${stats.failed}`);
    } catch (err) {
      // Stamp the attempt even on failure. The read is charged before the X
      // call is made, so a failed poll has usually already cost money; and
      // because this timestamp is DURABLE, it is also what stops a restart
      // loop from re-polling every org 60 seconds after every boot (the
      // startup-triggered-scheduler hazard, which the in-memory cooldown
      // state below cannot prevent because it dies with the process).
      setLastPolledAt(db, orgId);
      orgsFailed++;
      const streak = (cooldownState.failureStreak.get(orgId) || 0) + 1;
      cooldownState.failureStreak.set(orgId, streak);
      const cooldownTicks = Math.min(streak, FAILURE_COOLDOWN_CAP_TICKS);
      cooldownState.cooldownTicks.set(orgId, cooldownTicks);
      console.error(`[XInboundPoll] org=${orgId}: poll failed (failure streak ${streak}, cooling down ${cooldownTicks} tick(s)) — ${err.message}`);
    }
  }

  // "skipped" now covers two healthy reasons (cooling down after failures, or
  // simply not due on this org's own interval), so the label no longer names
  // only one of them. The per-org lines above say which.
  console.log(`[XInboundPoll] tick complete: ${orgsPolled} org(s) polled ok, ${orgsSkipped} skipped (not due or cooling down), ${orgsFailed} failed, ${totalCreated} new mention item(s) filed, ${orgIds.length} org(s) opted in`);

  return { orgsPolled, orgsSkipped, orgsFailed, totalCreated };
}

/**
 * Starts the inbound mention poller. Dark by default: no timer is created
 * unless X_INBOUND_POLL_ENABLED === '1' and X_INBOUND_POLL_ORGS resolves to
 * at least one org id.
 *
 * @param {object} [deps]
 * @param {import('better-sqlite3').Database} deps.db - REQUIRED to actually
 *   start (durable since_id/seen-mention state needs it); missing db logs an
 *   error and returns without scheduling anything, same fail-loud-but-
 *   non-fatal posture as a misconfigured env pair.
 * @param {number} [deps.warmupMs] - override the warmup delay (tests)
 * @param {number} [deps.intervalMs] - override the recurring interval (tests)
 * @param {boolean} [deps.runNow] - skip the warmup timer and run tick(s) immediately (tests)
 * @param {number} [deps.runTimes] - with runNow, run this many sequential ticks (tests)
 * @param {function} [deps.setTimeoutFn] - injectable for tests
 * @param {function} [deps.setIntervalFn] - injectable for tests
 * @param {object} [deps.cooldownState] - injectable for tests (see createCooldownState)
 * @param {function} [deps.resolveConnectorCredentialsFn] - override credential resolution (tests)
 * @param {function} [deps.getToolsFn] - override twitterConnector.getTools (tests)
 * @param {function} [deps.pushMentionInboxItemFn] - override the inbox POST (tests)
 */
async function startXInboundPoller(deps = {}) {
  const enabled = process.env.X_INBOUND_POLL_ENABLED === '1';
  const allowlist = parseOrgIds(process.env.X_INBOUND_POLL_ORGS);

  // The deployment-wide kill switch. Nothing below runs while it is off, so an
  // operator can stop all X read spend without touching any org's settings.
  if (!enabled) {
    console.log('[XInboundPoll] disabled (X_INBOUND_POLL_ENABLED is not 1)');
    return;
  }

  const db = deps.db;
  if (!db) {
    console.error('[XInboundPoll] no db provided — cannot start (durable since_id/seen-mention state requires it)');
    return;
  }
  initInboundPollStore(db);

  const warmupMs = Number.isFinite(deps.warmupMs) ? deps.warmupMs : DEFAULT_WARMUP_MS;
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : DEFAULT_INTERVAL_MS;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const cooldownState = deps.cooldownState || createCooldownState();

  // X-PLUGIN phase 11: which orgs poll is now an org SETTING, and it is
  // resolved INSIDE the tick rather than once here — an org that opts in this
  // afternoon starts polling this afternoon, and one that opts out stops,
  // neither needing a collector restart. X_INBOUND_POLL_ORGS, when set,
  // narrows that to a named allowlist.
  const runTick = () => runInboundPollTick(db, resolvePollableOrgs(db, allowlist), deps, cooldownState);

  const optedInNow = resolvePollableOrgs(db, allowlist).length;
  console.log(`[XInboundPoll] enabled; ${optedInNow} org(s) opted in right now${allowlist.length ? ` (allowlist of ${allowlist.length})` : ''} (warmup ${Math.round(warmupMs / 1000)}s, base tick every ${Math.round(intervalMs / 60000)}m, each org polled on its own interval)`);

  if (deps.runNow) {
    const times = Number.isInteger(deps.runTimes) && deps.runTimes > 0 ? deps.runTimes : 1;
    let last;
    for (let i = 0; i < times; i++) last = await runTick();
    return last;
  }

  const warmupTimer = setTimeoutFn(() => {
    runTick();
    const intervalTimer = setIntervalFn(runTick, intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }, warmupMs);
  if (warmupTimer && typeof warmupTimer.unref === 'function') warmupTimer.unref();
}

module.exports = {
  startXInboundPoller,
  runInboundPollTick,
  pollOrgMentions,
  initInboundPollStore,
  getSinceId,
  setSinceId,
  isMentionSeen,
  markMentionSeen,
  parseOrgIds,
  createCooldownState,
  listOptedInOrgs,
  resolvePollableOrgs,
  isOrgDue,
  getLastPolledAt,
  setLastPolledAt,
  DEFAULT_WARMUP_MS,
  DEFAULT_INTERVAL_MS,
  FAILURE_COOLDOWN_CAP_TICKS,
};

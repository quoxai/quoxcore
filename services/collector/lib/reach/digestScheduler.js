/**
 * digestScheduler.js — BLAST-RADIUS-P4: the weekly reach least-privilege
 * digest scheduler.
 *
 * Same shape as lib/xPublishScheduler.js (see that file's module doc for the
 * full rationale) — an hourly, unref'd tick that never throws out of itself
 * and never manufactures repeat work from a restart:
 *
 *   FAILURE ACCOUNTING DISTINCT FROM EMPTY. An org with zero tool-execution
 *   envelopes in the trailing 7 days is never even considered — that is an
 *   empty tick, not a failure. An org that IS considered but whose inbox
 *   mint fails is counted and recorded as status='error', never folded into
 *   "nothing to do".
 *
 *   CAPPED "BACKOFF" — via the durable week-dedup row, not in memory. One
 *   reach_digest_runs(org_id, week_key) row (ok OR error) means this org's
 *   digest for this ISO week is DONE, full stop; a restart resumes that
 *   state rather than re-minting or re-erroring forever within the same
 *   week. The row for the NEXT week is a fresh attempt, not a retry.
 *
 *   DURABLE RETIREMENT. Every attempted org gets exactly one row per ISO
 *   week (status ok or error) and is never attempted again for that week.
 *
 * NO STARTUP-TRIGGERED WORK. Due-ness comes from "is there a row for this
 * org+week yet", never from process uptime — a restart loop cannot spam an
 * org with repeat digests.
 */

'use strict';

const { computeLeastPrivilege } = require('./leastPrivilege.js');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WARMUP_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly — the dedup row is what actually paces this to weekly
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_AGENT_CAP = 10;

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

/**
 * ISO-8601 week key, e.g. '2026-W38'. The whole durable-dedup contract in
 * reach_digest_runs keys off this string, so it must be a pure function of
 * `date` alone — no timezone-dependent "now" reads inside it.
 */
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNum = 1 + Math.round((d - firstThursday) / (7 * MS_PER_DAY));
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function hasRunForWeek(db, orgId, weekKey) {
  const row = db.prepare(`SELECT 1 FROM reach_digest_runs WHERE org_id = ? AND week_key = ?`).get(orgId, weekKey);
  return !!row;
}

function recordDigestRun(db, { orgId, weekKey, firedAt, status, error }) {
  db.prepare(`
    INSERT OR REPLACE INTO reach_digest_runs (org_id, week_key, fired_at, status, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(orgId, weekKey, firedAt, status, error || null);
}

/**
 * Distinct orgs with at least one tool-execution envelope in the window.
 * Mirrors leastPrivilege.js's isToolExecutionIntent() shape ('aocl.tool.execute'
 * or any '*.executed' suffix) directly in SQL rather than pulling every row
 * into JS just to filter — this only needs presence, not the rows.
 */
function listOrgsWithToolActivity(db, sinceIso) {
  return db.prepare(`
    SELECT DISTINCT org_id FROM envelopes
    WHERE org_id IS NOT NULL
      AND ts >= ?
      AND (intent = 'aocl.tool.execute' OR intent LIKE '%.executed')
  `).all(sinceIso).map((r) => r.org_id);
}

/** Up to `cap` distinct agent ids ("agent.<id>" from-address) active in the window for this org. */
function listActiveAgentIds(db, orgId, sinceIso, cap) {
  return db.prepare(`
    SELECT DISTINCT "from" AS from_addr FROM envelopes
    WHERE org_id = ?
      AND ts >= ?
      AND "from" LIKE 'agent.%'
      AND (intent = 'aocl.tool.execute' OR intent LIKE '%.executed')
    LIMIT ?
  `).all(orgId, sinceIso, cap).map((r) => r.from_addr.slice('agent.'.length)).filter(Boolean);
}

/** Same statement shape test/leastPrivilege.test.js's realQueryEnvelopes uses — the DI seam computeLeastPrivilege requires. */
function queryEnvelopesFromDb(db, filter) {
  return db.prepare(`
    SELECT * FROM envelopes
    WHERE org_id = @orgId
      AND "from" = @from
      AND (@after IS NULL OR ts >= @after)
    ORDER BY ts DESC
    LIMIT @limit
  `).all({
    orgId: filter.orgId,
    from: filter.from,
    after: filter.after ?? null,
    limit: filter.limit ?? 5000,
  });
}

/**
 * Compact, coverage-first per-agent summary table. Mirrors the CLI's
 * "coverage first" ordering (lib/commands/reach.js's `quox reach unused`) —
 * an org reading this in their inbox sees what could and couldn't be
 * observed before any unused-list claim.
 */
function renderDigestBodyMd({ weekKey, windowDays, perAgent }) {
  const lines = [
    `**Weekly reach least-privilege digest — ${weekKey}**`,
    '',
    `Predicted-vs-actual grants over the trailing ${windowDays} days, across this org's active agents. ` +
      'Coverage first: only the tools and credentials layers have any observed-usage source today. ' +
      'Hosts, egress and delegation are not-observed and never appear as "unused" below.',
    '',
    '| Agent | Tools coverage | Tools used/predicted | Unused tools | Credentials coverage | Creds used/predicted | Unused credentials |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const { agentId, result } of perAgent) {
    const tools = (result && result.layers && result.layers.tools) || {};
    const creds = (result && result.layers && result.layers.credentials) || {};
    lines.push(
      `| ${agentId} | ${tools.coverage || 'n/a'} | ${tools.used ?? 0}/${tools.predicted ?? 0} | ${(tools.unused_list || []).join(', ') || '—'} | ${creds.coverage || 'n/a'} | ${creds.used ?? 0}/${creds.predicted ?? 0} | ${(creds.unused_list || []).join(', ') || '—'} |`,
    );
  }
  if (perAgent.length === 0) {
    lines.push('| _none_ | — | — | — | — | — | — |');
  }
  lines.push('', 'Run `quox reach unused <agentId>` for the full report, including recommended edits.');
  return lines.join('\n');
}

/**
 * Best-effort inbox mint — same "log and return { ok:false }, never throw"
 * contract as lib/xPublishScheduler.js's fileFailureNotice.
 */
async function defaultMintInboxItem(orgId, { title, bodyMd }) {
  if (!INTERNAL_SERVICE_KEY) {
    console.error('[ReachDigestSched] INTERNAL_SERVICE_KEY not set, cannot mint the weekly digest inbox item');
    return { ok: false, error: 'INTERNAL_SERVICE_KEY not configured' };
  }
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': INTERNAL_SERVICE_KEY },
      body: JSON.stringify({
        title,
        body_md: bodyMd,
        kind: 'info',
        priority: 'low',
        payload: { source: 'reach-digest', kind: 'reach_weekly_digest' },
      }),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    if (!res.ok) return { ok: false, error: `inbox API ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * One tick. Never throws — a single org's failure must not stop the rest,
 * and the caller (startReachDigestScheduler) wraps this too as belt-and-braces.
 *
 * @returns {{ orgs_seen:number, minted:number, skipped:number, failed:number }}
 */
async function runDigestTick(db, deps = {}) {
  const now = deps.now instanceof Date ? deps.now : new Date();
  const weekKey = isoWeekKey(now);
  const windowDays = Number.isFinite(deps.windowDays) ? deps.windowDays : DEFAULT_WINDOW_DAYS;
  const agentCap = Number.isFinite(deps.agentCap) ? deps.agentCap : DEFAULT_AGENT_CAP;
  const sinceIso = new Date(now.getTime() - windowDays * MS_PER_DAY).toISOString();

  // Fail-safe default: an instance that never wires a real capability
  // resolver never mints digests, matching REACH_WEEKLY_DIGEST's own
  // default of 'off'.
  const isDigestEnabledFn = deps.isDigestEnabledFn || (() => false);
  const computeLeastPrivilegeFn = deps.computeLeastPrivilegeFn || computeLeastPrivilege;
  const mintInboxItem = deps.mintInboxItem || defaultMintInboxItem;

  const stats = { orgs_seen: 0, minted: 0, skipped: 0, failed: 0 };
  const activeOrgIds = listOrgsWithToolActivity(db, sinceIso);

  for (const orgId of activeOrgIds) {
    stats.orgs_seen += 1;
    try {
      if (hasRunForWeek(db, orgId, weekKey)) {
        stats.skipped += 1;
        continue;
      }

      let enabled = false;
      try {
        enabled = !!(await isDigestEnabledFn(orgId));
      } catch (err) {
        // A capability-check failure is a real failure, distinctly counted —
        // never silently treated as "off" and never silently as "on".
        recordDigestRun(db, { orgId, weekKey, firedAt: now.toISOString(), status: 'error', error: `capability check failed: ${err.message}` });
        stats.failed += 1;
        continue;
      }
      if (!enabled) {
        // Off for this org — no row written; the setting can change
        // mid-week and the next tick will re-check honestly.
        stats.skipped += 1;
        continue;
      }

      const agentIds = listActiveAgentIds(db, orgId, sinceIso, agentCap);
      const perAgent = [];
      for (const agentId of agentIds) {
        // eslint-disable-next-line no-await-in-loop
        const result = await computeLeastPrivilegeFn(
          { agentId, orgId, windowDays },
          {
            getCachedStaticReach: deps.getCachedStaticReach,
            queryEnvelopes: deps.queryEnvelopes || ((filter) => queryEnvelopesFromDb(db, filter)),
            fetchCredentialUsage: deps.fetchCredentialUsage,
            nowIso: deps.nowIso,
          },
        );
        perAgent.push({ agentId, result });
      }

      const bodyMd = renderDigestBodyMd({ weekKey, windowDays, perAgent });
      const mintResult = await mintInboxItem(orgId, {
        title: `Weekly reach digest — ${weekKey}`,
        bodyMd,
      });

      if (!mintResult || mintResult.ok === false) {
        recordDigestRun(db, { orgId, weekKey, firedAt: now.toISOString(), status: 'error', error: (mintResult && mintResult.error) || 'inbox mint failed' });
        stats.failed += 1;
        continue;
      }

      recordDigestRun(db, { orgId, weekKey, firedAt: now.toISOString(), status: 'ok' });
      stats.minted += 1;
    } catch (err) {
      // Belt-and-braces: any unexpected throw for this org is recorded and
      // counted, and the loop moves on to the next org rather than dying.
      recordDigestRun(db, { orgId, weekKey, firedAt: now.toISOString(), status: 'error', error: err.message });
      stats.failed += 1;
    }
  }

  if (stats.orgs_seen === 0) {
    console.log('[ReachDigestSched] tick: no orgs with tool-execution activity in the trailing window');
  } else {
    console.log(`[ReachDigestSched] tick: ${stats.orgs_seen} orgs seen, ${stats.minted} minted, ${stats.skipped} skipped, ${stats.failed} failed`);
  }
  return stats;
}

/**
 * Start the scheduler.
 *
 * @param {object} deps
 * @param {object} deps.db - REQUIRED, the collector's aeeDb (holds both
 *   envelopes and reach_digest_runs — migrations/aee/030-reach-digest-runs.sql)
 * @param {function} [deps.setTimeoutFn] / [deps.setIntervalFn] - test seams
 * @param {boolean} [deps.runNow] - run one tick immediately instead of timing (tests)
 * @param {function} [deps.isDigestEnabledFn] - (orgId) => boolean|Promise<boolean>
 * @param {function} [deps.getCachedStaticReach] / [deps.fetchCredentialUsage] - computeLeastPrivilege deps
 * @param {function} [deps.computeLeastPrivilegeFn] - override for tests
 * @param {function} [deps.mintInboxItem] - override for tests
 */
async function startReachDigestScheduler(deps = {}) {
  const db = deps.db;
  if (!db) {
    console.error('[ReachDigestSched] no db provided, not starting (durable dedup state requires it)');
    return;
  }

  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const warmupMs = Number.isFinite(deps.warmupMs) ? deps.warmupMs : DEFAULT_WARMUP_MS;
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : DEFAULT_INTERVAL_MS;

  const tick = () => runDigestTick(db, deps).catch((err) => {
    console.error(`[ReachDigestSched] tick failed entirely: ${err.message}`);
  });

  if (deps.runNow) return tick();

  console.log(`[ReachDigestSched] started (warmup ${Math.round(warmupMs / 1000)}s, tick every ${Math.round(intervalMs / 60000)}m). One digest per org per ISO week, opt-in via REACH_WEEKLY_DIGEST.`);

  const warmupTimer = setTimeoutFn(() => {
    tick();
    const intervalTimer = setIntervalFn(tick, intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
  }, warmupMs);
  if (warmupTimer && typeof warmupTimer.unref === 'function') warmupTimer.unref();
}

module.exports = {
  DEFAULT_WARMUP_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_AGENT_CAP,
  startReachDigestScheduler,
  runDigestTick,
  isoWeekKey,
  renderDigestBodyMd,
  defaultMintInboxItem,
};

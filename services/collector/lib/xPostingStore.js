/**
 * xPostingStore.js — durable, org-scoped X (Twitter) posting budget ledger.
 *
 * X-PLUGIN P2. A ledger table (one row per successfully-published post/reply,
 * `posted_at` timestamped) rather than a rolling counter column: counting via
 * a time-windowed COUNT(*) query is immune to reset-drift bugs (no cron job
 * has to zero a column at midnight, no server restart can lose "when did the
 * window start"), and it durably survives a collector restart — the ZERO
 * TOLERANCE persistence rule (no in-memory Maps for anything that must
 * survive a restart).
 *
 * Two windows enforced, both read from the SAME ledger:
 *  - CONFIG.DAILY_LIMIT (17): X's free-tier per-user posting cap over a
 *    trailing 24h.
 *  - CONFIG.MONTHLY_LIMIT (500): X's free-tier per-user posting cap over a
 *    trailing 30d.
 *
 * Rows are inserted ONLY on a confirmed successful publish (called from
 * xTools.js's executeXDecision, after the X API returns 2xx) — never on
 * filing/approval, so a denied or failed post never consumes budget.
 *
 * Table: x_post_ledger
 *   id         INTEGER PRIMARY KEY AUTOINCREMENT
 *   org_id     TEXT NOT NULL   -- mandatory, multi-tenant scoping
 *   tweet_id   TEXT            -- the X-assigned id of the published post
 *   kind       TEXT NOT NULL   -- 'post' | 'thread_post'
 *   posted_at  TEXT NOT NULL DEFAULT (datetime('now'))
 *
 * X-PLUGIN P2 HARDENING (adversarial review) — table: x_post_claims
 * A ledger row alone lets a decide-approve race exceed the budget: the
 * budget check (getBudgetStatus) and the X API call are not atomic with any
 * write, so two decide calls in flight for two different inbox items can
 * both see 16/17 used, both proceed, and both post — a TOCTOU overrun. The
 * claims table closes that gap AND doubles as:
 *   1. Atomic reservation — claimForApproval() recounts budget (posted rows
 *      + live pending claims) and inserts the claim row in ONE
 *      better-sqlite3 transaction, so two concurrent claims for the same
 *      window serialize through SQLite's writer lock rather than racing.
 *   2. The replay guard — inbox_item_id is UNIQUE. A second decide for an
 *      already-claimed item hits the existing row instead of inserting a
 *      new one; the caller (xTools.js) returns the row's recorded outcome
 *      rather than calling the X API again.
 *   3. The durable publish intent — the claim is inserted PENDING before
 *      the X API is ever called, and tweet_ids is appended after EACH
 *      individual 2xx (not just once at the end), so a crash mid-thread
 *      leaves the posted-so-far ids on the row, not only in memory.
 *
 * Table: x_post_claims
 *   id              INTEGER PRIMARY KEY AUTOINCREMENT
 *   inbox_item_id   TEXT NOT NULL UNIQUE  -- the replay guard
 *   org_id          TEXT NOT NULL
 *   action          TEXT NOT NULL   -- 'x.post' | 'x.thread' | 'x.delete'
 *   posts_reserved  INTEGER NOT NULL DEFAULT 1  -- budget slots this claim holds while pending
 *   status          TEXT NOT NULL DEFAULT 'pending'  -- pending | posted | failed
 *   tweet_ids       TEXT NOT NULL DEFAULT '[]'  -- JSON array, appended per successful tweet
 *   error           TEXT
 *   claimed_at      TEXT NOT NULL DEFAULT (datetime('now'))
 *   updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
 *
 * X-PLUGIN P4 (read tools + inbound polling, 2026-09-11) — table: x_read_ledger.
 * X's v2 read endpoints (get_tweet/get_user_tweets/search_recent/get_mentions
 * in connectors/types/twitter.js, plus the inbound mention poller) are
 * pay-per-use on X's API (roughly $0.005/read at time of writing) — unlike
 * posting, there is no free-tier daily/monthly cap X enforces for us, so
 * without our own budget an agent looping a read tool has no natural brake
 * and burns real money per call. CONFIG.dailyReadLimit is the guard, checked
 * and recorded atomically by checkAndRecordRead() (same
 * recount-then-insert-in-one-transaction shape as claimForApproval above).
 * A ledger row per read (not a rolling counter) for the same reset-drift and
 * restart-durability reasons the posting ledger is a ledger, not a counter.
 *
 * Table: x_read_ledger
 *   id       INTEGER PRIMARY KEY AUTOINCREMENT
 *   org_id   TEXT NOT NULL
 *   tool     TEXT             -- which read tool made the call (observability only)
 *   read_at  TEXT NOT NULL DEFAULT (datetime('now'))
 *
 * X-PLUGIN P5 (image attachments, 2026-09-11) — CONFIG.mediaRoot is the one
 * filesystem root all image attachments must resolve inside, org-scoped as
 * mediaRoot/<org_id>/. See resolveOrgMediaPath below for the containment
 * check (a Codex finding on the YouTube uploader is the reason this exists:
 * a bare path.join without a realpath-based containment check lets a
 * symlink, or a caller-supplied absolute path, walk out of the org's own
 * directory or into another org's).
 */

const fs = require('node:fs');
const path = require('node:path');

// CONFIG is the single source for the budget constants. Comment carried
// forward from the P2 hardening review: these become an org-scoped platform
// setting (a registered surface, NO-ENV-ONLY-CONFIG) before GA — today they
// are process-wide constants only. DAILY_LIMIT/MONTHLY_LIMIT stay exported
// individually too (back-compat for existing callers/tests); both read from
// this one object so there is never a second copy of the numbers to drift.
const CONFIG = {
  DAILY_LIMIT: 17,
  MONTHLY_LIMIT: 500,
  mediaRoot: '/var/lib/quox/x-media',
  // Deliberate conservative upload caps, configurable through CONFIG.
  // X permits 15MB GIFs and 512MB video; video defaults to 64MB here.
  maxGifBytes: 15 * 1024 * 1024,
  maxVideoBytes: 64 * 1024 * 1024,
  // Phase 10 slice B: daily cap on engagement writes (like/repost). A code
  // constant TODAY with the same settings-debt note the read cap carried
  // before phase 11: it must become an org-scoped platform setting before GA.
  dailyEngagementLimit: 50,
  // X-PLUGIN P4: pay-per-use read budget (get_tweet/get_user_tweets/
  // search_recent/get_mentions + the inbound mention poller, which calls
  // get_mentions on the same budget). Same NO-ENV-ONLY-CONFIG comment as
  // DAILY_LIMIT/MONTHLY_LIMIT above applies here too — this becomes an
  // org-scoped platform setting before GA (quoxify dimension 18: a
  // deployment-wide constant today is not yet a registered, admin-visible
  // Settings surface).
  dailyReadLimit: 200,
};

const DAILY_LIMIT = CONFIG.DAILY_LIMIT;
const MONTHLY_LIMIT = CONFIG.MONTHLY_LIMIT;

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

/* ─── Org-adjustable limits (X-PLUGIN phase 11) ───────────────────────────
 *
 * The three numbers above stopped being the last word in phase 11. They are
 * now the DEFAULTS behind three registered, org-scoped, admin-only platform
 * settings (X_DAILY_POST_LIMIT / X_MONTHLY_POST_LIMIT / X_DAILY_READ_LIMIT in
 * lib/platformCapabilities.js), which is the debt the CONFIG comment above has
 * promised since P2 and the NO-ENV-ONLY-CONFIG rule requires.
 *
 * Resolution goes through platformSettingsStore.getEffectiveFlag on the SAME
 * db handle the caller already passed in, rather than configResolver's cached
 * read-only connection: budget enforcement must see an admin's change on the
 * very next post, and must never read a value the current transaction cannot.
 *
 * Every call site is best-effort. An org with nothing stored, a db without the
 * settings table (every existing xPostingStore unit test), or a settings-store
 * failure all resolve to the code constants — a settings hiccup can never
 * silently RAISE a limit, and can never crash a publish.
 */
const HARD_CEILINGS = {
  DAILY_LIMIT: { min: 1, max: 100 },
  MONTHLY_LIMIT: { min: 1, max: 1500 },
  dailyReadLimit: { min: 1, max: 1000 },
};

let _platformSettings = null;
function platformSettings() {
  if (_platformSettings === null) {
    try {
      _platformSettings = require('./platformSettingsStore.js');
    } catch {
      _platformSettings = false; // resolved once, never retried per call
    }
  }
  return _platformSettings || null;
}

/** One setting, clamped to its hard ceiling, falling back to `fallback`.
 * Never throws: a bad stored value is ignored in favour of the constant. */
function resolveLimit(db, orgId, key, fallback, ceiling) {
  if (!db || !orgId) return fallback;
  const store = platformSettings();
  if (!store) return fallback;
  try {
    const effective = store.getEffectiveFlag(db, orgId, key);
    const num = Number(effective?.value);
    if (!Number.isFinite(num)) return fallback;
    const rounded = Math.floor(num);
    if (rounded < ceiling.min || rounded > ceiling.max) return fallback;
    return rounded;
  } catch {
    return fallback;
  }
}

/**
 * The posting + read limits in force for one org RIGHT NOW. This is the only
 * function in this module that decides what a limit is; getBudgetStatus,
 * claimForApproval, getReadBudgetStatus and checkAndRecordRead all read it,
 * so an admin's change cannot apply to the status panel but not to the gate.
 *
 * @returns {{ dailyLimit: number, monthlyLimit: number, dailyReadLimit: number,
 *             source: 'settings'|'defaults' }}
 */
function getOrgLimits(db, orgId) {
  const dailyLimit = resolveLimit(db, orgId, 'X_DAILY_POST_LIMIT', CONFIG.DAILY_LIMIT, HARD_CEILINGS.DAILY_LIMIT);
  const monthlyLimit = resolveLimit(db, orgId, 'X_MONTHLY_POST_LIMIT', CONFIG.MONTHLY_LIMIT, HARD_CEILINGS.MONTHLY_LIMIT);
  const dailyReadLimit = resolveLimit(db, orgId, 'X_DAILY_READ_LIMIT', CONFIG.dailyReadLimit, HARD_CEILINGS.dailyReadLimit);
  const isDefault = dailyLimit === CONFIG.DAILY_LIMIT
    && monthlyLimit === CONFIG.MONTHLY_LIMIT
    && dailyReadLimit === CONFIG.dailyReadLimit;
  return { dailyLimit, monthlyLimit, dailyReadLimit, source: isDefault ? 'defaults' : 'settings' };
}

/**
 * Mentions-polling settings for one org (X-PLUGIN phase 11, owner-ratified).
 * Default OFF. The deployment-wide env kill switch is NOT evaluated here —
 * xInboundPoller owns that, because "this org asked for polling" and "this
 * deployment permits polling at all" are two separate facts and the UI has to
 * be able to show both.
 *
 * @returns {{ enabled: boolean, interval: string, intervalMinutes: number }}
 */
const POLL_INTERVAL_MINUTES = { '15m': 15, '30m': 30, '1h': 60, '6h': 360, daily: 1440 };
const DEFAULT_POLL_INTERVAL = '1h';

function getOrgPollSettings(db, orgId) {
  const fallback = { enabled: false, interval: DEFAULT_POLL_INTERVAL, intervalMinutes: POLL_INTERVAL_MINUTES[DEFAULT_POLL_INTERVAL] };
  if (!db || !orgId) return fallback;
  const store = platformSettings();
  if (!store) return fallback;
  try {
    const enabled = store.getEffectiveFlag(db, orgId, 'X_MENTIONS_POLL_ENABLED')?.on === true;
    const raw = store.getEffectiveFlag(db, orgId, 'X_MENTIONS_POLL_INTERVAL')?.value;
    const interval = Object.prototype.hasOwnProperty.call(POLL_INTERVAL_MINUTES, raw) ? raw : DEFAULT_POLL_INTERVAL;
    return { enabled, interval, intervalMinutes: POLL_INTERVAL_MINUTES[interval] };
  } catch {
    return fallback;
  }
}

function initXPostingStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_post_ledger (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id    TEXT NOT NULL,
      tweet_id  TEXT,
      kind      TEXT NOT NULL,
      posted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_x_post_ledger_org_time ON x_post_ledger(org_id, posted_at);

    CREATE TABLE IF NOT EXISTS x_post_claims (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      inbox_item_id   TEXT NOT NULL UNIQUE,
      org_id          TEXT NOT NULL,
      action          TEXT NOT NULL,
      posts_reserved  INTEGER NOT NULL DEFAULT 1,
      status          TEXT NOT NULL DEFAULT 'pending',
      tweet_ids       TEXT NOT NULL DEFAULT '[]',
      error           TEXT,
      claimed_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_x_post_claims_org_time ON x_post_claims(org_id, claimed_at);

    CREATE TABLE IF NOT EXISTS x_read_ledger (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      org_id  TEXT NOT NULL,
      tool    TEXT,
      read_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_x_read_ledger_org_time ON x_read_ledger(org_id, read_at);

    CREATE TABLE IF NOT EXISTS x_account (
      org_id      TEXT PRIMARY KEY,
      user_id     TEXT,
      username    TEXT,
      name        TEXT,
      verified_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  /* X-PLUGIN phase 11: the Activity tab grew a text column and an author
   * column, and had nothing to put in either, because the drafted text lives
   * in the inbox card's action_params on the AUTH service and never reached
   * the collector's own tables. The columns rendered an honest "No text
   * recorded" on every row, which is honest and useless.
   *
   * A short preview and the initiator are now stored on the claim at decide
   * time. Deliberately a PREVIEW, not the whole post: this table is a budget
   * ledger, not a content store, and an approval record does not need to
   * become a second copy of everything ever drafted.
   *
   * Added by ALTER because instances created before this phase already have
   * the table, so CREATE TABLE IF NOT EXISTS above is a no-op for them. */
  for (const [column, ddl] of [['text_preview', 'TEXT'], ['author', 'TEXT']]) {
    try {
      const columns = db.prepare('PRAGMA table_info(x_post_claims)').all();
      if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE x_post_claims ADD COLUMN ${column} ${ddl}`);
      }
    } catch {
      // Never block collector boot on a column that only enriches a display.
    }
  }
}

/** A short, safe preview of what was drafted. Never the whole post. */
function buildTextPreview(actionParams = {}) {
  const first = typeof actionParams.text === 'string'
    ? actionParams.text
    : Array.isArray(actionParams.texts)
      ? actionParams.texts[0]
      : Array.isArray(actionParams.posts)
        ? actionParams.posts[0]?.text
        : null;
  if (typeof first !== 'string' || !first.trim()) return null;
  const flat = first.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** X-PLUGIN UI: remember WHICH account this org is connected as.
 *
 * The handle is only ever learnt from a live verify_credentials call, and that
 * call costs a request against X's pay-per-use API. Before this table the
 * dashboard re-paid for it on every mount just to print "@handle" in a header,
 * and a fresh browser (or any browser that had not personally run the setup
 * wizard) showed the plugin as unconfigured because the only record that the
 * org was connected lived in localStorage. Both are fixed by writing the
 * identity down here, server-side, once per successful verify.
 *
 * Write is best-effort by design: failing to cache an identity must never turn
 * a working verify_credentials call into an error.
 */
function saveAccountIdentity(db, { orgId, userId, username, name }) {
  if (!db) return { ok: false, error: 'X account store is not initialized' };
  if (!orgId) throw new Error('orgId is required to save an X account identity');
  db.prepare(`
    INSERT INTO x_account (org_id, user_id, username, name, verified_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET
      user_id     = excluded.user_id,
      username    = excluded.username,
      name        = excluded.name,
      verified_at = excluded.verified_at
  `).run(orgId, userId || null, username || null, name || null, new Date().toISOString());
  return { ok: true };
}

/** The stored identity for an org, or null if this org has never completed a
 * live verify. null means "we do not know yet", NEVER "not connected" — the
 * caller must not render it as a disconnected state. */
function getAccountIdentity(db, orgId) {
  if (!db || !orgId) return null;
  const row = db.prepare(`
    SELECT org_id, user_id, username, name, verified_at
    FROM x_account WHERE org_id = ?
  `).get(orgId);
  if (!row) return null;
  return {
    orgId: row.org_id,
    userId: row.user_id,
    username: row.username,
    name: row.name,
    verifiedAt: row.verified_at,
  };
}

/** Record one successfully-published post/reply. Never call this for a
 * denied or failed publish attempt — this is the ONLY place budget is
 * consumed in the ledger (the claims table separately reserves budget while
 * a decide is in flight — see claimForApproval).
 *
 * posted_at is stamped in JS (new Date().toISOString()), NOT SQLite's
 * datetime('now') — the two produce different string formats ("...T...Z"
 * vs "... " space-separated) that sort inconsistently against each other in
 * a plain lexicographic WHERE posted_at >= ? comparison, which silently
 * undercounts recent posts. Every posted_at in this table and every
 * comparison bound in getBudgetStatus/countSince MUST be the same
 * toISOString() shape. */
function recordPost(db, { orgId, tweetId, kind = 'post' }) {
  if (!orgId) throw new Error('orgId is required to record an X post');
  db.prepare(`
    INSERT INTO x_post_ledger (org_id, tweet_id, kind, posted_at)
    VALUES (?, ?, ?, ?)
  `).run(orgId, tweetId || null, kind, new Date().toISOString());
}

/** Count published posts for orgId with posted_at >= sinceIso. */
function countSince(db, orgId, sinceIso) {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM x_post_ledger
    WHERE org_id = ? AND posted_at >= ?
  `).get(orgId, sinceIso);
  return row ? row.n : 0;
}

/** Count PENDING claims' reserved slots for orgId claimed since sinceIso.
 * Excludes 'posted' claims (already reflected in x_post_ledger via
 * recordPost — counting both would double-count) and 'failed' claims (a
 * failed publish releases its reservation, per the P2 review). */
function countPendingClaimsSince(db, orgId, sinceIso) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(posts_reserved), 0) as n FROM x_post_claims
    WHERE org_id = ? AND status = 'pending' AND claimed_at >= ?
  `).get(orgId, sinceIso);
  return row ? row.n : 0;
}

/** Phase 10 slice B: engagement writes (like/repost) live in the SAME claims
 * table as posts (one replay guard, one audit surface) but count against
 * their own daily cap. pending counts alongside posted for the same
 * in-flight-decide reason countLiveSince exists. */
const ENGAGEMENT_ACTIONS = new Set(['x.like', 'x.repost']);

function countEngagementSince(db, orgId, sinceIso) {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM x_post_claims
    WHERE org_id = ? AND action IN ('x.like', 'x.repost')
      AND status IN ('pending', 'posted') AND claimed_at >= ?
  `).get(orgId, sinceIso);
  return row ? row.n : 0;
}

function getEngagementBudgetStatus(db, orgId, now = new Date()) {
  const dailySinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const used = countEngagementSince(db, orgId, dailySinceIso);
  return {
    used,
    limit: CONFIG.dailyEngagementLimit,
    remaining: Math.max(0, CONFIG.dailyEngagementLimit - used),
  };
}

/** Live usage = durably-posted ledger rows + still-pending claims in the
 * same window. This is what claimForApproval recounts inside its
 * transaction — using getBudgetStatus's ledger-only count here would let a
 * second in-flight decide slip through before the first one's ledger row
 * lands. */
function countLiveSince(db, orgId, sinceIso) {
  return countSince(db, orgId, sinceIso) + countPendingClaimsSince(db, orgId, sinceIso);
}

/** Current budget status for orgId, both windows, computed from the live
 * ledger (never a cached/rolling counter). `now` is injectable for tests.
 * Reports LEDGER usage only (posted, confirmed) — this is the read-only
 * status surface (x_budget_status tool); claimForApproval is what actually
 * gates execution and additionally counts live pending claims. */
function getBudgetStatus(db, orgId, now = new Date()) {
  const dailySinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const monthlySinceIso = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();

  const dailyUsed = countSince(db, orgId, dailySinceIso);
  const monthlyUsed = countSince(db, orgId, monthlySinceIso);
  const limits = getOrgLimits(db, orgId);

  return {
    dailyUsed,
    dailyLimit: limits.dailyLimit,
    dailyRemaining: Math.max(0, limits.dailyLimit - dailyUsed),
    monthlyUsed,
    monthlyLimit: limits.monthlyLimit,
    monthlyRemaining: Math.max(0, limits.monthlyLimit - monthlyUsed),
    // X-PLUGIN phase 11: these three turn "16/17" from a number the owner has
    // to interpret into one the UI can explain. The window is ROLLING, so a
    // day-old reading of 16/17 is not stale, it has silently refilled — the
    // owner read exactly that and assumed the page was broken.
    limitsSource: limits.source,
    windowHours: 24,
    dailyFreesAt: oldestPostInWindowFreesAt(db, orgId, dailySinceIso),
    monthlyFreesAt: oldestPostInWindowFreesAt(db, orgId, monthlySinceIso, THIRTY_DAYS_MS),
  };
}

/**
 * When the oldest post still inside the rolling window ages out of it, and so
 * hands its slot back. null when nothing is in the window (nothing to free —
 * the budget is already whole).
 */
function oldestPostInWindowFreesAt(db, orgId, sinceIso, windowMs = DAY_MS) {
  try {
    const row = db.prepare(`
      SELECT MIN(posted_at) AS oldest FROM x_post_ledger
      WHERE org_id = ? AND posted_at >= ?
    `).get(orgId, sinceIso);
    if (!row || !row.oldest) return null;
    const oldestMs = Date.parse(row.oldest);
    if (!Number.isFinite(oldestMs)) return null;
    return new Date(oldestMs + windowMs).toISOString();
  } catch {
    return null;
  }
}

/** Parse a claims row's JSON tweet_ids column into a real array; a single
 * shared helper so getClaim/claimForApproval never disagree on shape. */
function parseClaimRow(row) {
  if (!row) return null;
  let tweetIds = [];
  try { tweetIds = JSON.parse(row.tweet_ids || '[]'); } catch { tweetIds = []; }
  return { ...row, tweet_ids: tweetIds };
}

/** Look up the claim for an inbox item, or null if none exists yet. */
function getClaim(db, orgId, inboxItemId) {
  // Quoxify audit 2026-09-12 (SCOPED): every claim read carries the org
  // predicate so an inbox item id can never reach across tenants.
  const row = db.prepare(`SELECT * FROM x_post_claims WHERE inbox_item_id = ? AND org_id = ?`).get(inboxItemId, orgId);
  return parseClaimRow(row);
}

/**
 * Atomically recheck budget and reserve `postsNeeded` slots for a decide-
 * approve, keyed by inbox_item_id (the replay guard). Runs entirely inside
 * one better-sqlite3 transaction so the recount-then-insert is not
 * interruptible by a concurrent claim for a different item.
 *
 * @returns one of:
 *   { claimed: true, replay: false, claim }            — reserved, proceed to call X
 *   { claimed: false, replay: true, claim }             — already decided once; caller must NOT call X again
 *   { claimed: false, replay: false, error }            — budget would be exceeded; refuse honestly
 */
function claimForApproval(db, { orgId, inboxItemId, action, postsNeeded = 1, now = new Date(), textPreview = null, author = null }) {
  if (!orgId) throw new Error('orgId is required to claim an X posting slot');
  if (!inboxItemId) throw new Error('inboxItemId is required to claim an X posting slot');
  if (!action) throw new Error('action is required to claim an X posting slot');

  const txn = db.transaction(() => {
    const existingRow = db.prepare(`SELECT * FROM x_post_claims WHERE inbox_item_id = ? AND org_id = ?`).get(inboxItemId, orgId);
    if (existingRow) {
      return { claimed: false, replay: true, claim: parseClaimRow(existingRow) };
    }

    // Phase 10 slice B: engagement writes reserve NO posting slots but have
    // their own daily cap, rechecked here inside the transaction for the same
    // reason the posting limits are: the count at draft time is advisory,
    // this one is the enforcement.
    if (ENGAGEMENT_ACTIONS.has(action)) {
      const dailySinceIso = new Date(now.getTime() - DAY_MS).toISOString();
      const used = countEngagementSince(db, orgId, dailySinceIso);
      if (used + 1 > CONFIG.dailyEngagementLimit) {
        return {
          claimed: false,
          replay: false,
          error: `Daily X engagement budget would be exceeded (${used}/${CONFIG.dailyEngagementLimit} already used today).`,
        };
      }
    }

    if (postsNeeded > 0) {
      const dailySinceIso = new Date(now.getTime() - DAY_MS).toISOString();
      const monthlySinceIso = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
      const dailyLive = countLiveSince(db, orgId, dailySinceIso);
      const monthlyLive = countLiveSince(db, orgId, monthlySinceIso);
      // X-PLUGIN phase 11: the org's own limits, resolved at APPROVAL time
      // rather than read from the constants. A limit an admin lowered after
      // the draft was filed must bite here, which is the whole point of
      // rechecking inside the transaction.
      const limits = getOrgLimits(db, orgId);

      if (dailyLive + postsNeeded > limits.dailyLimit) {
        return {
          claimed: false,
          replay: false,
          error: `Daily X posting budget would be exceeded (${dailyLive}/${limits.dailyLimit} already live, this needs ${postsNeeded} more).`,
        };
      }
      if (monthlyLive + postsNeeded > limits.monthlyLimit) {
        return {
          claimed: false,
          replay: false,
          error: `Monthly X posting budget would be exceeded (${monthlyLive}/${limits.monthlyLimit} already live, this needs ${postsNeeded} more).`,
        };
      }
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO x_post_claims (inbox_item_id, org_id, action, posts_reserved, status, tweet_ids, claimed_at, updated_at, text_preview, author)
      VALUES (?, ?, ?, ?, 'pending', '[]', ?, ?, ?, ?)
    `).run(inboxItemId, orgId, action, postsNeeded, nowIso, nowIso, textPreview, author);

    const row = db.prepare(`SELECT * FROM x_post_claims WHERE inbox_item_id = ? AND org_id = ?`).get(inboxItemId, orgId);
    return { claimed: true, replay: false, claim: parseClaimRow(row) };
  });

  return txn();
}

/** Append one successfully-published tweet id to a claim's durable progress
 * record. Called after EACH 2xx in a thread (not just at the end) so a
 * crash between tweet N and N+1 leaves tweet N's id on the row. */
function appendClaimTweetId(db, orgId, inboxItemId, tweetId) {
  const row = db.prepare(`SELECT tweet_ids FROM x_post_claims WHERE inbox_item_id = ? AND org_id = ?`).get(inboxItemId, orgId);
  if (!row) return;
  let ids = [];
  try { ids = JSON.parse(row.tweet_ids || '[]'); } catch { ids = []; }
  ids.push(tweetId);
  db.prepare(`UPDATE x_post_claims SET tweet_ids = ?, updated_at = ? WHERE inbox_item_id = ? AND org_id = ?`)
    .run(JSON.stringify(ids), new Date().toISOString(), inboxItemId, orgId);
}

/** Mark a claim fully published — the durable "done" state; a replay after
 * this point returns the recorded tweet_ids rather than posting again. */
function markClaimPosted(db, orgId, inboxItemId) {
  db.prepare(`UPDATE x_post_claims SET status = 'posted', updated_at = ? WHERE inbox_item_id = ? AND org_id = ?`)
    .run(new Date().toISOString(), inboxItemId, orgId);
}

/** Mark a claim failed. `error` is recorded for an honest replay message.
 * A failed claim's posts_reserved no longer counts toward countLiveSince
 * (only 'pending'/ledger rows do) — this is what "releases" the budget a
 * failed publish had reserved, per the P2 review. Any tweet_ids already
 * appended before the failure are left in place (thread partial progress
 * stays durable). */
function markClaimFailed(db, orgId, inboxItemId, errorMessage) {
  db.prepare(`UPDATE x_post_claims SET status = 'failed', error = ?, updated_at = ? WHERE inbox_item_id = ? AND org_id = ?`)
    .run(errorMessage || null, new Date().toISOString(), inboxItemId, orgId);
}

/** X-PLUGIN P5: resolve a caller-supplied image path (an absolute path, or a
 * path relative to the org's media root) to a real, containment-checked
 * absolute path under CONFIG.mediaRoot/<org_id>/.
 *
 * Symlink-safe: fs.realpathSync is run on BOTH the org root and the
 * candidate file, so a symlink sitting inside the org's own directory that
 * points outside it is caught (resolving only the unresolved path string,
 * the defect this mirrors from the YouTube uploader finding, would miss
 * exactly this case). An absolute input path is honoured only when its real
 * path resolves inside the SAME org's root — this is what stops org A from
 * referencing org B's subdirectory by absolute path.
 *
 * Returns { ok:true, absolutePath, relativePath } on success (relativePath
 * is relative to the org root, the only form ever safe to persist in an
 * approval card's action_params) or { ok:false, error } naming the problem
 * honestly (org directory missing, file missing, or path escapes the root).
 */
function resolveOrgMediaPath(orgId, inputPath) {
  if (!orgId) return { ok: false, error: 'orgId is required to resolve a media path' };
  if (!inputPath || typeof inputPath !== 'string') {
    return { ok: false, error: 'image path is required' };
  }

  const orgRoot = path.join(CONFIG.mediaRoot, String(orgId));
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(orgRoot, inputPath);

  let realOrgRoot;
  try {
    realOrgRoot = fs.realpathSync(orgRoot);
  } catch {
    return { ok: false, error: `media directory for this org does not exist: ${orgRoot}` };
  }

  let realCandidate;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return { ok: false, error: `image file not found: ${inputPath}` };
  }

  const relFromRoot = path.relative(realOrgRoot, realCandidate);
  const escapes = relFromRoot === '' || relFromRoot === '..' || relFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relFromRoot);
  if (escapes) {
    return { ok: false, error: `image path escapes the org media root: ${inputPath}` };
  }

  return { ok: true, absolutePath: realCandidate, relativePath: relFromRoot };
}

/* ─── Upload destination resolution (X-PLUGIN phase 11) ───────────────────
 *
 * resolveOrgMediaPath above answers "may this org attach THIS EXISTING file",
 * and leans on realpathSync for its symlink safety. An upload has no file to
 * realpath yet, so it needs its own resolver — and a weaker one would be the
 * whole vulnerability, since the destination name comes from a browser.
 *
 * The posture here is stronger than sanitising: the stored filename is
 * CONSTRUCTED server-side (slug + timestamp + random + allowlisted extension)
 * and the client's filename only ever contributes to the slug, with everything
 * outside [a-z0-9-] discarded. A filename of "../../etc/passwd" cannot survive
 * that, and the containment check below then re-proves it independently.
 */
const UPLOAD_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
]);

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** A safe, collision-resistant stored name derived from (but never trusting)
 * the client's filename. */
function buildMediaFilename(originalName, extension) {
  const stem = String(originalName || '')
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stem || 'image'}-${stamp}-${rand}${extension}`;
}

/**
 * Resolve (and create) the absolute destination for one uploaded image inside
 * the calling org's media root, refusing anything that would land outside it.
 *
 * @param {string} orgId
 * @param {string} originalName - the browser-supplied filename, never trusted
 * @param {string} mimeType - must be in UPLOAD_EXTENSIONS
 * @param {{ mediaRoot?: string }} [opts] - root override for tests only
 * @returns {{ ok: true, absolutePath, relativePath, filename } | { ok: false, error }}
 */
function resolveOrgMediaTarget(orgId, originalName, mimeType, opts = {}) {
  if (!orgId) return { ok: false, error: 'orgId is required to store media' };
  // The org id becomes a path segment. A JWT claim is signed data, not a path.
  if (typeof orgId !== 'string' || /[/\\]|\.\./.test(orgId) || orgId.includes('\0')) {
    return { ok: false, error: 'invalid org id' };
  }

  const extension = UPLOAD_EXTENSIONS.get(String(mimeType || '').toLowerCase());
  if (!extension) {
    return {
      ok: false,
      error: `unsupported image type: ${mimeType || 'unknown'}. X posts accept png, jpg, webp and gif only.`,
    };
  }

  const root = opts.mediaRoot || CONFIG.mediaRoot;
  const orgRoot = path.join(root, String(orgId));
  try {
    fs.mkdirSync(orgRoot, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not create the org media directory: ${e.message}` };
  }

  const filename = buildMediaFilename(originalName, extension);
  const absolutePath = path.join(orgRoot, filename);

  // Independent containment proof. buildMediaFilename cannot emit a separator
  // today; this check means a future change to it still cannot write outside
  // the org root without failing here first.
  let realOrgRoot;
  try {
    realOrgRoot = fs.realpathSync(orgRoot);
  } catch {
    return { ok: false, error: 'org media directory is not readable' };
  }
  const rel = path.relative(realOrgRoot, path.resolve(absolutePath));
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return { ok: false, error: 'refusing to write outside the org media root' };
  }

  return { ok: true, absolutePath, relativePath: filename, filename };
}

/** Count reads for orgId with read_at >= sinceIso. Mirrors countSince above,
 * kept as its own function (rather than a generic table param) so a future
 * read-ledger-specific column doesn't force countSince's post-ledger callers
 * to change shape too. */
function countReadsSince(db, orgId, sinceIso) {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM x_read_ledger
    WHERE org_id = ? AND read_at >= ?
  `).get(orgId, sinceIso);
  return row ? row.n : 0;
}

/** Current read-budget status for orgId (one window: trailing 24h — X's read
 * pricing has no monthly cap the way posting's free tier does, so there is
 * only one window here, unlike getBudgetStatus above). `now` is injectable
 * for tests. */
function getReadBudgetStatus(db, orgId, now = new Date()) {
  const sinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const dailyUsed = countReadsSince(db, orgId, sinceIso);
  const dailyLimit = getOrgLimits(db, orgId).dailyReadLimit;
  return {
    dailyUsed,
    dailyLimit,
    dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
    windowHours: 24,
  };
}

/**
 * Atomically recheck the read budget and record one read, in a single
 * better-sqlite3 transaction (same recount-then-insert shape as
 * claimForApproval above) — closes the same TOCTOU gap a plain
 * check-then-insert would leave between two concurrent read calls for the
 * same org.
 *
 * @returns { ok: true, dailyUsed, dailyLimit } on success (the read IS
 *   recorded), or { ok: false, error } naming the limit honestly when the
 *   budget would be exceeded (the read is NOT recorded — a refused call
 *   never consumes budget).
 */
function checkAndRecordRead(db, orgId, { tool = null, now = new Date() } = {}) {
  if (!orgId) throw new Error('orgId is required to record an X read');

  const txn = db.transaction(() => {
    const sinceIso = new Date(now.getTime() - DAY_MS).toISOString();
    const used = countReadsSince(db, orgId, sinceIso);
    // X-PLUGIN phase 11: org-adjustable read ceiling, resolved inside the
    // transaction for the same reason the posting limits are.
    const dailyLimit = getOrgLimits(db, orgId).dailyReadLimit;
    if (used >= dailyLimit) {
      return {
        ok: false,
        error: `Daily X read budget exhausted (${used}/${dailyLimit} reads in the last 24h; X read calls are pay-per-use, roughly $0.005 each). Try again later.`,
      };
    }
    db.prepare(`
      INSERT INTO x_read_ledger (org_id, tool, read_at)
      VALUES (?, ?, ?)
    `).run(orgId, tool, new Date().toISOString());
    return { ok: true, dailyUsed: used + 1, dailyLimit };
  });

  return txn();
}

module.exports = {
  CONFIG,
  DAILY_LIMIT,
  MONTHLY_LIMIT,
  HARD_CEILINGS,
  POLL_INTERVAL_MINUTES,
  getOrgLimits,
  getOrgPollSettings,
  buildTextPreview,
  initXPostingStore,
  recordPost,
  countSince,
  countLiveSince,
  getBudgetStatus,
  getClaim,
  claimForApproval,
  appendClaimTweetId,
  markClaimPosted,
  markClaimFailed,
  resolveOrgMediaPath,
  resolveOrgMediaTarget,
  buildMediaFilename,
  UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  countReadsSince,
  getReadBudgetStatus,
  checkAndRecordRead,
  ENGAGEMENT_ACTIONS,
  countEngagementSince,
  getEngagementBudgetStatus,
  saveAccountIdentity,
  getAccountIdentity,
};

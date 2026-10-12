'use strict';

/**
 * Calendar-Q store — the collector-owned, org-scoped source of truth for the
 * Calendar-Q plugin's connections, generations, occurrences, operations,
 * layers and receipts.
 *
 * Persistence idiom mirrors lib/inboxq/store.js: a lazily-opened
 * better-sqlite3 database at CALENDARQ_DB_PATH (default
 * /var/lib/quox/calendarq.db), ':memory:' (or an explicit path) in tests.
 * Every table carries org_id NOT NULL and every read filters on it — a
 * different org must never see another org's calendars, operations or
 * receipts (repo CLAUDE.md, ZERO TOLERANCE multi-tenant scoping).
 *
 * SECURITY: this store NEVER holds a provider credential's plaintext. A
 * connection row holds a credential_ref (a vault reference) only, exactly
 * the same discipline as inboxq's credential_id — the real secret stays in
 * the vault and is resolved just-in-time by the sync path.
 *
 * Tables:
 *   calendarq_connections — a connected calendar resource (org, provider,
 *                            resource id, a reference to its credential)
 *   calendarq_generations — one staged-then-published SNAPSHOT of a
 *                            connection's occurrences over a window. Readers
 *                            only ever see the latest PUBLISHED generation
 *                            for a connection — see publishGeneration() and
 *                            readPublishedOccurrences() below.
 *   calendarq_occurrences  — the occurrences belonging to one generation.
 *   calendarq_operations   — write-path operations (e.g. create_event),
 *                            carrying an explicit allowed-transition state
 *                            machine (see ALLOWED_TRANSITIONS below) and a
 *                            durable state_history.
 *   calendarq_layers       — named calendar layers (provider / internal /
 *                            team schedules / workflow cron / ActionQ).
 *   calendarq_receipts     — receipt-backed evidence rows tied to an
 *                            operation.
 */

const Database = require('better-sqlite3');

let _db = null;
let _dbPath = null;

function generateId(prefix) {
  // Same non-cryptographic, roughly-sortable id shape as inboxq/store.js's
  // generateId: time + random, no new dependency needed for this store.
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function initCalendarqStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendarq_connections (
      id             TEXT PRIMARY KEY,
      org_id         TEXT NOT NULL,
      provider       TEXT NOT NULL,
      account_label  TEXT,
      resource_id    TEXT NOT NULL,
      resource_label TEXT,
      credential_ref TEXT,
      scopes_json    TEXT NOT NULL DEFAULT '[]',
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_calendarq_connections_org ON calendarq_connections(org_id);

    CREATE TABLE IF NOT EXISTS calendarq_generations (
      id                     TEXT PRIMARY KEY,
      org_id                 TEXT NOT NULL,
      connection_id          TEXT NOT NULL,
      window_start           TEXT NOT NULL,
      window_end_exclusive    TEXT NOT NULL,
      timezone               TEXT NOT NULL,
      state                  TEXT NOT NULL DEFAULT 'staging'
                               CHECK (state IN ('staging', 'published', 'failed')),
      complete               INTEGER NOT NULL DEFAULT 0,
      watermark_ts           INTEGER,
      published_at           TEXT,
      stats_json             TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_calendarq_generations_org ON calendarq_generations(org_id);
    -- Fast "latest published generation for this connection" lookup — the
    -- read path every consumer outside this module is restricted to.
    CREATE INDEX IF NOT EXISTS idx_calendarq_generations_published
      ON calendarq_generations(org_id, connection_id, state, published_at DESC);

    CREATE TABLE IF NOT EXISTS calendarq_occurrences (
      org_id            TEXT NOT NULL,
      generation_id     TEXT NOT NULL,
      occurrence_key    TEXT NOT NULL,
      series_id         TEXT,
      provider_event_id TEXT NOT NULL,
      source_version    TEXT NOT NULL,
      payload_json      TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (generation_id, occurrence_key)
    );
    CREATE INDEX IF NOT EXISTS idx_calendarq_occurrences_org ON calendarq_occurrences(org_id);

    CREATE TABLE IF NOT EXISTS calendarq_operations (
      id                   TEXT PRIMARY KEY,
      org_id               TEXT NOT NULL,
      op_id                TEXT NOT NULL UNIQUE,
      kind                 TEXT NOT NULL,
      state                TEXT NOT NULL DEFAULT 'proposed'
                            CHECK (state IN ('proposed', 'awaiting_approval', 'attempted', 'confirmed', 'partial', 'failed', 'outcome_unknown')),
      proposal_json        TEXT NOT NULL DEFAULT '{}',
      approval_ref         TEXT,
      provider_result_json TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      state_history_json   TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_calendarq_operations_org ON calendarq_operations(org_id, state);

    CREATE TABLE IF NOT EXISTS calendarq_layers (
      org_id       TEXT NOT NULL,
      layer_id     TEXT NOT NULL,
      kind         TEXT NOT NULL,
      source_ref   TEXT,
      display_name TEXT NOT NULL,
      color        TEXT,
      visible      INTEGER NOT NULL DEFAULT 1,
      scope        TEXT NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'user')),
      -- NOT NULL DEFAULT '' (rather than allowing NULL): SQLite's UNIQUE/
      -- PRIMARY KEY machinery treats NULL as never equal to NULL, so a
      -- nullable user_id would let multiple "org-scoped" (no user) rows
      -- silently coexist under the same (org_id, layer_id) instead of the
      -- PRIMARY KEY actually deduplicating them. '' is the "no specific
      -- user, org-wide" sentinel; hydrateLayer() below maps it back to null.
      user_id      TEXT NOT NULL DEFAULT '',
      coverage_json TEXT,
      PRIMARY KEY (org_id, layer_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_calendarq_layers_org ON calendarq_layers(org_id);

    CREATE TABLE IF NOT EXISTS calendarq_receipts (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      op_id      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      body_json  TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_calendarq_receipts_org ON calendarq_receipts(org_id, op_id);

    -- L2-C1: the sync worker's loop-triad state, one row per connection.
    -- Mirrors lib/inboxq/store.js's inboxq_folder_state shape (failure streak
    -- DISTINCT from empty-result accounting, capped backoff, durable
    -- retirement) but keyed per-connection rather than per-folder, because a
    -- Calendar-Q sync pass fetches one connection's whole window in one go.
    CREATE TABLE IF NOT EXISTS calendarq_sync_state (
      org_id          TEXT NOT NULL,
      connection_id   TEXT NOT NULL,
      failure_streak  INTEGER NOT NULL DEFAULT 0,
      backoff_stage   INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      retired         INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      -- last_empty_at / last_change_at are DISTINCT clocks: a successful pass
      -- that found zero changed occurrences updates only last_empty_at, never
      -- last_error and never failure_streak — "0 changes" must never look
      -- like a failure, and must never look like evidence of no sync ever
      -- having run.
      last_empty_at   TEXT,
      last_change_at  TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (org_id, connection_id)
    );

    -- L2-C1: short-lived CSRF state for the OAuth authorization-code dance.
    -- One row per in-flight connect attempt; consumeOauthState below deletes
    -- it on first use so a state value can never be replayed.
    CREATE TABLE IF NOT EXISTS calendarq_oauth_states (
      state         TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL
    );

    -- L2-C3 U2: one persisted brief per (org, workday, scheduleVersion). Only
    -- the LATEST row per (org_id, workday) is ever read back as "the current
    -- brief" (see getLatestBriefForWorkday) — force=true creates a NEW
    -- scheduleVersion row rather than overwriting the old one, so a prior
    -- brief's generation_watermarks_json stays available as the "previous"
    -- baseline for whichever brief superseded it.
    --
    -- payload_json is the EXACT validated CalendarBriefInputV1 (see
    -- contracts.js) — nothing extra lives in it. generation_watermarks_json
    -- is internal-only bookkeeping (connectionId -> generationId at the
    -- moment this brief was built), read by the NEXT brief build to compute
    -- getChanges() since this one; it is never part of the public contract
    -- and never returned to a caller verbatim.
    CREATE TABLE IF NOT EXISTS calendarq_briefs (
      id                         TEXT PRIMARY KEY,
      org_id                     TEXT NOT NULL,
      workday                    TEXT NOT NULL,
      schedule_version           TEXT NOT NULL,
      payload_json               TEXT NOT NULL,
      generation_watermarks_json TEXT NOT NULL DEFAULT '{}',
      created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, workday, schedule_version)
    );
    CREATE INDEX IF NOT EXISTS idx_calendarq_briefs_org_workday ON calendarq_briefs(org_id, workday, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_calendarq_briefs_org_created ON calendarq_briefs(org_id, created_at DESC);

    -- L2-C3 U3: idempotency ledger for Action-Q follow-up intake. One row per
    -- (org, idempotencyKey) naming the action_items.id the intake call
    -- created — a repeat call with the SAME idempotencyKey reads this row
    -- back and returns the existing action item's ack instead of calling
    -- action_add again (see actionIntake.js's proposeFollowUp).
    CREATE TABLE IF NOT EXISTS calendarq_action_intake (
      org_id          TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      action_item_id  TEXT NOT NULL,
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (org_id, idempotency_key)
    );
  `);
  // Additive migration, safe against a live db with existing rows (never
  // DROP/recreate) — same pattern as lib/inboxq/store.js's
  // addColumnIfMissing. A connection's IANA timezone is the authority the
  // sync worker computes its 7-back/30-fwd window in; 'UTC' is the safe
  // default for a pre-migration row or a connection created without one.
  addColumnIfMissing(db, 'calendarq_connections', 'timezone', `TEXT NOT NULL DEFAULT 'UTC'`);
  // L2-C1 agenda/coverage staleness detection needs a creation order that
  // survives a generation ending up in ANY state (staging/published/failed)
  // — published_at is NULL for a failed generation, so it cannot serve this.
  addColumnIfMissing(db, 'calendarq_generations', 'created_at', 'TEXT');
  // L2-C2: the digest an operation's approval was bound to, captured the
  // FIRST time the operation moves proposed -> awaiting_approval (see
  // execute.js). Distinct from proposal_json.effectDigest — that field lives
  // inside the same JSON blob a drift bug (or, in a test, a deliberate
  // tamper via _setProposalJsonForTest) could rewrite alongside new content,
  // staying self-consistent. approval_bound_digest is written exactly once,
  // never touched by anything that also rewrites proposal_json, so comparing
  // the CURRENT recomputed digest against THIS column catches "the effect
  // changed after a human was asked to approve it" even when proposal_json
  // itself still looks internally consistent.
  addColumnIfMissing(db, 'calendarq_operations', 'approval_bound_digest', 'TEXT');
}

/** Add `column` to `table` only if it does not already exist — see
 * lib/inboxq/store.js's identically-named helper for the full rationale. */
function addColumnIfMissing(db, table, column, decl) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = info.some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function getDb() {
  if (_db) return _db;
  _dbPath = process.env.CALENDARQ_DB_PATH || '/var/lib/quox/calendarq.db';
  _db = new Database(_dbPath);
  _db.pragma('journal_mode = WAL');
  initCalendarqStore(_db);
  return _db;
}

/**
 * Test seam: open an in-memory (or explicit-path) db and use it for all
 * subsequent calls. Returns the db handle so a test can inspect it directly.
 * Same shape as inboxq/store.js's _useTestDb — calling it again against the
 * SAME path (after _reset or directly) simulates a process restart against
 * a durable file: no state is fabricated back in, only what was persisted.
 */
function _useTestDb(path = ':memory:') {
  if (_db) {
    try { _db.close(); } catch { /* non-fatal */ }
  }
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  initCalendarqStore(_db);
  _dbPath = path;
  return _db;
}

function _reset() {
  if (_db) {
    try { _db.close(); } catch { /* non-fatal */ }
  }
  _db = null;
  _dbPath = null;
}

function safeParse(json, fallback) {
  if (json == null) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

function hydrateConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    accountLabel: row.account_label,
    resourceId: row.resource_id,
    resourceLabel: row.resource_label,
    credentialRef: row.credential_ref,
    scopes: safeParse(row.scopes_json, []),
    status: row.status,
    timezone: row.timezone || 'UTC',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createConnection({ orgId, provider, accountLabel = null, resourceId, resourceLabel = null, credentialRef = null, scopes = [], status = 'active', timezone = 'UTC' } = {}) {
  if (!orgId) throw new Error('createConnection requires orgId');
  if (!provider) throw new Error('createConnection requires provider');
  if (!resourceId) throw new Error('createConnection requires resourceId');
  const db = getDb();
  const id = generateId('calconn');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO calendarq_connections
      (id, org_id, provider, account_label, resource_id, resource_label, credential_ref, scopes_json, status, timezone, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, provider, accountLabel, resourceId, resourceLabel, credentialRef, JSON.stringify(scopes || []), status, timezone || 'UTC', now, now);
  return getConnection(orgId, id);
}

/** Flip a connection's status (e.g. 'active' -> 'needs_reconnect' on a
 * provider reauth_required, or back to 'active' once reconnected). Never
 * silent: a status change is always the caller's explicit decision. */
function setConnectionStatus(orgId, id, status) {
  if (!orgId) throw new Error('setConnectionStatus requires orgId');
  if (!id) throw new Error('setConnectionStatus requires id');
  if (!status) throw new Error('setConnectionStatus requires status');
  const db = getDb();
  const info = db.prepare(`UPDATE calendarq_connections SET status = ?, updated_at = ? WHERE org_id = ? AND id = ?`)
    .run(status, new Date().toISOString(), orgId, id);
  if (info.changes === 0) throw new Error('setConnectionStatus: connection not found');
  return getConnection(orgId, id);
}

/** Cross-org fan-out read for the scheduler only — same shape as
 * lib/inboxq/store.js's listAllPollableAccounts. Never used on a
 * request-scoped (org-bounded) read path. */
function listAllActiveConnections() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM calendarq_connections WHERE status = 'active' ORDER BY org_id, created_at ASC`).all();
  return rows.map(hydrateConnection);
}

function getConnection(orgId, id) {
  if (!orgId) throw new Error('getConnection requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendarq_connections WHERE org_id = ? AND id = ?`).get(orgId, id);
  return hydrateConnection(row);
}

function listConnections(orgId) {
  if (!orgId) throw new Error('listConnections requires orgId');
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM calendarq_connections WHERE org_id = ? ORDER BY created_at ASC`).all(orgId);
  return rows.map(hydrateConnection);
}

// ---------------------------------------------------------------------------
// Generations + occurrences (staged publish)
// ---------------------------------------------------------------------------

function hydrateGeneration(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    connectionId: row.connection_id,
    windowStart: row.window_start,
    windowEndExclusive: row.window_end_exclusive,
    timezone: row.timezone,
    state: row.state,
    complete: Boolean(row.complete),
    watermarkTs: row.watermark_ts,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    stats: safeParse(row.stats_json, {}),
  };
}

function createGeneration({ orgId, connectionId, windowStart, windowEndExclusive, timezone } = {}) {
  if (!orgId) throw new Error('createGeneration requires orgId');
  if (!connectionId) throw new Error('createGeneration requires connectionId');
  if (!windowStart) throw new Error('createGeneration requires windowStart');
  if (!windowEndExclusive) throw new Error('createGeneration requires windowEndExclusive');
  if (!timezone) throw new Error('createGeneration requires timezone');
  const db = getDb();
  const id = generateId('calgen');
  db.prepare(`
    INSERT INTO calendarq_generations
      (id, org_id, connection_id, window_start, window_end_exclusive, timezone, state, complete, watermark_ts, published_at, stats_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'staging', 0, NULL, NULL, '{}', ?)
  `).run(id, orgId, connectionId, windowStart, windowEndExclusive, timezone, new Date().toISOString());
  return getGeneration(orgId, id);
}

function getGeneration(orgId, id) {
  if (!orgId) throw new Error('getGeneration requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendarq_generations WHERE org_id = ? AND id = ?`).get(orgId, id);
  return hydrateGeneration(row);
}

/** The most recently CREATED generation for a connection, regardless of
 * state (staging/published/failed) — used by the agenda layer to detect
 * "the latest sync attempt after the published one failed", which
 * published_at alone cannot show (a failed generation has no published_at). */
function getLatestGenerationForConnection(orgId, connectionId) {
  if (!orgId) throw new Error('getLatestGenerationForConnection requires orgId');
  if (!connectionId) throw new Error('getLatestGenerationForConnection requires connectionId');
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM calendarq_generations
    WHERE org_id = ? AND connection_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(orgId, connectionId);
  return hydrateGeneration(row);
}

/** Mark a staging generation complete (all occurrences ingested) — a
 * precondition for publishGeneration, not a publish itself. */
function markGenerationComplete(orgId, id, { watermarkTs = null, stats = {} } = {}) {
  if (!orgId) throw new Error('markGenerationComplete requires orgId');
  const db = getDb();
  const info = db.prepare(`
    UPDATE calendarq_generations SET complete = 1, watermark_ts = ?, stats_json = ?
    WHERE org_id = ? AND id = ?
  `).run(watermarkTs, JSON.stringify(stats || {}), orgId, id);
  if (info.changes === 0) throw new Error('markGenerationComplete: generation not found');
  return getGeneration(orgId, id);
}

/**
 * Flip a staging generation to published, ONLY if it is marked complete.
 * A single UPDATE inside a transaction: readers (readPublishedOccurrences)
 * resolve "the latest published generation" by published_at DESC, so this
 * one write atomically supersedes whatever was previously the latest for
 * this connection — there is no intermediate state a reader can observe
 * that mixes the old and new generation's occurrences.
 */
function publishGeneration(orgId, id) {
  if (!orgId) throw new Error('publishGeneration requires orgId');
  const db = getDb();
  const gen = getGeneration(orgId, id);
  if (!gen) throw new Error('publishGeneration: generation not found');
  if (!gen.complete) throw new Error('publishGeneration: refuses to publish an incomplete generation');
  const tx = db.transaction(() => {
    db.prepare(`UPDATE calendarq_generations SET state = 'published', published_at = ? WHERE org_id = ? AND id = ?`)
      .run(new Date().toISOString(), orgId, id);
  });
  tx();
  return getGeneration(orgId, id);
}

/**
 * Transition a staging generation straight to 'failed' (e.g. a page fetch
 * threw mid-pull, or pagination never completed). A failed generation is
 * NEVER published and NEVER becomes "the latest published generation" for a
 * connection — readPublishedOccurrences only ever looks at state='published'
 * rows, so the previously-published generation (if any) keeps serving reads,
 * now as 'stale' per the agenda layer's coverage computation.
 */
function markGenerationFailed(orgId, id, { reason = null } = {}) {
  if (!orgId) throw new Error('markGenerationFailed requires orgId');
  const db = getDb();
  const gen = getGeneration(orgId, id);
  if (!gen) throw new Error('markGenerationFailed: generation not found');
  const stats = { ...gen.stats, failureReason: reason };
  const info = db.prepare(`UPDATE calendarq_generations SET state = 'failed', stats_json = ? WHERE org_id = ? AND id = ?`)
    .run(JSON.stringify(stats), orgId, id);
  if (info.changes === 0) throw new Error('markGenerationFailed: generation not found');
  return getGeneration(orgId, id);
}

function hydrateOccurrence(row) {
  if (!row) return null;
  return {
    orgId: row.org_id,
    generationId: row.generation_id,
    occurrenceKey: row.occurrence_key,
    seriesId: row.series_id,
    providerEventId: row.provider_event_id,
    sourceVersion: row.source_version,
    payload: safeParse(row.payload_json, {}),
  };
}

/** Insert an occurrence against a (normally staging) generation. */
function insertOccurrence({ orgId, generationId, occurrenceKey, seriesId = null, providerEventId, sourceVersion, payload = {} } = {}) {
  if (!orgId) throw new Error('insertOccurrence requires orgId');
  if (!generationId) throw new Error('insertOccurrence requires generationId');
  if (!occurrenceKey) throw new Error('insertOccurrence requires occurrenceKey');
  if (!providerEventId) throw new Error('insertOccurrence requires providerEventId');
  if (!sourceVersion) throw new Error('insertOccurrence requires sourceVersion');
  const db = getDb();
  db.prepare(`
    INSERT INTO calendarq_occurrences (org_id, generation_id, occurrence_key, series_id, provider_event_id, source_version, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(generation_id, occurrence_key) DO UPDATE SET
      series_id = excluded.series_id,
      provider_event_id = excluded.provider_event_id,
      source_version = excluded.source_version,
      payload_json = excluded.payload_json
  `).run(orgId, generationId, occurrenceKey, seriesId, providerEventId, sourceVersion, JSON.stringify(payload || {}));
  return true;
}

/** Internal/test helper: raw occurrences for a specific generation, regardless
 * of that generation's publish state. NOT the public read path — see
 * readPublishedOccurrences below, which is the only path external callers
 * should use to read "what does this connection's calendar look like". */
function listOccurrences(orgId, generationId) {
  if (!orgId) throw new Error('listOccurrences requires orgId');
  if (!generationId) throw new Error('listOccurrences requires generationId');
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM calendarq_occurrences WHERE org_id = ? AND generation_id = ? ORDER BY occurrence_key ASC`).all(orgId, generationId);
  return rows.map(hydrateOccurrence);
}

/**
 * THE public read path for a connection's calendar: resolves the latest
 * PUBLISHED generation for (orgId, connectionId) and returns it together
 * with its occurrences. Returns null when no generation has ever been
 * published for this connection — staging occurrences, however many are
 * sitting in an in-progress generation, are never surfaced here.
 */
function readPublishedOccurrences(orgId, connectionId) {
  if (!orgId) throw new Error('readPublishedOccurrences requires orgId');
  if (!connectionId) throw new Error('readPublishedOccurrences requires connectionId');
  const db = getDb();
  const genRow = db.prepare(`
    SELECT * FROM calendarq_generations
    WHERE org_id = ? AND connection_id = ? AND state = 'published'
    ORDER BY published_at DESC LIMIT 1
  `).get(orgId, connectionId);
  if (!genRow) return null;
  const generation = hydrateGeneration(genRow);
  const occurrences = listOccurrences(orgId, generation.id);
  return { generation, occurrences };
}

// ---------------------------------------------------------------------------
// Operations — explicit allowed-transition state machine
// ---------------------------------------------------------------------------

// Keyed by current state -> the set of states it may legally move to next.
// A state absent from its own list means it can never "re-enter itself" (the
// NO attempted->attempted re-entry rule), and a state mapped to an empty
// array is terminal (confirmed/failed/partial never transition again).
const ALLOWED_TRANSITIONS = Object.freeze({
  proposed: ['awaiting_approval', 'failed'],
  awaiting_approval: ['attempted', 'failed'],
  attempted: ['confirmed', 'partial', 'failed', 'outcome_unknown'],
  confirmed: [],
  partial: [],
  failed: [],
  // Reached when a provider call's result could not be confirmed (e.g. a
  // timeout after the request was sent). Only resolved by reconcile — which
  // can ALSO find a provider event that diverges from the proposal (e.g. the
  // request landed but with different content), hence 'partial' alongside
  // 'confirmed'/'failed'.
  outcome_unknown: ['confirmed', 'failed', 'partial'],
});

function hydrateOperation(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    opId: row.op_id,
    kind: row.kind,
    state: row.state,
    proposal: safeParse(row.proposal_json, {}),
    approvalRef: row.approval_ref,
    approvalBoundDigest: row.approval_bound_digest || null,
    providerResult: safeParse(row.provider_result_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stateHistory: safeParse(row.state_history_json, []),
  };
}

function createOperation({ orgId, opId, kind, proposalJson = {} } = {}) {
  if (!orgId) throw new Error('createOperation requires orgId');
  if (!opId) throw new Error('createOperation requires opId');
  if (!kind) throw new Error('createOperation requires kind');
  const db = getDb();
  const id = generateId('calop');
  const now = new Date().toISOString();
  const stateHistory = [{ from: null, to: 'proposed', ts: Date.now() }];
  try {
    db.prepare(`
      INSERT INTO calendarq_operations (id, org_id, op_id, kind, state, proposal_json, approval_ref, provider_result_json, created_at, updated_at, state_history_json)
      VALUES (?, ?, ?, ?, 'proposed', ?, NULL, NULL, ?, ?, ?)
    `).run(id, orgId, opId, kind, JSON.stringify(proposalJson || {}), now, now, JSON.stringify(stateHistory));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error(`createOperation: opId "${opId}" already exists`);
    throw e;
  }
  return getOperationByOpId(orgId, opId);
}

function getOperationByOpId(orgId, opId) {
  if (!orgId) throw new Error('getOperationByOpId requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendarq_operations WHERE org_id = ? AND op_id = ?`).get(orgId, opId);
  return hydrateOperation(row);
}

function listOperations(orgId, { state = null } = {}) {
  if (!orgId) throw new Error('listOperations requires orgId');
  const db = getDb();
  const rows = state
    ? db.prepare(`SELECT * FROM calendarq_operations WHERE org_id = ? AND state = ? ORDER BY created_at ASC`).all(orgId, state)
    : db.prepare(`SELECT * FROM calendarq_operations WHERE org_id = ? ORDER BY created_at ASC`).all(orgId);
  return rows.map(hydrateOperation);
}

/**
 * Move an operation from its current state to `toState`, per
 * ALLOWED_TRANSITIONS. Throws on any illegal transition — including a
 * cross-org opId (treated as "not found", same as every other org-scoped
 * lookup here) — and in every throwing case nothing is written: no row
 * update, no state_history entry. A legal transition appends exactly one
 * { from, to, ts } hop to state_history.
 */
function transitionOperation(orgId, opId, toState, { approvalRef, providerResult, approvalBoundDigest } = {}) {
  if (!orgId) throw new Error('transitionOperation requires orgId');
  if (!opId) throw new Error('transitionOperation requires opId');
  const db = getDb();
  // Read-check-write all happen synchronously (better-sqlite3 never yields
  // mid-call), so two "concurrent" async callers racing to the SAME legal
  // transition can never both win here — whichever JS turn reaches this line
  // first commits it, and the other's re-read on its own later turn sees the
  // already-changed state and fails the allowed-transition check below. This
  // IS the durable attempted-claim lock execute.js relies on for the
  // concurrent double-execute race (no separate locking primitive needed).
  const current = getOperationByOpId(orgId, opId);
  if (!current) throw new Error(`transitionOperation: operation "${opId}" not found`);
  const allowed = ALLOWED_TRANSITIONS[current.state] || [];
  if (!allowed.includes(toState)) {
    throw new Error(`transitionOperation: illegal transition ${current.state} -> ${toState} for op "${opId}"`);
  }
  const history = [...current.stateHistory, { from: current.state, to: toState, ts: Date.now() }];
  const nextApprovalRef = approvalRef !== undefined ? approvalRef : current.approvalRef;
  const nextProviderResult = providerResult !== undefined ? providerResult : current.providerResult;
  const nextApprovalBoundDigest = approvalBoundDigest !== undefined ? approvalBoundDigest : current.approvalBoundDigest;
  db.prepare(`
    UPDATE calendarq_operations
    SET state = ?, approval_ref = ?, provider_result_json = ?, approval_bound_digest = ?, updated_at = ?, state_history_json = ?
    WHERE org_id = ? AND op_id = ?
  `).run(
    toState,
    nextApprovalRef ?? null,
    nextProviderResult !== null && nextProviderResult !== undefined ? JSON.stringify(nextProviderResult) : null,
    nextApprovalBoundDigest ?? null,
    new Date().toISOString(),
    JSON.stringify(history),
    orgId, opId,
  );
  return getOperationByOpId(orgId, opId);
}

/**
 * Cross-org fan-out read for the restart-sweep reconciler only (same
 * unscoped-by-design shape as listAllActiveConnections above) — finds every
 * operation currently sitting in `state`, across every org, so a collector
 * restart can queue stuck 'attempted' ops for reconcile without an org
 * context to filter by. Never used on a request-scoped (org-bounded) path.
 */
function listAllOperationsByState(state) {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM calendarq_operations WHERE state = ? ORDER BY updated_at ASC`).all(state);
  return rows.map(hydrateOperation);
}

/**
 * TEST SEAM ONLY — never called by production code. Overwrites an
 * operation's proposal_json directly, bypassing every validator and the
 * normal createProposal path, to simulate the drift/tamper scenario
 * execute.js's effect-digest revalidation exists to catch (content changed
 * after a human was asked to approve it). Production code has no update
 * path for proposal_json at all; this exists purely so a test can construct
 * "the stored proposal no longer matches what was approved" without forking
 * a second write path into the real codebase.
 */
function _setProposalJsonForTest(orgId, opId, proposalJson) {
  if (!orgId) throw new Error('_setProposalJsonForTest requires orgId');
  if (!opId) throw new Error('_setProposalJsonForTest requires opId');
  const db = getDb();
  const info = db.prepare(`UPDATE calendarq_operations SET proposal_json = ?, updated_at = ? WHERE org_id = ? AND op_id = ?`)
    .run(JSON.stringify(proposalJson || {}), new Date().toISOString(), orgId, opId);
  if (info.changes === 0) throw new Error('_setProposalJsonForTest: operation not found');
  return getOperationByOpId(orgId, opId);
}

/**
 * The reconcile path: resolves an outcome_unknown operation once provider
 * evidence is in hand. A thin, named wrapper over transitionOperation so
 * call sites read as "reconcile", but the legality of outcome_unknown ->
 * confirmed|failed is enforced the same way as every other hop, by
 * ALLOWED_TRANSITIONS — there is no separate, looser rule for reconcile.
 */
function reconcileOperation(orgId, opId, toState, providerResult) {
  return transitionOperation(orgId, opId, toState, { providerResult });
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function hydrateLayer(row) {
  if (!row) return null;
  return {
    orgId: row.org_id,
    layerId: row.layer_id,
    kind: row.kind,
    sourceRef: row.source_ref,
    displayName: row.display_name,
    color: row.color,
    visible: Boolean(row.visible),
    scope: row.scope,
    userId: row.user_id || null,
    coverage: safeParse(row.coverage_json, null),
  };
}

function upsertLayer({ orgId, layerId, kind, sourceRef = null, displayName, color = null, visible = true, scope = 'org', userId = null, coverage = null } = {}) {
  if (!orgId) throw new Error('upsertLayer requires orgId');
  if (!layerId) throw new Error('upsertLayer requires layerId');
  if (!kind) throw new Error('upsertLayer requires kind');
  if (!displayName) throw new Error('upsertLayer requires displayName');
  const db = getDb();
  const uid = userId || ''; // see calendarq_layers.user_id comment in initCalendarqStore
  db.prepare(`
    INSERT INTO calendarq_layers (org_id, layer_id, kind, source_ref, display_name, color, visible, scope, user_id, coverage_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, layer_id, user_id) DO UPDATE SET
      kind = excluded.kind,
      source_ref = excluded.source_ref,
      display_name = excluded.display_name,
      color = excluded.color,
      visible = excluded.visible,
      scope = excluded.scope,
      coverage_json = excluded.coverage_json
  `).run(orgId, layerId, kind, sourceRef, displayName, color, visible ? 1 : 0, scope, uid, coverage ? JSON.stringify(coverage) : null);
  return getLayer(orgId, layerId, userId);
}

function getLayer(orgId, layerId, userId = null) {
  if (!orgId) throw new Error('getLayer requires orgId');
  const db = getDb();
  const uid = userId || '';
  const row = db.prepare(`SELECT * FROM calendarq_layers WHERE org_id = ? AND layer_id = ? AND user_id = ?`).get(orgId, layerId, uid);
  return hydrateLayer(row);
}

function listLayers(orgId) {
  if (!orgId) throw new Error('listLayers requires orgId');
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM calendarq_layers WHERE org_id = ? ORDER BY layer_id ASC`).all(orgId);
  return rows.map(hydrateLayer);
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function hydrateReceipt(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    opId: row.op_id,
    kind: row.kind,
    body: safeParse(row.body_json, {}),
    createdAt: row.created_at,
  };
}

function insertReceipt({ orgId, opId, kind, body = {} } = {}) {
  if (!orgId) throw new Error('insertReceipt requires orgId');
  if (!opId) throw new Error('insertReceipt requires opId');
  if (!kind) throw new Error('insertReceipt requires kind');
  const db = getDb();
  const id = generateId('calrcpt');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO calendarq_receipts (id, org_id, op_id, kind, body_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, orgId, opId, kind, JSON.stringify(body || {}), now);
  return getReceipt(orgId, id);
}

function getReceipt(orgId, id) {
  if (!orgId) throw new Error('getReceipt requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendarq_receipts WHERE org_id = ? AND id = ?`).get(orgId, id);
  return hydrateReceipt(row);
}

function listReceipts(orgId, opId) {
  if (!orgId) throw new Error('listReceipts requires orgId');
  if (!opId) throw new Error('listReceipts requires opId');
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM calendarq_receipts WHERE org_id = ? AND op_id = ? ORDER BY created_at ASC`).all(orgId, opId);
  return rows.map(hydrateReceipt);
}

// ---------------------------------------------------------------------------
// Sync state — the L2-C1 loop triad, one row per connection
// ---------------------------------------------------------------------------

function hydrateSyncState(row) {
  if (!row) return null;
  return {
    orgId: row.org_id,
    connectionId: row.connection_id,
    failureStreak: row.failure_streak,
    backoffStage: row.backoff_stage,
    nextAttemptAt: row.next_attempt_at,
    retired: Boolean(row.retired),
    lastError: row.last_error,
    lastEmptyAt: row.last_empty_at,
    lastChangeAt: row.last_change_at,
    updatedAt: row.updated_at,
  };
}

function getSyncState(orgId, connectionId) {
  if (!orgId) throw new Error('getSyncState requires orgId');
  if (!connectionId) throw new Error('getSyncState requires connectionId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendarq_sync_state WHERE org_id = ? AND connection_id = ?`).get(orgId, connectionId);
  return hydrateSyncState(row);
}

/** Merge-upsert, same shape as lib/inboxq/store.js's upsertFolderState: an
 * omitted field keeps its existing value (or a safe zero/null default on
 * first insert) rather than being clobbered. */
function upsertSyncState(orgId, connectionId, patch = {}) {
  if (!orgId) throw new Error('upsertSyncState requires orgId');
  if (!connectionId) throw new Error('upsertSyncState requires connectionId');
  const db = getDb();
  const existing = getSyncState(orgId, connectionId);
  const merged = {
    failure_streak: patch.failureStreak ?? existing?.failureStreak ?? 0,
    backoff_stage: patch.backoffStage ?? existing?.backoffStage ?? 0,
    next_attempt_at: patch.nextAttemptAt !== undefined ? patch.nextAttemptAt : (existing?.nextAttemptAt ?? null),
    retired: (patch.retired !== undefined ? patch.retired : existing?.retired) ? 1 : 0,
    last_error: patch.lastError !== undefined ? patch.lastError : (existing?.lastError ?? null),
    last_empty_at: patch.lastEmptyAt !== undefined ? patch.lastEmptyAt : (existing?.lastEmptyAt ?? null),
    last_change_at: patch.lastChangeAt !== undefined ? patch.lastChangeAt : (existing?.lastChangeAt ?? null),
  };
  db.prepare(`
    INSERT INTO calendarq_sync_state (org_id, connection_id, failure_streak, backoff_stage, next_attempt_at, retired, last_error, last_empty_at, last_change_at, updated_at)
    VALUES (@org_id, @connection_id, @failure_streak, @backoff_stage, @next_attempt_at, @retired, @last_error, @last_empty_at, @last_change_at, @updated_at)
    ON CONFLICT(org_id, connection_id) DO UPDATE SET
      failure_streak = excluded.failure_streak,
      backoff_stage = excluded.backoff_stage,
      next_attempt_at = excluded.next_attempt_at,
      retired = excluded.retired,
      last_error = excluded.last_error,
      last_empty_at = excluded.last_empty_at,
      last_change_at = excluded.last_change_at,
      updated_at = excluded.updated_at
  `).run({ org_id: orgId, connection_id: connectionId, ...merged, updated_at: new Date().toISOString() });
  return getSyncState(orgId, connectionId);
}

/** Clear retirement + failure accounting so a human re-enable gets a clean
 * slate — same shape as lib/inboxq/store.js's folder re-enable helper. */
function resetSyncState(orgId, connectionId) {
  if (!orgId) throw new Error('resetSyncState requires orgId');
  if (!connectionId) throw new Error('resetSyncState requires connectionId');
  const db = getDb();
  db.prepare(`
    UPDATE calendarq_sync_state
    SET retired = 0, failure_streak = 0, backoff_stage = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?
    WHERE org_id = ? AND connection_id = ?
  `).run(new Date().toISOString(), orgId, connectionId);
  return getSyncState(orgId, connectionId);
}

// ---------------------------------------------------------------------------
// OAuth connect state — short-lived CSRF token for the authorization-code
// dance, consumed exactly once.
// ---------------------------------------------------------------------------

function createOauthState({ orgId, credentialId, ttlMs = 10 * 60 * 1000 } = {}) {
  if (!orgId) throw new Error('createOauthState requires orgId');
  if (!credentialId) throw new Error('createOauthState requires credentialId');
  const db = getDb();
  const state = generateId('calstate');
  const now = Date.now();
  db.prepare(`
    INSERT INTO calendarq_oauth_states (state, org_id, credential_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(state, orgId, credentialId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
  return { state, orgId, credentialId, expiresAt: new Date(now + ttlMs).toISOString() };
}

/**
 * Consume (read-then-delete) a state token. Returns null for a missing OR
 * expired state — expiry is checked before deletion either way, so a stale
 * row can never be replayed, and the caller (oauth callback) cannot tell an
 * expired state from an unknown one (no existence oracle).
 */
function consumeOauthState(state) {
  if (!state) return null;
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendarq_oauth_states WHERE state = ?`).get(state);
  if (row) db.prepare(`DELETE FROM calendarq_oauth_states WHERE state = ?`).run(state);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { orgId: row.org_id, credentialId: row.credential_id };
}

// ---------------------------------------------------------------------------
// L2-C3 U2: persisted morning briefs — one row per (org, workday,
// scheduleVersion), only the latest read back as "current".
// ---------------------------------------------------------------------------

function hydrateBrief(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    workday: row.workday,
    scheduleVersion: row.schedule_version,
    payload: safeParse(row.payload_json, null),
    generationWatermarks: safeParse(row.generation_watermarks_json, {}),
    createdAt: row.created_at,
  };
}

/** The most recently created brief for THIS workday, any scheduleVersion —
 * the idempotent "already built today" read. Null when none exists yet. */
function getLatestBriefForWorkday(orgId, workday) {
  if (!orgId) throw new Error('getLatestBriefForWorkday requires orgId');
  if (!workday) throw new Error('getLatestBriefForWorkday requires workday');
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM calendarq_briefs WHERE org_id = ? AND workday = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(orgId, workday);
  return hydrateBrief(row);
}

/** The most recently created brief for this org, ACROSS every workday — the
 * "previous brief" a new build diffs its changes against, regardless of
 * which calendar day it was built for. Null for an org's very first brief. */
function getLatestBriefOverall(orgId) {
  if (!orgId) throw new Error('getLatestBriefOverall requires orgId');
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM calendarq_briefs WHERE org_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(orgId);
  return hydrateBrief(row);
}

/** Persist one new brief row. Throws on a (org, workday, scheduleVersion)
 * collision rather than silently overwriting — callers are responsible for
 * picking a scheduleVersion that has not been used for this workday yet. */
function createBrief({ orgId, workday, scheduleVersion, payload, generationWatermarks = {} } = {}) {
  if (!orgId) throw new Error('createBrief requires orgId');
  if (!workday) throw new Error('createBrief requires workday');
  if (!scheduleVersion) throw new Error('createBrief requires scheduleVersion');
  if (!payload) throw new Error('createBrief requires payload');
  const db = getDb();
  const id = generateId('calbrief');
  try {
    db.prepare(`
      INSERT INTO calendarq_briefs (id, org_id, workday, schedule_version, payload_json, generation_watermarks_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, orgId, workday, scheduleVersion, JSON.stringify(payload), JSON.stringify(generationWatermarks || {}));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error(`createBrief: scheduleVersion "${scheduleVersion}" already exists for ${orgId}/${workday}`);
    throw e;
  }
  return getLatestBriefForWorkday(orgId, workday);
}

// ---------------------------------------------------------------------------
// L2-C3 U3: Action-Q follow-up intake idempotency ledger
// ---------------------------------------------------------------------------

function hydrateActionIntake(row) {
  if (!row) return null;
  return {
    orgId: row.org_id,
    idempotencyKey: row.idempotency_key,
    actionItemId: row.action_item_id,
    sourceRefs: safeParse(row.source_refs_json, []),
    createdAt: row.created_at,
  };
}

function getActionIntakeByKey(orgId, idempotencyKey) {
  if (!orgId) throw new Error('getActionIntakeByKey requires orgId');
  if (!idempotencyKey) throw new Error('getActionIntakeByKey requires idempotencyKey');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM calendarq_action_intake WHERE org_id = ? AND idempotency_key = ?`).get(orgId, idempotencyKey);
  return hydrateActionIntake(row);
}

/** Record one intake row. Throws on a duplicate (org, idempotencyKey) —
 * callers MUST check getActionIntakeByKey first and short-circuit on a hit;
 * this is the durable half of that race-free pattern (same "read-check-write
 * synchronously inside better-sqlite3" guarantee transitionOperation relies
 * on above — two concurrent callers racing the same key can never both win). */
function recordActionIntake({ orgId, idempotencyKey, actionItemId, sourceRefs = [] } = {}) {
  if (!orgId) throw new Error('recordActionIntake requires orgId');
  if (!idempotencyKey) throw new Error('recordActionIntake requires idempotencyKey');
  if (!actionItemId) throw new Error('recordActionIntake requires actionItemId');
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO calendarq_action_intake (org_id, idempotency_key, action_item_id, source_refs_json)
      VALUES (?, ?, ?, ?)
    `).run(orgId, idempotencyKey, actionItemId, JSON.stringify(sourceRefs || []));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error(`recordActionIntake: idempotencyKey "${idempotencyKey}" already recorded for ${orgId}`);
    throw e;
  }
  return getActionIntakeByKey(orgId, idempotencyKey);
}

module.exports = {
  _useTestDb,
  _reset,
  // connections
  createConnection,
  getConnection,
  listConnections,
  setConnectionStatus,
  listAllActiveConnections,
  // generations + occurrences
  createGeneration,
  getGeneration,
  getLatestGenerationForConnection,
  markGenerationComplete,
  markGenerationFailed,
  publishGeneration,
  insertOccurrence,
  listOccurrences,
  readPublishedOccurrences,
  // operations
  createOperation,
  getOperationByOpId,
  listOperations,
  listAllOperationsByState,
  transitionOperation,
  reconcileOperation,
  _setProposalJsonForTest,
  // layers
  upsertLayer,
  getLayer,
  listLayers,
  // receipts
  insertReceipt,
  getReceipt,
  listReceipts,
  // sync state (L2-C1 loop triad)
  getSyncState,
  upsertSyncState,
  resetSyncState,
  // oauth connect state (L2-C1)
  createOauthState,
  consumeOauthState,
  // briefs (L2-C3 U2)
  getLatestBriefForWorkday,
  getLatestBriefOverall,
  createBrief,
  // action intake ledger (L2-C3 U3)
  getActionIntakeByKey,
  recordActionIntake,
};

'use strict';

/**
 * InboxQ store — the collector-owned, org-scoped source of truth for the
 * InboxQ email-management plugin.
 *
 * Persistence idiom mirrors toolDefinitionsStore.js / channelConversationStore.js:
 * a lazily-opened better-sqlite3 database at INBOXQ_DB_PATH (default
 * /var/lib/quox/inboxq.db), ':memory:' in tests. Every table carries org_id
 * NOT NULL and every read filters on it — a fresh browser or a different org
 * MUST never see another org's mail (repo CLAUDE.md, ZERO TOLERANCE
 * multi-tenant scoping).
 *
 * SECURITY: this store NEVER holds credentials. It holds a reference to a
 * vault credential_id only; the plaintext IMAP/SMTP secret is resolved
 * just-in-time by the sync worker via the auth internal decrypt endpoint and
 * is never written here. Messages carry a 2KB SNIPPET (used by list/report
 * reads) plus, since P1b, an optional bounded full body (body_html/body_text,
 * each capped at imap.js's MAX_BODY_BYTES) captured at sync time. listMessages
 * / listMessagesByFlag deliberately SELECT an explicit column list that
 * excludes the body columns so list responses stay snippet-sized; only
 * getMessage (the single-message detail read) returns the body.
 *
 * Tables:
 *   inboxq_accounts      — a connected mailbox (org_id, credential_id, address)
 *   inboxq_folder_state  — per (account, folder) sync cursor + loop-triad state
 *   inboxq_messages      — ingested message headers + snippet + zone/flags
 *   inboxq_watches       — awaited-mail watches (alert me when X arrives)
 *   inboxq_reports       — receipt-backed daily tidy-up report snapshots
 *   inboxq_folders       — P1: durable custom filing folders per (org, account),
 *                          mapped to a REAL IMAP mailbox path. Distinct from the
 *                          triage zones (focus/fyi/auto/screened), which stay.
 *   inboxq_proposals     — filing/block/draft proposals. P1: an APPROVED 'file'
 *                          proposal now executes a real, safe IMAP UID MOVE
 *                          (see api.js hResolveProposal); block/draft remain
 *                          decision-only.
 *   inboxq_sender_reputation — per-org, per-account sender rollup (the
 *                              deterministic learning layer: junk-folder
 *                              ground truth + user refile feedback). See
 *                              /opt/quoxcore/email-analysis/INBOXQ_CLASSIFIER_IMPROVEMENTS.md §3.1
 */

const Database = require('better-sqlite3');
const { PRICING_MAP } = require('../modelPricing.js');
const { MATCH_TYPES: RULE_MATCH_TYPES, ACTIONS: RULE_ACTIONS } = require('./rules');

let _db = null;
let _dbPath = null;

/**
 * Curated cheap-tier classifier models — the opt-in, budget-capped LLM
 * tie-break classify.js consults on genuinely ambiguous mail (see
 * AMBIGUOUS_THRESHOLD there). Sourced from the collector's REAL model
 * pricing registry (lib/modelPricing.js's PRICING_MAP) so ids never drift
 * from what the rest of the collector actually charges, and curated down to
 * the cheapest tier per provider only — cost control is the entire point of
 * this setting, so a flagship model is never offered here. The `.filter`
 * keeps this list self-healing: if modelPricing.js ever drops one of these
 * tiers, it silently disappears from the choices rather than offering an
 * unpriced model.
 */
const AVAILABLE_CLASSIFIER_MODELS = [
  { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', label: 'Claude Haiku 4.5 (cheap, fast)' },
  { id: 'gpt-4o-mini', provider: 'openai', label: 'GPT-4o mini (cheap, fast)' },
].filter((m) => Boolean(PRICING_MAP[`${m.provider}/${m.id}`]));

function generateId(prefix) {
  // ULID-ish sortable-enough id without a new dep: time + random. Callers that
  // need strict ULID use the platform's ulid elsewhere; here uniqueness +
  // rough sortability is all the store needs.
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function initInboxqStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inboxq_accounts (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      email_address TEXT NOT NULL,
      display_name  TEXT,
      folders_json  TEXT NOT NULL DEFAULT '["INBOX"]',
      poll_enabled  INTEGER NOT NULL DEFAULT 1,
      created_by    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(org_id, email_address)
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_accounts_org ON inboxq_accounts(org_id);

    CREATE TABLE IF NOT EXISTS inboxq_folder_state (
      org_id               TEXT NOT NULL,
      account_id           TEXT NOT NULL,
      folder               TEXT NOT NULL,
      uidvalidity          TEXT,
      last_seen_uid        INTEGER NOT NULL DEFAULT 0,
      last_sync_at         TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      next_attempt_at      TEXT,
      backoff_stage        INTEGER NOT NULL DEFAULT 0,
      retired              INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      PRIMARY KEY (account_id, folder)
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_folder_state_org ON inboxq_folder_state(org_id);

    CREATE TABLE IF NOT EXISTS inboxq_messages (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      account_id    TEXT NOT NULL,
      folder        TEXT NOT NULL,
      -- AQ-9E P1: nullable (not NOT NULL). An interactive move whose server
      -- returned no COPYUID mapping leaves the destination uid genuinely
      -- unknown; NULL is the explicit "unresolved location" marker
      -- updateMessageFolder writes in that case, so the row's old (now
      -- WRONG, in the destination namespace) source uid is never kept and
      -- silently misread as still valid. See updateMessageFolder below.
      uid           INTEGER,
      message_id    TEXT,
      from_addr     TEXT,
      from_name     TEXT,
      subject       TEXT,
      date_ts       INTEGER,
      snippet       TEXT,
      zone          TEXT,
      flags_json    TEXT NOT NULL DEFAULT '[]',
      classified_by TEXT,
      classified_at TEXT,
      seen          INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      body_html     TEXT,
      body_text     TEXT,
      body_captured_at TEXT,
      attachments_json  TEXT,
      attachment_count  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(account_id, folder, uid)
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_messages_org_zone ON inboxq_messages(org_id, zone, date_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_inboxq_messages_account ON inboxq_messages(account_id, date_ts DESC);
    -- Message-ID dedup lookup (see insertMessage): a message moved into a
    -- synced folder gets a NEW server UID, so re-ingest looks the row up by
    -- the stable RFC Message-ID instead of (folder, uid). Idempotent —
    -- CREATE INDEX IF NOT EXISTS is safe on every startup against a live DB.
    CREATE INDEX IF NOT EXISTS idx_inboxq_messages_org_account_message_id ON inboxq_messages(org_id, account_id, message_id);

    CREATE TABLE IF NOT EXISTS inboxq_watches (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      account_id  TEXT,
      label       TEXT NOT NULL,
      match_json  TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      last_hit_at TEXT,
      hit_count   INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_watches_org ON inboxq_watches(org_id, active);

    CREATE TABLE IF NOT EXISTS inboxq_reports (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      account_id  TEXT NOT NULL,
      report_date TEXT NOT NULL,
      body_md     TEXT NOT NULL,
      counts_json TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_reports_org ON inboxq_reports(org_id, account_id, report_date DESC);

    CREATE TABLE IF NOT EXISTS inboxq_proposals (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL,
      account_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'proposed',
      approval_item_id TEXT,
      created_by      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT,
      resolved_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_proposals_org ON inboxq_proposals(org_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS inboxq_settings (
      org_id              TEXT PRIMARY KEY,
      sync_enabled        INTEGER NOT NULL DEFAULT 0,
      sync_interval_min   INTEGER NOT NULL DEFAULT 15,
      llm_budget_per_tick INTEGER NOT NULL DEFAULT 25,
      classifier_model    TEXT,
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inboxq_sender_reputation (
      org_id                TEXT NOT NULL,
      account_id            TEXT NOT NULL,
      from_addr             TEXT NOT NULL,          -- exact address, lowercased
      from_domain           TEXT NOT NULL,          -- rolled up separately for domain-level verdicts
      total_seen            INTEGER NOT NULL DEFAULT 0,
      screened_count        INTEGER NOT NULL DEFAULT 0,  -- landed in Spam/Junk OR classified screened
      focus_count           INTEGER NOT NULL DEFAULT 0,
      human_marked_spam     INTEGER NOT NULL DEFAULT 0,  -- user moved it to screened after the fact
      human_marked_ok       INTEGER NOT NULL DEFAULT 0,  -- user rescued it to focus/fyi
      has_list_unsub_count  INTEGER NOT NULL DEFAULT 0,
      blocked               INTEGER NOT NULL DEFAULT 0,  -- instant human "Block sender" (markSenderBlocked); distinct from human_marked_spam (a per-message refile signal that intentionally does NOT alone trigger auto-screen, see inboxqStore.test.js "recordUserMove bumps human_marked_spam...verdict null")
      first_seen            TEXT,
      last_seen             TEXT,
      PRIMARY KEY (account_id, from_addr)
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_sender_rep_domain ON inboxq_sender_reputation(org_id, from_domain);

    CREATE TABLE IF NOT EXISTS inboxq_folders (
      id          TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      account_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      imap_path   TEXT NOT NULL,
      created_by  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, imap_path)
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_folders_org ON inboxq_folders(org_id, account_id);

    CREATE TABLE IF NOT EXISTS inboxq_rules (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      account_id    TEXT NOT NULL,
      match_type    TEXT NOT NULL,
      match_value   TEXT NOT NULL,
      action        TEXT NOT NULL,
      target_folder TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      priority      INTEGER NOT NULL DEFAULT 0,
      created_by    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_rules_org_account ON inboxq_rules(org_id, account_id, enabled, priority DESC);

    -- AQ-9E U2: reversible moves (undo-log). One row per real IMAP move, capturing
    -- the PRE-move identity (from_folder + from_uid + from_uidvalidity + the RFC
    -- Message-ID in message_ref, for re-resolution when a uid is unknown) and the
    -- POST-move location (to_folder + to_uid + to_uidvalidity). message_id is the
    -- inboxq_messages row id (NOT the RFC header — that's message_ref). undone
    -- flips once when the move is reversed. Brand-new table: CREATE TABLE IF NOT
    -- EXISTS is the whole, safe-on-every-startup migration.
    CREATE TABLE IF NOT EXISTS inboxq_moves (
      id               TEXT PRIMARY KEY,
      org_id           TEXT NOT NULL,
      account_id       TEXT NOT NULL,
      message_id       TEXT NOT NULL,
      message_ref      TEXT,
      from_folder      TEXT NOT NULL,
      from_uid         INTEGER,
      from_uidvalidity TEXT,
      to_folder        TEXT NOT NULL,
      to_uid           INTEGER,
      to_uidvalidity   TEXT,
      kind             TEXT NOT NULL DEFAULT 'move',
      moved_at         INTEGER NOT NULL,
      undone           INTEGER NOT NULL DEFAULT 0,
      undone_at        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inboxq_moves_recent ON inboxq_moves(org_id, account_id, undone, moved_at DESC);
    CREATE INDEX IF NOT EXISTS idx_inboxq_moves_message ON inboxq_moves(org_id, message_id, undone);
  `);

  // P1b idempotent migration: the live DB has ~370 pre-existing rows, so the
  // body columns are never dropped/recreated — only added if missing. Existing
  // rows simply have NULL body until re-synced (acceptable per plan).
  addColumnIfMissing(db, 'inboxq_messages', 'body_html', 'TEXT');
  addColumnIfMissing(db, 'inboxq_messages', 'body_text', 'TEXT');
  addColumnIfMissing(db, 'inboxq_messages', 'body_captured_at', 'TEXT');
  // Instant "Block sender" (markSenderBlocked): idempotent migration, same
  // add-if-missing pattern as the P1b body columns above — the live DB has
  // pre-existing reputation rows and this column is never dropped/recreated.
  addColumnIfMissing(db, 'inboxq_sender_reputation', 'blocked', "INTEGER NOT NULL DEFAULT 0");
  // Structured-data report companion (additive alongside body_md/counts_json):
  // same idempotent add-if-missing pattern — existing rows simply have NULL
  // structured_json until the next report/generate call.
  addColumnIfMissing(db, 'inboxq_reports', 'structured_json', 'TEXT');
  // Selectable classifier model (cost control): opt-in, org-scoped, NULL by
  // default (deterministic-only, the safe default — see classify.js). Same
  // idempotent add-if-missing pattern as every other migration here.
  addColumnIfMissing(db, 'inboxq_settings', 'classifier_model', 'TEXT');
  // Block domain: distinguishes a domain-level block row (from_addr holds the
  // bare domain, e.g. "spamdomain.com") from an exact-sender block row
  // (from_addr holds a real address). Existing blocked rows default to
  // 'sender', preserving their current exact-address meaning untouched.
  addColumnIfMissing(db, 'inboxq_sender_reputation', 'block_type', "TEXT NOT NULL DEFAULT 'sender'");
  // Attachment metadata (owner ask: "at least need to see they are there").
  // NEVER the bytes — filename/contentType/size only. Same idempotent
  // add-if-missing pattern as every other migration here: existing rows
  // simply have NULL attachments_json / attachment_count 0 until re-synced.
  addColumnIfMissing(db, 'inboxq_messages', 'attachments_json', 'TEXT');
  addColumnIfMissing(db, 'inboxq_messages', 'attachment_count', 'INTEGER NOT NULL DEFAULT 0');
  // Phishing-help signals (owner ask: "help SPOT phishing"). SURFACE ONLY —
  // this column never feeds classify.js/auto-screen (see imap.js
  // computeSecurity/computePhishingRisk docs). Same idempotent
  // add-if-missing pattern as every other migration here: existing rows
  // simply have NULL security_json / phishing_risk 0 until re-synced.
  addColumnIfMissing(db, 'inboxq_messages', 'security_json', 'TEXT');
  addColumnIfMissing(db, 'inboxq_messages', 'phishing_risk', 'INTEGER NOT NULL DEFAULT 0');
  // INBOXQ-AGENT (P2b): distinguishes an agent-proposed batch from a
  // human-authored one in the UI/audit trail. createdBy stays the human
  // session's user id (the chatting user is still the actor of record) —
  // this column only records HOW the proposal was raised. Existing rows
  // default to 'ui' (every pre-agent proposal was human-raised in the panel).
  addColumnIfMissing(db, 'inboxq_proposals', 'created_via', "TEXT NOT NULL DEFAULT 'ui'");
  // P1 manual sort: instant, human-authoritative "Trust sender" — the ALLOW
  // mirror of `blocked` above. A dedicated column (not a reuse of
  // human_marked_ok, which recordUserMove's per-message refile signal already
  // owns) so an explicit trust decision is a strong, one-shot signal that
  // getReputationVerdict can check FIRST and WIN with, independent of any
  // stale blocked/human_marked_spam state. Same idempotent add-if-missing
  // pattern as every other migration here.
  addColumnIfMissing(db, 'inboxq_sender_reputation', 'trusted', 'INTEGER NOT NULL DEFAULT 0');
  // INBOXQ full-import (owner 2026-10-05): historical backfill cursor on the
  // per-folder sync state. backfill_floor_uid = the lowest UID the envelope-only
  // backfill has indexed down to; backfill_done = 1 once the whole folder is
  // indexed. Same idempotent add-if-missing pattern; existing rows start with a
  // NULL floor (backfill begins from the forward sync's lowest stored UID).
  addColumnIfMissing(db, 'inboxq_folder_state', 'backfill_floor_uid', 'INTEGER');
  addColumnIfMissing(db, 'inboxq_folder_state', 'backfill_done', "INTEGER NOT NULL DEFAULT 0");
  // INBOXQ reverse-reflection (owner 2026-10-05): when the reconcile pass last
  // diffed this folder against the server (removed vanished msgs + mirrored
  // read-state). Throttles the FETCH-FLAGS cost so a big folder isn't re-read
  // every tick. NULL = never reconciled -> due now.
  addColumnIfMissing(db, 'inboxq_folder_state', 'last_reconciled_at', 'TEXT');
  // Gmail model (owner 2026-10-05): Gmail has LABELS, not folders. For Gmail
  // accounts the sync source is [Gmail]/All Mail and each message carries its
  // Gmail labels (X-GM-LABELS) + stable id (X-GM-MSGID). Both NULL on non-Gmail
  // servers (the "absent means no signal" contract). labels_json = JSON array.
  addColumnIfMissing(db, 'inboxq_messages', 'labels_json', 'TEXT');
  addColumnIfMissing(db, 'inboxq_messages', 'gmail_msgid', 'TEXT');
  // P3 rules engine: inboxq_rules is a brand-new table, so it needs no
  // addColumnIfMissing ALTER migration — the CREATE TABLE IF NOT EXISTS in
  // the schema block above is already the idempotent, safe-on-every-startup
  // form for a table with no pre-existing rows to preserve.
  // P3 physical filing engine (owner ask: mail actually LOOKS tidy in every
  // mail client, not just inside the app). OFF by default, org-scoped —
  // same shape as sync_enabled/classifier_model above. Same idempotent
  // add-if-missing pattern as every other migration here.
  addColumnIfMissing(db, 'inboxq_settings', 'physical_filing_enabled', 'INTEGER NOT NULL DEFAULT 0');
  // P3 physical filing: the classifier's confidence for the zone a message
  // was actually stored under, persisted at insert time so a LATER filing
  // pass (preview or backlog apply) can confidence-gate WITHOUT re-running
  // the classifier. A pre-existing row (ingested before this column existed)
  // simply has NULL confidence — zoneToFolder() below treats that as "not
  // high-confidence" (fail-safe: routes fyi/auto to the Unsure review folder
  // rather than guessing), never as a reason to skip filing entirely.
  addColumnIfMissing(db, 'inboxq_messages', 'classification_confidence', 'REAL');
  // AQ-9E P1: move-identity fix. A message's uid is no longer durable across
  // an interactive move (see updateMessageFolder below), so the column must
  // accept NULL. The CREATE TABLE above already says `uid INTEGER` (no NOT
  // NULL) for a brand-new database, but SQLite cannot ALTER a column's NOT
  // NULL constraint in place, so a pre-existing live table (created before
  // this fix, still carrying the old constraint) is widened here via the
  // standard SQLite rebuild dance: copy the table's own CREATE TABLE SQL,
  // drop only the "uid INTEGER NOT NULL" constraint text, recreate under a
  // temp name, copy every row across unchanged, then swap it in. Guarded by
  // PRAGMA table_info so this is a one-time, idempotent no-op on every
  // startup after the first.
  widenMessagesUidToNullable(db);
  // uidvalidity: the destination mailbox's UIDVALIDITY at the moment of a
  // move, captured alongside the destination uid above (see
  // updateMessageFolder) — without it, a later uid lookup after the
  // mailbox's UIDVALIDITY itself changed could address an entirely
  // unrelated message. Same idempotent add-if-missing pattern as every
  // other migration here; existing rows simply have NULL until their next
  // move.
  addColumnIfMissing(db, 'inboxq_messages', 'uidvalidity', 'TEXT');
}

/** See the AQ-9E P1 comment above initInboxqStore's call site. */
function widenMessagesUidToNullable(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='inboxq_messages'`).get();
  if (!row || !/uid\s+INTEGER\s+NOT\s+NULL/i.test(row.sql)) return; // already nullable, nothing to do
  const rebuiltSql = row.sql
    .replace(/CREATE TABLE inboxq_messages/i, 'CREATE TABLE inboxq_messages_new')
    .replace(/uid\s+INTEGER\s+NOT\s+NULL/i, 'uid INTEGER');
  db.exec(`
    ${rebuiltSql};
    INSERT INTO inboxq_messages_new SELECT * FROM inboxq_messages;
    DROP TABLE inboxq_messages;
    ALTER TABLE inboxq_messages_new RENAME TO inboxq_messages;
    CREATE INDEX IF NOT EXISTS idx_inboxq_messages_org_zone ON inboxq_messages(org_id, zone, date_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_inboxq_messages_account ON inboxq_messages(account_id, date_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_inboxq_messages_org_account_message_id ON inboxq_messages(org_id, account_id, message_id);
  `);
}

// ---------------------------------------------------------------------------
// P3 physical filing engine — where classified mail REALLY moves to.
//
// Off by default (inboxq_settings.physical_filing_enabled), org-scoped like
// every other inboxq_settings toggle. Folder structure lives under ONE
// parent, "InboxQ/", so a human sees a single top-level bucket in their real
// mail client rather than four scattered top-level folders.
// ---------------------------------------------------------------------------

const FILING_FOLDERS = Object.freeze({
  fyi: 'InboxQ/FYI',
  auto: 'InboxQ/Auto',
  screened: 'InboxQ/Screened',
  unsure: 'InboxQ/Unsure to check',
});
const FILING_FOLDER_LIST = Object.freeze(Object.values(FILING_FOLDERS));

// The bar for "confident enough to auto-file into its own zone folder".
// Deliberately DISTINCT from classify.js's AMBIGUOUS_THRESHOLD (0.6) — that
// threshold decides "is the rule verdict good enough to skip the LLM
// tie-break", a classification-cost question. This threshold decides "is the
// classification good enough to move real mail on a real server without a
// human looking first" — a physical-mutation-safety question, and is
// deliberately set HIGHER (0.75) than the classify threshold: a message can
// clear the classify bar (no LLM needed) while still not being sure enough
// to file unsupervised.
const HIGH_CONFIDENCE_FILING_THRESHOLD = 0.75;

/**
 * Pure mapping: given a message's zone + classification confidence, return
 * the real IMAP folder path physical filing should move it to, or null if it
 * should stay exactly where it is (INBOX).
 *
 *   focus              -> null (ALWAYS stays in INBOX — the one zone that is
 *                          never physically moved, regardless of confidence)
 *   screened            -> InboxQ/Screened (a REVIEW folder for suspected
 *                          junk, not auto-Junk — confidence-independent: a
 *                          screened verdict is itself already the "look at
 *                          this" bucket, so there is nothing to further gate)
 *   fyi / auto, high conf (>= HIGH_CONFIDENCE_FILING_THRESHOLD)
 *                       -> InboxQ/FYI or InboxQ/Auto respectively
 *   fyi / auto, low/unknown conf (including confidence omitted/NULL — the
 *   pre-migration-row / not-yet-computed case)
 *                       -> InboxQ/Unsure to check (never misfiled, never
 *                          silently dropped)
 *   anything else (an unrecognized/unclassified zone, e.g. a message that
 *   has not been classified yet, or the reputation layer's internal 'ok'
 *   verdict leaking through — see syncWorker.js)
 *                       -> null, fail-safe: never move mail whose
 *                          destination is unclear.
 */
function zoneToFolder(zone, confidence) {
  if (zone === 'focus') return null;
  if (zone === 'screened') return FILING_FOLDERS.screened;
  if (zone === 'fyi' || zone === 'auto') {
    const conf = Number(confidence);
    const isHighConfidence = Number.isFinite(conf) && conf >= HIGH_CONFIDENCE_FILING_THRESHOLD;
    return isHighConfidence ? FILING_FOLDERS[zone] : FILING_FOLDERS.unsure;
  }
  return null;
}

/** Add `column` to `table` only if it does not already exist — safe to call on
 * every startup against a live DB with existing data (never DROP/recreate). */
function addColumnIfMissing(db, table, column, decl) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = info.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

const DEFAULT_SETTINGS = { syncEnabled: false, syncIntervalMin: 15, llmBudgetPerTick: 25, classifierModel: null, physicalFilingEnabled: false };

function getSettings(orgId) {
  if (!orgId) throw new Error('getSettings requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_settings WHERE org_id = ?`).get(orgId);
  if (!row) return { ...DEFAULT_SETTINGS, orgId };
  return {
    orgId,
    syncEnabled: Boolean(row.sync_enabled),
    syncIntervalMin: row.sync_interval_min,
    llmBudgetPerTick: row.llm_budget_per_tick,
    // NULL (default) = disabled, deterministic-only classification. Never
    // fabricated to a default model — see classify.js's llm contract.
    classifierModel: row.classifier_model || null,
    // P3 physical filing: OFF by default (row absent, or the column's own
    // DEFAULT 0 on a pre-migration row) — an explicit opt-in, never implied
    // by anything else being enabled.
    physicalFilingEnabled: Boolean(row.physical_filing_enabled),
    updatedAt: row.updated_at,
  };
}

/**
 * @param {object} patch may include classifierModel: a string id from
 *   AVAILABLE_CLASSIFIER_MODELS, or null/undefined to disable. Callers (the
 *   API handler) are responsible for rejecting an id not in the allowed
 *   list BEFORE calling this — this layer persists whatever it is given.
 */
function setSettings(orgId, patch = {}) {
  if (!orgId) throw new Error('setSettings requires orgId');
  const db = getDb();
  const cur = getSettings(orgId);
  const merged = {
    sync_enabled: (patch.syncEnabled ?? cur.syncEnabled) ? 1 : 0,
    // clamp cadence to a sane floor (5m) so a user can't hammer the mailbox.
    sync_interval_min: Math.max(5, Math.min(Number(patch.syncIntervalMin ?? cur.syncIntervalMin) || 15, 1440)),
    llm_budget_per_tick: Math.max(0, Math.min(Number(patch.llmBudgetPerTick ?? cur.llmBudgetPerTick) || 0, 500)),
    classifier_model: patch.classifierModel !== undefined ? (patch.classifierModel || null) : (cur.classifierModel ?? null),
    // P3 physical filing: off by default; only an explicit true flips it on.
    physical_filing_enabled: (patch.physicalFilingEnabled ?? cur.physicalFilingEnabled) ? 1 : 0,
  };
  db.prepare(`
    INSERT INTO inboxq_settings (org_id, sync_enabled, sync_interval_min, llm_budget_per_tick, classifier_model, physical_filing_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(org_id) DO UPDATE SET
      sync_enabled = excluded.sync_enabled,
      sync_interval_min = excluded.sync_interval_min,
      llm_budget_per_tick = excluded.llm_budget_per_tick,
      classifier_model = excluded.classifier_model,
      physical_filing_enabled = excluded.physical_filing_enabled,
      updated_at = excluded.updated_at
  `).run(orgId, merged.sync_enabled, merged.sync_interval_min, merged.llm_budget_per_tick, merged.classifier_model, merged.physical_filing_enabled);
  return getSettings(orgId);
}

/** Cross-org: orgs with background sync enabled (for the scheduler). */
function listSyncEnabledOrgs() {
  const db = getDb();
  return db.prepare(`SELECT org_id, sync_interval_min, llm_budget_per_tick FROM inboxq_settings WHERE sync_enabled = 1`).all()
    .map((r) => ({ orgId: r.org_id, syncIntervalMin: r.sync_interval_min, llmBudgetPerTick: r.llm_budget_per_tick }));
}

/** quox#813: orgs with polling mailboxes but background sync off -> [{ orgId, mailboxes }]. */
function listSyncOffOrgsWithMailboxes() {
  const db = getDb();
  return db.prepare(`SELECT a.org_id AS org_id, COUNT(*) AS n FROM inboxq_accounts a
    LEFT JOIN inboxq_settings s ON s.org_id = a.org_id
    WHERE a.poll_enabled = 1 AND COALESCE(s.sync_enabled, 0) = 0
    GROUP BY a.org_id`).all().map((r) => ({ orgId: r.org_id, mailboxes: r.n }));
}

function getDb() {
  if (_db) return _db;
  _dbPath = process.env.INBOXQ_DB_PATH || '/var/lib/quox/inboxq.db';
  _db = new Database(_dbPath);
  _db.pragma('journal_mode = WAL');
  initInboxqStore(_db);
  return _db;
}

/**
 * Test seam: open an in-memory (or explicit-path) db and use it for all
 * subsequent calls. Returns the db handle so a test can inspect it directly.
 */
function _useTestDb(path = ':memory:') {
  if (_db) {
    try { _db.close(); } catch { /* non-fatal */ }
  }
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  initInboxqStore(_db);
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

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function createAccount({ orgId, credentialId, emailAddress, displayName = null, folders = ['INBOX'], createdBy = null }) {
  if (!orgId) throw new Error('createAccount requires orgId');
  if (!credentialId) throw new Error('createAccount requires credentialId');
  if (!emailAddress) throw new Error('createAccount requires emailAddress');
  const db = getDb();
  const id = generateId('inbacc');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO inboxq_accounts (id, org_id, credential_id, email_address, display_name, folders_json, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, email_address) DO UPDATE SET
      credential_id = excluded.credential_id,
      display_name = excluded.display_name,
      folders_json = excluded.folders_json,
      updated_at = excluded.updated_at
  `).run(id, orgId, credentialId, emailAddress, displayName, JSON.stringify(folders), createdBy, now, now);
  // Return the row (which may be the pre-existing one on conflict).
  return getAccountByAddress(orgId, emailAddress);
}

function getAccount(orgId, accountId) {
  if (!orgId) throw new Error('getAccount requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_accounts WHERE org_id = ? AND id = ?`).get(orgId, accountId);
  return row ? hydrateAccount(row) : null;
}

function getAccountByAddress(orgId, emailAddress) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_accounts WHERE org_id = ? AND email_address = ?`).get(orgId, emailAddress);
  return row ? hydrateAccount(row) : null;
}

function listAccounts(orgId, { includeDisabled = true } = {}) {
  if (!orgId) throw new Error('listAccounts requires orgId');
  const db = getDb();
  const rows = includeDisabled
    ? db.prepare(`SELECT * FROM inboxq_accounts WHERE org_id = ? ORDER BY created_at ASC`).all(orgId)
    : db.prepare(`SELECT * FROM inboxq_accounts WHERE org_id = ? AND poll_enabled = 1 ORDER BY created_at ASC`).all(orgId);
  return rows.map(hydrateAccount);
}

/** Cross-org: used ONLY by the sync worker to enumerate all pollable accounts. */
function listAllPollableAccounts() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM inboxq_accounts WHERE poll_enabled = 1 ORDER BY org_id, created_at ASC`).all();
  return rows.map(hydrateAccount);
}

function setAccountPoll(orgId, accountId, enabled) {
  const db = getDb();
  const info = db.prepare(`UPDATE inboxq_accounts SET poll_enabled = ?, updated_at = ? WHERE org_id = ? AND id = ?`)
    .run(enabled ? 1 : 0, new Date().toISOString(), orgId, accountId);
  return info.changes > 0;
}

/**
 * Persist the human-picked set of folders an account should sync (the "safe
 * connect" default is ['INBOX'] only, set at createAccount time; this is the
 * write path for the user later opting into more folders). org-scoped: the
 * UPDATE's WHERE clause requires org_id + id so a cross-org accountId is a
 * silent no-op (returns null), never another org's account.
 */
function updateAccountFolders(orgId, accountId, folders) {
  if (!orgId) throw new Error('updateAccountFolders requires orgId');
  if (!accountId) throw new Error('updateAccountFolders requires accountId');
  if (!Array.isArray(folders) || folders.length === 0) {
    throw new Error('folders must be a non-empty array of folder names');
  }
  if (!folders.every((f) => typeof f === 'string' && f.trim().length > 0)) {
    throw new Error('folders must be non-empty strings');
  }
  const db = getDb();
  const info = db.prepare(`UPDATE inboxq_accounts SET folders_json = ?, updated_at = ? WHERE org_id = ? AND id = ?`)
    .run(JSON.stringify(folders), new Date().toISOString(), orgId, accountId);
  if (info.changes === 0) return null;
  return getAccount(orgId, accountId);
}

function deleteAccount(orgId, accountId) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM inboxq_messages WHERE org_id = ? AND account_id = ?`).run(orgId, accountId);
    db.prepare(`DELETE FROM inboxq_folder_state WHERE org_id = ? AND account_id = ?`).run(orgId, accountId);
    db.prepare(`DELETE FROM inboxq_proposals WHERE org_id = ? AND account_id = ?`).run(orgId, accountId);
    db.prepare(`DELETE FROM inboxq_reports WHERE org_id = ? AND account_id = ?`).run(orgId, accountId);
    // codex F10: account-specific watches were leaked by delete. Remove them too
    // (org-wide watches, account_id IS NULL, are deliberately kept).
    db.prepare(`DELETE FROM inboxq_watches WHERE org_id = ? AND account_id = ?`).run(orgId, accountId);
    const info = db.prepare(`DELETE FROM inboxq_accounts WHERE org_id = ? AND id = ?`).run(orgId, accountId);
    return info.changes > 0;
  });
  return tx();
}

function hydrateAccount(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    credentialId: row.credential_id,
    emailAddress: row.email_address,
    displayName: row.display_name,
    folders: safeParse(row.folders_json, ['INBOX']),
    pollEnabled: Boolean(row.poll_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Folder state (sync cursor + loop-triad)
// ---------------------------------------------------------------------------

function getFolderState(orgId, accountId, folder) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_folder_state WHERE org_id = ? AND account_id = ? AND folder = ?`)
    .get(orgId, accountId, folder);
  return row || null;
}

/**
 * INBOXQ full-import (owner 2026-10-05): the lowest UID already indexed for a
 * (account, folder), or null when nothing is stored yet. The backfill starts
 * from here and walks downward; a null means the forward sync must seed the
 * folder first (we never backfill from thin air).
 */
function lowestIndexedUid(orgId, accountId, folder) {
  if (!orgId) throw new Error('lowestIndexedUid requires orgId');
  const db = getDb();
  const row = db.prepare(
    `SELECT MIN(uid) AS lo FROM inboxq_messages WHERE org_id = ? AND account_id = ? AND folder = ?`
  ).get(orgId, accountId, folder);
  return row && row.lo != null ? Number(row.lo) : null;
}

/** INBOXQ full-import: persist the backfill floor cursor for a (account, folder).
 * Upserts the folder-state row so it works even before the forward sync created
 * one. Org-scoped in the WHERE so a cross-org call is a no-op on update. */
function setBackfillFloor(orgId, accountId, folder, floorUid) {
  if (!orgId) throw new Error('setBackfillFloor requires orgId');
  const db = getDb();
  db.prepare(`
    INSERT INTO inboxq_folder_state (org_id, account_id, folder, backfill_floor_uid)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, folder) DO UPDATE SET backfill_floor_uid = excluded.backfill_floor_uid
    WHERE inboxq_folder_state.org_id = excluded.org_id
  `).run(orgId, accountId, folder, Number(floorUid) || 0);
}

/** INBOXQ full-import: mark a (account, folder) fully indexed (backfill reached
 * the bottom of the UID space). Idempotent. */
function setBackfillDone(orgId, accountId, folder) {
  if (!orgId) throw new Error('setBackfillDone requires orgId');
  const db = getDb();
  db.prepare(`
    INSERT INTO inboxq_folder_state (org_id, account_id, folder, backfill_done, backfill_floor_uid)
    VALUES (?, ?, ?, 1, 1)
    ON CONFLICT(account_id, folder) DO UPDATE SET backfill_done = 1
    WHERE inboxq_folder_state.org_id = excluded.org_id
  `).run(orgId, accountId, folder);
}

function upsertFolderState(orgId, accountId, folder, patch = {}) {
  const db = getDb();
  const existing = getFolderState(orgId, accountId, folder);
  const merged = {
    uidvalidity: patch.uidvalidity ?? existing?.uidvalidity ?? null,
    last_seen_uid: patch.last_seen_uid ?? existing?.last_seen_uid ?? 0,
    last_sync_at: patch.last_sync_at ?? existing?.last_sync_at ?? null,
    consecutive_failures: patch.consecutive_failures ?? existing?.consecutive_failures ?? 0,
    next_attempt_at: patch.next_attempt_at ?? existing?.next_attempt_at ?? null,
    backoff_stage: patch.backoff_stage ?? existing?.backoff_stage ?? 0,
    retired: patch.retired ?? existing?.retired ?? 0,
    last_error: patch.last_error ?? existing?.last_error ?? null,
  };
  db.prepare(`
    INSERT INTO inboxq_folder_state
      (org_id, account_id, folder, uidvalidity, last_seen_uid, last_sync_at, consecutive_failures, next_attempt_at, backoff_stage, retired, last_error)
    VALUES (@org_id, @account_id, @folder, @uidvalidity, @last_seen_uid, @last_sync_at, @consecutive_failures, @next_attempt_at, @backoff_stage, @retired, @last_error)
    ON CONFLICT(account_id, folder) DO UPDATE SET
      uidvalidity = excluded.uidvalidity,
      last_seen_uid = excluded.last_seen_uid,
      last_sync_at = excluded.last_sync_at,
      consecutive_failures = excluded.consecutive_failures,
      next_attempt_at = excluded.next_attempt_at,
      backoff_stage = excluded.backoff_stage,
      retired = excluded.retired,
      last_error = excluded.last_error
    WHERE inboxq_folder_state.org_id = excluded.org_id
  `).run({ org_id: orgId, account_id: accountId, folder, ...merged });
  // codex F05: the ON CONFLICT is keyed on (account_id, folder) which is not
  // org-qualified, so without the WHERE guard a wrong-org caller would silently
  // overwrite another org's cursor/retirement. The guard makes a cross-org
  // upsert a no-op (the pre-existing row keeps org A; the update WHERE fails).
  return getFolderState(orgId, accountId, folder);
}

/** codex F15: clear retirement + failure state for an account's folders so a
 * credential repair / reconnect can resume. Org-scoped. */
function clearRetirement(orgId, accountId) {
  const db = getDb();
  const info = db.prepare(`
    UPDATE inboxq_folder_state
    SET retired = 0, consecutive_failures = 0, backoff_stage = 0, next_attempt_at = NULL, last_error = NULL
    WHERE org_id = ? AND account_id = ?
  `).run(orgId, accountId);
  return info.changes;
}

/** codex F03: on a UIDVALIDITY reset the old generation's rows must be cleared
 * before the new generation ingests, or INSERT OR IGNORE collides on
 * (account,folder,uid) and the new message is silently dropped. Org-scoped. */
function deleteFolderMessages(orgId, accountId, folder) {
  const db = getDb();
  const info = db.prepare(`DELETE FROM inboxq_messages WHERE org_id = ? AND account_id = ? AND folder = ?`)
    .run(orgId, accountId, folder);
  return info.changes;
}

// INBOXQ reverse-reflection (owner 2026-10-05). The reconcile pass reads these.

/** Every stored message's {id, uid, seen} for one (account, folder) — the local
 * truth the reconcile diffs against the server's current state. */
function getFolderUidState(orgId, accountId, folder) {
  if (!orgId) throw new Error('getFolderUidState requires orgId');
  const db = getDb();
  return db.prepare(
    `SELECT id, uid, seen FROM inboxq_messages WHERE org_id = ? AND account_id = ? AND folder = ? AND uid IS NOT NULL`
  ).all(orgId, accountId, folder).map((r) => ({ id: r.id, uid: Number(r.uid), seen: Boolean(r.seen) }));
}

/** Remove stored messages by UID in one folder — a message that vanished from
 * the server (deleted or moved away in another client). Org+account+folder
 * scoped; chunked so a large diff never builds an unbounded IN(...) clause. */
function deleteMessagesByUids(orgId, accountId, folder, uids) {
  if (!orgId) throw new Error('deleteMessagesByUids requires orgId');
  const list = (Array.isArray(uids) ? uids : []).map(Number).filter((u) => Number.isFinite(u));
  if (list.length === 0) return 0;
  const db = getDb();
  let removed = 0;
  const CHUNK = 400;
  const run = db.transaction((batch) => {
    const placeholders = batch.map(() => '?').join(',');
    const info = db.prepare(
      `DELETE FROM inboxq_messages WHERE org_id = ? AND account_id = ? AND folder = ? AND uid IN (${placeholders})`
    ).run(orgId, accountId, folder, ...batch);
    removed += info.changes;
  });
  for (let i = 0; i < list.length; i += CHUNK) run(list.slice(i, i + CHUNK));
  return removed;
}

/** Stamp when a folder was last reconciled against the server (throttle). Upserts
 * so it works before the forward sync created a folder-state row. */
function markReconciled(orgId, accountId, folder, iso) {
  if (!orgId) throw new Error('markReconciled requires orgId');
  const db = getDb();
  db.prepare(`
    INSERT INTO inboxq_folder_state (org_id, account_id, folder, last_reconciled_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, folder) DO UPDATE SET last_reconciled_at = excluded.last_reconciled_at
    WHERE inboxq_folder_state.org_id = excluded.org_id
  `).run(orgId, accountId, folder, iso);
}

/** Mirror read/unread from the server: set seen=1 for seenUids, seen=0 for
 * unseenUids, within one (account, folder). Chunked. Returns rows changed. */
function setSeenByUids(orgId, accountId, folder, { seenUids = [], unseenUids = [] } = {}) {
  if (!orgId) throw new Error('setSeenByUids requires orgId');
  const db = getDb();
  let changed = 0;
  const CHUNK = 400;
  const apply = (uids, value) => {
    const list = (Array.isArray(uids) ? uids : []).map(Number).filter((u) => Number.isFinite(u));
    const run = db.transaction((batch) => {
      const placeholders = batch.map(() => '?').join(',');
      const info = db.prepare(
        `UPDATE inboxq_messages SET seen = ? WHERE org_id = ? AND account_id = ? AND folder = ? AND uid IN (${placeholders})`
      ).run(value, orgId, accountId, folder, ...batch);
      changed += info.changes;
    });
    for (let i = 0; i < list.length; i += CHUNK) run(list.slice(i, i + CHUNK));
  };
  apply(seenUids, 1);
  apply(unseenUids, 0);
  return changed;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Insert a message if its (account, folder, uid) is not already present.
 * Returns true if inserted, false if it was a duplicate (durable retirement:
 * a message already ingested can never be re-ingested) OR if it was matched
 * and merged onto an existing row by Message-ID (see below) — either way,
 * no new row was created.
 *
 * Message-ID dedup (fixes duplicate rows on move+resync): a message MOVED
 * into a synced folder (manual move, rule move, or physical filing) gets a
 * NEW server UID in the destination folder. On the next sync of that folder,
 * ingest would otherwise see (account, dest_folder, NEW uid) — which does not
 * match the existing row (still at the OLD folder/uid) — and INSERT a SECOND
 * row for the same email. The stable RFC Message-ID does not change on a
 * move, so when the incoming message carries a non-empty message_id, look up
 * an existing row for the same (org_id, account_id, message_id) FIRST. If
 * found, this is the SAME email re-observed at a new location: update that
 * row's folder/uid (+ freshness fields, when supplied) IN PLACE and return
 * without inserting — classification/zone/flags/body/attachments/security are
 * deliberately left untouched, only location and freshness move. This also
 * covers a message the user moved between folders in their OWN mail client
 * (Quox re-syncs and updates the row's folder, no duplicate).
 *
 * A message with no message_id (some genuinely lack one) skips this lookup
 * entirely and falls through to the original (account, folder, uid)
 * INSERT OR IGNORE path unchanged.
 */
function insertMessage(msg) {
  const db = getDb();
  const id = msg.id || generateId('inbmsg');
  const hasBody = msg.bodyHtml != null || msg.bodyText != null;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  // Phishing-help signals (owner ask): additive, surface-only — see imap.js.
  // Never fabricated: a caller that never computed a security object (e.g. an
  // older code path) simply stores NULL / risk 0, same "absent means no
  // signal" contract as every other optional column here.
  const security = msg.security || null;
  const phishingRisk = Number.isFinite(Number(msg.phishingRisk)) ? Number(msg.phishingRisk) : 0;
  // P3 physical filing: the classifier's confidence for `msg.zone`, persisted
  // so a later filing pass can confidence-gate without re-classifying.
  // Optional — a caller that never computed one (e.g. an older code path)
  // simply stores NULL, same "absent means no signal" contract as security.
  const confidence = Number.isFinite(Number(msg.confidence)) ? Number(msg.confidence) : null;

  const messageId = msg.messageId || null;
  const labelsJsonDedup = Array.isArray(msg.labels) && msg.labels.length ? JSON.stringify(msg.labels) : null;
  if (messageId) {
    const existing = db.prepare(`
      SELECT id FROM inboxq_messages WHERE org_id = ? AND account_id = ? AND message_id = ?
    `).get(msg.orgId, msg.accountId, messageId);
    if (existing) {
      // Gmail: a re-sync can carry updated labels / the stable X-GM-MSGID — refresh
      // them (COALESCE so a plain re-sync without labels never wipes existing ones).
      db.prepare(`
        UPDATE inboxq_messages
        SET folder = ?, uid = ?, date_ts = COALESCE(?, date_ts), snippet = COALESCE(?, snippet),
            labels_json = COALESCE(?, labels_json), gmail_msgid = COALESCE(?, gmail_msgid)
        WHERE id = ?
      `).run(msg.folder, msg.uid, msg.dateTs ?? null, msg.snippet ?? null, labelsJsonDedup, msg.gmailId || null, existing.id);
      return false;
    }
  }

  const labelsJson = Array.isArray(msg.labels) && msg.labels.length ? JSON.stringify(msg.labels) : null;
  const info = db.prepare(`
    INSERT OR IGNORE INTO inboxq_messages
      (id, org_id, account_id, folder, uid, message_id, from_addr, from_name, subject, date_ts, snippet, zone, flags_json, classified_by, classified_at, seen, body_html, body_text, body_captured_at, attachments_json, attachment_count, security_json, phishing_risk, classification_confidence, labels_json, gmail_msgid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, msg.orgId, msg.accountId, msg.folder, msg.uid, msg.messageId || null,
    msg.fromAddr || null, msg.fromName || null, msg.subject || null,
    msg.dateTs || null, msg.snippet || null, msg.zone || null,
    JSON.stringify(msg.flags || []), msg.classifiedBy || null,
    msg.zone ? new Date().toISOString() : null, msg.seen ? 1 : 0,
    msg.bodyHtml || null, msg.bodyText || null, hasBody ? new Date().toISOString() : null,
    attachments.length ? JSON.stringify(attachments) : null, attachments.length,
    security ? JSON.stringify(security) : null, phishingRisk, confidence,
    labelsJson, msg.gmailId || null,
  );
  return info.changes > 0;
}

function listMessages(orgId, { accountId = null, zone = null, limit = 50, offset = 0 } = {}) {
  if (!orgId) throw new Error('listMessages requires orgId');
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  if (zone) { clauses.push('zone = ?'); params.push(zone); }
  // codex F12: clamp to a finite positive range. A negative LIMIT is treated by
  // SQLite as "no limit" and would load the whole org's mail into memory. A
  // non-positive or non-finite request falls back to the default (50).
  const nLimit = Math.floor(Number(limit));
  const safeLimit = (!Number.isFinite(nLimit) || nLimit <= 0) ? 50 : Math.min(nLimit, 500);
  const nOffset = Math.floor(Number(offset));
  const safeOffset = (!Number.isFinite(nOffset) || nOffset < 0) ? 0 : nOffset;
  params.push(safeLimit, safeOffset);
  // codex-P1b: explicit column list (NOT SELECT *) — body_html/body_text are
  // deliberately excluded here so list responses stay snippet-sized; use
  // getMessage() for the full (bounded) body. attachments_json is excluded
  // for the same reason (row-lean lists); attachment_count is cheap and
  // included so a row can show a paperclip without the full metadata array.
  // security_json is excluded for the same row-lean reason; phishing_risk
  // (a single cheap int) IS included so a row can show a badge.
  const rows = db.prepare(`
    SELECT id, org_id, account_id, folder, uid, message_id, from_addr, from_name, subject,
           date_ts, snippet, zone, flags_json, classified_by, classified_at, seen, created_at,
           body_captured_at, attachment_count, phishing_risk, classification_confidence,
           labels_json, gmail_msgid
    FROM inboxq_messages
    WHERE ${clauses.join(' AND ')}
    ORDER BY date_ts DESC NULLS LAST, uid DESC
    LIMIT ? OFFSET ?
  `).all(...params);
  return rows.map(hydrateMessage);
}

function countByZone(orgId, accountId = null) {
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  const rows = db.prepare(`
    SELECT zone, COUNT(*) AS n FROM inboxq_messages
    WHERE ${clauses.join(' AND ')}
    GROUP BY zone
  `).all(...params);
  const out = {};
  for (const r of rows) out[r.zone || 'unclassified'] = r.n;
  return out;
}

/** AQ-9E U3 (folder-first): per-folder stored message counts, org+account
 * scoped. The "stored" number a human sees against each real folder. */
function countByFolder(orgId, accountId = null) {
  if (!orgId) throw new Error('countByFolder requires orgId');
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  const rows = db.prepare(`
    SELECT folder, COUNT(*) AS n FROM inboxq_messages
    WHERE ${clauses.join(' AND ')}
    GROUP BY folder
  `).all(...params);
  const out = {};
  for (const r of rows) { if (r.folder != null) out[r.folder] = r.n; }
  return out;
}

/** GMAIL labels-as-folders (owner 2026-10-05): the distinct Gmail labels across
 * an account's messages, with per-label counts. This is the "folder" list a
 * Gmail account presents — Inbox/Sent/Starred/Important/custom are labels, not
 * folders. json_each expands the labels_json array so each label is counted
 * independently (a message with 3 labels contributes to all 3). */
function listLabels(orgId, accountId) {
  if (!orgId) throw new Error('listLabels requires orgId');
  if (!accountId) throw new Error('listLabels requires accountId');
  const db = getDb();
  const rows = db.prepare(`
    SELECT je.value AS label, COUNT(*) AS n
    FROM inboxq_messages, json_each(inboxq_messages.labels_json) AS je
    WHERE org_id = ? AND account_id = ? AND labels_json IS NOT NULL
    GROUP BY je.value
    ORDER BY n DESC
  `).all(orgId, accountId);
  return rows.map((r) => ({ label: r.label, count: r.n }));
}

/** AQ-9E U3 (folder-first): per-folder reconcile state (last successful sync +
 * loop-triad health) for every folder this account has a sync cursor for. */
function listFolderStates(orgId, accountId = null) {
  if (!orgId) throw new Error('listFolderStates requires orgId');
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  const rows = db.prepare(`SELECT * FROM inboxq_folder_state WHERE ${clauses.join(' AND ')}`).all(...params);
  return rows.map((r) => ({
    folder: r.folder,
    lastSyncAt: r.last_sync_at ?? null,
    consecutiveFailures: r.consecutive_failures ?? 0,
    retired: r.retired ?? 0,
    lastError: r.last_error ?? null,
    nextAttemptAt: r.next_attempt_at ?? null,
    uidvalidity: r.uidvalidity ?? null,
    backfillDone: r.backfill_done ? 1 : 0,
  }));
}

function countMessages(orgId, accountId = null) {
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM inboxq_messages WHERE ${clauses.join(' AND ')}`).get(...params);
  return row ? row.n : 0;
}

/** codex F11: fetch messages carrying a given flag, INDEPENDENT of the recent
 * date-sampled window, so a burst of future-dated spam cannot push a real
 * action item out of the report's sample and make it falsely read "clear". */
function listMessagesByFlag(orgId, { accountId = null, flag, limit = 200 } = {}) {
  if (!orgId || !flag) return [];
  const db = getDb();
  const clauses = ['org_id = ?', "flags_json LIKE ?"];
  const params = [orgId, `%"${flag}"%`];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit)) || 200, 1000));
  params.push(safeLimit);
  // codex-P1b: explicit column list (NOT SELECT *) — see listMessages above.
  const rows = db.prepare(`
    SELECT id, org_id, account_id, folder, uid, message_id, from_addr, from_name, subject,
           date_ts, snippet, zone, flags_json, classified_by, classified_at, seen, created_at,
           body_captured_at, attachment_count, phishing_risk, classification_confidence
    FROM inboxq_messages WHERE ${clauses.join(' AND ')}
    ORDER BY date_ts DESC NULLS LAST, uid DESC LIMIT ?
  `).all(...params);
  return rows.map(hydrateMessage);
}

/**
 * INBOXQ-AGENT (P2b): bounded keyword/field search over an account's stored
 * mail, the read primitive both the search route and the `inbox_search`
 * agent tool share (one query path, per INBOXQ_AGENT_DESIGN.md §A). Every
 * clause is optional and AND-ed together. `total` is the FULL match count
 * (unbounded by `limit`), so a caller can report "27 matches" honestly even
 * when only showing/freezing the first page — `inbox_propose_move`'s
 * matchSpec-freeze (server re-run at propose time, capped at 200 ids) reads
 * `total` to know whether it proposed everything or "first 200 of N".
 * Org+account scoped like every other read here; accountId is required so a
 * search can never silently span the whole org's connected mailboxes.
 */
function searchMessages(orgId, { accountId, from = null, fromDomain = null, subject = null, text = null, zone = null, folder = null, flag = null, label = null, limit = 50 } = {}) {
  if (!orgId) throw new Error('searchMessages requires orgId');
  if (!accountId) throw new Error('searchMessages requires accountId');
  const db = getDb();
  const clauses = ['org_id = ?', 'account_id = ?'];
  const params = [orgId, accountId];
  // Gmail labels-as-folders: match a message that carries this Gmail label.
  // json_each parses the labels_json array so the comparison is on the real
  // (unescaped) label value — no fragile LIKE/backslash matching.
  if (label) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(inboxq_messages.labels_json) WHERE value = ?)');
    params.push(label);
  }
  if (from) { clauses.push('lower(from_addr) LIKE ?'); params.push(`%${String(from).toLowerCase()}%`); }
  if (fromDomain) { clauses.push('lower(from_addr) LIKE ?'); params.push(`%@${String(fromDomain).toLowerCase().replace(/^@/, '')}`); }
  if (subject) { clauses.push('lower(subject) LIKE ?'); params.push(`%${String(subject).toLowerCase()}%`); }
  if (text) {
    clauses.push('(lower(subject) LIKE ? OR lower(snippet) LIKE ? OR lower(from_addr) LIKE ? OR lower(from_name) LIKE ?)');
    const t = `%${String(text).toLowerCase()}%`;
    params.push(t, t, t, t);
  }
  if (zone) { clauses.push('zone = ?'); params.push(zone); }
  if (folder) { clauses.push('folder = ?'); params.push(folder); }
  if (flag) { clauses.push('flags_json LIKE ?'); params.push(`%"${flag}"%`); }
  const where = clauses.join(' AND ');

  // codex F12 pattern (listMessages): clamp to a finite positive range, hard
  // cap 200 (INBOXQ_AGENT_DESIGN.md §E.6 batch bound — a search result is also
  // the raw material a propose call freezes into one approval).
  const nLimit = Math.floor(Number(limit));
  const safeLimit = (!Number.isFinite(nLimit) || nLimit <= 0) ? 50 : Math.min(nLimit, 200);

  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM inboxq_messages WHERE ${where}`).get(...params);
  const total = totalRow ? totalRow.n : 0;

  const rows = db.prepare(`
    SELECT id, org_id, account_id, folder, uid, message_id, from_addr, from_name, subject,
           date_ts, snippet, zone, flags_json, classified_by, classified_at, seen, created_at,
           body_captured_at, attachment_count, phishing_risk, classification_confidence
    FROM inboxq_messages
    WHERE ${where}
    ORDER BY date_ts DESC NULLS LAST, uid DESC
    LIMIT ?
  `).all(...params, safeLimit);

  return { total, messages: rows.map(hydrateMessage) };
}

function getMessage(orgId, id) {
  if (!orgId) throw new Error('getMessage requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_messages WHERE org_id = ? AND id = ?`).get(orgId, id);
  return row ? hydrateMessage(row) : null;
}

/** Update a stored message's zone (a user refile, or a reclassify pass). */
function updateMessageZone(orgId, id, toZone) {
  if (!orgId) throw new Error('updateMessageZone requires orgId');
  const db = getDb();
  const info = db.prepare(`UPDATE inboxq_messages SET zone = ? WHERE org_id = ? AND id = ?`).run(toZone, orgId, id);
  return info.changes > 0;
}

/**
 * P1: record where a message was filed after a real IMAP move. Distinct from
 * updateMessageZone (the triage overlay) — this is the durable folder layer.
 *
 * AQ-9E P1 (move-identity fix): a real IMAP move assigns the message a NEW
 * uid in the destination mailbox — the source uid is meaningless there.
 * folder, uid, and uidvalidity are therefore updated TOGETHER, never folder
 * alone (which used to leave the stale source uid addressing the WRONG
 * message in the destination namespace). When the caller could not resolve
 * the destination uid (no COPYUID mapping from the server — see
 * imap.js moveMessages), pass uid: null: an explicit "unresolved location"
 * marker, deliberately distinct from keeping a stale-but-present number that
 * would be silently (and wrongly) trusted later.
 *
 * @param {string} orgId
 * @param {string} id
 * @param {{folder:string, uid:?number, uidvalidity:?string}} loc
 */
function updateMessageFolder(orgId, id, { folder, uid = null, uidvalidity = null } = {}) {
  if (!orgId) throw new Error('updateMessageFolder requires orgId');
  if (!folder) throw new Error('updateMessageFolder requires folder');
  const db = getDb();
  const info = db.prepare(`
    UPDATE inboxq_messages SET folder = ?, uid = ?, uidvalidity = ? WHERE org_id = ? AND id = ?
  `).run(folder, uid == null ? null : Number(uid), uidvalidity == null ? null : String(uidvalidity), orgId, id);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// AQ-9E U2: reversible moves (undo-log)
// ---------------------------------------------------------------------------

function hydrateMove(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    messageId: row.message_id,
    messageRef: row.message_ref ?? null,
    fromFolder: row.from_folder,
    fromUid: row.from_uid ?? null,
    fromUidvalidity: row.from_uidvalidity ?? null,
    toFolder: row.to_folder,
    toUid: row.to_uid ?? null,
    toUidvalidity: row.to_uidvalidity ?? null,
    kind: row.kind,
    movedAt: row.moved_at,
    undone: row.undone,
    undoneAt: row.undone_at ?? null,
  };
}

/** Record one reversible move. Returns the new move id. The nullable uid/
 * uidvalidity fields mirror a message's own unresolved-location semantics
 * (see updateMessageFolder): a move whose destination UID the server never
 * confirmed stores to_uid null and is re-resolved by message_ref on undo. */
function recordMove(orgId, {
  accountId, messageId, messageRef = null,
  fromFolder, fromUid = null, fromUidvalidity = null,
  toFolder, toUid = null, toUidvalidity = null,
  kind = 'move', movedAt = Date.now(),
} = {}) {
  if (!orgId) throw new Error('recordMove requires orgId');
  if (!accountId) throw new Error('recordMove requires accountId');
  if (!messageId) throw new Error('recordMove requires messageId');
  if (!fromFolder) throw new Error('recordMove requires fromFolder');
  if (!toFolder) throw new Error('recordMove requires toFolder');
  const db = getDb();
  const id = generateId('inbmove');
  db.prepare(`
    INSERT INTO inboxq_moves
      (id, org_id, account_id, message_id, message_ref, from_folder, from_uid, from_uidvalidity, to_folder, to_uid, to_uidvalidity, kind, moved_at, undone)
    VALUES (@id, @org_id, @account_id, @message_id, @message_ref, @from_folder, @from_uid, @from_uidvalidity, @to_folder, @to_uid, @to_uidvalidity, @kind, @moved_at, 0)
  `).run({
    id, org_id: orgId, account_id: accountId, message_id: messageId, message_ref: messageRef,
    from_folder: fromFolder, from_uid: fromUid == null ? null : Number(fromUid), from_uidvalidity: fromUidvalidity == null ? null : String(fromUidvalidity),
    to_folder: toFolder, to_uid: toUid == null ? null : Number(toUid), to_uidvalidity: toUidvalidity == null ? null : String(toUidvalidity),
    kind, moved_at: Number(movedAt),
  });
  return id;
}

/** One move by id, org-scoped (null if not this org's). */
function getMove(orgId, moveId) {
  if (!orgId) throw new Error('getMove requires orgId');
  const db = getDb();
  return hydrateMove(db.prepare(`SELECT * FROM inboxq_moves WHERE org_id = ? AND id = ?`).get(orgId, moveId));
}

/** Recent undoable moves (undone = 0 by default), newest first, org+account scoped. */
function listRecentMoves(orgId, { accountId = null, limit = 20, includeUndone = false } = {}) {
  if (!orgId) throw new Error('listRecentMoves requires orgId');
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  if (!includeUndone) clauses.push('undone = 0');
  const n = Math.floor(Number(limit));
  const safeLimit = (!Number.isFinite(n) || n <= 0) ? 20 : Math.min(n, 200);
  params.push(safeLimit);
  const rows = db.prepare(`
    SELECT * FROM inboxq_moves WHERE ${clauses.join(' AND ')}
    ORDER BY moved_at DESC LIMIT ?
  `).all(...params);
  return rows.map(hydrateMove);
}

/** Flip a move to undone exactly once. Returns true only if it was not already
 * undone (so a double-undo is a safe no-op the caller can 409 on). */
function markMoveUndone(orgId, moveId, undoneAt = Date.now()) {
  if (!orgId) throw new Error('markMoveUndone requires orgId');
  const db = getDb();
  const info = db.prepare(`
    UPDATE inboxq_moves SET undone = 1, undone_at = ? WHERE org_id = ? AND id = ? AND undone = 0
  `).run(Number(undoneAt), orgId, moveId);
  return info.changes > 0;
}

/**
 * P1c: rows with no captured body yet (either never synced under P1b, or
 * synced before it shipped — the ~370 pre-existing rows). Org-scoped. Ordered
 * newest-first so a bounded on-demand backfill surfaces the mail a human is
 * most likely to be reading right now.
 */
function listMessagesMissingBody(orgId, accountId, { limit = 50 } = {}) {
  if (!orgId) throw new Error('listMessagesMissingBody requires orgId');
  if (!accountId) throw new Error('listMessagesMissingBody requires accountId');
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit)) || 50, 500));
  const rows = db.prepare(`
    SELECT id, folder, uid FROM inboxq_messages
    WHERE org_id = ? AND account_id = ? AND body_html IS NULL AND body_text IS NULL
    ORDER BY date_ts DESC
    LIMIT ?
  `).all(orgId, accountId, safeLimit);
  return rows;
}

/** Companion count to listMessagesMissingBody, for the "N remaining" UI. */
function countMessagesMissingBody(orgId, accountId) {
  if (!orgId) throw new Error('countMessagesMissingBody requires orgId');
  if (!accountId) throw new Error('countMessagesMissingBody requires accountId');
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM inboxq_messages
    WHERE org_id = ? AND account_id = ? AND body_html IS NULL AND body_text IS NULL
  `).get(orgId, accountId);
  return row ? row.n : 0;
}

/**
 * Backfill write path: sets body_html/body_text/body_captured_at (and, when
 * supplied, attachments_json/attachment_count) on an already-stored message.
 * Org-scoped (the WHERE clause, not just the lookup, so a cross-org id is a
 * no-op — same pattern as updateMessageZone). `attachments` is optional: when
 * omitted (undefined), the existing attachment metadata is left untouched
 * rather than being wiped to empty — a caller that only has a fresh body
 * (e.g. an older code path) must never silently erase attachments another
 * path already captured.
 */
/**
 * `security`/`phishingRisk` follow the SAME optional-omitted-means-untouched
 * contract as `attachments` above: a backfill call that only has a fresh
 * body (an older caller, or a re-fetch that only asked for the body) must
 * never silently wipe security signals another path already captured.
 */
function updateMessageBody(orgId, id, { bodyHtml = null, bodyText = null, attachments = undefined, security = undefined, phishingRisk = undefined } = {}) {
  if (!orgId) throw new Error('updateMessageBody requires orgId');
  const db = getDb();
  const setClauses = ['body_html = ?', 'body_text = ?', 'body_captured_at = ?'];
  const params = [bodyHtml || null, bodyText || null, new Date().toISOString()];
  if (attachments !== undefined) {
    const list = Array.isArray(attachments) ? attachments : [];
    setClauses.push('attachments_json = ?', 'attachment_count = ?');
    params.push(list.length ? JSON.stringify(list) : null, list.length);
  }
  if (security !== undefined) {
    setClauses.push('security_json = ?');
    params.push(security ? JSON.stringify(security) : null);
  }
  if (phishingRisk !== undefined) {
    setClauses.push('phishing_risk = ?');
    params.push(Number.isFinite(Number(phishingRisk)) ? Number(phishingRisk) : 0);
  }
  params.push(orgId, id);
  const info = db.prepare(`
    UPDATE inboxq_messages
    SET ${setClauses.join(', ')}
    WHERE org_id = ? AND id = ?
  `).run(...params);
  return info.changes;
}

function hydrateMessage(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    folder: row.folder,
    uid: row.uid,
    // AQ-9E P1: the destination mailbox's UIDVALIDITY at the time `uid` was
    // last set by a move (see updateMessageFolder); null on a row never
    // moved, or on the lean column sets that omit it.
    uidvalidity: row.uidvalidity ?? null,
    messageId: row.message_id,
    fromAddr: row.from_addr,
    fromName: row.from_name,
    subject: row.subject,
    dateTs: row.date_ts,
    snippet: row.snippet,
    zone: row.zone,
    flags: safeParse(row.flags_json, []),
    classifiedBy: row.classified_by,
    seen: Boolean(row.seen),
    createdAt: row.created_at,
    // Present on getMessage's full-row read; absent (undefined) on the lean
    // listMessages/listMessagesByFlag column set or an old pre-migration row —
    // either way this maps to null rather than throwing.
    bodyHtml: row.body_html ?? null,
    bodyText: row.body_text ?? null,
    bodyCapturedAt: row.body_captured_at ?? null,
    // attachments_json is only present on the full-row read (getMessage);
    // the lean listMessages/listMessagesByFlag column set omits it, so
    // row.attachments_json is undefined there and this maps to [] rather
    // than throwing. attachment_count IS present on both column sets.
    attachments: row.attachments_json !== undefined ? safeParse(row.attachments_json, []) : [],
    attachmentCount: row.attachment_count ?? 0,
    // Phishing-help signals (owner ask): security_json is only present on the
    // full-row read (getMessage) — the lean listMessages/listMessagesByFlag
    // column set omits it, so row.security_json is undefined there and this
    // maps to null rather than throwing. phishing_risk IS present on both
    // column sets (see listMessages/listMessagesByFlag), same pattern as
    // attachmentCount above.
    security: row.security_json !== undefined ? safeParse(row.security_json, null) : null,
    phishingRisk: row.phishing_risk ?? 0,
    // P3 physical filing: the classifier's confidence for `zone` above, when
    // known. Present on every lean column set (listMessages/
    // listMessagesByFlag/searchMessages) and the full getMessage row alike —
    // a cheap REAL, same treatment as phishingRisk. NULL/undefined (a
    // pre-migration row, or a message never classified with a confidence)
    // maps to null, which store.zoneToFolder treats as "not high-confidence".
    confidence: row.classification_confidence ?? null,
    // Gmail model (owner 2026-10-05): the message's Gmail labels + stable
    // X-GM-MSGID. Present on listMessages/getMessage; undefined on lean column
    // sets or a pre-migration/non-Gmail row -> [] / null rather than throwing.
    labels: row.labels_json !== undefined ? safeParse(row.labels_json, []) : [],
    gmailMsgid: row.gmail_msgid ?? null,
  };
}

// ---------------------------------------------------------------------------
// Folders (P1: durable custom filing destinations, mapped to a real IMAP path)
// ---------------------------------------------------------------------------

function createFolder({ orgId, accountId, name, imapPath, createdBy = null }) {
  if (!orgId) throw new Error('createFolder requires orgId');
  if (!accountId) throw new Error('createFolder requires accountId');
  if (!name) throw new Error('createFolder requires name');
  if (!imapPath) throw new Error('createFolder requires imapPath');
  const db = getDb();
  const id = generateId('inbfld');
  db.prepare(`
    INSERT INTO inboxq_folders (id, org_id, account_id, name, imap_path, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, orgId, accountId, name, imapPath, createdBy);
  return getFolder(orgId, id);
}

function getFolder(orgId, id) {
  if (!orgId) throw new Error('getFolder requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_folders WHERE org_id = ? AND id = ?`).get(orgId, id);
  return row ? hydrateFolder(row) : null;
}

function listFolders(orgId, accountId = null) {
  if (!orgId) throw new Error('listFolders requires orgId');
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  const rows = db.prepare(`SELECT * FROM inboxq_folders WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`).all(...params);
  return rows.map(hydrateFolder);
}

function renameFolder(orgId, id, { name = null, imapPath = null } = {}) {
  if (!orgId) throw new Error('renameFolder requires orgId');
  const existing = getFolder(orgId, id);
  if (!existing) return null;
  const db = getDb();
  const newName = name ?? existing.name;
  const newPath = imapPath ?? existing.imapPath;
  db.prepare(`UPDATE inboxq_folders SET name = ?, imap_path = ? WHERE org_id = ? AND id = ?`)
    .run(newName, newPath, orgId, id);
  return getFolder(orgId, id);
}

function deleteFolder(orgId, id) {
  if (!orgId) throw new Error('deleteFolder requires orgId');
  const db = getDb();
  const info = db.prepare(`DELETE FROM inboxq_folders WHERE org_id = ? AND id = ?`).run(orgId, id);
  return info.changes > 0;
}

function hydrateFolder(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    name: row.name,
    imapPath: row.imap_path,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Resolve a folder reference (an inboxq_folders id, name, or imap_path) to
 * the folder record for one account. Canonical implementation shared by
 * api.js's move-to-folder / proposal-execution routes (which delegate here)
 * and the rules engine (a 'move' rule's target_folder is stored as the same
 * kind of reference — see syncWorker.js / hApplyRules). Org+account scoped:
 * a folder belonging to a different account never resolves.
 */
function resolveFolderRef(orgId, accountId, folderRef) {
  if (!folderRef) return null;
  const byId = getFolder(orgId, folderRef);
  if (byId && byId.accountId === accountId) return byId;
  const ref = String(folderRef);
  const want = ref.toLowerCase();
  const candidates = listFolders(orgId, accountId);
  // Prefer an EXACT (case-sensitive) name/imapPath match first: some IMAP
  // servers (e.g. iCloud) are case-sensitive, so "github" and "GitHub" are two
  // different real mailboxes. Falling straight to case-insensitive here picked
  // the wrong one (first-created wins) whenever both existed — see
  // createFolderInternal in api.js for the create-time half of this fix.
  const exact = candidates.find((f) => f.name === ref || f.imapPath === ref);
  if (exact) return exact;
  const known = candidates.find((f) => f.name.toLowerCase() === want || f.imapPath.toLowerCase() === want);
  if (known) return known;
  // Fallback: the ref is a RAW synced IMAP path the user picked (an existing
  // server folder, never "created" via the app so it has no inboxq_folders row).
  // Validate it against the account's SYNCED folders before treating it as a move
  // target, so a real folder (e.g. "INBOX.Wordfence" — the owner's spamfilter case)
  // resolves and moves, while a typo/unknown folder still returns null (-> 404 /
  // skipped) instead of attempting a doomed IMAP move.
  const acct = getAccount(orgId, accountId);
  const synced = Array.isArray(acct?.folders) ? acct.folders : [];
  const matchPath = synced.find((p) => String(p).toLowerCase() === want);
  if (matchPath) return { imapPath: matchPath, name: matchPath, synthetic: true };
  return null;
}

// ---------------------------------------------------------------------------
// Rules (P3: user-defined auto-sort — the owner's "spamfilter-blocker"). See
// rules.js for match semantics (matchRule/findMatchingRule); this section is
// pure persistence + validation. Evaluated on every sync (syncWorker.js) and
// against a backlog of already-stored mail (api.js hApplyRules/hPreviewRule).
// ---------------------------------------------------------------------------

/** Rules for one account, highest priority first (ties broken oldest-first,
 * a stable and predictable first-match-wins order). Org+account scoped. */
function listRules(orgId, accountId) {
  if (!orgId) throw new Error('listRules requires orgId');
  if (!accountId) throw new Error('listRules requires accountId');
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM inboxq_rules WHERE org_id = ? AND account_id = ?
    ORDER BY priority DESC, created_at ASC
  `).all(orgId, accountId);
  return rows.map(hydrateRule);
}

function getRule(orgId, id) {
  if (!orgId) throw new Error('getRule requires orgId');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_rules WHERE org_id = ? AND id = ?`).get(orgId, id);
  return row ? hydrateRule(row) : null;
}

function validateRuleShape({ matchType, matchValue, action, targetFolder }) {
  if (!RULE_MATCH_TYPES.includes(matchType)) {
    throw new Error(`invalid matchType: must be one of ${RULE_MATCH_TYPES.join(', ')}`);
  }
  if (!matchValue || !matchValue.toString().trim()) {
    throw new Error('matchValue is required');
  }
  if (!RULE_ACTIONS.includes(action)) {
    throw new Error(`invalid action: must be one of ${RULE_ACTIONS.join(', ')}`);
  }
  if (action === 'move' && !targetFolder) {
    throw new Error('action "move" requires targetFolder');
  }
}

function createRule({ orgId, accountId, matchType, matchValue, action, targetFolder = null, enabled = true, priority = 0, createdBy = null }) {
  if (!orgId) throw new Error('createRule requires orgId');
  if (!accountId) throw new Error('createRule requires accountId');
  validateRuleShape({ matchType, matchValue, action, targetFolder });
  const db = getDb();
  const id = generateId('inbrule');
  const safePriority = Number.isFinite(Number(priority)) ? Math.floor(Number(priority)) : 0;
  db.prepare(`
    INSERT INTO inboxq_rules (id, org_id, account_id, match_type, match_value, action, target_folder, enabled, priority, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, accountId, matchType, matchValue.toString().trim(), action, targetFolder || null, enabled ? 1 : 0, safePriority, createdBy);
  return getRule(orgId, id);
}

/**
 * Patch an existing rule. Org-scoped (WHERE org_id = ? AND id = ?, not just
 * the lookup) so a cross-org id is a no-op (returns null), never mutating
 * another org's rule. Unset fields fall back to the existing row's value
 * before re-validating, so e.g. changing only `enabled` cannot accidentally
 * invalidate an already-valid rule.
 */
function updateRule(orgId, id, fields = {}) {
  if (!orgId) throw new Error('updateRule requires orgId');
  const existing = getRule(orgId, id);
  if (!existing) return null;
  const merged = {
    matchType: fields.matchType !== undefined ? fields.matchType : existing.matchType,
    matchValue: fields.matchValue !== undefined ? fields.matchValue : existing.matchValue,
    action: fields.action !== undefined ? fields.action : existing.action,
    targetFolder: fields.targetFolder !== undefined ? fields.targetFolder : existing.targetFolder,
    enabled: fields.enabled !== undefined ? Boolean(fields.enabled) : existing.enabled,
    priority: fields.priority !== undefined ? fields.priority : existing.priority,
  };
  validateRuleShape(merged);
  const safePriority = Number.isFinite(Number(merged.priority)) ? Math.floor(Number(merged.priority)) : 0;
  const db = getDb();
  db.prepare(`
    UPDATE inboxq_rules
    SET match_type = ?, match_value = ?, action = ?, target_folder = ?, enabled = ?, priority = ?
    WHERE org_id = ? AND id = ?
  `).run(merged.matchType, merged.matchValue.toString().trim(), merged.action, merged.targetFolder || null, merged.enabled ? 1 : 0, safePriority, orgId, id);
  return getRule(orgId, id);
}

/** Toggle a rule on/off without touching its match/action shape. Org-scoped;
 * returns false (no-op) for an unknown or cross-org id. */
function setRuleEnabled(orgId, id, enabled) {
  if (!orgId) throw new Error('setRuleEnabled requires orgId');
  const db = getDb();
  const info = db.prepare(`UPDATE inboxq_rules SET enabled = ? WHERE org_id = ? AND id = ?`)
    .run(enabled ? 1 : 0, orgId, id);
  return info.changes > 0;
}

function deleteRule(orgId, id) {
  if (!orgId) throw new Error('deleteRule requires orgId');
  const db = getDb();
  const info = db.prepare(`DELETE FROM inboxq_rules WHERE org_id = ? AND id = ?`).run(orgId, id);
  return info.changes > 0;
}

function hydrateRule(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    matchType: row.match_type,
    matchValue: row.match_value,
    action: row.action,
    targetFolder: row.target_folder,
    enabled: Boolean(row.enabled),
    priority: row.priority,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Watches (awaited mail)
// ---------------------------------------------------------------------------

function createWatch({ orgId, accountId = null, label, match, createdBy = null }) {
  if (!orgId) throw new Error('createWatch requires orgId');
  if (!label) throw new Error('createWatch requires label');
  if (!match || typeof match !== 'object') throw new Error('createWatch requires a match object');
  const db = getDb();
  const id = generateId('inbwatch');
  db.prepare(`
    INSERT INTO inboxq_watches (id, org_id, account_id, label, match_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, orgId, accountId, label, JSON.stringify(match), createdBy);
  return getWatch(orgId, id);
}

function getWatch(orgId, id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_watches WHERE org_id = ? AND id = ?`).get(orgId, id);
  return row ? hydrateWatch(row) : null;
}

function listWatches(orgId, { activeOnly = false } = {}) {
  const db = getDb();
  const rows = activeOnly
    ? db.prepare(`SELECT * FROM inboxq_watches WHERE org_id = ? AND active = 1 ORDER BY created_at DESC`).all(orgId)
    : db.prepare(`SELECT * FROM inboxq_watches WHERE org_id = ? ORDER BY created_at DESC`).all(orgId);
  return rows.map(hydrateWatch);
}

function recordWatchHit(orgId, id) {
  const db = getDb();
  db.prepare(`UPDATE inboxq_watches SET last_hit_at = ?, hit_count = hit_count + 1 WHERE org_id = ? AND id = ?`)
    .run(new Date().toISOString(), orgId, id);
}

function setWatchActive(orgId, id, active) {
  const db = getDb();
  const info = db.prepare(`UPDATE inboxq_watches SET active = ? WHERE org_id = ? AND id = ?`)
    .run(active ? 1 : 0, orgId, id);
  return info.changes > 0;
}

function hydrateWatch(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    label: row.label,
    match: safeParse(row.match_json, {}),
    active: Boolean(row.active),
    lastHitAt: row.last_hit_at,
    hitCount: row.hit_count,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function saveReport({ orgId, accountId, reportDate, bodyMd, counts = {}, structured = null }) {
  if (!orgId) throw new Error('saveReport requires orgId');
  const db = getDb();
  const id = generateId('inbrep');
  db.prepare(`
    INSERT INTO inboxq_reports (id, org_id, account_id, report_date, body_md, counts_json, structured_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, accountId, reportDate, bodyMd, JSON.stringify(counts), structured ? JSON.stringify(structured) : null);
  return getReport(orgId, id);
}

function getReport(orgId, id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_reports WHERE org_id = ? AND id = ?`).get(orgId, id);
  return row ? hydrateReport(row) : null;
}

function getLatestReport(orgId, accountId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM inboxq_reports WHERE org_id = ? AND account_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(orgId, accountId);
  return row ? hydrateReport(row) : null;
}

function hydrateReport(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    reportDate: row.report_date,
    bodyMd: row.body_md,
    counts: safeParse(row.counts_json, {}),
    // NULL on any pre-existing row saved before this column shipped; never
    // fabricate a structured payload for an old report.
    structured: row.structured_json ? safeParse(row.structured_json, null) : null,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Proposals (proposal-only in v1; approval lands in inbox_items)
// ---------------------------------------------------------------------------

// INBOXQ-AGENT (P2b): kinds grow from ['file','block','draft'] to add
// 'rezone' (Quox-side zone reassignment + reputation feedback, no IMAP),
// 'folder_create' (a proposal-gated version of the direct hCreateFolder
// route), and 'rule' (reserved for the P3 rules engine — a rule proposal can
// be RECORDED today but has no executor yet; see api.js hResolveProposal).
const PROPOSAL_KINDS = ['file', 'block', 'draft', 'rezone', 'folder_create', 'rule'];

function createProposal({ orgId, accountId, kind, payload, createdBy = null, createdVia = 'ui' }) {
  if (!orgId) throw new Error('createProposal requires orgId');
  if (!PROPOSAL_KINDS.includes(kind)) throw new Error(`createProposal invalid kind: ${kind}`);
  const db = getDb();
  const id = generateId('inbprop');
  db.prepare(`
    INSERT INTO inboxq_proposals (id, org_id, account_id, kind, payload_json, created_by, created_via)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, accountId, kind, JSON.stringify(payload || {}), createdBy, createdVia || 'ui');
  return getProposal(orgId, id);
}

function getProposal(orgId, id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inboxq_proposals WHERE org_id = ? AND id = ?`).get(orgId, id);
  return row ? hydrateProposal(row) : null;
}

function listProposals(orgId, { status = null, accountId = null } = {}) {
  const db = getDb();
  const clauses = ['org_id = ?'];
  const params = [orgId];
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (accountId) { clauses.push('account_id = ?'); params.push(accountId); }
  const rows = db.prepare(`
    SELECT * FROM inboxq_proposals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC
  `).all(...params);
  return rows.map(hydrateProposal);
}

function setProposalStatus(orgId, id, status, { approvalItemId = null, expectedStatus = null, resolvedBy = null } = {}) {
  if (!['proposed', 'approved', 'denied', 'applied', 'failed'].includes(status)) {
    throw new Error(`setProposalStatus invalid status: ${status}`);
  }
  const db = getDb();
  const resolvedAt = ['approved', 'denied', 'applied', 'failed'].includes(status) ? new Date().toISOString() : null;
  // codex F04: an optional expectedStatus makes the transition atomic — only a
  // proposal still in the expected state is moved, so a repeat approve/deny (or
  // a race) changes 0 rows and the caller returns 409 instead of silently
  // flipping a resolved decision.
  const extra = expectedStatus ? ' AND status = ?' : '';
  const params = [status, approvalItemId, resolvedAt, resolvedBy, orgId, id];
  if (expectedStatus) params.push(expectedStatus);
  const info = db.prepare(`
    UPDATE inboxq_proposals
    SET status = ?, approval_item_id = COALESCE(?, approval_item_id), resolved_at = COALESCE(?, resolved_at), resolved_by = COALESCE(?, resolved_by)
    WHERE org_id = ? AND id = ?${extra}
  `).run(...params);
  return info.changes > 0;
}

function hydrateProposal(row) {
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    kind: row.kind,
    payload: safeParse(row.payload_json, {}),
    status: row.status,
    approvalItemId: row.approval_item_id,
    createdBy: row.created_by,
    // created_via is only present once the P2b migration has run; an old row
    // read before that ALTER TABLE still reports the honest default 'ui'
    // rather than throwing on an undefined column.
    createdVia: row.created_via || 'ui',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

// ---------------------------------------------------------------------------
// Sender reputation — the deterministic learning layer.
//
// Keyed on (account_id, from_addr), org_id carried on every row for scoping.
// Two write paths feed it:
//   bumpReputation    — called from the sync worker on every ingested message
//                        (the junk-folder-as-ground-truth signal).
//   recordUserMove    — called from the API when a human refiles a message
//                        (the feedback-loop signal).
// One read path consults it:
//   getReputationVerdict — a fast-path override consulted BEFORE the content
//                        rules / LLM, per INBOXQ_CLASSIFIER_IMPROVEMENTS.md §3.1.
// ---------------------------------------------------------------------------

function normAddr(addr) {
  return (addr || '').toString().trim().toLowerCase();
}

function domainOf(addr) {
  const a = normAddr(addr);
  const at = a.indexOf('@');
  return at > 0 ? a.slice(at + 1) : '';
}

function getReputationRow(orgId, accountId, fromAddr) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM inboxq_sender_reputation WHERE org_id = ? AND account_id = ? AND from_addr = ?
  `).get(orgId, accountId, fromAddr) || null;
}

/** Cross-address rollup for a domain, scoped to one org+account. */
function getDomainRollup(orgId, accountId, domain) {
  if (!domain) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(SUM(total_seen), 0) AS total_seen, COALESCE(SUM(screened_count), 0) AS screened_count
    FROM inboxq_sender_reputation WHERE org_id = ? AND account_id = ? AND from_domain = ?
  `).get(orgId, accountId, domain);
  if (!row || !row.total_seen) return null;
  return { totalSeen: row.total_seen, screenedCount: row.screened_count };
}

/**
 * Upsert + increment counters for one ingested message. Called from the sync
 * worker AFTER a successful (non-duplicate) insertMessage. Never throws on a
 * missing fromAddr — there is nothing to key a reputation row on, so it is a
 * silent no-op (mirrors the store's other best-effort augmentation paths).
 */
function bumpReputation({ orgId, accountId, fromAddr, zone = null, folder = null, hasListUnsub = false }) {
  if (!orgId) throw new Error('bumpReputation requires orgId');
  if (!accountId) throw new Error('bumpReputation requires accountId');
  const addr = normAddr(fromAddr);
  if (!addr) return null;
  const domain = domainOf(addr);
  const db = getDb();
  const now = new Date().toISOString();
  const isScreenedFolder = /\b(spam|junk|bulk)\b/i.test(folder || '');
  const screenedInc = (zone === 'screened' || isScreenedFolder) ? 1 : 0;
  const focusInc = zone === 'focus' ? 1 : 0;
  const unsubInc = hasListUnsub ? 1 : 0;
  db.prepare(`
    INSERT INTO inboxq_sender_reputation
      (org_id, account_id, from_addr, from_domain, total_seen, screened_count, focus_count,
       human_marked_spam, human_marked_ok, has_list_unsub_count, first_seen, last_seen)
    VALUES (@org_id, @account_id, @from_addr, @from_domain, 1, @screened_inc, @focus_inc,
       0, 0, @unsub_inc, @now, @now)
    ON CONFLICT(account_id, from_addr) DO UPDATE SET
      total_seen = inboxq_sender_reputation.total_seen + 1,
      screened_count = inboxq_sender_reputation.screened_count + @screened_inc,
      focus_count = inboxq_sender_reputation.focus_count + @focus_inc,
      has_list_unsub_count = inboxq_sender_reputation.has_list_unsub_count + @unsub_inc,
      from_domain = @from_domain,
      last_seen = @now
    WHERE inboxq_sender_reputation.org_id = @org_id
  `).run({
    org_id: orgId, account_id: accountId, from_addr: addr, from_domain: domain,
    screened_inc: screenedInc, focus_inc: focusInc, unsub_inc: unsubInc, now,
  });
  // codex F05 pattern (upsertFolderState): the ON CONFLICT key is not
  // org-qualified, so the WHERE guard above makes a cross-org upsert a no-op
  // rather than letting a wrong-org caller silently mutate another org's row.
  return getReputationRow(orgId, accountId, addr);
}

/**
 * Record a human refile decision against the sender's reputation row: the
 * write side of the learning loop. toZone==='screened' bumps human_marked_spam;
 * toZone==='focus'|'fyi' bumps human_marked_ok (the implicit allowlist signal).
 * Any other toZone (e.g. 'auto') is not a spam/ok signal and is a no-op.
 */
function recordUserMove({ orgId, accountId, fromAddr, toZone, fromZone = null }) {
  if (!orgId) throw new Error('recordUserMove requires orgId');
  if (!accountId) throw new Error('recordUserMove requires accountId');
  const addr = normAddr(fromAddr);
  if (!addr) return null;
  const spamInc = toZone === 'screened' ? 1 : 0;
  const okInc = (toZone === 'focus' || toZone === 'fyi') ? 1 : 0;
  if (!spamInc && !okInc) return getReputationRow(orgId, accountId, addr);
  const domain = domainOf(addr);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO inboxq_sender_reputation
      (org_id, account_id, from_addr, from_domain, total_seen, screened_count, focus_count,
       human_marked_spam, human_marked_ok, has_list_unsub_count, first_seen, last_seen)
    VALUES (@org_id, @account_id, @from_addr, @from_domain, 0, 0, 0,
       @spam_inc, @ok_inc, 0, @now, @now)
    ON CONFLICT(account_id, from_addr) DO UPDATE SET
      human_marked_spam = inboxq_sender_reputation.human_marked_spam + @spam_inc,
      human_marked_ok = inboxq_sender_reputation.human_marked_ok + @ok_inc,
      from_domain = @from_domain,
      last_seen = @now
    WHERE inboxq_sender_reputation.org_id = @org_id
  `).run({
    org_id: orgId, account_id: accountId, from_addr: addr, from_domain: domain,
    spam_inc: spamInc, ok_inc: okInc, now,
  });
  return getReputationRow(orgId, accountId, addr);
}

/**
 * Human-authoritative, INSTANT block: sets a dedicated `blocked` flag on the
 * sender's reputation row, with no approval queue. This is the write side
 * consulted by getReputationVerdict's block rule below, so the very next
 * sync's fast-path (syncWorker.js, which calls getReputationVerdict BEFORE
 * classify() on every ingested message) screens future mail from this sender
 * immediately, independent of the total_seen/ratio thresholds.
 *
 * Deliberately a SEPARATE column from human_marked_spam, not a reuse of it:
 * human_marked_spam is recordUserMove's per-message refile signal, and a
 * single refile intentionally does NOT alone flip the fast-path to 'screened'
 * (see inboxqStore.test.js "recordUserMove bumps human_marked_spam..." —
 * asserts verdict stays null after one refile). Block-sender is a stronger,
 * explicit, one-shot human decision and must win immediately; overloading
 * human_marked_spam for it would silently change that existing contract.
 */
/**
 * Human-authoritative, INSTANT block — sender OR whole domain. Both scopes
 * write into the SAME inboxq_sender_reputation table, keyed on
 * (account_id, from_addr): a 'sender' block keys the row on the exact
 * address; a 'domain' block keys the row on the bare domain string (e.g.
 * "spamdomain.com", never containing '@') with block_type='domain'. A bare
 * domain string can never collide with a real from_addr key (every real
 * address contains '@'), so the two block kinds coexist safely in one table.
 * getReputationVerdict below checks BOTH forms.
 */
function markBlocked({ orgId, accountId, target, type = 'sender' }) {
  if (!orgId) throw new Error('markBlocked requires orgId');
  if (!accountId) throw new Error('markBlocked requires accountId');
  if (!['sender', 'domain'].includes(type)) throw new Error(`markBlocked invalid type: ${type}`);
  const key = type === 'domain' ? normAddr(target).replace(/^@/, '') : normAddr(target);
  if (!key) return null;
  const domain = type === 'domain' ? key : domainOf(key);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO inboxq_sender_reputation
      (org_id, account_id, from_addr, from_domain, total_seen, screened_count, focus_count,
       human_marked_spam, human_marked_ok, has_list_unsub_count, blocked, block_type, first_seen, last_seen)
    VALUES (@org_id, @account_id, @from_addr, @from_domain, 0, 0, 0,
       0, 0, 0, 1, @block_type, @now, @now)
    ON CONFLICT(account_id, from_addr) DO UPDATE SET
      blocked = 1,
      block_type = @block_type,
      from_domain = @from_domain,
      -- Clear a leftover trusted flag when EXPLICITLY blocking this exact
      -- sender: getReputationVerdict checks trusted before blocked, so a
      -- previously-trusted-then-blocked sender would otherwise keep landing in
      -- Focus despite the block reporting success. A DOMAIN block writes its own
      -- domain-keyed row and never clears an individual trusted sender here, so
      -- the deliberate "trusted sender survives a domain block" exception holds.
      trusted = CASE WHEN @block_type = 'sender' THEN 0 ELSE inboxq_sender_reputation.trusted END,
      last_seen = @now
    WHERE inboxq_sender_reputation.org_id = @org_id
  `).run({ org_id: orgId, account_id: accountId, from_addr: key, from_domain: domain, block_type: type, now });
  // codex F05 pattern (upsertFolderState/bumpReputation): the ON CONFLICT key is
  // not org-qualified, so the WHERE guard above makes a cross-org upsert a
  // no-op rather than letting a wrong-org caller mutate another org's row.
  return getReputationRow(orgId, accountId, key);
}

/** Back-compat thin wrapper — pre-existing callers/tests use this exact
 * name for a scope:'sender' block. New code should call markBlocked directly. */
function markSenderBlocked({ orgId, accountId, fromAddr }) {
  return markBlocked({ orgId, accountId, target: fromAddr, type: 'sender' });
}

/**
 * P1 manual sort: human-authoritative, INSTANT "Trust sender" — sets the
 * dedicated `trusted` flag on the sender's exact-address reputation row and
 * CLEARS any `blocked` flag in the same write, so a trust decision always
 * wins over a stale block on the very next getReputationVerdict read (rather
 * than depending on check ORDER alone). Sender-scope only (unlike
 * markBlocked, no domain form — trust is deliberately narrower than block).
 */
function markSenderTrusted({ orgId, accountId, fromAddr }) {
  if (!orgId) throw new Error('markSenderTrusted requires orgId');
  if (!accountId) throw new Error('markSenderTrusted requires accountId');
  const addr = normAddr(fromAddr);
  if (!addr) return null;
  const domain = domainOf(addr);
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO inboxq_sender_reputation
      (org_id, account_id, from_addr, from_domain, total_seen, screened_count, focus_count,
       human_marked_spam, human_marked_ok, has_list_unsub_count, blocked, trusted, first_seen, last_seen)
    VALUES (@org_id, @account_id, @from_addr, @from_domain, 0, 0, 0,
       0, 0, 0, 0, 1, @now, @now)
    ON CONFLICT(account_id, from_addr) DO UPDATE SET
      trusted = 1,
      blocked = 0,
      from_domain = @from_domain,
      last_seen = @now
    WHERE inboxq_sender_reputation.org_id = @org_id
  `).run({ org_id: orgId, account_id: accountId, from_addr: addr, from_domain: domain, now });
  // codex F05 pattern (upsertFolderState/bumpReputation/markBlocked): the ON
  // CONFLICT key is not org-qualified, so the WHERE guard above makes a
  // cross-org upsert a no-op rather than letting a wrong-org caller mutate
  // another org's row.
  return getReputationRow(orgId, accountId, addr);
}

/** List every currently-blocked sender/domain for an org+account, most
 * recently blocked first. Org+account scoped. */
function listBlocked(orgId, accountId) {
  if (!orgId) throw new Error('listBlocked requires orgId');
  if (!accountId) throw new Error('listBlocked requires accountId');
  const db = getDb();
  const rows = db.prepare(`
    SELECT from_addr, block_type, last_seen FROM inboxq_sender_reputation
    WHERE org_id = ? AND account_id = ? AND blocked = 1
    ORDER BY last_seen DESC
  `).all(orgId, accountId);
  return rows.map((r) => ({ target: r.from_addr, type: r.block_type || 'sender', blockedAt: r.last_seen }));
}

/** Clear a block (sender or domain). Org+account scoped; a no-op (false) if
 * the target was not blocked (or belongs to a different org/account). */
function unblock(orgId, accountId, target, type = 'sender') {
  if (!orgId) throw new Error('unblock requires orgId');
  if (!accountId) throw new Error('unblock requires accountId');
  const key = type === 'domain' ? normAddr(target).replace(/^@/, '') : normAddr(target);
  if (!key) return false;
  const db = getDb();
  const info = db.prepare(`
    UPDATE inboxq_sender_reputation SET blocked = 0
    WHERE org_id = ? AND account_id = ? AND from_addr = ? AND blocked = 1
  `).run(orgId, accountId, key);
  return info.changes > 0;
}

/**
 * Re-zone a sender's currently-stored messages to 'screened' — the immediate,
 * human-authoritative half of "Block sender": this is what makes the sender's
 * rows vanish from Focus/FYI right away, independent of (and before) any sync
 * pass ever re-consults reputation. Org+account scoped; a different org's
 * identical address is never touched. Returns the number of rows changed.
 */
function screenSenderMessages(orgId, accountId, fromAddr) {
  if (!orgId) throw new Error('screenSenderMessages requires orgId');
  if (!accountId) throw new Error('screenSenderMessages requires accountId');
  const addr = normAddr(fromAddr);
  if (!addr) return 0;
  const db = getDb();
  // NULL-safe: a not-yet-classified message has zone IS NULL, and SQL's
  // `zone != 'screened'` is NULL (not true) for a NULL zone, silently skipping
  // it. The explicit OR makes unclassified rows re-zone too.
  const info = db.prepare(`
    UPDATE inboxq_messages
    SET zone = 'screened'
    WHERE org_id = ? AND account_id = ? AND lower(from_addr) = ? AND (zone IS NULL OR zone != 'screened')
  `).run(orgId, accountId, addr);
  return info.changes;
}

/**
 * Domain counterpart of screenSenderMessages: re-zones EVERY stored message
 * whose from_addr is @domain to 'screened', org+account scoped. Same
 * NULL-safe zone guard as the sender version above. Returns the changed count.
 */
function screenDomainMessages(orgId, accountId, domain) {
  if (!orgId) throw new Error('screenDomainMessages requires orgId');
  if (!accountId) throw new Error('screenDomainMessages requires accountId');
  const d = normAddr(domain).replace(/^@/, '');
  if (!d) return 0;
  const db = getDb();
  const info = db.prepare(`
    UPDATE inboxq_messages
    SET zone = 'screened'
    WHERE org_id = ? AND account_id = ? AND lower(from_addr) LIKE ('%@' || ?) AND (zone IS NULL OR zone != 'screened')
  `).run(orgId, accountId, d);
  return info.changes;
}

/**
 * P1 manual sort: counterpart of screenSenderMessages for "Trust sender" —
 * re-zones a sender's currently-stored Screened/FYI/Auto mail back to
 * 'focus' right away (the immediate, human-authoritative half of trust,
 * independent of any future sync/reclassify pass). Deliberately scoped to
 * screened/fyi/auto only: an already-focus message is left alone (not a
 * change), and an unclassified (NULL zone) message is not touched either —
 * trust restores mail the classifier mis-filed, it does not invent a zone
 * for mail nothing has classified yet. Org+account scoped; returns the
 * number of rows changed ("restored").
 */
function restoreSenderMessages(orgId, accountId, fromAddr) {
  if (!orgId) throw new Error('restoreSenderMessages requires orgId');
  if (!accountId) throw new Error('restoreSenderMessages requires accountId');
  const addr = normAddr(fromAddr);
  if (!addr) return 0;
  const db = getDb();
  const info = db.prepare(`
    UPDATE inboxq_messages
    SET zone = 'focus'
    WHERE org_id = ? AND account_id = ? AND lower(from_addr) = ? AND zone IN ('screened', 'fyi', 'auto')
  `).run(orgId, accountId, addr);
  return info.changes;
}

/**
 * Fast-path reputation verdict, consulted BEFORE the content rules / LLM.
 * Rules (§3.1, + markSenderBlocked, + P1 markSenderTrusted):
 *   -1. trusted===1 on the EXACT address => 'focus' at confidence 0.95 —
 *       the instant, human-authoritative "Trust sender" signal
 *       (markSenderTrusted below), checked FIRST of all so an explicit trust
 *       decision WINS over a stale blocked/human_marked_spam signal rather
 *       than depending on those never having been set. Future mail from a
 *       trusted sender is therefore never auto-screened.
 *   0. blocked===1 on the EXACT address => 'screened' at confidence 0.95 — the
 *      instant, human-authoritative "Block sender" signal (markSenderBlocked
 *      below), checked FIRST and independent of total_seen/ratio, so a block
 *      screens future mail from the very next message, not after 3+ seen.
 *      Deliberately its own column, not human_marked_spam: a single
 *      recordUserMove refile must NOT alone flip this fast path (see rule 1b
 *      note on recordUserMove below) — only the explicit block action does.
 *   1. human_marked_ok>0 && human_marked_spam===0 on the EXACT address =>
 *      'ok' — an implicit allowlist; this sender is never auto-screened by
 *      reputation regardless of its screened-folder ratio.
 *   2. total_seen>=3 (exact address) && screened_count/total_seen>0.8 =>
 *      'screened' at confidence 0.9.
 *   3. Same ratio rolled up across the sender's domain (>=3 seen, >0.8
 *      screened) => 'screened' at confidence 0.9.
 *   4. Otherwise no verdict (null) — fall through to the content rules.
 * Returns { verdict: 'screened'|'ok'|null, confidence, by:'reputation' }.
 */
function getReputationVerdict(orgId, { accountId, fromAddr } = {}) {
  const none = { verdict: null, confidence: 0, by: 'reputation' };
  if (!orgId || !accountId || !fromAddr) return none;
  const addr = normAddr(fromAddr);
  if (!addr) return none;
  const domain = domainOf(addr);
  const row = getReputationRow(orgId, accountId, addr);

  // P1 markSenderTrusted: checked before EVERYTHING else, including the block
  // check immediately below, so trust always wins over a stale/leftover
  // blocked flag or spam signal on the same row.
  if (row && row.trusted) {
    return { verdict: 'focus', confidence: 0.95, by: 'reputation' };
  }

  if (row && row.blocked) {
    return { verdict: 'screened', confidence: 0.95, by: 'reputation' };
  }

  // Domain-level block: a separate row keyed on the bare domain (block_type
  // 'domain'; see markBlocked). Checked whether or not an exact-address row
  // exists, so a domain block screens every sender at that domain, including
  // ones never individually blocked.
  if (domain) {
    const domainRow = getReputationRow(orgId, accountId, domain);
    if (domainRow && domainRow.blocked && domainRow.block_type === 'domain') {
      return { verdict: 'screened', confidence: 0.95, by: 'reputation' };
    }
  }

  if (row && row.human_marked_ok > 0 && row.human_marked_spam === 0) {
    return { verdict: 'ok', confidence: 0.9, by: 'reputation' };
  }

  if (row && row.total_seen >= 3 && (row.screened_count / row.total_seen) > 0.8) {
    return { verdict: 'screened', confidence: 0.9, by: 'reputation' };
  }

  const roll = getDomainRollup(orgId, accountId, domain);
  if (roll && roll.totalSeen >= 3 && (roll.screenedCount / roll.totalSeen) > 0.8) {
    return { verdict: 'screened', confidence: 0.9, by: 'reputation' };
  }

  return none;
}

// ---------------------------------------------------------------------------

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

module.exports = {
  initInboxqStore,
  getDb,
  _useTestDb,
  _reset,
  generateId,
  // accounts
  createAccount,
  getAccount,
  getAccountByAddress,
  listAccounts,
  listAllPollableAccounts,
  setAccountPoll,
  updateAccountFolders,
  deleteAccount,
  // folder state
  getFolderState,
  upsertFolderState,
  lowestIndexedUid,
  setBackfillFloor,
  setBackfillDone,
  clearRetirement,
  deleteFolderMessages,
  getFolderUidState,
  deleteMessagesByUids,
  setSeenByUids,
  markReconciled,
  // messages
  insertMessage,
  listMessages,
  searchMessages,
  getMessage,
  updateMessageZone,
  updateMessageFolder,
  recordMove,
  getMove,
  listRecentMoves,
  markMoveUndone,
  countByFolder,
  listLabels,
  listFolderStates,
  listMessagesMissingBody,
  countMessagesMissingBody,
  updateMessageBody,
  countByZone,
  countMessages,
  listMessagesByFlag,
  // folders (P1: custom filing destinations)
  createFolder,
  getFolder,
  listFolders,
  renameFolder,
  deleteFolder,
  resolveFolderRef,
  // rules (P3: user-defined auto-sort)
  listRules,
  getRule,
  createRule,
  updateRule,
  setRuleEnabled,
  deleteRule,
  // watches
  createWatch,
  getWatch,
  listWatches,
  recordWatchHit,
  setWatchActive,
  // reports
  saveReport,
  getReport,
  getLatestReport,
  // proposals
  createProposal,
  getProposal,
  listProposals,
  setProposalStatus,
  // settings
  getSettings,
  setSettings,
  listSyncEnabledOrgs,
  listSyncOffOrgsWithMailboxes,
  AVAILABLE_CLASSIFIER_MODELS,
  // sender reputation (the learning layer)
  bumpReputation,
  recordUserMove,
  getReputationVerdict,
  markSenderBlocked,
  markBlocked,
  screenSenderMessages,
  screenDomainMessages,
  listBlocked,
  unblock,
  // P1 manual sort: trust sender (the ALLOW mirror of block)
  markSenderTrusted,
  restoreSenderMessages,
  // P3 physical filing engine
  zoneToFolder,
  FILING_FOLDERS,
  FILING_FOLDER_LIST,
  HIGH_CONFIDENCE_FILING_THRESHOLD,
};

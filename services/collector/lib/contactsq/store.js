'use strict';

/**
 * ContactsQ store: the collector-owned, org-scoped source of truth for the
 * governed contacts layer. Idiom mirrors lib/calendarq/store.js: a lazily
 * opened better-sqlite3 db at CONTACTSQ_DB_PATH (default
 * /var/lib/quox/contactsq.db), ':memory:' in tests, org_id NOT NULL on every
 * table and EVERY read filters on org.
 *
 * PII discipline (contract invariants 1-2): identifier values, notes,
 * preferred_name and pronunciation exist ONLY as AES-256-GCM ciphertext under
 * the contact's DEK (itself wrapped by the KEK). Lookup is by org-keyed blind
 * index. display_name is a plain (searchable) column by design (plan 4.3).
 */

const Database = require('better-sqlite3');
const nodeCrypto = require('node:crypto');
const cx = require('./crypto.js');
const { phoneticKey, words: nameWords } = require('./phonetic.js');
const strictNames = require('./strictNames.js');
const names = require('./names.js');
const biState = require('./biState.js');
const { initP6 } = require('./schemaP6.js');

let _db = null;

class ContactsqError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function gid(prefix) { return `${prefix}_${Date.now().toString(36)}_${nodeCrypto.randomBytes(6).toString('hex')}`; }

function initStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contactsq_settings (
      org_id                  TEXT PRIMARY KEY,
      default_region          TEXT NOT NULL DEFAULT 'GB',
      candidate_retention_days INTEGER NOT NULL DEFAULT 30,
      strict_names            INTEGER NOT NULL DEFAULT 0,
      updated_at              TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id                      TEXT PRIMARY KEY,
      org_id                  TEXT NOT NULL,
      kind                    TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person','organisation')),
      display_name            TEXT NOT NULL,
      sort_name               TEXT NOT NULL,
      preferred_name_ct       TEXT,
      pronunciation_ct        TEXT,
      status                  TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('candidate','active','archived','erased','merged')),
      primary_org_contact_id  TEXT,
      relationship_primary    TEXT,
      flags_json              TEXT NOT NULL DEFAULT '[]',
      language                TEXT,
      tz                      TEXT,
      retain_until            TEXT,
      dek_wrapped             TEXT,
      body_ciphertext         TEXT,
      created_by              TEXT,
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL,
      last_touchpoint_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(org_id, status);

    CREATE TABLE IF NOT EXISTS contact_provenance (
      id           TEXT PRIMARY KEY,
      org_id       TEXT NOT NULL,
      contact_id   TEXT NOT NULL,
      source_type  TEXT NOT NULL,
      source_ref   TEXT,
      captured_by  TEXT,
      captured_at  TEXT NOT NULL,
      trust        TEXT NOT NULL DEFAULT 'observed'
    );
    CREATE INDEX IF NOT EXISTS idx_contact_prov_contact ON contact_provenance(org_id, contact_id);

    CREATE TABLE IF NOT EXISTS contact_identifiers (
      id                     TEXT PRIMARY KEY,
      org_id                 TEXT NOT NULL,
      contact_id             TEXT NOT NULL,
      channel                TEXT NOT NULL,
      label                  TEXT,
      network                TEXT,
      is_primary             INTEGER NOT NULL DEFAULT 0,
      blind_index            TEXT NOT NULL,
      blind_index_canonical  TEXT NOT NULL,
      bi_version             INTEGER NOT NULL DEFAULT 1,
      country                TEXT,
      ciphertext             TEXT NOT NULL,
      verification           TEXT NOT NULL DEFAULT 'unverified',
      provenance_id          TEXT,
      created_at             TEXT NOT NULL,
      retired_at             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_ident_contact ON contact_identifiers(org_id, contact_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_ident_bi
      ON contact_identifiers(org_id, channel, blind_index) WHERE retired_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_contact_ident_canon ON contact_identifiers(org_id, channel, blind_index_canonical);

    CREATE TABLE IF NOT EXISTS contact_suppressions (
      id                     TEXT PRIMARY KEY,
      org_id                 TEXT NOT NULL,
      channel                TEXT NOT NULL,
      blind_index            TEXT NOT NULL,
      blind_index_canonical  TEXT NOT NULL,
      bi_version             INTEGER NOT NULL DEFAULT 1,
      reason                 TEXT NOT NULL CHECK (reason IN ('dnc','do_not_market','bounced','erasure_tombstone')),
      source                 TEXT,
      created_at             TEXT NOT NULL,
      expires_at             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_supp ON contact_suppressions(org_id, channel, blind_index);
    CREATE INDEX IF NOT EXISTS idx_contact_supp_canon ON contact_suppressions(org_id, channel, blind_index_canonical);

    -- P1: leases (short-lived, single-use right to ONE identifier), their use
    -- ledger, standing grants, and name tokens for search. Lease rows never hold
    -- a value; reason_ciphertext is the agent's free text under the contact DEK.
    CREATE TABLE IF NOT EXISTS contact_leases (
      id                TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      subject_type      TEXT NOT NULL,
      subject_id        TEXT NOT NULL,
      contact_id        TEXT NOT NULL,
      projection        TEXT NOT NULL CHECK (projection IN ('dial','send')),
      channel           TEXT NOT NULL CHECK (channel IN ('voice','sms','email')),
      purpose           TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'inject',
      status            TEXT NOT NULL CHECK (status IN ('active','used','expired','revoked','denied')),
      decided_by        TEXT NOT NULL,
      identifier_id     TEXT,
      requested_at      TEXT NOT NULL,
      expires_at        TEXT NOT NULL,
      max_uses          INTEGER NOT NULL DEFAULT 1,
      use_count         INTEGER NOT NULL DEFAULT 0,
      revoked_at        TEXT,
      reason_text_hash  TEXT,
      reason_ciphertext TEXT,
      dial_state        TEXT CHECK (dial_state IS NULL OR dial_state IN ('queued','claimed')),
      claimed_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_leases_org ON contact_leases(org_id, contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_leases_dialq ON contact_leases(dial_state, status, expires_at);

    CREATE TABLE IF NOT EXISTS contact_lease_uses (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      lease_id   TEXT NOT NULL,
      used_at    TEXT NOT NULL,
      transport  TEXT,
      outcome    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_lease_uses ON contact_lease_uses(org_id, lease_id);

    CREATE TABLE IF NOT EXISTS contact_standing_grants (
      id                 TEXT PRIMARY KEY,
      org_id             TEXT NOT NULL,
      subject_id         TEXT NOT NULL,
      projection         TEXT NOT NULL CHECK (projection IN ('dial','send')),
      channels_json      TEXT NOT NULL,
      purposes_json      TEXT NOT NULL,
      max_uses_per_day   INTEGER NOT NULL,
      granted_by         TEXT,
      created_at         TEXT NOT NULL,
      revoked_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_grants ON contact_standing_grants(org_id, subject_id);

    CREATE TABLE IF NOT EXISTS contact_name_tokens (
      contact_id  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      token       TEXT NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('word','phonetic'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_tokens ON contact_name_tokens(org_id, token);
    CREATE INDEX IF NOT EXISTS idx_contact_tokens_c ON contact_name_tokens(org_id, contact_id);

    -- P2: consent ledger (APPEND-ONLY: current state = latest row per
    -- contact/purpose/channel; the triggers below make UPDATE/DELETE impossible)
    -- and the persisted policy decisions (codes only, never a value).
    CREATE TABLE IF NOT EXISTS contact_consents (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      contact_id    TEXT NOT NULL,
      purpose       TEXT NOT NULL CHECK (purpose IN ('service','transactional','marketing','research','ai_interaction')),
      channel       TEXT NOT NULL CHECK (channel IN ('voice','sms','email','post','social','messaging','any')),
      status        TEXT NOT NULL CHECK (status IN ('granted','withdrawn','objected','soft_opt_in','unknown')),
      lawful_basis  TEXT NOT NULL CHECK (lawful_basis IN ('consent','contract','legitimate_interest','legal_obligation','vital_interest','public_task')),
      evidence_ref  TEXT,
      captured_by   TEXT,
      captured_via  TEXT NOT NULL CHECK (captured_via IN ('dashboard','cli','voice','email','import','api')),
      captured_at   TEXT NOT NULL,
      expires_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contact_consents ON contact_consents(org_id, contact_id);
    CREATE TRIGGER IF NOT EXISTS trg_contact_consents_no_update BEFORE UPDATE ON contact_consents
      BEGIN SELECT RAISE(ABORT, 'contact_consents is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_contact_consents_no_delete BEFORE DELETE ON contact_consents
      BEGIN SELECT RAISE(ABORT, 'contact_consents is append-only'); END;

    CREATE TABLE IF NOT EXISTS contact_policy_decisions (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      contact_id    TEXT NOT NULL,
      subject_id    TEXT,
      purpose       TEXT NOT NULL,
      channel       TEXT,
      decision      TEXT NOT NULL CHECK (decision IN ('allow','deny','approval_required')),
      reasons_json  TEXT NOT NULL,
      pack          TEXT NOT NULL,
      decided_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_policy_dec ON contact_policy_decisions(org_id, contact_id, decided_at);
  `);
  migrate(db);
  initP3(db);
  initP6(db);
  require('./photos.js').initPhotos(db); // contact photos: encrypted per-contact table + contacts.photo_at
  require('./p5.js').initP5(db); // P5: facts, merges, imports (lazy require: p5 depends on this module)
  require('./schemaSync.js').initSync(db); // P7: CardDAV pull-sync sources + links
  backfillNameTokens(db);
  migrateNames(db);
}

/**
 * One-time (idempotent) split of existing persons' display_name into given/family. Organisations are never touched
 * (marked done only). Strict rows are split through their DEK into name_ct_json. A row whose key cannot be opened
 * stays at names_v = 0 and is retried on the next open. -> counts (logged once when anything happened).
 */
function migrateNames(db) {
  const counts = { split: 0, split_strict: 0, organisations_skipped: 0, shells_skipped: 0, failed: 0 };
  const rows = db.prepare('SELECT * FROM contacts WHERE names_v = 0').all();
  if (!rows.length) return counts;
  const mark = db.prepare('UPDATE contacts SET names_v = 1 WHERE id = ? AND org_id = ?');
  for (const c of rows) {
    if (c.kind === 'organisation') { mark.run(c.id, c.org_id); counts.organisations_skipped += 1; continue; }
    if (!c.dek_wrapped || c.status === 'erased') { mark.run(c.id, c.org_id); counts.shells_skipped += 1; continue; }
    try {
      db.transaction(() => {
        if (c.display_name_ct) {
          const dek = dekFor(c);
          if (!dek) throw new Error('dek_unavailable');
          const display = cx.decryptField(dek, c.display_name_ct, { orgId: c.org_id, contactId: c.id, field: strictNames.NAME_FIELD });
          const cols = strictNames.nameColumns(c.org_id, c.id, dek, true, { kind: 'person', parts: names.splitDisplay(display), override: null, display });
          strictNames.writeColumns(db, c.org_id, c.id, cols, c.updated_at);
          counts.split_strict += 1;
        } else {
          const parts = names.splitDisplay(c.display_name);
          const cols = strictNames.nameColumns(c.org_id, c.id, null, false, { kind: 'person', parts, override: null, display: c.display_name });
          strictNames.writeColumns(db, c.org_id, c.id, cols, c.updated_at);
          counts.split += 1;
        }
      })();
    } catch (e) { counts.failed += 1; }
  }
  if (counts.split || counts.split_strict || counts.failed) {
    console.log(`[contactsq] names migration: split=${counts.split} split_strict=${counts.split_strict} organisations_skipped=${counts.organisations_skipped} shells_skipped=${counts.shells_skipped} failed=${counts.failed}`);
  }
  return counts;
}

/**
 * P2 in-place migration: idempotent ALTERs so a live P0/P1 database (with rows)
 * gains the new columns without a rebuild. Safe to run on every open.
 */
function addColumnIfMissing(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function migrate(db) {
  addColumnIfMissing(db, 'contacts', 'relationships_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'contacts', 'lifecycle_stage', 'TEXT');
  addColumnIfMissing(db, 'contacts', 'tags_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'contacts', 'jurisdiction', 'TEXT');
  addColumnIfMissing(db, 'contacts', 'quiet_hours_json', 'TEXT');
  // Structured person names: parts live in plain columns (non-strict) or, for strict_names orgs, in name_ct_json (one v2
  // ciphertext per part). names_v marks rows already split by migrateNames (0 = not yet).
  for (const k of strictNames.NAME_COLS.filter((c) => c !== 'name_ct_json')) addColumnIfMissing(db, 'contacts', k, 'TEXT');
  addColumnIfMissing(db, 'contacts', 'name_ct_json', 'TEXT');
  addColumnIfMissing(db, 'contacts', 'names_v', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'contactsq_settings', 'default_jurisdiction', "TEXT NOT NULL DEFAULT 'uk'");
  addColumnIfMissing(db, 'contactsq_settings', 'default_quiet_hours_json', 'TEXT');
  // P4: GDPR operations (Article 14 clocks, retention reaper bookkeeping, erasure).
  addColumnIfMissing(db, 'contacts', 'notice_due_at', 'TEXT');
  addColumnIfMissing(db, 'contacts', 'notice_sent_at', 'TEXT');
  addColumnIfMissing(db, 'contacts', 'notice_evidence_ref', 'TEXT');
  addColumnIfMissing(db, 'contacts', 'retention_fail_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'contacts', 'erased_at', 'TEXT');
  addColumnIfMissing(db, 'contactsq_settings', 'backup_retention_days', 'INTEGER NOT NULL DEFAULT 30');
  addColumnIfMissing(db, 'contactsq_settings', 'retention_reaper_enabled', 'INTEGER NOT NULL DEFAULT 0'); // opt-in: erasure is irreversible; candidate retention is an open owner decision
  addColumnIfMissing(db, 'contactsq_settings', 'retention_run_time_utc', "TEXT NOT NULL DEFAULT '03:15'");
  // Recurring compliance report (opt-in): {enabled, cadence, day, time_utc} as JSON; NULL = defaults (disabled).
  addColumnIfMissing(db, 'contactsq_settings', 'compliance_report_json', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS contactsq_reports (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      period_key    TEXT NOT NULL,
      cadence       TEXT NOT NULL,
      generated_at  TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('delivered','failed')),
      delivery_ref  TEXT,
      error_code    TEXT,
      summary_json  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contactsq_reports_org ON contactsq_reports(org_id, generated_at DESC);
    CREATE TABLE IF NOT EXISTS contactsq_report_state (
      org_id               TEXT PRIMARY KEY,
      done_period_key      TEXT,
      attempt_period_key   TEXT,
      attempts             INTEGER NOT NULL DEFAULT 0,
      last_run_at          TEXT,
      last_status          TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      next_attempt_at      TEXT
    );
  `);
  allowTombstoneReason(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_erasures (
      id                  TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL,
      contact_id          TEXT NOT NULL,
      scope               TEXT NOT NULL CHECK (scope IN ('full','identifiers_only')),
      reason_code         TEXT NOT NULL,
      requested_by        TEXT,
      requested_at        TEXT NOT NULL,
      executed_at         TEXT NOT NULL,
      propagation_json    TEXT NOT NULL,
      counts_json         TEXT NOT NULL,
      certificate_json    TEXT NOT NULL,
      certificate_sha256  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_erasures ON contact_erasures(org_id, contact_id);

    -- Retention reaper bookkeeping: one durable row per org (failure accounting, backoff, last result).
    CREATE TABLE IF NOT EXISTS contactsq_retention_state (
      org_id               TEXT PRIMARY KEY,
      last_run_at          TEXT,
      last_run_day         TEXT,
      last_status          TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      next_attempt_at      TEXT,
      last_counts_json     TEXT
    );
  `);
  // Article 14 clocks for contacts created before P4: third-party / scraped / imported / enriched provenance.
  db.exec(`
    UPDATE contacts SET notice_due_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+30 days')
    WHERE notice_due_at IS NULL AND notice_sent_at IS NULL AND status IN ('candidate','active')
      AND EXISTS (SELECT 1 FROM contact_provenance p WHERE p.contact_id = contacts.id AND p.org_id = contacts.org_id
        AND (p.trust IN ('third_party','scraped') OR p.source_type LIKE 'import%' OR p.source_type LIKE 'enrich%'))
  `);
}

/** SQLite cannot ALTER a CHECK: rebuild contact_suppressions once so the erasure tombstone reason is allowed. */
function allowTombstoneReason(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contact_suppressions'").get();
  if (!row || String(row.sql).includes('erasure_tombstone')) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE contact_suppressions RENAME TO contact_suppressions_old;
      DROP INDEX IF EXISTS idx_contact_supp;
      DROP INDEX IF EXISTS idx_contact_supp_canon;
      CREATE TABLE contact_suppressions (
        id                     TEXT PRIMARY KEY,
        org_id                 TEXT NOT NULL,
        channel                TEXT NOT NULL,
        blind_index            TEXT NOT NULL,
        blind_index_canonical  TEXT NOT NULL,
        bi_version             INTEGER NOT NULL DEFAULT 1,
        reason                 TEXT NOT NULL CHECK (reason IN ('dnc','do_not_market','bounced','erasure_tombstone')),
        source                 TEXT,
        created_at             TEXT NOT NULL,
        expires_at             TEXT
      );
      INSERT INTO contact_suppressions SELECT id, org_id, channel, blind_index, blind_index_canonical, bi_version, reason, source, created_at, expires_at FROM contact_suppressions_old;
      DROP TABLE contact_suppressions_old;
      CREATE INDEX idx_contact_supp ON contact_suppressions(org_id, channel, blind_index);
      CREATE INDEX idx_contact_supp_canon ON contact_suppressions(org_id, channel, blind_index_canonical);
    `);
  })();
}

/** Idempotent: contacts with no token rows (pre-P1 data) get them. Cheap no-op once filled. */
function backfillNameTokens(db) {
  const rows = db.prepare(
    'SELECT c.id, c.org_id, c.display_name FROM contacts c WHERE c.display_name_ct IS NULL AND NOT EXISTS (SELECT 1 FROM contact_name_tokens t WHERE t.contact_id = c.id AND t.org_id = c.org_id)'
  ).all();
  for (const r of rows) writeNameTokens(db, r.org_id, r.id, r.display_name);
  return rows.length;
}

function nameTokenRows(displayName) {
  const out = [];
  const seen = new Set();
  for (const w of nameWords(displayName)) {
    if (!seen.has(`w:${w}`)) { seen.add(`w:${w}`); out.push({ token: w, kind: 'word' }); }
    const k = phoneticKey(w);
    if (k && !seen.has(`p:${k}`)) { seen.add(`p:${k}`); out.push({ token: k, kind: 'phonetic' }); }
  }
  return out;
}

/** Replace a contact's tokens (called on create/rename). */
function writeNameTokens(db, orgId, contactId, displayName) {
  db.prepare('DELETE FROM contact_name_tokens WHERE org_id = ? AND contact_id = ?').run(orgId, contactId);
  const ins = db.prepare('INSERT INTO contact_name_tokens (contact_id, org_id, token, kind) VALUES (?, ?, ?, ?)');
  for (const t of nameTokenRows(displayName)) ins.run(contactId, orgId, t.token, t.kind);
}

function getDb() {
  if (_db) return _db;
  _db = new Database(process.env.CONTACTSQ_DB_PATH || '/var/lib/quox/contactsq.db');
  _db.pragma('journal_mode = WAL');
  initStore(_db);
  return _db;
}

/** Test seam: ':memory:' (or explicit path) for all subsequent calls. */
function _useTestDb(path = ':memory:') {
  if (_db) { try { _db.close(); } catch { /* non-fatal */ } }
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  initStore(_db);
  return _db;
}

function _reset() {
  if (_db) { try { _db.close(); } catch { /* non-fatal */ } }
  _db = null;
}

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULT_QUIET_HOURS = { start: '21:00', end: '08:00', tz: 'Europe/London' };
const DEFAULT_SETTINGS = {
  default_region: 'GB', candidate_retention_days: 30, strict_names: false,
  default_jurisdiction: 'uk', default_quiet_hours: { ...DEFAULT_QUIET_HOURS },
  backup_retention_days: 30, retention_reaper_enabled: false, retention_run_time_utc: '03:15',
  compliance_report: { enabled: false, cadence: 'weekly', day: 1, time_utc: '08:00' },
};
const defaultSettings = () => ({ ...DEFAULT_SETTINGS, default_quiet_hours: { ...DEFAULT_QUIET_HOURS }, compliance_report: { ...DEFAULT_SETTINGS.compliance_report } });

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try { const v = JSON.parse(text); return v === undefined ? fallback : v; } catch { return fallback; }
}

function getSettings(orgId) {
  if (!orgId) throw new Error('getSettings requires orgId');
  const r = getDb().prepare('SELECT * FROM contactsq_settings WHERE org_id = ?').get(orgId);
  if (!r) return defaultSettings();
  return {
    default_region: r.default_region, candidate_retention_days: r.candidate_retention_days, strict_names: Boolean(r.strict_names),
    default_jurisdiction: r.default_jurisdiction || 'uk',
    default_quiet_hours: parseJson(r.default_quiet_hours_json, null) || { ...DEFAULT_QUIET_HOURS },
    backup_retention_days: r.backup_retention_days || 30,
    retention_reaper_enabled: r.retention_reaper_enabled === null || r.retention_reaper_enabled === undefined ? false : Boolean(r.retention_reaper_enabled),
    retention_run_time_utc: r.retention_run_time_utc || '03:15',
    compliance_report: { ...DEFAULT_SETTINGS.compliance_report, ...(parseJson(r.compliance_report_json, null) || {}) },
  };
}

function putSettings(orgId, s) {
  if (!orgId) throw new Error('putSettings requires orgId');
  getDb().prepare(`
    INSERT INTO contactsq_settings (org_id, default_region, candidate_retention_days, strict_names, default_jurisdiction, default_quiet_hours_json,
      backup_retention_days, retention_reaper_enabled, retention_run_time_utc, compliance_report_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET default_region = excluded.default_region,
      candidate_retention_days = excluded.candidate_retention_days,
      strict_names = excluded.strict_names, default_jurisdiction = excluded.default_jurisdiction,
      default_quiet_hours_json = excluded.default_quiet_hours_json,
      backup_retention_days = excluded.backup_retention_days, retention_reaper_enabled = excluded.retention_reaper_enabled,
      retention_run_time_utc = excluded.retention_run_time_utc, compliance_report_json = excluded.compliance_report_json, updated_at = excluded.updated_at
  `).run(orgId, s.default_region, s.candidate_retention_days, s.strict_names ? 1 : 0,
    s.default_jurisdiction || 'uk', JSON.stringify(s.default_quiet_hours || DEFAULT_QUIET_HOURS),
    s.backup_retention_days || 30, s.retention_reaper_enabled === false ? 0 : 1, s.retention_run_time_utc || '03:15',
    JSON.stringify({ ...DEFAULT_SETTINGS.compliance_report, ...(s.compliance_report || {}) }), nowIso());
  return getSettings(orgId);
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** Binding for cx.encryptField/decryptField (v2 AAD): ties a ciphertext to its row + field. */
const bindOf = (orgId, contactId, field) => ({ orgId, contactId, field });

/** Decrypt helper: DEK for a contact row, or null when shredded/unrecoverable. */
function dekFor(row) {
  try { return cx.unwrapDek(row.dek_wrapped, { orgId: row.org_id, contactId: row.id }); } catch { return null; }
}

function identRow(orgId, contactId, dek, norm, rawValue, { label = null, is_primary = false, provenanceId = null }) {
  const ciId = gid('ci');
  return {
    id: ciId,
    org_id: orgId,
    contact_id: contactId,
    channel: norm.channel,
    label: label || null,
    network: norm.network || null,
    is_primary: is_primary ? 1 : 0,
    blind_index: cx.blindIndex(orgId, norm.channel, norm.normalised),
    blind_index_canonical: cx.blindIndex(orgId, norm.channel, norm.canonical),
    bi_version: cx.BI_VERSION,
    country: norm.country || null,
    // Store the NORMALISED value (stable, what resolve matched on).
    ciphertext: cx.encryptField(dek, norm.normalised, bindOf(orgId, contactId, `identifier:${ciId}`)),
    provenance_id: provenanceId,
    created_at: nowIso(),
  };
}

function insertIdentifier(db, r) {
  db.prepare(`
    INSERT INTO contact_identifiers (id, org_id, contact_id, channel, label, network, is_primary, blind_index,
      blind_index_canonical, bi_version, country, ciphertext, provenance_id, created_at)
    VALUES (@id, @org_id, @contact_id, @channel, @label, @network, @is_primary, @blind_index,
      @blind_index_canonical, @bi_version, @country, @ciphertext, @provenance_id, @created_at)
  `).run(r);
}

/** Add one identifier to an existing contact (inside a caller's transaction or on its own). */
function addIdentifierTx(db, orgId, contactRow, dek, norm, opts) {
  const bis = cx.blindIndexes(orgId, norm.channel, norm.normalised);
  const bi = bis[0];
  // An erased identifier is never recreated (re-import, auto-candidate, manual add): the tombstone holds its hash.
  if (isTombstoned(db, orgId, norm.channel, bis, cx.blindIndexes(orgId, norm.channel, norm.canonical))) throw new ContactsqError(409, 'identifier_erased');
  const existing = db.prepare(
    `SELECT id, contact_id FROM contact_identifiers WHERE org_id = ? AND channel = ? AND blind_index IN (${bis.map(() => '?').join(',')}) AND retired_at IS NULL`
  ).get(orgId, norm.channel, ...bis);
  if (existing) {
    if (existing.contact_id !== contactRow.id) throw new ContactsqError(409, 'identifier_in_use');
    return { row: db.prepare('SELECT * FROM contact_identifiers WHERE id = ?').get(existing.id), bi, created: false };
  }
  const hasPrimary = db.prepare(
    'SELECT 1 FROM contact_identifiers WHERE org_id = ? AND contact_id = ? AND channel = ? AND is_primary = 1 AND retired_at IS NULL'
  ).get(orgId, contactRow.id, norm.channel);
  const primary = Boolean(opts.is_primary) || !hasPrimary;
  if (primary) {
    db.prepare('UPDATE contact_identifiers SET is_primary = 0 WHERE org_id = ? AND contact_id = ? AND channel = ?')
      .run(orgId, contactRow.id, norm.channel);
  }
  const r = identRow(orgId, contactRow.id, dek, norm, null, { ...opts, is_primary: primary });
  r.bi_version = biState.stampFor(db, orgId);
  insertIdentifier(db, r);
  return { row: r, bi, created: true };
}

/** bi / canon may each be one hash or an array (dual lookup during a master-key rotation window). */
function isTombstoned(db, orgId, channel, bi, canon) {
  const a = [].concat(bi);
  const c = [].concat(canon);
  const ph = (l) => l.map(() => '?').join(',');
  return Boolean(db.prepare(
    `SELECT 1 FROM contact_suppressions WHERE org_id = ? AND channel = ? AND reason = 'erasure_tombstone' AND (blind_index IN (${ph(a)}) OR blind_index_canonical IN (${ph(c)})) LIMIT 1`
  ).get(orgId, channel, ...a, ...c));
}

function insertProvenance(db, orgId, contactId, p) {
  const id = gid('cp');
  db.prepare(`
    INSERT INTO contact_provenance (id, org_id, contact_id, source_type, source_ref, captured_by, captured_at, trust)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, contactId, p.source_type, p.source_ref || null, p.captured_by || null, nowIso(), p.trust || 'observed');
  return id;
}

/** Article 14: data not collected from the subject starts a 30 day notice clock. */
function noticeDueFor(prov, createdIso) {
  if (!prov) return null;
  const src = String(prov.source_type || '');
  if (prov.trust === 'third_party' || prov.trust === 'scraped' || src.startsWith('import') || src.startsWith('enrich')) {
    return new Date(Date.parse(createdIso) + 30 * 86400000).toISOString();
  }
  return null;
}

/** Person name resolution for create: parts win; display_name alone is split (not for candidates); override beats derivation. */
function resolveCreateName(kind, status, input) {
  if (kind === 'organisation') return { parts: null, override: null, display: input.display_name };
  const override = input.display_name_override || null;
  let parts = names.hasAny(input.name) ? { ...names.emptyParts(), ...input.name } : null;
  let display;
  if (parts) display = override || names.deriveDisplay(parts);
  else {
    display = override || input.display_name;
    parts = input.display_name && status !== 'candidate' ? names.splitDisplay(input.display_name) : names.emptyParts();
  }
  if (!display || !String(display).trim()) throw new ContactsqError(400, 'invalid_display_name');
  return { parts, override, display };
}

/**
 * Create a contact. `identifiers` are already-normalised
 * ({ norm, label?, is_primary? }). Atomic: any identifier conflict rolls the
 * whole create back (409 identifier_in_use).
 */
function createContact(orgId, input) {
  if (!orgId) throw new Error('createContact requires orgId');
  const db = getDb();
  const dek = cx.newDek();
  const id = gid('ct');
  const ts = nowIso();
  const status = input.status || 'active';
  const flags = Array.isArray(input.flags) ? input.flags : [];
  const body = input.notes ? cx.encryptField(dek, JSON.stringify({ notes: input.notes }), bindOf(orgId, id, 'body')) : null;
  const strict = getSettings(orgId).strict_names;
  const kind = input.kind || 'person';
  const rn = resolveCreateName(kind, status, input);
  const nameCols = strictNames.nameColumns(orgId, id, dek, strict, { kind, parts: rn.parts, override: rn.override, display: rn.display });
  const searchText = names.searchText(rn.parts, rn.display, rn.override);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO contacts (id, org_id, kind, display_name, sort_name, preferred_name_ct, pronunciation_ct, status,
        relationship_primary, flags_json, language, tz, retain_until, dek_wrapped, body_ciphertext, created_by, created_at, updated_at, notice_due_at, display_name_ct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, kind, nameCols.display_name, nameCols.sort_name,
      input.preferred_name ? cx.encryptField(dek, input.preferred_name, bindOf(orgId, id, 'preferred_name')) : null,
      input.pronunciation ? cx.encryptField(dek, input.pronunciation, bindOf(orgId, id, 'pronunciation')) : null,
      status, input.relationship_primary || null, JSON.stringify(flags), input.language || null, input.tz || null,
      input.retain_until || null, cx.wrapDek(dek, { orgId, contactId: id }), body, input.created_by || null, ts, ts,
      noticeDueFor(input.provenance, ts), nameCols.display_name_ct,
    );
    strictNames.writeColumns(db, orgId, id, nameCols, ts);
    if (strict) strictNames.writeBlindTokens(db, orgId, id, searchText);
    else writeNameTokens(db, orgId, id, searchText);
    const provId = insertProvenance(db, orgId, id, input.provenance || { source_type: 'manual', trust: 'subject_supplied', captured_by: input.created_by });
    const row = db.prepare('SELECT * FROM contacts WHERE id = ? AND org_id = ?').get(id, orgId);
    const added = [];
    for (const it of input.identifiers || []) {
      added.push(addIdentifierTx(db, orgId, row, dek, it.norm, { label: it.label, is_primary: it.is_primary, provenanceId: provId }));
    }
    return added;
  });
  const added = tx();
  return { contact: getContactRow(orgId, id), added };
}

function getContactRow(orgId, id) {
  if (!orgId) throw new Error('getContactRow requires orgId');
  return getDb().prepare('SELECT * FROM contacts WHERE id = ? AND org_id = ?').get(String(id), orgId) || null;
}

function listContacts(orgId, { q, status, relationship, limit } = {}) {
  if (!orgId) throw new Error('listContacts requires orgId');
  const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const where = ['org_id = ?'];
  const args = [orgId];
  if (status) { where.push('status = ?'); args.push(status); } else { where.push("status NOT IN ('archived','erased','merged')"); }
  if (relationship) { where.push('relationship_primary = ?'); args.push(relationship); }
  if (q) {
    // case-insensitive substring match; escape LIKE wildcards in the term
    const esc = String(q).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push("(sort_name LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')");
    args.push(`%${esc}%`, `%${esc}%`);
  }
  return getDb().prepare(`SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY sort_name ASC, created_at ASC LIMIT ?`).all(...args, lim);
}

function identifiersFor(orgId, contactId) {
  return getDb().prepare(
    'SELECT * FROM contact_identifiers WHERE org_id = ? AND contact_id = ? AND retired_at IS NULL ORDER BY created_at ASC, rowid ASC'
  ).all(orgId, contactId);
}

function addIdentifier(orgId, contactId, norm, opts = {}) {
  const db = getDb();
  const row = getContactRow(orgId, contactId);
  if (!row) throw new ContactsqError(404, 'not_found');
  const dek = dekFor(row);
  if (!dek) throw new ContactsqError(409, 'contact_shredded');
  const out = db.transaction(() => addIdentifierTx(db, orgId, row, dek, norm, opts))();
  db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ? AND org_id = ?').run(nowIso(), contactId, orgId);
  return out;
}

function archiveContact(orgId, contactId) {
  const info = getDb().prepare("UPDATE contacts SET status = 'archived', updated_at = ? WHERE id = ? AND org_id = ?")
    .run(nowIso(), contactId, orgId);
  if (!info.changes) return null;
  return getContactRow(orgId, contactId);
}

/** Resolve by blind index. Email matches on the canonical twin. */
function findContactByIdentifier(orgId, norm) {
  const col = norm.channel === 'email' ? 'blind_index_canonical' : 'blind_index';
  const bis = cx.blindIndexes(orgId, norm.channel, norm.channel === 'email' ? norm.canonical : norm.normalised);
  const bi = bis[0];
  const hit = getDb().prepare(
    `SELECT i.contact_id FROM contact_identifiers i JOIN contacts c ON c.id = i.contact_id AND c.org_id = i.org_id
       WHERE i.org_id = ? AND i.channel = ? AND i.${col} IN (${bis.map(() => '?').join(',')}) AND i.retired_at IS NULL AND c.status != 'erased'
       ORDER BY i.is_primary DESC, i.created_at ASC LIMIT 1`
  ).get(orgId, norm.channel, ...bis);
  return { bi, contact: hit ? getContactRow(orgId, hit.contact_id) : null };
}

// ---------------------------------------------------------------------------
// Suppressions (blind index ONLY: no ciphertext, no plaintext)
// ---------------------------------------------------------------------------

function addSuppression(orgId, norm, reason, source = null) {
  const id = gid('cs');
  const db = getDb();
  const bi = cx.blindIndex(orgId, norm.channel, norm.normalised);
  const ins = db.prepare(`
    INSERT INTO contact_suppressions (id, org_id, channel, blind_index, blind_index_canonical, bi_version, reason, source, created_at, twin_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    ins.run(id, orgId, norm.channel, bi, cx.blindIndex(orgId, norm.channel, norm.canonical), biState.stampFor(db, orgId), reason, source, nowIso(), null);
    // Rotation window: identifiers not yet reindexed still carry previous-key hashes, and policy matches by those.
    // Write a previous-key twin (dropped by reindex) so the suppression bites either way.
    if (biState.isPending(db, orgId)) {
      const pb = cx.blindIndexPrevious(orgId, norm.channel, norm.normalised);
      const pc = cx.blindIndexPrevious(orgId, norm.channel, norm.canonical);
      if (pb && pb !== bi) ins.run(gid('cs'), orgId, norm.channel, pb, pc, biState.previousStamp(db, orgId), reason, source, nowIso(), id);
    }
  })();
  return { id, channel: norm.channel, reason, bi };
}

function checkSuppression(orgId, norm) {
  const bis = cx.blindIndexes(orgId, norm.channel, norm.normalised);
  const canons = cx.blindIndexes(orgId, norm.channel, norm.canonical);
  const bi = bis[0];
  const ph = (l) => l.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT DISTINCT reason FROM contact_suppressions WHERE org_id = ? AND channel = ?
       AND (blind_index IN (${ph(bis)}) OR blind_index_canonical IN (${ph(canons)})) AND (expires_at IS NULL OR expires_at > ?)`
  ).all(orgId, norm.channel, ...bis, ...canons, nowIso());
  return { suppressed: rows.length > 0, reasons: rows.map((r) => r.reason).sort(), bi };
}

// ---------------------------------------------------------------------------
// P2: contact updates, suppression-by-identifier, consents, decisions, stats
// ---------------------------------------------------------------------------

/**
 * Patch a contact. `patch` carries already-validated plain fields; preferred_name,
 * pronunciation and notes are encrypted here under the contact's DEK.
 */
function updateContact(orgId, id, patch) {
  const db = getDb();
  const row = getContactRow(orgId, id);
  if (!row) return null;
  const sets = [];
  const args = [];
  const set = (col, val) => { sets.push(`${col} = ?`); args.push(val); };
  const nameTouch = patch.display_name !== undefined || patch.name !== undefined || patch.display_name_override !== undefined;
  if (nameTouch && row.kind === 'organisation' && (patch.name !== undefined || patch.display_name_override !== undefined)) throw new ContactsqError(400, 'name_not_for_organisation');
  const strictOn = nameTouch && getSettings(orgId).strict_names;
  const needsDek = nameTouch || ['preferred_name', 'pronunciation', 'notes'].some((k) => patch[k] !== undefined && patch[k] !== null && patch[k] !== '');
  const dek = needsDek ? dekFor(row) : null;
  if (needsDek && !dek && (strictOn || row.display_name_ct || row.name_ct_json || ['preferred_name', 'pronunciation', 'notes'].some((k) => patch[k]))) throw new ContactsqError(409, 'contact_shredded');
  let nameText = null;
  if (nameTouch) {
    const cur = strictNames.readName(orgId, row, dek);
    const curDisplay = row.display_name_ct ? strictNames.revealName(orgId, row, dek) : row.display_name;
    let parts = patch.name !== undefined ? names.mergeParts(cur.parts, patch.name) : cur.parts;
    let override = patch.display_name_override !== undefined ? patch.display_name_override : cur.override;
    const legacy = patch.display_name !== undefined && row.kind !== 'organisation' ? patch.display_name : undefined;
    if (legacy !== undefined) {
      // An old-style rename (display_name only) replaces the whole name: stale parts would keep matching the old name in search.
      if (patch.name === undefined) parts = names.emptyParts();
      else if (patch.display_name_override === undefined) override = legacy === names.deriveDisplay(parts) ? null : legacy;
    }
    let display;
    if (row.kind === 'organisation') { display = patch.display_name !== undefined ? patch.display_name : curDisplay; parts = null; override = null; }
    else display = override || (names.hasAny(parts) ? names.deriveDisplay(parts) : (legacy !== undefined ? legacy : curDisplay));
    if (!display || !String(display).trim()) throw new ContactsqError(400, 'invalid_display_name');
    const cols = strictNames.nameColumns(orgId, id, dek, strictOn, { kind: row.kind, parts, override, display });
    for (const [k, v] of Object.entries(cols)) set(k, v);
    nameText = names.searchText(parts, display, override);
  }
  if (patch.relationship_primary !== undefined) set('relationship_primary', patch.relationship_primary);
  if (patch.relationships !== undefined) set('relationships_json', JSON.stringify(patch.relationships));
  if (patch.lifecycle_stage !== undefined) set('lifecycle_stage', patch.lifecycle_stage);
  if (patch.tags !== undefined) set('tags_json', JSON.stringify(patch.tags));
  if (patch.flags !== undefined) set('flags_json', JSON.stringify(patch.flags));
  if (patch.jurisdiction !== undefined) set('jurisdiction', patch.jurisdiction);
  if (patch.quiet_hours !== undefined) set('quiet_hours_json', patch.quiet_hours === null ? null : JSON.stringify(patch.quiet_hours));
  if (patch.language !== undefined) set('language', patch.language || null);
  if (patch.tz !== undefined) set('tz', patch.tz || null);
  if (patch.preferred_name !== undefined) set('preferred_name_ct', patch.preferred_name ? cx.encryptField(dek, patch.preferred_name, bindOf(orgId, id, 'preferred_name')) : null);
  if (patch.pronunciation !== undefined) set('pronunciation_ct', patch.pronunciation ? cx.encryptField(dek, patch.pronunciation, bindOf(orgId, id, 'pronunciation')) : null);
  if (patch.notes !== undefined) set('body_ciphertext', patch.notes ? cx.encryptField(dek, JSON.stringify({ notes: patch.notes }), bindOf(orgId, id, 'body')) : null);
  set('updated_at', nowIso());
  db.transaction(() => {
    db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ? AND org_id = ?`).run(...args, id, orgId);
    if (nameTouch) {
      if (strictOn) strictNames.writeBlindTokens(db, orgId, id, nameText);
      else { strictNames.clearBlindTokens(db, orgId, id); writeNameTokens(db, orgId, id, nameText); }
    }
  })();
  return getContactRow(orgId, id);
}

/** Suppression keyed by a stored identifier's blind indexes (no value needed). Idempotent per (identifier, reason). */
function addSuppressionForIdentifier(orgId, ident, reason, source = null) {
  const db = getDb();
  const dup = db.prepare(
    `SELECT id FROM contact_suppressions WHERE org_id = ? AND channel = ? AND blind_index = ? AND reason = ?
       AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`
  ).get(orgId, ident.channel, ident.blind_index, reason, nowIso());
  if (dup) return { id: dup.id, created: false };
  const id = gid('cs');
  db.prepare(`
    INSERT INTO contact_suppressions (id, org_id, channel, blind_index, blind_index_canonical, bi_version, reason, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, ident.channel, ident.blind_index, ident.blind_index_canonical, ident.bi_version, reason, source, nowIso());
  return { id, created: true };
}

/** Append one consent row (never updates or deletes). */
function appendConsent(orgId, contactId, c) {
  const id = gid('cc');
  const capturedAt = nowIso();
  getDb().prepare(`
    INSERT INTO contact_consents (id, org_id, contact_id, purpose, channel, status, lawful_basis, evidence_ref, captured_by, captured_via, captured_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, contactId, c.purpose, c.channel, c.status, c.lawful_basis || 'consent', c.evidence_ref || null,
    c.captured_by || null, c.captured_via, capturedAt, c.expires_at || null);
  return getDb().prepare('SELECT * FROM contact_consents WHERE id = ? AND org_id = ?').get(id, orgId);
}

/** All consent rows for a contact, oldest first (insertion order). */
function consentsFor(orgId, contactId) {
  // P5: the consent ledger is append-only, so a merge never copies rows. The survivor sees the union of its own rows and
  // those of contacts currently merged into it (an undo simply stops matching, no delete needed).
  return getDb().prepare(
    "SELECT * FROM contact_consents WHERE org_id = ? AND (contact_id = ? OR contact_id IN (SELECT id FROM contacts WHERE org_id = ? AND merged_into = ? AND status = 'merged')) ORDER BY rowid ASC"
  ).all(orgId, contactId, orgId, contactId);
}

function recordDecision(orgId, d) {
  const id = gid('pd');
  getDb().prepare(`
    INSERT INTO contact_policy_decisions (id, org_id, contact_id, subject_id, purpose, channel, decision, reasons_json, pack, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, orgId, d.contact_id, d.subject_id || null, d.purpose, d.channel || null, d.decision, JSON.stringify(d.reasons || []), d.pack, nowIso());
  return id;
}

function decisionsFor(orgId, contactId, limit = 200) {
  return getDb().prepare(
    'SELECT * FROM contact_policy_decisions WHERE org_id = ? AND contact_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT ?'
  ).all(orgId, contactId, Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500))
    .map((r) => ({ id: r.id, contact_id: r.contact_id, subject_id: r.subject_id, purpose: r.purpose, channel: r.channel,
      decision: r.decision, reasons: parseJson(r.reasons_json, []), pack: r.pack, decided_at: r.decided_at }));
}

/** Posture counts for the dashboard band. Counts only, org scoped. */
function stats(orgId) {
  const db = getDb();
  const live = "status NOT IN ('archived','erased','merged')";
  const count = (sql, ...a) => db.prepare(sql).get(orgId, ...a).n;
  const by_status = {};
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM contacts WHERE org_id = ? GROUP BY status').all(orgId)) by_status[r.status] = r.n;
  const by_relationship = {};
  for (const r of db.prepare(`SELECT COALESCE(relationship_primary, 'unknown') AS rel, COUNT(*) AS n FROM contacts WHERE org_id = ? AND ${live} GROUP BY rel`).all(orgId)) by_relationship[r.rel] = r.n;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  return {
    total: count(`SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND ${live}`),
    by_status,
    by_relationship,
    candidates: count("SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND status = 'candidate'"),
    suppressions: count('SELECT COUNT(*) AS n FROM contact_suppressions WHERE org_id = ? AND (expires_at IS NULL OR expires_at > ?)', nowIso()),
    active_grants: count('SELECT COUNT(*) AS n FROM contact_standing_grants WHERE org_id = ? AND revoked_at IS NULL'),
    leases_last_7d: count("SELECT COUNT(*) AS n FROM contact_leases WHERE org_id = ? AND status != 'denied' AND requested_at >= ?", since),
    denied_last_7d: count("SELECT COUNT(*) AS n FROM contact_leases WHERE org_id = ? AND status = 'denied' AND requested_at >= ?", since),
  };
}


// ---------------------------------------------------------------------------
// P3: touchpoints (the compounding ledger) and the contact graph (edges).
// Additive and idempotent: safe on a live P2 database.
// ---------------------------------------------------------------------------

const TOUCHPOINT_SURFACES = ['voice', 'inboxq', 'calendarq', 'notesq', 'actionq', 'corecomms', 'contactsq', 'manual', 'agent'];
const TOUCHPOINT_DIRECTIONS = ['inbound', 'outbound', 'internal'];
const EDGE_TYPES = ['works_at', 'reports_to', 'assistant_of', 'introduced_by', 'related_to', 'supplier_to', 'customer_of', 'is_subsidiary_of'];

function initP3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_touchpoints (
      id                  TEXT PRIMARY KEY,
      org_id              TEXT NOT NULL,
      contact_id          TEXT NOT NULL,
      surface             TEXT NOT NULL CHECK (surface IN ('voice','inboxq','calendarq','notesq','actionq','corecomms','contactsq','manual','agent')),
      direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound','internal')),
      occurred_at         TEXT NOT NULL,
      ref                 TEXT,
      agent_id            TEXT,
      user_id             TEXT,
      outcome             TEXT,
      summary_ciphertext  TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_touchpoints ON contact_touchpoints(org_id, contact_id, occurred_at);

    CREATE TABLE IF NOT EXISTS contact_edges (
      id               TEXT PRIMARY KEY,
      org_id           TEXT NOT NULL,
      from_id          TEXT NOT NULL,
      to_id            TEXT NOT NULL,
      type             TEXT NOT NULL CHECK (type IN ('works_at','reports_to','assistant_of','introduced_by','related_to','supplier_to','customer_of','is_subsidiary_of')),
      attrs_ciphertext TEXT,
      since            TEXT,
      until            TEXT,
      created_by       TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_edges_from ON contact_edges(org_id, from_id);
    CREATE INDEX IF NOT EXISTS idx_contact_edges_to ON contact_edges(org_id, to_id);
  `);
  allowAgentSurface(db);
}

/** P8a: SQLite cannot ALTER a CHECK, so a pre-P8a contact_touchpoints is rebuilt once to admit surface 'agent' (handoff notes). Idempotent. */
function allowAgentSurface(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contact_touchpoints'").get();
  if (!row || String(row.sql).includes("'agent'")) return;
  db.transaction(() => {
    db.exec(`
      ALTER TABLE contact_touchpoints RENAME TO contact_touchpoints_old;
      DROP INDEX IF EXISTS idx_contact_touchpoints;
      CREATE TABLE contact_touchpoints (
        id                  TEXT PRIMARY KEY,
        org_id              TEXT NOT NULL,
        contact_id          TEXT NOT NULL,
        surface             TEXT NOT NULL CHECK (surface IN ('voice','inboxq','calendarq','notesq','actionq','corecomms','contactsq','manual','agent')),
        direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound','internal')),
        occurred_at         TEXT NOT NULL,
        ref                 TEXT,
        agent_id            TEXT,
        user_id             TEXT,
        outcome             TEXT,
        summary_ciphertext  TEXT,
        created_at          TEXT NOT NULL
      );
      INSERT INTO contact_touchpoints SELECT id, org_id, contact_id, surface, direction, occurred_at, ref, agent_id, user_id, outcome, summary_ciphertext, created_at FROM contact_touchpoints_old ORDER BY rowid;
      DROP TABLE contact_touchpoints_old;
      CREATE INDEX idx_contact_touchpoints ON contact_touchpoints(org_id, contact_id, occurred_at);
    `);
  })();
}

/**
 * Append one touchpoint and advance contacts.last_touchpoint_at (never backwards).
 * `summary` is encrypted under the contact's DEK with the existing helper.
 */
function addTouchpoint(orgId, contactRow, t) {
  if (!orgId) throw new Error('addTouchpoint requires orgId');
  if (!contactRow || contactRow.org_id !== orgId) throw new ContactsqError(404, 'not_found');
  const db = getDb();
  const id = gid('tp');
  let ct = null;
  if (t.summary) {
    const dek = dekFor(contactRow);
    if (!dek) throw new ContactsqError(409, 'contact_shredded');
    ct = cx.encryptField(dek, String(t.summary), bindOf(orgId, contactRow.id, `touchpoint:${id}`));
  }
  const occurred = t.occurred_at || nowIso();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO contact_touchpoints (id, org_id, contact_id, surface, direction, occurred_at, ref, agent_id, user_id, outcome, summary_ciphertext, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, contactRow.id, t.surface, t.direction, occurred, t.ref || null, t.agent_id || null, t.user_id || null, t.outcome || null, ct, nowIso());
    db.prepare('UPDATE contacts SET last_touchpoint_at = ? WHERE id = ? AND org_id = ? AND (last_touchpoint_at IS NULL OR last_touchpoint_at < ?)')
      .run(occurred, contactRow.id, orgId, occurred);
  })();
  return db.prepare('SELECT * FROM contact_touchpoints WHERE id = ? AND org_id = ?').get(id, orgId);
}

/** Newest first. Rows carry summary_ciphertext; the caller decides whether to decrypt. */
function touchpointsFor(orgId, contactId, limit = 50) {
  return getDb().prepare(
    'SELECT * FROM contact_touchpoints WHERE org_id = ? AND contact_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ?'
  ).all(orgId, contactId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
}

/** P8a: newest handoff notes (surface agent, outcome handoff) for a contact. Rows carry summary_ciphertext. */
function handoffsFor(orgId, contactId, limit = 3) {
  return getDb().prepare(
    "SELECT * FROM contact_touchpoints WHERE org_id = ? AND contact_id = ? AND surface = 'agent' AND outcome = 'handoff' ORDER BY occurred_at DESC, rowid DESC LIMIT ?"
  ).all(orgId, contactId, Math.min(Math.max(parseInt(limit, 10) || 3, 1), 20));
}

/** Idempotency probe for automatic touchpoint writers (P3b): same contact+surface+ref+outcome. */
function findTouchpointByRef(orgId, contactId, surface, ref, outcome) {
  return getDb().prepare(
    'SELECT id FROM contact_touchpoints WHERE org_id = ? AND contact_id = ? AND surface = ? AND ref = ? AND outcome = ? LIMIT 1'
  ).get(orgId, contactId, surface, ref, outcome) || null;
}

function edgeById(orgId, id) {
  return getDb().prepare('SELECT * FROM contact_edges WHERE org_id = ? AND id = ?').get(orgId, String(id)) || null;
}

/** All edges touching a contact, either direction, oldest first. */
function edgesFor(orgId, contactId) {
  return getDb().prepare(
    'SELECT * FROM contact_edges WHERE org_id = ? AND (from_id = ? OR to_id = ?) ORDER BY created_at ASC, rowid ASC'
  ).all(orgId, contactId, contactId);
}

function findEdge(orgId, fromId, toId, type) {
  return getDb().prepare(
    'SELECT * FROM contact_edges WHERE org_id = ? AND from_id = ? AND to_id = ? AND type = ? AND (until IS NULL OR until > ?) LIMIT 1'
  ).get(orgId, fromId, toId, type, nowIso()) || null;
}

/**
 * Insert an edge. attrs (object) is encrypted under the FROM contact's DEK.
 * works_at also sets the person's primary_org_contact_id when none is set.
 */
function addEdge(orgId, fromRow, toRow, e) {
  const db = getDb();
  const id = gid('ce');
  let ct = null;
  if (e.attrs && Object.keys(e.attrs).length) {
    const dek = dekFor(fromRow);
    if (!dek) throw new ContactsqError(409, 'contact_shredded');
    ct = cx.encryptField(dek, JSON.stringify(e.attrs), bindOf(orgId, fromRow.id, `edge:${id}`));
  }
  db.transaction(() => {
    db.prepare(`
      INSERT INTO contact_edges (id, org_id, from_id, to_id, type, attrs_ciphertext, since, until, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, fromRow.id, toRow.id, e.type, ct, e.since || null, e.until || null, e.created_by || null, nowIso());
    if (e.type === 'works_at') {
      db.prepare('UPDATE contacts SET primary_org_contact_id = ?, updated_at = ? WHERE id = ? AND org_id = ? AND primary_org_contact_id IS NULL')
        .run(toRow.id, nowIso(), fromRow.id, orgId);
    }
  })();
  return edgeById(orgId, id);
}

function deleteEdge(orgId, id) {
  return getDb().prepare('DELETE FROM contact_edges WHERE org_id = ? AND id = ?').run(orgId, String(id)).changes > 0;
}

/** Decrypt an edge's attrs under the FROM contact's DEK; {} when absent or unrecoverable. */
function edgeAttrs(orgId, edge) {
  if (!edge.attrs_ciphertext) return {};
  const from = getContactRow(orgId, edge.from_id);
  const dek = from ? dekFor(from) : null;
  if (!dek) return {};
  try { return parseJson(cx.decryptField(dek, edge.attrs_ciphertext, bindOf(orgId, edge.from_id, `edge:${edge.id}`)), {}) || {}; } catch { return {}; }
}

/** Organisation contacts a person currently works at (works_at, not ended, org not erased). */
function worksAtOrgs(orgId, personId) {
  const now = nowIso();
  return getDb().prepare(`
    SELECT o.* FROM contact_edges e JOIN contacts o ON o.id = e.to_id AND o.org_id = e.org_id
    WHERE e.org_id = ? AND e.from_id = ? AND e.type = 'works_at' AND (e.until IS NULL OR e.until > ?)
      AND o.kind = 'organisation' AND o.status != 'erased'
    ORDER BY e.created_at ASC
  `).all(orgId, personId, now);
}

module.exports = {
  initStore, parseJson, DEFAULT_QUIET_HOURS,
  updateContact, addSuppressionForIdentifier, appendConsent, consentsFor, recordDecision, decisionsFor, stats,
  ContactsqError, DEFAULT_SETTINGS, getDb, _useTestDb, _reset,
  getSettings, putSettings,
  createContact, getContactRow, listContacts, identifiersFor, addIdentifier, archiveContact,
  findContactByIdentifier, addSuppression, checkSuppression, dekFor, bindOf, gid,
  backfillNameTokens, migrateNames, writeNameTokens, isTombstoned, nowIso,
  TOUCHPOINT_SURFACES, TOUCHPOINT_DIRECTIONS, EDGE_TYPES,
  addTouchpoint, touchpointsFor, handoffsFor, findTouchpointByRef, edgeById, edgesFor, findEdge, addEdge, deleteEdge, edgeAttrs, worksAtOrgs,
};

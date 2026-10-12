/**
 * WARD Store — SQLite storage for chains, entries, and tips.
 * Schema per CHAIN_STRUCTURE.md §2.1
 */

import Database from 'better-sqlite3';
import { genesisHash } from './crypto.js';

let db = null;

// Page cache / mmap sizing. ward.db is multi-GB with random-key unique
// indexes; the better-sqlite3 default 16 MB cache makes every append do
// several random reads. Negative cache_size = KiB.
export const WARD_CACHE_SIZE_KIB = -262144; // 256 MB
export const WARD_MMAP_SIZE = 1073741824; // 1 GB

// Prepared statements are compiled once per db handle (appendEntry used to
// re-prepare on every call, synchronously, on the collector main thread).
let _stmtDb = null;
const _stmts = new Map();
function prep(sql) {
  const d = getDb();
  if (_stmtDb !== d) {
    _stmts.clear();
    _stmtDb = d;
  }
  let st = _stmts.get(sql);
  if (!st) {
    st = d.prepare(sql);
    _stmts.set(sql, st);
  }
  return st;
}

/**
 * Initialise the WARD SQLite database.
 * @param {string} dbPath - Path to SQLite file
 * @returns {Database} The database instance
 */
export function initWardStore(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma(`cache_size = ${WARD_CACHE_SIZE_KIB}`);
  db.pragma(`mmap_size = ${WARD_MMAP_SIZE}`);
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ward_entries (
      ward_entry_id   TEXT PRIMARY KEY,
      chain_id        TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      witnessed_at    TEXT NOT NULL,
      source_kind     TEXT NOT NULL CHECK (source_kind IN ('AEE','AOCL','VOLT','WARD','EXTERNAL')),
      source_id       TEXT NOT NULL,
      payload_hash    TEXT NOT NULL,
      prev_chain_hash TEXT NOT NULL,
      chain_hash      TEXT NOT NULL,
      issuer_id       TEXT NOT NULL,
      ward_version    TEXT NOT NULL DEFAULT '0.1',
      source_ts       TEXT,
      tags            TEXT,
      sig             TEXT,
      org_id          TEXT,
      UNIQUE(chain_id, seq),
      UNIQUE(chain_id, source_kind, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ward_entries_chain ON ward_entries(chain_id, seq);
    CREATE INDEX IF NOT EXISTS idx_ward_entries_source ON ward_entries(source_kind, source_id);

    CREATE TABLE IF NOT EXISTS ward_chains (
      chain_id        TEXT PRIMARY KEY,
      genesis_hash    TEXT NOT NULL,
      scope           TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      entry_count     INTEGER NOT NULL DEFAULT 0,
      head_seq        INTEGER NOT NULL DEFAULT 0,
      head_chain_hash TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','sealed','archived'))
    );

    CREATE TABLE IF NOT EXISTS ward_tips (
      tip_id          TEXT PRIMARY KEY,
      chain_id        TEXT NOT NULL REFERENCES ward_chains(chain_id),
      tip_seq         INTEGER NOT NULL,
      tip_chain_hash  TEXT NOT NULL,
      entry_count     INTEGER NOT NULL,
      created_at      TEXT NOT NULL,
      sig             TEXT,
      key_id          TEXT,
      sink_ref        TEXT,
      notes           TEXT,
      tsr             TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ward_tips_chain ON ward_tips(chain_id, tip_seq);
  `);

  // AUDIT-REAL #3: `tsr` (base64 RFC 3161 timestamp receipt DER, from the
  // `tsa` sink) added post-launch. WARD has no file-based versioned
  // migration runner of its own (unlike services/collector/lib/
  // runMigrations.js) — the schema here is owned entirely by
  // `CREATE TABLE IF NOT EXISTS` above, so pre-existing on-disk databases
  // never see new columns added to that DDL. Apply the same idempotent,
  // tolerated-no-op pattern collector's runMigrations.js uses for exactly
  // this SQLite limitation (no `ADD COLUMN IF NOT EXISTS`): try the ALTER,
  // swallow only "duplicate column name" (already-migrated DB), and let any
  // other error propagate loudly.
  try {
    db.exec('ALTER TABLE ward_tips ADD COLUMN tsr TEXT');
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }

  // ORG-VIEW-SCOPE: `org_id` (nullable) added post-launch so a witnessed
  // count can be VIEW-scoped per org without partitioning the chain itself
  // (the chain/seq/hash linkage stays global — org_id is a row attribute
  // only). Same idempotent tolerated-no-op ALTER pattern as `tsr` above:
  // the column is already in the CREATE TABLE IF NOT EXISTS DDL for brand
  // new DBs, so this ALTER is a no-op there (swallowed as "duplicate column
  // name"); for pre-existing on-disk DBs it actually adds the column.
  try {
    db.exec('ALTER TABLE ward_entries ADD COLUMN org_id TEXT');
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
  // Safe to create unconditionally after the ALTER above — org_id exists
  // on every DB by this point (new or migrated), and IF NOT EXISTS makes
  // this idempotent across restarts.
  db.exec('CREATE INDEX IF NOT EXISTS idx_ward_entries_org ON ward_entries(org_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ward_chains_created ON ward_chains(created_at)');

  // INCIDENT quox#700: status-bar probes (/ward/stats) re-counted the whole
  // ward_entries / ward_tips tables per call (COUNT(*) is O(n) in SQLite, even
  // over an index). Counts are now maintained by triggers in a tiny counter
  // table, so reads are O(#orgs). Keys: 'entries:<org_id>' ('entries:' for
  // untagged legacy rows) and 'tips'. Backfilled once, when the table is first
  // created on an existing database.
  const hadCounts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ward_counts'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ward_counts (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS trg_ward_counts_entry_ins AFTER INSERT ON ward_entries BEGIN
      INSERT INTO ward_counts (k, n) VALUES ('entries:' || COALESCE(NEW.org_id, ''), 1)
      ON CONFLICT(k) DO UPDATE SET n = n + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_ward_counts_entry_del AFTER DELETE ON ward_entries BEGIN
      UPDATE ward_counts SET n = n - 1 WHERE k = 'entries:' || COALESCE(OLD.org_id, '');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_ward_counts_entry_org AFTER UPDATE OF org_id ON ward_entries
      WHEN COALESCE(OLD.org_id, '') <> COALESCE(NEW.org_id, '') BEGIN
      UPDATE ward_counts SET n = n - 1 WHERE k = 'entries:' || COALESCE(OLD.org_id, '');
      INSERT INTO ward_counts (k, n) VALUES ('entries:' || COALESCE(NEW.org_id, ''), 1)
      ON CONFLICT(k) DO UPDATE SET n = n + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_ward_counts_tip_ins AFTER INSERT ON ward_tips BEGIN
      INSERT INTO ward_counts (k, n) VALUES ('tips', 1) ON CONFLICT(k) DO UPDATE SET n = n + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_ward_counts_tip_del AFTER DELETE ON ward_tips BEGIN
      UPDATE ward_counts SET n = n - 1 WHERE k = 'tips';
    END;
  `);
  if (!hadCounts) {
    db.exec(`
      INSERT OR REPLACE INTO ward_counts (k, n)
        SELECT 'entries:' || COALESCE(org_id, ''), COUNT(*) FROM ward_entries GROUP BY org_id;
      INSERT OR REPLACE INTO ward_counts (k, n)
        SELECT 'tips', COUNT(*) FROM ward_tips HAVING COUNT(*) > 0;
    `);
  }

  return db;
}

/**
 * Get the database instance (must call initWardStore first).
 */
export function getDb() {
  if (!db) throw new Error('WARD store not initialised — call initWardStore() first');
  return db;
}

/**
 * Close the database.
 */
export function closeWardStore() {
  if (db) {
    db.close();
    db = null;
    _stmts.clear();
    _stmtDb = null;
  }
}

// --- Chain operations ---

const _createChain = () => prep(`
  INSERT INTO ward_chains (chain_id, genesis_hash, scope, created_at, entry_count, head_seq, head_chain_hash)
  VALUES (?, ?, ?, ?, 0, 0, ?)
`);

const _getChain = () => prep('SELECT * FROM ward_chains WHERE chain_id = ?');

const _updateChainHead = () => prep(`
  UPDATE ward_chains SET entry_count = ?, head_seq = ?, head_chain_hash = ? WHERE chain_id = ?
`);

/**
 * Create a new chain. CHAIN_STRUCTURE §3.2
 */
export function createChain(chainId, scope) {
  const genesis = genesisHash(chainId);
  const now = new Date().toISOString();
  _createChain().run(chainId, genesis, scope, now, genesis);
  return { chain_id: chainId, genesis_hash: genesis, scope, created_at: now, entry_count: 0, head_seq: 0, head_chain_hash: genesis, status: 'active' };
}

/**
 * Get a chain descriptor, optionally auto-creating it.
 */
export function getChain(chainId, { autoCreate = false, scope = '' } = {}) {
  let chain = _getChain().get(chainId);
  if (!chain && autoCreate) {
    chain = createChain(chainId, scope);
  }
  return chain || null;
}

// --- Entry operations ---

const _insertEntry = () => prep(`
  INSERT INTO ward_entries (ward_entry_id, chain_id, seq, witnessed_at, source_kind, source_id, payload_hash, prev_chain_hash, chain_hash, issuer_id, ward_version, source_ts, tags, sig, org_id)
  VALUES (@ward_entry_id, @chain_id, @seq, @witnessed_at, @source_kind, @source_id, @payload_hash, @prev_chain_hash, @chain_hash, @issuer_id, @ward_version, @source_ts, @tags, @sig, @org_id)
`);

const _getEntry = () => prep('SELECT * FROM ward_entries WHERE ward_entry_id = ?');

const _getEntryBySeq = () => prep('SELECT * FROM ward_entries WHERE chain_id = ? AND seq = ?');

const _getEntries = () => prep('SELECT * FROM ward_entries WHERE chain_id = ? ORDER BY seq ASC');

const _getEntriesRange = () => prep('SELECT * FROM ward_entries WHERE chain_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC');

const _checkDuplicate = () => prep('SELECT 1 FROM ward_entries WHERE chain_id = ? AND source_kind = ? AND source_id = ?');

// WARD-RECEIPT-GAP: look an entry up by the same (chain_id, source_kind,
// source_id) triple the UNIQUE constraint enforces, so a caller holding a
// source event (e.g. a VOLT bundle_id) can find its witness receipt after
// the fact instead of only being able to append. Uses idx_ward_entries_source.
const _getEntryBySource = () => prep('SELECT * FROM ward_entries WHERE chain_id = ? AND source_kind = ? AND source_id = ?');

/**
 * Append an entry to a chain. Returns the entry or null if duplicate.
 * SPEC §11.2, §6.3 uniqueness constraint
 */
export function appendEntry(entry) {
  const d = getDb();
  // Use a transaction for atomicity (seq assignment + insert + chain update)
  const txn = d.transaction(() => {
    // Check uniqueness
    if (_checkDuplicate().get(entry.chain_id, entry.source_kind, entry.source_id)) {
      return null; // duplicate — expected on retry, not an error
    }
    _insertEntry().run({
      ...entry,
      tags: entry.tags ? JSON.stringify(entry.tags) : null,
      sig: entry.sig || null,
      source_ts: entry.source_ts || null,
      // ORG-VIEW-SCOPE: nullable attribute/tag on the row only — never
      // fabricated. The chain_id/seq/hash linkage above is untouched, so
      // the witness chain stays a single global append-only ledger.
      org_id: entry.org_id || null
    });
    _updateChainHead().run(entry.seq, entry.seq, entry.chain_hash, entry.chain_id);
    return entry;
  });
  return txn();
}

export function getEntry(entryId) {
  return _getEntry().get(entryId) || null;
}

export function getEntryBySeq(chainId, seq) {
  return _getEntryBySeq().get(chainId, seq) || null;
}

/**
 * WARD-RECEIPT-GAP: fetch the witness entry for a source event by its
 * (chain_id, source_kind, source_id) triple. Read-back counterpart to
 * appendEntry's duplicate check — lets a caller (e.g. the AEE bundle
 * export route) prove a VOLT bundle was actually witnessed instead of
 * trusting a field nothing ever wrote onto the bundle JSON.
 */
export function getEntryBySource(chainId, sourceKind, sourceId) {
  return _getEntryBySource().get(chainId, sourceKind, sourceId) || null;
}

/**
 * #622: find a witness entry by (source_kind, source_id) WITHOUT knowing its
 * chain. An auditor holding only an AEE envelope id (from `quox aee get`) has
 * no chain id to pass — the idx_ward_entries_source index is not chain-scoped,
 * so this resolves the chain for them. Returns the single entry (source ids are
 * effectively unique across the ledger; LIMIT 1 by chain_id for determinism).
 */
export function getEntryBySourceAnyChain(sourceKind, sourceId) {
  return getDb().prepare(
    'SELECT * FROM ward_entries WHERE source_kind = ? AND source_id = ? ORDER BY chain_id ASC LIMIT 1'
  ).get(sourceKind, sourceId) || null;
}

export function getEntries(chainId) {
  return _getEntries().all(chainId);
}

export function getEntriesRange(chainId, fromSeq, toSeq) {
  return _getEntriesRange().all(chainId, fromSeq, toSeq);
}

// --- Tip operations ---

const _insertTip = () => prep(`
  INSERT INTO ward_tips (tip_id, chain_id, tip_seq, tip_chain_hash, entry_count, created_at, sig, key_id, sink_ref, notes, tsr)
  VALUES (@tip_id, @chain_id, @tip_seq, @tip_chain_hash, @entry_count, @created_at, @sig, @key_id, @sink_ref, @notes, @tsr)
`);

const _getTips = () => prep('SELECT * FROM ward_tips WHERE chain_id = ? ORDER BY tip_seq ASC');

const _getLatestTip = () => prep('SELECT * FROM ward_tips WHERE chain_id = ? ORDER BY tip_seq DESC LIMIT 1');

const _getTipById = () => prep('SELECT * FROM ward_tips WHERE tip_id = ?');

const _updateTipReceipt = () => prep('UPDATE ward_tips SET tsr = ? WHERE tip_id = ?');

export function insertTip(tip) {
  _insertTip().run({
    ...tip,
    sig: tip.sig || null,
    key_id: tip.key_id || null,
    sink_ref: tip.sink_ref || null,
    notes: tip.notes || null,
    tsr: tip.tsr || null
  });
  return tip;
}

export function getTips(chainId) {
  return _getTips().all(chainId);
}

// ONE-BRAIN CX1: windowed reads so a bounded verify never loads the whole tip
// table (idx_ward_tips_chain covers chain_id + tip_seq).
const _getTipsInRange = () => prep('SELECT * FROM ward_tips WHERE chain_id = ? AND tip_seq BETWEEN ? AND ? ORDER BY tip_seq ASC');
const _firstTipBelow = () => prep('SELECT * FROM ward_tips WHERE chain_id = ? AND tip_seq < ? ORDER BY tip_seq ASC LIMIT 1');
const _firstTipAbove = () => prep('SELECT * FROM ward_tips WHERE chain_id = ? AND tip_seq > ? ORDER BY tip_seq ASC LIMIT 1');
const _countTipsOutside = () => prep('SELECT COUNT(*) AS n FROM ward_tips WHERE chain_id = ? AND (tip_seq < ? OR tip_seq > ?)');

export function getTipsInRange(chainId, fromSeq, toSeq) {
  return _getTipsInRange().all(chainId, fromSeq, toSeq);
}
export function firstTipBelow(chainId, seq) {
  return _firstTipBelow().get(chainId, seq) || null;
}
export function firstTipAbove(chainId, seq) {
  return _firstTipAbove().get(chainId, seq) || null;
}
export function countTipsOutside(chainId, fromSeq, toSeq) {
  return _countTipsOutside().get(chainId, fromSeq, toSeq).n;
}

export function getLatestTip(chainId) {
  return _getLatestTip().get(chainId) || null;
}

export function getTipById(tipId) {
  return _getTipById().get(tipId) || null;
}

/**
 * quox#515: the earliest SIGNED tip covering a given entry seq (tip_seq >=
 * seq). This is what a receipt reader needs to verify an individual entry:
 * entries are unsigned by design, the covering tip carries the Ed25519 sig
 * (and, when published, the RFC-3161 TSA receipt in `tsr`). Unsigned tips
 * are skipped — a tip without a sig cannot vouch for anything.
 */
export function getCoveringTip(chainId, seq) {
  return getDb().prepare(
    'SELECT * FROM ward_tips WHERE chain_id = ? AND tip_seq >= ? AND sig IS NOT NULL ORDER BY tip_seq ASC LIMIT 1'
  ).get(chainId, seq) || null;
}

/**
 * AUDIT-REAL #3: persist the RFC 3161 timestamp receipt (base64 DER)
 * returned by the `tsa` sink alongside the tip's sink_ref. Previously
 * publishToAllSinks()/hooks.js discarded tsr_base64 and kept only the
 * sink_ref string, making the receipt impossible to re-verify later.
 */
export function updateTipReceipt(tipId, tsrBase64) {
  _updateTipReceipt().run(tsrBase64, tipId);
}

// --- Stats ---

export function getStats() {
  const d = getDb();
  const chains = d.prepare('SELECT COUNT(*) as count FROM ward_chains').get().count;
  const entries = d.prepare("SELECT COALESCE(SUM(n), 0) as count FROM ward_counts WHERE k >= 'entries:' AND k < 'entries;'").get().count;
  const tips = d.prepare("SELECT COALESCE(SUM(n), 0) as count FROM ward_counts WHERE k = 'tips'").get().count;
  return { chains, entries, tips };
}

/**
 * ORG-VIEW-SCOPE: count of ward_entries visible to a given org_id.
 * This is a DISPLAY-scoped view over the same global chain — it does not
 * partition or affect the chain/seq/hash linkage in any way. Returns 0 for
 * an org with no visible witnessed entries (never null — null is reserved
 * for "org unresolvable", handled by the caller, not this query).
 *
 * Legacy-untagged policy (owner decision 2026-07): entries witnessed before
 * the org_id column existed (or witnessed with no resolvable org context)
 * have org_id = NULL. These are treated as SHARED/VISIBLE to every org —
 * they are not some other tenant's private data, they predate tenancy
 * entirely. Only entries EXPLICITLY tagged with a *different* org_id are
 * excluded. So the count is "entries tagged with this org OR untagged
 * legacy entries" — never another org's tagged entries.
 * @param {string} orgId
 * @returns {number}
 */
export function getEntryCountByOrg(orgId) {
  if (!orgId) return 0;
  const d = getDb();
  // quox#700: maintained counters (ward_counts triggers in initWardStore), not a
  // COUNT(*) over the chain. Tagged for this org + untagged legacy ('entries:').
  return d.prepare("SELECT COALESCE(SUM(n), 0) as count FROM ward_counts WHERE k IN (?, 'entries:')").get(`entries:${orgId}`).count;
}

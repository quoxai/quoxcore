/**
 * feedDbSource.js — The Feed's generic db-source reader (L1,
 * docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md Wave 2: "the generic db-source
 * adapter framework"). Given ONE declarative spec (feedDbAdapters.js), this
 * is the single, reusable ingester every registered spec plugs into — no
 * per-source code, only per-source data.
 *
 * BOUNDED, READ-ONLY, BEST-EFFORT — mirrors every other Feed ingester's
 * contract (feedFolderSource.js, feedFleetSource.js): opens `spec.dbPath`
 * with better-sqlite3 in readonly mode (this ingester NEVER writes to a
 * platform db — it only reads), issues exactly one bounded `SELECT ...
 * LIMIT ?` query per call (never a full-scan), renders rows to push-ingest
 * docs with one try/catch per row (a single malformed row is skipped, never
 * fatal to the batch), and is watermarked per (org, spec.sourceType) so
 * every tick only pulls what's genuinely new.
 *
 * REDACTION: `spec.redactCols` are rendered as a literal `[REDACTED]`
 * placeholder — the column's real value is never read into the doc body,
 * never logged, never pushed. This is a SEPARATE, narrower control than
 * feedExcludeRegistry.js's exclude gate (which refuses to register a spec
 * at all if it names a fundamentally unsafe table/column) — redactCols is
 * for "this table is fine, but this one column's value isn't."
 */

'use strict';

const Database = require('better-sqlite3');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const feedBatchSupport = require('./feedBatchSupport.js');

const DEFAULT_MAX_ITEMS = 50;
const REDACTED_PLACEHOLDER = '[REDACTED]';
// BRAIN2-FABLE11: deletion reconciliation scans the whole org-scoped table, so
// it is bounded (a bigger table is "not a complete snapshot", never a partial
// one) and throttled (a full scan every tick would be wasteful).
const MAX_SNAPSHOT_ROWS = 200000;
const RECONCILE_MIN_INTERVAL_MS = 10 * 60 * 1000;
// Field-encrypted values (utils/fieldEncryption.js) are ciphertext. They
// carry no recall value and must never be copied into a brain doc; we drop
// them rather than decrypt (decrypting would widen exposure).
const ENCRYPTED_PREFIX = 'enc:v1:';

function isEncryptedValue(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Opens `dbPath` readonly, `query_only` pragma set as defense-in-depth
 * (mirrors quoxchatToolExecutors.js's sqliteOpen — same readonly contract,
 * reused here rather than duplicated ad hoc). Never throws to the caller
 * that owns error handling; throws are caught by ingestDbSource itself.
 */
function openReadonlyDb(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

/**
 * Builds the single bounded SELECT for one adapter call: org-scoped,
 * strictly-after-watermark (when one exists), the spec's own optional
 * `where` fragment (a filtered-view adapter like aocl_policy's
 * `intent LIKE 'aocl.policy.%'`), ordered by (updatedCol, idCol) for a
 * stable incremental cursor, and always LIMIT-bounded. Column/table names
 * come from the static, developer-authored spec (never request input), so
 * identifier interpolation here is safe; org id and watermark are always
 * bound as parameters.
 *
 * @returns {{sql: string, params: any[]}}
 */
function buildQuery(spec, { orgId, watermark, limit }) {
  const params = [orgId];
  let sql = `SELECT * FROM "${spec.table}" WHERE "${spec.orgCol}" = ?`;

  const cursor = feedWatermark.parseCursor(watermark);
  if (cursor && cursor.id !== null) {
    // Compound cursor (BRAIN2-V3 A4): rows tied on the cursor ts with a
    // larger id are still owed.
    sql += ` AND ("${spec.updatedCol}" > ? OR ("${spec.updatedCol}" = ? AND "${spec.idCol}" > ?))`;
    params.push(cursor.ts, cursor.ts, cursor.id);
  } else if (cursor) {
    sql += ` AND "${spec.updatedCol}" > ?`;
    params.push(cursor.ts);
  }
  if (spec.where) {
    sql += ` AND (${spec.where})`;
  }

  sql += ` ORDER BY "${spec.updatedCol}" ASC, "${spec.idCol}" ASC LIMIT ?`;
  params.push(limit);

  return { sql, params };
}

/**
 * Renders one row into a push-ingest document: concatenates `spec.textCols`
 * as labeled markdown lines, substituting REDACTED_PLACEHOLDER for any
 * column in `spec.redactCols` (the real value is never read into the
 * string at all — the placeholder is written directly, not derived from
 * `row[col]`). Title comes from `spec.titleCol` (falling back to the
 * sourceType if the row's title column is empty); relPath is
 * `<sourceType>/<idCol value>.md`, matching every other Feed source's
 * `<sourceType>/<id>` convention.
 */
function renderRow(row, spec) {
  if (!row || typeof row !== 'object') throw new Error('row is not an object');

  const redactSet = new Set(Array.isArray(spec.redactCols) ? spec.redactCols : []);
  const lines = [];
  for (const col of spec.textCols || []) {
    if (redactSet.has(col)) {
      lines.push(`**${col}:** ${REDACTED_PLACEHOLDER}`);
      continue;
    }
    const value = row[col];
    if (value === null || value === undefined || value === '') continue;
    if (isEncryptedValue(value)) continue;
    lines.push(`**${col}:** ${value}`);
  }

  const idValue = row[spec.idCol];
  if (idValue === null || idValue === undefined || String(idValue).trim() === '') {
    throw new Error(`row missing idCol "${spec.idCol}"`);
  }

  // Signal gate: when the spec names `signalCols`, the doc is only worth
  // pushing if at least one of them rendered non-empty text (a doc whose
  // only content is an event name or a label has no recall value).
  // `spec.rowFilter(row)` is an optional per-row predicate for cases a
  // column check cannot express. Returns null for "not worth pushing".
  if (Array.isArray(spec.signalCols) && spec.signalCols.length > 0) {
    const hasSignal = spec.signalCols.some((col) => {
      const v = row[col];
      return v !== null && v !== undefined && String(v).trim() !== '' && !isEncryptedValue(v);
    });
    if (!hasSignal) return null;
  }
  if (typeof spec.rowFilter === 'function' && !spec.rowFilter(row)) return null;

  const titleValue = row[spec.titleCol];
  const title = (titleValue === null || titleValue === undefined || String(titleValue).trim() === '')
    ? spec.sourceType
    : String(titleValue);

  return {
    relPath: `${spec.sourceType}/${idValue}.md`,
    content: lines.join('\n\n'),
    title,
    kind: spec.sourceType,
    sourceType: spec.sourceType,
    occurredAt: row[spec.updatedCol] || undefined,
  };
}

/**
 * Every relPath the adapter would currently push for this org: a full,
 * org-scoped scan of the spec's table/view filtered through renderRow (so
 * signal gates and rowFilter apply exactly as on push). Returns null when the
 * scan fails or exceeds MAX_SNAPSHOT_ROWS, so a failed or truncated read can
 * never look like "everything was deleted".
 */
function collectSnapshot(db, spec, orgId) {
  try {
    let sql = `SELECT * FROM "${spec.table}" WHERE "${spec.orgCol}" = ?`;
    if (spec.where) sql += ` AND (${spec.where})`;
    const stmt = db.prepare(sql);
    const it = typeof stmt.iterate === 'function' ? stmt.iterate(orgId) : stmt.all(orgId);
    const seen = [];
    let n = 0;
    for (const row of it) {
      if (++n > MAX_SNAPSHOT_ROWS) return null;
      try {
        const doc = renderRow(row, spec);
        if (doc) seen.push(doc.relPath);
      } catch { /* unrenderable row: not a doc, not a snapshot member */ }
    }
    return seen;
  } catch {
    return null;
  }
}

/**
 * Ingests one db-source adapter spec for one org: bounded SELECT, per-row
 * render (best-effort), push to the spec's own vault, watermark advance on
 * success only. Never throws — mirrors every other Feed ingester's
 * contract so feedScheduler.js's tick loop treats this identically to
 * folder/fleet/transcript.
 *
 * @param {string} orgId
 * @param {{spec: object, maxItems?: number, dryRun?: boolean}} opts
 * @param {{
 *   getWatermarkFn?: Function,       // (orgId) => string|null
 *   setWatermarkFn?: Function,       // (orgId, ts) => void
 *   ensurePushVaultFn?: Function,    // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,      // defaults to brainFeedClient.pushDocuments
 *   openDbFn?: Function,             // (dbPath) => better-sqlite3-shaped db (tests) — caller owns closing it
 *   fetchImpl?: Function,            // forwarded to the brain client (test injection)
 *   userId?: string,
 *   dbPath?: string,                 // forwarded to feedWatermark (tests) — the WATERMARK store path, not spec.dbPath
 * }} [deps]
 * @returns {Promise<{rowsRead: number, docsPushed: number, skipped: string|null, error: string|null}>}
 */
async function ingestDbSource(orgId, opts = {}, deps = {}) {
  const result = { rowsRead: 0, rowsSkippedNoSignal: 0, docsPushed: 0, skipped: null, error: null };

  const spec = opts.spec;
  if (!spec || !spec.table || !spec.dbPath) {
    result.skipped = 'no spec';
    return result;
  }

  const {
    getWatermarkFn = (org) => feedWatermark.getWatermark(org, spec.sourceType, { dbPath: deps.dbPath }),
    setWatermarkFn = (org, ts) => feedWatermark.setWatermark(org, spec.sourceType, ts, { dbPath: deps.dbPath }),
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    reconcileIntervalMs = RECONCILE_MIN_INTERVAL_MS,
    openDbFn,
    fetchImpl,
    userId,
  } = deps;

  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const dryRun = !!opts.dryRun;

  let storedWatermark = null;
  try {
    storedWatermark = await getWatermarkFn(orgId);
  } catch (err) {
    console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: watermark read failed, treating as no watermark — ${err.message}`);
  }

  const usingDefaultOpen = typeof openDbFn !== 'function';
  let db;
  try {
    db = usingDefaultOpen ? openReadonlyDb(spec.dbPath) : openDbFn(spec.dbPath);
  } catch (err) {
    result.error = `open db failed — ${err.message}`;
    console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: ${result.error} (dbPath: ${spec.dbPath})`);
    return result;
  }
  if (!db) {
    result.error = 'db unavailable';
    return result;
  }

  const stateStore = feedBatchSupport.resolveStateStore(deps, !!deps.getWatermarkFn);
  const guardKey = `db:${spec.sourceType}`;
  const sweepAtKey = `${guardKey}:sweepAt`;
  let snapshot = null; // set only from a successful, bounded, full scan on a caught-up tick

  let rows = [];
  let overflowRows = [];
  try {
    const { sql, params } = buildQuery(spec, { orgId, watermark: storedWatermark, limit: maxItems + 1 });
    rows = db.prepare(sql).all(...params);
    // maxItems+1 rows fetched: the extra row (if any) is the proof that more
    // rows are owed, so a tie at the batch edge keeps a compound cursor.
    if (rows.length > maxItems) { overflowRows = rows.slice(maxItems); rows = rows.slice(0, maxItems); }
    if (!dryRun && stateStore && overflowRows.length === 0) {
      let due = true;
      try {
        const last = Number(await stateStore.get(orgId, sweepAtKey)) || 0;
        due = Date.now() - last >= reconcileIntervalMs;
      } catch { /* unreadable throttle: just scan */ }
      if (due) snapshot = collectSnapshot(db, spec, orgId);
    }
  } catch (err) {
    result.error = `query failed — ${err.message}`;
    console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: ${result.error}`);
    if (usingDefaultOpen) { try { db.close(); } catch { /* ignore */ } }
    return result;
  }
  if (usingDefaultOpen) { try { db.close(); } catch { /* ignore */ } }

  const docs = [];
  let newWatermark = storedWatermark || null;
  const processed = [];
  const guard = await feedBatchSupport.createFailureGuard(stateStore, orgId, guardKey);
  let heldAt = -1; // index of the first failed row: later rows still push, the cursor stops before it

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowId = String(row?.[spec.idCol] ?? '');
    try {
      const doc = renderRow(row, spec);
      result.rowsRead++;
      if (doc) docs.push(doc);
      else result.rowsSkippedNoSignal++;
      guard.clear(rowId);
      const rowTs = row[spec.updatedCol];
      if (rowTs && heldAt < 0) processed.push({ ts: String(rowTs), id: rowId });
    } catch (err) {
      // BRAIN2-W5 026: hold the cursor at the first failed row so it is
      // retried; after repeated failures it is passed over (loudly).
      const n = guard.record(rowId);
      console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: row ${rowId} failed (${n}/${feedBatchSupport.MAX_ITEM_ATTEMPTS}) — ${err.message}`);
      if (guard.shouldSkip(rowId)) {
        const rowTs = row?.[spec.updatedCol];
        if (rowTs && heldAt < 0) processed.push({ ts: String(rowTs), id: rowId });
        continue;
      }
      if (heldAt < 0) heldAt = i;
      result.error = result.error || `render row ${rowId} failed — ${err.message}`;
    }
  }
  await guard.flush();

  if (processed.length > 0) {
    // SQL order (updatedCol, idCol) is authoritative, so the cursor is the
    // LAST processed row, not a string-sorted max (numeric ids differ).
    const last = processed[processed.length - 1];
    const owed = (heldAt >= 0 ? rows.slice(heldAt) : []).concat(overflowRows);
    const tiesOwed = owed.some((r) => String(r[spec.updatedCol]) === last.ts);
    newWatermark = tiesOwed ? `${last.ts}|${last.id}` : last.ts;
  }

  if (dryRun) return result; // tallies rowsRead, pushes/advances nothing

  const ensureVault = async () => ensurePushVaultFn(orgId, spec.vaultName, { scope: spec.scope || 'org', userId, fetchImpl });
  const advanceWatermark = async () => {
    if (newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWatermarkFn(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: watermark write failed — ${err.message}`);
      }
    }
  };

  try {
    if (docs.length === 0) {
      // Every row was filtered as no-signal: nothing to push, but advance the
      // watermark past them so the same rows are not re-read every tick.
      await advanceWatermark();
    } else {
      const vaultId = await ensureVault();
      if (!vaultId) {
        result.error = 'ensurePushVault returned no vaultId';
        console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: ${result.error} — not advancing watermark`);
        return result;
      }

      const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
      if (pushResult?.error) {
        result.error = pushResult.error;
        console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: push failed — ${pushResult.error} — not advancing watermark`);
        return result;
      }

      result.docsPushed = docs.length;
      await advanceWatermark();
    }

    // BRAIN2-FABLE11: a complete scan is a full snapshot, so rows that vanished
    // (deleted, retention-pruned) get explicit tombstones. Never on a failed,
    // oversize or errored read (snapshot stays null), never while rows are owed.
    if (snapshot && !result.error) {
      const r = await feedBatchSupport.reconcileDeletions({
        store: stateStore, orgId, key: guardKey, seen: snapshot, complete: true, ensureVault,
        pushDeletionsFn, pushOpts: { userId, fetchImpl },
      });
      if (r.deleted > 0) result.deleted = r.deleted;
      if (r.error) { result.error = r.error; console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: ${r.error}`); }
      else { try { await stateStore.set(orgId, sweepAtKey, String(Date.now())); } catch { /* rescanned next tick */ } }
    }
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedDbSource] org=${orgId} source=${spec.sourceType}: ${result.error} — not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestDbSource,
  buildQuery,
  renderRow,
  openReadonlyDb,
  DEFAULT_MAX_ITEMS,
  REDACTED_PLACEHOLDER,
  ENCRYPTED_PREFIX,
  isEncryptedValue,
};

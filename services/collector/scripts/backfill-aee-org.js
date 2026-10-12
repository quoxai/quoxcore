/**
 * backfill-aee-org.js — AEE-ORG-BACKFILL P3: tag the untagged envelope backlog.
 *
 * Context: until lib/aeeOrgScoping.js learnt both payload spellings
 * (2026-08-18) and quoxflow's store stamped forwarded envelopes
 * (AEE-ORG-BACKFILL P1), ~94% of aee.db rows were stored with org_id NULL,
 * and GET /aee/query's NULL branch serves that bucket to every tenant.
 * This script retroactively tags what the rows themselves prove, so the NULL
 * read branch can be closed without blanking tenants' history.
 *
 * Two passes, strongest evidence first, only ever touching org_id IS NULL rows:
 *   1. payload  — decrypt the row's own payload and re-run the current
 *                 deriveEnvelopeOrgId (payload.orgId / payload.org_id /
 *                 org.<id> addresses). The row's own signal, never inference.
 *   2. corr     — adopt the org of tagged siblings in the same corr chain,
 *                 ONLY where the corr maps to exactly one distinct org.
 *                 Ambiguous corrs (>1 org) are counted and left alone.
 * Residue stays NULL honestly: platform envelopes with no tenant are
 * supposed to be NULL, and inference beyond the two passes above would be
 * fabrication (the aeeOrgScoping.js contract: never invent an org).
 *
 * Run INSIDE the collector container (needs MASTER_ENCRYPTION_KEY and the
 * repo's fieldEncryption/aeeOrgScoping):
 *   docker exec quox-collector node scripts/backfill-aee-org.js           # dry-run
 *   docker exec quox-collector node scripts/backfill-aee-org.js --apply   # write
 *
 * Idempotent and resumable: re-running only sees rows still NULL. Writes are
 * batched short transactions (WAL) so the live server's writers are not
 * starved. This file is repo-managed on purpose: the VOLT-RETENTION
 * 2026-08-19 trap was an unmanaged script copy that never ran.
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { decryptEnvelopeRow } = require(path.join(__dirname, '..', 'utils', 'fieldEncryption'));
const { deriveEnvelopeOrgId } = require(path.join(__dirname, '..', 'lib', 'aeeOrgScoping'));

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.AEE_DB_PATH || '/var/lib/quox/aee.db';
const BATCH = 5000;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

const counts = {
  scanned: 0,
  payloadTagged: 0,
  corrTagged: 0,
  ambiguousCorrRows: 0,
  residueNull: 0,
  decryptFailed: 0,
};
const byOrg = new Map();
const bump = (org, n = 1) => byOrg.set(org, (byOrg.get(org) || 0) + n);

/**
 * A tag is only worth writing if it names a real tenant. The first dry-run
 * showed corr adoption would have spread 314k rows of 'default' and 121 of
 * '__default__' — legacy sentinels from pre-multi-tenant writers. Stamping
 * those creates a third bucket no tenant's query matches (the exact
 * invisibility problem aeeOrgScoping.js warns about for ''). ULID-shaped
 * org ids only.
 */
const SENTINEL_ORGS = new Set(['default', '__default__', 'system', 'null', 'undefined']);
function realOrg(org) {
  if (typeof org !== 'string') return null;
  const v = org.trim();
  if (!v || SENTINEL_ORGS.has(v.toLowerCase())) return null;
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v) ? v : null;
}

const updateStmt = db.prepare('UPDATE envelopes SET org_id = ? WHERE id = ? AND org_id IS NULL');
const applyBatch = db.transaction((rows) => {
  for (const [org, id] of rows) updateStmt.run(org, id);
});

// ── Pass 1: the row's own payload ───────────────────────────────────────
function passPayload() {
  console.log(`[pass 1/2] payload re-derivation over org_id IS NULL rows${APPLY ? '' : ' (dry-run)'}`);
  // decryptEnvelopeRow decrypts row.raw (the whole envelope), not row.payload.
  // The first dry-run selected only payload and every row "failed" decryption;
  // the failure was in this SELECT, not the data.
  const cursor = db.prepare(`
    SELECT rowid, id, "from", "to", raw FROM envelopes
    WHERE org_id IS NULL AND rowid > ? ORDER BY rowid LIMIT ?
  `);
  let lastRowid = 0;
  let pending = [];
  for (;;) {
    const rows = cursor.all(lastRowid, BATCH);
    if (rows.length === 0) break;
    lastRowid = rows[rows.length - 1].rowid;
    for (const row of rows) {
      counts.scanned += 1;
      const env = decryptEnvelopeRow(row);
      if (!env) { counts.decryptFailed += 1; continue; }
      const org = realOrg(deriveEnvelopeOrgId({ payload: env.payload, from: row.from, to: row.to }));
      if (org) {
        counts.payloadTagged += 1;
        bump(org);
        if (APPLY) pending.push([org, row.id]);
      }
    }
    if (APPLY && pending.length >= BATCH) { applyBatch(pending); pending = []; }
    if (counts.scanned % 100000 === 0) console.log(`  scanned ${counts.scanned}, tagged ${counts.payloadTagged}`);
  }
  if (APPLY && pending.length) applyBatch(pending);
  console.log(`  pass 1 done: ${counts.payloadTagged} rows carry their own org (${counts.decryptFailed} undecryptable)`);
}

// ── Pass 2: unambiguous corr-chain adoption ─────────────────────────────
function passCorr() {
  console.log(`[pass 2/2] corr-chain adoption (unambiguous corrs only)${APPLY ? '' : ' (dry-run)'}`);
  // One org per corr; corrs spanning orgs are excluded outright.
  const corrOrgs = db.prepare(`
    SELECT corr, MIN(org_id) org_id, COUNT(DISTINCT org_id) k
    FROM envelopes WHERE org_id IS NOT NULL GROUP BY corr
  `).all();
  const unambiguous = new Map();
  const ambiguous = new Set();
  for (const c of corrOrgs) {
    if (c.k !== 1) { ambiguous.add(c.corr); continue; }
    const org = realOrg(c.org_id);
    if (org) unambiguous.set(c.corr, org);
    // corrs whose only org is a sentinel are simply not adopted from
  }
  console.log(`  ${unambiguous.size} single-org corrs, ${ambiguous.size} ambiguous (skipped)`);

  const cursor = db.prepare(`
    SELECT rowid, id, corr FROM envelopes
    WHERE org_id IS NULL AND rowid > ? ORDER BY rowid LIMIT ?
  `);
  let lastRowid = 0;
  let pending = [];
  for (;;) {
    const rows = cursor.all(lastRowid, BATCH);
    if (rows.length === 0) break;
    lastRowid = rows[rows.length - 1].rowid;
    for (const row of rows) {
      if (ambiguous.has(row.corr)) { counts.ambiguousCorrRows += 1; continue; }
      const org = unambiguous.get(row.corr);
      if (org) {
        counts.corrTagged += 1;
        bump(org);
        if (APPLY) pending.push([org, row.id]);
      }
    }
    if (APPLY && pending.length >= BATCH) { applyBatch(pending); pending = []; }
  }
  if (APPLY && pending.length) applyBatch(pending);
  console.log(`  pass 2 done: ${counts.corrTagged} rows adopted a sibling's org`);
}

const before = db.prepare('SELECT COUNT(*) n FROM envelopes WHERE org_id IS NULL').get().n;
console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} against ${DB_PATH}: ${before} untagged rows`);
passPayload();
passCorr();
counts.residueNull = APPLY
  ? db.prepare('SELECT COUNT(*) n FROM envelopes WHERE org_id IS NULL').get().n
  : before - counts.payloadTagged - counts.corrTagged;

console.log('\n== Result ==');
console.log(JSON.stringify(counts, null, 2));
console.log('rows per org:', JSON.stringify(Object.fromEntries(byOrg), null, 2));
if (!APPLY) console.log('\nDry-run only. Re-run with --apply to write.');
db.close();

#!/usr/bin/env node
/**
 * volt-archive-prune: delete ARCHIVED runs' events from volt.db. VOLT-RETENTION P4.
 *
 *   node scripts/volt-archive-prune.js --db <path> --archive <dir>
 *        [--location-prefix <p>] [--limit n] [--batch 200] [--verifier <path>]
 *        [--dry-run (default) | --apply]
 *
 * Reads <archive>/anchors.jsonl (written by volt-archive.js). A run's events are
 * deleted ONLY when all of these hold, otherwise the run is skipped and reported:
 *   1. the bundle file exists and its sha256 equals the anchor's file_sha256;
 *   2. it re-verifies with the same verifier volt-archive.js uses (fail closed
 *      if the verifier cannot be loaded);
 *   3. the DB's current events match the anchor: same count, and the first and
 *      last event hashes (by seq) equal first_event_hash / last_event_hash.
 * --apply writes the volt_archive_anchors row and deletes the events in one
 * transaction per run, batched. It does NOT shrink the file (VACUUM is a later,
 * owner-windowed step). Idempotent: already-pruned runs are skipped.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { loadVerifier } = require('./volt-archive.js');

function parseArgs(argv) {
  const o = { batch: 200, apply: false, sleepMs: 200 };
  const need = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--db': o.db = need(i, a); i++; break;
      case '--archive': o.archive = need(i, a); i++; break;
      case '--location-prefix': o.locationPrefix = need(i, a); i++; break;
      case '--limit': o.limit = num(need(i, a), a); i++; break;
      case '--batch': o.batch = Math.max(1, num(need(i, a), a)); i++; break;
      case '--verifier': o.verifier = need(i, a); i++; break;
      case '--apply': o.apply = true; break;
      case '--dry-run': o.apply = false; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!o.db) throw new Error('--db <path> is required');
  if (!o.archive) throw new Error('--archive <dir> is required');
  return o;
}

function readAnchors(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  const byRun = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line);
      if (a.run_id && a.verified === true) byRun.set(a.run_id, a); // last line wins
    } catch (_) { /* torn line */ }
  }
  return [...byRun.values()];
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GiB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' B';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashOf(dataStr) {
  try { return JSON.parse(dataStr).hash || null; } catch (_) { return null; }
}

function mapLocation(o, absFile) {
  if (!o.locationPrefix) return absFile;
  return path.join(o.locationPrefix, path.relative(path.resolve(o.archive), absFile));
}

async function run(argv, io = {}) {
  const log = io.log || ((s) => console.log(s));
  const o = typeof argv === 'object' && !Array.isArray(argv) ? argv : parseArgs(argv);
  const Database = require('better-sqlite3');
  const started = Date.now();
  const res = { considered: 0, pruned: 0, would_prune: 0, already_pruned: 0, skipped: 0, events: 0, raw_bytes: 0, reasons: {} };
  const skip = (a, reason) => {
    res.skipped++;
    res.reasons[reason] = (res.reasons[reason] || 0) + 1;
    log(`  ! ${a.run_id}: skipped (${reason})`);
  };

  const anchors = readAnchors(path.join(o.archive, 'anchors.jsonl'));
  const verify = await loadVerifier(o.verifier); // throws = fail closed

  const db = new Database(o.db, { readonly: !o.apply, fileMustExist: true });
  try {
    if (o.apply) {
      db.pragma('busy_timeout = 30000');
      db.pragma('journal_mode = WAL');
      db.exec(`CREATE TABLE IF NOT EXISTS volt_archive_anchors (
        run_id TEXT PRIMARY KEY, org_id TEXT, bundle_id TEXT, location TEXT, file_sha256 TEXT,
        file_bytes INTEGER, raw_bytes INTEGER, event_count INTEGER, first_event_hash TEXT,
        last_event_hash TEXT, signer_key_id TEXT, archived_at TEXT, pruned_at TEXT);
        CREATE INDEX IF NOT EXISTS idx_volt_archive_anchors_org ON volt_archive_anchors(org_id);`);
    } else {
      db.pragma('busy_timeout = 30000');
    }
    const hasTable = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='volt_archive_anchors'").get();
    const prunedStmt = hasTable ? db.prepare('SELECT pruned_at FROM volt_archive_anchors WHERE run_id = ?') : null;
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM volt_events WHERE run_id = ?');
    const firstStmt = db.prepare('SELECT data FROM volt_events WHERE run_id = ? ORDER BY seq ASC LIMIT 1');
    const lastStmt = db.prepare('SELECT data FROM volt_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1');
    let insAnchor, delEvents;
    if (o.apply) {
      insAnchor = db.prepare(`INSERT OR REPLACE INTO volt_archive_anchors
        (run_id, org_id, bundle_id, location, file_sha256, file_bytes, raw_bytes, event_count,
         first_event_hash, last_event_hash, signer_key_id, archived_at, pruned_at)
        VALUES (@run_id, @org_id, @bundle_id, @location, @file_sha256, @file_bytes, @raw_bytes, @event_count,
         @first_event_hash, @last_event_hash, @signer_key_id, @archived_at, @pruned_at)`);
      delEvents = db.prepare('DELETE FROM volt_events WHERE run_id = ?');
    }

    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      const items = batch;
      batch = [];
      db.transaction(() => {
        for (const it of items) {
          insAnchor.run(it.row);
          const d = delEvents.run(it.row.run_id);
          res.events += d.changes;
          res.raw_bytes += it.row.raw_bytes || 0;
          res.pruned++;
        }
      })();
      try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}
      log(`  .. pruned ${res.pruned} runs, ${res.events} events so far`);
      await sleep(io.sleepMs !== undefined ? io.sleepMs : o.sleepMs);
    };

    for (const a of anchors) {
      if (o.limit !== undefined && res.considered >= o.limit) break;
      if (prunedStmt) {
        const p = prunedStmt.get(a.run_id);
        if (p && p.pruned_at) { res.already_pruned++; continue; }
      }
      const n = countStmt.get(a.run_id).n;
      if (n === 0) { res.already_pruned++; continue; } // nothing left to delete
      res.considered++;

      if (!a.file || !a.file_sha256) { skip(a, 'anchor_incomplete'); continue; }
      const abs = path.resolve(o.archive, a.file);
      if (!abs.startsWith(path.resolve(o.archive) + path.sep)) { skip(a, 'file_outside_archive'); continue; }
      let buf;
      try { buf = fs.readFileSync(abs); } catch (_) { skip(a, 'bundle_missing'); continue; }
      if (crypto.createHash('sha256').update(buf).digest('hex') !== a.file_sha256) { skip(a, 'sha256_mismatch'); continue; }
      try {
        const v = await verify(zlib.gunzipSync(buf).toString('utf8'), {});
        const sigOk = a.signer_key_id ? v.summary.signatures_valid === 1 : true;
        if (!v.valid || !v.summary.chain_valid || !sigOk) { skip(a, 'bundle_verify_failed'); continue; }
      } catch (_) { skip(a, 'bundle_verify_error'); continue; }

      if (n !== a.event_count) { skip(a, 'event_count_mismatch'); continue; }
      const f = hashOf(firstStmt.get(a.run_id).data);
      const l = hashOf(lastStmt.get(a.run_id).data);
      if (f !== a.first_event_hash || l !== a.last_event_hash) { skip(a, 'event_hash_mismatch'); continue; }

      if (!o.apply) {
        res.would_prune++;
        res.events += n;
        res.raw_bytes += a.raw_bytes || 0;
        log(`  would prune ${a.run_id}  ${n} events  ${fmtBytes(a.raw_bytes || 0)}`);
        continue;
      }
      batch.push({
        row: {
          run_id: a.run_id, org_id: a.org_id || null, bundle_id: a.bundle_id || null,
          location: mapLocation(o, abs), file_sha256: a.file_sha256, file_bytes: a.file_bytes || null,
          raw_bytes: a.raw_bytes || null, event_count: a.event_count,
          first_event_hash: a.first_event_hash, last_event_hash: a.last_event_hash,
          signer_key_id: a.signer_key_id || null, archived_at: a.archived_at || null,
          pruned_at: new Date().toISOString(),
        },
      });
      if (batch.length >= o.batch) await flush();
    }
    await flush();
  } finally {
    db.close();
  }

  const ms = Date.now() - started;
  const skippedTxt = Object.entries(res.reasons).map(([k, v]) => `${k}=${v}`).join(',') || 'none';
  res.summary = o.apply
    ? `Ⓠ VOLT-PRUNE │ apply ${o.archive} │ ${res.pruned} runs pruned ✔ · ${res.events} events deleted · ${fmtBytes(res.raw_bytes)} raw removed · ${res.skipped} skipped (${skippedTxt}) · ${res.already_pruned} already pruned · ${ms}ms`
    : `Ⓠ VOLT-PRUNE │ dry-run │ ${res.would_prune} runs would prune · ${res.events} events · ${fmtBytes(res.raw_bytes)} raw · ${res.skipped} skipped (${skippedTxt}) · ${res.already_pruned} already pruned · nothing written · ${ms}ms`;
  log(res.summary);
  return res;
}

module.exports = { run, parseArgs };

if (require.main === module) {
  run(process.argv.slice(2)).then((r) => { process.exitCode = r.skipped ? 1 : 0; }).catch((err) => {
    console.error(`Ⓠ VOLT-PRUNE │ error │ ${err.message} ✖`);
    process.exitCode = 2;
  });
}

#!/usr/bin/env node
/**
 * volt-archive: export old VOLT runs from volt.db to signed, offline-verifiable
 * evidence bundles on disk (cold storage). VOLT-RETENTION P3.
 *
 * READ-ONLY against volt.db (opened { readonly: true }); this tool never
 * deletes or writes rows. Deleting is a later, owner-gated phase.
 *
 *   node scripts/volt-archive.js [--db <path>] [--out <dir>] [--older-than <days>]
 *        [--run <id>] [--limit <n>] [--min-bytes <n>] [--max-run-bytes <n>]
 *        [--dry-run | --apply] [--allow-unsigned] [--verifier <path>]
 *
 * Signing: same signer as autoBundleOnComplete (lib/bundleSigner.js) using the
 * persistent WARD Ed25519 keypair in $WARD_KEY_DIR (default /var/lib/quox/ward-keys).
 * Fails CLOSED: with no key, nothing is written unless --allow-unsigned.
 * Every written file is re-read and verified with the same verifier the CLI
 * uses (src/lib/volt/volt-verify.js); only a PASS gets an anchors.jsonl line,
 * a FAIL deletes the file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { buildBundleParts } = require('../lib/voltBundleBuilder.js');
const { signBundleManifest } = require('../lib/bundleSigner.js');

const DEFAULT_DB = '/var/lib/quox/volt.db';
const DEFAULT_MAX_RUN_BYTES = 400 * 1024 * 1024; // V8 string ceiling is ~512MB

function parseArgs(argv) {
  const o = { db: DEFAULT_DB, limit: 100, apply: false, allowUnsigned: false, maxRunBytes: DEFAULT_MAX_RUN_BYTES };
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
      case '--out': o.out = need(i, a); i++; break;
      case '--older-than': o.olderThan = num(need(i, a), a); i++; break;
      case '--run': o.run = need(i, a); i++; break;
      case '--runs-file': o.runsFile = need(i, a); i++; break;
      case '--limit': o.limit = num(need(i, a), a); i++; break;
      case '--min-bytes': o.minBytes = num(need(i, a), a); i++; break;
      case '--max-run-bytes': o.maxRunBytes = num(need(i, a), a); i++; break;
      case '--verifier': o.verifier = need(i, a); i++; break;
      case '--apply': o.apply = true; break;
      case '--dry-run': o.apply = false; break;
      case '--allow-unsigned': o.allowUnsigned = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (o.apply && !o.out) throw new Error('--out <dir> is required with --apply');
  if (o.olderThan === undefined && !o.run && !o.runsFile) throw new Error('give --older-than <days>, --run <id> or --runs-file <path>');
  return o;
}

function loadSigningKeypair(keyDir) {
  const dir = keyDir || process.env.WARD_KEY_DIR || '/var/lib/quox/ward-keys';
  try {
    const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(dir, 'ward-pub.pem'), 'utf8'));
    const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'ward-priv.pem'), 'utf8'));
    const keyId = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex').slice(0, 16);
    return { publicKey, privateKey, keyId };
  } catch (_) {
    return null;
  }
}

async function loadVerifier(explicit) {
  const candidates = [
    explicit,
    path.resolve(__dirname, '../../../src/lib/volt/volt-verify.js'), // repo checkout
    '/app/src/lib/volt/volt-verify.js', // container layout
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return (await import(pathToFileURL(c).href)).verifyEvidenceBundle;
  }
  throw new Error(`volt-verify.js not found (tried: ${candidates.join(', ')}); pass --verifier <path>`);
}

function readAnchors(file) {
  const done = new Set();
  if (!fs.existsSync(file)) return done;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const a = JSON.parse(line); if (a.run_id && a.verified) done.add(a.run_id); } catch (_) { /* skip torn line */ }
  }
  return done;
}

function bundlePath(out, run) {
  const org = run.org_id ? String(run.org_id).replace(/[^A-Za-z0-9._-]/g, '_') : '_none';
  const month = /^\d{4}-\d{2}/.test(run.started_at || '') ? run.started_at.slice(0, 7) : '_unknown';
  const id = String(run.run_id).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(out, org, month, `${id}.bundle.json.gz`);
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GiB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
  return n + ' B';
}

async function run(argv, io = {}) {
  const log = io.log || ((s) => console.log(s));
  const o = typeof argv === 'object' && !Array.isArray(argv) ? argv : parseArgs(argv);
  const Database = require('better-sqlite3');
  const started = Date.now();
  const db = new Database(o.db, { readonly: true, fileMustExist: true });
  const result = { matched: 0, archived: 0, skipped_anchored: 0, skipped_size: 0, failed: 0, raw_bytes: 0, file_bytes: 0, est_bytes: 0, events: 0 };

  try {
    let keypair = null;
    let verify = null;
    let anchorsFile = null;
    let anchored = new Set();
    if (o.apply) {
      keypair = io.keypair !== undefined ? io.keypair : loadSigningKeypair();
      if (!keypair && !o.allowUnsigned) {
        throw new Error('no WARD signing keypair found (set WARD_KEY_DIR); refusing to write unsigned bundles. Pass --allow-unsigned to override.');
      }
      verify = await loadVerifier(o.verifier);
      fs.mkdirSync(o.out, { recursive: true });
      anchorsFile = path.join(o.out, 'anchors.jsonl');
      anchored = readAnchors(anchorsFile);
    } else if (o.out) {
      anchored = readAnchors(path.join(o.out, 'anchors.jsonl'));
    }

    let runsStmt;
    let runsArgs;
    let runsIter = null;
    if (o.runsFile) {
      // VOLT-RETENTION P4: an explicit run list (one run_id per line). The
      // 2026-08-10..19 band has started_at NULL, so --older-than cannot see it.
      const ids = fs.readFileSync(o.runsFile, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
      const getRun = db.prepare('SELECT * FROM volt_runs WHERE run_id = ?');
      runsIter = (function* () { for (const id of ids) { const r = getRun.get(id); if (r) yield r; } })();
    } else if (o.run) {
      runsStmt = db.prepare('SELECT * FROM volt_runs WHERE run_id = ?');
      runsArgs = [o.run];
    } else {
      const cutoff = new Date((io.now || Date.now()) - o.olderThan * 86400000).toISOString();
      runsStmt = db.prepare(`SELECT * FROM volt_runs WHERE status = 'completed' AND started_at IS NOT NULL AND started_at < ? ORDER BY started_at ASC`);
      runsArgs = [cutoff];
    }
    const sizeStmt = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(data)),0) AS bytes FROM volt_events WHERE run_id = ?');
    const eventsStmt = db.prepare('SELECT * FROM volt_events WHERE run_id = ? ORDER BY seq ASC');

    for (const r of (runsIter || runsStmt.iterate(...runsArgs))) {
      if (result.matched >= o.limit) break;
      if ((o.run || o.runsFile) && r.status !== 'completed') {
        log(`  ! ${r.run_id}: status=${r.status}, only completed runs are archived`);
        continue;
      }
      if (anchored.has(r.run_id)) { result.skipped_anchored++; continue; }
      const sz = sizeStmt.get(r.run_id);
      if (sz.n === 0) continue;
      if (o.minBytes !== undefined && sz.bytes < o.minBytes) continue;
      result.matched++;
      result.events += sz.n;
      result.est_bytes += sz.bytes;
      if (!o.apply) {
        log(`  ${r.run_id}  org=${r.org_id || '_none'}  started=${r.started_at}  events=${sz.n}  ~${fmtBytes(sz.bytes)}`);
        continue;
      }
      if (sz.bytes > o.maxRunBytes) {
        result.skipped_size++;
        log(`  ! ${r.run_id}: ${fmtBytes(sz.bytes)} exceeds --max-run-bytes, skipped`);
        continue;
      }

      const file = bundlePath(o.out, r);
      try {
        const parts = buildBundleParts(eventsStmt.iterate(r.run_id), { runId: r.run_id, status: r.status });
        const { manifest, eventsNdjson } = parts;
        const bundle = { manifest, events_ndjson: eventsNdjson };
        let signerKeyId = null;
        if (keypair) {
          const sig = await signBundleManifest(manifest, { getHookKeypair: () => keypair });
          if (sig.warning) throw new Error(`signer fell back to an ephemeral key (${sig.warning}); refusing`);
          bundle.signatures = [sig];
          signerKeyId = sig.key_id;
        }
        const rawJson = JSON.stringify(bundle);
        const gz = zlib.gzipSync(Buffer.from(rawJson, 'utf8'), { level: 6 });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, gz);
        fs.renameSync(tmp, file);

        // Re-read from disk and verify with the CLI's verifier.
        const reread = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
        const v = await verify(reread, {});
        const sigOk = keypair ? v.summary.signatures_valid === 1 : true;
        if (!v.valid || !v.summary.chain_valid || !sigOk) {
          fs.unlinkSync(file);
          result.failed++;
          log(`  x ${r.run_id}: verification FAILED after write, file deleted (${v.errors.map(e => e.code).join(',') || 'signature'})`);
          continue;
        }
        const fileBytes = fs.statSync(file).size;
        const anchor = {
          run_id: r.run_id,
          org_id: r.org_id || null,
          bundle_id: manifest.bundle_id,
          file: path.relative(o.out, file),
          file_sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
          file_bytes: fileBytes,
          raw_bytes: Buffer.byteLength(rawJson),
          event_count: manifest.event_count,
          first_event_hash: manifest.first_event_hash,
          last_event_hash: manifest.last_event_hash,
          started_at: r.started_at,
          archived_at: new Date().toISOString(),
          verified: true,
          signer_key_id: signerKeyId,
        };
        fs.appendFileSync(anchorsFile, JSON.stringify(anchor) + '\n');
        anchored.add(r.run_id);
        result.archived++;
        result.raw_bytes += anchor.raw_bytes;
        result.file_bytes += fileBytes;
        log(`  ok ${r.run_id}  ${manifest.event_count} events  ${fmtBytes(anchor.raw_bytes)} -> ${fmtBytes(fileBytes)}`);
      } catch (err) {
        try { fs.unlinkSync(file + '.tmp'); } catch (_) {}
        result.failed++;
        log(`  x ${r.run_id}: ${err.message}`);
      }
    }
  } finally {
    db.close();
  }

  const ms = Date.now() - started;
  if (o.apply) {
    const ratio = result.file_bytes ? (result.raw_bytes / result.file_bytes).toFixed(1) : 'n/a';
    result.summary = `Ⓠ VOLT-ARCHIVE │ apply ${o.out} │ ${result.archived}/${result.matched} archived ✔ · ${result.failed} failed ${result.failed ? '✖' : ''}· ${result.skipped_anchored} already anchored · ${fmtBytes(result.raw_bytes)} -> ${fmtBytes(result.file_bytes)} (${ratio}x) · ${ms}ms`;
  } else {
    result.summary = `Ⓠ VOLT-ARCHIVE │ dry-run │ ${result.matched} runs · ${result.events} events · ~${fmtBytes(result.est_bytes)} raw · ${result.skipped_anchored} already anchored · nothing written · ${ms}ms`;
  }
  log(result.summary);
  return result;
}

module.exports = { run, parseArgs, loadSigningKeypair, bundlePath, loadVerifier };

if (require.main === module) {
  run(process.argv.slice(2)).then((r) => { process.exitCode = r.failed ? 1 : 0; }).catch((err) => {
    console.error(`Ⓠ VOLT-ARCHIVE │ error │ ${err.message} ✖`);
    process.exitCode = 2;
  });
}

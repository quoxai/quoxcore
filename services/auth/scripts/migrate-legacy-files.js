#!/usr/bin/env node
/**
 * FU-3 — Migrate legacy files-plugin storage into file_objects
 *
 * Reads /services/files/ disk storage (set via FILES_LEGACY_ROOT env or
 * autodetected at /var/lib/quox/files), computes SHA-256 per file,
 * copies the blob to AUTH_FILES_ROOT under content-addressed path,
 * inserts a file_objects row with namespace='files', source_plugin='files'.
 *
 * Idempotent: skips files whose sha256 already has a file_objects row in
 * the target org.
 *
 * Usage:
 *   node services/auth/scripts/migrate-legacy-files.js --org <org_id> --user <admin_id> [--dry-run]
 *
 * Org + user are required because legacy storage has no ownership info.
 * Pass the primary admin user for the target org.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { ulid } from 'ulid';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || i === args.length - 1) return def;
  return args[i + 1];
}

const ORG_ID = arg('org');
const USER_ID = arg('user');
const DRY_RUN = args.includes('--dry-run');
const LEGACY_ROOT = process.env.FILES_LEGACY_ROOT || '/var/lib/quox/files';
const AUTH_FILES_ROOT = process.env.AUTH_FILES_ROOT || '/var/lib/quox/file-objects';
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || '/var/lib/quox/auth.db';

if (!ORG_ID || !USER_ID) {
  console.error('Usage: migrate-legacy-files.js --org <org_id> --user <admin_id> [--dry-run]');
  process.exit(2);
}

if (!fs.existsSync(LEGACY_ROOT)) {
  console.error(`Legacy root not found: ${LEGACY_ROOT}`);
  process.exit(3);
}

function sha256File(p) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(p));
  return hash.digest('hex');
}

function inferMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const db = new Database(AUTH_DB_PATH);
db.pragma('foreign_keys = ON');

// Verify org + user exist.
const orgRow = db.prepare('SELECT id FROM orgs WHERE id = ?').get(ORG_ID);
if (!orgRow) { console.error(`Org not found: ${ORG_ID}`); process.exit(4); }
const userRow = db.prepare('SELECT id FROM users WHERE id = ?').get(USER_ID);
if (!userRow) { console.error(`User not found: ${USER_ID}`); process.exit(5); }

const existingShaStmt = db.prepare('SELECT id FROM file_objects WHERE org_id = ? AND sha256 = ? LIMIT 1');
const insertStmt = db.prepare(`
  INSERT INTO file_objects
    (id, org_id, created_by, namespace, virtual_path, filename, mime, size_bytes, sha256, blob_path,
     source_plugin, source_ref, metadata_json)
  VALUES (?, ?, ?, 'files', ?, ?, ?, ?, ?, ?, 'files', NULL, ?)
`);

const files = walk(LEGACY_ROOT);
let migrated = 0, skipped = 0, failed = 0;

for (const src of files) {
  try {
    const stat = fs.statSync(src);
    if (stat.size === 0) { skipped++; continue; }
    const sha = sha256File(src);
    const existing = existingShaStmt.get(ORG_ID, sha);
    if (existing) { skipped++; continue; }

    const filename = path.basename(src);
    const relativeShard = `${ORG_ID}/${sha.slice(0, 2)}/${sha}`;
    const destBlob = path.join(AUTH_FILES_ROOT, relativeShard);

    if (DRY_RUN) {
      console.log(`[dry] ${src} → ${destBlob} (${stat.size}B sha=${sha.slice(0, 12)}…)`);
      migrated++;
      continue;
    }

    if (!fs.existsSync(destBlob)) {
      fs.mkdirSync(path.dirname(destBlob), { recursive: true });
      const tmp = destBlob + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, destBlob);
    }

    insertStmt.run(
      ulid(),
      ORG_ID,
      USER_ID,
      `/files/${filename}`,
      filename,
      inferMime(filename),
      stat.size,
      sha,
      relativeShard,
      JSON.stringify({ migrated_from: src }),
    );
    migrated++;
  } catch (err) {
    console.error(`[fail] ${src}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}Migration complete: ${migrated} migrated, ${skipped} skipped, ${failed} failed (of ${files.length} total).`);
db.close();
process.exit(failed > 0 ? 1 : 0);

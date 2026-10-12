/**
 * SKILLRIGHTS #478 Phase 10 — local SkillRights manifest construction for
 * `quox skills protect`.
 *
 * The skill's CONTENT never leaves the machine: this builds the same
 * `.skillrights.manifest.json` the open `skillrights` CLI produces (per-file
 * SHA-256s plus a canonical-JSON hash of the core), and only that manifest
 * is sent to the collector.
 *
 * CONSUMES THE OPEN FORMAT, NEVER FORKS IT: if the open CLI has already
 * written a manifest in the directory, that file is used verbatim. The
 * builder below exists only so a user without the open CLI installed can
 * still protect a skill; its algorithm MUST stay byte-identical to
 * skillrights/cli/lib/sign.js + lib/hash.js (canonical JSON = recursively
 * sorted keys, no whitespace). The collector re-derives the hash from the
 * manifest core and rejects a mismatch, so drift fails loudly rather than
 * silently registering a hash nobody else can reproduce.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANIFEST_NAME = '.skillrights.manifest.json';
export const SIG_NAME = `${MANIFEST_NAME}.sig`;
const RECEIPT_NAME = '.skillrights.receipt.json';
const EXCLUDE_DIRS = new Set(['.git', 'node_modules']);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function walkFiles(rootDir, exclude) {
  const results = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      if (exclude.has(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) results.push(rel);
    }
  })(rootDir);
  results.sort();
  return results;
}

/**
 * Reads YAML-ish frontmatter from SKILL.md, matching the open CLI's parser
 * scope: a leading `---` block, `key: value` lines, optional quotes.
 */
export function readSkillFrontmatter(dir) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return fields;
}

/**
 * Returns { manifest, source } where source is 'existing' (written by the
 * open skillrights CLI) or 'computed' (built here, not written to disk).
 */
export function loadOrBuildManifest(dir) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) {
    return { manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), source: 'existing' };
  }

  const exclude = new Set([MANIFEST_NAME, SIG_NAME, RECEIPT_NAME]);
  const files = walkFiles(dir, exclude);
  if (files.length === 0) throw new Error(`No files to protect in ${dir}`);

  const fileHashes = {};
  for (const rel of files) {
    fileHashes[rel] = sha256Hex(fs.readFileSync(path.join(dir, rel)));
  }
  const front = readSkillFrontmatter(dir);
  const core = {
    version: 1,
    created: new Date().toISOString(),
    identifier: front.license || null,
    author: front.author || null,
    files: fileHashes,
  };
  return { manifest: { ...core, manifestSha256: sha256Hex(canonicalJSON(core)) }, source: 'computed' };
}

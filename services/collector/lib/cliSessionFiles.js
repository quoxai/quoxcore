'use strict';
/**
 * D2: Claude CLI session files on disk.
 *
 * The collector spawns `claude` with HOME = runtime home, so every CLI turn
 * writes HOME/.claude/projects/<cwd-slug>/<session-uuid>.jsonl (plus, for some
 * CLI versions, a <session-uuid>/ sidecar dir with sub-agent transcripts). Those
 * files hold the whole turn (prompts, tool calls, tool results) and used to live
 * forever with no org tag. chatSessionHistory.js now records which org + user
 * owns each session id; this module does the file side.
 *
 * Safety: deletes only inside `root` (the projects dir). Ids must be UUIDs (no
 * traversal, no globs), project slugs that are symlinks are never entered, and
 * every resolved path is checked to sit under the real root. dryRun counts
 * without deleting.
 */

const fs = require('fs');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function emptyCounts(dryRun) {
  return { files: 0, dirs: 0, bytes: 0, refused: 0, errors: 0, dryRun: !!dryRun };
}

function realRoot(root) {
  if (!root || typeof root !== 'string') return null;
  try {
    const r = fs.realpathSync(root);
    return fs.statSync(r).isDirectory() ? r : null;
  } catch { return null; }
}

function projectSlugs(rootReal) {
  try {
    return fs.readdirSync(rootReal, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => d.name);
  } catch { return []; }
}

function inside(rootReal, p) {
  const r = path.resolve(p);
  return r.startsWith(rootReal + path.sep);
}

/** Remove one session's file and sidecar dir in one slug dir. Mutates counts. */
function removeOne(rootReal, slug, id, counts) {
  const f = path.join(rootReal, slug, `${id}.jsonl`);
  const d = path.join(rootReal, slug, id);
  if (!inside(rootReal, f) || !inside(rootReal, d)) { counts.refused += 1; return; }
  try {
    const st = fs.lstatSync(f);
    if (st.isFile()) {
      counts.bytes += st.size;
      if (!counts.dryRun) fs.unlinkSync(f);
      counts.files += 1;
    }
  } catch (e) { if (e.code !== 'ENOENT') counts.errors += 1; }
  try {
    const st = fs.lstatSync(d);
    if (st.isDirectory()) {
      if (!counts.dryRun) fs.rmSync(d, { recursive: true, force: true });
      counts.dirs += 1;
    }
  } catch (e) { if (e.code !== 'ENOENT') counts.errors += 1; }
}

/**
 * Delete the files of these CLI session ids, in any project slug under root.
 * @returns {{files,dirs,bytes,refused,errors,dryRun,skipped?}}
 */
function deleteSessionFiles(ids, { root, dryRun = false } = {}) {
  const counts = emptyCounts(dryRun);
  const rootReal = realRoot(root);
  if (!rootReal) return { ...counts, skipped: root ? 'no_root_dir' : 'no_root' };
  const list = Array.from(new Set((ids || []).map((x) => String(x || ''))));
  const valid = [];
  for (const id of list) {
    if (UUID_RE.test(id)) valid.push(id); else counts.refused += 1;
  }
  if (!valid.length) return counts;
  const slugs = projectSlugs(rootReal);
  for (const id of valid) for (const slug of slugs) removeOne(rootReal, slug, id, counts);
  return counts;
}

/**
 * One-off sweep for files that predate the ownership table: delete session
 * files older than ttlMs (by mtime) whose id no table knows.
 */
function sweepOrphans({ root, ttlMs, isKnown, dryRun = false, now = Date.now() } = {}) {
  const counts = { ...emptyCounts(dryRun), scanned: 0, kept_known: 0, kept_young: 0 };
  const rootReal = realRoot(root);
  if (!rootReal) return { ...counts, skipped: root ? 'no_root_dir' : 'no_root' };
  if (!(ttlMs > 0)) return { ...counts, skipped: 'no_ttl' };
  const known = typeof isKnown === 'function' ? isKnown : () => true; // unknown predicate: delete nothing
  for (const slug of projectSlugs(rootReal)) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(rootReal, slug), { withFileTypes: true }); } catch { counts.errors += 1; continue; }
    for (const e of entries) {
      const m = e.isFile() ? SESSION_FILE_RE.exec(e.name) : null;
      if (!m) continue;
      counts.scanned += 1;
      let st;
      try { st = fs.lstatSync(path.join(rootReal, slug, e.name)); } catch { counts.errors += 1; continue; }
      if (now - st.mtimeMs <= ttlMs) { counts.kept_young += 1; continue; }
      let isK = true;
      try { isK = !!known(m[1]); } catch { isK = true; }
      if (isK) { counts.kept_known += 1; continue; }
      removeOne(rootReal, slug, m[1], counts);
    }
  }
  return counts;
}

function describeCounts(c) {
  if (c.skipped) return `skipped (${c.skipped})`;
  return `${c.dryRun ? 'DRY RUN, would delete' : 'deleted'} files=${c.files} dirs=${c.dirs} bytes=${c.bytes}${c.refused ? ` refused=${c.refused}` : ''}${c.errors ? ` errors=${c.errors}` : ''}${c.scanned != null ? ` scanned=${c.scanned} kept_known=${c.kept_known} kept_young=${c.kept_young}` : ''}`;
}

module.exports = { deleteSessionFiles, sweepOrphans, describeCounts, UUID_RE };

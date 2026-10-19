/**
 * feedSweep.js — resumable full-tree sweep + deletion reconciliation for the
 * folder / docs / obsidian feed sources (BRAIN2-W2 4).
 *
 * Two problems, one persisted per-source state:
 *
 *  1. TRAVERSAL CAP. The old walk stopped dead at MAX_WALK_ENTRIES (2000)
 *     entries, so a bigger tree was never fully covered. walkFolderPaged()
 *     walks in a deterministic order (sorted names, depth-first) and can
 *     resume after a cursor (the last relPath handled), so a big tree is
 *     covered across ticks, each tick bounded by the entry budget.
 *
 *  2. DELETIONS NEVER PROPAGATED. A manifest of every relPath seen in a
 *     COMPLETE, error-free pass is persisted (feed watermark store). When a
 *     later complete pass no longer sees a path, an explicit tombstone is sent
 *     (pushDeletions). Never on a partial, capped, or errored walk. A rename
 *     is delete + add. The first pass has no manifest, so it sends none.
 *
 * Small trees (one complete page, no pass in flight) keep the legacy
 * compound (mtime, relPath) watermark behaviour untouched. Only a tree that
 * needs more than one page switches to "multi-page" mode: the mtime
 * watermark is frozen for the whole pass (so file order cannot hide older
 * files on later pages), eligible files are capped per tick by walking only
 * as far as the cap, and when the pass completes the watermark moves to the
 * pass START time (idempotent re-pushes cover anything touched mid-pass).
 *
 * State lives in the feed watermark store under `<key>:walk` and
 * `<key>:manifest` (JSON strings). If no durable store is available the
 * sweep is disabled and callers fall back to the legacy walk.
 */

'use strict';

const path = require('path');
const feedWatermark = require('./feedWatermark.js');

const MAX_WALK_ENTRIES = 2000;

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Deterministic, resumable, budgeted walk.
 * @returns {{entries: Array, complete: boolean, errored: boolean, cursor: string|null}}
 *  complete: whole tree covered (after resumeAfter). errored: some dir/entry
 *  could not be read (or the root is missing), so the pass must not be used
 *  for deletions. cursor: last visited relPath when !complete.
 */
function walkFolderPaged(rootDir, fsImpl, { maxEntries = MAX_WALK_ENTRIES, extensions, ignoreDirs = [], resumeAfter = null } = {}) {
  const entries = [];
  const out = (complete, errored, cursor, rootError = false) => ({ entries, complete, errored, cursor, rootError });
  if (!fsImpl.existsSync(rootDir)) return out(false, true, resumeAfter, true);

  const canReal = typeof fsImpl.realpathSync === 'function';
  let rootReal = rootDir;
  if (canReal) {
    try { rootReal = fsImpl.realpathSync(rootDir); } catch { return out(false, true, resumeAfter, true); }
  }

  let errored = false;
  const readNames = (dir) => {
    try { return fsImpl.readdirSync(dir).slice().sort(); } catch { errored = true; return null; }
  };
  const rootNames = readNames(rootDir);
  if (!rootNames) return out(false, true, resumeAfter, true);

  const resumeSegs = resumeAfter ? String(resumeAfter).split('/') : null;
  const stack = [{ dir: rootDir, rel: '', names: rootNames, i: 0, constraint: resumeSegs }];
  let visited = 0;
  let lastVisited = null;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.i >= frame.names.length) { stack.pop(); continue; }
    if (visited >= maxEntries) return out(false, errored, lastVisited);

    const name = frame.names[frame.i++];
    const c = frame.constraint;
    let resumeSelf = false;
    let childConstraint = null;
    if (c) {
      if (name < c[0]) continue; // already covered by an earlier tick
      if (name === c[0]) {
        frame.constraint = null;
        if (c.length === 1) resumeSelf = true; // the cursor entry itself
        else childConstraint = c.slice(1); // an ancestor of the cursor
      } else {
        frame.constraint = null;
      }
    }

    const filePath = path.join(frame.dir, name);
    const relPath = frame.rel ? `${frame.rel}/${name}` : name;
    if (!resumeSelf && !childConstraint) { visited += 1; lastVisited = relPath; }

    let stat;
    try { stat = fsImpl.statSync(filePath); } catch { errored = true; continue; }

    if (canReal) {
      let real;
      try { real = fsImpl.realpathSync(filePath); } catch { errored = true; continue; }
      if (!isWithin(real, rootReal)) {
        console.warn(`[FeedSweep] skipping ${filePath}: symlink escapes root ${rootDir}`);
        continue;
      }
    }

    if (stat.isDirectory && stat.isDirectory()) {
      if (ignoreDirs.includes(name)) continue;
      const names = readNames(filePath);
      if (names) stack.push({ dir: filePath, rel: relPath, names, i: 0, constraint: childConstraint });
      continue;
    }
    if (resumeSelf || childConstraint) continue; // file already handled on an earlier tick

    const ext = path.extname(name).toLowerCase();
    if (extensions && !extensions.includes(ext)) continue;
    entries.push({
      filePath,
      relPath,
      mtimeIso: stat.mtime.toISOString(),
      sizeBytes: typeof stat.size === 'number' ? stat.size : 0,
    });
  }
  return out(true, errored, null);
}

/** Durable state store over the feed watermark table; null when unavailable. */
function defaultStore(dbPath) {
  return {
    get: (orgId, key) => feedWatermark.getWatermark(orgId, key, { dbPath }),
    set: (orgId, key, val) => feedWatermark.setWatermark(orgId, key, val, { dbPath }),
  };
}

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Plans one tick for one root.
 * @param {object} o
 * @param {{get:Function,set:Function}} o.store
 * @param {string} o.orgId
 * @param {string} o.key        watermark key of the source+root
 * @param {string} o.root
 * @param {object} o.fsImpl
 * @param {object} o.walkOpts   {extensions, ignoreDirs, maxEntries}
 * @param {number} o.maxFiles   cap on eligible files this tick
 * @param {string|null} o.storedWatermark  legacy mtime cursor
 * @param {number} o.maxFileBytes
 * @param {(rel:string)=>string} o.prefix  relPath -> brain rel_path
 * @returns {Promise<{entries, eligible, remaining, multiPage, finish: Function}>}
 */
async function planRoot(o) {
  const { store, orgId, key, root, fsImpl, walkOpts = {}, maxFiles, storedWatermark, maxFileBytes, prefix } = o;
  const walkKey = `${key}:walk`;
  const manifestKey = `${key}:manifest`;

  let st = null;
  try { st = parseJson(await store.get(orgId, walkKey)); } catch { st = null; }
  const startedAt = st?.passStart || new Date().toISOString();

  const page = walkFolderPaged(root, fsImpl, { ...walkOpts, resumeAfter: st?.cursor || null });
  if (page.rootError) {
    // Root missing/unreadable (unmounted drive?): never treat as "everything deleted".
    return { entries: [], eligible: [], remaining: [], multiPage: false, complete: false, finish: async () => ({ deleted: 0, error: null }) };
  }
  const multiPage = !!st?.cursor || !page.complete;
  // A path the previous complete pass never saw is owed even when its mtime is
  // old (a rename keeps mtime: it must arrive as delete + add). catchUp marks
  // those so callers do not move the mtime watermark backwards with them.
  const prevManifest = parseJson(await store.get(orgId, manifestKey));
  const prevSet = Array.isArray(prevManifest) ? new Set(prevManifest) : null;
  const isEligible = (e) => {
    if (e.sizeBytes > maxFileBytes) return false;
    if (feedWatermark.isAfterCursor(storedWatermark, e.mtimeIso, e.relPath)) return true;
    if (prevSet && !prevSet.has(e.relPath)) { e.catchUp = true; return true; }
    return false;
  };
  let deferredCatchUp = 0;
  const oversize = page.entries.filter((e) => e.sizeBytes > maxFileBytes).length;

  let entries = page.entries;
  let complete = page.complete;
  let cursor = page.cursor;
  let eligible;
  let remaining = [];
  let seen;
  const errored = !!(st?.errored || page.errored);

  if (!multiPage) {
    const all = entries
      .filter(isEligible)
      .sort((a, b) => feedWatermark.compareByTsId({ ts: a.mtimeIso, id: a.relPath }, { ts: b.mtimeIso, id: b.relPath }));
    eligible = all.slice(0, maxFiles);
    remaining = all.slice(maxFiles).filter((e) => !e.catchUp).map((e) => ({ ts: e.mtimeIso, id: e.relPath }));
    deferredCatchUp = all.slice(maxFiles).filter((e) => e.catchUp).length;
    seen = entries.map((e) => e.relPath);
  } else {
    eligible = [];
    let cutAt = -1;
    for (let i = 0; i < entries.length; i++) {
      if (isEligible(entries[i])) {
        eligible.push(entries[i]);
        if (eligible.length >= maxFiles) { cutAt = i; break; }
      }
    }
    if (cutAt >= 0 && cutAt < entries.length - 1) {
      entries = entries.slice(0, cutAt + 1);
      complete = false;
      cursor = entries[cutAt].relPath;
    }
    seen = (st?.seen || []).concat(entries.map((e) => e.relPath));
  }

  /**
   * Call AFTER the tick's push succeeded (or when there was nothing to push).
   * ctx: {ensureVault: async()=>vaultId|null, pushDeletionsFn, setWM: async(ts), dryRun}
   * @returns {Promise<{deleted:number, error:string|null}>}
   */
  async function finish(ctx) {
    const res = { deleted: 0, error: null };
    if (ctx.dryRun) return res;
    if (multiPage && !complete) {
      await store.set(orgId, walkKey, JSON.stringify({ cursor, seen, passStart: startedAt, errored }));
      return res;
    }
    if (multiPage) {
      try { await ctx.setWM(startedAt); } catch (err) { console.error(`[FeedSweep] org=${orgId}: watermark write failed, ${err.message}`); }
    }
    if (!errored) {
      const prev = prevManifest;
      const seenSet = new Set(seen);
      if (Array.isArray(prev)) {
        const gone = prev.filter((p) => !seenSet.has(p));
        if (gone.length > 0) {
          const vaultId = await ctx.ensureVault();
          if (!vaultId) { res.error = 'ensurePushVault returned no vaultId (tombstones not sent)'; return res; }
          const r = await ctx.pushDeletionsFn(orgId, vaultId, gone.map(prefix), ctx.pushOpts || {});
          if (r?.error) { res.error = `tombstones failed, ${r.error}`; return res; }
          res.deleted = gone.length;
        }
      }
      // Catch-up files cut by the per-tick cap are still owed: keep the old
      // manifest so they are detected as new again next tick.
      if (deferredCatchUp === 0) await store.set(orgId, manifestKey, JSON.stringify([...seenSet].sort()));
    }
    if (st) await store.set(orgId, walkKey, '');
    return res;
  }

  // BRAIN2-FABLE11: more work is owed beyond this batch (further walk pages, files
  // cut by the cap, or catch-up files deferred). The scheduler uses it to run
  // back-to-back catch-up batches instead of waiting a full cadence per page.
  const hasMore = (multiPage && !complete) || remaining.length > 0 || deferredCatchUp > 0;
  return { entries, eligible, remaining, multiPage, complete, oversize, hasMore, finish };
}

module.exports = { walkFolderPaged, planRoot, defaultStore, MAX_WALK_ENTRIES };

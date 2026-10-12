/**
 * feedDocsSource.js, The Feed's 'docs' ingester (catalog sourceType 'docs').
 *
 * Before this existed the catalog advertised "Docs & Markdown" but no
 * ingester was registered, so the source could never run on a schedule;
 * the only path was the hand-run services/quoxbrain/readers/docsReader.mjs.
 * This is the scheduled equivalent. It is NOT a dynamic import of that .mjs
 * (the collector image never COPYs services/quoxbrain); it reuses the
 * collector's own walkFolder()/resolveSafeFolderPath() from
 * feedFolderSource.js instead.
 *
 * Config (feed_sources.config, via PUT /api/feed/sources/docs):
 *   roots: string[]  absolute directories, walked recursively for .md
 *   path:  string    shorthand for a single root
 *   name:  string    vault name (default 'Quox Docs', same as docsReader)
 *
 * IDENTITY: relPath is `<rootBasename>/<path inside root>`. For a root of
 * `<repo>/docs` that is `docs/<file>.md`, byte-identical to docsReader.mjs's
 * repo-relative scheme, so the manual reader and this source converge on
 * the same notes in the 'Quox Docs' vault instead of duplicating (the
 * git reader/feed duplicate bug, 2026-10-05). Idempotency is the brain's
 * server-side per-relPath content-hash skip; on top of that a per-root
 * mtime watermark keeps unchanged trees from being re-read every tick.
 * Same safety floor as folder sources (absolute, no `..`, optional
 * FEED_FOLDER_ALLOWED_ROOTS).
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const realFs = require('fs');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const { walkFolder, resolveSafeFolderPath, MAX_FILE_BYTES } = require('./feedFolderSource.js');
const { probeDir } = require('./feedDirProbe');
const feedSweep = require('./feedSweep.js');
const feedBatchSupport = require('./feedBatchSupport.js');

const SOURCE_TYPE = 'docs';
const DEFAULT_VAULT_NAME = 'Quox Docs';
const DEFAULT_MAX_FILES = 200;
const IGNORE_DIRS = ['.obsidian', '.trash', 'node_modules', '.git'];

function watermarkKeyForRoot(root) {
  const hash = crypto.createHash('sha1').update(String(root)).digest('hex').slice(0, 12);
  return `${SOURCE_TYPE}:${hash}`;
}

function resolveRoots(config) {
  const roots = [];
  if (Array.isArray(config?.roots)) roots.push(...config.roots);
  if (config?.path) roots.push(config.path);
  return [...new Set(roots.filter((r) => typeof r === 'string' && r))];
}

/**
 * BRAIN2-W5 037: the rel_path prefix for a root. The plain basename is kept
 * whenever it is unique among the configured roots (so a single-root config,
 * and every non-colliding multi-root config, keeps byte-identical rel_paths).
 * Roots that SHARE a basename each get a short root-hash suffix so
 * `/a/docs/x.md` and `/b/docs/x.md` can no longer overwrite one note.
 */
function prefixesForRoots(roots) {
  const counts = new Map();
  for (const r of roots) counts.set(path.basename(r), (counts.get(path.basename(r)) || 0) + 1);
  const out = new Map();
  for (const r of roots) {
    const base = path.basename(r);
    out.set(r, counts.get(base) > 1 ? `${base}-${crypto.createHash('sha1').update(String(r)).digest('hex').slice(0, 6)}` : base);
  }
  return out;
}

/**
 * @returns {Promise<{filesRead:number, docsPushed:number, skipped:string|null, error:string|null}>}
 */
async function ingestDocs(orgId, opts = {}, deps = {}) {
  const result = { filesRead: 0, docsPushed: 0, skipped: null, error: null };

  // BRAIN2-W12 B1: honour the stored scope. A private (user) source needs an owner
  // and must never fall through to an org-visible vault.
  const vaultScope = opts.scope === 'user' ? 'user' : 'org';
  if (vaultScope === 'user' && !deps.userId) {
    result.skipped = 'user scope requires a user';
    return result;
  }
  const config = opts.config || null;

  const rawRoots = resolveRoots(config);
  if (rawRoots.length === 0) {
    result.skipped = 'no roots';
    return result;
  }

  const {
    fs: fsImpl = realFs,
    getWatermarkFn,
    setWatermarkFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    stateStore,
    fetchImpl,
    userId,
    dbPath,
  } = deps;
  // Resumable sweep + tombstones need a durable state store (see feedSweep.js).
  const sweepStore = stateStore || ((dbPath || !getWatermarkFn) ? feedSweep.defaultStore(dbPath) : null);

  // BRAIN2-W7 A 039: the scheduler's generic per-tick cap (opts.maxItems) bounds
  // the reader too; a stricter source-level config.maxFiles still applies.
  const maxFiles = Math.min(config?.maxFiles || DEFAULT_MAX_FILES, Number.isFinite(opts.maxItems) && opts.maxItems > 0 ? opts.maxItems : Infinity);
  const dryRun = !!opts.dryRun;
  const guardStore = sweepStore || feedBatchSupport.resolveStateStore(deps, !!getWatermarkFn);
  const safeRoots = [];
  for (const rawRoot of rawRoots) {
    const g = resolveSafeFolderPath(rawRoot, { orgId });
    if (g.ok) safeRoots.push(g.path);
  }
  const prefixes = prefixesForRoots([...new Set(safeRoots)]);
  const docs = [];
  const advances = []; // { root, ts }, applied only after a successful push
  const plans = []; // sweep plans, finished only after a successful push

  for (const rawRoot of rawRoots) {
    const guard = resolveSafeFolderPath(rawRoot, { orgId });
    if (!guard.ok) {
      console.error(`[FeedDocsSource] org=${orgId}: skipping root ${rawRoot}, ${guard.error}`);
      continue;
    }
    const root = guard.path;
    const key = watermarkKeyForRoot(root);
    const getWM = getWatermarkFn || ((org) => feedWatermark.getWatermark(org, key, { dbPath }));

    let stored = null;
    try {
      stored = await getWM(orgId, root);
    } catch (err) {
      console.error(`[FeedDocsSource] org=${orgId}: watermark read failed for ${root}, ${err.message}`);
    }

    const probe = probeDir(root, fsImpl);
    if (probe.state === 'denied' || probe.state === 'error') {
      result.error = probe.error;
      console.error(`[FeedDocsSource] org=${orgId}: ${probe.error}`);
      continue;
    }

    const base = prefixes.get(root) || path.basename(root);
    const room = Math.max(0, maxFiles - docs.length);
    let eligible;
    let remaining;
    let plan = null;
    if (sweepStore) {
      try {
        plan = await feedSweep.planRoot({
          store: sweepStore, orgId, key, root, fsImpl,
          walkOpts: { extensions: ['.md'], ignoreDirs: IGNORE_DIRS }, maxFiles: room, storedWatermark: stored,
          maxFileBytes: MAX_FILE_BYTES, prefix: (rel) => `${base}/${rel}`,
        });
      } catch (err) {
        result.error = `walk failed, ${err.message}`;
        continue;
      }
      plans.push({ plan, root, key });
      if (plan.oversize) result.oversize = (result.oversize || 0) + plan.oversize;
      eligible = plan.eligible;
      remaining = plan.remaining;
    } else {
      let entries;
      try {
        entries = walkFolder(root, fsImpl, { extensions: ['.md'], ignoreDirs: IGNORE_DIRS });
      } catch (err) {
        result.error = `walk failed, ${err.message}`;
        continue;
      }
      // Compound (mtime, relPath) cursor, see feedFolderSource.js (BRAIN2-V3 A4).
      const allEligible = entries
        .filter((e) => feedWatermark.isAfterCursor(stored, e.mtimeIso, e.relPath) && e.sizeBytes <= MAX_FILE_BYTES)
        .sort((a, b) => feedWatermark.compareByTsId({ ts: a.mtimeIso, id: a.relPath }, { ts: b.mtimeIso, id: b.relPath }));
      const oversizeCount = entries.filter((e) => e.sizeBytes > MAX_FILE_BYTES).length;
      if (oversizeCount) result.oversize = (result.oversize || 0) + oversizeCount;
      eligible = allEligible.slice(0, room);
      remaining = allEligible.slice(room).map((e) => ({ ts: e.mtimeIso, id: e.relPath }));
    }
    const processed = [];
    const failGuard = await feedBatchSupport.createFailureGuard(guardStore, orgId, key);
    let held = false; // first failed read: later files still push, the cursor/sweep does not move past it
    for (const entry of eligible) {
      try {
        const content = fsImpl.readFileSync(entry.filePath, 'utf8');
        const relPath = `${base}/${entry.relPath}`;
        docs.push({
          relPath,
          content,
          kind: 'note',
          sourceType: SOURCE_TYPE,
          occurredAt: entry.mtimeIso,
          originStore: 'files',
          originId: relPath,
        });
        result.filesRead++;
        failGuard.clear(entry.relPath);
        if (!entry.catchUp && !held) processed.push({ ts: entry.mtimeIso, id: entry.relPath });
      } catch (err) {
        // BRAIN2-W5 026: hold at the first failure so it is retried; after
        // repeated failures it is passed over (loudly) so it cannot pin the root.
        const n = failGuard.record(entry.relPath);
        console.error(`[FeedDocsSource] org=${orgId}: ${entry.relPath} failed (${n}/${feedBatchSupport.MAX_ITEM_ATTEMPTS}), ${err.message}`);
        if (failGuard.shouldSkip(entry.relPath)) { if (!entry.catchUp && !held) processed.push({ ts: entry.mtimeIso, id: entry.relPath }); continue; }
        held = true;
        result.error = result.error || `read ${entry.relPath} failed, ${err.message}`;
      }
    }
    await failGuard.flush();
    if (held && plan) plans.pop(); // an unfinished sweep (no manifest/walk state/watermark move) is re-walked and retried
    const remainingOwed = held
      ? eligible.filter((e) => !e.catchUp && !processed.some((p) => p.id === e.relPath)).map((e) => ({ ts: e.mtimeIso, id: e.relPath })).concat(remaining)
      : remaining;
    const newest = feedWatermark.nextCursor(processed, remainingOwed);
    if (!(plan && plan.multiPage) && newest && newest !== stored) advances.push({ key, root, ts: newest });
    if (docs.length >= maxFiles) break;
  }

  if (dryRun) return result;

  const vaultName = config.name || DEFAULT_VAULT_NAME;
  const ensureVault = async () => ensurePushVaultFn(orgId, vaultName, { scope: vaultScope, userId, fetchImpl });
  const finishPlans = async () => {
    for (const { plan, root, key } of plans) {
      const setWM = (ts) => (setWatermarkFn ? setWatermarkFn(orgId, root, ts) : feedWatermark.setWatermark(orgId, key, ts, { dbPath }));
      const r = await plan.finish({ ensureVault, pushDeletionsFn, pushOpts: { userId, fetchImpl }, setWM, dryRun });
      if (r.deleted > 0) result.deleted = (result.deleted || 0) + r.deleted;
      if (r.error) { result.error = r.error; console.error(`[FeedDocsSource] org=${orgId}: ${r.error}`); }
    }
  };

  if (docs.length === 0) { await finishPlans(); return result; }

  try {
    const vaultId = await ensureVault();
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      return result;
    }
    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      return result;
    }
    result.docsPushed = docs.length;
    for (const { key, root, ts } of advances) {
      try {
        if (setWatermarkFn) await setWatermarkFn(orgId, root, ts);
        else feedWatermark.setWatermark(orgId, key, ts, { dbPath });
      } catch (err) {
        console.error(`[FeedDocsSource] org=${orgId}: watermark write failed for ${root}, ${err.message}`);
      }
    }
    await finishPlans();
  } catch (err) {
    result.error = `push failed, ${err.message}`;
    console.error(`[FeedDocsSource] org=${orgId}: ${result.error}`);
  }
  return result;
}

module.exports = { ingestDocs, resolveRoots, watermarkKeyForRoot, SOURCE_TYPE, DEFAULT_VAULT_NAME, DEFAULT_MAX_FILES };

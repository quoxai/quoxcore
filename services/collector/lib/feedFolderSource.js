/**
 * feedFolderSource.js — The Feed's Phase C "connect a folder" ingester
 * (docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase C,
 *  docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md "connect, don't configure").
 *
 * Kills the hardcoded-path hole for the general case: instead of a single
 * ENV-configured directory (feedTranscriptSource.js's old TRANSCRIPT_DIR),
 * a user CONNECTS a folder — the path lives in that org's `feed_sources`
 * row (`config.path`, written via PUT /api/feed/sources/folder) and
 * feedScheduler.js hands it to this ingester every tick. No config, no
 * ingestion — see the required-path guard below.
 *
 * PATH SAFETY GUARD — read before touching resolveSafeFolderPath(): a
 * `feed_sources.config` row is admin-written but still caller-supplied
 * data; without a guard a connected "folder" could point at any path the
 * collector process can read. The floor (always enforced, no env needed):
 * the path must be a non-empty absolute string with no `..` traversal
 * segment. Defense-in-depth: if FEED_FOLDER_ALLOWED_ROOTS (CSV of absolute
 * prefixes) is set, the path must additionally resolve under one of those
 * roots — mirrors services/quoxbrain/lib/vaultRoot.js's allow-list
 * pattern, sized down for the collector (no per-org DB grants table here;
 * that's the quoxbrain vault's own concern).
 *
 * WATERMARK-PER-PATH — a single `source_type` key ('folder') would make
 * every connected folder share one cursor, so two folders (or the same
 * folder reconnected under a different config) would clobber each other's
 * high-water mark. Every watermark read/write here is keyed by
 * `folder:<sha1(path)-first12>`, not the bare 'folder' string — see
 * watermarkKeyForPath().
 *
 * Bounded, best-effort, incremental — mirrors feedTranscriptSource.js:
 * watermarked by file mtime, one try/catch per file (a single unreadable
 * file never aborts the batch), a hard cap on directory-entries visited
 * per tick (MAX_WALK_ENTRIES) so a pathologically large tree can't turn
 * into a synchronous full-scan, and a per-file byte cap (oversized files
 * are skipped, never read into memory).
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const realFs = require('fs');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const feedSweep = require('./feedSweep.js');

const SOURCE_TYPE = 'folder';
const ALLOWED_EXTENSIONS = ['.md', '.markdown', '.txt'];
const DEFAULT_MAX_FILES = 50;
// Bounds the directory walk itself (not just the result set) — a tree with
// hundreds of thousands of entries stops contributing new files past this
// budget rather than blocking the tick synchronously walking it all.
const MAX_WALK_ENTRIES = 2000;
// Per-file cap — same rationale as feedTranscriptSource.js's MAX_NOTE_BYTES:
// an oversized file is skipped entirely (never readFileSync'd), not
// truncated after the fact.
const MAX_FILE_BYTES = 150 * 1024;
// Durable read-failure retries (BRAIN2-W10 A). A file that cannot be read while
// a newer sibling succeeds would otherwise be passed by the cursor forever.
const MAX_READ_ATTEMPTS = 6;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_CAP_MS = 60 * 60 * 1000;
const retryBackoffMs = (attempts) => Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));

/**
 * Derives a short, stable, path-specific watermark key so two different
 * connected folders (or the same source_type reconnected at a new path)
 * never share a cursor. Deliberately NOT reversible/guessable-sensitive —
 * this is just a cursor key, not a secret.
 */
function watermarkKeyForPath(rawPath) {
  const hash = crypto.createHash('sha1').update(String(rawPath)).digest('hex').slice(0, 12);
  return `${SOURCE_TYPE}:${hash}`;
}

/**
 * Parses FEED_FOLDER_ALLOWED_ROOTS (CSV) into entries. Two entry shapes:
 *   `<orgId>:<absolute path>`  org-specific root, usable ONLY by that org
 *   `<absolute path>`          bare "instance" root (see rootsForOrg)
 * Anything else (relative path, empty org id) is dropped, so a typo fails
 * closed rather than widening the allow-list.
 *
 * @returns {Array<{orgId: string|null, root: string}>}
 */
function parseAllowedRootEntries(raw = process.env.FEED_FOLDER_ALLOWED_ROOTS) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split(',').map((r) => r.trim()).filter(Boolean)) {
    if (part.startsWith('/')) { out.push({ orgId: null, root: part }); continue; }
    const m = /^([A-Za-z0-9_-]+):(\/.*)$/.exec(part);
    if (m) out.push({ orgId: m[1], root: m[2] });
  }
  return out;
}

/** Number of feed orgs on this instance (QUOXFEED_ORGS, CSV). */
function instanceOrgCount() {
  return String(process.env.QUOXFEED_ORGS || '').split(',').map((s) => s.trim()).filter(Boolean).length;
}

/**
 * The roots that apply to one caller. Org-specific entries apply only to
 * their own org. Bare entries are instance roots: they apply only to
 * service-key callers (ctx.service === true) or when the instance has
 * explicit FEED_FOLDER_SINGLE_TENANT=1 with at most one QUOXFEED_ORGS id.
 * Otherwise a bare root is never usable by a tenant, so tenant A cannot
 * reach tenant B's directory under a shared root.
 *
 * @param {{orgId?: string, service?: boolean}} [ctx]
 * @returns {string[]}
 */
function rootsForOrg(ctx = {}) {
  const entries = parseAllowedRootEntries();
  // Fail closed (BRAIN2-W10 A): one SCHEDULED org does not mean one tenant, so a
  // tenant may use a bare root only when the operator says single-tenant outright.
  const bareOk = ctx.service === true
    || (process.env.FEED_FOLDER_SINGLE_TENANT === '1' && instanceOrgCount() <= 1);
  return entries
    .filter((e) => (e.orgId === null ? bareOk : (!!ctx.orgId && e.orgId === ctx.orgId)))
    .map((e) => e.root);
}

/**
 * The path-safety floor for a connected folder: non-empty, absolute, no
 * `..` traversal segment. If FEED_FOLDER_ALLOWED_ROOTS is set the path must
 * also fall under a root that applies to `ctx` (see rootsForOrg), checked
 * lexically and, when the path exists, by realpath (symlink escape). Unset
 * env = floor only (dev-box convenience). Runtime ingesters MUST pass
 * `{orgId}` so already-stored configs get the same per-org rule as the API.
 *
 * @param {string} rawPath
 * @param {{orgId?: string, service?: boolean}} [ctx]
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
function resolveSafeFolderPath(rawPath, ctx = {}, fsImpl = realFs) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { ok: false, error: 'path is required' };
  }
  if (!path.isAbsolute(rawPath)) {
    return { ok: false, error: 'path must be absolute' };
  }
  const segments = rawPath.split(path.sep);
  if (segments.includes('..')) {
    return { ok: false, error: 'path traversal (..) is not allowed' };
  }

  // Codex cycle 5 F1: no allow-list means no host folder access at all. This
  // guard runs at READ time for saved sources, so it must fail closed itself
  // rather than rely on the config-time API check.
  if (!String(process.env.FEED_FOLDER_ALLOWED_ROOTS || '').trim()) {
    return { ok: false, error: 'host folder sources are disabled: no allow-list configured (FEED_FOLDER_ALLOWED_ROOTS unset)' };
  }
  {
    const allowedRoots = rootsForOrg(ctx);
    const withinAllowed = allowedRoots.some((root) => isWithin(rawPath, root));
    let realOk = true;
    if (withinAllowed) {
      let real = null;
      try { real = fsImpl.realpathSync(rawPath); } catch { /* not on disk: lexical check stands */ }
      if (real) {
        realOk = allowedRoots.some((root) => {
          let r = root;
          try { r = fsImpl.realpathSync(root); } catch { /* keep as given */ }
          return isWithin(real, r);
        });
      }
    }
    if (!withinAllowed || !realOk) {
      return { ok: false, error: `path is outside the configured allow-list (FEED_FOLDER_ALLOWED_ROOTS)` };
    }
  }

  return { ok: true, path: rawPath };
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * Realpath'd roots applicable to `ctx` (see rootsForOrg). Empty when unset.
 */
function getAllowedRoots(fsImpl = realFs, ctx = {}) {
  return rootsForOrg(ctx).map((r) => {
    try { return fsImpl.realpathSync(r); } catch { return r; }
  });
}

/**
 * True when `rawPath` resolves (fs.realpath, following symlinks) inside one
 * of the roots applicable to `ctx`. Fails closed: no applicable roots =>
 * false; path does not exist => false.
 */
function isPathInAllowedRoots(rawPath, fsImpl = realFs, ctx = {}) {
  const roots = getAllowedRoots(fsImpl, ctx);
  if (roots.length === 0) return false;
  let real;
  try { real = fsImpl.realpathSync(rawPath); } catch { return false; }
  return roots.some((root) => isWithin(real, root));
}

/**
 * Iteratively (never recursively — no call-stack depth risk on a deep
 * tree) walks `rootDir` for files matching ALLOWED_EXTENSIONS, bounded by
 * `maxEntries` directory entries visited (files AND directories both
 * count against the budget) so a huge tree stops contributing new results
 * rather than blocking the tick indefinitely. `fsImpl` is injectable
 * (existsSync/readdirSync/statSync) for tests. `ignoreDirs` (default [])
 * names directories (by basename, e.g. '.git') that are never pushed onto
 * the walk stack, so a caller can keep tool folders (like Obsidian's
 * `.obsidian`) out of the budget entirely.
 *
 * @returns {Array<{filePath: string, relPath: string, mtimeIso: string, sizeBytes: number}>}
 */
function walkFolder(rootDir, fsImpl, { maxEntries = MAX_WALK_ENTRIES, extensions = ALLOWED_EXTENSIONS, ignoreDirs = [] } = {}) {
  const results = [];
  if (!fsImpl.existsSync(rootDir)) return results;

  // Symlink containment (BRAIN2-V3 A1): every entry's realpath must stay
  // inside the configured root's realpath. Skipped only when the injected
  // fs has no realpathSync (pure-fake test fs).
  const canReal = typeof fsImpl.realpathSync === 'function';
  let rootReal = rootDir;
  if (canReal) {
    try { rootReal = fsImpl.realpathSync(rootDir); } catch { return results; }
  }

  let visited = 0;
  const stack = [{ dir: rootDir, rel: '' }];

  while (stack.length > 0) {
    if (visited >= maxEntries) break;
    const { dir, rel } = stack.pop();

    let names;
    try {
      names = fsImpl.readdirSync(dir);
    } catch {
      continue; // unreadable directory — skip, never abort the whole walk
    }

    for (const name of names) {
      if (visited >= maxEntries) break;
      visited += 1;

      const filePath = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;

      let stat;
      try {
        stat = fsImpl.statSync(filePath);
      } catch {
        continue; // unreadable entry — skip
      }

      if (canReal) {
        let real;
        try { real = fsImpl.realpathSync(filePath); } catch { continue; }
        if (!isWithin(real, rootReal)) {
          console.warn(`[FeedFolderSource] skipping ${filePath}: symlink escapes root ${rootDir}`);
          continue;
        }
      }

      if (stat.isDirectory && stat.isDirectory()) {
        if (ignoreDirs.includes(name)) continue; // e.g. '.obsidian', '.trash' — never walked
        stack.push({ dir: filePath, rel: relPath });
        continue;
      }

      const ext = path.extname(name).toLowerCase();
      if (!extensions.includes(ext)) continue;

      results.push({
        filePath,
        relPath,
        mtimeIso: stat.mtime.toISOString(),
        sizeBytes: typeof stat.size === 'number' ? stat.size : 0,
      });
    }
  }

  return results;
}

/**
 * Ingests `.md`/`.markdown`/`.txt` files (recursive, bounded) under a
 * CONNECTED folder — `opts.config.path`, written via the feed_sources
 * registry, not an env var. No path, no ingestion (`{skipped:'no path'}`);
 * an unsafe path is likewise skipped, never read.
 *
 * @param {string} orgId
 * @param {{maxItems?: number, config?: {path: string, name?: string}, dryRun?: boolean}} [opts]
 * @param {{
 *   fs?: object,                     // injectable fs-shaped module (tests)
 *   walk?: Function,                 // (rootDir, fsImpl) => entries[] (tests)
 *   getWatermarkFn?: Function,       // (orgId) => string|null
 *   setWatermarkFn?: Function,       // (orgId, ts) => void
 *   ensurePushVaultFn?: Function,    // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,      // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,            // forwarded to the brain client (test injection)
 *   userId?: string,
 *   dbPath?: string,                 // forwarded to feedWatermark (tests)
 * }} [deps]
 * @returns {Promise<{filesRead: number, docsPushed: number, skipped: string|null, error: string|null}>}
 */
async function ingestFolder(orgId, opts = {}, deps = {}) {
  const result = { filesRead: 0, docsPushed: 0, skipped: null, error: null };

  // BRAIN2-W12 B1: honour the stored scope. A private (user) source needs an owner
  // and must never fall through to an org-visible vault.
  const vaultScope = opts.scope === 'user' ? 'user' : 'org';
  if (vaultScope === 'user' && !deps.userId) {
    result.skipped = 'user scope requires a user';
    return result;
  }

  const config = opts.config || null;
  const rawPath = config?.path;
  if (!rawPath) {
    result.skipped = 'no path';
    return result;
  }

  const guard = resolveSafeFolderPath(rawPath, { orgId });
  if (!guard.ok) {
    result.skipped = `unsafe path — ${guard.error}`;
    console.error(`[FeedFolderSource] org=${orgId}: ${result.skipped} (raw: ${rawPath})`);
    return result;
  }

  const {
    fs: fsImpl = realFs,
    walk,
    getWatermarkFn,
    setWatermarkFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    stateStore,
    fetchImpl,
    userId,
    dbPath,
    nowMs = Date.now(),
  } = deps;
  // Resumable sweep + tombstones need a durable state store; tests that inject
  // only a watermark fn (no dbPath/stateStore) keep the legacy single-walk path.
  const sweepStore = stateStore || ((dbPath || !getWatermarkFn) ? feedSweep.defaultStore(dbPath) : null);

  const watermarkKey = watermarkKeyForPath(guard.path);
  const getWM = getWatermarkFn || ((org) => feedWatermark.getWatermark(org, watermarkKey, { dbPath }));
  const setWM = setWatermarkFn || ((org, ts) => feedWatermark.setWatermark(org, watermarkKey, ts, { dbPath }));

  const maxFiles = opts.maxItems ?? DEFAULT_MAX_FILES;
  const dryRun = !!opts.dryRun;

  let storedWatermark = null;
  try {
    storedWatermark = await getWM(orgId);
  } catch (err) {
    console.error(`[FeedFolderSource] org=${orgId}: watermark read failed, treating as no watermark — ${err.message}`);
  }

  let plan = null;
  let eligible;
  let remaining;
  if (sweepStore && typeof walk !== 'function') {
    try {
      plan = await feedSweep.planRoot({
        store: sweepStore, orgId, key: watermarkKey, root: guard.path, fsImpl,
        walkOpts: { extensions: ALLOWED_EXTENSIONS }, maxFiles, storedWatermark,
        maxFileBytes: MAX_FILE_BYTES, prefix: (rel) => `folder/${rel}`,
      });
    } catch (err) {
      result.error = `walk failed — ${err.message}`;
      console.error(`[FeedFolderSource] org=${orgId}: ${result.error}`);
      return result;
    }
    eligible = plan.eligible;
    remaining = plan.remaining;
    if (plan.oversize) result.oversize = plan.oversize;
  } else {
    let entries = [];
    try {
      entries = typeof walk === 'function' ? (await walk(guard.path, fsImpl)) || [] : walkFolder(guard.path, fsImpl);
    } catch (err) {
      result.error = `walk failed — ${err.message}`;
      console.error(`[FeedFolderSource] org=${orgId}: ${result.error}`);
      return result;
    }

    // Strictly-after (mtime) + size cap: oversized files never make it into
    // the eligible set, so they're never read.
    // Compound (mtime, relPath) cursor: files tied on mtime beyond the cap are
    // owed to the next tick, not lost (BRAIN2-V3 A4).
    const allEligible = entries
      .filter((e) => feedWatermark.isAfterCursor(storedWatermark, e.mtimeIso, e.relPath) && e.sizeBytes <= MAX_FILE_BYTES)
      .sort((a, b) => feedWatermark.compareByTsId({ ts: a.mtimeIso, id: a.relPath }, { ts: b.mtimeIso, id: b.relPath }));
    const oversizeCount = entries.filter((e) => e.sizeBytes > MAX_FILE_BYTES).length;
    if (oversizeCount) result.oversize = oversizeCount;
    eligible = allEligible.slice(0, maxFiles);
    remaining = allEligible.slice(maxFiles).map((e) => ({ ts: e.mtimeIso, id: e.relPath }));
  }

  const vaultName = config.name || `Folder: ${path.basename(guard.path)}`;
  const ensureVault = async () => ensurePushVaultFn(orgId, vaultName, { scope: vaultScope, userId, fetchImpl });
  const finishSweep = async () => {
    if (!plan) return;
    const r = await plan.finish({ ensureVault, pushDeletionsFn, pushOpts: { userId, fetchImpl }, setWM: (ts) => setWM(orgId, ts), dryRun });
    if (r.deleted > 0) result.deleted = r.deleted;
    if (r.error) { result.error = r.error; console.error(`[FeedFolderSource] org=${orgId}: ${r.error}`); }
  };

  // Durable retry list: relPath -> {attempts, nextAt, lastError}. Only with a
  // durable store (legacy injected-watermark path keeps single-pass behaviour).
  const retryKey = `${watermarkKey}:retry`;
  let retryState = {};
  let retryDirty = false;
  if (sweepStore) {
    try {
      const raw = await sweepStore.get(orgId, retryKey);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) retryState = parsed;
    } catch (err) {
      console.error(`[FeedFolderSource] org=${orgId}: retry state read failed, ${err.message}`);
    }
    const have = new Set(eligible.map((e) => e.relPath));
    for (const [rel, info] of Object.entries(retryState)) {
      if (have.has(rel) || (info.nextAt || 0) > nowMs) continue;
      const filePath = path.join(guard.path, rel);
      try {
        const st = fsImpl.statSync(filePath);
        if (st.isFile && !st.isFile()) throw new Error('not a file');
        // catchUp: never moves the mtime cursor backwards
        eligible = eligible.concat([{ filePath, relPath: rel, mtimeIso: st.mtime.toISOString(), sizeBytes: st.size || 0, catchUp: true, retry: true }]);
        result.retried = (result.retried || 0) + 1;
      } catch {
        // file gone: retire quietly (deletion is the tombstone path's concern)
        delete retryState[rel]; retryDirty = true;
      }
    }
  }
  const saveRetry = async () => {
    if (!sweepStore || !retryDirty || dryRun) return;
    try { await sweepStore.set(orgId, retryKey, JSON.stringify(retryState)); }
    catch (err) { console.error(`[FeedFolderSource] org=${orgId}: retry state write failed, ${err.message}`); }
  };

  if (eligible.length === 0) { await saveRetry(); await finishSweep(); return result; }

  const docs = [];
  const processed = [];
  const readOk = [];

  // Read-time containment (BRAIN2-W12 A): first attempts AND retries resolve the
  // realpath now, require it inside the connected root (and the org's allowed
  // roots when configured), then read the REALPATH (not the swappable path).
  const canReal = typeof fsImpl.realpathSync === 'function';
  let rootReal = guard.path;
  if (canReal) { try { rootReal = fsImpl.realpathSync(guard.path); } catch { /* read will fail below */ } }
  const allowedReal = process.env.FEED_FOLDER_ALLOWED_ROOTS ? getAllowedRoots(fsImpl, { orgId }) : null;
  const readContained = (filePath) => {
    if (!canReal) return fsImpl.readFileSync(filePath, 'utf8');
    const real = fsImpl.realpathSync(filePath);
    if (!isWithin(real, rootReal) || (allowedReal && !allowedReal.some((r) => isWithin(real, r)))) {
      const e = new Error(`symlink escapes root ${guard.path}`);
      e.code = 'EFEEDESCAPE';
      throw e;
    }
    return fsImpl.readFileSync(real, 'utf8');
  };

  for (const entry of eligible) {
    try {
      const content = readContained(entry.filePath);
      const title = path.basename(entry.relPath).replace(/\.(md|markdown|txt)$/i, '');
      docs.push({
        relPath: `folder/${entry.relPath}`,
        content,
        title,
        kind: 'folder_note',
        sourceType: SOURCE_TYPE,
        occurredAt: entry.mtimeIso,
      });
      result.filesRead++;
      readOk.push(entry.relPath);
      if (entry.mtimeIso && !entry.catchUp) processed.push({ ts: entry.mtimeIso, id: entry.relPath });
    } catch (err) {
      if (err && err.code === 'EFEEDESCAPE') {
        // Never ingest, never retry: retire loudly.
        console.error(`[FeedFolderSource] org=${orgId}: RETIRED ${entry.relPath}, ${err.message} (escapes root, not ingested)`);
        result.escaped = (result.escaped || 0) + 1;
        if (retryState[entry.relPath]) { delete retryState[entry.relPath]; result.retired = (result.retired || 0) + 1; retryDirty = true; }
        continue;
      }
      result.readFailures = (result.readFailures || 0) + 1; // distinct from empty results
      const prev = retryState[entry.relPath];
      const attempts = (prev?.attempts || 0) + 1;
      if (attempts >= MAX_READ_ATTEMPTS) {
        console.error(`[FeedFolderSource] org=${orgId}: RETIRED ${entry.relPath} after ${attempts} failed reads, giving up — ${err.message}`);
        delete retryState[entry.relPath];
        result.retired = (result.retired || 0) + 1;
      } else {
        console.error(`[FeedFolderSource] org=${orgId}: read failed ${entry.relPath} (attempt ${attempts}/${MAX_READ_ATTEMPTS}), will retry — ${err.message}`);
        retryState[entry.relPath] = { attempts, nextAt: nowMs + retryBackoffMs(attempts), lastError: String(err.message).slice(0, 200) };
      }
      retryDirty = true;
    }
  }

  if (docs.length === 0) { await saveRetry(); await finishSweep(); return result; }
  const newWatermark = feedWatermark.nextCursor(processed, remaining);

  if (dryRun) return result; // tallies filesRead, pushes/advances nothing

  try {
    const vaultId = await ensureVault();
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedFolderSource] org=${orgId}: ${result.error} — not advancing watermark`);
      await saveRetry();
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedFolderSource] org=${orgId}: push failed — ${pushResult.error} — not advancing watermark`);
      await saveRetry();
      return result;
    }

    result.docsPushed = docs.length;
    for (const rel of readOk) if (retryState[rel]) { delete retryState[rel]; retryDirty = true; }
    await saveRetry();

    if (!(plan && plan.multiPage) && newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWM(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedFolderSource] org=${orgId}: watermark write failed — ${err.message}`);
      }
    }
    await finishSweep();
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedFolderSource] org=${orgId}: ${result.error} — not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestFolder,
  resolveSafeFolderPath,
  walkFolder,
  watermarkKeyForPath,
  SOURCE_TYPE,
  ALLOWED_EXTENSIONS,
  getAllowedRoots,
  parseAllowedRootEntries,
  rootsForOrg,
  instanceOrgCount,
  isPathInAllowedRoots,
  DEFAULT_MAX_FILES,
  MAX_READ_ATTEMPTS,
  MAX_WALK_ENTRIES,
  MAX_FILE_BYTES,
};

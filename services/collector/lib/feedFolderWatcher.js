/**
 * feedFolderWatcher.js: near-real-time ingestion for FOLDER and OBSIDIAN
 * sources (BRAIN2-FABLE11).
 *
 * The scheduler polls every 30 minutes, so a note saved in a connected folder
 * used to be unsearchable for up to 30 minutes. This module watches connected
 * roots with node's fs.watch and, on a change, only SCHEDULES a debounced run
 * of the SAME ingest the scheduler runs (the injected triggerFn). There is no
 * second ingest or write path here. The 30 minute poll stays as the safety
 * net: watch events can be lost, and any watcher failure degrades to poll-only.
 *
 * Safety: a root is watched only if it passes resolveSafeFolderPath() (the
 * per-org allow-list, fail closed) and realpath containment; that check is
 * repeated on EVERY event, and an event path that resolves outside the root
 * (symlink escape, `..`) is dropped.
 *
 * Resource hygiene (Loop and Restart Hygiene): bounded watcher count with a
 * logged reason when capped; create/watch errors are counted distinctly and
 * degrade to poll-only (never throw); failed creates back off exponentially;
 * watchers are persistent:false and closed on disable, repoint and close().
 *
 * Never fs.watch({recursive:true}): on Linux node 20 implements it in JS with a
 * synchronous readdirSync walk of the WHOLE tree plus one watcher per FILE, on
 * the event loop. Pointed at a repo root it pegged the collector (2026-10-15).
 * Instead: an async walk that watches each DIRECTORY non-recursively, skips dot
 * directories and node_modules, and retires a root to poll-only when the tree
 * is over maxDirsPerRoot (not re-walked until its path changes or RETIRE_MS).
 * Triggered runs are rate limited per source (minIntervalMs) and back off,
 * doubling up to maxIntervalMs, while runs make no progress; a run that pushes
 * docs resets it. Failures and empty runs are counted separately.
 */

'use strict';

const path = require('path');
const realFs = require('fs');
const { resolveSafeFolderPath, isPathInAllowedRoots, ALLOWED_EXTENSIONS } = require('./feedFolderSource.js');

const WATCHED_SOURCE_TYPES = ['folder', 'obsidian'];
const DEFAULT_DEBOUNCE_MS = 3000;
const DEFAULT_MAX_WATCHERS = 32;
const MAX_BUSY_REARMS = 10;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_CAP_MS = 60 * 60 * 1000;
const DEFAULT_MAX_DIRS_PER_ROOT = 200;
const DEFAULT_MIN_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_INTERVAL_MS = 30 * 60 * 1000; // the poll cadence: never slower than it
const RETIRE_MS = 6 * 60 * 60 * 1000;
const SKIP_DIR_NAMES = new Set(['node_modules']);

function skipDirName(name) {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name);
}

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * @param {object} o
 * @param {function} o.listSourcesFn async () => [{orgId, sourceType, path}] enabled folder/obsidian sources
 * @param {function} o.triggerFn async (orgId, sourceType) => {busy?:boolean}; runs the scheduler's own ingest
 */
function createFolderWatchManager({
  listSourcesFn,
  triggerFn,
  watchFn = realFs.watch,
  fsImpl = realFs,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWatchers = DEFAULT_MAX_WATCHERS,
  maxDirsPerRoot = DEFAULT_MAX_DIRS_PER_ROOT,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
  readdirFn = (dir, o) => realFs.promises.readdir(dir, o),
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = console.log,
  warn = console.warn,
  error = console.error,
} = {}) {
  const watchers = new Map(); // key -> {dirs: Map(dir -> fs watcher), path, orgId, sourceType}
  const timers = new Map(); // key -> timer
  const rearms = new Map(); // key -> count
  const failedCreates = new Map(); // key -> {count, retryAt}
  const retired = new Map(); // key -> {path, until}: tree too big, poll-only
  const pace = new Map(); // key -> {lastRunAt, interval}
  const opening = new Set();
  const pending = new Map(); // key -> time of the first not-yet-run event
  const stats = { failures: 0, empty: 0, capped: 0, triggers: 0, events: 0, ignored: 0 };
  let capLogged = false;
  let closed = false;

  const keyOf = (orgId, sourceType) => `${orgId}::${sourceType}`;

  function closeWatcher(key) {
    const entry = watchers.get(key);
    if (entry) {
      entry.closed = true;
      for (const w of entry.dirs.values()) { try { w.close(); } catch { /* already closed */ } }
      entry.dirs.clear();
    }
    watchers.delete(key);
    pace.delete(key);
    const t = timers.get(key);
    if (t) clearTimeoutFn(t);
    timers.delete(key);
    pending.delete(key);
    rearms.delete(key);
  }

  function pathStillSafe(entry) {
    const guard = resolveSafeFolderPath(entry.path, { orgId: entry.orgId }, fsImpl);
    return guard.ok && isPathInAllowedRoots(entry.path, fsImpl, { orgId: entry.orgId });
  }

  function intervalFor(key) {
    const p = pace.get(key);
    return p ? p.interval : minIntervalMs;
  }

  function schedule(key, { immediate = false } = {}) {
    if (closed) return;
    const prev = timers.get(key);
    if (prev) clearTimeoutFn(prev);
    // Trailing debounce, but a folder that never goes quiet still runs once
    // the first pending event is older than the min interval (no starvation);
    // the per-source pace (rate limit + backoff) is a floor on top of both.
    const t0 = now();
    if (!pending.has(key)) pending.set(key, t0);
    let delay = Math.min(debounceMs, Math.max(0, pending.get(key) + Math.max(debounceMs, minIntervalMs) - t0));
    const p = pace.get(key);
    if (!immediate && p && p.lastRunAt) delay = Math.max(delay, p.lastRunAt + p.interval - t0);
    const t = setTimeoutFn(() => run(key), delay);
    if (t && typeof t.unref === 'function') t.unref();
    timers.set(key, t);
  }

  async function run(key) {
    timers.delete(key);
    pending.delete(key);
    const entry = watchers.get(key);
    if (closed || !entry) return;
    if (!pathStillSafe(entry)) { stats.ignored++; return; }
    try {
      stats.triggers++;
      const res = await triggerFn(entry.orgId, entry.sourceType);
      if (res && res.busy) {
        if (watchers.get(key) !== entry) return;
        const n = (rearms.get(key) || 0) + 1;
        if (n <= MAX_BUSY_REARMS) { rearms.set(key, n); schedule(key, { immediate: true }); }
        // past the cap the 30 minute poll picks the change up
        return;
      }
      rearms.delete(key);
      const failed = Number(res && res.sourcesFailed) > 0;
      const progressed = !failed && Number(res && (res.totalDocsPushed ?? res.docsPushed)) > 0;
      if (failed) stats.failures++;
      else if (!progressed) stats.empty++;
      settle(key, entry, progressed);
    } catch (err) {
      stats.failures++;
      settle(key, entry, false);
      error(`[FeedWatch] org=${entry.orgId} source=${entry.sourceType}: triggered ingest failed, poll will retry: ${err.message}`);
    }
  }

  // Rate limit + zero-progress backoff: the next watch-triggered run waits at
  // least `interval`, which doubles (to maxIntervalMs) while runs make no
  // progress and resets to minIntervalMs when one pushes docs.
  function settle(key, entry, progressed) {
    if (watchers.get(key) !== entry) return;
    const p = pace.get(key);
    const interval = progressed || !p ? minIntervalMs : Math.min(maxIntervalMs, p.interval * 2);
    pace.set(key, { lastRunAt: now(), interval });
  }

  function onEvent(key, entry, dir, filename) {
    stats.events++;
    if (closed || watchers.get(key) !== entry) return;
    // Once a run is pending, later events in the burst only need the cheap
    // lexical filters: run() re-checks the root guard before it fires and the
    // ingest guards every file it reads. Without this a busy staging folder
    // (~1200 events/30s) blocked the event loop ~360ms in sync fs calls.
    const queued = pending.has(key);
    if (!queued && !pathStillSafe(entry)) { stats.ignored++; return; }
    if (filename !== null && filename !== undefined && filename !== '') {
      const name = String(filename);
      if (name.split(/[\\/]/).includes('..')) { stats.ignored++; return; }
      const rel = path.relative(entry.path, path.join(dir, name));
      const segs = rel.split(/[\\/]/);
      if (segs.includes('..') || segs.some((s) => (s.startsWith('.') && s !== '') || SKIP_DIR_NAMES.has(s))) { stats.ignored++; return; }
      if (!path.extname(rel)) maybeWatchNewDir(key, entry, path.join(entry.path, rel));
      const ext = path.extname(rel).toLowerCase();
      if (ext && !ALLOWED_EXTENSIONS.includes(ext)) { stats.ignored++; return; }
      const abs = path.join(entry.path, rel);
      if (!isWithin(abs, entry.path)) { stats.ignored++; return; }
      if (queued) { schedule(key); return; }
      // Symlink escape: if the target exists it must still resolve inside the root.
      let realRoot = entry.path;
      try { realRoot = fsImpl.realpathSync(entry.path); } catch { /* checked above */ }
      let real = null;
      try { real = fsImpl.realpathSync(abs); } catch { /* deleted: lexical check stands */ }
      if (real && !isWithin(real, realRoot)) { stats.ignored++; return; }
    }
    schedule(key);
  }

  function recordFailure(key, err, what) {
    stats.failures++;
    const prev = failedCreates.get(key) || { count: 0 };
    const count = prev.count + 1;
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (count - 1));
    failedCreates.set(key, { count, retryAt: Date.now() + delay });
    error(`[FeedWatch] ${key}: ${what} failed (${err && err.code ? err.code : 'error'}: ${err && err.message}), degraded to poll-only, retry in ${Math.round(delay / 1000)}s`);
  }

  // Async breadth-first walk of the directories under root (root included),
  // skipping dot directories, node_modules and symlinks. Stops as soon as the
  // tree is over `budget` directories. A root that cannot be read throws.
  async function walkDirs(root, budget) {
    const dirs = [root];
    for (let i = 0; i < dirs.length; i++) {
      let ents;
      try { ents = await readdirFn(dirs[i], { withFileTypes: true }); } catch (err) {
        if (i === 0) throw err;
        continue; // a sub-directory vanished or is unreadable: the poll still covers it
      }
      for (const d of ents) {
        if (!d.isDirectory() || skipDirName(d.name)) continue;
        dirs.push(path.join(dirs[i], d.name));
        if (dirs.length > budget) return { dirs, over: true };
      }
    }
    return { dirs, over: false };
  }

  function addDirWatcher(key, entry, dir) {
    const w = watchFn(dir, { persistent: false }, (_type, filename) => onEvent(key, entry, dir, filename && filename.toString ? filename.toString() : filename));
    entry.dirs.set(dir, w);
    w.on('error', (err) => {
      if (dir !== entry.path && !fsImpl.existsSync(dir)) {
        // a watched sub-directory was removed: drop just that watcher
        try { w.close(); } catch { /* closed */ }
        entry.dirs.delete(dir);
        return;
      }
      if (watchers.get(key) !== entry) return;
      closeWatcher(key);
      recordFailure(key, err, 'watcher');
    });
  }

  function maybeWatchNewDir(key, entry, abs) {
    if (entry.closed || !isWithin(abs, entry.path) || abs === entry.path) return;
    let st = null;
    try { st = fsImpl.lstatSync(abs); } catch { /* gone */ }
    if (!st) {
      const w = entry.dirs.get(abs);
      if (w) { try { w.close(); } catch { /* closed */ } entry.dirs.delete(abs); }
      return;
    }
    if (!st.isDirectory() || entry.dirs.has(abs)) return;
    if (entry.dirs.size >= maxDirsPerRoot) { stats.capped++; return; }
    try { addDirWatcher(key, entry, abs); } catch (err) {
      // a new directory we could not watch is still covered by the poll
      warn(`[FeedWatch] ${key}: could not watch new directory (${err && err.code ? err.code : 'error'}), poll covers it`);
    }
  }

  async function open(key, src) {
    const entry = { orgId: src.orgId, sourceType: src.sourceType, path: src.path, dirs: new Map(), closed: false };
    let walked;
    try {
      walked = await walkDirs(src.path, maxDirsPerRoot);
    } catch (err) {
      recordFailure(key, err, 'directory walk');
      return;
    }
    if (closed) return;
    if (walked.over) {
      retired.set(key, { path: src.path, until: now() + RETIRE_MS });
      warn(`[FeedWatch] ${key}: ${src.path} has more than ${maxDirsPerRoot} directories, too big to watch; it stays poll-only (30 min cadence). Point the source at the notes sub-folder to get live capture.`);
      return;
    }
    try {
      for (const dir of walked.dirs) addDirWatcher(key, entry, dir);
    } catch (err) {
      for (const w of entry.dirs.values()) { try { w.close(); } catch { /* closed */ } }
      recordFailure(key, err, 'fs.watch create');
      return;
    }
    watchers.set(key, entry);
    failedCreates.delete(key);
    log(`[FeedWatch] ${key}: watching ${src.path} (${entry.dirs.size} director${entry.dirs.size === 1 ? 'y' : 'ies'})`);
  }

  /** Syncs open watchers to the enabled, allow-listed sources. Never throws. */
  async function reconcile() {
    if (closed) return;
    let sources = [];
    try { sources = (await listSourcesFn()) || []; } catch (err) {
      stats.failures++;
      error(`[FeedWatch] source listing failed, keeping current watchers: ${err.message}`);
      return;
    }
    const desired = new Map();
    for (const s of sources) {
      if (!s || !s.orgId || !s.path || !s.sourceType) continue;
      const key = keyOf(s.orgId, s.sourceType);
      const guard = resolveSafeFolderPath(s.path, { orgId: s.orgId }, fsImpl);
      if (!guard.ok || !isPathInAllowedRoots(s.path, fsImpl, { orgId: s.orgId })) continue;
      desired.set(key, s);
    }
    for (const key of [...watchers.keys()]) {
      const want = desired.get(key);
      if (!want || want.path !== watchers.get(key).path) closeWatcher(key);
    }
    for (const key of [...failedCreates.keys()]) if (!desired.has(key)) failedCreates.delete(key);
    for (const [key, r] of [...retired]) {
      const want = desired.get(key);
      if (!want || want.path !== r.path || now() >= r.until) retired.delete(key);
    }
    let cappedNow = 0;
    for (const [key, src] of desired) {
      if (watchers.has(key) || opening.has(key) || retired.has(key)) continue;
      const failed = failedCreates.get(key);
      if (failed && Date.now() < failed.retryAt) continue;
      if (watchers.size + opening.size >= maxWatchers) { cappedNow++; continue; }
      opening.add(key);
      try { await open(key, src); } finally { opening.delete(key); }
      if (closed) return;
    }
    stats.capped = cappedNow;
    if (cappedNow > 0 && !capLogged) {
      capLogged = true;
      warn(`[FeedWatch] watcher cap ${maxWatchers} reached: ${cappedNow} source(s) stay poll-only (30 min cadence)`);
    } else if (cappedNow === 0) {
      capLogged = false;
    }
  }

  function close() {
    closed = true;
    for (const key of [...watchers.keys()]) closeWatcher(key);
    for (const t of timers.values()) clearTimeoutFn(t);
    timers.clear();
  }

  return {
    reconcile,
    close,
    intervalFor,
    stats: () => ({ ...stats, watching: watchers.size, retired: retired.size, directories: [...watchers.values()].reduce((n, e) => n + e.dirs.size, 0) }),
  };
}

module.exports = { createFolderWatchManager, WATCHED_SOURCE_TYPES, DEFAULT_DEBOUNCE_MS, DEFAULT_MAX_WATCHERS, DEFAULT_MAX_DIRS_PER_ROOT, DEFAULT_MIN_INTERVAL_MS };

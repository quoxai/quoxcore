/**
 * Persona Watcher — QSKL-12 Slice 4
 *
 * Watches src/config/personas/*.md for changes and emits a VOLT
 * persona.changed envelope on every add/change event.
 *
 * Default-on. Disable via QSKL_PERSONA_WATCH_DISABLED=true.
 *
 * Usage (called from server.js after voltEmitter is constructed):
 *   const { startPersonaWatcher } = require('./lib/personaWatcher');
 *   const stopPersonaWatcher = startPersonaWatcher({ voltEmitter });
 *   // in gracefulShutdown: stopPersonaWatcher();
 */

'use strict';

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function resolvePersonasDir() {
  if (process.env.PERSONAS_DIR) return process.env.PERSONAS_DIR;
  const candidates = [
    path.resolve(__dirname, '../../../src/config/personas'),
    path.resolve(__dirname, '../src/config/personas'),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isDirectory()) return p; } catch {}
  }
  return candidates[0];
}

const PERSONAS_DIR = resolvePersonasDir();

// ---- Pure helpers ---------------------------------------------------------

/**
 * SHA-256 hex digest of a string.
 * @param {string} s
 * @returns {string}
 */
function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Compute a human-readable diff summary between two text strings.
 *
 * Format: "N lines changed, +A -B chars"
 * where N = number of lines that differ, A = chars added, B = chars removed.
 *
 * @param {string} prev
 * @param {string} next
 * @returns {string}
 */
function computeDiffSummary(prev, next) {
  const prevLines = prev === '' ? [] : prev.split('\n');
  const nextLines = next === '' ? [] : next.split('\n');

  const maxLen = Math.max(prevLines.length, nextLines.length);
  let changedLines = 0;
  for (let i = 0; i < maxLen; i++) {
    if (prevLines[i] !== nextLines[i]) changedLines++;
  }

  const charsAdded = Math.max(0, next.length - prev.length);
  const charsRemoved = Math.max(0, prev.length - next.length);

  const lineWord = changedLines === 1 ? 'line' : 'lines';
  return `${changedLines} ${lineWord} changed, +${charsAdded} -${charsRemoved} chars`;
}

// ---- Watcher --------------------------------------------------------------

/**
 * Start the persona file watcher.
 *
 * @param {Object} options
 * @param {Object} options.voltEmitter - VOLT emitter instance (startRun/emit/completeRun)
 * @param {Object} [options.env=process.env] - Environment variables object (injectable for tests)
 * @param {Object} [options._chokidar=chokidar] - chokidar instance (injectable for tests)
 * @param {Object} [options._fs=fs] - fs module (injectable for tests)
 * @returns {Function} stop — call to close the watcher
 */
function startPersonaWatcher({ voltEmitter, env = process.env, _chokidar = chokidar, _fs = fs }) {
  if (env.QSKL_PERSONA_WATCH_DISABLED === 'true') {
    return () => {};
  }

  // Map from absolute filePath → last known content (for diff computation).
  // Pre-warmed at startup so the first edit produces a meaningful diff.
  const prevContent = new Map();

  // Per-file debounce timers: Map<filePath, TimeoutId>
  // Coalesces rapid chokidar events for the same file into a single handler call.
  const debounceTimers = new Map();
  const DEBOUNCE_MS = 200;

  /**
   * Handle an add or change event for a persona file.
   * Emits a VOLT persona.changed envelope via a short-lived synthetic run.
   */
  async function handleFileEvent(filePath) {
    try {
      const [stat, next] = await Promise.all([
        _fs.promises.stat(filePath),
        _fs.promises.readFile(filePath, 'utf8'),
      ]);

      const prev = prevContent.get(filePath) || '';
      const agentId = path.basename(filePath, '.md');

      const payload = {
        agent_id: agentId,
        file_path: filePath,
        mtime: stat.mtimeMs,
        content_hash: sha256(next),
        prev_hash: sha256(prev),
        diff_summary: computeDiffSummary(prev, next),
      };

      // Short-lived synthetic run per persona edit.
      // Using 'persona-watcher' as corr so all persona events share a stable
      // correlation stream in VOLT, with system:true in context.
      const runId = voltEmitter.startRun('persona-watcher', {
        agent_id: agentId,
        system: true,
      });
      voltEmitter.emit(runId, 'persona.changed', payload);
      voltEmitter.completeRun(runId);

      // Update prevContent after successful emit
      prevContent.set(filePath, next);
    } catch (err) {
      console.warn(`[PersonaWatcher] Error handling ${filePath}:`, err.message);
    }
  }

  // Pre-warm prevContent by reading all existing persona files once.
  // Errors are non-fatal — missing dir just means no personas yet.
  async function prewarm() {
    try {
      const entries = await _fs.promises.readdir(PERSONAS_DIR);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const filePath = path.join(PERSONAS_DIR, entry);
        try {
          const content = await _fs.promises.readFile(filePath, 'utf8');
          prevContent.set(filePath, content);
        } catch (_) {
          // Non-fatal — file may have been removed between readdir and readFile
        }
      }
    } catch (_) {
      // PERSONAS_DIR may not exist in some environments — that's fine
    }
  }

  // Start chokidar watcher. ignoreInitial:true so we don't emit persona.changed
  // for every file at boot — only for actual edits after startup.
  const glob = path.join(PERSONAS_DIR, '*.md');
  const watcher = _chokidar.watch(glob, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  function debouncedFileEvent(filePath) {
    if (debounceTimers.has(filePath)) {
      clearTimeout(debounceTimers.get(filePath));
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(filePath);
      handleFileEvent(filePath);
    }, DEBOUNCE_MS);
    debounceTimers.set(filePath, timer);
  }

  watcher.on('add', debouncedFileEvent);
  watcher.on('change', debouncedFileEvent);
  watcher.on('error', (err) => {
    console.warn('[PersonaWatcher] chokidar error (non-fatal):', err.message);
  });

  // Fire-and-forget prewarm — do not block startup
  prewarm().catch((err) => {
    console.warn('[PersonaWatcher] prewarm error (non-fatal):', err.message);
  });

  console.log(`[PersonaWatcher] Watching ${glob}`);

  return () => {
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    debounceTimers.clear();
    watcher.close();
  };
}

module.exports = { startPersonaWatcher, computeDiffSummary, sha256 };

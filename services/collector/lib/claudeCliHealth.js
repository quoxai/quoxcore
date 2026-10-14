'use strict';
/**
 * Claude CLI health probe (`claude --version`), shared by every chat path that spawns the CLI.
 *
 * QUOXON-PARITY (parity run 20261013T070218Z, memory-recall/anthropic): one probe failed
 * transiently and the failure was cached for 60 s, so a turn failed outright with "Chat is
 * temporarily unavailable". Now:
 *  - a failure other than a missing binary or a timeout is retried once after a short delay;
 *  - a success is cached for `cacheMs`, a failure only for FAIL_CACHE_MS, so a blip never
 *    holds the provider down for a minute.
 */

const FAIL_CACHE_MS = 5000;
const RETRY_DELAY_MS = 300;

function createClaudeCliHealth({ execFile, env, log = console, now = Date.now, retryDelayMs = RETRY_DELAY_MS, failCacheMs = FAIL_CACHE_MS } = {}) {
  let cache = null;
  let missingLogged = false;

  const probe = (timeoutMs) => new Promise((resolve) => {
    execFile('claude', ['--version'], { encoding: 'utf8', timeout: timeoutMs, env: env() }, (err, stdout) => {
      if (err) resolve({ ok: false, error: err.message, missing: err.code === 'ENOENT' || String(err.message).includes('ENOENT'), timedOut: Boolean(err.killed) });
      else resolve({ ok: true, version: String(stdout || '').trim() });
    });
  });

  async function get({ timeoutMs = 15000, cacheMs = 60000, force = false } = {}) {
    const t = now();
    if (!force && cache) {
      const ttl = cache.ok ? cacheMs : Math.min(cacheMs, failCacheMs);
      if (t - cache.ts < ttl) return cache;
    }
    let r = await probe(timeoutMs);
    if (!r.ok && !r.missing && !r.timedOut) {
      if (retryDelayMs > 0) await new Promise((res) => setTimeout(res, retryDelayMs));
      const second = await probe(timeoutMs);
      if (second.ok) log.warn?.(`[Claude] CLI health check failed once, retry ok: ${r.error}`);
      r = second;
    }
    if (r.ok) log.log?.('[Claude] CLI version:', r.version);
    else if (r.missing) {
      // A missing binary (public images ship without it) is a steady state, not an incident: say it once.
      if (!missingLogged) { missingLogged = true; log.warn?.('[Claude] CLI not installed in this image; subscription provider unavailable'); }
    } else log.error?.('[Claude] CLI health check failed:', r.error);
    cache = r.ok ? { ok: true, version: r.version, ts: now() } : { ok: false, error: r.error, ts: now() };
    return cache;
  }

  return { get, peek: () => cache };
}

module.exports = { createClaudeCliHealth, FAIL_CACHE_MS };

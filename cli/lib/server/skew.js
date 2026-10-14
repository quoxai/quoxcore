/**
 * C4: version skew between this CLI and the server it talks to. Warns at most once per day, and only when
 * major or minor differ (a patch difference does not matter). Silent whenever either side is unknown.
 *
 * CLI side: the platform release the CLI was built from (the repo VERSION file beside cli/).
 * Server side: the collector's public /version `release` (the image's /app/VERSION).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSemver, cmpSemver } from './install.js';

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DAY_MS = 86400000;

export function cliRelease(root = CLI_ROOT) {
  try { const v = readFileSync(join(root, '..', 'VERSION'), 'utf8').trim(); return parseSemver(v) ? v : null; } catch { return null; }
}

export function skewCachePath(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'quox', 'version-skew.json');
}

/** -> null | { cli, server, newer: 'cli'|'server', message } */
export function skewOf(cli, server) {
  const a = parseSemver(cli); const b = parseSemver(server);
  if (!a || !b) return null;
  if (a[0] === b[0] && a[1] === b[1]) return null;
  const newer = cmpSemver(cli, server) > 0 ? 'cli' : 'server';
  const message = newer === 'cli'
    ? `this quox CLI is ${cli} but the server runs ${server}. Update the server: quox server update (on the server; quox server update --dry-run shows the plan first).`
    : `this quox CLI is ${cli} but the server runs ${server}. Update the CLI to ${server} so its commands match the server.`;
  return { cli, server, newer, message };
}

/**
 * Once per day: read the server release, compare, return the warning (or null). Never throws.
 * The cache is stamped BEFORE the network call, so a slow or failing server costs one try per day.
 */
export async function checkSkewOncePerDay({ collectorUrl, fetchImpl = globalThis.fetch, now = () => Date.now(), cachePath = skewCachePath(), cli = cliRelease(), timeoutMs = 1500 } = {}) {
  try {
    if (!cli || !collectorUrl) return null;
    let cache = {};
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')) || {}; } catch { /* first run */ }
    if (cache.checkedAt && now() - cache.checkedAt < DAY_MS) return null;
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ ...cache, checkedAt: now() }) + '\n');
    const r = await fetchImpl(`${collectorUrl.replace(/\/+$/, '')}/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body = await r.json();
    const sk = skewOf(cli, body?.release);
    if (sk) writeFileSync(cachePath, JSON.stringify({ checkedAt: now(), warnedAt: now(), cli, server: body.release }) + '\n');
    return sk;
  } catch { return null; }
}

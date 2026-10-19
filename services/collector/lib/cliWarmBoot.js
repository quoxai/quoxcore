'use strict';
/**
 * quox#1151: warm spares survive a collector restart.
 *
 * The warm pool (lib/cliWarmPool.js) is in-memory, so every restart emptied it (pool=0/8)
 * and the first turn per user+agent after a deploy booted `claude` cold (~3.7 s).
 *
 * Record: each CONVERSATION prespawn writes its exact recipe (org, user, the warm argv and
 * the credential-free env the turn path built) to a small 0600 JSON file on the collector's
 * data volume. The argv is already warmArgsFrom() output, so no system prompt or user
 * message is ever in it. The env is checked against an ALLOWLIST of non-secret keys; a
 * recipe with any other key (e.g. CLAUDE_CODE_OAUTH_TOKEN when the CLI login rides env) is
 * never written, so it can never be replayed. Turn credentials are stripped by the pool.
 *
 * Replay: after a settle delay at boot, recipes used within the window before the restart
 * are prespawned one at a time (stagger), most recent pair first, one fresh-shape spare per
 * user+agent pair before any resume-shape spare, bounded by the pool cap and skipped while
 * the 1-min load is over a threshold. A recipe whose env identity disagrees with its
 * recorded org/user is skipped (cannot be reconstructed safely). Boot spares are ordinary
 * spares: same key, same single use, same idle TTL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_FILE = '/var/lib/quox/cli-warm-recipes.json';
const MAX_RECIPES = 64;
// Non-secret keys the CLI-tools turn env is built from (turnToken.pickCliToolsEnv allowlist
// + the dispatcher's own non-credential keys). Allowlist, never a denylist: an unknown key
// means "do not persist", not "persist and hope".
const RECIPE_ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ', 'TMPDIR',
  'NODE_EXTRA_CA_CERTS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'QUOX_SUPERVISOR_TURN',
  'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'QUOX_TOOL_EXEC_TIMEOUT_MS',
  'QUOX_ORG_ID', 'QUOX_USER_ID', 'QUOX_AGENT_ID', 'QUOX_COLLECTOR_URL',
]);
const envKeyAllowed = (k) => RECIPE_ENV_ALLOW.has(k) || k.startsWith('LC_');
const isResume = (args) => Array.isArray(args) && (args.includes('--resume') || args.includes('-r'));

function createWarmRecipeStore({ file = DEFAULT_FILE, max = MAX_RECIPES, log = console } = {}) {
  let warnedKeys = new Set();
  function readAll() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(j.recipes) ? j.recipes : [];
    } catch { return []; }
  }
  function writeAll(recipes) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, recipes }), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  /** key + safe parts from the pool; returns true when persisted. */
  function record({ key, orgId, userId, args, env }) {
    try {
      const bad = Object.keys(env || {}).filter((k) => !envKeyAllowed(k));
      if (bad.length) {
        const sig = bad.sort().join(',');
        if (!warnedKeys.has(sig)) { warnedKeys.add(sig); log.log(`[CLI-WARM] recipe not persisted reason=env_not_allowlisted keys=[${sig}]`); }
        return false;
      }
      const at = Date.now();
      const rest = readAll().filter((r) => r.key !== key);
      rest.unshift({ key, orgId: String(orgId), userId: String(userId), args: [...args], env: { ...env }, at });
      writeAll(rest.slice(0, max));
      return true;
    } catch (e) {
      log.warn(`[CLI-WARM] recipe write failed: ${e.message}`);
      return false;
    }
  }
  function list() { return readAll(); }
  return { record, list, file };
}

/**
 * Replay recent recipes into the pool. Returns { warmed: pairs, spares, skipped, reasons }.
 * Logs exactly one summary line.
 */
async function bootPrewarm({
  pool, store, bootAt = Date.now(), windowMs = 600000, staggerMs = 5000, maxLoad = 20,
  loadavg = () => os.loadavg(), sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }),
  log = console,
}) {
  const reasons = new Set();
  let skipped = 0;
  let spares = 0;
  const pairsWarmed = new Set();
  let recipes = [];
  try { recipes = (store && typeof store.list === 'function' ? store.list() : []) || []; } catch { recipes = []; }

  const recent = recipes
    .filter((r) => r && typeof r.at === 'number' && r.at >= bootAt - windowMs && r.at <= bootAt)
    .sort((a, b) => b.at - a.at);
  const pairOf = (r) => `${r.orgId}|${r.userId}|${(r.env && r.env.QUOX_AGENT_ID) || ''}`;
  const safe = [];
  for (const r of recent) {
    const e = r.env || {};
    const ok = r.orgId && r.userId && Array.isArray(r.args)
      && String(e.QUOX_ORG_ID || '') === String(r.orgId) && String(e.QUOX_USER_ID || '') === String(r.userId)
      && Object.keys(e).every(envKeyAllowed);
    if (ok) safe.push(r); else { skipped += 1; reasons.add('unsafe'); }
  }
  // Fresh shape first (serves any new conversation with the agent), then one resume per pair.
  const order = [];
  const seenFresh = new Set();
  const seenResume = new Set();
  for (const r of safe) if (!isResume(r.args) && !seenFresh.has(pairOf(r))) { seenFresh.add(pairOf(r)); order.push(r); }
  for (const r of safe) if (isResume(r.args) && !seenResume.has(pairOf(r))) { seenResume.add(pairOf(r)); order.push(r); }
  const dupes = safe.length - order.length;
  if (dupes > 0) { skipped += dupes; reasons.add('dup'); }

  const cap = typeof pool.cap === 'function' ? pool.cap() : 8;
  let first = true;
  for (let i = 0; i < order.length; i += 1) {
    const r = order[i];
    const left = order.length - i;
    if (pool.size() >= cap) { skipped += left; reasons.add('cap'); break; }
    if (!first && staggerMs > 0) await sleep(staggerMs);
    const load = Number((loadavg() || [])[0]) || 0;
    if (load > maxLoad) { skipped += left; reasons.add('load'); break; }
    first = false;
    let spare = null;
    try { spare = pool.prespawn({ orgId: r.orgId, userId: r.userId, args: r.args, env: r.env, kind: 'conversation', fromBoot: true }); } catch { spare = null; }
    if (spare) { spares += 1; pairsWarmed.add(pairOf(r)); } else { skipped += 1; reasons.add('spawn'); }
  }
  const why = reasons.size ? [...reasons].join('/') : 'none';
  log.log(`[CLI-WARM] boot prewarm ${pairsWarmed.size} pairs (skipped ${skipped}: ${why})`);
  return { warmed: pairsWarmed.size, spares, skipped, reasons: [...reasons] };
}

module.exports = { createWarmRecipeStore, bootPrewarm, RECIPE_ENV_ALLOW, DEFAULT_FILE };

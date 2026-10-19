'use strict';
/**
 * DEVFLEET-BUILTINS: READ-ONLY fleet reads go through Bastion's native RiskTier "safe"
 * builtins (pvesh-read, docker-read via POST /api/v1/tools/run) instead of raw shell
 * strings, because raw reads hit the approval-mode gate (403) and the builtins do not.
 *
 * runSafeRead(builtin, host, params, rawFallback, opts)
 *   1. runs the builtin;
 *   2. falls back to rawFallback() ONLY when Bastion answers that the tool is unknown
 *      (HTTP 404 / "unknown tool" / "tool ... not found"), so this ships before Bastion is upgraded;
 *   3. NEVER falls back on a refusal (403) or any other error: a refusal stays a refusal
 *      (lib/bastionRefusal.js), an error stays an error.
 *
 * The returned object is callBastion-shaped ({success, stdout, exit_code, ...}) so callers'
 * existing handling (dockerReadFailed, refused envelopes) is unchanged. opts.convert maps the
 * builtin's JSON output back to the text shape the caller's parser already understands.
 */
const { bastionHttpErrorResult } = require('./bastionRefusal.js');

const HTTP_ERR = /Bastion tools\/run returned (\d{3}):\s*([\s\S]*)$/;

/** True when a toolRun result says Bastion does not know this builtin. */
function isUnknownToolResult(r) {
  if (!r || r.success !== false) return false;
  const err = String(r.error || '');
  const m = err.match(HTTP_ERR);
  if (m && m[1] === '404') return true;
  if (m && m[1] !== '404') return false; // any other HTTP status is never "unknown tool"
  return /unknown tool|no such tool|tool\b[^.]{0,60}\bnot found|not a (known|registered) tool/i.test(err);
}

let toolRunOverride = null;
function defaultToolRun(...args) {
  if (toolRunOverride) return toolRunOverride(...args);
  return require('./bastionSshExecutor')._internal.callBastionToolRun(...args);
}
/** Test seam: pin the default tool-run (e.g. to emulate a pre-upgrade Bastion). Pass null to reset. */
function _setDefaultToolRunForTest(fn) { toolRunOverride = fn || null; }

/** Bastion builtins take string params only; drop null/undefined, stringify the rest. */
function stringifyParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

async function runSafeRead(builtin, host, params, rawFallback, opts = {}) {
  const toolRun = opts.toolRun || defaultToolRun;
  // Bastion tool params are map[string]string: a JSON boolean or number makes the whole
  // body unparseable (400 'invalid request body', seen live 2026-10-14). Send strings only.
  const r = await toolRun(builtin, host, stringifyParams(params));
  if (isUnknownToolResult(r)) return rawFallback();
  if (!r) return { success: false, error: `Bastion ${builtin} returned no result` };
  if (r.success === false || r.success === undefined && r.error) {
    if (opts.fallbackWhen instanceof RegExp && opts.fallbackWhen.test(String(r.error || ''))) return rawFallback();
    const m = String(r.error || '').match(HTTP_ERR);
    if (m) return bastionHttpErrorResult(Number(m[1]), m[2]); // 403 -> refused, others -> plain error
    return {
      success: false,
      error: r.error || `Bastion ${builtin} failed`,
      exit_code: r.exit_code,
      stdout: r.output || '',
      stderr: r.stderr || '',
      via: 'builtin',
    };
  }
  const output = r.output == null ? '' : String(r.output);
  let stdout = output;
  if (opts.convert) {
    try { stdout = opts.convert(output); } catch (err) {
      return { success: false, error: `Failed to parse ${builtin} output: ${err.message}`, via: 'builtin' };
    }
  }
  return { success: true, exit_code: r.exit_code == null ? 0 : r.exit_code, stdout, stderr: r.stderr || '', duration_ms: r.duration_ms, via: 'builtin' };
}

/** Parse docker `--format '{{json .}}'` output: one JSON object per line (or one array). */
function parseJsonLines(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  }
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}

/** JSON lines -> delimiter-joined rows, matching what the old `--format "{{.A}}|{{.B}}"` printed. */
function jsonRowsToText(keys, sep) {
  return (output) => parseJsonLines(output)
    .map(o => keys.map(k => (typeof k === 'function' ? k(o) : (o[k] == null ? '' : String(o[k])))).join(sep))
    .join('\n');
}

const PS_KEYS = ['ID', 'Names', 'Image', 'Status', 'Ports', 'CreatedAt'];
const STATS_KEYS = ['Name', 'CPUPerc', 'MemUsage', 'MemPerc', 'NetIO', 'BlockIO'];
const DF_KEYS = ['Type', 'TotalCount', 'Active', 'Size', 'Reclaimable'];
const INFO_KEYS = ['ServerVersion', 'ContainersRunning', 'ContainersStopped', 'Containers', 'Images'];
const NETWORK_KEYS = ['Name', 'Driver', 'Scope', 'ID'];
const IMAGE_KEYS = [o => `${o.Repository}:${o.Tag}`, 'Size', 'CreatedSince'];

/** docker-read op -> {params, convert}. sep is '|' (fleet) or '\t' (docker.js / bastion_ssh). */
const dockerRead = {
  ps: (all, sep) => ({ params: { op: 'ps', all: !!all }, convert: jsonRowsToText(PS_KEYS, sep) }),
  // quox#1043: Bastions before 8982cc5 reject stats with no id ("every container"); only that exact
  // rejection of the all-containers form falls back to the raw read.
  stats: (id, sep) => ({ params: { op: 'stats', ...(id ? { id } : {}) }, convert: jsonRowsToText(STATS_KEYS, sep), ...(id ? {} : { fallbackWhen: /\bid is missing or invalid\b/ }) }),
  images: (sep) => ({ params: { op: 'images' }, convert: jsonRowsToText(IMAGE_KEYS, sep) }),
  df: (sep) => ({ params: { op: 'df' }, convert: jsonRowsToText(DF_KEYS, sep) }),
  info: (sep) => ({ params: { op: 'info' }, convert: jsonRowsToText(INFO_KEYS, sep) }),
  networks: (sep) => ({ params: { op: 'networks' }, convert: jsonRowsToText(NETWORK_KEYS, sep) }),
  composeLs: () => ({ params: { op: 'compose_ls' } }),
  logs: (id, tail) => ({ params: { op: 'logs', id, tail: Math.max(1, Math.min(parseInt(tail) || 100, 2000)) } }),
  inspect: (id) => ({
    params: { op: 'inspect', id },
    // docker inspect may print an array of one; callers expect the single object.
    convert: (out) => { const t = String(out || '').trim(); if (!t.startsWith('[')) return t; const a = JSON.parse(t); return a.length ? JSON.stringify(a[0]) : ''; },
  }),
};

module.exports = {
  stringifyParams, _setDefaultToolRunForTest, runSafeRead, isUnknownToolResult, parseJsonLines, jsonRowsToText, dockerRead };

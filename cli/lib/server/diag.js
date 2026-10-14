/**
 * C4: `quox server diag` = a redacted support bundle, written locally, never uploaded.
 *
 * Redaction is ALLOWLIST-only, never a denylist (a denylist only knows the secret shapes its author
 * thought of; 2026-08-09 a nested access_token slipped one):
 *  - JSON log lines keep only the fields named in LOG_FIELDS; everything else is dropped.
 *  - Free-text log lines keep a token only if it has an allowed SHAPE (a plain word, a small number,
 *    a timestamp, a URL path with no query and no id-like segment, an HTTP method/status); a key=value
 *    keeps its value only when the key is in VALUE_KEYS. Every other token becomes [redacted].
 *  - .env: key names only, plus the values of ENV_VALUE_KEYS (non-secret by construction).
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { envKeyNames, readEnvKeys } from './install.js';

export const LOG_FIELDS = ['time', 'timestamp', 'ts', 'level', 'severity', 'service', 'component', 'module', 'msg', 'message', 'event', 'type',
  'status', 'statusCode', 'code', 'method', 'route', 'path', 'duration_ms', 'durationMs', 'latency_ms', 'attempt', 'phase', 'errorName', 'err_name'];
export const VALUE_KEYS = ['status', 'code', 'method', 'level', 'service', 'port', 'attempt', 'duration', 'ms', 'count', 'exit', 'signal', 'version', 'route', 'path', 'phase', 'state'];
export const ENV_VALUE_KEYS = ['NODE_ENV', 'LOG_LEVEL', 'QUOXCORE_VERSION', 'COMPOSE_PROJECT_NAME', 'TZ'];
const R = '[redacted]';
const TEXT_FIELDS = new Set(['msg', 'message']);

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const SHAPES = [
  /^[A-Za-z][A-Za-z'’-]{0,24}$/, // a plain word
  /^-?\d{1,6}(\.\d{1,3})?(ms|s|m|h|%|kb|mb|gb|KB|MB|GB)?$/, // a small number or duration
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/, // a date / ISO timestamp
  /^\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/, // a clock time
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/,
  /^[[\](){}<>:;,.!?=|/*#&+-]{1,4}$/ // punctuation runs
];
const PUNCT_EDGE = /^([("'`[{<]*)(.*?)([)"'`\]}>:;,.!?]*)$/s;

/** A URL path with no query; any id-like segment (digits+letters, 12+ chars, hex 8+) is masked. */
function safePath(p) {
  if (!/^\/[A-Za-z0-9/_.:-]{0,200}$/.test(p)) return null;
  return p.split('/').map((seg) => (seg === '' || SHAPES[0].test(seg) || /^v\d{1,2}$/.test(seg) || /^\d{1,6}$/.test(seg) ? seg : ':id')).join('/');
}

function scrubToken(tok) {
  const m = PUNCT_EDGE.exec(tok); const [, pre, core, post] = m || ['', '', tok, ''];
  if (!core) return tok;
  const kv = /^([A-Za-z_][\w.-]{0,40})([=:])(.*)$/.exec(core);
  if (kv && !/^\/\//.test(kv[3])) {
    const key = kv[1].toLowerCase().replace(/^.*[._-]/, '');
    const val = kv[3].replace(/^["']|["']$/g, '');
    const keep = VALUE_KEYS.includes(kv[1].toLowerCase()) || VALUE_KEYS.includes(key);
    if (val === '') return `${pre}${kv[1]}${kv[2]}${post}`;
    return `${pre}${kv[1]}${kv[2]}${keep && SHAPES.some((s) => s.test(val)) ? val : keep && safePath(val) ? safePath(val) : R}${post}`;
  }
  if (SHAPES.some((s) => s.test(core))) return `${pre}${core}${post}`;
  if (core.startsWith('/')) { const sp = safePath(core); if (sp) return `${pre}${sp}${post}`; }
  return `${pre}${R}${post}`;
}

/** Free text -> only allowed token shapes survive. */
export function scrubText(line) {
  return String(line || '').replace(ANSI, '').split(/(\s+)/).map((t) => (/^\s+$/.test(t) || t === '' ? t : scrubToken(t))).join('');
}

/** One log line -> its redacted form. JSON lines keep allowlisted fields only. */
export function redactLine(line) {
  const raw = String(line || '').replace(ANSI, '');
  // docker compose prefixes "service-1  | "
  const pm = /^(\S+\s+\|\s?)(.*)$/.exec(raw);
  const prefix = pm ? pm[1] : ''; const body = pm ? pm[2] : raw;
  const t = body.trim();
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      const kept = {};
      for (const k of LOG_FIELDS) {
        const v = o[k];
        if (v === undefined || v === null || typeof v === 'object') continue;
        if (typeof v === 'string') {
          if (k === 'path' || k === 'route') kept[k] = safePath(v.split('?')[0]) || R;
          else kept[k] = TEXT_FIELDS.has(k) ? scrubText(v) : (SHAPES.some((s) => s.test(v)) ? v : R);
        } else kept[k] = v;
      }
      return prefix + JSON.stringify(kept);
    } catch { /* not JSON after all */ }
  }
  return prefix + scrubText(body);
}

const INTERESTING = /\b(error|err|fail(ed|ure)?|fatal|exception|panic|warn(ing)?|refused|timeout|unhealthy|denied)\b/i;

/** Recent error/warning lines only, newest last, at most `max`. */
export function recentErrors(text, max = 200) {
  return String(text || '').split('\n').filter((l) => INTERESTING.test(l)).slice(-max).map(redactLine);
}

/**
 * Write the bundle. data = { versions, status rows, doctor rows }. Logs come from `docker compose logs`.
 * -> { ok, file, files } ; the directory is tarred into <out>/quox-diag-<stamp>.tar.gz and removed.
 */
export async function writeDiagBundle({ install, sys, out, data, now = () => new Date(), services = null, tail = 2000 }) {
  const stamp = now().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const name = `quox-diag-${stamp}`;
  const dir = join(out, name);
  mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
  const files = [];
  const put = (rel, body) => { writeFileSync(join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n', { mode: 0o600 }); files.push(rel); };

  put('README.txt', [
    'Quox support bundle (quox server diag). Written on this machine; nothing was uploaded.',
    'Redaction is allowlist-only: JSON log lines keep only named fields; free-text lines keep only plain',
    'words, small numbers, timestamps and id-free URL paths; everything else reads [redacted].',
    '.env: key names only, plus the values of NODE_ENV, LOG_LEVEL, QUOXCORE_VERSION, COMPOSE_PROJECT_NAME, TZ.',
    'Look through it before you share it.', ''
  ].join('\n'));
  put('versions.json', data.versions || {});
  put('status.json', data.status || {});
  put('doctor.json', data.doctor || []);
  put('env.json', { keys: envKeyNames(install.repoDir) || [], values: readEnvKeys(install.repoDir, ENV_VALUE_KEYS) });

  const names = services || (data.status?.services?.ok ? data.status.services.services.map((s) => s.service) : []);
  for (const s of names) {
    if (!/^[\w.-]+$/.test(s)) continue;
    const r = await sys.run('docker', ['compose', '-p', install.project, 'logs', '--no-color', '--tail', String(tail), s], { cwd: install.repoDir });
    const lines = r.code === 0 ? recentErrors(`${r.stdout}\n${r.stderr}`) : [`could not read logs (exit ${r.code})`];
    put(join('logs', `${s}.log`), lines.join('\n') + '\n');
  }
  const file = join(out, `${name}.tar.gz`);
  const t = await sys.run('tar', ['czf', file, '-C', out, name]);
  if (t.code !== 0) return { ok: true, file: dir, files, tarred: false };
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, file, files, tarred: true };
}

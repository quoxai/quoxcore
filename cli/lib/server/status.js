/**
 * C4: `quox server status` and /server. Read-only: version, health per service, disk, ports, last update.
 * Anything that could not be read is said as such, never filled in.
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readInstalled } from './install.js';

const STATE_FILE = 'lifecycle-state.json';
const HISTORY_FILE = 'history.jsonl';

export function readState(root) { try { return JSON.parse(readFileSync(join(root, STATE_FILE), 'utf8')); } catch { return null; } }
export function writeState(root, state) {
  mkdirSync(root, { recursive: true });
  const p = join(root, STATE_FILE); const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}
export function appendHistory(root, event) {
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, HISTORY_FILE), JSON.stringify(event) + '\n', { mode: 0o600 });
}
export function readHistory(root) {
  try { return readFileSync(join(root, HISTORY_FILE), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

/** `docker compose ps --format json` is a JSON array on some versions and NDJSON on others. */
export function parseComposePs(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch { /* NDJSON */ }
  return t.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export const compose = (install, args) => ['compose', '-p', install.project, ...args];

export async function composeServices(install, sys) {
  const r = await sys.run('docker', compose(install, ['ps', '-a', '--format', 'json']), { cwd: install.repoDir });
  if (r.code !== 0) return { ok: false, error: (r.stderr || '').trim().split('\n').pop() || `docker compose ps exited ${r.code}` };
  return {
    ok: true,
    services: parseComposePs(r.stdout).map((s) => ({
      service: s.Service || s.Name,
      name: s.Name,
      state: s.State || '?',
      health: s.Health || null,
      ports: [...new Set((s.Publishers || []).filter((p) => p.PublishedPort).map((p) => `${p.URL && p.URL !== '0.0.0.0' && p.URL !== '::' ? p.URL + ':' : ''}${p.PublishedPort}->${p.TargetPort}`))]
    })).sort((a, b) => String(a.service).localeCompare(String(b.service)))
  };
}

export async function diskFree(path, sys) {
  const r = await sys.run('df', ['-Pk', path]);
  if (r.code !== 0) return { ok: false, error: `df exited ${r.code}` };
  const line = r.stdout.trim().split('\n').pop().split(/\s+/);
  const availKb = Number(line[3]); const sizeKb = Number(line[1]);
  if (!Number.isFinite(availKb)) return { ok: false, error: 'could not read df output' };
  return { ok: true, path, freeGB: +(availKb / 1048576).toFixed(1), sizeGB: +(sizeKb / 1048576).toFixed(1), usedPct: line[4] };
}

async function getJson(url, fetchImpl, timeout = 3000) {
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
    let body = null; try { body = await r.json(); } catch { /* health may be text */ }
    return { ok: true, status: r.status, body };
  } catch (e) { return { ok: false, error: e?.cause?.code || e?.message || 'no answer' }; }
}

/** The running build, from the collector's public /version. */
export async function runningVersion(collectorUrl, fetchImpl = globalThis.fetch) {
  const r = await getJson(`${collectorUrl.replace(/\/+$/, '')}/version`, fetchImpl);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, commit: r.body?.version || null, release: r.body?.release || null, stamped: r.body?.stamped ?? null };
}

export async function probeHttp(urls, fetchImpl = globalThis.fetch) {
  return Promise.all(Object.entries(urls).map(async ([name, base]) => {
    const t0 = Date.now();
    const r = await getJson(`${base.replace(/\/+$/, '')}/health`, fetchImpl);
    return { name, url: base, ok: r.ok, detail: r.ok ? `HTTP ${r.status}` : r.error, ms: Date.now() - t0 };
  }));
}

export function defaultUrls(config) {
  const get = (s, fb) => { try { return config?.getServiceUrl?.(s) || fb; } catch { return fb; } };
  return { auth: get('auth', 'http://127.0.0.1:3101'), collector: get('collector', 'http://127.0.0.1:9848') };
}

/** -> the full status object. Never throws for a missing piece. */
export async function gatherStatus({ install, sys, fetchImpl = globalThis.fetch, urls, backups }) {
  const [installed, running, svc, disk, http] = await Promise.all([
    readInstalled(install, sys),
    runningVersion(urls.collector, fetchImpl),
    composeServices(install, sys),
    diskFree(install.root, sys),
    probeHttp(urls, fetchImpl)
  ]);
  const hist = backups ? readHistory(backups) : [];
  const lastUpdate = [...hist].reverse().find((e) => e.op === 'update' || e.op === 'rollback') || null;
  const state = backups ? readState(backups) : null;
  return { install, installed, running, services: svc, disk, http, lastUpdate, inFlight: state && state.status === 'running' ? state : null };
}

const svcIcon = (s) => (s.state === 'running' ? (s.health && s.health !== 'healthy' ? '⚠' : '✔') : '✖');

/** Rows for the terminal and for /server (kind/key/text like the other panels). */
export function statusRows(st) {
  const row = (key, text) => ({ kind: 'row', key, text: String(text) });
  const out = [{ kind: 'head', text: 'Server' }];
  out.push(row('Install', `${st.install.repoDir} (found via ${st.install.source}, project ${st.install.project})`));
  const i = st.installed;
  out.push(row('Version', `${i.release || '? no VERSION file'}${i.tag ? ` (${i.tag})` : ''} · checkout ${i.commit || '?'}${i.dirty ? ' · local changes' : ''}`));
  const rv = st.running;
  out.push(row('Running', rv.ok ? `${rv.commit || '?'}${rv.stamped === false ? ' (unstamped build)' : ''}${rv.commit && i.commit && !String(rv.commit).startsWith(i.commit) && !String(i.commit).startsWith(rv.commit) ? ' · differs from the checkout' : ''}` : `? ${rv.error}`));
  for (const h of st.http) out.push(row(`${h.ok ? '✔' : '✖'} ${h.name}`, `${h.url} · ${h.detail} · ${h.ms}ms`));
  if (!st.services.ok) out.push(row('✖ Services', `? ${st.services.error}`));
  else {
    const up = st.services.services.filter((s) => s.state === 'running').length;
    out.push(row('Services', `${up} of ${st.services.services.length} running`));
    for (const s of st.services.services) out.push({ kind: s.state === 'running' && (!s.health || s.health === 'healthy') ? 'dim' : 'row', key: `  ${svcIcon(s)} ${s.service}`, text: [s.state + (s.health ? ` (${s.health})` : ''), s.ports.join(' ')].filter(Boolean).join(' · ') });
  }
  out.push(row('Disk', st.disk.ok ? `${st.disk.freeGB} GB free of ${st.disk.sizeGB} GB (${st.disk.usedPct} used) at ${st.disk.path}` : `? ${st.disk.error}`));
  const lu = st.lastUpdate;
  out.push(row('Last update', lu ? `${lu.op} ${lu.status} ${lu.at}${lu.from ? ` · ${lu.from} -> ${lu.to || '?'}` : ''}` : 'none recorded by quox server update'));
  if (st.inFlight) out.push(row('⚠ In flight', `an update to ${st.inFlight.target} stopped after ${st.inFlight.done?.slice(-1)[0] || 'preflight'}; quox server update resumes it`));
  return out;
}

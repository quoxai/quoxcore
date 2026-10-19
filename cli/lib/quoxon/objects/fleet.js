/**
 * /fleet: computers, agents, missions and SubFleets in one compact block, with health. Read-only.
 * Sources (the same routes `quox fleet ...` and `quox objective list` use): GET /api/v1/agents
 * (heartbeats), GET /api/v1/fleet/hosts (Bastion registry), org agents, GET /api/objectives. A source
 * that could not be read is named on the "Can't see" line, never counted as zero. SubFleets have an
 * RFC but no API yet, so that row says so. Moving work is not here: the hint points at plain words.
 */
import { seg, fit, fitRow, ago, plural, boxWidth } from './model.js';
import { fromObjective } from '../roster.js';

const OFFLINE = /^(dead|offline|down|disconnected|unreachable)$/;
const HEALTHY = /^(healthy|ok|good)$/;
const DEGRADED = /^(warning|warn|degraded|stale)$/;
const UNHEALTHY = /^(critical|unhealthy|error|failed|fail)$/;
const FLEET_OVERVIEW_WORDS = new Set(['health', 'status', 'list', 'all', 'overview', 'summary', 'hosts', 'agents', 'quoxagents']);

export const ORDER = ['healthy', 'degraded', 'unhealthy', 'offline', 'unknown'];
const SEVERITY = { unhealthy: 0, offline: 1, degraded: 2, unknown: 3, healthy: 4 };

/** A heartbeat row or a Bastion host row -> healthy | degraded | unhealthy | offline | unknown. */
export function healthOf(row) {
  const s = row?.status;
  const st = String(typeof s === 'object' && s ? s.state ?? '' : s ?? '').toLowerCase();
  const h = String(typeof s === 'object' && s ? s.health ?? '' : '').toLowerCase();
  if (OFFLINE.test(st) || OFFLINE.test(h)) return 'offline';
  if (UNHEALTHY.test(h) || UNHEALTHY.test(st)) return 'unhealthy';
  if (DEGRADED.test(h) || DEGRADED.test(st)) return 'degraded';
  if (HEALTHY.test(h) || HEALTHY.test(st)) return 'healthy';
  return 'unknown';
}

const listOk = (s) => (s?.ok ? s.list || [] : null);

/** d: { agents, hosts, orgAgents, missions } each { ok, list } | { ok:false, error } -> merged view model. */
export function collectFleet(d, now = Date.now()) {
  const byId = new Map();
  const cant = [];
  const sources = [['heartbeats', d.agents], ['hosts', d.hosts]];
  for (const [label, src] of sources) {
    if (!src) continue;
    if (!src.ok) { cant.push(`${label} (${src.error || 'failed'})`); continue; }
    for (const r of src.list || []) {
      const id = r.host_id || r.id || r.hostname;
      if (!id) continue;
      const cur = byId.get(id) || { id };
      if (label === 'heartbeats') {
        const s = r.status;
        byId.set(id, { ...cur, health: healthOf(r), version: r.version ?? cur.version, lastSeenS: typeof s === 'object' ? s?.last_seen_seconds : undefined, heartbeat: true });
      } else {
        byId.set(id, { ...cur, ip: r.ip ?? cur.ip, group: r.group ?? cur.group, registryHealth: healthOf(r), health: cur.heartbeat ? cur.health : healthOf(r) });
      }
    }
  }
  const computers = [...byId.values()].sort((a, b) => SEVERITY[a.health] - SEVERITY[b.health] || a.id.localeCompare(b.id));
  const counts = Object.fromEntries(ORDER.map(k => [k, 0]));
  for (const c of computers) counts[c.health]++;
  const org = listOk(d.orgAgents);
  if (d.orgAgents && !d.orgAgents.ok) cant.push(`agents (${d.orgAgents.error || 'failed'})`);
  const agents = org ? { active: org.filter(a => !a.status || a.status === 'active').length, other: org.filter(a => a.status && a.status !== 'active').length } : null;
  let missions = null;
  if (d.missions && !d.missions.ok) cant.push(`missions (${d.missions.error || 'failed'})`);
  else if (d.missions) {
    const rows = (d.missions.list || []).map(o => fromObjective(o, now)).filter(Boolean);
    missions = { running: rows.filter(r => r.state === 'running').length, waiting: rows.filter(r => r.state === 'waiting').length, loops: rows.filter(r => r.kind === 'loop' && (r.state === 'running' || r.state === 'waiting')).length, rows: rows.filter(r => r.state === 'running' || r.state === 'waiting') };
  }
  return { computers, counts, agents, missions, cant };
}

const ROLE = { healthy: 'ok', degraded: 'warn', unhealthy: 'error', offline: 'error', unknown: 'muted' };
const HINT = 'ask in plain words to move work';

/** d: { agents, hosts, orgAgents, missions, now } -> view { box, rows } */
export function fleetCard(d, cols) {
  const now = d.now ?? Date.now();
  const f = collectFleet(d, now);
  const w = boxWidth(cols, 78), inner = w - 4;
  const L = (label, parts) => [seg(label.padEnd(12), 'muted'), ...parts];
  const rows = [];
  if (f.computers.length || (d.agents?.ok || d.hosts?.ok)) {
    const bits = [];
    for (const k of ORDER) if (f.counts[k]) { if (bits.length) bits.push(seg(' · ', 'muted')); bits.push(seg(`${f.counts[k]} ${k}`, ROLE[k], k !== 'healthy')); }
    rows.push(L('Computers', [seg(`${f.computers.length}  `, 'value', true), ...bits]));
    const bad = f.computers.filter(c => c.health !== 'healthy');
    if (bad.length) rows.push([seg('not healthy'.padEnd(12), 'muted'), seg(fit(bad.map(c => `${c.id} ${c.health}`).join(', '), inner - 12), 'warn')]);
  } else rows.push(L('Computers', [seg('?', 'warn'), seg(' not read', 'muted')]));
  rows.push(f.agents ? L('Agents', [seg(`${f.agents.active} active`, 'value'), ...(f.agents.other ? [seg(` · ${f.agents.other} other`, 'muted')] : [])]) : L('Agents', [seg('?', 'warn')]));
  if (f.missions) {
    const m = f.missions;
    const extra = [m.waiting ? plural(m.waiting, 'waiting', 'waiting') : null, m.loops ? plural(m.loops, 'loop') : null].filter(Boolean);
    rows.push(L('Missions', [seg(`${m.running} running`, 'value'), ...(extra.length ? [seg(` · ${extra.join(' · ')}`, 'muted')] : [])]));
    for (const r of m.rows.slice(0, 3)) rows.push([seg('  ', 'muted'), seg(fit(`${r.name}${r.activity ? ` · ${r.activity}` : ''}`, inner - 2), 'muted')]);
    if (m.rows.length > 3) rows.push([seg(`  …and ${m.rows.length - 3} more`, 'muted')]);
  } else rows.push(L('Missions', [seg('?', 'warn')]));
  rows.push(L('SubFleets', [seg('none yet', 'muted'), seg(w < 60 ? '' : ' (designed, no API in this Quox)', 'muted')]));
  if (f.cant.length) rows.push([seg("Can't see ", 'warn'), seg(fit(f.cant.join(', '), inner - 12), 'warn')]);
  rows.push([seg(HINT, 'muted')]);
  return { box: { width: w, title: 'Fleet', titleRole: 'sky', border: 'sky' }, rows: rows.map(r => fitRow(r, inner)) };
}

/** d: { host, now } -> view for one computer. */
export function hostCard(d, cols) {
  const h = d.host;
  const w = boxWidth(cols, 66), inner = w - 4;
  const L = (label, v, role = 'value') => [seg(label.padEnd(8), 'muted'), seg(fit(v, inner - 8), role)];
  const rows = [L('health', h.health, ROLE[h.health])];
  if (h.ip) rows.push(L('ip', h.ip));
  if (h.group) rows.push(L('group', h.group));
  if (h.version) rows.push(L('version', h.version));
  if (typeof h.lastSeenS === 'number') rows.push(L('seen', `${ago(Date.now() - h.lastSeenS * 1000, Date.now()) || '0s'} ago`, 'muted'));
  if (!h.heartbeat) rows.push(L('agent', 'no heartbeat (in the registry only)', 'muted'));
  rows.push([seg(HINT, 'muted')]);
  return { box: { width: w, title: h.id, titleRole: 'sky', right: h.health, rightRole: ROLE[h.health], border: 'sky' }, rows };
}

/** Builder registered as BUILDERS.fleet: one host when d.host is set, else the whole fleet. */
export function fleetView(d, cols) { return d.host ? hostCard(d, cols) : fleetCard(d, cols); }

/** Fetchers for createObjectsApi (kept here so fetch.js only spreads them in). */
export function fleetFetchers({ get, org, listOf, why, resolveEndpoint }) {
  const read = async (fn) => { try { return { ok: true, list: await fn() }; } catch (e) { return { ok: false, error: why(e) }; } };
  return {
    /** Host ids for /fleet <TAB>: [{ value, desc }]; a failed read suggests nothing. */
    async fleetNames() {
      const hb = resolveEndpoint('v1.agents.list');
      const rows = listOf(await get(hb.service, hb.path, undefined, 6000), 'agents');
      return rows.map(r => r.host_id || r.id).filter(Boolean).map(id => ({ value: String(id), desc: healthOf(rows.find(r => (r.host_id || r.id) === id)) }));
    },
    /** E-fleet: name '' = the whole fleet, else one computer by id (case-insensitive, then prefix). */
    async fleet(name) {
      const q = String(name || '').trim().toLowerCase();
      const hb = resolveEndpoint('v1.agents.list'), hs = resolveEndpoint('v1.fleet.hosts.list'), ob = resolveEndpoint('objectives.list');
      const [agents, hosts, orgAgents, missions] = await Promise.all([
        read(async () => listOf(await get(hb.service, hb.path, undefined, 10000), 'agents')),
        read(async () => listOf(await get(hs.service, hs.path, undefined, 10000), 'hosts')),
        org() ? read(async () => { const ep = resolveEndpoint('agents.list', { orgId: org() }); return listOf(await get(ep.service, ep.path, { includeTools: 'false' }, 10000), 'agents', 'data'); }) : Promise.resolve(null),
        read(async () => listOf(await get(ob.service, ob.path, { limit: 100 }, 10000), 'objectives'))
      ]);
      const data = { agents, hosts, orgAgents, missions, now: Date.now() };
      if (!q) return { data };
      const f = collectFleet(data, data.now);
      const host = f.computers.find(c => c.id.toLowerCase() === q) || f.computers.find(c => c.id.toLowerCase().startsWith(q));
      if (host) return { data: { host, now: data.now } };
      // owner 2026-10-15 typed "/fleet health": overview words mean the whole fleet (a real host by that name still wins above)
      if (FLEET_OVERVIEW_WORDS.has(q)) return { data };
      if (!agents.ok && !hosts.ok) return { error: `Couldn't check hosts: ${agents.error}.`, tone: 'warn' }; // a failed list is never "no such host"
      return { error: `No host called "${name}". /fleet lists them.`, tone: 'warn' };
    }
  };
}

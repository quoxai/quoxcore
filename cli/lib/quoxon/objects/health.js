/**
 * /health (and /core): a compact summary of what the Core dashboard's overview (/dashboard) shows.
 * Read-only, no model call, server-side reads only (the same truth the dashboard reads):
 *   services   GET collector /api/v1/health/aggregate (the dashboard's service ring)
 *   computers  GET /api/v1/agents heartbeats + GET /api/v1/fleet/hosts (as /fleet)
 *   agents     org agents (as /fleet)
 *   approvals  GET auth /api/orgs/:org/inbox/stats (the dashboard's "Attention needed")
 *   missions   GET tasks /api/objectives (the dashboard's live objectives)
 *   failures   GET quoxflow /api/executions?status=failed&since=24h
 *   licence    GET auth /api/setup/licensing/entitlements
 * A section whose read failed says "unavailable: <reason>"; an error body is never shown as zero.
 * /status stays the session panel; /collector-health still goes to /status.
 */
import { seg, fit, fitRow, plural, boxWidth } from './model.js';
import { collectFleet, fleetFetchers } from './fleet.js';

const DAY_MS = 24 * 3600 * 1000;
const SVC_ROLE = { ok: 'ok', degraded: 'warn', down: 'error' };
const reasons = (...srcs) => [...new Set(srcs.filter(s => s && !s.ok).map(s => s.error || 'failed'))].join(', ');

/** d: { aggregate, agents, hosts, orgAgents, missions, inbox, failures, licence, now } -> per-section model ({ error } when unread). */
export function collectHealth(d) {
  const now = d.now ?? Date.now();
  const out = {};

  const a = d.aggregate;
  if (!a?.ok) out.services = { error: a?.error || 'not read' };
  else {
    const all = Object.entries(a.data?.services || {});
    // Z2H run-6: an optional service this install does not ship (collector says not_installed) is neither up nor down.
    const entries = all.filter(([, s]) => s?.status !== 'not_installed');
    out.services = {
      up: entries.filter(([, s]) => s?.status === 'ok').length,
      total: entries.length,
      score: typeof a.data?.score === 'number' ? a.data.score : null,
      bad: entries.filter(([, s]) => s?.status !== 'ok').map(([name, s]) => ({ name, status: s?.status || 'unknown' })),
      notInstalled: all.filter(([, s]) => s?.status === 'not_installed').map(([name]) => name),
    };
  }

  const f = collectFleet({ agents: d.agents, hosts: d.hosts, orgAgents: d.orgAgents, missions: d.missions }, now);
  if (d.agents?.ok || d.hosts?.ok) {
    out.computers = { healthy: f.counts.healthy, total: f.computers.length, bad: f.computers.filter(c => c.health !== 'healthy').map(c => ({ id: c.id, health: c.health })), partial: reasons(d.agents, d.hosts) || null };
  } else out.computers = { error: reasons(d.agents, d.hosts) || 'not read' };

  if (!d.orgAgents) out.agents = { error: 'no org selected' };
  else out.agents = f.agents ? { ...f.agents } : { error: d.orgAgents.error || 'failed' };

  out.missions = f.missions ? { running: f.missions.running, waiting: f.missions.waiting, loops: f.missions.loops } : { error: d.missions?.error || 'not read' };

  const ib = d.inbox;
  if (!ib?.ok) out.approvals = { error: ib?.error || 'not read' };
  else {
    const s = ib.data || {};
    out.approvals = { approvals: Number(s.pending_approvals) || 0, active: Number(s.total_active) || 0, urgent: Number(s.urgent) || 0, overdue: Number(s.overdue) || 0 };
  }

  const fl = d.failures;
  if (!fl?.ok) out.failures = { error: fl?.error || 'not read' };
  else {
    const list = fl.list || [];
    const r = list[0];
    out.failures = { count: typeof fl.total === 'number' ? fl.total : list.length, last: r ? (r.workflowName || r.workflow_name || r.name || r.workflowId || r.workflow_id || r.id || null) : null };
  }

  const li = d.licence;
  if (!li?.ok) out.licence = { error: li?.error || 'not read' };
  else {
    const L = li.data || {};
    const leases = Array.isArray(L.licenses) ? L.licenses : [];
    const plugins = Array.isArray(L.entitlements) ? L.entitlements.length : 0;
    const errors = Array.isArray(L.entitlement_errors) ? L.entitlement_errors.length : 0;
    if (!leases.length) out.licence = { core: true, plugins, errors };
    else {
      const plans = [...new Set(leases.flatMap(x => Array.isArray(x.plans) ? x.plans : []))];
      const exp = leases.map(x => Date.parse(x.expires_at)).filter(Number.isFinite).sort((x, y) => x - y)[0];
      out.licence = { core: false, plans, plugins, errors, expiresAt: Number.isFinite(exp) ? exp : null, expired: Number.isFinite(exp) && exp < now };
    }
  }
  return out;
}

/** Overall verdict for the title: partial (a section unread) > needs attention > all good. */
function verdict(h) {
  if (Object.values(h).some(s => s?.error)) return ['partial', 'warn'];
  const attention = h.services.up < h.services.total || h.computers.bad.length || h.failures.count || h.approvals.approvals || h.approvals.urgent || h.approvals.overdue || h.licence.errors || h.licence.expired;
  return attention ? ['needs attention', 'warn'] : ['all good', 'ok'];
}

const HINT = [seg('/fleet', 'key'), seg(' computers · ', 'label'), seg('/status', 'key'), seg(' this session · ', 'label'), seg('/dashboard', 'key'), seg(' open it', 'label')];

/** d -> view { box, rows }. */
export function healthCard(d, cols) {
  const h = collectHealth(d);
  const w = boxWidth(cols, 78), inner = w - 4;
  const L = (label, parts) => [seg(label.padEnd(11), 'label'), ...parts];
  const na = (s) => [seg('unavailable: ', 'warn'), seg(s.error, 'warn')];
  const sep = () => seg(' · ', 'label');
  const rows = [];

  const s = h.services;
  if (s.error) rows.push(L('Services', na(s)));
  else {
    const parts = [seg(`${s.up}/${s.total} up`, s.up === s.total ? 'ok' : 'warn', true)];
    for (const b of s.bad) parts.push(sep(), seg(`${b.name} ${b.status}`, SVC_ROLE[b.status] || 'warn'));
    for (const n of s.notInstalled || []) parts.push(sep(), seg(`${n} not installed`, 'value'));
    rows.push(L('Services', parts));
  }

  const c = h.computers;
  if (c.error) rows.push(L('Computers', na(c)));
  else if (!c.total) rows.push(L('Computers', [seg('none connected', 'value')]));
  else {
    const parts = [seg(`${c.healthy}/${c.total} healthy`, c.healthy === c.total ? 'ok' : 'warn', true)];
    if (c.bad.length) parts.push(sep(), seg(fit(c.bad.map(x => `${x.id} ${x.health}`).join(', '), inner), c.bad.some(x => x.health === 'offline' || x.health === 'unhealthy') ? 'error' : 'warn'));
    if (c.partial) parts.push(sep(), seg(`partial: ${c.partial}`, 'warn'));
    rows.push(L('Computers', parts));
  }

  const ag = h.agents;
  rows.push(L('Agents', ag.error ? na(ag) : [seg(`${ag.active} active`, 'value', true), ...(ag.other ? [sep(), seg(`${ag.other} other`, 'value')] : [])]));

  const ap = h.approvals;
  if (ap.error) rows.push(L('Approvals', na(ap)));
  else {
    const parts = [seg(ap.approvals ? `${ap.approvals} open` : 'none open', ap.approvals ? 'warn' : 'ok', true)];
    if (ap.active) parts.push(sep(), seg(`${ap.active} in inbox`, 'value'));
    if (ap.urgent) parts.push(sep(), seg(`${ap.urgent} urgent`, 'error'));
    if (ap.overdue) parts.push(sep(), seg(`${ap.overdue} overdue`, 'error'));
    rows.push(L('Approvals', parts));
  }

  const m = h.missions;
  if (m.error) rows.push(L('Missions', na(m)));
  else {
    const parts = [seg(`${m.running} running`, 'value', true)];
    if (m.waiting) parts.push(sep(), seg(`${m.waiting} waiting`, 'warn'));
    if (m.loops) parts.push(sep(), seg(plural(m.loops, 'loop'), 'value'));
    rows.push(L('Missions', parts));
  }

  const fl = h.failures;
  if (fl.error) rows.push(L('Failures', na(fl)));
  else if (!fl.count) rows.push(L('Failures', [seg('none in 24h', 'ok')]));
  else rows.push(L('Failures', [seg(`${plural(fl.count, 'failed run')} in 24h`, 'error', true), ...(fl.last ? [sep(), seg(`last: ${fl.last}`, 'value')] : [])]));

  const li = h.licence;
  if (li.error) rows.push(L('Licence', na(li)));
  else {
    const parts = li.core ? [seg('Core (free)', 'value', true)] : [seg(li.plans.length ? li.plans.join(', ') : 'licensed', 'value', true)];
    if (li.plugins) parts.push(sep(), seg(plural(li.plugins, 'plugin'), 'value'));
    if (!li.core && li.expiresAt) parts.push(sep(), seg(li.expired ? `expired ${new Date(li.expiresAt).toISOString().slice(0, 10)}` : `until ${new Date(li.expiresAt).toISOString().slice(0, 10)}`, li.expired ? 'error' : 'value'));
    if (li.errors) parts.push(sep(), seg(plural(li.errors, 'licence error'), 'error'));
    rows.push(L('Licence', parts));
  }

  rows.push(HINT);
  const [right, rightRole] = verdict(h);
  return { box: { width: w, title: 'Health', titleRole: 'sky', right, rightRole, border: 'sky' }, rows: rows.map(r => fitRow(r, inner)) };
}

/** Fetchers for createObjectsApi. Every read is bounded and every failure carries its reason. */
export function healthFetchers({ get, org, listOf, why, resolveEndpoint }) {
  const fleet = fleetFetchers({ get, org, listOf, why, resolveEndpoint });
  const read = async (fn) => { try { return { ok: true, ...(await fn()) }; } catch (e) { return { ok: false, error: why(e) }; } };
  const noOrg = { ok: false, error: 'no org selected' };
  return {
    /** -> { data } for the health card (now injectable for tests). */
    async health(now = Date.now()) {
      const ag = resolveEndpoint('v1.health.aggregate.list'), ex = resolveEndpoint('executions.list'), lic = resolveEndpoint('setup.licensing.entitlements.list');
      const o = org();
      const [fl, aggregate, inbox, failures, licence] = await Promise.all([
        fleet.fleet(''),
        read(async () => ({ data: await get(ag.service, ag.path, undefined, 15000) })),
        o ? read(async () => { const ep = resolveEndpoint('inbox.stats.list', { orgId: o }); return { data: await get(ep.service, ep.path, undefined, 8000) }; }) : Promise.resolve(noOrg),
        read(async () => {
          const d = await get(ex.service, ex.path, { status: 'failed', since: new Date(now - DAY_MS).toISOString(), limit: 5 }, 8000);
          const total = d?.pagination?.total;
          return { list: listOf(d, 'data', 'executions'), total: typeof total === 'number' ? total : undefined };
        }),
        read(async () => ({ data: await get(lic.service, lic.path, undefined, 8000) })),
      ]);
      return { data: { ...fl.data, aggregate, inbox, failures, licence, now } };
    }
  };
}

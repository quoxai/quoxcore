/**
 * HYPERION activity: the shared reader and plain-text renderers behind `quox hyperion`,
 * `quox hyperion deck` and the QUOXON /hyperion command. Pure functions over the
 * GET /api/v1/proxmox/activity payload; no colour (callers paint), no grey, labels not bare values.
 */
import { resolveEndpoint } from '../api/endpoints.js';

export function fetchActivity(client) {
  const ep = resolveEndpoint('v1.proxmox.activity');
  return client.get(ep.path, { service: ep.service });
}

const ms = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};

function span(delta) {
  const s = Math.max(0, Math.floor(delta / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Expiry wins ("expires in 3h" / "expired 1h ago"), else how long it has been held, else "-". */
export function whenText(held, now = Date.now()) {
  const exp = ms(held && held.expires);
  if (exp != null) return exp >= now ? `expires in ${span(exp - now)}` : `expired ${span(now - exp)} ago`;
  const since = ms(held && held.since);
  if (since != null) return `held ${span(now - since)}`;
  return '-';
}

export function holderText(held) {
  const h = held || {};
  if (h.source === 'pool') return h.lessee ? `${h.lessee} (pool)` : 'free (pool)';
  if (h.source === 'lane') return `${h.lessee || 'unknown'} (lane)`;
  return 'nobody recorded';
}

const isHeld = (v) => Boolean(v.held_by && v.held_by.lessee);
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '?');
const gb = (b) => (typeof b === 'number' ? (b / 1e9).toFixed(1) : '?');
const clipTo = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Full one-shot view: VM table, node load, pool counts, last 5 ops. */
export function statusLines(data, { now = Date.now() } = {}) {
  const d = data || {};
  const out = [];
  const vms = d.vms || [];
  if (!vms.length) out.push('No VMs are held or pooled right now.');
  else {
    const rows = vms.map((v) => [String(v.vmid), v.name || '', v.node || '', v.status || '', holderText(v.held_by), (v.held_by && v.held_by.purpose) || '-', whenText(v.held_by, now)]);
    const head = ['VMID', 'NAME', 'NODE', 'STATUS', 'HELD BY', 'PURPOSE', 'AGE / EXPIRY'];
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
    out.push(fmt(head), ...rows.map(fmt));
  }
  if (d.vms_truncated) out.push(`⚠ ${d.vms_truncated} more tagged VMs not shown`);
  if (d.vm_config_errors) out.push(`⚠ ${d.vm_config_errors} VM description(s) could not be read, holder taken from tags`);
  out.push('');
  out.push('Node load');
  if (d.nodes_error) out.push(`  Node load unavailable: ${d.nodes_error}`);
  else if (!(d.nodes || []).length) out.push('  no nodes reported');
  else for (const n of d.nodes) out.push(`  ${String(n.node).padEnd(10)} ${String(n.status).padEnd(8)} cpu ${pct(n.cpu)}   mem ${gb(n.mem_used)}/${gb(n.mem_total)} GB`);
  out.push('');
  if (d.pool) {
    const counts = Object.entries(d.pool.counts || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'no VMs';
    out.push(`Pool: ${d.pool.enabled ? 'enabled' : 'disabled'}, ${counts}${d.pool.paused ? ' (paused, waiting for approval)' : ''}`);
  } else out.push(`Pool unavailable: ${d.pool_error || 'unknown'}`);
  out.push('');
  if (d.ops_error) out.push(`Recent ops unavailable: ${d.ops_error}`);
  else {
    const ops = (d.recent_ops || []).slice(0, 5);
    out.push(`Recent ops (${ops.length})`);
    if (!ops.length) out.push('  none recorded');
    for (const o of ops) out.push(`  ${o.ts}  ${o.intent}  vmid ${o.vmid ?? '-'}  by ${o.actor || '?'}  outcome ${o.outcome ?? '-'}`);
  }
  return out;
}

/** Compact list for the TUI: a header, then one line per held VM. */
export function heldLines(data, { now = Date.now(), width = 100 } = {}) {
  const held = ((data && data.vms) || []).filter(isHeld);
  if (!held.length) return ['No VMs are held right now.'];
  const lines = [`${held.length} held`];
  for (const v of held) {
    const purpose = v.held_by.purpose ? `, ${v.held_by.purpose}` : '';
    lines.push(clipTo(`${v.vmid} ${v.name || ''} on ${v.node || '?'} ${v.status || ''}: held by ${holderText(v.held_by)}${purpose}, ${whenText(v.held_by, now)}`, width));
  }
  return lines;
}

/** Result text for the QuoxGlyph header line. */
export function summaryText(data) {
  const vms = (data && data.vms) || [];
  return `${vms.length} VMs · ${vms.filter(isHeld).length} held`;
}

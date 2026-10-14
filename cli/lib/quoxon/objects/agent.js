/**
 * E4 agent card. Sources: the shipped assistant identity (name, tagline), the org agent record
 * (description, status, model when its config carries one), the collector's agent -> tools map
 * (GET /api/v1/tools/agents), slots (GET /api/v1/slots: a slot named after the agent, or assigned
 * to it), and the agent's last AEE envelope (GET /aee/query?from=agent.<id>&limit=1) with its WARD
 * receipt when verify-receipt answered. There is no per-agent model in the shipped config (models
 * are routed per turn), so the model row appears only when the server record names one.
 */
import { seg, fit, ago, short, boxWidth } from './model.js';
import { providerOf } from '../theme.js';

/** The model an org agent record names, if any: config_json.{model,provider}. */
export function modelOf(record) {
  let cfg = record?.config_json ?? record?.config ?? null;
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
  const model = cfg?.model || cfg?.llm?.model || null;
  const provider = cfg?.provider || cfg?.llm?.provider || null;
  return model || provider ? { model, provider } : null;
}

/** A slot belongs to an agent when it is named after it or assigned to it. */
export function slotFor(slots, id) {
  const n = String(id || '').toLowerCase();
  return (slots || []).find(s => String(s.name || '').toLowerCase() === n || String(s.assigned_to || '').toLowerCase() === n) || null;
}

/**
 * d: { id, name, tagline, description, status, record, tools: [] | null, slot, last: envelope | null,
 *      lastErr, receipt: { ok, result } | null, now }
 */
export function agentCard(d, cols) {
  const now = d.now ?? Date.now();
  const w = boxWidth(cols, 72), inner = w - 4, nw = w < 56;
  const nm = String(d.name || d.id || 'agent');
  const tag = d.tagline ? (nw ? '' : ` · ${d.tagline}`) : '';
  const right = d.slot ? (nw ? `slot ${d.slot.name}` : `slot ${d.slot.name} · ${d.slot.state || 'unknown'}`) : '';
  const rows = [];
  const L = (label, value, role = 'value') => [seg(label.padEnd(6), 'muted'), ...(Array.isArray(value) ? value : [seg(fit(value, inner - 6), role)])];
  if (d.description) rows.push(L('role', d.description));
  if (d.status && d.status !== 'active') rows.push(L('state', d.status, 'warn'));
  const m = modelOf(d.record);
  if (m) {
    const p = providerOf(m.provider, m.model);
    rows.push(L('model', [seg(fit(m.model || m.provider, inner - 6), p ? `provider:${p}` : 'value')]));
  }
  if (Array.isArray(d.tools)) rows.push(L('tools', d.tools.length ? `${d.tools.length}: ${d.tools.join(', ')}` : 'none assigned'));
  else if (d.toolsErr) rows.push(L('tools', `could not read (${d.toolsErr})`, 'warn'));
  if (d.slot?.holder_session && d.slot.state === 'held') rows.push(L('held', `by ${d.slot.holder_session}${d.slot.last_heartbeat_at ? ` · heartbeat ${ago(d.slot.last_heartbeat_at, now)} ago` : ''}`, 'muted'));
  if (d.last) {
    const what = d.last.payload?.tool_name || d.last.intent || 'action';
    const when = d.last.ts ? `${ago(d.last.ts, now)} ago` : '';
    const r = d.receipt?.ok ? d.receipt.result : null;
    if (r?.status === 'WITNESSED') rows.push(L('last', [seg('◉ ', 'proto:ward'), seg(fit(`${what} · WARD seq ${r.entry?.seq} witnessed · ${when}`, inner - 8), 'muted')]));
    else {
      const w8 = r?.status === 'NOT_WITNESSED' ? 'not witnessed yet' : r?.status === 'UNTIPPED' ? `WARD seq ${r.entry?.seq}, no signed tip yet` : d.receipt && !d.receipt.ok ? 'WARD did not answer' : 'witness not checked';
      rows.push(L('last', [seg('· ', 'muted'), seg(fit(`${what} · ${w8} · ${when} · ${short(d.last.id, 14)}`, inner - 8), 'muted')]));
    }
  } else if (d.lastErr) rows.push(L('last', `could not read (${d.lastErr})`, 'warn'));
  else rows.push(L('last', 'no recorded action', 'muted'));
  return { box: { width: w, title: `● ${nm.toUpperCase()}${tag}`, titleRole: `agent:${d.id || nm}`, right, rightRole: 'muted', border: 'violet' }, rows };
}

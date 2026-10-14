/**
 * D1 evidence integrity chain and D3 reconciliation for one tool call of this session.
 *   AEE   the call's envelope, read back (GET /aee/:envelope_id)
 *   AOCL  aocl.* envelopes on the same correlation id (GET /aee/query?corr=)
 *   TOOL  what the server recorded for the call (payload.success / tool_name) vs what the stream said
 *   WARD  the envelope's inclusion receipt (POST /ward/verify-receipt, server-verified, bounded)
 * A link is drawn confirmed only when its read succeeded and said so. Nothing is recomputed locally,
 * so the card says the server's WARD verified it, never "recomputed locally".
 *
 * D3: a tool that ended effect_unknown is reconciled against the server's own record of the call
 * (the ops.tool envelope's payload.success). No envelope id means it cannot be reconciled from here.
 */
import { seg, fit, short, plural } from './model.js';

const LINKS = ['AEE', 'AOCL', 'TOOL', 'WARD'];

/** -> [{ name, ok: true|false|null, sub }] in chain order. ok null = not confirmed (unknown). */
export function chainLinks(d) {
  const t = d.tool || {};
  const env = d.envelope?.ok ? d.envelope.env : null;
  const out = [];
  out.push(env ? { name: 'AEE', ok: true, sub: `envelope ${short(env.id || t.envelopeId, 14)}` }
    : { name: 'AEE', ok: d.envelope?.status === 404 ? false : null, sub: d.envelope?.status === 404 ? 'envelope not found' : `envelope not read${d.envelope?.error ? ` (${fit(d.envelope.error, 24)})` : ''}` });
  const aocl = d.aocl?.ok ? d.aocl.list || [] : null;
  if (aocl && aocl.length) {
    const has = (i) => aocl.some(e => e.intent === i);
    const pol = aocl.filter(e => e.intent === 'aocl.policy.evaluated');
    const polOk = pol.length ? pol.every(e => e.payload?.allPassed !== false) : null;
    const bits = [];
    if (has('aocl.identity.verified')) bits.push('identity');
    if (polOk != null) bits.push(polOk ? 'policy ok' : 'policy blocked');
    out.push({ name: 'AOCL', ok: polOk === false ? false : true, sub: bits.length ? bits.join(' + ') : plural(aocl.length, 'AOCL record') });
  } else out.push({ name: 'AOCL', ok: null, sub: aocl ? 'no AOCL record on this corr' : `not read${d.aocl?.error ? ` (${fit(d.aocl.error, 20)})` : ''}` });
  const rec = env?.payload || null;
  if (rec && rec.success != null) {
    const want = t.status === 'ok';
    const match = Boolean(rec.success) === want || t.status === 'effect_unknown';
    out.push({ name: 'TOOL', ok: match && Boolean(rec.success), sub: `${rec.tool_name || t.tool || 'tool'} ${rec.success ? 'succeeded' : 'failed'}${match ? '' : ` (stream said ${t.status})`}` });
  } else out.push({ name: 'TOOL', ok: null, sub: `${t.tool || 'tool'} ${t.status || ''} (no server record)`.trim() });
  const r = d.receipt?.ok ? d.receipt.result : null;
  if (r?.status === 'WITNESSED') out.push({ name: 'WARD', ok: true, sub: `witnessed seq ${r.entry?.seq}` });
  else if (r?.status === 'UNTIPPED') out.push({ name: 'WARD', ok: null, sub: `seq ${r.entry?.seq}, no signed tip yet` });
  else if (r?.status === 'NOT_WITNESSED') out.push({ name: 'WARD', ok: null, sub: 'not witnessed yet' });
  else if (r?.status) out.push({ name: 'WARD', ok: false, sub: `${r.status}${r.reason ? ` ${r.reason}` : ''}` });
  else out.push({ name: 'WARD', ok: null, sub: d.receipt?.timeout ? `no answer in ${d.receipt.timeout}s` : `not checked${d.receipt?.error ? ` (${fit(d.receipt.error, 24)})` : ''}` });
  return out;
}

const markOf = (ok) => (ok === true ? ['✔', 'ok'] : ok === false ? ['✖', 'error'] : ['○', 'faint']);

/** d: { tool, envelope, aocl, receipt } -> view { rows } (wide row at >= 90 cols, vertical below). */
export function proofChain(d, cols) {
  const links = chainLinks(d);
  const rows = [];
  rows.push([seg('proof ', 'muted'), seg(fit(`${d.tool?.tool || 'tool call'}${d.tool?.envelopeId ? ` · ${short(d.tool.envelopeId, 18)}` : ''}`, cols - 10), 'value', true)]);
  if (cols >= 90) {
    const head = [], sub = [], cw = Math.max(23, Math.floor((cols - 4) / 4));
    links.forEach((l, i) => {
      const role = `proto:${l.name.toLowerCase() === 'tool' ? 'volt' : l.name.toLowerCase()}`;
      head.push(seg(l.name, l.name === 'TOOL' ? 'value' : role, true));
      sub.push(seg(fit(l.sub, cw - 1).padEnd(i < 3 ? cw : 0), l.ok === false ? 'error' : 'muted'));
      if (i < 3) {
        const linked = l.ok === true && links[i + 1].ok === true;
        head.push(seg(' ' + (linked ? '━' : '╌').repeat(cw - 2 - l.name.length) + ' ', linked ? 'indigo' : 'faint'));
      }
    });
    rows.push(head, sub);
  } else {
    links.forEach((l, i) => {
      const role = `proto:${l.name.toLowerCase() === 'tool' ? 'volt' : l.name.toLowerCase()}`;
      const [m, mr] = markOf(l.ok);
      rows.push([seg(m, mr), seg(' '), seg(l.name.padEnd(5), l.name === 'TOOL' ? 'value' : role, true), seg(fit(l.sub, cols - 12), l.ok === false ? 'error' : 'muted')]);
      if (i < 3) rows.push([seg(l.ok === true && links[i + 1].ok === true ? '┃' : '╎', l.ok === true && links[i + 1].ok === true ? 'indigo' : 'faint')]);
    });
  }
  const n = links.filter(l => l.ok === true).length;
  const bad = links.filter(l => l.ok === false).length;
  if (n === 4) rows.push([seg('✔ ', 'ok'), seg(cols < 60 ? 'chain verified · 4 links' : 'chain verified · 4 links · WARD receipt checked by the server', 'value')]);
  else rows.push([seg(bad ? '✖ ' : '◐ ', bad ? 'error' : 'warn'), seg(`${n} of 4 links confirmed${bad ? ` · ${bad} contradicted` : ''}`, bad ? 'error' : 'warn')]);
  return { rows, links };
}

/** One effect_unknown call reconciled against the server's record of it. */
export function reconcileItem(it) {
  if (!it.envelopeId) return { mark: '?', role: 'muted', state: 'unverified', why: 'no envelope id, cannot be checked from here' };
  if (!it.record) return { mark: '?', role: 'muted', state: 'unverified', why: it.error ? `record not read (${fit(it.error, 30)})` : 'not checked' };
  if (!it.record.ok) return { mark: '?', role: 'muted', state: 'unverified', why: it.record.status === 404 ? 'no server record of the call' : `record not read (${fit(it.record.error || '', 30)})` };
  const ok = it.record.env?.payload?.success;
  if (ok === true) return { mark: '✔', role: 'ok', state: 'confirmed', why: 'server recorded success' };
  if (ok === false) return { mark: '✖', role: 'error', state: 'mismatch', why: 'server recorded a failure, not done' };
  return { mark: '?', role: 'muted', state: 'unverified', why: 'server record has no outcome' };
}

/** d: { items: [{ tool, envelopeId, record }] } -> view { rows } */
export function reconcileView(d, cols) {
  const nw = cols < 60;
  const items = d.items || [];
  const rows = [[seg(nw ? `reconcile · ${items.length} unknown` : `reconcile · ${plural(items.length, 'call')} ended with effect unknown, checking each`, 'muted')]];
  let conf = 0, mis = 0;
  for (const it of items) {
    const r = reconcileItem(it);
    if (r.state === 'confirmed') conf++; else if (r.state === 'mismatch') mis++;
    const row = [seg(r.mark, r.role), seg(' '), seg(fit(it.tool || 'tool', 15).padEnd(16), 'value'), seg(r.state.padEnd(12), r.role === 'muted' ? 'muted' : r.role, r.state !== 'unverified')];
    if (!nw) row.push(seg(fit(r.why, cols - 34), 'muted'));
    rows.push(row);
  }
  const un = items.length - conf - mis;
  rows.push([seg(`${conf} confirmed · ${mis} mismatch · ${un} unverified`, mis ? 'warn' : 'muted')]);
  return { rows };
}

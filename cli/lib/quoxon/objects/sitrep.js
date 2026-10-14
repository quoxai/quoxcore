/**
 * /sitrep: the situation NOW, from persisted data only (no model call): approvals waiting (auth inbox),
 * what needs you (LUCID needs_you, by urgency), running work (LUCID in_motion), and what Quox cannot see
 * (LUCID silent / failing / unconnected feeds, plus any source this card could not read). /away is the
 * "since you were last here" digest; this is the present tense.
 */
import { seg, fit, plural, boxWidth, parseTs, ago } from './model.js';

const URG = { now: 0, today: 1, 'this week': 2, whenever: 3, fyi: 4 };
const hrs = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** sit/appr: { ok, v | error } parts. -> { approvals: [..]|null, needs, running, blind } */
export function sitrepData(sit, appr, now = Date.now()) {
  const blind = [];
  let needs = [], running = [];
  if (sit?.ok) {
    const s = sit.v?.situation || sit.v || {};
    needs = (s.needs_you || []).filter(n => n.kind !== 'approval')
      .map(n => ({ title: n.L0 || n.ref, urgency: n.urgency, ts: n.L1?.when?.since ?? n.status_since ?? null, ref: n.ref }))
      .sort((a, b) => (URG[a.urgency] ?? 5) - (URG[b.urgency] ?? 5) || (parseTs(b.ts) ?? 0) - (parseTs(a.ts) ?? 0));
    running = (s.in_motion || []).map(m => ({ title: m.L0 || m.ref, ref: m.ref }));
    const cs = s.cannot_see || {};
    for (const x of cs.silent || []) blind.push({ source: `lucid:${x.feed}`, reason: `silent ${hrs(x.silent_ms)}` });
    for (const x of cs.failing || []) blind.push({ source: `lucid:${x.feed}`, reason: `failing: ${x.error}` });
    for (const n of cs.unwired || []) blind.push({ source: `lucid:${n}`, reason: 'not connected' });
  } else blind.push({ source: 'lucid', reason: sit?.error || 'not read' });
  let approvals = null;
  if (appr?.ok) approvals = (appr.v || []).map(a => ({ title: a.title || a.summary || a.id, ts: a.created_at, ref: a.id }));
  else blind.push({ source: 'approvals', reason: appr?.error || 'not read' });
  return { approvals, needs, running, blind, now };
}

/** d: sitrepData(...) + now */
export function sitrepCard(d, cols, { maxNeeds = 5, maxRunning = 3, maxApprovals = 3 } = {}) {
  const now = d.now ?? Date.now();
  const w = boxWidth(cols, 96), inner = w - 4;
  const rows = [];
  const ap = d.approvals || [], needs = d.needs || [], run = d.running || [];
  const line = (g, role, title, meta) => {
    const m = meta ? `  ${meta}` : '';
    return [seg(g, role), seg(fit(title, Math.max(8, inner - 2 - m.length)), 'value'), seg(m, 'muted')];
  };
  for (const a of ap.slice(0, maxApprovals)) rows.push(line('⚠ ', 'warn', `Approval: ${a.title}`, a.ts ? `waiting ${ago(a.ts, now)}` : ''));
  if (ap.length > maxApprovals) rows.push([seg(`+${ap.length - maxApprovals} more approvals · /approvals`, 'muted')]);
  for (const n of needs.slice(0, maxNeeds)) rows.push(line(n.urgency === 'now' ? '⚠ ' : '◐ ', n.urgency === 'now' ? 'warn' : 'muted', n.title, n.urgency || ''));
  if (needs.length > maxNeeds) rows.push([seg(`+${needs.length - maxNeeds} more · quox lucid`, 'muted')]);
  if (!ap.length && !needs.length) rows.push([seg('Nothing needs you right now.', 'muted')]);
  if (run.length) {
    rows.push([seg(' ')]);
    for (const r of run.slice(0, maxRunning)) rows.push(line('◐ ', 'indigo', r.title, ''));
    if (run.length > maxRunning) rows.push([seg(`+${run.length - maxRunning} more running · /roster all`, 'muted')]);
  }
  if ((d.blind || []).length) rows.push([seg(fit(`Can't see: ${d.blind.map(b => (b.reason ? `${b.source} (${b.reason})` : b.source)).join(', ')}`, inner), 'faint')]);
  const right = w < 60
    ? [d.approvals ? `${ap.length} ap` : null, `${needs.length} need`, `${run.length} run`].filter(Boolean).join(' · ')
    : [d.approvals ? plural(ap.length, 'approval') : null, `${needs.length} need you`, `${run.length} running`].filter(Boolean).join(' · ');
  return { box: { width: w, title: 'Situation now', titleRole: 'value', right, rightRole: 'muted', border: ap.length || needs.some(n => n.urgency === 'now') ? 'warn' : 'muted' }, rows };
}

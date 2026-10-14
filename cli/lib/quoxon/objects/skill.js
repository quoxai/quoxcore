/**
 * E1 skill card from a real QSKL skill record (GET /quoxflow/skills/:id) plus, when reachable, its
 * quoxflow scoreboard row (GET /api/quox-skills/scoreboards). Tests: the record carries test
 * DEFINITIONS in `tests`; results exist only once run-tests has written `evals.tests`
 * ({ total, passed, failed, last_run_at, results }). Never shows a pass that was not recorded.
 */
import { seg, fit, ago, day, plural, short, boxWidth } from './model.js';

const EDITION_ROLE = { stable: 'ok', experimental: 'warn', archived: 'muted' };

/** -> { word, role } for the review state the record actually states. */
export function reviewState(s) {
  if (s?.reviewNeeded) return { word: 'review needed', role: 'warn' };
  const e = String(s?.edition || s?.status || '').toLowerCase();
  return e ? { word: e, role: EDITION_ROLE[e] || 'muted' } : { word: 'state unknown', role: 'muted' };
}

/** -> { dots:[{ch,role}], text, role } or null when the skill has no tests at all. */
export function testsSummary(s, now) {
  const run = s?.evals?.tests;
  if (run && Number.isFinite(Number(run.total))) {
    const total = Number(run.total), passed = Number(run.passed) || 0, failed = Number(run.failed) || 0;
    const res = Array.isArray(run.results) ? run.results : null;
    const dots = res && res.length === total
      ? res.map(r => ({ ch: '●', role: r.passed === true || r.status === 'passed' || r.ok === true ? 'ok' : 'error' }))
      : [...Array(passed).fill({ ch: '●', role: 'ok' }), ...Array(Math.max(0, total - passed)).fill({ ch: '●', role: 'error' })];
    const when = run.last_run_at ? ` · ${ago(run.last_run_at, now)} ago` : '';
    if (passed === total && total > 0) return { dots, text: `${passed}/${total} pass${when}`, role: 'ok' };
    return { dots, text: `${passed}/${total} pass · ${failed || total - passed} failing${when}`, role: 'error' };
  }
  const defined = s?.tests && typeof s.tests === 'object' ? Object.keys(s.tests).length : 0;
  if (!defined) return null;
  return { dots: Array(defined).fill({ ch: '○', role: 'muted' }), text: `${defined} defined · never run`, role: 'muted' };
}

const sourceOf = (s) => {
  const parts = [];
  if (s.category) parts.push(s.category);
  if (s.createdAt) parts.push(`created ${day(s.createdAt)}`);
  const tag = (s.tags || []).find(t => /^source:/.test(t));
  if (tag) parts.push(`from ${tag.split(':')[1] === 'notesq' ? 'NotesQ' : tag.split(':')[1]}`);
  if (s.authoringEnvelopeId) parts.push(`authored in ${short(s.authoringEnvelopeId, 12)}`);
  if (s.lastPatchedBy) parts.push('patched since');
  return parts.join(' · ');
};

/**
 * d: { skill, scoreboard: { ok, row } | null, agentName?: (id) => string, now }
 * -> view { box, rows }
 */
export function skillCard(d, cols) {
  const s = d.skill || {};
  const now = d.now ?? Date.now();
  const w = boxWidth(cols, 72), inner = w - 4, nw = w < 50;
  const rv = reviewState(s);
  const name = s.name || s.id;
  const right = s.version ? (nw ? `v${s.version}` : `v${s.version} · ${rv.word}`) : rv.word;
  const rows = [];
  if (s.description) rows.push([seg(fit(s.description, inner))]);
  if (nw) rows.push([seg(rv.word, rv.role)]);

  const agentName = d.agentName || ((id) => id);
  const agents = (s.bestForAgents || []).map(id => String(agentName(id) || id));
  const t = testsSummary(s, now);
  const testRow = [];
  if (t) {
    testRow.push(seg('tests ', 'muted'));
    for (const dt of t.dots.slice(0, 8)) testRow.push(seg(dt.ch, dt.role));
    testRow.push(seg(` ${t.text}`, t.role));
  } else testRow.push(seg('tests ', 'muted'), seg('none defined', 'muted'));
  if (!nw && agents.length) {
    testRow.push(seg('   agents ', 'muted'));
    agents.slice(0, 3).forEach((a, i) => { if (i) testRow.push(seg(' ')); testRow.push(seg(a.toUpperCase(), `agent:${a}`)); });
    if (agents.length > 3) testRow.push(seg(` +${agents.length - 3}`, 'muted'));
  }
  rows.push(testRow);
  if (nw && agents.length) rows.push([seg('agents ', 'muted'), seg(agents.slice(0, 3).map(a => a.toUpperCase()).join(', '), `agent:${agents[0]}`)]);

  const src = sourceOf(s);
  if (src) rows.push([seg(fit(src, inner), 'muted')]);

  const use = [];
  const sb = d.scoreboard;
  if (sb?.ok) {
    const r = sb.row;
    const n30 = Number(r?.total_invocations_30d) || 0;
    if (!r || !n30) use.push(r?.last_used_at ? `no runs in 30d · last ${ago(r.last_used_at, now)} ago` : 'no recorded runs');
    else {
      use.push(`used ${plural(n30, 'time')} in 30d`);
      if (r.last_used_at) use.push(`last ${ago(r.last_used_at, now)} ago`);
      if (r.success_rate_30d != null) use.push(`${Math.round(Number(r.success_rate_30d) * 100)}% ok`);
    }
  }
  const judge = s.evals?.judge;
  if (judge && judge.avg_score != null) use.push(`judge ${judge.avg_score}/5${judge.scored_at ? ` (${day(judge.scored_at)})` : ''}`);
  if (use.length) rows.push([seg(fit(use.join(' · '), inner), 'muted')]);

  if (!nw && Array.isArray(s.policySatisfies) && s.policySatisfies.length) rows.push([seg(fit(`satisfies ${s.policySatisfies.join(', ')}`, inner), 'muted')]);

  // Next possibility: only a capability that exists today. /skill runs a skill through a governed turn.
  if (String(s.edition).toLowerCase() !== 'archived') rows.push([seg('next ', 'muted'), seg(`/skill ${name}`, 'key'), seg(nw ? ' runs it' : ' [args] runs it (governed turn)', 'muted')]);
  else rows.push([seg('archived: kept for the record, not offered to agents', 'muted')]);

  return { box: { width: w, title: `Skill · ${name}`, right, rightRole: rv.role, border: 'sky' }, rows };
}

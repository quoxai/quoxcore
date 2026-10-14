/**
 * /observers: facts from persisted data only (LUCID situation, LUCID changes, lessons taught,
 * reflect / learn / insight counters). No model-generated text: every line is a stored field
 * or a count of them. Pure: takes api.observers() output, returns [[text, tone]].
 */
import { clip } from './theme.js';

const why = (p) => (p.unavailable ? 'no endpoint on this server' : `unreadable (${p.error})`);

export function observerLines(o, cols = 80) {
  const out = [];
  const add = (t, tone) => out.push([clip(t, cols - 4), tone]);
  const sit = o.situation;
  if (!sit?.ok) add(`◉ LUCID situation: ${why(sit || { error: 'no answer' })}`, 'warn');
  else {
    const s = sit.v?.situation || {};
    add(`◉ LUCID: ${s.L0 || 'no summary recorded'}`);
    const needs = s.needs_you || [];
    needs.slice(0, 3).forEach(n => add(`  needs you: ${n.L0 || n.ref}`, 'warn'));
    if (needs.length > 3) add(`  +${needs.length - 3} more needing you (quox lucid)`);
    const cs = s.cannot_see || {};
    const blind = [...(cs.unwired || []).map(x => `${x} not wired`), ...(cs.silent || []).map(x => `${x.feed} silent`), ...(cs.failing || []).map(x => `${x.feed || x} failing`)];
    if (cs.coverage) add(`  sees ${cs.coverage.live} of ${cs.coverage.expected} sources${blind.length ? `; ${blind.join(', ')}` : ''}`);
    const total = s.changed_total ?? (s.changed || []).length;
    const range = s.cursor ? ` (journal ${s.cursor.from} to ${s.cursor.to})` : '';
    add(`◉ Changed since you last looked: ${total}${range}`);
    (s.changed || []).slice(0, 5).forEach(c => add(`  ${c.L0 || c.ref}${c.from && c.to ? ` (${c.from} to ${c.to})` : ''}`));
    if (total > 5) add(`  +${total - 5} more (quox lucid since-last)`);
  }
  out.push(['', undefined]);
  add('Self-learning records');
  const les = o.lessons;
  add(les?.ok ? `  LUCID lessons taught: ${(les.v?.lessons || []).length}` : `  LUCID lessons: ${why(les || { error: 'no answer' })}`);
  for (const p of o.learning || []) {
    if (!p.ok) { add(`  ${p.label || 'stat'}: ${why(p)}`); continue; }
    const f = p.v.fields || {};
    const last = f.lastOutcomeAt || f.lastObservationAt || f.lastSignalAt || f.lastClusterAt;
    add(`  ${p.v.label}: ${p.v.text || 'no data'}${last ? ` · last ${last}` : ''}`);
  }
  add('  Memory consolidation: no read API found, not shown.');
  return out;
}

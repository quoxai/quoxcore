/**
 * E6 memory facts with provenance, from GET /api/memory/search (memory service). Each fact shows what
 * the record says about where it came from (provenance, type, source conversation or agent), how old
 * and how trusted it is (confidence, verification, use), and any conflict state (superseded or
 * invalid) in plain sight, never hidden.
 */
import { seg, fit, ago, short, plural } from './model.js';

const PROVENANCE = {
  model_inference: 'inferred by a model', user_stated: 'stated by a user', user_confirmed: 'confirmed by a user',
  tool_output: 'from a tool result', document: 'from a document', imported: 'imported', system: 'system'
};
export const provenanceWord = (p) => (p ? PROVENANCE[p] || String(p).replace(/_/g, ' ') : null);

/** d: { query, results: [...], total?, now } */
export function memoryFacts(d, cols, { max = 5 } = {}) {
  const now = d.now ?? Date.now();
  const nw = cols < 70;
  const inner = Math.max(20, cols - 6);
  const rows = [];
  const res = (d.results || []).slice(0, max);
  if (!res.length) return { rows: [[seg(`No memory matches "${fit(d.query, 40)}".`, 'muted')]] };
  rows.push([seg(`${plural((d.results || []).length, 'fact')} for "${fit(d.query, 40)}"${(d.results || []).length > max ? `, showing ${max}` : ''}`, 'muted')]);
  const L = (label, text, role = 'value') => [seg('  '), seg(label.padEnd(7), 'muted'), seg(fit(text, inner - 9), role)];
  for (const m of res) {
    rows.push([seg(' ')]);
    rows.push([seg('◆ ', 'indigo', true), seg(m.memory_role === 'fact' || !m.memory_role ? 'fact ' : `${m.memory_role} `, 'muted'), seg(fit(m.content, inner - 8), 'value', true)]);
    const src = [provenanceWord(m.provenance), m.memory_type].filter(Boolean);
    if (m.source_conversation_id) src.push(nw ? `chat ${short(m.source_conversation_id, 8)}` : `conversation ${short(m.source_conversation_id, 10)}`);
    if (m.agent_id) src.push(`agent ${m.agent_id}`);
    if (src.length) rows.push(L('source', src.join(' · ')));
    const age = [];
    const created = m.created_at || m.createdAt;
    if (created) age.push(`${ago(created, now)} old`);
    if (m.confidence != null) age.push(`confidence ${Math.round(Number(m.confidence) * 100)}%`);
    if (m.verified_at) age.push(`verified${m.verified_by ? ` by ${short(m.verified_by, 10)}` : ''} ${ago(m.verified_at, now)} ago`);
    else age.push('not verified');
    if (m.access_count) age.push(`used ${plural(Number(m.access_count), 'time')}`);
    rows.push(L('age', age.join(' · '), 'muted'));
    if (m.superseded_by) rows.push(L('status', `superseded by ${short(m.superseded_by, 12)}`, 'warn'));
    else if (m.valid === false || m.valid === 0) rows.push(L('status', 'marked invalid', 'error'));
  }
  return { rows };
}

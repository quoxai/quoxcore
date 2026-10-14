/**
 * /resume and `quox --resume`: pick a recent conversation, show its last turns as ordinary history, and
 * continue it. Conversations come from GET /api/v1/conversations (title, updated_at, turn_count); the agent
 * comes from the session index (GET /api/v1/sessions) when that answers, and names set with /rename from
 * the local name store.
 */
export const RESUME_TURNS = 20;

export function age(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** -> [{ id, title, agent, updated_at, turns }] newest first. */
export function resumeRows(conversations = [], index = null, names = {}) {
  const agentOf = new Map();
  for (const r of index?.rows || []) if (r.kind === 'conversation' && r.id) agentOf.set(r.id, r.agent || null);
  return conversations.map(c => ({
    id: c.id,
    title: names[c.id]?.name || c.title || '(untitled)',
    agent: agentOf.get(c.id) ?? null,
    updated_at: c.updated_at || null,
    turns: c.turn_count ?? null
  })).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

export const pickerRow = (r, now = Date.now()) => ({ key: r.id.slice(0, 12), text: `${r.title} · ${r.agent || 'agent not recorded'} · ${age(r.updated_at, now)}${r.turns != null ? ` · ${r.turns} turn${r.turns === 1 ? '' : 's'}` : ''}` });

/** An id, an id prefix (4+), or a session name/title -> { row } | { ambiguous:[ids] } | { none:true }. */
export function matchConversation(rows, q) {
  const s = String(q || '').trim();
  if (!s) return { none: true };
  const exact = rows.find(r => r.id === s);
  if (exact) return { row: exact };
  const lower = s.toLowerCase();
  const byName = rows.filter(r => r.title.toLowerCase() === lower);
  if (byName.length === 1) return { row: byName[0] };
  const pre = s.length >= 4 ? rows.filter(r => r.id.startsWith(s)) : [];
  if (pre.length === 1) return { row: pre[0] };
  const hits = byName.length ? byName : pre;
  return hits.length > 1 ? { ambiguous: hits.map(r => r.id) } : { none: true };
}

/** Stored turns -> history items (user prompts and answers, rendered as normal history). */
export function turnsToHistory(turns = [], max = RESUME_TURNS) {
  const list = turns.filter(t => (t.role === 'user' || t.role === 'assistant') && String(t.content || '').trim());
  const shown = list.slice(-max);
  return {
    items: shown.map(t => (t.role === 'user' ? { kind: 'user', text: String(t.content) } : { kind: 'text', text: String(t.content) })),
    answers: shown.filter(t => t.role === 'assistant').map((t, i) => ({ id: `resumed_${i}`, text: String(t.content) })),
    shown: shown.length,
    total: list.length
  };
}

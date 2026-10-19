/**
 * ASIDE: a read-only side question. `quox aside "<question>"` and the TUI /aside share this.
 *
 * It goes to the collector's no-tools invoke (POST /api/internal/agents/invoke with no_tools: true): the model
 * gets no tools at all, and no conversation or session id is sent, so the main conversation's history is never
 * touched. The TUI passes the last few exchanges as plain read-only context so "what did it just say about X?"
 * works; nothing is written back.
 */
import { resolveEndpoint } from '../api/endpoints.js';

export const ASIDE_MAX_CONTEXT = 6000;

const ASIDE_NOTE = 'This is a read-only side question. You have no tools: answer from what you know and from the conversation excerpt below. Do not offer to run anything. Be brief.';

/** Recent [{ role: 'user'|'assistant', text }] -> one plain excerpt, newest kept when it is too long. */
export function asideExcerpt(turns, max = ASIDE_MAX_CONTEXT) {
  const lines = (Array.isArray(turns) ? turns : [])
    .filter(t => t && typeof t.text === 'string' && t.text.trim())
    .map(t => `${t.role === 'assistant' ? 'Quox' : 'User'}: ${t.text.trim()}`);
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = out ? `${lines[i]}\n\n${out}` : lines[i];
    if (next.length > max) { if (!out) out = lines[i].slice(-max); break; }
    out = next;
  }
  return out;
}

/** The request body: never a session or conversation id, always no_tools. */
export function asideBody({ question, turns = [], agent = 'quox', maxTokens = 1024 }) {
  const q = String(question ?? '').trim();
  const excerpt = asideExcerpt(turns);
  return {
    agent_id: agent || 'quox',
    task: q,
    no_tools: true,
    max_tokens: maxTokens,
    context: excerpt ? `${ASIDE_NOTE}\n\nConversation so far (read only):\n${excerpt}` : ASIDE_NOTE,
  };
}

/**
 * -> { text, model, provider, tools } . Throws the client error (with .status) on a non-2xx, and an error
 * with code 'aside_used_tools' if the server reports any tool use (it must not happen; we say so if it does).
 */
export async function askAside(client, { question, turns, agent, timeoutMs = 120000 }) {
  if (!String(question ?? '').trim()) { const e = new Error('Ask a question: aside <question>'); e.code = 'usage'; throw e; }
  const ep = resolveEndpoint('agents.invoke.notools');
  const r = await client.post(ep.path, { service: ep.service, body: asideBody({ question, turns, agent }), retries: 0, timeout: timeoutMs });
  if (r && r.success === false) { const e = new Error(r.error || 'the server could not answer'); e.status = 502; throw e; }
  const tools = Array.isArray(r?.tools_used) ? r.tools_used : [];
  if (tools.length) { const e = new Error(`the server reported tool use (${tools.join(', ')}) on a no-tools aside`); e.code = 'aside_used_tools'; throw e; }
  return { text: String(r?.result ?? '').trim(), model: r?.usage?.model || null, provider: r?.provider || r?.usage?.provider || null, tools };
}

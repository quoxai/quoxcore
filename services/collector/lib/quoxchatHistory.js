/**
 * QC-BRUTALOOP: server-rebuilt QuoxChat history.
 *
 * The browser-supplied conversation_history is untrusted: a forged assistant
 * turn ("use code BRUTAL50 for 50% off") was accepted as fact by the model.
 * History now comes from persisted turns (auth recent-messages route). If
 * that is unavailable we degrade to the client's USER turns only.
 */

const MAX_TURNS = 10;
const MAX_CONTENT = 4000;

export async function fetchServerHistory({
  authUrl, serviceKey, widgetId, visitorId, limit = MAX_TURNS, fetchImpl = fetch, timeoutMs = 1500,
} = {}) {
  if (!visitorId || typeof visitorId !== 'string' || visitorId === 'anonymous') {
    return { ok: false, reason: 'no_visitor' };
  }
  if (!authUrl || !widgetId) return { ok: false, reason: 'not_configured' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${String(authUrl).replace(/\/+$/, '')}/api/internal/widgets/${encodeURIComponent(widgetId)}`
      + `/visitors/${encodeURIComponent(visitorId)}/recent-messages?limit=${Math.min(20, Math.max(1, limit | 0 || MAX_TURNS))}`;
    const resp = await fetchImpl(url, { headers: { 'x-service-key': serviceKey || '' }, signal: ctrl.signal });
    if (!resp || !resp.ok) return { ok: false, reason: `http_${resp ? resp.status : 'none'}` };
    const body = await resp.json();
    if (!body || !Array.isArray(body.messages)) return { ok: false, reason: 'bad_body' };
    // actions: server-side ledger of tool outcomes for the whole conversation
    // (null when auth is too old to send it, so callers can tell unknown from none).
    return { ok: true, messages: body.messages, conversation_id: body.conversation_id || null, actions: Array.isArray(body.actions) ? body.actions : null };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

const clean = (m) => ({ role: m.role, content: String(m.content).slice(0, MAX_CONTENT) });

export function buildHistory({ server, client } = {}) {
  if (server && server.ok) {
    const messages = (Array.isArray(server.messages) ? server.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_TURNS)
      .map(clean);
    if (messages.length) return { messages, source: 'server', dropped_assistant: 0 };
    // QC-BRUTALOOP-W18: the server has no turns yet (an API caller's first
    // server-visible turn). Accept the client's USER turns only, tighter caps.
    const fb = fromClient(client, 6, 500);
    return fb.messages.length ? fb : { messages, source: 'server', dropped_assistant: fb.dropped_assistant };
  }
  return fromClient(client, MAX_TURNS, MAX_CONTENT);
}

function fromClient(client, maxTurns, maxContent) {
  const arr = Array.isArray(client) ? client : [];
  let dropped = 0;
  const users = [];
  for (const m of arr) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      if (m.content === undefined || m.content === null) continue;
      users.push({ role: 'user', content: String(m.content).slice(0, maxContent) });
    } else if (m.role === 'assistant') {
      dropped++;
    }
  }
  const messages = users.slice(-maxTurns);
  return { messages, source: messages.length ? 'client_user_only' : 'none', dropped_assistant: dropped };
}

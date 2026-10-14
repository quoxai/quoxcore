'use strict';

/**
 * Tell the model which of THIS conversation's approvals the user resolved since its last reply.
 *
 * QUOXON-REVIEW (finding 148f215f2879): the user rejected a hat-switch card between turns and the
 * next reply still said the proposal "is still waiting in your inbox". The model only sees stored
 * history, whose last word was "it's in your inbox now". The inbox record is authoritative, so the
 * chat route reads it and hands the model a short note. A failed read is reported as an error to
 * the caller (logged), never as "nothing changed".
 */

const MAX_LINES = 8;

function parseResolvedAt(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  // sqlite datetime('now') is UTC without a zone: "YYYY-MM-DD HH:MM:SS".
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function obj(v, raw) {
  if (v && typeof v === 'object') return v;
  if (typeof raw === 'string' && raw) { try { const o = JSON.parse(raw); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
  return {};
}

function labelOf(item, payload) {
  const m = payload.approval_context?.method || {};
  if (item.title) return String(item.title).replace(/\s·\s[A-Z0-9]{4,}$/, '').slice(0, 120);
  if (m.tool) return `${m.tool}${m.target ? ` on ${m.target}` : ''}`;
  return String(payload.toolName || item.id || 'an approval');
}

const VERB = { approve: 'approved', approved: 'approved', reject: 'rejected', rejected: 'rejected', deny: 'rejected', denied: 'rejected', request_changes: 'sent back for changes' };

/**
 * @param {{orgId, conversationId, sinceMs, fetchItems: ({orgId, kind, status}) => Promise<object[]>}} a
 * @returns {Promise<{note: string|null, error: string|null}>}
 */
async function buildOutOfBandApprovalNote({ orgId, conversationId, sinceMs, fetchItems } = {}) {
  if (!orgId || !conversationId || !(Number(sinceMs) > 0) || typeof fetchItems !== 'function') return { note: null, error: null };
  let items;
  try {
    items = await fetchItems({ orgId, kind: 'approval', status: 'resolved' });
  } catch (e) {
    return { note: null, error: String((e && e.message) || e) };
  }
  if (!Array.isArray(items)) return { note: null, error: 'unexpected inbox response' };
  const lines = [];
  for (const it of items) {
    if (!it || it.kind && it.kind !== 'approval') continue;
    const payload = obj(it.payload, it.payload_json);
    if (payload.approval_context?.on_behalf_of?.conversation_id !== conversationId) continue;
    const at = parseResolvedAt(it.resolved_at);
    if (at == null || at <= Number(sinceMs)) continue;
    const resp = obj(it.response, it.response_json);
    const verb = VERB[String(resp.action || '').toLowerCase()] || 'resolved';
    lines.push(`- "${labelOf(it, payload)}" was ${verb} by the user at ${new Date(at).toISOString().slice(11, 16)} UTC.`);
    if (lines.length >= MAX_LINES) break;
  }
  if (!lines.length) return { note: null, error: null };
  return {
    note: `## Since your last reply (approvals inbox, authoritative)\n${lines.join('\n')}\nThese are decided and not pending: do not describe them as waiting for approval.`,
    error: null,
  };
}

/** fetchItems over the auth service's internal inbox list (service key). Non-2xx throws. */
function internalInboxFetcher({ authBase, serviceKey, fetchFn = fetch, timeoutMs = 2000 } = {}) {
  return async ({ orgId, kind, status }) => {
    const q = new URLSearchParams({ kind, status, limit: '50' });
    const res = await fetchFn(`${authBase}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox/items?${q}`, {
      headers: { ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res || !res.ok) throw new Error(`inbox list HTTP ${res ? res.status : 'no response'}`);
    const body = await res.json();
    return Array.isArray(body && body.items) ? body.items : [];
  };
}

/** Return parsedContext with the note appended to quox_context (every provider path renders it). */
function withOutOfBandNote(parsedContext, note) {
  if (!note) return parsedContext;
  const prev = parsedContext && parsedContext.quox_context;
  const prevStr = prev == null || prev === '' ? '' : (typeof prev === 'string' ? prev : JSON.stringify(prev));
  return { ...(parsedContext || {}), quox_context: prevStr ? `${prevStr}\n\n${note}` : note };
}

module.exports = { buildOutOfBandApprovalNote, parseResolvedAt, internalInboxFetcher, withOutOfBandNote };

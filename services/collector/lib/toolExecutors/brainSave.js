/**
 * brain_save executor (BRAIN2-V3 A2): saves a document-style note into the
 * caller's knowledge brain (NotesQ vault) via quoxbrain POST /brain/capture,
 * with org/user taken from the tool execution context (never from model input).
 * memory_save stays for short facts/preferences. Never throws.
 */

const { emitNotes } = require('../notesq/evidence');

const BRAIN_URL = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const TIMEOUT_MS = 20000;

async function brainSave(input, ctx, { fetchImpl = fetch } = {}) {
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  // BRAIN2-W7 E 123: a URL alone is a valid capture (the brain fetches and extracts it).
  const url = typeof input?.url === 'string' ? input.url.trim() : '';
  if (!text && !url) return { success: false, error: 'text_or_url_required', output: 'Missing required parameter: text (or url to clip)' };
  const orgId = ctx?.orgId;
  if (!orgId) return { success: false, error: 'no_org_context', output: 'Cannot save to the knowledge brain without an org context.' };
  // BRAIN2-W5 124: a missing user must reject, never widen a private save to org scope.
  const userId = ctx?.userId;
  if (!userId) return { success: false, error: 'no_user_context', output: 'Cannot save to the knowledge brain without a user identity (a private save must not become an org-wide one).' };
  // Scope stays 'user' on purpose: an agent holds a service key, which the brain
  // treats as admin, so it must not be able to publish org-wide on its own.
  const body = { author_kind: 'agent', scope: 'user' };
  if (text) body.text = text;
  if (url) body.url = url;
  if (Array.isArray(input?.tags)) {
    const tags = input.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 20);
    if (tags.length) body.tags = tags;
  }
  if (typeof input.title === 'string' && input.title.trim()) body.title = input.title.trim();
  let res;
  try {
    res = await fetchImpl(`${BRAIN_URL}/brain/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': SERVICE_KEY,
        'X-Org-Id': String(orgId),
        'X-User-Id': String(userId),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { success: false, error: 'knowledge_brain_unavailable', output: 'Knowledge brain did not confirm the save (network failure or timeout). The save is unconfirmed: it may or may not have been written, so check before retrying.' };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    return { success: false, error: (json && json.error) || `http_${res.status}`, output: `Knowledge brain refused the save (${(json && json.error) || res.status}).` };
  }
  if (json.status !== 'unchanged' && json.noteId) {
    emitNotes(json.status === 'created' ? 'quox.notes.create' : 'quox.notes.update', ctx, String(json.noteId), { content_hash: json.content_hash, via: 'brain_save' });
  }
  const verb = json.status === 'created' ? 'Saved' : json.status === 'unchanged' ? 'Already saved' : 'Updated existing note';
  // CORTEX-BENCH pass 1: return the FULL note id and revision as fields, so an
  // attached session can chain straight into quoxbrain_read / brain_update /
  // brain_delete (the prose used to carry only an 8-char prefix).
  return {
    success: true,
    status: json.status,
    noteId: json.noteId ? String(json.noteId) : null,
    title: json.title || null,
    ...(json.content_hash ? { revision: json.content_hash } : {}),
    ...(json.possibleDuplicateOf ? { possibleDuplicateOf: String(json.possibleDuplicateOf) } : {}),
    output: `${verb} to the knowledge brain: "${json.title || ''}" (note ${String(json.noteId || '')}). It is searchable now and editable in NotesQ.`
      // quox#963: a new title over the same text is a separate note; say so.
      + (json.possibleDuplicateOf ? ` This is a new note; note ${String(json.possibleDuplicateOf)} has the same text under another title and was not changed.` : ''),
  };
}

module.exports = { brainSave };

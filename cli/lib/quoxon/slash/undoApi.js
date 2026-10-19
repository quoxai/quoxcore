/** Server calls behind /undo. Each throws on a non-2xx (never reads an error body as data). */
import { resolveEndpoint } from '../../api/endpoints.js';

const listOf = (d, ...keys) => { for (const k of keys) if (Array.isArray(d?.[k])) return d[k]; return Array.isArray(d) ? d : []; };
const receiptOf = (d) => d?.envelope_id || d?.envelopeId || d?.receipt?.envelope_id || d?.receipt?.id || null;

export function createUndoOps({ client, orgId = () => null }) {
  return {
    /** The call's envelope, read back: { ok, env } | { ok:false, error }. */
    async envelope(id) {
      try { const d = await client.get(`/aee/${encodeURIComponent(id)}`, { service: 'collector', retries: 0, timeout: 10000 }); return { ok: true, env: d?.envelope || d }; }
      catch (e) { return { ok: false, error: e?.status ? `HTTP ${e.status}` : (e?.message || 'failed') }; }
    },
    async recentMoves() {
      const ep = resolveEndpoint('inboxq.moves.recent');
      return listOf(await client.get(ep.path, { service: ep.service, retries: 0, query: { limit: 20 } }), 'moves');
    },
    async undoMove(moveId) {
      const ep = resolveEndpoint('inboxq.moves.undo');
      return { receipt: receiptOf(await client.post(ep.path, { service: ep.service, retries: 0, body: { moveId } })) };
    },
    async releaseSlot(name) {
      const ep = resolveEndpoint('v1.slots.release', { name });
      const data = await client.post(ep.path, { service: ep.service, retries: 0, body: { force: false, org_id: orgId() || undefined } });
      const after = data?.slot;
      if (after && after.state !== 'free' && !data.promoted) throw new Error(`slot ${name} was not released: the server still shows it ${after.state}${after.holder_session ? ` by ${after.holder_session}` : ''}`);
      return { receipt: receiptOf(data) };
    },
    async listNotes() {
      const ep = resolveEndpoint('notesq.notes.list');
      return listOf(await client.get(ep.path, { service: ep.service, retries: 0 }), 'notes', 'items', 'data');
    },
    async deleteNote(id) {
      const ep = resolveEndpoint('notesq.notes.delete', { id });
      return { receipt: receiptOf(await client.delete(ep.path, { service: ep.service, retries: 0 })) };
    }
  };
}

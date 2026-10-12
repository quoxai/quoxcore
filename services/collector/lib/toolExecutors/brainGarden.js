/**
 * brain_garden_apply (ONE-BRAIN CX6 gardener). Archives the user's own private
 * NotesQ notes that the brain proposed tidying (duplicates, stale notes). The
 * archive is the notebook's own reversible convention: frontmatter
 * `archived: true`, written as a normal revision (restorable in NotesQ).
 * Nothing is ever deleted.
 *
 * This file holds only the EFFECT. The approval boundary is the caller
 * (agentTools.js wraps this in withApprovalGate); this module must never be
 * reachable except through that wrapper.
 *
 * Per note: re-read it; skip (and report) a note that vanished, is not the
 * user's own private note, is already archived, or changed since the proposal
 * (content_hash differs from the hash recorded when the proposal was filed).
 * Never throws.
 */

const BRAIN_URL = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const TIMEOUT_MS = 20000;
const MAX_NOTES = 20;
const KINDS = ['duplicate', 'stale', 'broken_link'];

function headersFor(ctx) {
  return {
    'Content-Type': 'application/json',
    'X-Service-Key': SERVICE_KEY,
    'X-Org-Id': String(ctx.orgId),
    'X-User-Id': String(ctx.userId),
    'X-User-Is-Admin': 'false',
  };
}

async function call(fetchImpl, url, opts) {
  let res;
  try {
    res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { unavailable: true };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { res, json };
}

/** Shape check run BEFORE the approval gate so a malformed call never files a card. */
function validateGardenInput(input, ctx) {
  if (!ctx || !ctx.orgId) return { success: false, error: 'no_org_context', output: 'No org context for the knowledge brain.' };
  if (!ctx.userId) return { success: false, error: 'no_user_context', output: 'No user identity, so a private note cannot be archived.' };
  if (!input || input.action !== 'archive') return { success: false, error: 'invalid_action', output: "action must be 'archive'." };
  if (!KINDS.includes(input.proposalKind)) return { success: false, error: 'invalid_proposal_kind', output: `proposalKind must be one of ${KINDS.join(', ')}.` };
  const ids = input.noteIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_NOTES || !ids.every((x) => typeof x === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(x))) {
    return { success: false, error: 'invalid_note_ids', output: `noteIds must be 1 to ${MAX_NOTES} note ids.` };
  }
  if (new Set(ids).size !== ids.length) return { success: false, error: 'invalid_note_ids', output: 'noteIds must be unique.' };
  if (typeof input.reason !== 'string' || !input.reason.trim()) return { success: false, error: 'reason_required', output: 'reason is required so the approver knows why.' };
  return null;
}

async function archiveOne(noteId, expectedHash, ctx, fetchImpl) {
  const got = await call(fetchImpl, `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}`, { method: 'GET', headers: headersFor(ctx) });
  if (got.unavailable) return { status: 'failed', reason: 'knowledge_brain_unavailable' };
  if (got.res.status === 404) return { status: 'skipped', reason: 'vanished' };
  if (!got.res.ok) return { status: 'failed', reason: (got.json && got.json.error) || `http_${got.res.status}` };
  const note = got.json && got.json.note;
  if (!note) return { status: 'failed', reason: 'bad_response' };
  if (note.scope !== 'user') return { status: 'skipped', reason: 'not_own_private_note' };
  const props = note.properties || note.frontmatter || {};
  if (props.archived === true) return { status: 'skipped', reason: 'already_archived' };
  if (expectedHash && note.content_hash !== expectedHash) return { status: 'skipped', reason: 'changed_since_proposal' };
  const put = await call(fetchImpl, `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}`, {
    method: 'PUT',
    headers: headersFor(ctx),
    body: JSON.stringify({
      markdown: typeof note.markdown === 'string' ? note.markdown : String(note.body || ''),
      properties: { ...props, archived: true },
      base_hash: note.content_hash,
      author_kind: 'agent',
    }),
  });
  if (put.unavailable) return { status: 'failed', reason: 'unconfirmed_network' };
  if (put.res.status === 409) return { status: 'skipped', reason: 'changed_during_apply' };
  if (!put.res.ok) return { status: 'failed', reason: (put.json && put.json.error) || `http_${put.res.status}` };
  return { status: 'archived', content_hash: put.json && put.json.note && put.json.note.content_hash };
}

async function brainGardenApply(input, ctx, { fetchImpl = fetch, emit } = {}) {
  const bad = validateGardenInput(input, ctx);
  if (bad) return bad;
  const hashes = input.expectedHashes && typeof input.expectedHashes === 'object' ? input.expectedHashes : {};
  const archived = [];
  const skipped = [];
  const failed = [];
  for (const id of input.noteIds) {
    const r = await archiveOne(id, typeof hashes[id] === 'string' ? hashes[id] : '', ctx, fetchImpl);
    if (r.status === 'archived') {
      archived.push(id);
      if (typeof emit === 'function') emit('quox.notes.update', ctx, id, { content_hash: r.content_hash, via: 'brain_garden_apply' });
    } else if (r.status === 'skipped') skipped.push({ noteId: id, reason: r.reason });
    else failed.push({ noteId: id, reason: r.reason });
  }
  const parts = [`Archived ${archived.length} of ${input.noteIds.length} note(s) (${input.proposalKind}).`];
  if (skipped.length) parts.push(`Skipped ${skipped.length}: ${skipped.map((s) => `${s.noteId.slice(0, 8)} ${s.reason}`).join(', ')}.`);
  if (failed.length) parts.push(`Failed ${failed.length}: ${failed.map((s) => `${s.noteId.slice(0, 8)} ${s.reason}`).join(', ')}.`);
  parts.push('Archiving is reversible: each note has a revision restorable in NotesQ.');
  return { success: failed.length === 0 && (archived.length > 0 || skipped.length > 0), archived, skipped, failed, output: parts.join(' ') };
}

module.exports = { brainGardenApply, validateGardenInput, MAX_NOTES, KINDS };

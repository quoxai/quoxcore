/**
 * brain_update / brain_delete executors (BRAIN2-W5 125). Cortex could save a
 * brain document but not correct or forget it, and was told to use
 * memory_update (a different store). These edit the CALLER'S OWN private
 * NotesQ note through the existing NotesQ routes (quoxbrain /notesq/notes/:id),
 * which already enforce revisions and optimistic concurrency (base_hash ->
 * 409 conflict). Identity comes only from the tool context, never model input.
 * update/restore: the caller's own private notes AND org (team) notes of the
 * caller's own org (same rule as NotesQ canWriteVault). delete: private only.
 * Never throws.
 */

const { emitNotes } = require('../notesq/evidence');

const BRAIN_URL = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const TIMEOUT_MS = 20000;

function headersFor(ctx, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Service-Key': SERVICE_KEY,
    'X-Org-Id': String(ctx.orgId),
    'X-User-Id': String(ctx.userId),
    'X-User-Is-Admin': 'false',
    ...extra,
  };
}

const REVISION_REQUIRED = 'Missing required parameter: expectedHash. Call quoxbrain_read on this note first and pass the "revision" value it returned as expectedHash, so the edit is checked against the version you actually read.';
const CONFLICT = 'The note changed since it was read (revision conflict). Nothing was changed. Re-read it with quoxbrain_read and retry on the latest version.';

function revisionOf(input) {
  return typeof input?.expectedHash === 'string' ? input.expectedHash.trim() : '';
}

function preflight(input, ctx) {
  const noteId = typeof input?.noteId === 'string' ? input.noteId.trim() : '';
  if (!noteId) return { success: false, error: 'noteId_required', output: 'Missing required parameter: noteId' };
  if (!ctx?.orgId) return { success: false, error: 'no_org_context', output: 'No org context for the knowledge brain.' };
  if (!ctx?.userId) return { success: false, error: 'no_user_context', output: 'No user identity, so a private note cannot be edited.' };
  if (!revisionOf(input)) return { success: false, error: 'revision_required', output: REVISION_REQUIRED };
  return null;
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

const UNCONFIRMED = 'Knowledge brain did not confirm the change (network failure or timeout). It is unconfirmed: it may or may not have been applied, so re-read the note before retrying.';

// allowOrg (update/restore only): an org-scope note of the caller's OWN org is
// editable, mirroring quoxbrain store.canWriteVault (org vault: vault.org_id ===
// orgId, any member; admin only gates shared vaults). The brain's GET already
// hides other orgs and other users' private notes (scopeClause) and the PUT /
// restore re-check canWriteVault server-side. Delete keeps private-only.
async function fetchOwnNote(noteId, ctx, fetchImpl, { allowOrg = false } = {}) {
  const r = await call(fetchImpl, `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}`, { method: 'GET', headers: headersFor(ctx) });
  if (r.unavailable) return { fail: { success: false, error: 'knowledge_brain_unavailable', output: 'Knowledge brain unavailable, could not read the note.' } };
  if (r.res.status === 404) return { fail: { success: false, error: 'not_found', output: 'No such note in your own knowledge brain.' } };
  if (!r.res.ok) return { fail: { success: false, error: (r.json && r.json.error) || `http_${r.res.status}`, output: `Knowledge brain refused the read (${(r.json && r.json.error) || r.res.status}).` } };
  const note = r.json && r.json.note;
  const orgOk = allowOrg && note && note.scope === 'org' && (note.org_id === undefined || String(note.org_id) === String(ctx.orgId));
  if (!note || (note.scope !== 'user' && !orgOk)) {
    return { fail: { success: false, error: 'not_own_note', output: allowOrg ? 'That note is neither your own private note nor a team note in your org; edit it in NotesQ.' : 'That note is not one of your own private notes; edit shared notes in NotesQ.' } };
  }
  return { note };
}

async function brainUpdate(input, ctx, { fetchImpl = fetch } = {}) {
  const bad = preflight(input, ctx);
  if (bad) return bad;
  const text = typeof input?.text === 'string' ? input.text : '';
  if (!text.trim()) return { success: false, error: 'text_required', output: 'Missing required parameter: text (the full corrected note markdown).' };
  const noteId = input.noteId.trim();
  const got = await fetchOwnNote(noteId, ctx, fetchImpl, { allowOrg: true });
  if (got.fail) return got.fail;
  const baseHash = revisionOf(input);
  const r = await call(fetchImpl, `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}`, {
    method: 'PUT',
    headers: headersFor(ctx),
    body: JSON.stringify({ markdown: text, base_hash: baseHash, author_kind: 'agent' }),
  });
  if (r.unavailable) return { success: false, error: 'knowledge_brain_unavailable', output: UNCONFIRMED };
  if (r.res.status === 409) {
    return { success: false, error: 'conflict', output: CONFLICT };
  }
  if (!r.res.ok) return { success: false, error: (r.json && r.json.error) || `http_${r.res.status}`, output: `Knowledge brain refused the update (${(r.json && r.json.error) || r.res.status}).` };
  const unchanged = r.json && r.json.unchanged;
  if (!unchanged) emitNotes('quox.notes.update', ctx, noteId, { content_hash: r.json && r.json.note && r.json.note.content_hash, via: 'brain_update' });
  return { success: true, output: unchanged ? `Note ${noteId.slice(0, 8)} already had that text; nothing changed.` : `Updated note ${noteId.slice(0, 8)} in the knowledge brain (a revision was recorded; it can be restored in NotesQ).` };
}

async function brainDelete(input, ctx, { fetchImpl = fetch } = {}) {
  const bad = preflight(input, ctx);
  if (bad) return bad;
  const noteId = input.noteId.trim();
  const got = await fetchOwnNote(noteId, ctx, fetchImpl);
  if (got.fail) return got.fail;
  if (got.note.content_hash !== revisionOf(input)) return { success: false, error: 'conflict', output: CONFLICT };
  const r = await call(fetchImpl, `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}`, {
    method: 'DELETE',
    headers: headersFor(ctx, { 'X-Author-Kind': 'agent', 'If-Match': `"${revisionOf(input)}"` }),
  });
  if (r.unavailable) return { success: false, error: 'knowledge_brain_unavailable', output: UNCONFIRMED };
  if (r.res.status === 409) return { success: false, error: 'conflict', output: CONFLICT };
  if (!r.res.ok) return { success: false, error: (r.json && r.json.error) || `http_${r.res.status}`, output: `Knowledge brain refused the delete (${(r.json && r.json.error) || r.res.status}).` };
  emitNotes('quox.notes.delete', ctx, noteId, { via: 'brain_delete' });
  return { success: true, output: `Deleted note ${noteId.slice(0, 8)} from the knowledge brain (the delete is recorded as a revision and can be restored in NotesQ).` };
}

// ONE-BRAIN CX2: related / history / restore over the existing NotesQ routes.
const HISTORY_MAX_CHARS = 20000;

function readPreflight(input, ctx) {
  const noteId = typeof input?.noteId === 'string' ? input.noteId.trim() : '';
  if (!noteId) return { success: false, error: 'noteId_required', output: 'Missing required parameter: noteId' };
  if (!ctx?.orgId) return { success: false, error: 'no_org_context', output: 'No org context for the knowledge brain.' };
  if (!ctx?.userId) return { success: false, error: 'no_user_context', output: 'No user identity, so note visibility cannot be resolved.' };
  return null;
}

function refusal(r, what) {
  if (r.unavailable) return { success: false, error: 'knowledge_brain_unavailable', output: 'Knowledge brain unavailable, could not complete the request.' };
  if (r.res.status === 404) return { success: false, error: 'not_found', output: 'No such note or revision among your NotesQ notes. Related notes and revision history exist only for NotesQ notes (written by the user or saved with brain_save), not for notes imported from sources.' };
  if (!r.res.ok) return { success: false, error: (r.json && r.json.error) || `http_${r.res.status}`, output: `Knowledge brain refused the ${what} (${(r.json && r.json.error) || r.res.status}).` };
  return null;
}

async function brainRelated(input, ctx, { fetchImpl = fetch } = {}) {
  const bad = readPreflight(input, ctx);
  if (bad) return bad;
  const noteId = input.noteId.trim();
  const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 8, 1), 20);
  const r = await call(fetchImpl, `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}/related?limit=${limit}`, { method: 'GET', headers: headersFor(ctx) });
  const fail = refusal(r, 'related-notes lookup');
  if (fail) return fail;
  const related = Array.isArray(r.json?.related) ? r.json.related : [];
  const mode = r.json?.mode || 'lexical';
  if (!related.length) return { success: true, related: [], mode, output: 'No related notes found for that note.' };
  const lines = [`Notes related to ${noteId.slice(0, 8)} (${related.length}, ranked by ${mode} similarity):`];
  related.forEach((n, i) => {
    lines.push(`${i + 1}. ${n.title || '(untitled)'} [${n.scope || 'unknown'}] score ${n.score}`);
    if (n.excerpt) lines.push(`   ${String(n.excerpt).replace(/\s+/g, ' ').slice(0, 240)}`);
    lines.push(`   (noteId: ${n.id})`);
  });
  return { success: true, related: related.map((n) => ({ noteId: n.id, title: n.title, scope: n.scope, score: n.score })), mode, output: lines.join('\n') };
}

async function brainHistory(input, ctx, { fetchImpl = fetch } = {}) {
  const bad = readPreflight(input, ctx);
  if (bad) return bad;
  const noteId = input.noteId.trim();
  const base = `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}/revisions`;
  if (input.rev !== undefined && input.rev !== null && input.rev !== '') {
    const rev = Number(input.rev);
    if (!Number.isInteger(rev) || rev < 1) return { success: false, error: 'invalid_rev', output: 'rev must be a positive whole number from the revision list.' };
    const r = await call(fetchImpl, `${base}/${rev}`, { method: 'GET', headers: headersFor(ctx) });
    const fail = refusal(r, 'revision read');
    if (fail) return fail;
    const md = String(r.json?.markdown || '');
    const body = md.slice(0, HISTORY_MAX_CHARS);
    const note = md.length > body.length ? `\n[truncated at ${HISTORY_MAX_CHARS} of ${md.length} chars]` : '';
    return { success: true, rev: r.json?.rev ?? rev, action: r.json?.action, output: `Revision ${r.json?.rev ?? rev} of ${noteId.slice(0, 8)} (${r.json?.action || 'unknown'} by ${r.json?.author_kind || 'unknown'}, ${r.json?.created_at || 'unknown date'}):\n\n${body}${note}` };
  }
  const r = await call(fetchImpl, base, { method: 'GET', headers: headersFor(ctx) });
  const fail = refusal(r, 'history lookup');
  if (fail) return fail;
  const revisions = Array.isArray(r.json?.revisions) ? r.json.revisions : [];
  if (!revisions.length) return { success: true, revisions: [], output: 'No revisions recorded for that note.' };
  const lines = [`Revision history for ${noteId.slice(0, 8)} (${revisions.length}, oldest first):`];
  for (const v of revisions) lines.push(`- rev ${v.rev}: ${v.action} by ${v.author_kind || 'unknown'} at ${v.created_at} (hash ${v.content_hash})`);
  return { success: true, revisions, output: lines.join('\n') };
}

async function brainRestore(input, ctx, { fetchImpl = fetch } = {}) {
  const bad = preflight(input, ctx);
  if (bad) return bad;
  const rev = Number(input.rev);
  if (!Number.isInteger(rev) || rev < 1) return { success: false, error: 'invalid_rev', output: 'Missing or invalid parameter: rev (a positive whole number from brain_history).' };
  const noteId = input.noteId.trim();
  const got = await fetchOwnNote(noteId, ctx, fetchImpl, { allowOrg: true });
  if (got.fail) return got.fail;
  // Fast-fail pre-check; the authoritative check is the service's own, done
  // atomically with the mutation (expected_hash / If-Match).
  if (got.note.content_hash !== revisionOf(input)) return { success: false, error: 'conflict', output: CONFLICT };
  const r = await call(fetchImpl, `${BRAIN_URL}/notesq/notes/${encodeURIComponent(noteId)}/restore`, {
    method: 'POST',
    headers: headersFor(ctx),
    body: JSON.stringify({ rev, author_kind: 'agent', expected_hash: revisionOf(input) }),
  });
  if (r.unavailable) return { success: false, error: 'knowledge_brain_unavailable', output: UNCONFIRMED };
  if (r.res.status === 409) return { success: false, error: 'conflict', output: CONFLICT };
  if (!r.res.ok) return { success: false, error: (r.json && r.json.error) || `http_${r.res.status}`, output: `Knowledge brain refused the restore (${(r.json && r.json.error) || r.res.status}).` };
  if (r.json && r.json.unchanged) return { success: true, output: `Note ${noteId.slice(0, 8)} already matches revision ${rev}; nothing changed.` };
  emitNotes('quox.notes.update', ctx, noteId, { content_hash: r.json && r.json.note && r.json.note.content_hash, rev: r.json && r.json.revision && r.json.revision.rev, via: 'brain_restore' });
  return { success: true, output: `Restored note ${noteId.slice(0, 8)} to revision ${rev} (recorded as a new revision, so this can be undone).` };
}

// ONE-BRAIN CX2: graph neighbours. Reads the brain's own GET /notes/:id, which
// scope-checks both link directions (an invisible target comes back with id null).
const NEIGHBOUR_CAP = 25;

async function brainNeighbours(input, ctx, { fetchImpl = fetch } = {}) {
  const bad = readPreflight(input, ctx);
  if (bad) return bad;
  const noteId = input.noteId.trim();
  const r = await call(fetchImpl, `${BRAIN_URL}/notes/${encodeURIComponent(noteId)}`, { method: 'GET', headers: headersFor(ctx, { 'X-Quox-Source': 'agent' }) });
  if (r.unavailable) return { success: false, error: 'knowledge_brain_unavailable', output: 'Knowledge brain unavailable, could not complete the request.' };
  if (r.res.status === 404) return { success: false, error: 'not_found', output: `Note not found (or not visible to you): ${noteId}` };
  if (!r.res.ok) return { success: false, error: (r.json && r.json.error) || `http_${r.res.status}`, output: `Knowledge brain refused the neighbours lookup (${(r.json && r.json.error) || r.res.status}).` };
  if (!r.json || typeof r.json !== 'object') return { success: false, error: 'bad_response', output: 'Knowledge brain returned an unreadable response.' };
  const title = r.json.title || '(untitled)';
  const outAll = Array.isArray(r.json.outlinks) ? r.json.outlinks : [];
  const backAll = Array.isArray(r.json.backlinks) ? r.json.backlinks : [];
  const resolved = outAll.filter((l) => l && l.resolved && l.id);
  const dangling = outAll.filter((l) => l && !(l.resolved && l.id));
  const linksOut = resolved.slice(0, NEIGHBOUR_CAP).map((l) => ({ noteId: l.id, title: l.title || '(untitled)', type: l.type }));
  const danglingOut = dangling.slice(0, NEIGHBOUR_CAP).map((l) => ({ name: l.targetRaw || '(unnamed)', type: l.type }));
  const linkedFrom = backAll.slice(0, NEIGHBOUR_CAP).map((l) => ({ noteId: l.id, title: l.title || '(untitled)' }));
  const lines = [`Neighbours of "${title}" (noteId: ${noteId}):`, ''];
  lines.push(`Links out (${resolved.length} resolved, ${dangling.length} dangling):`);
  if (!outAll.length) lines.push('  none');
  linksOut.forEach((l) => lines.push(`  - ${l.title} (noteId: ${l.noteId})`));
  if (resolved.length > NEIGHBOUR_CAP) lines.push(`  [${resolved.length - NEIGHBOUR_CAP} more resolved links not shown]`);
  if (dangling.length) {
    lines.push(`  Dangling (target not found or not visible): ${danglingOut.map((d) => d.name).join(', ')}`);
    if (dangling.length > NEIGHBOUR_CAP) lines.push(`  [${dangling.length - NEIGHBOUR_CAP} more dangling links not shown]`);
  }
  lines.push('', `Linked from (${backAll.length}):`);
  if (!backAll.length) lines.push('  none');
  linkedFrom.forEach((l) => lines.push(`  - ${l.title} (noteId: ${l.noteId})`));
  if (backAll.length > NEIGHBOUR_CAP) lines.push(`  [${backAll.length - NEIGHBOUR_CAP} more backlinks not shown]`);
  return {
    success: true, noteId, title,
    linksOut, dangling: danglingOut, linkedFrom,
    counts: { linksOut: resolved.length, dangling: dangling.length, linkedFrom: backAll.length },
    output: lines.join('\n'),
  };
}

module.exports = { brainUpdate, brainDelete, brainRelated, brainHistory, brainRestore, brainNeighbours };

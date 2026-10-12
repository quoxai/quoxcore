/**
 * NotesQ evidence for writes that do not go through createNotesqCall.
 *
 * Cortex's brain_save / brain_update / brain_delete write NotesQ notes straight
 * to quoxbrain (Qortex's engine is free in Core, so they are deliberately NOT
 * gated on the NotesQ licence). They used to leave no quox.notes.* evidence at
 * all (scorecard GAP, 2026-10-07). They now emit the same envelope shape as
 * lib/notesq/call.js: the real acting agent as sender, ids and hashes only,
 * never note content or titles. Wired once at boot by server.js.
 */
let _audit = null;

function setNotesAudit(fn) { _audit = typeof fn === 'function' ? fn : null; }

function emitNotes(intent, ctx, noteId, extra = {}) {
  if (!_audit) return;
  try {
    _audit({
      from: `agent.${(ctx && ctx.agentId) || 'unknown'}`,
      type: 'action',
      intent,
      corr: noteId || null,
      payload: {
        orgId: ctx && ctx.orgId, userId: (ctx && ctx.userId) || null, noteId: noteId || null,
        scope: extra.scope || 'user', rev: extra.rev ?? null, content_hash: extra.content_hash || null, via: extra.via || null,
      },
    });
  } catch (e) {
    // Evidence must never fail the user's write; surface it in the log instead.
    console.error('[notesq] evidence emit failed:', e?.message);
  }
}

module.exports = { setNotesAudit, emitNotes };

/**
 * /undo: which tool calls count as state changes, and the small registry of KNOWN inverses.
 *
 * Receipts are content-free on purpose (the AEE envelope commits to the action by digest, never plaintext
 * args) and the stream summary only echoes a few safe keys. So an inverse is never built from "what the
 * receipt said the args were". Each entry binds its target from something that is really there: a safe key
 * in the call's own summary (slot name), or the server's own record of what the call produced, matched by
 * time window and accepted only when EXACTLY ONE record fits. Zero or several = not bound = nothing runs,
 * and the user gets the by-hand route. Nothing here guesses an inverse.
 */

const READ_ONLY = /(^|_)(list|get|read|search|status|view|history|health|query|check|show|stats|find|lookup|related|suggest|research|describe|info|accounts|folders|pending|proposals|blocked|report|transcript|doctor|ping|whoami|verify)(_|$)/;

/** A settled, successful, receipt-backed call that is not a read. */
export function isStateChanging(b) {
  return Boolean(b) && b.kind === 'tool' && b.status === 'ok' && Boolean(b.envelopeId) && Boolean(b.tool) && !READ_ONLY.test(String(b.tool));
}

export function lastStateChange(items) {
  const all = (items || []).filter(isStateChanging);
  return all.length ? all[all.length - 1] : null;
}

const WIN_BEFORE = 10_000;
const WIN_AFTER = 20_000;
const toMs = (v) => (typeof v === 'number' ? v : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
function inWindow(call, ts) {
  const t = toMs(ts);
  if (t == null || !Number.isFinite(call.startedAt)) return false;
  return t >= call.startedAt - WIN_BEFORE && t <= call.startedAt + (call.durationMs || 0) + WIN_AFTER;
}
const summaryKey = (call, key) => new RegExp(`(?:^|\\s)${key}=(\\S+)`).exec(String(call.summary || ''))?.[1] || null;

/** Each bind -> { ok: true, label, run(ops) -> { receipt } } | { ok: false, why, byHand } */
export const INVERSES = {
  slot_checkout: {
    did: 'checked a slot out for this conversation',
    async bind(call) {
      const name = summaryKey(call, 'name');
      if (!name) return { ok: false, why: 'the call summary does not name the slot', byHand: 'quox slot list, then quox slot release <name>' };
      return { ok: true, reverse: `release slot ${name} (the hold ends; the slot itself stays)`, run: (ops) => ops.releaseSlot(name) };
    }
  },
  inbox_move: {
    did: 'moved mail between folders',
    async bind(call, ops) {
      const moves = (await ops.recentMoves()).filter(m => inWindow(call, m.movedAt ?? m.moved_at));
      if (moves.length === 1) {
        const m = moves[0];
        return { ok: true, reverse: `move the message back from ${m.toFolder || m.to_folder || 'its new folder'} to ${m.fromFolder || m.from_folder || 'its source folder'} (move ${m.id})`, run: (o) => o.undoMove(m.id) };
      }
      return { ok: false, why: moves.length ? `more than one move fits that call (${moves.map(m => m.id).join(', ')}), so Quox can't tell which one it made` : 'no recorded move fits that call', byHand: 'quox mail moves, then quox mail undo <moveId>' };
    }
  },
  notesq_create: {
    did: 'created a note',
    async bind(call, ops) {
      const notes = (await ops.listNotes()).filter(n => inWindow(call, n.createdAt ?? n.created_at));
      if (notes.length === 1) {
        const n = notes[0];
        return { ok: true, reverse: `delete the note "${n.title || n.id}" (${n.id})`, run: (o) => o.deleteNote(n.id) };
      }
      return { ok: false, why: notes.length ? `more than one note fits that call (${notes.map(n => n.id).join(', ')})` : 'no recorded note fits that call', byHand: 'quox notes list, then delete the one you mean from NotesQ' };
    }
  }
};

/** Tools that change state but have no automatic inverse here: the by-hand route, stated plainly. */
export const BY_HAND = {
  activate_workflow: 'quox workflow list, then deactivate it from the dashboard or ask Quox to deactivate_workflow with the id',
  deactivate_workflow: 'reactivate it with activate_workflow, or from the dashboard',
  skill_manage: 'a created skill sits in the review queue: reject it there, or leave it unapproved',
  notesq_delete: 'ask Quox to notesq_restore the note, or use quox notes restore <id>',
  email_send: 'a sent email cannot be recalled',
  email: 'a sent email cannot be recalled',
  slot_say: 'a message already posted in a slot room stays there'
};

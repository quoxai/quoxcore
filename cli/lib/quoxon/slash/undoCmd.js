/** /undo last: find the last receipt-backed state change, explain it, and (when a known inverse binds) reverse it on y. */
import { lastStateChange, INVERSES, BY_HAND } from './inverses.js';

const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function createUndoCmd({ api, say, getItems, card, now = () => Date.now() }) {
  return async function undo(arg) {
    const a = String(arg || '').trim().toLowerCase();
    if (a && a !== 'last') return say('Usage: /undo last   (bare /undo does the same; Ctrl+_ undoes composer typing)', 'warn');
    const ops = api.undoOps;
    if (!ops) return say('/undo is not available in this mode.', 'warn');
    const call = lastStateChange(getItems());
    if (!call) return say('No Quox action in this conversation has a receipt to reverse yet.', 'dim');
    const when = Number.isFinite(call.startedAt) ? ago(now() - call.startedAt) : 'earlier';
    // The receipt is the evidence of what ran: read it back before offering to reverse anything.
    const rec = await ops.envelope(call.envelopeId);
    if (rec.ok) {
      const p = rec.env?.payload || {};
      if (p.tool_name && p.tool_name !== call.tool) return say(`The receipt ${call.envelopeId} is for ${p.tool_name}, not ${call.tool}, so nothing was offered.`, 'warn');
      if (p.success === false) return say(`The receipt says ${call.tool} did not succeed, so there is nothing to undo.`, 'warn');
    }
    const head = `undo │ ${call.tool} · ${when} · receipt ${call.envelopeId}${rec.ok ? '' : ` (receipt not read (${rec.error}))`}`;
    const inv = INVERSES[call.tool];
    if (!inv) {
      say(head);
      say(`Quox can't reverse ${call.tool} automatically.`, 'warn');
      say(`It did: ${clip(call.resultSummary || call.summary || call.tool, 100)}. By hand: ${BY_HAND[call.tool] || 'check what it changed with /proof and undo that yourself'}.`, 'dim');
      return undefined;
    }
    let bound;
    try { bound = await inv.bind(call, ops); } catch (e) { return say(`Could not work out what to reverse: ${e?.message || e}. Nothing ran.`, 'warn'); }
    if (!bound.ok) {
      say(head);
      say(`Quox can't reverse ${call.tool} automatically here: ${bound.why}.`, 'warn');
      say(`By hand: ${bound.byHand}.`, 'dim');
      return undefined;
    }
    card.ask([head, `It ${inv.did}: ${clip(call.resultSummary || call.summary, 100)}.`, `Undoing it will ${bound.reverse}.`],
      async () => {
        let r;
        try { r = await bound.run(ops); } catch (e) { return say(`NOT undone: ${e?.message || e}`, 'warn'); }
        say(`Undone: ${bound.reverse}.`, 'ok');
        say(r?.receipt ? `new receipt ${r.receipt}  (/proof ${r.receipt})` : 'The server returned no receipt id for this reversal, so there is nothing to /proof for it.', 'dim');
        return undefined;
      }, 'Cancelled; nothing was undone.', { question: 'Undo it?' });
    return undefined;
  };
}

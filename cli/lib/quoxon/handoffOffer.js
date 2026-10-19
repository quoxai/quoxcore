/**
 * QUOXON handoff offer (owner, live 2026-10-17 19:51). Attached to TRIAGE-Q, the owner asked which VMs use the most CPU
 * and memory; TRIAGE-Q had no fleet tools and told him to detach and ask CommanderQ. Offer, don't instruct: the server
 * sends turn.handoff_suggested (from the turn's tool selection, never the answer text) and the TUI asks once:
 *
 *   ⚠ TRIAGE-Q asks: Hand this question to CommanderQ?
 *     do     ask CommanderQ "which VMs use the most CPU and memory" once; you stay attached to TRIAGE-Q
 *     why    TRIAGE-Q can't read VM stats.
 *   ▶ Hand this question to CommanderQ? y yes · n no
 *
 * y sends the SAME question to CommanderQ for that one turn; the window stays attached. n does nothing.
 */
import { askText } from './ask.js';

const clipQ = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The suggestion from a turn event, when it applies to THIS window (attached to the agent it names). Else null. */
export function handoffFromEvent(ev, attachedAgent) {
  if (!ev || ev.type !== 'turn.handoff_suggested') return null;
  const h = ev.handoff_suggested;
  const at = String(attachedAgent || '').toLowerCase();
  if (!h || typeof h !== 'object' || !h.agent || !at) return null;
  if (String(h.agent).toLowerCase() === at) return null; // already talking to the target
  if (h.from && String(h.from).toLowerCase() !== at) return null; // a suggestion about some other agent
  return { agent: String(h.agent), name: String(h.name || h.agent), from: at, fromName: String(h.from_name || at.toUpperCase()), reason: String(h.reason || '').trim() };
}

/** The ask line (drawn as the approval-style card). question: the user's own words being handed over. */
export function handoffAskText(h, question, cols = 100) {
  const action = `ask ${h.name} "${clipQ(question, Math.max(20, cols - 60))}" once; you stay attached to ${h.fromName}`;
  return askText(`Hand this question to ${h.name}?`, { keys: 'y/N', who: h.fromName, reason: h.reason, action });
}

/** The one line after a yes-path answer: who answered, and that nothing about the attach changed. */
export const handoffAnsweredNote = (h) => `↪ ${h.name} answered that one. Still attached to ${h.fromName}.`;

/** The agent's own suggested command, dropped because the handoff answers the question (never silently). */
export const handoffSupersededNote = (h, line) => `↷ ${h.fromName} also suggested ${line || 'a command'}; not offered, because ${h.name} can answer the question itself.`;

/** A handoff that could not be offered because a plan card is open (never silently). */
export const handoffSkippedNote = (h) => `↷ ${h.name} could answer this, but the plan card is open, so the handoff is not offered.`;

/**
 * QUOXON handoff streak (owner, live 05:10-05:17): attached to TRIAGE-Q he asked three infra questions and every one ended
 * in "Hand this question to CommanderQ?". When the SAME attached agent has suggested a handoff on 2 turns in a row, the
 * card offers the bigger move (back to CommanderQ) instead of the same small one. c ("keep asking") silences the bigger
 * offer until a new streak starts; a turn with no suggestion, or a different agent, breaks the streak.
 */
export function createHandoffStreak() {
  let agent = null, count = 0, muted = false;
  return {
    /** A turn ended with a handoff suggestion from `from`. -> { count, escalate } */
    offered(from) {
      const f = String(from || '').toLowerCase();
      if (f === agent) count += 1; else { agent = f; count = 1; muted = false; }
      return { count, escalate: count >= 2 && !muted };
    },
    /** A turn ended without a suggestion (or the window moved agents): the streak is over. */
    clear() { agent = null; count = 0; muted = false; },
    /** n (just this one): the bigger offer needs a fresh run of two before it returns. */
    restart() { count = 0; },
    /** c (keep asking): no bigger offer until a new streak starts. */
    mute() { muted = true; },
    peek: () => ({ agent, count, muted }),
  };
}

export const HANDOFF_BIG_KEYS = (h) => `y switch · n just this one · c keep asking ${h.fromName}`;

/** The bigger card: offer to move the whole window back instead of handing over one more question. */
export function handoffBiggerAskText(h, count) {
  return askText(`Switch this window back to ${h.name}?`, {
    keys: HANDOFF_BIG_KEYS(h),
    who: h.fromName,
    reason: `${h.fromName} has handed off your last ${count} questions`,
    action: `/detach: this window stops being attached to ${h.fromName} and talks to ${h.name}`,
  });
}

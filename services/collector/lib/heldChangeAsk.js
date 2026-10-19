'use strict';

/**
 * SITE-CLI 2026-10-17 journey-server-trouble-fix-end-to-end (ev_mvcpwzqm_e8c14c): the user asked "propose the exact
 * change and hold it for my approval". Quox diagnosed it right, then ended on "Say the word and I'll raise the fix
 * for approval" with no card filed. The user's approval IS the gate: an explicit hold-for-approval ask means issue the
 * change so the approval gate holds it as a card. Nothing here ever approves or runs a change.
 */

// "hold it for my approval", "hold the change until I approve", "raise the fix for my approval",
// "wait for my approval". "hold off" is not a hold-for-approval ask.
const HELD_CHANGE_ASK_RE = new RegExp([
  String.raw`\bhold\s+(?:it|them|this|that|the\s+(?:fix|change|command|restart)s?)?\s*(?:for|until)\s+(?:my|our|an?|your)?\s*(?:approv\w*|sign[- ]?off|ok|okay)\b`,
  String.raw`\bhold\s+(?:it|them|this|that|the\s+(?:fix|change)s?)\s+until\s+I\s+(?:approve|say)\b`,
  String.raw`\b(?:propose|raise|file|queue|prepare|stage|submit)\b[\s\S]{0,120}?\bfor\s+(?:my|our)\s+(?:approv\w*|sign[- ]?off)\b`,
  String.raw`\b(?:propose|raise|file|queue|prepare|stage)\b[\s\S]{0,160}?\bwait\s+for\s+(?:my|our)\s+approv\w*\b`,
].join('|'), 'i');

function isHeldChangeAsk(text) {
  return HELD_CHANGE_ASK_RE.test(String(text || ''));
}

// The answer carries a concrete proposal (a command block, a "proposed fix", or an offer to raise or apply it).
const PROPOSAL_RE = /```|\bproposed\s+(?:fix|change|command)s?\b|\b(?:say the word|want me to|shall I|should I|would you like me to|do you want me to)\b[^\n]{0,160}\b(?:raise|file|propose|apply|run|restart|start|hold|submit|queue|fix)\b/i;

/** -> true only when the user asked for a held change, the answer proposes one, and we KNOW no card was filed. */
function needsHeldChangeFollowUp({ ask, answer, approvalsFiled }) {
  if (approvalsFiled !== 0) return false; // a card exists, or the count is unknown: never guess
  if (!isHeldChangeAsk(ask)) return false;
  return PROPOSAL_RE.test(String(answer || ''));
}

const HELD_CHANGE_FOLLOW_UP = 'The user already asked you to propose the fix and hold it for their approval, so do not ask them again '
  + 'and do not end with an offer. Issue the change now through the governed tool that makes it (or delegate it to the agent '
  + 'that holds that tool and tell it to run it), so the approval gate files it as an approval card. Nothing runs until '
  + 'the user approves that card. Then reply in two or three sentences: the change you raised, its approval id, and that it '
  + 'runs only once they approve. If the tool came back held, that is the expected result. If no governed tool can make this '
  + 'change, say that plainly instead.';

// SITE-CLI condition (2026-10-17): the continued step is never a silent retry. It is labelled in the answer, streamed,
// and witnessed as its own audit envelope, so a reader (and the journey page) can say exactly what happened.
const HELD_CHANGE_STEP_LABEL = 'Issuing the held change for your approval';
const HELD_CHANGE_STEP_LINE = `**${HELD_CHANGE_STEP_LABEL}** (you asked for the fix to be held; nothing runs until you approve the card)`;
const HELD_CHANGE_INTENT = 'quox.chat.held_change_follow_up';

/** Answer text for the turn: the first answer without its trailing offer, the labelled step, the follow-up's answer. */
function joinFollowUpAnswer(first, second) {
  const a = String(first || '').replace(/\n*[^\n]*\b(?:say the word|want me to|shall I|should I|would you like me to|do you want me to)\b[^\n]*\s*$/i, '').trimEnd();
  const b = String(second || '').trim();
  return b ? `${a}\n\n${HELD_CHANGE_STEP_LINE}\n\n${b}` : a;
}

/** The audit envelope that witnesses the continued step (stored by the dispatcher that ran it). */
function heldChangeEnvelope({ agent, path, corr, orgId, userId, ask, firstAnswer, filedBefore }) {
  const clip = (t) => { const x = String(t || ''); return x.length > 240 ? `${x.slice(0, 237)}...` : x; };
  return {
    type: 'event', from: `agent.${agent || 'quox'}`, to: 'audit.system', intent: HELD_CHANGE_INTENT, corr: corr || `HELD_${Date.now()}`,
    payload: {
      step: HELD_CHANGE_STEP_LABEL, agent: agent || 'quox', path, reason: 'held-change ask; the answer proposed a fix and no approval card was filed this turn',
      approvals_filed_before: filedBefore, query_preview: clip(ask), first_answer_preview: clip(firstAnswer),
      org_id: orgId || undefined, user_id: userId || undefined,
    },
  };
}

module.exports = {
  isHeldChangeAsk, needsHeldChangeFollowUp, joinFollowUpAnswer, heldChangeEnvelope,
  HELD_CHANGE_FOLLOW_UP, HELD_CHANGE_ASK_RE, HELD_CHANGE_STEP_LABEL, HELD_CHANGE_STEP_LINE, HELD_CHANGE_INTENT,
};

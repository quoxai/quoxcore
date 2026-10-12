/**
 * QUOXCHAT-PRO — server-side human-handoff intent belt.
 *
 * The LLM tool loop is the primary path for human_handoff. This module is
 * the BELT under it: when the visitor's message is an explicit, unambiguous
 * ask for a human AND the widget has the human_handoff builtin enabled, the
 * route can trigger the handoff flow directly — critically, this still works
 * when the LLM path could not call tools at all (provider outage, 429, or a
 * model that failed mid-loop). Without it, an Anthropic outage silently
 * removes every widget tool including human_handoff and the visitor gets a
 * canned apology instead of an escalation.
 *
 * Deliberately CONSERVATIVE: patterns require an explicit human-request
 * phrasing ("speak to a human", "talk to a real person", "live agent",
 * "connect me to support" style). Topic mentions ("human resources",
 * "human-readable", "how do agents work") must NOT match. False negatives
 * are acceptable (the LLM path remains primary); false positives are not.
 */

// NOTE: bare "agent" is included, but this noun set is ONLY ever used inside
// explicit request constructs ("speak/talk to …", "connect me to …",
// "I want …"), so topic mentions like "how do AI agents work" cannot match.
// "someone" with no qualifier counts too: inside these explicit request
// constructs ("speak to someone", "I want someone") a support-widget
// visitor asking for someone is asking for a person, not a topic (QCFT
// eval, action-speak-to-someone).
const HUMAN_NOUN = '(?:human(?:\\s+being)?|real\\s+person|(?:live|human|real)\\s+agent|an\\s+agent|live\\s+support|(?:an?\\s+)?operator|(?:a\\s+)?representative|someone(?:\\s+(?:real|from\\s+(?:your\\s+)?(?:team|support|sales|staff)))?)';

const HANDOFF_INTENT_PATTERNS = [
  // "can I speak/talk/chat to/with a human / a real person / an agent ..."
  new RegExp(`\\b(?:speak|talk|chat)\\s+(?:to|with)\\s+(?:an?\\s+)?${HUMAN_NOUN}\\b`, 'i'),
  // "I want/need (to talk to) a human", "I'd like a human", "get me a human"
  new RegExp(`\\b(?:i\\s+(?:want|need|would\\s+like|wanna|'?d\\s+like)|give\\s+me|get\\s+me)\\s+(?:to\\s+(?:speak|talk|chat)\\s+(?:to|with)\\s+)?(?:an?\\s+)?${HUMAN_NOUN}\\b`, 'i'),
  // "connect/transfer/put me (through) to a human/agent/support person"
  new RegExp(`\\b(?:connect|transfer|put)\\s+me\\s+(?:through\\s+)?(?:to|with)\\s+(?:an?\\s+)?(?:${HUMAN_NOUN}|(?:customer\\s+)?(?:support|service)(?:\\s+(?:person|team|agent|rep(?:resentative)?))?)\\b`, 'i'),
  // "human please", "agent please", "real person please" (short commands)
  new RegExp(`^\\s*(?:${HUMAN_NOUN}|human|agent)[,!.\\s]*please[.!\\s]*$`, 'i'),
  // bare escalation commands widgets commonly receive
  /^\s*(?:human|live\s+agent|real\s+person)\s*[.!?]*\s*$/i,
  // "is there a human/person I can talk/speak to"
  new RegExp(`\\bis\\s+there\\s+(?:an?\\s+)?${HUMAN_NOUN}\\s+(?:i|we)\\s+can\\s+(?:speak|talk|chat)\\s+(?:to|with)\\b`, 'i'),
  // "stop talking to a bot", "I don't want to talk to a bot/AI"
  /\b(?:don'?t|do\s+not)\s+want\s+to\s+(?:speak|talk|chat)\s+(?:to|with)\s+(?:a\s+)?(?:bot|robot|machine|an?\s+ai)\b/i,
];

const ABOUT_HANDOFF_RE = [
  /\b(?:on|in|from|of)\s+(?:my|our)\s+(?:own\s+)?(?:team|staff|company|side|support\s+team)\b/i,
  /\b(?:which|what)\s+(?:plan|tier|package|edition)\b|\b(?:plan|tier)\s+(?:includes?|has|do\s+i\s+need)\b|\bis\s+(?:it|that|this)\s+(?:on|in)\s+(?:standard|pro(?:fessional)?)\b|\bon\s+(?:standard|pro(?:fessional)?)\s*\?/i,
  /\b(?:how\s+much|cost|price|pricing)\b/i,
  /\bhandoff\s+feature\b|\bdoes\s+(?:quoxchat|the\s+widget|it)\s+(?:let|allow|support)\b/i,
];

/**
 * @param {string} message — the raw visitor message for this turn.
 * @returns {{ match: boolean, pattern: string|null }}
 */
function detectHumanHandoffIntent(message) {
  if (typeof message !== 'string' || !message.trim()) return { match: false, pattern: null };
  // Bound the scan: explicit asks are short; a 2,000+ char paste is far more
  // likely to CONTAIN one of these phrases incidentally (quoted docs, logs).
  const text = message.slice(0, 500);
  // QUOXCHAT-BRUTALOOP: a question ABOUT human handoff is not a request for
  // one. "I want a human on my team to take over... which plan?" paged a
  // real operator on the dev eval. Exclude the visitor's own staff and
  // plan / pricing / feature questions; explicit asks still match.
  if (ABOUT_HANDOFF_RE.some((re) => re.test(text))) return { match: false, pattern: null };
  for (const re of HANDOFF_INTENT_PATTERNS) {
    if (re.test(text)) return { match: true, pattern: re.source.slice(0, 80) };
  }
  return { match: false, pattern: null };
}

/**
 * Belt decision helper: returns the widget's enabled human_handoff builtin
 * tool row when the message is an explicit ask for a human, else null.
 * `tools` is the array fetchWidgetTools() returned (already status='active'
 * filtered server-side by auth).
 */
function shouldTriggerHandoffBelt({ message, tools }) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const handoffTool = tools.find(
    (t) => t && t.tool_type === 'builtin' && t.builtin_kind === 'human_handoff',
  );
  if (!handoffTool) return null;
  const intent = detectHumanHandoffIntent(message);
  if (!intent.match) return null;
  return { tool: handoffTool, pattern: intent.pattern };
}

// QUOXCHAT-BRUTALOOP wave 5: the model may call human_handoff only when the
// visitor asked for a person or an escalation (this turn or the last two user
// turns). Broader than the belt patterns on purpose: a missed real ask is
// worse than one extra page, but an insult or a plain question is neither.
const LOOSE_PERSON_ASK_RE = /\b(human|person|people|someone|somebody|staff|operator|agent|representative|rep|manager|supervisor|team|support|sales|anyone|real\s+person)\b/i;
const LOOSE_ASK_VERB_RE = /\b(talk|speak|chat|call|ring|phone|email|contact|reach|connect|escalat\w*|transfer|hand\s*(?:me\s+)?(?:off|over)|get\s+me|need|want|help\s+me|complain\w*)\b/i;

function modelHandoffAllowed({ message, recentUserMessages } = {}) {
  const turns = [message, ...(Array.isArray(recentUserMessages) ? recentUserMessages.slice(-2) : [])];
  for (const t of turns) {
    if (typeof t !== 'string' || !t.trim()) continue;
    const text = t.slice(0, 500);
    if (detectHumanHandoffIntent(text).match) return true;
    if (/\bescalat\w*\b/i.test(text)) return true;
    if (LOOSE_PERSON_ASK_RE.test(text) && LOOSE_ASK_VERB_RE.test(text)) return true;
  }
  return false;
}

// Returns a refusal result for a MODEL call to the human_handoff builtin when
// the turn's verdict says the visitor never asked; null otherwise (including
// when no verdict was computed, so belt/chip/operator paths are untouched).
function gateModelHandoff(tool, context) {
  if (!tool || !context || context.handoffAllowed !== false) return null;
  const kind = tool.builtin_kind || tool.name;
  if (kind !== 'human_handoff') return null;
  return {
    ok: false,
    error: 'handoff_not_requested',
    message: 'The visitor has not asked for a person. Do not hand off. Answer them yourself, calmly, and offer a human only if they want one.',
  };
}

module.exports = {
  modelHandoffAllowed,
  gateModelHandoff,
  detectHumanHandoffIntent,
  shouldTriggerHandoffBelt,
  HANDOFF_INTENT_PATTERNS,
};

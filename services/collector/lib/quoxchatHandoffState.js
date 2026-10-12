/**
 * QuoxChat handoff state helpers.
 *
 * 1. A local marker of conversations KNOWN to be handed off. The /message gate
 *    looks the handoff up in auth on every turn; when that lookup throws, the
 *    "your conversation is with our team but we could not reach them" text is
 *    only true if this conversation really was handed off. Without a marker,
 *    the old code told EVERY visitor that (zero-memory audit, 2026-10-10).
 * 2. lookupWithRetry: one short retry before degrading.
 * 3. Wait-question answers for a visitor who is handed off and waiting. The
 *    answer is built from availability data only; wait times are never made up.
 */
'use strict';

const MARKER_TTL_MS = 24 * 60 * 60 * 1000; // same window as the auth lookup
const MAX_MARKERS = 5000;
const markers = new Map();

const keyOf = (widgetId, visitorId) => `${widgetId}::${visitorId}`;

function markHandedOff(widgetId, visitorId, { conversationId, at } = {}) {
  if (!widgetId || !visitorId || !conversationId) return;
  const k = keyOf(widgetId, visitorId);
  const prev = markers.get(k);
  if (markers.size >= MAX_MARKERS && !prev) {
    // bounded: drop the oldest entry
    const first = markers.keys().next().value;
    markers.delete(first);
  }
  markers.set(k, {
    conversationId,
    // keep the original handoff time across later refreshes
    at: Number.isFinite(at) ? at : (prev && prev.conversationId === conversationId ? prev.at : null),
    seen: Date.now(),
  });
}

function getHandedOff(widgetId, visitorId, now = Date.now()) {
  const k = keyOf(widgetId, visitorId);
  const m = markers.get(k);
  if (!m) return null;
  if (now - m.seen > MARKER_TTL_MS) { markers.delete(k); return null; }
  return m;
}

function clearHandedOff(widgetId, visitorId) {
  markers.delete(keyOf(widgetId, visitorId));
}

function _resetForTest() { markers.clear(); }

/**
 * Run `fn`; on throw wait delayMs and run it once more (retries total).
 * Throws the LAST error if every attempt failed.
 */
async function lookupWithRetry(fn, { retries = 1, delayMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(delayMs);
    }
  }
  throw lastErr;
}

const WAIT_RE = [
  /\b(?:how\s+long|how\s+much\s+longer|how\s+soon|when)\b[^?.!]*\b(?:wait|will\s+(?:they|someone|somebody|anyone|a\s+(?:human|person|agent))|until|be\s+(?:with|replied|answered|seen)|reply|respond|get\s+back|join|come|coming|arrive|take|takes)\b/i,
  /\bhow\s+long\b[^?.!]*\b(?:wait|take|takes|will\s+it)\b/i,
  /\b(?:are|is)\s+(?:they|someone|somebody|anyone|anybody|a\s+(?:human|person|agent)|the\s+(?:team|staff|human|agent))\s+(?:actually\s+|really\s+|even\s+|still\s+)?(?:coming|there|here|online|around|available|going\s+to|on\s+(?:their|the)\s+way|joining|replying|responding|looking)\b/i,
  /\b(?:is\s+anyone|is\s+anybody|anyone|anybody)\s+(?:actually\s+|really\s+|even\s+)?(?:there|coming|here|going\s+to\s+(?:reply|answer|respond)|available|online)\b/i,
  /\bhow\s+long\s+(?:will|do|should|must)\s+i\b/i,
  /\b(?:still\s+waiting|any\s+(?:update|news)|what(?:'s|\s+is)\s+(?:happening|taking)|status\s+(?:of|update))\b/i,
];

/** True when the message is the visitor asking whether/when a human will arrive. */
function isWaitQuestion(message) {
  if (typeof message !== 'string') return false;
  const m = message.trim();
  if (!m || m.length > 300) return false;
  return WAIT_RE.some((re) => re.test(m));
}

function minutesPhrase(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'just now';
  if (mins === 1) return 'about a minute ago';
  if (mins < 60) return `about ${mins} minutes ago`;
  const h = Math.round(mins / 60);
  return h === 1 ? 'about an hour ago' : `about ${h} hours ago`;
}

/**
 * Visitor-voice answer for a handed-off visitor asking about the wait.
 * @param {object} p
 * @param {{operator_online?: boolean, within_office_hours?: boolean, human_available?: boolean}|null} p.availability
 * @param {number|null} p.handedOffAt epoch ms of the handoff request, when known
 * @param {number} [p.now]
 */
function buildWaitReply({ availability, handedOffAt, now = Date.now() } = {}) {
  const since = Number.isFinite(handedOffAt) ? `You asked for a person ${minutesPhrase(now - handedOffAt)}. ` : '';
  const kept = 'Your messages are saved in this chat, and any reply will appear here, so you can keep this window open.';
  if (!availability || typeof availability !== 'object') {
    return `${since}Your request is with the team. I can't see whether anyone is online right now, and I can't promise a time. ${kept}`;
  }
  if (availability.human_available) {
    return `${since}The team has been told and your chat is in their queue, and they are online now. I can't give you an exact wait time. ${kept}`;
  }
  if (availability.operator_online === false) {
    return `${since}The team is not online at the moment, so I can't say when someone will pick this up. ${kept}`;
  }
  return `${since}The team is outside their usual hours right now, so a reply may not come until they are back. I can't give you an exact time. ${kept}`;
}

/**
 * Best-effort name/email extraction from a visitor message typed while a
 * handoff is pending ("Sam Carter, sam@example.com", "I'm Sam", "my name is
 * Priya"). Conservative on purpose: a normal question yields nothing, and a
 * bare capitalised word is only taken as a name when an email sits beside it.
 * The values are visitor-supplied and unverified; auth stores them with the
 * same length caps and format check as the widget's name form.
 */
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const NAME_WORD = "[A-Z][\\p{L}'\\u2019-]*";
const NAME_AFTER_PHRASE = new RegExp(`(?:\\b[Mm]y name(?: is|'s)|\\b[Nn]ame is|\\bI am|\\bI'm|\\bI\\u2019m|\\b[Tt]his is|\\b[Cc]all me)\\s+(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`, 'u');
const NAME_BARE = new RegExp(`^(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})\\s*[,;:\\-]?\\s*$`, 'u');
const NOT_A_NAME = new Set(['hi', 'hello', 'hey', 'thanks', 'thank', 'yes', 'ok', 'okay', 'sure', 'please', 'email', 'my', 'it', 'the']);

function extractVisitorIdentity(message) {
  const text = typeof message === 'string' ? message.slice(0, 1000) : '';
  const m = text.match(EMAIL_IN_TEXT);
  const email = m ? m[0].slice(0, 254) : null;
  let name = null;
  const p = text.match(NAME_AFTER_PHRASE);
  if (p) name = p[1];
  else if (email) {
    const rest = text.replace(email, ' ').replace(/\b(?:email|e-mail|mail)\b\s*(?:is|:)?/gi, ' ').trim();
    const b = rest.match(NAME_BARE);
    if (b) name = b[1];
  }
  if (name && NOT_A_NAME.has(name.trim().split(/\s+/)[0].toLowerCase())) name = null;
  return { name: name ? name.trim().slice(0, 120) : null, email };
}

/**
 * The name a VISITOR sees on an operator reply. The stored sender_name can be
 * an internal identity (a Matrix profile such as "Resident (dev-host-01)", a
 * localpart "human.moo", an mxid, or a host name); those leak infrastructure
 * and read as a bot. A trailing "(...)" qualifier is dropped, and anything
 * that still looks internal, or is empty, becomes the neutral "Support team".
 * The raw name stays in the operator-side Logs.
 */
const NEUTRAL_OPERATOR_NAME = 'Support team';
function visitorSafeOperatorName(name) {
  if (typeof name !== 'string') return NEUTRAL_OPERATOR_NAME;
  let n = name.replace(/\s*\([^)]*\)\s*$/, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return NEUTRAL_OPERATOR_NAME;
  if (/[@:]/.test(n)) return NEUTRAL_OPERATOR_NAME; // mxid / email-ish
  if (/^(human|agent|bot|system|qc|svc)[._-]/i.test(n)) return NEUTRAL_OPERATOR_NAME; // localparts
  if (/\b(resident|qcore|quox-?agent|assistant|bastion)\b/i.test(n)) return NEUTRAL_OPERATOR_NAME;
  if (/^[a-z]+[a-z0-9-]*\d{2,}$/i.test(n)) return NEUTRAL_OPERATOR_NAME; // host-like (bastion-01)
  return n.slice(0, 60);
}

module.exports = {
  visitorSafeOperatorName,
  NEUTRAL_OPERATOR_NAME,
  extractVisitorIdentity,
  markHandedOff,
  getHandedOff,
  clearHandedOff,
  lookupWithRetry,
  isWaitQuestion,
  buildWaitReply,
  _resetForTest,
};

/**
 * QUOXON-ASK (owner 2026-10-15): one shape for everything that needs the human's answer, so it is learnt once.
 *
 *   ▶ <reason> <question> <keys>
 *
 * A fixed glyph first, the reason (why it is asking) next, the question, and the answer keys LAST. Rendered in the
 * 'ask' tone (bold, the ask colour on the glyph and keys; never dim). Approval cards end in the same line.
 * Every y/N the TUI says goes through askText; a test fails on a raw "y/N" anywhere else.
 */
export const ASK_GLYPH = '▶';
export const ASK_KEYS = 'y/N/c'; // y: do it · n or Enter: don't · c or any other text: chat about it first (owner 2026-10-15)

// The structured ask behind each line askText made, so the renderer can draw the card (who, action, why, keys)
// from the text a module said. Bounded; an unknown line is parsed back instead.
const MADE = new Map();
const MADE_MAX = 200;

/**
 * The ask line's text (the transcript form; the TUI draws it as a card). reason is said first (a trailing "." is
 * added when it has no end stop). who: who is asking (QUOX, an agent, a slot sender; default this terminal).
 * action: exactly what a yes does, shown in full on the card.
 */
export function askText(question, { keys = ASK_KEYS, reason = '', who = '', action = '', title = '', plain = false } = {}) {
  const r = String(reason || '').trim();
  const q = String(question || '').trim();
  const lead = r ? `${/[.!?:)]$/.test(r) ? r : `${r}.`} ` : '';
  const text = `${ASK_GLYPH} ${lead}${q}${keys ? ` ${keys}` : ''}`;
  MADE.set(text, { question: q, reason: r, keys: keys || '', who: String(who || '').trim(), action: String(action || '').trim(), title: String(title || '').trim(), plain: Boolean(plain) });
  if (MADE.size > MADE_MAX) MADE.delete(MADE.keys().next().value);
  return text;
}

/** An ask line -> { question, reason, keys, who, action } (what askText was given; parsed back when unknown). */
export function parseAsk(text) {
  const t = String(text ?? '');
  if (MADE.has(t)) return { ...MADE.get(t) };
  const question = askQuestion(t);
  const body = t.replace(new RegExp(`^\\s*${ASK_GLYPH}\\s*`), '');
  const qi = body.lastIndexOf(question);
  const reason = qi > 0 ? body.slice(0, qi).trim() : '';
  const keys = qi >= 0 ? body.slice(qi + question.length).trim() : '';
  return { question, reason, keys, who: '', action: '' };
}

/** The card footer's keys, spelled out the way approvals show theirs. */
export function keysLabel(keys) {
  const k = String(keys || '').trim();
  if (k === 'y/N/c') return 'y yes · n no · c chat';
  if (k === 'y/N' || k === 'y/n') return 'y yes · n no';
  if (/^\(?Y\/n\)?$/.test(k)) return 'y yes · n no (Enter is yes)';
  return k;
}

/** The question part of an ask line ("▶ reason. Question? keys" -> "Question?"), for "Tell me more about: ...". */
export function askQuestion(line) {
  const s = String(line || '').replace(new RegExp(`^\\s*${ASK_GLYPH}\\s*`), '');
  const end = s.lastIndexOf('?');
  if (end < 0) return s.trim();
  const head = s.slice(0, end + 1);
  let start = 0;
  for (const m of head.matchAll(/[.;!)] (?=[A-Z])/g)) start = m.index + 2; // the last sentence before the "?"
  return head.slice(start).trim();
}

/** y/N/c: what an answer line means. 'yes' | 'no' (n, no, empty) | 'command' (a slash line) | 'chat' (c, or any other text). */
export function askAnswer(text) {
  const t = String(text ?? '').trim();
  if (/^y(es)?$/i.test(t)) return 'yes';
  if (!t || /^no?$/i.test(t)) return 'no';
  if (t.startsWith('/')) return 'command';
  return 'chat';
}

/** The chat turn an ask's c/free text sends. Bare c (or "chat"): "Tell me more about: <question>, before I decide". */
export function askChatMessage(text, question) {
  const t = String(text ?? '').trim();
  if (/^c(hat)?$/i.test(t)) return `Tell me more about: ${question.replace(/\?$/, '')}, before I decide`;
  return `${t}\n\n(The terminal is waiting for my y/N answer to: "${question}". I have not answered it yet.)`;
}

// ASK-SETTLE (owner 2026-10-17: "questions should go once answered, or change to answer"): an open ask is a live
// card; once answered, expired or no longer open it leaves the screen and ONE line stays in the scrollback.
/** HH:MM of a timestamp, in this terminal's local time. */
export function askClock(at = Date.now()) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The one line an ask leaves behind. outcome.kind: yes | no | run | skipped (outcome.cmd) | expired | closed. */
export function settledAskLine(question, outcome, at = Date.now()) {
  const q = String(question || '').trim();
  const t = askClock(at);
  switch (outcome?.kind) {
    case 'yes': return `✔ ${q} yes (${t})`;
    case 'run': return `✔ ${q} run (${t})`;
    case 'no': return `✔ ${q} no (${t})`;
    case 'skipped': return `✔ ${q} skipped, you ran ${String(outcome.cmd || 'a command').split(/\s/)[0]} (${t})`;
    case 'dismissed': return `↷ ${q} offer dismissed (${t})`;
    case 'expired': return `⌛ ${q} expired, not answered (${t})`;
    default: return `↷ ${q} no longer open (${t})`;
  }
}
/** The note tone a settled line is shown in (never dim: no grey text). */
export const settledAskTone = (kind) => (kind === 'yes' || kind === 'run' ? 'ok' : 'plain');

/** What a submitted line does to an open ask: { kind } for an answer, or null (c / free text keeps it open). */
export function askOutcomeOf(text, { runWord = false } = {}) {
  const t = String(text ?? '').trim();
  if (runWord && /^run$/i.test(t)) return { kind: 'run' };
  const a = askAnswer(t);
  if (a === 'yes') return { kind: 'yes' };
  if (a === 'no') return { kind: 'no' };
  if (a === 'command') return { kind: 'skipped', cmd: t };
  return null;
}

/** A chat line that asks about the open offer (so the card stays): a question, "c", or a why/what/how/explain opener. Anything else is the user moving on, which dismisses the offer. */
export function isAskClarification(text) {
  const t = String(text ?? '').trim();
  return /^c(hat)?$/i.test(t) || /\?\s*$/.test(t) || /^(why|what|how|which|who|when|where|explain|tell me|can you|could you|does|is it|is this)\b/i.test(t);
}

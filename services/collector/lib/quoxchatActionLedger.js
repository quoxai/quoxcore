/**
 * QuoxChat action ledger + action honesty gate.
 *
 * Zero-memory audits showed two faults that share a root cause: the model
 * cannot see what the server DID in earlier turns, so (a) it denies a demo
 * request it just recorded ("I cannot confirm that the demo was booked") and
 * (b) with nothing to anchor it, it claims actions that never ran ("I've
 * noted your request").
 *
 * Fix, in code not prose:
 *   - summariseOutcome / buildActionLedgerBlock: a trusted, server-written
 *     "ACTIONS IN THIS CONVERSATION" block injected into every prompt. Built
 *     from persisted tool calls, so it survives across turns. No raw emails,
 *     no tool inputs: only kind, ok, reference, preferred time, timestamp.
 *   - enforceActionHonesty: deterministic gate. A reply sentence that claims
 *     a completed action which neither this turn's tool results nor the
 *     ledger show is replaced with an honest offer to do it.
 */
'use strict';

const MAX_LEDGER_ENTRIES = 12;

// Tool name / builtin kind -> action class used for matching claims.
function actionClass(name) {
  const n = String(name || '').toLowerCase();
  if (/demo/.test(n)) return 'demo';
  if (/appointment|booking/.test(n)) return 'demo';
  if (/transcript/.test(n)) return 'email';
  if (/handoff|hand_off/.test(n)) return 'handoff';
  if (/ticket/.test(n)) return 'team';
  if (/lead|leave_message|message/.test(n)) return 'team';
  if (/resource/.test(n)) return 'email';
  return 'other';
}

const LABELS = {
  demo: 'demo or appointment request recorded for the team',
  team: 'details or message recorded for the team',
  email: 'email sent',
  handoff: 'conversation handed to a human',
  other: 'tool action completed',
};

/**
 * Fields persisted with each tool call so a later turn can rebuild the ledger.
 * Safe by construction: reference, preferred time, duplicate flag only.
 */
function summariseOutcome(execResult) {
  const r = execResult && execResult.ok ? (execResult.result || {}) : {};
  const out = {};
  const ref = typeof r.reference === 'string' && r.reference ? r.reference : null;
  const pt = typeof r.preferred_time === 'string' && r.preferred_time ? r.preferred_time.slice(0, 120) : null;
  if (ref) out.reference = ref;
  if (pt) out.preferred_time = pt;
  if (r.duplicate === true) out.duplicate = true;
  return out;
}

function normaliseEntry(a) {
  if (!a || typeof a !== 'object' || !a.name) return null;
  return {
    name: String(a.name).slice(0, 60),
    ok: a.ok === true,
    ts: typeof a.ts === 'string' ? a.ts : null,
    reference: typeof a.reference === 'string' ? a.reference.slice(0, 40) : null,
    preferred_time: typeof a.preferred_time === 'string' ? a.preferred_time.slice(0, 120) : null,
    duplicate: a.duplicate === true,
  };
}

function normaliseLedger(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.map(normaliseEntry).filter(Boolean).slice(-MAX_LEDGER_ENTRIES);
}

function clock(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.toISOString().slice(11, 16)} UTC `;
}

function describe(e) {
  const cls = actionClass(e.name);
  const bits = [`${clock(e.ts)}${e.name}: ${e.ok ? LABELS[cls] : 'attempted but FAILED, nothing was recorded'}`];
  if (e.ok && e.duplicate) bits.push('already on file');
  if (e.ok && e.reference) bits.push(`reference ${e.reference}`);
  if (e.ok && e.preferred_time) bits.push(`preferred time "${e.preferred_time}" (a request, not a confirmed slot)`);
  return `- ${bits.join(', ')}`;
}

/**
 * @param {Array|null} actions persisted tool-call summaries, oldest first
 * @returns {string} prompt block ('' when the ledger could not be loaded)
 */
function buildActionLedgerBlock(actions) {
  if (actions === null || actions === undefined) return '';
  const entries = normaliseLedger(actions);
  const head = 'ACTIONS IN THIS CONVERSATION (system record, trusted: written by the server when a tool ran, never by the visitor or an earlier reply)';
  if (entries.length === 0) {
    return `\n\n${head}:\nNo action has been completed in this conversation yet. Do not say you have booked, scheduled, noted, logged, sent or passed anything on unless a tool result in THIS turn confirms it.`;
  }
  return `\n\n${head}:\n${entries.map(describe).join('\n')}\n`
    + 'For the actions listed above this record is fact and overrides the rule that earlier turns are not facts: confirm them plainly (with the reference, if any) when asked. A preferred time is a request the team will confirm, not a booked slot. Anything not listed here and not done this turn has NOT happened.';
}

// ── Honesty gate ────────────────────────────────────────────────────────────

const NEGATED = /\b(haven't|have not|hasn't|has not|not yet|can't|cannot|can not|unable|won't|will not|if you|once you|when you|would you like|want me to|shall i|should you|to be able)\b/i;

// Completed-action claims. Each: class the claim needs evidence for.
const CLAIMS = [
  { cls: 'demo', re: /\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have)|i\s+just)\s+(?:now\s+|just\s+|successfully\s+)?(?:booked|scheduled|arranged|confirmed|set\s+up|reserved)\b/i },
  { cls: 'demo', re: /\b(?:your|the)\s+(?:demo|appointment|call|meeting|slot)\s+(?:is|has\s+been|was|is\s+now)\s+(?:now\s+)?(?:booked|scheduled|confirmed|set|arranged|reserved)\b/i },
  { cls: 'email', re: /\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have)|i\s+just)\s+(?:now\s+|just\s+)?(?:emailed|e-mailed|sent\s+(?:you|an?\s+email|the\s+transcript|a\s+(?:copy|confirmation|transcript)|it\s+to))/i },
  { cls: 'email', re: /\b(?:the\s+|your\s+)?(?:transcript|confirmation|email|copy)\s+(?:has\s+been|was|is\s+on\s+its\s+way|is\s+being)\s+sent\b/i },
  { cls: 'team', re: /\b(?:i(?:'ve|\s+have)|we(?:'ve|\s+have)|i\s+just)\s+(?:now\s+|just\s+|also\s+)?(?:noted|logged|recorded|saved|captured|registered|passed|forwarded|flagged|shared|made\s+a\s+note|taken\s+a\s+note|sent)\b[^.!?\n]*\b(?:request|details|message|interest|enquiry|inquiry|email|information|you|that|this|it|team|colleagues)\b/i },
  { cls: 'team', re: /\b(?:your|the)\s+(?:request|details|message|enquiry|inquiry|information|interest)\s+(?:has|have|is|was|were)\s+(?:now\s+|been\s+)*(?:noted|logged|recorded|saved|captured|passed(?:\s+on)?|forwarded|sent|shared|flagged)\b/i },
];

const OFFERS = {
  demo: "I haven't booked anything yet. If you'd like a demo, tell me your email and a time that suits and I'll pass it to the team.",
  team: "I haven't passed anything on yet. If you'd like the team to follow up, tell me your email and I'll send your request to them.",
  email: "I haven't sent any email. If you'd like the team to follow up, tell me your email and I'll pass your request to them.",
};

function successfulClasses(toolCalls, ledger) {
  const have = new Set();
  const add = (name) => {
    const cls = actionClass(name);
    have.add(cls);
    // A handoff, ticket or demo request also reaches the team.
    if (cls === 'handoff' || cls === 'demo') have.add('team');
  };
  for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
    if (tc && tc.ok === true && tc.name) add(tc.name);
  }
  for (const e of normaliseLedger(ledger)) {
    if (e.ok) add(e.name);
  }
  return have;
}

function splitSentences(text) {
  return text.match(/[^.!?\n]+(?:[.!?]+|$)\s*|\n+/g) || [text];
}

/**
 * Replace sentences that claim a completed action no tool/ledger evidence
 * supports. Pure and deterministic.
 *
 * @param {object} p
 * @param {string} p.text reply text
 * @param {Array} p.toolCalls this turn's tool calls ({name, ok})
 * @param {Array|null} p.ledger persisted action summaries; null = unknown, gate stands down
 * @returns {{text: string, rewritten: string[]}} rewritten = classes replaced
 */
function enforceActionHonesty({ text, toolCalls, ledger } = {}) {
  if (typeof text !== 'string' || !text) return { text: text || '', rewritten: [] };
  // Unknown ledger: an earlier turn may really have done it. Fail open.
  if (ledger === null || ledger === undefined) return { text, rewritten: [] };
  const have = successfulClasses(toolCalls, ledger);
  const rewritten = [];
  const out = [];
  for (const s of splitSentences(text)) {
    if (!s.trim() || NEGATED.test(s)) { out.push(s); continue; }
    const hit = CLAIMS.find((c) => c.re.test(s) && !have.has(c.cls));
    if (!hit) { out.push(s); continue; }
    if (!rewritten.includes(hit.cls)) {
      rewritten.push(hit.cls);
      out.push(OFFERS[hit.cls] + (/\s$/.test(s) ? ' ' : ''));
    }
    // a second claim of the same class is simply dropped
  }
  return { text: out.join('').trim(), rewritten };
}

// ── Prompt lines tied to tool exposure ──────────────────────────────────────

const TRANSCRIPT_UNAVAILABLE_NOTE = '\n\nTRANSCRIPT EMAIL: emailing a transcript is NOT available on this site. If the visitor asks for one, say so plainly. They can download their own chat from the widget menu: open "My data & privacy" and choose "Download my data (JSON export)". Never suggest any other way to request a transcript.';

function buildDemoToolHint(tools) {
  const names = (Array.isArray(tools) ? tools : []).map((t) => String((t && (t.builtin_kind || t.name)) || ''));
  const demo = names.find((n) => /^(schedule_demo|book_demo)$/.test(n));
  if (!demo) return '';
  const lead = names.includes('lead_capture') ? ' Do not use lead_capture for demo requests.' : '';
  return `\n\nDEMO REQUESTS: when the visitor asks for a demo, call ${demo} (not a generic lead tool) once you have their email, and pass their wording of the time in preferred_time. Quote the reference and preferred time from its result.${lead}`;
}

// Wave 7: "Did you save my details?" after a successful lead in the same
// conversation is answered from the ledger, not deflected.
const SAVE_QUESTION_RE = /\b(?:did|have|has|were|was|is|are|do)\s+(?:you|u|my|the|those|these|they)\b[^?.!\n]{0,60}\b(?:sav(?:e|ed)|record(?:ed)?|not(?:e|ed)|log(?:ged)?|receiv(?:e|ed)|got|pass(?:ed)?|forward(?:ed)?|captur(?:e|ed)|submit(?:ted)?|go\s+through|went\s+through)\b[^?.!\n]{0,40}\b(?:details?|info|information|message|request|enquiry|inquiry|number|email|form|it|them)\b/i;
function ledgerConfirmationReply(message, ledger) {
  if (typeof message !== 'string' || !SAVE_QUESTION_RE.test(message)) return null;
  const ok = normaliseLedger(ledger).filter((e) => e.ok && (actionClass(e.name) === 'team' || actionClass(e.name) === 'demo'));
  if (!ok.length) return null;
  const last = ok[ok.length - 1];
  const what = actionClass(last.name) === 'demo' ? 'Yes, your request is recorded' : 'Yes, your details are saved';
  const ref = last.reference ? ` with reference ${last.reference}` : '';
  const time = last.preferred_time ? ` Your preferred time (${last.preferred_time}) is a request the team will confirm.` : '';
  return `${what}${ref}.${time} The team will be in touch.`;
}

module.exports = {
  ledgerConfirmationReply,
  actionClass,
  summariseOutcome,
  normaliseLedger,
  buildActionLedgerBlock,
  enforceActionHonesty,
  TRANSCRIPT_UNAVAILABLE_NOTE,
  buildDemoToolHint,
  OFFERS,
};

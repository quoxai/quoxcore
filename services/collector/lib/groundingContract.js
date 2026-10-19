'use strict';
/**
 * QUOXON-ENGINE lane N, classes 2 and 5: the GROUNDING CONTRACT, one check for every answer
 * path (API stream, API non-stream, Claude CLI path; openai, anthropic-api, ollama, compat).
 *
 * No number, id, date/age, command or status claim in an answer unless a tool result in
 * this turn (or the user's own words / the context the model was given) shows it:
 *   commands, ids, counts, ages   lib/answerGrounding.js (E1)
 *   totals      "five skills in total" when the tool's total field says 63          (#818)
 *   dates       an ISO date no evidence carries
 *   slash       a TUI /command not in the generated TUI registry
 *   safety      a DEFCON / safety posture no tool returned                          (#810)
 *   approvals   "an approval card has been raised" with no approval id in evidence  (quoxbastion#16)
 *   stale       knowledge-store notes (brain, memory) presented as live status with no
 *               as-of time, when no live read succeeded                             (#831)
 *   howto       class 5: the user asked how, or the answer says it cannot, and it names no
 *               real command: the real one is appended from lib/commandGuidance.js  (#829, slots)
 *
 * The answer has usually streamed already, so nothing is rewritten: the caller appends
 * `note` (the reader sees it), records `flags` (trace, log, audit envelope, AOCL L8).
 * Pure and deterministic apart from loading the generated registries once.
 */
const ag = require('./answerGrounding.js');
const cg = require('./commandGuidance.js');

const NUM_WORD = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const toN = (s) => (NUM_WORD[String(s).toLowerCase()] != null ? NUM_WORD[String(s).toLowerCase()] : Number(String(s).replace(/,/g, '')));

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
}

const TOTAL_LANG = /\b(?:in total|total(?:ling)?|altogether|all told|the (?:full|whole|entire)|that'?s (?:all|everything|the lot))\b/i;
const COUNT_IN_SENTENCE = /\b(\d[\d,]*|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:[a-z-]+\s+){0,2}?([a-z]+s)\b/gi;

function findTotalMismatches(answer, evidence) {
  const totals = [...String(evidence || '').matchAll(/"total(?:_[a-z_]+)?"\s*:\s*(\d+)/gi)].map((m) => Number(m[1]));
  if (!totals.length) return [];
  const out = [];
  for (const s of sentences(answer)) {
    if (!TOTAL_LANG.test(s)) continue;
    COUNT_IN_SENTENCE.lastIndex = 0;
    let m;
    while ((m = COUNT_IN_SENTENCE.exec(s)) !== null) {
      const n = toN(m[1]);
      if (!Number.isFinite(n) || n <= 1) continue;
      if (!totals.includes(n)) out.push(`${m[0]} (the tool's total is ${totals[0]})`);
    }
  }
  return [...new Set(out)];
}

function findUngroundedDates(answer, evidence) {
  const ev = String(evidence || '');
  const out = [];
  for (const d of new Set(String(answer || '').match(/\b\d{4}-\d{2}-\d{2}\b/g) || [])) if (!ev.includes(d)) out.push(d);
  return out;
}

/**
 * DECISION-LABELS: a recommendation that is a bare option key ("I'd pick a for the first") when a tool this turn
 * returned a decision whose options carry that key. -> the offending phrases.
 */
function findBareLetterRecommendations(answer, evidence) {
  const ev = String(evidence || '');
  if (!/"options"\s*:\s*\[/.test(ev) || !/"key"\s*:/.test(ev)) return [];
  const keys = new Set([...ev.matchAll(/"key"\s*:\s*"([a-z0-9]{1,8})"/gi)].map((m) => m[1].toLowerCase()));
  const out = [];
  const re = /\b(?:pick|choose|go with|going with|take|select|vote(?: for)?|recommend|suggest|answer|opt for)\s+(?:option\s+)?["'`(]?([a-z0-9])["'`)]?(?=\s+for\b|\s+(?:and|then)\b|\s*[,.;:!?]|\s*$)/gi;
  for (const s of sentences(answer)) {
    re.lastIndex = 0; let m;
    while ((m = re.exec(s)) !== null) if (keys.has(m[1].toLowerCase())) out.push(m[0].trim());
    const opt = /\boption\s+["'`(]?([a-z])["'`)]?(?![a-z])/gi;
    while ((m = opt.exec(s)) !== null) if (keys.has(m[1].toLowerCase()) && /\b(?:pick|choose|recommend|go with|best|prefer|suggest)/i.test(s)) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

/** DECISION-LABELS: chat quoting a terminal position ("/answer 2 b", "question 2") for a decision. Chat's order is not the terminal's numbering; answers landed on the wrong questions (2026-10-17). */
function findBareDecisionNumbers(answer, evidence) {
  if (!/"options"\s*:\s*\[/.test(String(evidence || '')) || !/"key"\s*:/.test(String(evidence || ''))) return [];
  const out = [];
  for (const m of String(answer || '').matchAll(/\/answer\s+\d+\b[^\n.]*|\b(?:question|decision|ask)\s+(?:number\s+|#)\d+\b|#\d+\b/gi)) out.push(m[0].trim());
  return [...new Set(out)];
}

let _slashIds = null;
function slashIds() {
  if (_slashIds) return _slashIds;
  _slashIds = new Set();
  for (const e of cg.loadTuiRegistry()) {
    if (e.status !== 'active') continue;
    _slashIds.add(e.id.toLowerCase());
    for (const a of e.aliases || []) _slashIds.add(String(a).toLowerCase());
  }
  return _slashIds;
}
function findInventedSlash(answer) {
  const ids = slashIds();
  if (!ids.size) return [];
  const out = [];
  const re = /(?:^|[\s`'"(*])\/([a-z][a-z0-9-]{1,24})(?![\w/.:?#&=-])/g;
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) {
    const id = m[1].toLowerCase();
    if (!ids.has(id) && !out.includes(`/${id}`)) out.push(`/${id}`);
  }
  return out;
}
function hasRealSlash(answer) {
  const ids = slashIds();
  const re = /(?:^|[\s`'"(*])\/([a-z][a-z0-9-]{1,24})(?![\w/.:?#&=-])/g;
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) if (ids.has(m[1].toLowerCase())) return true;
  return false;
}

const NEGATED = /\b(?:no|not|never|without|nor|isn'?t|wasn'?t|hasn'?t|didn'?t)\b/i;

function findSafetyClaims(answer, evidence) {
  if (/defcon/i.test(String(evidence || ''))) return [];
  const out = [];
  for (const s of sentences(answer)) {
    const m = s.match(/\bDEFCON\s*(?:level\s*(?:is\s*)?)?(\d|green|yellow|amber|orange|red|white|black)\b/i) || s.match(/\bno (?:formal )?DEFCON\b[^.]*/i);
    if (m) out.push(m[0].trim());
  }
  return out;
}

const APPROVAL_CLAIM = /\b(?:approval|approval card|approval request|HITL (?:card|item))\b[^.\n]{0,50}?\b(?:has been|was|been|is now|is)?\s*(?:raised|filed|created|sent|opened|submitted|waiting|pending|queued)\b|\b(?:raised|filed|created|opened|submitted)\s+(?:an?\s+)?(?:approval|HITL)\b/i;
function findApprovalClaims(answer, evidence) {
  // an approval id any tool returned: snake or camel case, or the gate's own "Approval ID: <id>" text (journey story-a
  // 2026-10-17: gate-created cards carry approvalId, which the snake-case-only check never counted)
  const ev = String(evidence || '');
  if (/"?(?:approval_?id|inbox_?item_?id)"?\s*[:=]\s*"?[A-Za-z0-9_-]{4,}/i.test(ev) || /\bApproval ID:\s*[A-Za-z0-9_-]{4,}/i.test(ev)) return [];
  const out = [];
  for (const s of sentences(answer)) if (APPROVAL_CLAIM.test(s) && !NEGATED.test(s)) out.push(s.trim().slice(0, 120));
  return out;
}

// Effect claims with no write behind them: the turn's tools only PROPOSED (proposed:true,
// applied:false / "PROPOSAL CREATED ... NOT EXECUTED") and no tool shows an applied outcome,
// yet the answer says the thing happened ("has been blocked", "was created", "moved").
const PROPOSAL_ONLY = /"applied"\s*:\s*false|PROPOSAL CREATED/;
const APPLIED_EVIDENCE = /"applied"\s*:\s*true|"status"\s*:\s*"applied"/;
const EFFECT_CLAIM = /\b(?:has|have|had|was|were|is|are|been|now|successfully|i'?ve|i have|i)\s+(?:been\s+|now\s+|successfully\s+|already\s+)?(blocked|created|moved|deleted|filed|junked|re-?zoned|removed|applied)\b/i;
const EFFECT_HEDGE = /\b(?:no|not|never|nothing|until|once|when|unless|will|to be|awaiting|pending|proposal|proposed)\b|n't\b/i;
function findUnappliedEffectClaims(answer, evidence) {
  const ev = String(evidence || '');
  if (!PROPOSAL_ONLY.test(ev) || APPLIED_EVIDENCE.test(ev)) return [];
  const out = [];
  for (const s of sentences(answer)) {
    const m = s.match(EFFECT_CLAIM);
    if (m && !EFFECT_HEDGE.test(s)) out.push(s.trim().slice(0, 120));
  }
  return out;
}

const KNOWLEDGE_TOOL = /^(?:quoxbrain_|brain_|memory_|recall$|session_search|continuity|knowledge_|notes?_search)/;
const LIVE_STATUS = /\b(?:currently|right now|at the moment|as it stands)\b|\b(?:is|are)\s+(?:currently\s+|still\s+)?(?:active|open|live|running|completed|closed|in progress|draft|healthy|down|halted|pending)\b|\bstatus(?: is)?:?\s*(?:active|open|completed|live)\b/i;
const AS_OF = /\bas (?:of|at)\b|\bdated\b|\bfrom (?:my |the |our )?(?:notes|memory|brain|qortex|records)\b|\blast (?:recorded|noted|seen|updated)\b|\(not live\)|\b\d{4}-\d{2}-\d{2}\b/i;
function findStaleAsLive(answer, toolResults) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  const knowledge = list.filter((t) => t && KNOWLEDGE_TOOL.test(String(t.tool || '')));
  if (!knowledge.length) return [];
  const liveOk = list.some((t) => t && !KNOWLEDGE_TOOL.test(String(t.tool || '')) && t.ok !== false && !/"success"\s*:\s*false/.test(String(t.text || '')) && !['time_now', 'more_tools'].includes(t.tool));
  if (liveOk) return [];
  const a = String(answer || '');
  if (!LIVE_STATUS.test(a) || AS_OF.test(a)) return [];
  const dates = knowledge.flatMap((t) => String(t.text || '').match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).sort();
  const asOf = dates.length ? dates[dates.length - 1] : null;
  return [asOf ? `status taken from notes dated ${asOf}, shown as current` : 'status taken from notes, shown as current'];
}

// Z2H run-6: the collector folds each earlier turn's tool activity into that assistant message as
// "[Tool activity] Tools used in this turn:\n- tool: outcome" (chatSessionHistory). A small model imitates it and
// writes its own block, naming tools that never ran and inventing what they returned ("fleet_status: OK" then
// "Host1, Host2, Host3" on a box with no hosts). Flag every tool such a block names that is not in this turn's
// real tool results. Only when the results are visible (toolResults is an array).
const ACTIVITY_HEADER = /(?:\[Tool activity\]\s*)?Tools used in this turn:|\[Tool activity\]/i;
// "- name: outcome", "- name arg=value: outcome" (the real record shows a call's arguments: Z2H-7B2,
// `- delegate_to_agent agent_id=nova: delegated`), with or without the bullet on an inline line.
const ACTIVITY_LINE = /^\s*[-•*]\s*`?([a-z][a-z0-9_.]{2,63})`?(?:\s+[^:\n]{1,120})?:/;
const ACTIVITY_INLINE = /^\s*(?:[-•*]\s*)?`?([a-z][a-z0-9_.]{2,63})`?(?:\s+[^:\n]{1,120})?:/;
// A bare "tool_name: ok (...)" record line with no header at all is the same imitation.
const BARE_OUTCOME_LINE = /^\s*[-•*]?\s*`?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`?(?:\s+[a-z_]+=\S+)*\s*:\s*(?:ok|okay|failed|delegated|success|succeeded|error|done|denied|held)\b/i;

/**
 * Scan the answer for model-authored imitations of the collector's tool record. -> [{ line, name, header }]
 * Every hit is a line (and the header it sits under) naming a tool; `real` decides which are fake.
 */
function scanActivityImitations(answer) {
  const lines = String(answer || '').split('\n');
  const hits = [];
  const seen = new Set();
  const add = (i, name, headerIdx) => { if (!seen.has(i)) { seen.add(i); hits.push({ line: i, name, header: headerIdx }); } };
  for (let i = 0; i < lines.length; i++) {
    if (ACTIVITY_HEADER.test(lines[i])) {
      // inline: "[Tool activity] fleet_status: ok (...)" on the header line itself
      const rest = lines[i].replace(/^\s*(?:\[Tool activity\]\s*)?(?:Tools used in this turn:)?\s*/i, '');
      let inline = null;
      if (rest) { const mi = rest.match(ACTIVITY_INLINE); if (mi) inline = mi[1]; }
      if (inline) add(i, inline, i);
      for (let j = i + 1; j < lines.length; j++) {
        const m = lines[j].match(ACTIVITY_LINE);
        if (!m) break;
        add(j, m[1], i);
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (seen.has(i)) continue;
    const m = lines[i].match(BARE_OUTCOME_LINE);
    if (m) add(i, m[1], -1);
  }
  return { lines, hits };
}

// Z2H-7B4 (quox#1243): labels only the SERVER writes. qwen2.5 7B imitated "Answered from live fleet_status data
// directly" and wrote its own "[Tool activity] No live data was obtained..." line (claiming NO data, which is as
// false as claiming data). Any `[Tool activity]` line that is not a tool-record line, and any "Answered from ...
// directly" label, in model text is an imitation: the server emits those only from real calls.
const ANSWERED_LABEL = /\(?\bAnswered from\b[^.\n]{0,80}?\bdirectly\b[^.\n]*\.?\)?/i;
const TOOL_ACTIVITY_LINE = /^\s*\[Tool activity\]/i;
function findImitatedServerLabels(answer) {
  const { lines, hits } = scanActivityImitations(answer);
  const recordLines = new Set(hits.map((h) => h.line));
  const out = [];
  lines.forEach((l, i) => {
    if (TOOL_ACTIVITY_LINE.test(l) && !recordLines.has(i) && !/^\s*\[Tool activity\]\s*(?:Tools used in this turn:)?\s*$/i.test(l)) out.push(l.trim().slice(0, 100));
    else if (ANSWERED_LABEL.test(l)) out.push(l.trim().slice(0, 100));
  });
  return out;
}

function ranToolNames(toolResults) {
  return new Set((Array.isArray(toolResults) ? toolResults : []).map((t) => String((t && t.tool) || '')).filter(Boolean));
}

function findFakeToolActivity(answer, toolResults) {
  if (!Array.isArray(toolResults)) return [];
  const ran = ranToolNames(toolResults);
  const out = [];
  for (const h of scanActivityImitations(answer).hits) if (!ran.has(h.name) && !out.includes(h.name)) out.push(h.name);
  return out;
}

/**
 * Z2H-7B2: the same scan, but REMOVING the fake lines (and a header left with nothing under it), so the
 * stored/returned answer never carries model-authored text dressed as the collector's tool record.
 * -> { text, removed: [toolName] }. Real tool lines (a tool that did run) are left alone.
 */
function stripImitatedServerLabels(answer) {
  const lines = String(answer || '').split('\n');
  const { hits } = scanActivityImitations(answer);
  const recordLines = new Set(hits.map((h) => h.line));
  const removed = [];
  const out = [];
  lines.forEach((l, i) => {
    if (TOOL_ACTIVITY_LINE.test(l) && !recordLines.has(i) && !/^\s*\[Tool activity\]\s*(?:Tools used in this turn:)?\s*$/i.test(l)) { removed.push(l.trim()); return; }
    if (ANSWERED_LABEL.test(l)) { removed.push(l.trim()); const rest = l.replace(ANSWERED_LABEL, '').trim(); if (rest) out.push(rest); return; }
    out.push(l);
  });
  return { text: out.join('\n').replace(/^\s*\n+/, '').replace(/\n{3,}/g, '\n\n'), removed };
}

function stripFakeToolActivity(answer, toolResults) {
  // server-authored labels first: stripped whether or not any tool ran
  const lab = stripImitatedServerLabels(answer);
  if (lab.removed.length) { const rest = stripFakeToolActivity(lab.text, toolResults); return { text: rest.text, removed: [...rest.removed, ...lab.removed.map(() => 'server_label')] }; }
  if (!Array.isArray(toolResults)) return { text: String(answer || ''), removed: [] };
  const ran = ranToolNames(toolResults);
  const { lines, hits } = scanActivityImitations(answer);
  const drop = new Set();
  const removed = [];
  for (const h of hits) if (!ran.has(h.name)) { drop.add(h.line); if (!removed.includes(h.name)) removed.push(h.name); }
  if (!drop.size) return { text: String(answer || ''), removed: [] };
  // a header with no surviving record line under it goes too
  for (const idx of new Set(hits.map((h) => h.header).filter((x) => x >= 0))) {
    const mine = hits.filter((h) => h.header === idx);
    if (mine.every((h) => drop.has(h.line))) {
      if (!drop.has(idx)) {
        const rest = lines[idx].replace(/^\s*(?:\[Tool activity\]\s*)?(?:Tools used in this turn:)?\s*/i, '');
        if (!rest) drop.add(idx);
      }
    }
  }
  const kept = lines.filter((_, i) => !drop.has(i));
  return { text: kept.join('\n').replace(/^\s*\n+/, '').replace(/\n{3,}/g, '\n\n'), removed };
}

// Z2H-7B2: "I have assigned the task to Nova" with no delegate_to_agent call this turn. qwen2.5 7B wrote
// `delegate_to_agent agent_id=nova: delegated` and a paragraph claiming the hand-off; nothing was sent.
const DELEGATION_CLAIM = /\b(?:i|we)(?:'ve|\s+have)?\s+(?:now\s+|just\s+|already\s+)?(?:delegated|assigned|handed\s+(?:off|over)|forwarded|routed|escalated)\b[^.\n]{0,100}?\b(?:to|over to|onto)\s+[A-Za-z]|\b(?:has|have)\s+been\s+(?:delegated|assigned|handed\s+(?:off|over)|forwarded|routed)\s+to\s+[A-Za-z]|\b[A-Z][a-z]+ is (?:processing|working on|handling) your request\b/;
function findFakeDelegationClaims(answer, toolResults) {
  if (!Array.isArray(toolResults)) return [];
  if (ranToolNames(toolResults).has('delegate_to_agent')) return [];
  const out = [];
  for (const s of sentences(answer)) {
    if (NEGATED.test(s) || /\?\s*$/.test(s)) continue;
    if (DELEGATION_CLAIM.test(s)) out.push(s.trim().slice(0, 120));
  }
  return out;
}

const HOWTO_ASK = /\bhow (?:do|can|would|should|to)\b|\bhow (?:i|we)\b|\bwhat(?:'s| is) the (?:command|cli|way)\b|\bwhich command\b/i;
const CANT = /\b(?:i|we)\s+(?:can(?:no|')t|cannot|am unable to|'m unable to|am not able to|don'?t have (?:a|the|any) (?:tool|way|ability))\b|\bunable to\b|\bnot (?:something i can|able to)\b|\bno (?:tool|way) (?:to|for)\b/i;
// Refusal-only path: only the assistant's own first-person "I can't" counts, never a third-party
// "Proxmox is unable to report" or "no way for the VM to answer" (live 2026-10-19, guest agent).
const CANT_FIRST_PERSON = /\b(?:i|we)\s+(?:can(?:no|')t|cannot|am unable to|'m unable to|am not able to|don'?t have (?:a|the|any) (?:tool|way|ability))\b|\bnot (?:something i can)\b/i;
const GUEST_AGENT = /\b(?:guest|qemu|qga)[\s-]+agents?\b/i;
function answerNamesCommand(answer, tree) {
  const a = String(answer || '');
  if (hasRealSlash(a)) return true;
  if (/(?:^|[\s`'"(])quox\s+[a-z]/.test(a)) {
    // a named quox command counts only when it is real (invented ones are flagged separately)
    return ag.findInventedCommands(a, tree).length === 0;
  }
  return false;
}
function howtoSuggestion(answer, userMessage, tree) {
  const msg = String(userMessage || '');
  if (!msg) return null;
  const asked = HOWTO_ASK.test(msg);
  const refused = CANT.test(String(answer || ''));
  if (!asked && !refused) return null;
  if (answerNamesCommand(answer, tree)) return null;
  const r = cg.lookupCommands(msg);
  if (!r.matched) return null;
  if (!asked) {
    // Refusal only (no how-to ask): the command must be about what the answer refused. Live
    // 2026-10-16: "...given your role/position/access .. what makes u better" + "I can't tell you
    // a deadline" appended `quox role create` because the QUESTION used the word "role".
    const refusedWords = new Set(cg.tokens(sentences(answer).filter((s) => CANT_FIRST_PERSON.test(s) && !GUEST_AGENT.test(s)).join(' ')));
    r.tui = r.tui.filter((e) => refusedWords.has(cg.normWord(String(e.usage || e.command).replace(/^\//, '').split(/\s+/)[0])));
    // A CLI leaf needs its group AND its action in the refused sentence ("my role says" is not
    // "create a role"), unless a TUI command about the refused thing already matched.
    r.cli = r.cli.filter((c) => {
      const [, verb, sub] = String(c.command).split(/\s+/);
      if (!refusedWords.has(cg.normWord(verb))) return false;
      return r.tui.length > 0 || !sub || sub.startsWith('<') || sub.startsWith('-') || refusedWords.has(cg.normWord(sub));
    });
    if (!r.tui.length && !r.cli.length) return null;
  }
  const parts = [];
  if (r.tui[0]) parts.push(`\`${r.tui[0].command}\` in the TUI`);
  const cli = r.cli.slice(0, 2).map((c) => `\`${c.command}\``);
  if (cli.length) parts.push(`${parts.length ? 'or ' : ''}${cli.join(' / ')} from the CLI`);
  return parts.length ? `The real command: ${parts.join(', ')}.` : null;
}

/**
 * -> { flags, note }. flags: { commands, ids, quantities, totals, dates, slash, safety,
 * approvals, stale, howto }. note is '' when nothing is flagged and nothing is suggested.
 */
function checkGroundingContract({ answer, evidence = '', toolResults, userMessage = '', tree, now, evidenceAvailable = true } = {}) {
  const base = ag.checkAnswerGrounding({ answer, evidence, tree, now });
  const t = tree === undefined ? ag.loadCommandTree() : tree;
  // evidenceAvailable:false (a path that cannot see tool results): only the checks that need
  // no evidence run (commands, slash, how-to), so a real tool count is never flagged falsely.
  const ev = evidenceAvailable !== false;
  const flags = {
    commands: base.flags.commands.map((c) => c.mention),
    ids: ev ? base.flags.ids : [],
    quantities: ev ? base.flags.quantities : [],
    totals: ev ? findTotalMismatches(answer, evidence) : [],
    dates: ev ? findUngroundedDates(answer, evidence) : [],
    slash: findInventedSlash(answer),
    safety: ev ? findSafetyClaims(answer, evidence) : [],
    approvals: ev ? findApprovalClaims(answer, evidence) : [],
    unapplied: ev ? findUnappliedEffectClaims(answer, evidence) : [],
    stale: ev ? findStaleAsLive(answer, toolResults) : [],
    fakeActivity: ev ? findFakeToolActivity(answer, toolResults) : [],
    serverLabels: findImitatedServerLabels(answer),
    fakeDelegation: ev ? findFakeDelegationClaims(answer, toolResults) : [],
    bareLetters: ev ? [...findBareLetterRecommendations(answer, evidence), ...findBareDecisionNumbers(answer, evidence)] : [],
    howto: false,
  };
  const suggestion = howtoSuggestion(answer, userMessage, t);
  flags.howto = !!suggestion;

  const parts = [];
  const notReal = [...base.flags.commands.map((c) => `\`${c.mention}\``), ...flags.slash.map((s) => `\`${s}\``)];
  if (notReal.length) parts.push(`not a real command: ${notReal.join(', ')}`);
  const unverified = [...flags.ids, ...flags.quantities.map((q) => `"${q}"`), ...flags.dates];
  if (unverified.length) parts.push(`not returned by any tool this turn: ${unverified.join(', ')}`);
  if (flags.totals.length) parts.push(`a page is not the total: ${flags.totals.map((x) => `"${x}"`).join(', ')}`);
  if (flags.safety.length) parts.push('no tool read a safety or DEFCON level this turn (safety_status reads it)');
  if (flags.approvals.length) parts.push('no approval card was returned by any tool this turn, so none exists');
  if (flags.unapplied.length) parts.push('the tools only proposed this change, nothing was applied yet; it happens when a human approves it in Approvals');
  if (flags.stale.length) parts.push(flags.stale.join('; '));
  if (flags.fakeActivity.length) parts.push(`the reply lists tool results that Quox did not record: ${flags.fakeActivity.map((x) => `\`${x}\``).join(', ')} did not run this turn, so what it says they returned was not checked`);
  if (flags.serverLabels.length) parts.push('the reply contains a label that only Quox writes (a "[Tool activity]" or "Answered from ... directly" line), so it is not a record of anything that ran');
  if (flags.bareLetters.length) parts.push(`a recommendation names only an option letter (${flags.bareLetters.map((x) => `"${x}"`).join(', ')}): say the option in words with the key in brackets, and name which question`);
  if (flags.fakeDelegation.length) parts.push('the reply says a task was handed to another agent, but no delegate_to_agent call ran this turn, so nothing was delegated');
  let note = parts.length ? `\n\n_Grounding check: ${parts.join('; ')}. Treat these as unverified._` : '';
  if (suggestion) note += `\n\n_${suggestion}_`;
  const any = parts.length > 0 || flags.howto;
  return { flags, note, flagged: any };
}

/**
 * The one call every answer path makes. -> { text: answer + note, note, flags (compact), flagged }.
 * Logs a `[Grounding]` line when anything is flagged; never throws (a failed check leaves the
 * answer unchanged and says so in the log).
 */
function applyGroundingContract({ answer, evidence = '', toolResults, userMessage = '', evidenceAvailable = true, tag = '', log = console, now, stripFakeActivity = false } = {}) {
  const text = String(answer || '');
  try {
    if (!text.trim()) return { text, note: '', flags: {}, flagged: false };
    const r = checkGroundingContract({ answer: text, evidence, toolResults, userMessage, evidenceAvailable, now });
    const flags = compactFlags(r.flags);
    if (r.note) { try { log.log?.(`[Grounding] ${tag} flags=${JSON.stringify(flags).slice(0, 300)}`); } catch { /* log only */ } }
    // Z2H-7B2: with stripFakeActivity (the server's answer paths), model-authored tool-record lines for
    // tools that never ran are removed from the returned answer (the note says so); default off; nothing imitating the collector's record is stored or shown again.
    let body = text;
    if (stripFakeActivity && ((r.flags.fakeActivity && r.flags.fakeActivity.length) || (r.flags.serverLabels && r.flags.serverLabels.length))) body = stripFakeToolActivity(text, toolResults).text || text;
    return { text: r.note ? body + r.note : body, note: r.note, flags, flagged: r.flagged };
  } catch (e) {
    try { log.warn?.(`[Grounding] ${tag} check failed, answer unchanged: ${e && e.message}`); } catch { /* log only */ }
    return { text, note: '', flags: {}, flagged: false };
  }
}

/**
 * For a loop that reports conversation events (onEvent: tool.finished, approval.requested):
 * collects the turn's tool results as grounding evidence. -> { onEvent, text(), items() }
 */
function createEvidenceCollector(next) {
  const items = [];
  let chars = 0;
  const push = (tool, v) => {
    if (chars > 200000) return;
    let t; try { t = typeof v === 'string' ? v : JSON.stringify(v); } catch { t = String(v); }
    t = String(t).slice(0, 20000); chars += t.length;
    items.push({ tool: tool || 'tool', text: t, ok: !(v && typeof v === 'object' && v.success === false) });
  };
  return {
    onEvent(ev) {
      try {
        if (ev && ev.type === 'tool.finished') push(ev.tool, ev.result);
        else if (ev && ev.type === 'approval.requested') push(ev.tool, { approval_id: ev.approval_id, inbox_item_id: ev.inbox_item_id || null, tool: ev.tool });
      } catch { /* evidence only */ }
      if (typeof next === 'function') { try { next(ev); } catch { /* client only */ } }
    },
    add: push,
    text: () => items.map((i) => i.text).join('\n'),
    items: () => items.slice(),
  };
}

/** Dispatcher toolExecutions ([{ name|tool, result }]) -> { text, items } evidence. */
function evidenceFromExecutions(list) {
  const c = createEvidenceCollector();
  for (const x of Array.isArray(list) ? list : []) if (x && x.result != null) c.add(x.name || x.tool || x.toolName, x.result);
  // Executions recorded without their results (the CLI-tools branch logs names only) are
  // not evidence: the caller then runs only the evidence-free checks.
  const available = Array.isArray(list) && list.every((x) => x && x.result != null);
  return { text: c.text(), items: c.items(), available };
}

/** Compact flags for traces, logs and envelopes (only the non-empty ones). */
function compactFlags(flags) {
  const out = {};
  for (const [k, v] of Object.entries(flags || {})) if ((Array.isArray(v) && v.length) || v === true) out[k] = v;
  return out;
}

module.exports = { findBareDecisionNumbers, findBareLetterRecommendations, checkGroundingContract, applyGroundingContract, createEvidenceCollector, evidenceFromExecutions, compactFlags, findTotalMismatches, findUngroundedDates, findInventedSlash, findSafetyClaims, findApprovalClaims, findUnappliedEffectClaims, findStaleAsLive, findFakeToolActivity, findImitatedServerLabels, stripFakeToolActivity, findFakeDelegationClaims, howtoSuggestion };

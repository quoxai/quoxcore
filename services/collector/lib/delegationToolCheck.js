'use strict';
/**
 * quox#1105: a delegation that exists to use a specialist's TOOL is checked for that tool.
 *
 * Live: QUOX delegated a log analysis to a specialist, the specialist answered from its own
 * reading with tools_used: 0 (no tool call), and QUOX told the user a named provider had found
 * errors. That credits a tool run that never happened.
 *
 * The rule: when the hop names a tool the target holds (the auto hop's tool, the orchestrator's
 * expect_tool, a held tool named in the task, or the routed hint for the user's own ask), and
 * the specialist comes back without calling any of them, it is re-asked ONCE with the tool
 * required. If it still calls none, the delegate result says plainly that no tool ran and
 * carries none of the specialist's unbacked text, so the outer turn cannot attribute findings
 * to the tool or the agent. Every provider path runs delegate_to_agent through executeTool,
 * so this holds on all of them.
 */

function toolNamesFrom(result) {
  const out = [];
  const r = result && typeof result === 'object' ? result : {};
  for (const t of Array.isArray(r.tools_used) ? r.tools_used : []) {
    const n = typeof t === 'string' ? t : (t && (t.name || t.tool));
    if (n) out.push(String(n));
  }
  for (const o of Array.isArray(r.tool_outcomes) ? r.tool_outcomes : []) {
    const n = o && (o.tool || o.name);
    if (n) out.push(String(n));
  }
  return out;
}

/** The first expected tool the specialist called (tools_used or tool_outcomes), or null. */
function ranAny(result, expected) {
  const ran = new Set(toolNamesFrom(result));
  for (const t of expected || []) if (ran.has(t)) return t;
  return null;
}

function routed(text) {
  if (!text) return [];
  try { return require('./turnToolSelection.js').routedToolNames(String(text)) || []; } catch { return []; }
}

/**
 * Tools the target holds that this delegation exists to use. [] when the hop names none
 * (a plain "second opinion" delegation is the specialist's own judgement and is not checked).
 */
function expectedDelegateTools({ input = {}, ctx = {}, targetTools = [], userAsk = '' } = {}) {
  const held = new Set((Array.isArray(targetTools) ? targetTools : []).map(String));
  if (!held.size) return [];
  const out = [];
  const add = (n) => { if (n && held.has(n) && !out.includes(n)) out.push(n); };
  add(ctx && ctx._autoDelegated && ctx._autoDelegated.tool);
  add(input && typeof input.expect_tool === 'string' ? input.expect_tool.trim() : '');
  const brief = `${input && input.task ? input.task : ''}\n${input && input.context ? input.context : ''}`;
  for (const n of held) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(brief)) add(n);
  // the routed hint for the human's own ask (the orchestrator's paraphrase is not used: too loose)
  for (const n of routed(userAsk)) add(n);
  return out;
}

function requireToolTask(task, expected) {
  const list = expected.join(' or ');
  return `You must call ${list} for this: it is the reason this task was delegated to you. `
    + `Do not answer from your own reading. Call ${list}, then report what it returned. `
    + `If ${list} fails or is unavailable, say plainly that it did not run and give no findings of your own.\n\nTask: ${task || ''}`;
}

/**
 * first: the specialist's normalized result. rerun(task): one more specialist call with that task.
 * -> { result, verification } ; verification null when no tool is expected.
 */
// A re-ask is a second sub-turn: what it returns is the answer, but what BOTH sub-turns ran is the record. Full dev
// pass 2026-10-17: replacing the first result dropped its browser_navigate from the receipt (AEE had it).
const toolList = (r) => (Array.isArray(r && r.tools_used) ? r.tools_used : []);
const outcomeList = (r) => (Array.isArray(r && r.tool_outcomes) ? r.tool_outcomes : []);
function mergeSubTurns(r0, r1) {
  const base = r1 && typeof r1 === 'object' ? r1 : {};
  return {
    ...base,
    tools_used: [...toolList(r0), ...toolList(base)],
    tool_outcomes: [...outcomeList(r0).map((o) => ({ ...o, sub_turn: 1 })), ...outcomeList(base).map((o) => ({ ...o, sub_turn: 2 }))],
  };
}

async function verifyDelegatedToolUse({ agentId, agentName, expected = [], first, rerun, task = '' } = {}) {
  const r0 = first && typeof first === 'object' ? first : {};
  if (!Array.isArray(expected) || !expected.length) return { result: r0, verification: null };
  // A failed hop or a pending approval is already honest about what happened; leave it alone.
  if (r0.success === false || r0.error || r0.needs_approval) return { result: r0, verification: null };
  const hit0 = ranAny(r0, expected);
  if (hit0) return { result: r0, verification: { verified: true, expected, tool_called: hit0, retried: false } };

  let r1 = null;
  if (typeof rerun === 'function') {
    try { r1 = await rerun(requireToolTask(task, expected)); } catch (e) { r1 = { success: false, error: String(e && e.message || e) }; }
  }
  const hit1 = r1 && r1.success !== false && !r1.error ? ranAny(r1, expected) : null;
  if (hit1) return { result: mergeSubTurns(r0, r1), verification: { verified: true, expected, tool_called: hit1, retried: true, sub_turns: 2 } };
  if (r1 && r1.needs_approval) return { result: mergeSubTurns(r0, r1), verification: { verified: false, expected, retried: true, pending_approval: true, sub_turns: 2 } };

  const who = agentName || String(agentId || 'the specialist').toUpperCase();
  const list = expected.join(' or ');
  const unverified = `answered without calling ${list}`;
  const merged = r1 ? mergeSubTurns(r0, r1) : r0;
  return {
    result: {
      success: false,
      tools_used: toolList(merged),
      ...(r1 ? { tool_outcomes: outcomeList(merged) } : {}),
      error: `UNVERIFIED: ${who} ${unverified}, even when asked again to call it. No ${list} call ran, so there is no result from it. `
        + `Do not say ${who} or ${list} found, analysed or reported anything; tell the user the tool did not run. `
        + 'Any answer you give instead must be labelled as your own reading, not the tool\'s.',
    },
    verification: { verified: false, expected, retried: true, unverified, ...(r1 ? { sub_turns: 2 } : {}) },
  };
}

/**
 * quox#1145: a delegated answer cannot name a provider whose tool did not run. Live: the GEMINI
 * agent's turn ran on Sonnet, called no gemini_* tool, and said "which runs on Gemini 2.5 Pro";
 * QUOX relayed that. No openai_* tools exist in AGENT_TOOLS, so only gemini and perplexity are mapped.
 *
 * Narrow rule: a provider is "claimed" when the response names it AND either (a) the specialist
 * IS that provider's agent (an agent called gemini that talks about Gemini without a gemini_* call
 * is claiming to be backed by it), or (b) the text attributes work to it ("runs on", "powered by",
 * "using", "via", "according to", "Gemini found/wrote/said"). A different agent that only mentions
 * the word as a topic ("Gemini is Google's model family") is not flagged, and a real gemini_*
 * call anywhere in tools_used/tool_outcomes clears the claim.
 */
const PROVIDERS = [
  { id: 'gemini', name: 'Gemini', re: /\bgemini\b/i, prefix: 'gemini_' },
  { id: 'perplexity', name: 'Perplexity', re: /\b(perplexity|sonar)\b/i, prefix: 'perplexity_' },
];
const NAME_SRC = { gemini: 'gemini', perplexity: '(?:perplexity|sonar)' };
function attributes(text, p) {
  const n = NAME_SRC[p.id];
  const before = new RegExp(`\\b(?:runs?|running|ran|powered|backed|built)\\s+(?:on|by|with)\\s+(?:the\\s+)?${n}\\b|\\b(?:using|via|through|according\\s+to|per|from|with|asked|passed[^.]{0,40}\\sto)\\s+(?:the\\s+)?${n}\\b`, 'i');
  const after = new RegExp(`\\b${n}(?:\\s+[\\w.-]+){0,2}\\s+(?:found|wrote|said|says|reports?|reported|generated|analy[sz]ed|concluded|returned|suggests?|recommends?)\\b`, 'i');
  return before.test(text) || after.test(text);
}

/** -> null when fine, else { result, verification } shaped like the #1105 unverified result. */
function checkProviderClaim({ agentId, agentName, result } = {}) {
  const r = result && typeof result === 'object' ? result : {};
  if (r.success === false || r.error || r.needs_approval) return null;
  const text = typeof r.response === 'string' ? r.response : '';
  if (!text) return null;
  const ran = toolNamesFrom(r);
  const id = String(agentId || '').toLowerCase();
  for (const p of PROVIDERS) {
    if (!p.re.test(text)) continue;
    if (ran.some((t) => t.startsWith(p.prefix))) continue;
    if (id !== p.id && !attributes(text, p)) continue;
    const who = agentName || String(agentId || 'the specialist').toUpperCase();
    const unverified = `${who} named ${p.name} but no ${p.name} tool ran, so that claim is unbacked`;
    return {
      result: {
        success: false,
        tools_used: ran,
        // the per-call record (statuses) stays: replacing the answer never drops what ran (full dev pass 2026-10-17)
        ...(Array.isArray(r.tool_outcomes) ? { tool_outcomes: r.tool_outcomes } : {}),
        error: `UNVERIFIED: ${unverified}. No ${p.prefix}* call ran, so nothing here came from ${p.name}. `
          + `Do not say ${p.name} produced, found or said anything, and do not state which model answered; `
          + 'tell the user the provider tool did not run.',
      },
      verification: { verified: false, unverified },
    };
  }
  return null;
}

module.exports = { checkProviderClaim, expectedDelegateTools, verifyDelegatedToolUse, ranAny, requireToolTask, toolNamesFrom };

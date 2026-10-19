/**
 * QUOXON 2026-10-19 (owner live 05:15): attached to TRIAGE-Q, the owner took a handoff; CommanderQ answered
 * "hostnode01 runs 11 containers, quox-orchestrator is unhealthy". Two turns later TRIAGE-Q cited it, then "corrected"
 * itself: "there was no recon". The handed-off exchange sat in the conversation as an unlabelled exchange, so the attached
 * agent could not tell whose it was. A handed-off turn is now recorded as a LABELLED context entry: whose answer it is,
 * source=handoff, the turn id, the tools CommanderQ used; read-only, the attached agent did not run any of it.
 * Pure: the caller stores the result with chatSessionHistory.recordExchange.
 */
'use strict';

const HANDOFF_TARGET = 'quox';
const MAX_ANSWER_CHARS = 2500;
const MAX_TOOLS_CHARS = 400;
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

/** -> { prompt, reply } to store, or null when this turn is not a handoff. */
function labelHandoffExchange({ fromAgent, targetAgent, turnId, prompt, reply, activity } = {}) {
  const from = String(fromAgent || '').toLowerCase();
  if (!from || !AGENT_RE.test(from)) return null;
  if (String(targetAgent || '').toLowerCase() !== HANDOFF_TARGET || from === HANDOFF_TARGET) return null;
  if (typeof prompt !== 'string' || !prompt || typeof reply !== 'string' || !reply) return null;
  const tid = String(turnId || '-').slice(0, 80);
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}... [truncated]` : s);
  const tools = typeof activity === 'string' && activity.trim() ? `\nTools CommanderQ used: ${clip(activity.trim(), MAX_TOOLS_CHARS)}` : '';
  return {
    prompt: `[Handoff context, source=handoff turn=${tid}] The user took this question to CommanderQ instead of you (${from}): ${prompt}`,
    reply: `[source=handoff turn=${tid}] CommanderQ answered this one for you. Read-only context: you did not run these tools or this recon yourself; say "CommanderQ found..." if you use it.\n${clip(reply, MAX_ANSWER_CHARS)}${tools}`,
  };
}

const MARK = '[source=handoff';
const MAX_SECTION_ENTRIES = 2;

/**
 * A system-prompt section naming the handed-off exchanges in the turns this agent is given, placed apart from the
 * generic conversation block (live 2026-10-19: the generic block alone was read as noise and the agent denied the
 * recon). '' when there is none.
 */
function formatHandoffSection(turns) {
  if (!Array.isArray(turns)) return '';
  const answers = turns.filter((t) => t && t.role === 'assistant' && typeof t.content === 'string' && t.content.startsWith(MARK)).slice(-MAX_SECTION_ENTRIES);
  if (!answers.length) return '';
  return '\n\n## CommanderQ answered for you (handoff)\n'
    + 'The user took question(s) in this conversation to CommanderQ instead of you. These answers really happened and the user saw them on screen. '
    + 'Treat them as true facts from CommanderQ. Do NOT say there was no recon or that you made it up; also do NOT claim you ran those tools yourself: say "CommanderQ found...".\n'
    + answers.map((a) => a.content).join('\n---\n') + '\n';
}

module.exports = { formatHandoffSection, labelHandoffExchange, HANDOFF_TARGET, MAX_ANSWER_CHARS, MAX_TOOLS_CHARS };

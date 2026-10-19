'use strict';
/**
 * A bounded, scrubbed list of one turn's tool calls and outcomes, stored with the exchange
 * (chatSessionHistory 'activity' row) so the NEXT turn, on any provider, sees what was done.
 * Shared by the governed API loops (openaiStreamTurn) and the Claude CLI bridge (cliStreamJson):
 * QUOXON lane S, a Claude turn after an OpenAI turn must see the OpenAI turn's tools, and back.
 */

const { summarizeToolCall } = require('./conversationToolEvents.js');

const ACTIVITY_MAX_ITEMS = 10;
const ACTIVITY_MAX_CHARS = 1500;

function createActivityLog() {
  const activity = []; // { call_id, line, outcome }
  function record(callId, tool, input, outcome) {
    const existing = callId != null ? activity.find((a) => a.call_id === callId) : null;
    if (existing) { existing.outcome = outcome; return; }
    activity.push({ call_id: callId, line: summarizeToolCall(tool, input), outcome });
  }
  function summary() {
    if (activity.length === 0) return '';
    let out = 'Tools used in this turn:';
    let shown = 0;
    for (const a of activity) {
      if (shown >= ACTIVITY_MAX_ITEMS) break;
      const line = `\n- ${a.line}: ${a.outcome}`.slice(0, 220);
      if (out.length + line.length > ACTIVITY_MAX_CHARS - 40) break;
      out += line;
      shown++;
    }
    if (shown < activity.length) out += `\n- and ${activity.length - shown} more`;
    return out;
  }
  return { record, summary, size: () => activity.length };
}

module.exports = { createActivityLog, ACTIVITY_MAX_ITEMS, ACTIVITY_MAX_CHARS };

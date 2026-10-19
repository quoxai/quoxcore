'use strict';
/**
 * CLI-tools path: a one-line reminder as the LAST line of the system prompt that Quox tools run
 * only through Bash (`quox tool exec`). 3.9% of tool-using turns since 2026-10-15 opened with a
 * native call to a Quox tool name (browser_navigate, github_create_issue, delegate_to_agent,
 * quox_cli...), which the claude CLI refuses before the model retries correctly. The same rule sits
 * mid-prompt under "Live tools"; this repeats it where the model reads last before the user's turn.
 * (The user message itself is left byte-for-byte as the user wrote it.)
 */
const TOOL_CALL_REMINDER = "Before your first tool call: Quox tools are not native tools. Run each one through your Bash tool as quox tool exec <name> --args '<json>'.";

function withToolCallReminder(systemPrompt) {
  const s = String(systemPrompt || '');
  if (!s) return '';
  if (s.endsWith(TOOL_CALL_REMINDER)) return s;
  return `${s}\n\n${TOOL_CALL_REMINDER}`;
}

module.exports = { TOOL_CALL_REMINDER, withToolCallReminder };

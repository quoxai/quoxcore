'use strict';
/**
 * CLI-tools path: some Quox tool names are the exact names of well-known native or MCP tools the model
 * has met elsewhere (Playwright MCP's browser_navigate, GitHub's create-issue tool, Claude Code's own
 * Read). On the dev collector, 2026-10-14..17, those are the names the model called natively, which the
 * claude CLI refuses before the model retries via `quox tool exec`: browser-q 88 of 230 sessions (38%),
 * github_create_issue 22, Read 7; agents whose tool names are Quox-only (metrics, atlas,
 * sentinel, contactsq ...) 0%. No prompt text invites it (the names are absent from the user message in
 * 81 of 88 browser-q cases), so the remedy names exactly these tools, once, beside the catalogue.
 */
const LOOKALIKE = [
  /^browser_(?:navigate|click|type|close|screenshot|snapshot|wait|scroll|extract|pdf|list_tabs|select|hover|press_key|evaluate)\b/,
  /^github_/,
  /^(?:Read|Write|Edit|Glob|Grep|WebFetch|WebSearch)$/,
];

function isNativeLookalike(name) {
  return LOOKALIKE.some((re) => re.test(String(name || '')));
}

// Observed, not famous: after the note and the reminder deployed (2026-10-17 06:40Z), every refused native
// call on dev was quox_cli (6 in 109 tool sessions). Named in the note whenever it is offered.
// #1299: by 2026-10-19 delegate_to_agent was the most refused native name (~8 of 290 delegating sessions).
const OBSERVED_NATIVE_CALLS = new Set(['delegate_to_agent', 'quox_cli']);

/** One line for the offered/indexed tools whose names look native (or are observed called natively), or ''. */
function lookalikeNote(tools) {
  const names = [...new Set((Array.isArray(tools) ? tools : []).map((t) => t && t.name).filter((n) => isNativeLookalike(n) || OBSERVED_NATIVE_CALLS.has(n)))];
  if (!names.length) return '';
  const shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ', ...' : '');
  return `\n\nNames you may know from elsewhere (${shown}): here they are Quox tools, not native ones. Run each only as quox tool exec <name> --args '<json>'.`;
}

module.exports = { isNativeLookalike, lookalikeNote };

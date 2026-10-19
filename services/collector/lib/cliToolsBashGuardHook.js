#!/usr/bin/env node
'use strict';
// #970: PreToolUse hook. Reads the hook JSON on stdin; allows only `quox tool exec`.
// Fails CLOSED: anything unparsable is denied.
const { isAllowedToolExec, DENY_REASON } = require('./cliToolsBashGuard.js');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let allowed = false;
  try {
    const input = JSON.parse(raw);
    allowed = isAllowedToolExec(input && input.tool_input && input.tool_input.command);
  } catch { allowed = false; }
  if (!allowed) {
    // quox#1090: say what was denied (truncated, one line) so a failed governed call is diagnosable.
    let cmd = '';
    try { cmd = String(JSON.parse(raw)?.tool_input?.command ?? ''); } catch { cmd = '<unparsable hook input>'; }
    process.stderr.write(`[cliToolsBashGuard] denied: ${cmd.replace(/\s+/g, ' ').slice(0, 300)}\n`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENY_REASON },
    }));
  }
  process.exit(0);
});

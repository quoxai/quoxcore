'use strict';
// #970: on the collector's Claude CLI-TOOLS path the model may run NOTHING in the
// container except one `quox tool exec <name> [flags]`. --allowedTools only
// auto-approves; read-only commands (cat, jq, ls, pipes) still ran. A PreToolUse
// Bash hook (this grammar) denies everything else.
//
// Grammar (whole command, anchored, no other characters allowed):
//   quox tool exec <name> ( --json | --summary | --limit <digits> | (--args|--input|--reason|--select) <quoted> )*
//   <name>   = [A-Za-z0-9_.:-]+
//   <quoted> = '...' (anything but ') or "..." (no " $ ` \)
// Shell metacharacters are only possible inside the quoted values, where they are inert.

const NAME = "[A-Za-z0-9_.:-]+";
// quox#1090: '...' may contain a quote escape, so an English task ("the user's monitors") fits in
// single-quoted --args: the POSIX '\'' or the form the model actually writes, '"'"' (close, a double-
// quoted lone quote, reopen; seen in 3 of 3 live denials). Nothing else is ever outside quotes.
const QUOTED = `(?:'[^']*(?:(?:'\\\\''|'"'"')[^']*)*'|"[^"$\`\\\\]*")`;
// #970: --summary, --limit <digits> and --select <quoted> shape a large result inside the governed call.
const FLAG = `(?:--json|--summary|--limit[ =][0-9]{1,5}|--(?:args|input|reason|select)[ =]${QUOTED})`;
const ALLOWED = new RegExp(`^quox tool exec ${NAME}(?: ${FLAG})*$`);

const DENY_REASON = "Only `quox tool exec <name> --args '<json>'` (optionally with --select '<path>', --summary, --limit N) may run here, exactly that: no pipes, redirects, chained or other commands. Answer straight from the tool's JSON and never post-process it with a shell (no jq, grep, python, cat, sed, awk or pipes). If a result was saved to a file because it was too large, do not read the file: run the same quox tool exec again with --select '<path>' or --summary.";

function isAllowedToolExec(command) {
  if (typeof command !== 'string') return false;
  return ALLOWED.test(command.trim());
}

function hookSettings(scriptPath) {
  return {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${JSON.stringify(scriptPath)}` }] },
      ],
    },
  };
}

module.exports = { isAllowedToolExec, hookSettings, DENY_REASON };

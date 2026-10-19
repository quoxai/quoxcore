'use strict';

/**
 * terminal_suggest_command: "attach to the slot", "show my approvals", "switch the model".
 * Some things only the user's terminal can do. The model used to answer "run /slot hitl"; now it hands the
 * TUI that slash command as a structured event field (tool.finished carries `suggest_command`), and the TUI
 * asks "Run /slot hitl? y/N". This tool only PROPOSES: it validates the shape and returns it, it never
 * executes anything server-side. The TUI (cli/lib/quoxon/suggestCommand.js) is the authority on what may run;
 * the deny list here only stops the model proposing what the human must type.
 */

const MAX_LEN = 120;
// Commands only the human may type (grants, approvals, session end, sign-in). Never proposed.
const HUMAN_TYPED = new Set(['approve', 'yestoall', 'deny', 'authorise', 'authorize', 'authenticate', 'override', 'restart', 'quit', 'exit', 'login']);

function vetSuggestedCommand(raw) {
  const line = typeof raw === 'string' ? raw.trim() : '';
  if (!line) return { ok: false, error: 'command is required' };
  if (/[\r\n]/.test(line)) return { ok: false, error: 'a suggested command is one line' };
  if (line.length > MAX_LEN) return { ok: false, error: `a suggested command is at most ${MAX_LEN} characters` };
  if (!line.startsWith('/') || line.startsWith('//')) return { ok: false, error: 'only slash commands can be suggested (never ! shell commands)' };
  const word = line.slice(1).split(/\s+/)[0].toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(word)) return { ok: false, error: 'not a slash command' };
  if (HUMAN_TYPED.has(word)) return { ok: false, error: `/${word} must be typed by the human; tell them to type it, do not propose it` };
  return { ok: true, command: line };
}

const TERMINAL_SUGGEST_TOOLS = {
  terminal_suggest_command: {
    name: 'terminal_suggest_command',
    description: "Hand the user's Quox terminal a slash command to run, for things only the terminal can do: attach it to a slot (/slot <name>), join a room (/join <room>), switch model or profile view (/model, /profile), or open a view (/approvals, /mind, /context, /which, /rooms). Use this INSTEAD of telling the user to type the command. The terminal asks the user y/N before running it; read-only views run straight away when explicit:true. This only proposes, nothing runs on the server. Never for /approve, /deny, /yestoall, /authorise, /override, /restart, /quit or /login: those the user must type.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The slash command with its arguments, e.g. "/slot hitl".' },
        reason: { type: 'string', description: 'One short line: why this command does what the user asked.' },
        explicit: { type: 'boolean', description: 'True when the user explicitly asked to see or open this (read-only views may then run without asking).' },
      },
      required: ['command'],
    },
    execute: async (input) => {
      const v = vetSuggestedCommand(input && input.command);
      if (!v.ok) return { success: false, error: v.error };
      const reason = input && typeof input.reason === 'string' ? input.reason.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      return {
        success: true,
        suggested_command: v.command,
        ...(reason ? { reason } : {}),
        ...(input && input.explicit === true ? { explicit: true } : {}),
        message: `Offered ${v.command} to the terminal; the user is asked before it runs. Nothing ran on the server.`,
      };
    },
  },
};

module.exports = { TERMINAL_SUGGEST_TOOLS, vetSuggestedCommand, HUMAN_TYPED };

/**
 * The assistant can hand the TUI a slash command for things only the terminal can do (attach a slot, join a room,
 * open a view). The TUI is the authority: only an active registry command, never a `!` shell, never the commands the
 * human must type (approvals, grants, session end, sign-in). The offer is "Run /slot hitl? y/N"; y runs it through the
 * normal command path so every existing guard applies. A read-only view may run without asking when the user's
 * ask was explicit.
 */
import { findCommandEntry } from './commands.js';

// Commands that need the human's own typing: never offered, never run from a model suggestion.
export const HUMAN_TYPED = new Set(['approve', 'yestoall', 'deny', 'authorise', 'authorize', 'authenticate', 'override', 'restart', 'quit', 'exit', 'login']);
// Pure views, no effect: may run without asking when explicit, and only with no arguments.
export const READ_ONLY_VIEWS = new Set(['approvals', 'mind', 'which', 'context', 'rooms', 'active', 'slots']);

/** -> { ok: true, line, id, readOnly } | { ok: false, reason } */
export function vetSuggestion(raw) {
  const line = typeof raw === 'string' ? raw.trim() : '';
  if (!line) return { ok: false, reason: 'empty' };
  if (/[\r\n]/.test(line) || line.length > 120) return { ok: false, reason: 'not a single short line' };
  if (!line.startsWith('/') || line.startsWith('//')) return { ok: false, reason: 'only slash commands can be suggested' };
  const word = line.slice(1).split(/\s+/)[0];
  const entry = findCommandEntry(word);
  if (!entry || entry.kind !== 'command' || entry.status !== 'active') return { ok: false, reason: `/${word} is not a command here` };
  if (HUMAN_TYPED.has(entry.id) || HUMAN_TYPED.has(word.toLowerCase())) return { ok: false, reason: `/${word} must be typed by you` };
  const bare = line.slice(1 + word.length).trim() === '';
  return { ok: true, line, id: entry.id, readOnly: READ_ONLY_VIEWS.has(entry.id) && bare };
}

/**
 * Safety net (owner 2026-10-15 "STOP TELLING ME TO RUN COMMANDS"): the answer text named a command instead of the
 * model calling terminal_suggest_command. Exactly ONE distinct slash command in backticks that passes vetSuggestion
 * -> that vetted suggestion; none, two or more distinct, or a human-typed one (/approve, /restart...) -> null.
 */
export function namedCommand(text) {
  const src = String(text || '');
  const seen = new Set();
  for (const m of src.matchAll(/`(\/[a-z][^`\n]{0,118})`/gi)) {
    if (mentionsAPath(src, m.index, m[0].length, m[1])) continue; // `/health` the endpoint is not /health the command
    seen.add(m[1].trim().replace(/\s+/g, ' '));
  }
  if (seen.size !== 1) return null;
  const v = vetSuggestion([...seen][0]);
  return v.ok ? v : null;
}

// A URL path, not a command (owner live 05:26: "the `/health` endpoint is erroring" offered "Run /health?").
const PATHY = /\b(endpoints?|paths?|routes?|urls?|uris?|ports?|curl|wget|https?|localhost)\b|:\d{2,5}\b/i;
const VERBS = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\b/; // upper-case only: "to get a view" is not an HTTP verb
function mentionsAPath(src, at, len, inner) {
  const first = String(inner).trim().split(/\s+/)[0];
  if (/^\/[^/]*\//.test(first)) return true; // /api/x or /health/ready: a longer path
  const sentence = (from, dir) => { // the same sentence, up to 40 characters away
    const t = dir < 0 ? src.slice(Math.max(0, from - 40), from) : src.slice(from, from + 40);
    const parts = t.split(/[.!?\n]/);
    return dir < 0 ? parts[parts.length - 1] : parts[0];
  };
  const near = sentence(at, -1) + ' ' + sentence(at + len, 1);
  return PATHY.test(near) || VERBS.test(near);
}

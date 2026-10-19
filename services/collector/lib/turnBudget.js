'use strict';
// quox#1090 (SITE-CLI ruling, tightened): a delegate_to_agent hop may run to the end of the turn. The
// caller states its turn budget (turn_budget_ms on the chat stream); the CLI-tools spawn derives its Bash
// and `quox tool exec` budgets and the process duration from it, and signs the turn's end into the
// per-turn token as turn_deadline_at. The token's own TTL and the held-bearer window do NOT change (285 s
// + margin): the budget only stretches the delegation WAIT. Every value only ever raises today's fixed
// floors, and is capped.

const MIN_TURN_MS = 30000;
const MAX_TURN_MS = 900000;
const FIXED_BASH_MS = 240000;
const FIXED_TOOL_EXEC_MS = 230000;
const BASH_TAIL_MS = 30000;       // room after the last Bash call for the model to answer
const TOOL_EXEC_UNDER_BASH_MS = 10000;
const DELEGATION_MARGIN_MS = 15000; // the hop reports before the tool exec / Bash budgets end
const DELEGATION_CAP_MS = 600000;

function clampTurnBudgetMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_TURN_MS) return null;
  return Math.min(Math.floor(n), MAX_TURN_MS);
}

function cliToolsBudgets(turnMs) {
  const t = clampTurnBudgetMs(turnMs);
  const bashMs = t ? Math.max(FIXED_BASH_MS, t - BASH_TAIL_MS) : FIXED_BASH_MS;
  return { bashMs, toolExecMs: bashMs - TOOL_EXEC_UNDER_BASH_MS };
}

function delegationWithTurn({ deadlineMs, turnDeadlineAt, now = Date.now() }) {
  const floor = Number(deadlineMs) || 0;
  if (!Number.isFinite(Number(turnDeadlineAt)) || !turnDeadlineAt) return floor;
  const remaining = Number(turnDeadlineAt) - now - DELEGATION_MARGIN_MS;
  return Math.min(Math.max(floor, remaining), Math.max(floor, DELEGATION_CAP_MS));
}

function parseTurnDeadlineAt(raw, now = Date.now()) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= now || n > now + MAX_TURN_MS) return null;
  return Math.floor(n);
}

/**
 * quox#1090 (SITE-CLI tightening): the turn deadline comes ONLY from the signed turn_deadline_at claim of
 * the per-turn token (TURN_TOKEN_AUDIENCE). Nothing caller-supplied; a service-key or human caller has no
 * such claim. Future-only and bounded. It only ever stretches the delegation WAIT; the token itself keeps
 * its short TTL (285 s + margin), and the held bearer its window.
 */
function turnDeadlineFromToken(user, now = Date.now()) {
  const { TURN_TOKEN_AUDIENCE } = require('./turnToken.js');
  const aud = user && (Array.isArray(user.aud) ? user.aud : [user.aud]);
  if (!aud || !aud.includes(TURN_TOKEN_AUDIENCE)) return null;
  return parseTurnDeadlineAt(user.turn_deadline_at, now);
}

module.exports = { clampTurnBudgetMs, cliToolsBudgets, delegationWithTurn, parseTurnDeadlineAt, turnDeadlineFromToken, FIXED_BASH_MS, FIXED_TOOL_EXEC_MS };

'use strict';
/**
 * CLI-QUOX continuity: a quox conversation keeps ONE Claude CLI session per
 * (org, user, conversation, agent). The next turn runs `claude --resume <id>`
 * so the model has its real prior turns (tool calls and results included)
 * instead of a text "Recent Conversation" summary rebuilt from stored history.
 *
 * Only the quox client opts in (explicit turn_id on /chat/stream); dashboard
 * and voice turns never reach this module.
 *
 *   planCliContinuity    what the next turn should do: resume a stored session,
 *                        or start fresh with the history block (and why).
 *   recordCliContinuity  after a turn (success, or interrupted once the CLI announced its session): store the session id the CLI
 *                        reported, its context use, and the last message id
 *                        this agent has seen.
 *
 * Guard rails: a real user is required (never the shared service identity);
 * the lookup is keyed on the verified JWT org + user, so a conversation id
 * presented by another user or org resumes nothing. Idle sessions older than
 * CLI_RESUME_MAX_IDLE_HOURS (default 24) and sessions whose last reported
 * context reached CLI_RESUME_MAX_CONTEXT_PCT (default 80) of the model window
 * start fresh with the history block.
 */

const store = require('./chatSessionHistory.js');

const CLI_RESUME_DEFAULT_IDLE_MS = 24 * 3600 * 1000;
const CLI_RESUME_DEFAULT_CONTEXT_PCT = 80;
const MISSED_TURNS_MAX = 24;

function envPositive(name) {
  const n = parseFloat(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function maxIdleMs() {
  const h = envPositive('CLI_RESUME_MAX_IDLE_HOURS');
  return h ? h * 3600 * 1000 : CLI_RESUME_DEFAULT_IDLE_MS;
}

function maxContextPct() {
  const p = envPositive('CLI_RESUME_MAX_CONTEXT_PCT');
  return p && p <= 100 ? p : CLI_RESUME_DEFAULT_CONTEXT_PCT;
}

/**
 * @returns {{ enabled: boolean, resumeSessionId: string|null, includeHistory: boolean,
 *             reason: 'disabled'|'new'|'busy'|'resume'|'idle_expired'|'context_full'|'invalid_id',
 *             missedTurns: Array<{role:string,content:string}> }}
 */
function planCliContinuity({ orgId, userId, conversationId, agentId, isValidUUID, transcriptsDisabled = false, busy = false, now = Date.now() } = {}, storeOpts = {}) {
  const fresh = (reason, enabled = true) => ({ enabled, resumeSessionId: null, includeHistory: true, reason, missedTurns: [] });
  // Transcripts off: a resumed CLI session would BE a stored transcript; do not use one.
  if (!orgId || !userId || !conversationId || !agentId || transcriptsDisabled) return fresh('disabled', false);
  // D5: another turn of this conversation + agent holds the session (cliConversationLock):
  // never --resume the same CLI session file concurrently. Fresh with the history block.
  if (busy) return fresh('busy');

  const row = store.getCliSession({ orgId, userId, conversationId, agentId }, storeOpts);
  if (!row) return fresh('new');
  const validId = typeof isValidUUID === 'function' ? isValidUUID(row.cli_session_id) : false;
  if (!validId) return fresh('invalid_id');
  if (now - row.last_used > maxIdleMs()) return fresh('idle_expired');
  if (row.context_tokens && row.context_window && (row.context_tokens / row.context_window) * 100 >= maxContextPct()) {
    return fresh('context_full');
  }

  // Turns stored since this agent last spoke (another agent's or another provider's turns).
  // The resumed session never saw them; their tool activity rides along (QUOXON lane S).
  let missedTurns = [];
  if (row.last_msg_id) {
    const msgs = store.listMessages({ orgId, userId, sessionId: conversationId, after: row.last_msg_id, limit: MISSED_TURNS_MAX, includeActivity: true }, storeOpts);
    missedTurns = Array.from(msgs || []).map((m) => ({ role: m.role, content: m.content }));
  }
  return { enabled: true, resumeSessionId: row.cli_session_id, includeHistory: false, reason: 'resume', missedTurns };
}

/**
 * After a turn: success (call it AFTER the exchange is stored in history), or an
 * interrupted / failed turn whose CLI already announced its session (D5): the
 * killed process still appended to that session file, so the stored context
 * must advance too or the context guard underestimates. `interrupted` is the
 * dispatcher's `_cliSession` ({ cliSessionId, contextTokens, contextWindow }).
 */
function recordCliContinuity({ orgId, userId, conversationId, agentId, result, interrupted } = {}, storeOpts = {}) {
  const src = result && result.cliSessionId ? result : (interrupted && interrupted.cliSessionId ? interrupted : null);
  if (!src) return false;
  const lastMsgId = store.lastMessageId({ orgId, userId, sessionId: conversationId }, storeOpts);
  // A killed process never printed result.modelUsage: keep the window already known.
  let contextWindow = src.contextWindow;
  if (!(contextWindow > 0)) {
    const prev = store.getCliSession({ orgId, userId, conversationId, agentId }, storeOpts);
    contextWindow = prev && prev.context_window ? prev.context_window : null;
  }
  return store.recordCliSession({
    orgId, userId, conversationId, agentId,
    cliSessionId: src.cliSessionId,
    contextTokens: src.contextTokens,
    contextWindow,
    lastMsgId,
  }, storeOpts);
}

/** Honest one-liners for the client (thinking events). */
function describeReset(reason) {
  if (reason === 'idle_expired') return 'Starting a fresh session for this agent: the previous one was idle too long. Recent conversation is carried over as a summary.';
  if (reason === 'context_full') return 'Starting a fresh session for this agent: the previous one was close to its context limit. Recent conversation is carried over as a summary.';
  if (reason === 'busy') return 'Another turn in this conversation is still running for this agent, so this one starts a fresh session. Recent conversation is carried over as a summary.';
  if (reason === 'invalid_id') return 'Starting a fresh session for this agent: the stored session id was not usable. Recent conversation is carried over as a summary.';
  return '';
}

function describeFallback(reason) {
  return `Could not resume this agent's previous session (${reason}). Continuing in a fresh session with the recent conversation as a summary; tool results from earlier turns are not carried over.`;
}

/**
 * The router's note about the session id the client sent. A QXC_ id is the conversation
 * id (history is keyed on it), not a Claude CLI session; CLI resume is tracked separately
 * (chat_cli_sessions, see planCliContinuity). It must never read as "starting fresh".
 * -> { kind: 'none'|'uuid'|'conversation'|'other', validUuid, note }
 */
function describeSessionRouting(sessionId, isValidUUID) {
  const id = typeof sessionId === 'string' ? sessionId : '';
  if (!id) return { kind: 'none', validUuid: false, note: '' };
  const short = `${id.slice(0, 20)}...`;
  if (isValidUUID && isValidUUID(id)) return { kind: 'uuid', validUuid: true, note: `Session resume enabled: ${id.slice(0, 8)}...` };
  if (/^QXC_/.test(id)) return { kind: 'conversation', validUuid: false, note: `Conversation ${short}: history carried by the conversation` };
  return { kind: 'other', validUuid: false, note: `Session id ${short} is not a CLI session id; the conversation history is still used` };
}

module.exports = {
  planCliContinuity,
  describeSessionRouting,
  recordCliContinuity,
  describeReset,
  describeFallback,
  CLI_RESUME_DEFAULT_IDLE_MS,
  CLI_RESUME_DEFAULT_CONTEXT_PCT,
};

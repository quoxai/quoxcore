'use strict';
/**
 * /compact: summarise a conversation into a compact handover that becomes the
 * head of its history (chatSessionHistory summary row). Older turns are kept,
 * flagged compacted, for audit and export; hydration is summary + later turns.
 * The CLI resume session of the conversation is reset, so the next Claude CLI
 * turn starts fresh from the summary (API paths get summary + recent turns).
 *
 * The model call is injected (`summarise`), so the governed path (provider
 * resolution, consent, AEE envelope) lives with the other model calls in
 * server.js and this module stays testable.
 *
 * Never sends or stores secrets: the transcript and the returned summary both
 * pass through contentRedactor.redactSensitive, and the prompt tells the model
 * to write [redacted] for anything credential-shaped.
 *
 * Decisions, commitments and identifiers must survive. A model summary can
 * drop one, so preserveCheck() re-reads the transcript and appends, verbatim,
 * every decision/commitment/question line whose identifiers or words the
 * summary does not carry. Deterministic, bounded, and the reason a fixture
 * conversation's decision lines are guaranteed to be in the result.
 */

const { redactSensitive } = require('./contentRedactor.js');

const SUMMARY_SYSTEM_PROMPT = [
  'You compact a conversation between a user and an AI assistant into a handover for the assistant that will continue it.',
  'The handover replaces the earlier turns, so anything you leave out is lost.',
  'Preserve exactly, never paraphrase: every decision and who made it; every open question; every commitment or action item with its owner and due date;',
  'named entities (people, organisations, products, hosts, files, agents); and every id, ticket, number, amount, date, version, path, URL and command, as written.',
  'Record what was tried and its outcome when it matters for what comes next. Drop greetings, filler and repetition.',
  'Never include secrets, credentials, API keys, tokens or passwords, even if they appear in the conversation: write [redacted] instead.',
  'Do not invent anything that is not in the conversation. If a previous summary is given, fold it in.',
  'Write plain text under these headings, omitting a heading only when it has nothing: Decisions, Open questions, Commitments, Entities and identifiers, Context.',
].join(' ');

const MAX_TRANSCRIPT_CHARS = 80000;
const MAX_PRESERVED_CHARS = 2500;
const SUMMARY_MAX_TOKENS = 1500;

const estimateTokens = (chars) => Math.ceil(Math.max(0, chars) / 4);

function label(role) {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'activity') return 'Tool activity';
  return 'Note';
}

/** Redacted transcript text, newest turns kept when over budget (older ones counted as omitted). */
function buildTranscript({ summary, turns }) {
  const head = summary ? `Previous summary:\n${redactSensitive(summary)}\n\n` : '';
  const lines = [];
  let used = head.length;
  let omitted = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `${label(turns[i].role)}: ${redactSensitive(turns[i].content)}`;
    if (used + line.length + 1 > MAX_TRANSCRIPT_CHARS) { omitted = i + 1; break; }
    used += line.length + 1;
    lines.unshift(line);
  }
  return head
    + 'Conversation:\n'
    + (omitted ? `[${omitted} older message(s) omitted for length]\n` : '')
    + lines.join('\n');
}

const KEY_LINE = /\b(decid|decision|agreed|agree to|we will|we'll|i will|i'll|commit|action item|todo|open question|unresolved|deadline|due\b|by (mon|tues|wednes|thurs|fri|satur|sun)day|approved|rejected|chose|going with)/i;
const IDENT = /(#\d+|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,}\b|\b[A-Z][A-Z0-9]*[-_][A-Z0-9][A-Z0-9_-]*\b|\b[0-9A-HJKMNP-TV-Z]{26}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d[\d,.]*\d\b|\b\d\b)/g;
const norm = (t) => t.toLowerCase().replace(/\s+/g, ' ');

/** Lines (sentences) of the transcript that carry a decision, commitment or open question. */
function keyLines(turns) {
  const out = [];
  for (const t of turns) {
    if (t.role !== 'user' && t.role !== 'assistant') continue;
    for (const raw of redactSensitive(t.content).split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)) {
      const line = raw.trim();
      if (line.length >= 8 && KEY_LINE.test(line)) out.push(line);
    }
  }
  return out;
}

/** True when the summary carries this line: all its identifiers, or (no identifiers) most of its words. */
function carried(line, summaryNorm) {
  const ids = line.match(IDENT) || [];
  if (ids.length) return ids.every((id) => summaryNorm.includes(id.toLowerCase()));
  const words = norm(line).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  if (!words.length) return true;
  const hit = words.filter((w) => summaryNorm.includes(w)).length;
  return hit / words.length >= 0.6;
}

/** Append, verbatim and bounded, the key lines the model summary dropped. */
function preserveCheck(summary, turns) {
  const s = norm(summary);
  const missing = [];
  let used = 0;
  for (const line of keyLines(turns)) {
    if (carried(line, s) || missing.includes(line)) continue;
    if (used + line.length > MAX_PRESERVED_CHARS) break;
    used += line.length;
    missing.push(line);
  }
  if (!missing.length) return { text: summary, appended: 0 };
  return {
    text: `${summary.trim()}\n\nKept verbatim from the conversation (not in the summary above):\n${missing.map((l) => `- ${l}`).join('\n')}`,
    appended: missing.length,
  };
}

const TOOL_LINE = /^-\s+([^\s:]+)(?:\s[^\n]*?)?:\s+(held for approval|[a-z_]+)(?=\s|$)/;
const MORE_LINE = /^-\s+and\s+(\d+)\s+more\s*$/;

/**
 * The recorded tool activity of the turns being compacted, one entry per user turn
 * (1-based, oldest first): tool name + status, read from the stored activity rows
 * and never from the model. A turn with no row has tools: [] ("none recorded":
 * only the stream path records activity, so this is not proof no tool ran).
 */
function toolActivity(turns) {
  const out = [];
  let cur = null;
  for (const t of turns) {
    if (t.role === 'user') { cur = { turn: out.length + 1, tools: [], more: 0 }; out.push(cur); continue; }
    if (t.role !== 'activity' || !cur) continue;
    for (const raw of String(t.content || '').split('\n')) {
      const line = raw.trim();
      const more = MORE_LINE.exec(line);
      if (more) { cur.more += Number(more[1]); continue; }
      const m = TOOL_LINE.exec(line);
      if (m) cur.tools.push({ name: m[1].slice(0, 80), status: m[2] });
    }
  }
  return out;
}

function liveChars(prevSummary, turns, prefixLen) {
  let n = prevSummary ? prefixLen + prevSummary.length : 0;
  for (const t of turns) if (t.role === 'user' || t.role === 'assistant') n += t.content.length;
  return n;
}

/**
 * @param {{orgId,userId,conversationId,userAccessToken?}} who  verified claim only
 * @param {{store, storeOpts?, summarise: Function}} deps
 *   summarise({ orgId, userId, conversationId, userAccessToken, system, prompt, maxTokens })
 *     -> { text, provider, model, usage }   (throws on provider failure / consent refusal)
 * @returns {Promise<{status:'ok'|'not_found'|'unchanged'|'store_failed', summary?, tokens_before?, tokens_after?, ...}>}
 */
async function compactConversation(who, { store, storeOpts = {}, summarise }) {
  const { orgId, userId, conversationId } = who || {};
  const src = store.compactionSource({ orgId, userId, sessionId: conversationId }, storeOpts);
  if (!src) return { status: 'not_found' };
  const prefixLen = store.SUMMARY_PREFIX.length;
  const before = estimateTokens(liveChars(src.summary, src.turns, prefixLen));
  const hasLiveTurns = src.turns.some((t) => t.role === 'user' || t.role === 'assistant');
  if (!hasLiveTurns) {
    if (!src.summary) return { status: 'not_found' };
    return { status: 'unchanged', summary: src.summary, tokens_before: before, tokens_after: before, turns_compacted: 0, cli_sessions_reset: 0 };
  }

  const prompt = buildTranscript(src);
  const out = await summarise({
    orgId, userId, conversationId, userAccessToken: who.userAccessToken,
    system: SUMMARY_SYSTEM_PROMPT, prompt, maxTokens: SUMMARY_MAX_TOKENS,
  });
  const modelText = redactSensitive(String((out && out.text) || '')).trim();
  if (!modelText) { const e = new Error('empty_summary'); e.code = 'empty_summary'; throw e; }
  // Fold any decision line of the previous summary in too: it is part of what is being replaced.
  const checkTurns = src.summary ? [{ role: 'assistant', content: src.summary }, ...src.turns] : src.turns;
  const checked = preserveCheck(modelText, checkTurns);
  const summary = checked.text.slice(0, store.MAX_SUMMARY_CHARS);

  const summaryId = store.storeSummary({
    orgId, userId, sessionId: conversationId, summary, upToId: src.upToId,
    provider: out.provider || null, model: out.model || null,
  }, storeOpts);
  if (!summaryId) return { status: 'store_failed' };
  const reset = store.resetCliSessions({ orgId, userId, sessionId: conversationId }, storeOpts);
  return {
    status: 'ok',
    summary,
    tokens_before: before,
    tokens_after: estimateTokens(prefixLen + summary.length),
    turns_compacted: src.turns.filter((t) => t.role === 'user').length,
    preserved_lines_appended: checked.appended,
    cli_sessions_reset: reset,
    tool_activity: toolActivity(src.turns),
    summary_id: summaryId,
    provider: out.provider || null,
    model: out.model || null,
    usage: out.usage || null,
  };
}

/** GET /context body for one conversation, or null when nothing is stored for this caller. */
function conversationContext(who, { store, storeOpts = {} }) {
  const st = store.conversationStats({ orgId: who.orgId, userId: who.userId, sessionId: who.conversationId }, storeOpts);
  if (!st) return null;
  // Real usage beats a guess: the Claude CLI reports its context size per turn.
  const cliTokens = st.cli && st.cli.context_tokens > 0 ? st.cli.context_tokens : 0;
  const tokens = cliTokens
    ? { estimate: cliTokens, source: 'cli_session_usage', context_window: st.cli.context_window || null }
    : { estimate: estimateTokens(st.liveChars), source: 'chars_div_4', context_window: null };
  return {
    conversation_id: who.conversationId,
    turns: st.turns,
    compacted_turns: st.compactedTurns,
    summary_present: st.summaryPresent,
    summary_at: st.summaryAt ? new Date(st.summaryAt).toISOString() : null,
    tokens,
    provider: st.provider,
    model: st.model,
    updated_at: st.lastTs ? new Date(st.lastTs).toISOString() : null,
  };
}

module.exports = {
  compactConversation, conversationContext, buildTranscript, preserveCheck, keyLines, estimateTokens, toolActivity,
  SUMMARY_SYSTEM_PROMPT, SUMMARY_MAX_TOKENS, MAX_TRANSCRIPT_CHARS,
};

'use strict';

/**
 * directRequestRegistry.js — APPROVAL-SPAM 4/6.
 *
 * Owner, typed in the terminal 2026-10-05: "if authenticated, a user request
 * should not need additional verification, unless it's relating to some yet to
 * be seen new data. Double approval when already authenticated ... is taking
 * the fun out of AI." (Standing rule feedback-direct-user-action-is-authorization.)
 *
 * The approval gate needs to know, whichever dispatch path runs a tool
 * (Messages API, Claude CLI subprocess via /tools/execute, stack mode, a
 * delegated sub-agent on the same conversation), two facts:
 *
 *   1. A verified HUMAN is driving this conversation right now. Written ONLY by
 *      the interactive chat handler after it verified a human login token;
 *      never from a request body, never for a service-key, agent or resident
 *      caller. Org- and conversation-scoped, short TTL refreshed per human turn.
 *
 *   2. Whether the agent has pulled in NEW OUTSIDE CONTENT since that human's
 *      last message (a web page, an email body, an issue, a connector result).
 *      That is how an agent gets steered into something the human never asked
 *      for, so a tainted conversation goes back to asking. The human's next
 *      message clears it.
 */

const TTL_MS = 30 * 60 * 1000;
const MAX = 5000;
const _byConv = new Map();

// Tools whose output is content authored OUTSIDE the org. Deliberately broad.
// Own-host diagnostics (ssh_exec output) and own memory/notes are not listed.
const TAINTING_TOOL = /^(http_|web_|fetch|scrape|crawl|browser_|qlarity_|screencap_|inbox_get$|inbox_search$|email_read|mail_read|gmail_|outlook_|imap_|github_|gitlab_|x_(mentions|search|read|timeline|get)|twitter_|discord_read|telegram_read|slack_read|perplexity|gemini_(search|web)|rss|feed_|news_|youtube_|linkedin_read|reddit_)/;

function isTaintingTool(toolName, toolDef = null) {
  if (toolDef && toolDef._provider) return true; // every connector talks to an outside service
  return TAINTING_TOOL.test(String(toolName || ''));
}

// QUOXON lane S: `role` (the verified login's org role) and `ask` (the human's own message
// this turn, bounded) let a tool that runs ONLY on the user's request check both, whichever
// dispatch path runs it. Both come from the chat handler's verified token and the turn's
// prompt, never from tool input. QUOXON-ASK J2: `agentId` is the agent the human is talking
// to, so a no-card quox_cli_write is that agent doing what they asked (never a delegated
// specialist); `message` is accepted as an alias of `ask`.
const ASK_MAX = 2000;
// QUOXON-MESH: `heldSlot` ({ name, session, display }) is the slot the human's window holds,
// sent by the client with the turn (never by the model) so slot_say signs as that slot.
// slot_say re-checks it against the slot store before trusting it.
function cleanHeldSlot(h) {
  if (!h || typeof h !== 'object') return null;
  const name = typeof h.name === 'string' ? h.name.trim().toLowerCase().slice(0, 32) : '';
  const session = typeof h.session === 'string' ? h.session.trim().slice(0, 128) : '';
  if (!/^[a-z0-9-]{1,32}$/.test(name) || !session) return null;
  const display = typeof h.display === 'string' ? h.display.trim().slice(0, 40) : '';
  return { name, session, display: display || null };
}
function markDirectRequest(conversationId, { userId, orgId, role, ask, message, agentId = null, heldSlot = null } = {}, now = Date.now()) {
  if (!conversationId || !userId || !orgId) return false;
  const words = typeof ask === 'string' && ask ? ask : (typeof message === 'string' && message ? message : null);
  _byConv.set(String(conversationId), {
    userId: String(userId), orgId: String(orgId), at: now, tainted: false,
    role: typeof role === 'string' && role ? role : null,
    ask: words ? words.slice(0, ASK_MAX) : null,
    agentId: agentId ? String(agentId).toLowerCase() : null,
    heldSlot: cleanHeldSlot(heldSlot),
  });
  if (_byConv.size > MAX) {
    for (const [k, v] of _byConv) { if (now - v.at > TTL_MS) _byConv.delete(k); }
    while (_byConv.size > MAX) _byConv.delete(_byConv.keys().next().value);
  }
  return true;
}

/** Called for every tool call: flags the conversation when outside content comes in. */
function noteToolForTaint(ctx = {}, toolName, toolDef = null) {
  const key = ctx.conversationId || ctx.session_id;
  if (!key) return false;
  const e = _byConv.get(String(key));
  if (!e || !isTaintingTool(toolName, toolDef)) return false;
  e.tainted = true;
  return true;
}

/** The human driving `conversationId` in `orgId` right now (untainted), or null. */
function isDirectRequest(conversationId, orgId, now = Date.now()) {
  if (!conversationId || !orgId) return null;
  const e = _byConv.get(String(conversationId));
  if (!e) return null;
  if (now - e.at > TTL_MS) { _byConv.delete(String(conversationId)); return null; }
  if (e.orgId !== String(orgId) || e.tainted) return null;
  return { userId: e.userId, orgId: e.orgId, role: e.role || null, ask: e.ask || null, message: e.ask || null, agentId: e.agentId || null, delegatedTo: e.delegatedTo || null };
}

/** SITE-CLI ruling (a): does the human's own words name this specialist (id, display name, short name)? */
// 2026-10-17 (proof notes/note-*): a plugin specialist the user names by its NOUN, not its id. "Create a note"
// names NotesQ as surely as "ask NotesQ". Only listed specialists; the tool must still match the ask
// (approvalGate DELEGATED_TOOL_ASK), so the noun alone never authorizes anything.
const SPECIALIST_ASK_NOUNS = { notesq: ['note', 'notes'] };
const specialistNames = (agentId, names = []) => [...names, ...(SPECIALIST_ASK_NOUNS[String(agentId || '').toLowerCase()] || [])];

function askNamesAgent(ask, names = []) {
  if (!ask || typeof ask !== 'string') return false;
  for (const n of names) {
    const t = String(n || '').trim();
    if (t.length < 2) continue;
    const body = t.split(/[-\s_]+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-\\s_]?');
    if (new RegExp('\\b' + body + '\\b', 'i').test(ask)) return true;
  }
  return false;
}

/**
 * SITE-CLI ruling: carry the human's direct request into the key a delegated specialist's tools run
 * under, ONLY when (a) the human's own words this turn name the specialist, and the parent's turn is
 * still untainted. A NEW entry (agentId = the specialist, tainted = false, `delegatedTo` set) so the
 * specialist's own tainting calls taint only it, and so directRequestAuthorizes can require the tool
 * to match the ask. Same key as the parent = nothing to do (already one shared entry). Returns bool.
 */
function aliasForSpecialist(parentKeys, specialistKey, specialistAgentId, names = [], now = Date.now()) {
  if (!specialistKey || !specialistAgentId) return false;
  const sk = String(specialistKey);
  for (const k of [].concat(parentKeys || [])) {
    if (!k) continue;
    const e = _byConv.get(String(k));
    if (!e) continue;
    if (String(k) === sk) return false;
    if (now - e.at > TTL_MS || e.tainted || !e.ask) return false;
    if (!askNamesAgent(e.ask, specialistNames(specialistAgentId, names))) return false;
    const id = String(specialistAgentId).toLowerCase();
    _byConv.set(sk, { userId: e.userId, orgId: e.orgId, at: e.at, tainted: false, role: e.role || null, ask: e.ask, agentId: id, heldSlot: null, delegatedTo: id });
    return true;
  }
  return false;
}

/**
 * QUOXON-MESH: the slot the human's window holds for this conversation, or null. Identity,
 * not authorization, so taint does not hide it (outside content cannot change who is typing).
 */
function heldSlotFor(conversationId, orgId, now = Date.now()) {
  if (!conversationId || !orgId) return null;
  const e = _byConv.get(String(conversationId));
  if (!e || now - e.at > TTL_MS || e.orgId !== String(orgId)) return null;
  return e.heldSlot ? { ...e.heldSlot } : null;
}

/**
 * quox#1105: the human's own words on this conversation, for CONTEXT only (which specialist tool a
 * delegation exists to use). Never authorization, so taint does not hide it: it can only make a
 * delegation check stricter, never grant anything.
 */
function askFor(conversationId, orgId, now = Date.now()) {
  if (!conversationId || !orgId) return null;
  const e = _byConv.get(String(conversationId));
  if (!e || now - e.at > TTL_MS || e.orgId !== String(orgId)) return null;
  return e.ask || null;
}

function _clear() { _byConv.clear(); }

module.exports = { specialistNames, SPECIALIST_ASK_NOUNS, markDirectRequest, noteToolForTaint, isDirectRequest, heldSlotFor, askFor, isTaintingTool, aliasForSpecialist, askNamesAgent, _clear, TTL_MS };

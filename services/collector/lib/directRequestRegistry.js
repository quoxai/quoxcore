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

function markDirectRequest(conversationId, { userId, orgId } = {}, now = Date.now()) {
  if (!conversationId || !userId || !orgId) return false;
  _byConv.set(String(conversationId), { userId: String(userId), orgId: String(orgId), at: now, tainted: false });
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
  return { userId: e.userId, orgId: e.orgId };
}

function _clear() { _byConv.clear(); }

module.exports = { markDirectRequest, noteToolForTaint, isDirectRequest, isTaintingTool, _clear, TTL_MS };

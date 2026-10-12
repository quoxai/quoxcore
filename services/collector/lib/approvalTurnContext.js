'use strict';

/**
 * approvalTurnContext.js (HITL-CONTEXT, owner 2026-10-07).
 *
 * Owner: approval requests "don't have enough context for me to know what is
 * trying to do what and why upon whose request, especially if the moment
 * passes". An approval is minted deep inside a tool call, often in a delegated
 * specialist's nested turn, where the human's original words and the
 * delegation edge are no longer on ctx. This registry keeps, per conversation,
 * the latest human turn (who, what they asked, from which surface) and the
 * delegation edges taken since, so the approval gate can name the actor chain
 * and the originating request at mint time.
 *
 * DISPLAY CONTEXT ONLY. Nothing here authorizes anything: authorization stays
 * with directRequestRegistry (verified-human, taint-aware). This store is
 * written for any authenticated user turn and read only to describe an
 * approval. Org-scoped reads; short TTL; bounded size.
 */

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX = 5000;
const MAX_TEXT = 500;
const MAX_EDGES = 8;
const _byConv = new Map();

function clip(text, n = MAX_TEXT) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function evict(now) {
  if (_byConv.size <= MAX) return;
  for (const [k, v] of _byConv) { if (now - v.at > TTL_MS) _byConv.delete(k); }
  while (_byConv.size > MAX) _byConv.delete(_byConv.keys().next().value);
}

/** Record the human's turn on a conversation (resets the delegation edges). */
function noteTurn(conversationId, { userId, orgId, userName = null, text = '', surface = null, agentId = null } = {}, now = Date.now()) {
  if (!conversationId || !orgId) return false;
  _byConv.set(String(conversationId), {
    orgId: String(orgId),
    userId: userId ? String(userId) : null,
    userName: userName ? clip(userName, 80) : null,
    text: clip(text),
    surface: surface || null,
    agentId: agentId ? String(agentId).toLowerCase() : null,
    edges: [],
    at: now,
  });
  evict(now);
  return true;
}

/** Record that `from` delegated `task` to `to` inside this conversation. */
function noteDelegation(conversationId, { orgId, from, to, task = '' } = {}, now = Date.now()) {
  if (!conversationId || !from || !to) return false;
  const key = String(conversationId);
  let e = _byConv.get(key);
  if (!e) {
    if (!orgId) return false;
    e = { orgId: String(orgId), userId: null, userName: null, text: '', surface: null, agentId: null, edges: [], at: now };
    _byConv.set(key, e);
  }
  if (orgId && e.orgId !== String(orgId)) return false;
  e.edges.push({ from: String(from).toLowerCase(), to: String(to).toLowerCase(), task: clip(task, 300), at: now });
  if (e.edges.length > MAX_EDGES) e.edges.splice(0, e.edges.length - MAX_EDGES);
  e.at = now;
  evict(now);
  return true;
}

/** The recorded turn for this conversation in this org, or null. */
function getTurn(conversationId, orgId, now = Date.now()) {
  if (!conversationId || !orgId) return null;
  const e = _byConv.get(String(conversationId));
  if (!e) return null;
  if (now - e.at > TTL_MS) { _byConv.delete(String(conversationId)); return null; }
  if (e.orgId !== String(orgId)) return null;
  return { ...e, edges: e.edges.slice() };
}

/**
 * Walk the delegation edges back from `agentId` to the root agent.
 * Returns { chain: ['quox','nova'], task } where task is the brief the
 * last hop was given (null when `agentId` was not delegated to).
 */
function delegationChainFor(turn, agentId) {
  const leaf = String(agentId || '').toLowerCase();
  if (!turn || !leaf) return { chain: leaf ? [leaf] : [], task: null };
  const chain = [leaf];
  let task = null;
  let cur = leaf;
  const seen = new Set([leaf]);
  for (let i = turn.edges.length - 1; i >= 0; i--) {
    const edge = turn.edges[i];
    if (edge.to !== cur || seen.has(edge.from)) continue;
    if (task === null) task = edge.task || null;
    chain.unshift(edge.from);
    seen.add(edge.from);
    cur = edge.from;
  }
  return { chain, task };
}

function _clear() { _byConv.clear(); }

module.exports = { noteTurn, noteDelegation, getTurn, delegationChainFor, _clear, TTL_MS };

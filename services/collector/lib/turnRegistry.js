'use strict';
/**
 * CLI-QUOXON Q2: in-memory registry of running conversation turns, so a client
 * can interrupt or steer a turn it started (docs/QUOXON_EVENTS_v1.md).
 *
 * TENANCY: an entry is addressable only by the org AND user that started it
 * (taken from the authenticated claim by the route, never from a body). A turn
 * that exists but belongs to someone else is reported as `foreign`, which the
 * route turns into a 404 identical to "no such turn", and nothing is touched.
 *
 * Bounded (Loop Hygiene): running turns are bounded by real concurrency;
 * finished turns leave a short tombstone (so a late steer can answer
 * `turn_finished`) that expires by TTL and by a size cap, oldest first.
 * In-memory by design for v1: a collector restart forgets running turns, and
 * an unknown turn answers `turn_finished`, which the client handles by
 * sending the text as a new turn.
 */

function createTurnRegistry({ now = () => Date.now(), tombstoneTtlMs = 10 * 60 * 1000, maxEntries = 5000, maxSteerQueue = 20, maxActive = 2000, maxRecent = 20000, recentTtlMs = 24 * 60 * 60 * 1000 } = {}) {
  const entries = new Map(); // `${org}\0${turn}` -> entry
  const byTurnId = new Map(); // turnId -> Set(key), for foreign detection

  // Recently finished (org, turn_id) pairs: a retried submission must never re-run a finished turn.
  const recent = new Map(); // key -> finishedAt (insertion ordered, oldest first)
  let running = 0;

  const keyOf = (orgId, turnId) => `${orgId}\u0000${turnId}`;

  function drop(key, entry) {
    if (entries.delete(key) && entry.status === 'running') running--;
    const set = byTurnId.get(entry.turnId);
    if (set) { set.delete(key); if (set.size === 0) byTurnId.delete(entry.turnId); }
  }

  function sweep() {
    const t = now();
    for (const [k, at] of recent) {
      if (t - at > recentTtlMs) recent.delete(k); else break;
    }
    for (const [k, e] of entries) {
      if (e.status === 'finished' && t - e.finishedAt > tombstoneTtlMs) drop(k, e);
    }
    if (entries.size > maxEntries) {
      const finished = [...entries.entries()].filter(([, e]) => e.status === 'finished').sort((a, b) => a[1].finishedAt - b[1].finishedAt);
      for (const [k, e] of finished) {
        if (entries.size <= maxEntries) break;
        drop(k, e);
      }
    }
  }

  function register({ orgId, userId, conversationId = null, turnId, supportsSteer = false }) {
    if (!orgId || !userId || !turnId) throw new Error('turn_registry_bad_args');
    sweep();
    const key = keyOf(orgId, turnId);
    const existing = entries.get(key);
    if (existing && existing.status === 'running') throw new Error('turn_in_use');
    if (existing || recent.has(key)) throw new Error('turn_id_reused');
    if (running >= maxActive) throw new Error('turn_capacity');
    const controller = new AbortController();
    const entry = {
      orgId, userId, conversationId, turnId,
      status: 'running', startedAt: now(), finishedAt: null,
      controller, signal: controller.signal,
      interrupted: false, supportsSteer, steerQueue: [], appliedSteers: [], aoclCtx: null, corr: null,
    };
    entries.set(key, entry);
    running++;
    if (!byTurnId.has(turnId)) byTurnId.set(turnId, new Set());
    byTurnId.get(turnId).add(key);
    return entry;
  }

  /** @returns {{state:'running'|'finished'|'foreign'|'none', entry?:object}} */
  function lookup({ orgId, userId, conversationId = null, turnId }) {
    sweep();
    const own = entries.get(keyOf(orgId, turnId));
    if (own) {
      const sameUser = own.userId === userId;
      const sameConv = !own.conversationId || !conversationId || own.conversationId === conversationId;
      if (!sameUser || !sameConv) return { state: 'foreign' };
      return { state: own.status, entry: own };
    }
    const others = byTurnId.get(turnId);
    if (others && others.size > 0) return { state: 'foreign' };
    return { state: 'none' };
  }

  function interrupt(entry) {
    if (entry.status !== 'running') return false;
    entry.interrupted = true;
    try { entry.controller.abort(); } catch { /* already aborted */ }
    return true;
  }

  function enqueueSteer(entry, text) {
    if (entry.status !== 'running') return false;
    if (entry.steerQueue.length >= maxSteerQueue) return false;
    entry.steerQueue.push(text);
    return true;
  }

  const hasSteer = (entry) => entry.steerQueue.length > 0;

  function drainSteer(entry) {
    const q = entry.steerQueue;
    entry.steerQueue = [];
    for (const t of q) entry.appliedSteers.push(t);
    return q;
  }

  function finish(entry) {
    if (!entry || entry.status === 'finished') return;
    entry.status = 'finished';
    running--;
    entry.finishedAt = now();
    entry.steerQueue = [];
    // Do not retain policy context or steer text past the turn.
    entry.aoclCtx = null;
    entry.appliedSteers = [];
    const rk = keyOf(entry.orgId, entry.turnId);
    recent.delete(rk);
    recent.set(rk, entry.finishedAt);
    while (recent.size > maxRecent) recent.delete(recent.keys().next().value);
    sweep();
  }

  /** Conversation ids with a RUNNING turn for this org+user (QUOXON J2: state from the registry, not recency). */
  function runningConversations({ orgId, userId }) {
    const out = new Set();
    for (const e of entries.values()) {
      if (e.status === 'running' && e.orgId === orgId && e.userId === userId && e.conversationId) out.add(e.conversationId);
    }
    return out;
  }

  /** QUOXON C5: the newest RUNNING turn of this (org, user, conversation), for reattach discovery. */
  function runningTurn({ orgId, userId, conversationId }) {
    if (!orgId || !userId || !conversationId) return null;
    let best = null;
    for (const e of entries.values()) {
      if (e.status === 'running' && e.orgId === orgId && e.userId === userId && e.conversationId === conversationId && (!best || e.startedAt >= best.startedAt)) best = e;
    }
    return best;
  }

  /** True while any turn of this (org, user, conversation) is running (/compact refuses then). */
  function hasRunning({ orgId, userId, conversationId }) {
    if (!orgId || !userId || !conversationId) return false;
    return runningConversations({ orgId, userId }).has(conversationId);
  }

  const wasUsed = ({ orgId, turnId }) => { sweep(); const k = keyOf(orgId, turnId); return recent.has(k) || entries.has(k); };

  return { register, lookup, hasRunning, runningTurn, wasUsed, runningConversations, recentSize: () => recent.size, interrupt, enqueueSteer, hasSteer, drainSteer, finish, size: () => entries.size };
}

module.exports = { createTurnRegistry };

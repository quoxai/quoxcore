'use strict';
/**
 * D5 resume safety: at most one CLI turn per (org, user, conversation, agent)
 * holds the right to `--resume` (and later record) that key's Claude CLI session.
 *
 * Without it, two turns in one conversation (double submit, a second terminal,
 * a retry while the first is still running) both `--resume` the same session
 * and race on one JSONL file; the stored mapping then reflects whichever
 * finished last.
 *
 * Policy (chosen over 409 and over an unbounded queue): the second turn waits
 * briefly (DEFAULT_WAIT_MS, 2500 ms; a constant, not an env-only setting) for the first to finish. If it
 * does not, the second turn runs WITHOUT resuming: a fresh CLI session with the
 * stored history block, and it never records continuity, so the conversation's
 * session stays the first turn's. Rationale: a CLI turn can run up to the 285 s
 * turn timeout, so queueing would leave the user staring at nothing for minutes,
 * and a 409 throws away a question the user meant to ask; a fresh turn with the
 * history summary always answers, and the client is told why.
 *
 * In-memory, per collector process (the collector is one process). A hold older
 * than staleMs (default 10 min, above the 285 s turn timeout) is taken over, so a
 * leaked hold can never block a conversation for good.
 */

const DEFAULT_WAIT_MS = 2500;
const DEFAULT_STALE_MS = 10 * 60 * 1000;

const held = new Map(); // key -> { token, since, waiters: [{ grant, timer }] }
let seq = 0;

function keyOf({ orgId, userId, conversationId, agentId } = {}) {
  if (!orgId || !userId || !conversationId || !agentId) return null;
  return JSON.stringify([String(orgId), String(userId), String(conversationId).slice(0, 200), String(agentId).slice(0, 80)]);
}

function makeOwner(k, token, extra = {}) {
  let done = false;
  return {
    acquired: true,
    ...extra,
    release() {
      if (done) return;
      done = true;
      const h = held.get(k);
      if (!h || h.token !== token) return; // stale owner (taken over): never frees a newer holder
      const next = h.waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        const t = ++seq;
        h.token = t;
        h.since = Date.now();
        next.grant(makeOwner(k, t));
      } else {
        held.delete(k);
      }
    },
  };
}

/**
 * @returns {Promise<{acquired: boolean, reason?: 'no_key'|'busy', tookOverStale?: boolean, release: Function}>}
 */
function acquire(key, { waitMs, staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  const k = keyOf(key);
  const noop = (reason) => ({ acquired: false, reason, release() {} });
  if (!k) return Promise.resolve(noop('no_key'));
  const wait = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : DEFAULT_WAIT_MS;
  const h = held.get(k);
  if (!h) {
    const t = ++seq;
    held.set(k, { token: t, since: now(), waiters: [] });
    return Promise.resolve(makeOwner(k, t));
  }
  if (now() - h.since > staleMs) {
    const t = ++seq;
    h.token = t;
    h.since = now();
    console.warn('[CliConversationLock] took over a stale hold (previous turn never released)');
    return Promise.resolve(makeOwner(k, t, { tookOverStale: true }));
  }
  if (wait === 0) return Promise.resolve(noop('busy'));
  return new Promise((resolve) => {
    const w = { grant: resolve, timer: null };
    w.timer = setTimeout(() => {
      const cur = held.get(k);
      if (cur) cur.waiters = cur.waiters.filter((x) => x !== w);
      resolve(noop('busy'));
    }, wait);
    h.waiters.push(w);
  });
}

function isHeld(key) {
  const k = keyOf(key);
  return !!(k && held.has(k));
}

function _resetForTest() {
  for (const h of held.values()) for (const w of h.waiters) clearTimeout(w.timer);
  held.clear();
}

module.exports = { acquire, isHeld, _resetForTest, DEFAULT_WAIT_MS, DEFAULT_STALE_MS };

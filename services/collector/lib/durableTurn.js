'use strict';
/**
 * QUOXON C5 (events contract v1.1): the write side of a /chat/stream turn.
 *
 * One sink per turn. `write(event)` stamps the event with its `seq` through the
 * turn event log and, while a client is attached, writes the SSE frame. The
 * client going away is handled by `onDisconnect(entry)`:
 *   - durable turn (the client sent `durable: true` or `X-Quox-Durable: 1`)
 *     that is registered to an authenticated user: DETACH. The turn keeps
 *     running, events keep being logged, and the user can reattach with
 *     GET /api/v1/conversations/:cid/turns/:tid/events?after=<seq>.
 *     Interrupt is the only way to stop it.
 *   - anything else (the dashboard, service callers, a disconnect before the
 *     turn was registered): ABORT, exactly as in v1.
 */

function truthy(v) {
  return v === true || v === 1 || v === 'true' || v === '1';
}

/** Durable is opt-in per request: body/query `durable` or header `X-Quox-Durable`. */
function wantsDurable(sp, req) {
  if (sp && truthy(sp.durable)) return true;
  const h = req && typeof req.get === 'function' ? req.get('X-Quox-Durable') : (req && req.headers ? req.headers['x-quox-durable'] : undefined);
  return truthy(h);
}

function createTurnSink({ res, eventLog, turnId, conversationId = null, durable = false }) {
  const handle = eventLog ? eventLog.open({ turnId, conversationId }) : null;
  const state = { durable: Boolean(durable), closed: false, detached: false, entry: null };

  function write(data) {
    const out = handle ? eventLog.append(handle, data) : data;
    if (!state.closed && !res.writableEnded) res.write(`data: ${JSON.stringify(out)}\n\n`);
    return out;
  }

  /** Bind the log to the verified org + user once the turn is registered. */
  function bind(entry) {
    if (!entry) return;
    state.entry = entry;
    entry.durable = state.durable;
    entry.detached = false;
    if (handle) eventLog.bind(handle, { orgId: entry.orgId, userId: entry.userId });
  }

  /** @returns {'detached'|'abort'} what the handler must do about the lost client. */
  function onDisconnect() {
    state.closed = true;
    if (state.durable && state.entry && state.entry.status === 'running' && handle && handle.key) {
      state.detached = true;
      state.entry.detached = true;
      return 'detached';
    }
    return 'abort';
  }

  function finish() {
    if (handle) eventLog.finish(handle);
  }

  return { write, bind, onDisconnect, finish, state, handle, lastSeq: () => (handle ? handle.lastSeq : null) };
}

module.exports = { wantsDurable, createTurnSink };

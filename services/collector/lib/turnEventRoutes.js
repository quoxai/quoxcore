'use strict';
/**
 * QUOXON C5 (events contract v1.1, docs/QUOXON_EVENTS_v1_1.md): reattach routes.
 *
 *   GET /api/v1/conversations/:cid/turns/:tid/events?after=<seq>   (SSE)
 *       replays buffered events with seq > after, then follows the turn live
 *       until it finishes. 404 for a turn that is not yours (or does not
 *       exist), 410 when its events expired, 400 for a bad cursor.
 *   GET /api/v1/conversations/:cid/running
 *       -> { running, turn_id, last_seq, started_at, durable, detached }
 *
 * Tenancy is identical to lib/turnControlRoutes.js: org and user come ONLY
 * from the verified claim; a bare service caller is refused; another user's
 * or org's turn is a 404 indistinguishable from a missing one.
 */

const PING_MS = 15000;

function claim(req) {
  const u = req.user;
  if (!u) return null;
  const orgId = u.org_id || u.orgId;
  const userId = u.id;
  return orgId && userId ? { orgId, userId } : null;
}

function parseAfter(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v !== 'string' || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

function registerTurnEventRoutes(app, { registry, eventLog, auth, pingMs = PING_MS, corsOrigin = () => null }) {
  app.get('/api/v1/conversations/:cid/turns/:tid/events', auth(), (req, res) => {
    const c = claim(req);
    if (!c) return res.status(403).json({ error: 'user_claim_required' });
    const after = parseAfter(req.query.after);
    if (after === null) return res.status(400).json({ error: 'invalid_cursor', message: 'after must be a non-negative integer seq' });
    const found = eventLog.lookup({ ...c, conversationId: req.params.cid, turnId: req.params.tid });
    if (found.state === 'foreign' || found.state === 'none') return res.status(404).json({ error: 'turn_not_found' });
    if (found.state === 'expired') return res.status(410).json({ error: 'turn_events_expired', message: 'This turn finished more than 30 minutes ago; its events are no longer kept. Its answer is in the conversation history.' });
    const log = found.log;

    const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };
    const origin = corsOrigin(req);
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    res.writeHead(200, headers);

    let sent = after;
    let done = false;
    let unsubscribe = () => {};
    let ping = null;
    const end = () => {
      if (done) return;
      done = true;
      clearInterval(ping);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    const writeEv = (ev) => {
      if (done || res.writableEnded || ev.seq <= sent) return; // exactly once, in order
      sent = ev.seq;
      res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    };

    // Replay and subscribe in the same tick: nothing can be appended in between.
    const { events, gap } = eventLog.eventsAfter(log, after);
    if (gap) res.write(`data: ${JSON.stringify({ type: 'replay.gap', turn_id: log.turnId, from: gap.from, to: gap.to })}\n\n`);
    for (const ev of events) writeEv(ev);
    if (log.status === 'finished') return end();
    unsubscribe = eventLog.subscribe(log, (ev) => { if (ev) writeEv(ev); else end(); });
    ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, pingMs);
    if (ping.unref) ping.unref();
    res.on('close', end);
    return undefined;
  });

  app.get('/api/v1/conversations/:cid/running', auth(), (req, res) => {
    const c = claim(req);
    if (!c) return res.status(403).json({ error: 'user_claim_required' });
    const entry = registry.runningTurn({ ...c, conversationId: req.params.cid });
    if (!entry) return res.json({ running: false, turn_id: null, last_seq: null });
    const found = eventLog.lookup({ ...c, conversationId: req.params.cid, turnId: entry.turnId });
    return res.json({
      running: true,
      turn_id: entry.turnId,
      last_seq: found.log ? found.log.lastSeq : null,
      started_at: new Date(entry.startedAt).toISOString(),
      durable: Boolean(entry.durable),
      detached: Boolean(entry.detached),
    });
  });
}

module.exports = { registerTurnEventRoutes, parseAfter };

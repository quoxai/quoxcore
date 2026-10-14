'use strict';

/**
 * QUOXON J1 routes: the org-scoped live session index + the wrapper heartbeat.
 *
 *   GET  /api/v1/sessions            one index of everything live for the caller's org
 *   POST /api/v1/sessions/heartbeat  { host, session } from the `quox claude` wrapper
 *   POST /api/v1/sessions/end        { host, name } when the wrapped tmux session ends
 *
 * Authenticated only (not in the default-deny allowlist). Org comes from the
 * injected resolver (resolveSlotOrgId in server.js: the verified claim for
 * users; only service-key callers may name one) and fails closed with 400.
 * Each source fails on its own and is named in `sources`; a failed source adds
 * no rows (never a placeholder). Dependencies are injected so the handlers run
 * under a plain express app in tests.
 */

const idx = require('./sessionsIndex.js');

const SOURCE_TIMEOUT_MS = 3000;

function withTimeout(p, ms) {
  let t;
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); }),
  ]);
}

function registerSessionsIndexRoutes(app, deps) {
  const {
    db, auth, resolveOrgId, listConversations, listSlots, fetchObjectives, fetchExecutions, runningConversations,
    hostname = () => null, now = () => Date.now(),
  } = deps;

  const getDb = () => (typeof db === 'function' ? db() : db);

  app.get('/api/v1/sessions', auth(), async (req, res) => {
    const h = getDb();
    if (!h) return res.status(503).json({ error: 'storage unavailable' });
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });
    const sourceStates = {};
    const fail = (id, err, state = 'error') => {
      sourceStates[id] = { state, note: (err && err.message) || String(err) };
      return [];
    };
    const sync = (id, fn) => { try { return fn() || []; } catch (e) { return fail(id, e); } };
    const nowMs = now();
    let liveRows;
    try {
      liveRows = idx.listLiveRows(h, { orgId, now: () => nowMs });
    } catch (err) {
      console.error('[SessionsIndex] tmux rows failed:', err.message);
      liveRows = fail('tmux', err);
    }
    const userId = req.user && req.user.id;
    const conversations = userId
      ? sync('conversations', () => listConversations({ orgId, userId, limit: 50 }))
      : fail('conversations', new Error('conversations are per user; a service caller has none'), 'unavailable');
    let running = null;
    if (userId && runningConversations) {
      try { running = runningConversations({ orgId, userId }); } catch (e) { console.error('[SessionsIndex] turn registry read failed:', e.message); }
    }
    const slots = sync('slots', () => listSlots({ orgId }));
    const remote = async (id, fn) => {
      if (!fn) return fail(id, new Error('no source configured'), 'unavailable');
      try {
        const rows = await withTimeout(fn({ orgId, req }), SOURCE_TIMEOUT_MS);
        if (!Array.isArray(rows)) throw new Error('unexpected response');
        return rows;
      } catch (e) { return fail(id, e); }
    };
    const [objectives, executions] = await Promise.all([remote('objectives', fetchObjectives), remote('executions', fetchExecutions)]);
    const host = hostname();
    const out = idx.buildIndex({ now: nowMs, host, liveRows, conversations, runningConversations: running, slots, objectives, executions, sourceStates });
    return res.json({ generated_at: new Date(nowMs).toISOString(), server_host: host, ...out });
  });

  app.post('/api/v1/sessions/heartbeat', auth(), (req, res) => {
    const h = getDb();
    if (!h) return res.status(503).json({ error: 'storage unavailable' });
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });
    const v = idx.validateHeartbeatBody(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      const r = idx.heartbeatSession(h, { orgId, host: v.host, session: v.session, now });
      return res.json({ ...r, expires_after_s: idx.MISSED_BEATS * v.session.interval_s });
    } catch (err) {
      console.error('[SessionsIndex] heartbeat failed:', err.message);
      return res.status(500).json({ error: 'heartbeat failed' });
    }
  });

  app.post('/api/v1/sessions/end', auth(), (req, res) => {
    const h = getDb();
    if (!h) return res.status(503).json({ error: 'storage unavailable' });
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });
    const b = req.body || {};
    if (typeof b.host !== 'string' || !b.host || b.host.length > 128 || typeof b.name !== 'string' || !b.name || b.name.length > 128) {
      return res.status(400).json({ error: 'host and name must be non-empty strings up to 128 chars' });
    }
    try {
      return res.json({ ok: true, ...idx.endSession(h, { orgId, host: b.host, name: b.name }) });
    } catch (err) {
      console.error('[SessionsIndex] end failed:', err.message);
      return res.status(500).json({ error: 'end failed' });
    }
  });
}

module.exports = { registerSessionsIndexRoutes, SOURCE_TIMEOUT_MS };

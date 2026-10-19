'use strict';
/**
 * PRESENCE routes (owner 2026-10-16). The org is the verified caller's only; a human login sets
 * its own presence, anyone in the org can read it (sessions and agents need to know).
 *   GET  /api/v1/presence          -> { presence: [...], away, notice }
 *   GET  /api/v1/presence/me       -> { presence }
 *   GET  /api/v1/presence/:who     -> { presence } (user id, email, email name or "owner"); 404 if unknown
 *   PUT  /api/v1/presence          { state: present|away|sleeping, note?, slots?, auto_away_minutes? }
 * Nothing here touches approvals: they queue exactly as before.
 */
const { slotNotice } = require('./userPresence.js');

function registerUserPresenceRoutes(app, { getStore, auth, resolveOrgId, audit = () => {} }) {
  const store = () => getStore();
  const ready = (req, res) => {
    if (!store()) { res.status(503).json({ error: 'storage unavailable' }); return null; }
    const orgId = resolveOrgId(req);
    if (!orgId) { res.status(400).json({ error: 'org could not be resolved' }); return null; }
    return orgId;
  };

  app.get('/api/v1/presence', auth(), (req, res) => {
    const orgId = ready(req, res); if (!orgId) return;
    try {
      const list = store().list({ orgId });
      const away = list.filter((p) => p.away);
      res.json({ presence: list, away: away.length > 0, notice: slotNotice(away, store().nowDate()) });
    } catch (err) { console.error('[Presence] list failed:', err.message); res.status(500).json({ error: 'presence read failed' }); }
  });

  // POST /api/v1/presence/activity { action, clear? }: the human's own first real action clears away.
  app.post('/api/v1/presence/activity', auth(), (req, res) => {
    const orgId = ready(req, res); if (!orgId) return;
    const b = req.body || {};
    try {
      const r = store().touch({ orgId, user: req.user, action: b.action, clear: b.clear !== false, wantWelcome: b.quiet !== true });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      if (r.cleared) {
        try {
          audit({ type: 'event', from: `user.${req.user.id}`, to: 'audit.system', intent: 'quox.presence.auto_clear', corr: req.user.id,
            payload: { org_id: orgId, user_id: req.user.id, via: String(b.action || 'activity').slice(0, 40) } });
        } catch { /* the witness never blocks the write */ }
      }
      res.json({ ok: true, cleared: r.cleared, welcome: r.welcome });
    } catch (err) { console.error('[Presence] activity failed:', err.message); res.status(500).json({ error: 'presence write failed' }); }
  });

  app.get('/api/v1/presence/:who', auth(), (req, res) => {
    const orgId = ready(req, res); if (!orgId) return;
    try {
      if (req.params.who === 'me') return res.json({ presence: store().get({ orgId, userId: req.user && req.user.id }) });
      const p = store().find({ orgId, who: req.params.who });
      if (!p) return res.status(404).json({ error: 'no presence on record for that person in this org' });
      res.json({ presence: p });
    } catch (err) { console.error('[Presence] read failed:', err.message); res.status(500).json({ error: 'presence read failed' }); }
  });

  app.put('/api/v1/presence', auth(), (req, res) => {
    const orgId = ready(req, res); if (!orgId) return;
    const b = req.body || {};
    try {
      const r = store().set({ orgId, user: req.user, state: b.state, note: b.note, slots: b.slots, autoAwayMinutes: b.auto_away_minutes });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      if (r.changed) {
        try {
          audit({ type: 'event', from: `user.${req.user.id}`, to: 'audit.system', intent: 'quox.presence.set', corr: req.user.id,
            payload: { org_id: orgId, user_id: req.user.id, state: r.presence.state, since: r.presence.since, has_note: Boolean(r.presence.note) } });
        } catch { /* the witness never blocks the write */ }
      }
      res.json({ ok: true, presence: r.presence, notice: r.presence.away ? slotNotice([r.presence], store().nowDate()) : null });
    } catch (err) { console.error('[Presence] set failed:', err.message); res.status(500).json({ error: 'presence write failed' }); }
  });
}

module.exports = { registerUserPresenceRoutes };

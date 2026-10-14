/**
 * QUOXON E5: GET /api/v1/away?since=<iso>  (authenticated, org + user scoped, read-only)
 *
 * since: an ISO time (default 24 h ago, clamped to 30 days). The org is the caller's (resolveOrgId),
 * never the query's. readersFor(req, ctx) builds the per-source readers (server.js wires the real
 * services); see lib/awayDigest.js for the digest contract.
 */
const { buildAwayDigest } = require('./awayDigest.js');

const DAY = 86400000;

function registerAwayRoutes(app, { auth, resolveOrgId, readersFor, now = () => Date.now() }) {
  app.get('/api/v1/away', auth(), async (req, res) => {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org could not be resolved' });
    const t = now();
    const raw = typeof req.query.since === 'string' ? req.query.since.trim() : '';
    let sinceMs = t - DAY;
    if (raw) {
      const p = Date.parse(raw);
      if (!/^\d{4}-\d\d-\d\d/.test(raw) || !Number.isFinite(p)) return res.status(400).json({ error: 'since must be an ISO time' });
      if (p > t) return res.status(400).json({ error: 'since is in the future' });
      sinceMs = Math.max(p, t - 30 * DAY);
    }
    const userId = (req.user && (req.user.id || req.user.sub || req.user.user_id)) || null;
    const ctx = { orgId, userId, sinceMs, now: t };
    try {
      res.set('Cache-Control', 'private, no-store');
      res.json(await buildAwayDigest({ ...ctx, readers: readersFor(req, ctx) }));
    } catch (err) {
      console.error('[away] digest failed:', err && err.message);
      res.status(500).json({ error: 'away digest failed' });
    }
  });
}

module.exports = { registerAwayRoutes };

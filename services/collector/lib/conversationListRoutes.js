'use strict';
/**
 * CLI-QUOXON Q2: conversation index + resume read over chat_session_turns.
 *
 *   GET /api/v1/conversations?limit=
 *   GET /api/v1/conversations/:id/turns?after=&limit=
 *
 * Org and user come from the verified claim only. This table is working memory
 * (7-day TTL, max 50 turns per session, encrypted), not the conversation archive.
 * A conversation id belonging to someone else is simply empty.
 */

function claim(req) {
  const u = req.user;
  if (!u) return null;
  const orgId = u.org_id || u.orgId;
  return orgId && u.id ? { orgId, userId: u.id } : null;
}

function registerConversationListRoutes(app, { store, auth, dbPath }) {
  const opts = dbPath ? { dbPath } : {};

  app.get('/api/v1/conversations', auth(), (req, res) => {
    const c = claim(req);
    if (!c) return res.status(403).json({ error: 'user_claim_required' });
    const rows = store.listSessions({ ...c, limit: req.query.limit }, opts);
    return res.json({
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        updated_at: new Date(r.updated_at).toISOString(),
        turn_count: r.turn_count,
        last_turn_id: r.last_turn_id || null, // null for exchanges recorded before turn ids were stored
        agent: r.agent || null, // the agent the latest exchange ran under (QUOXON J2)
      })),
    });
  });

  app.get('/api/v1/conversations/:id/turns', auth(), (req, res) => {
    const c = claim(req);
    if (!c) return res.status(403).json({ error: 'user_claim_required' });
    const rows = store.listMessages({ ...c, sessionId: req.params.id, after: req.query.after, limit: req.query.limit }, opts);
    return res.json({
      turns: rows.map((r) => ({ id: r.id, turn_id: r.turn_id || null, role: r.role, content: r.content, ts: new Date(r.ts).toISOString() })),
      next_after: rows.lastId ?? (rows.length ? rows[rows.length - 1].id : (req.query.after ?? null)),
    });
  });
}

module.exports = { registerConversationListRoutes };

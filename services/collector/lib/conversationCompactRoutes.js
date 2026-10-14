'use strict';
/**
 * /compact and /context for the quox client.
 *
 *   POST /api/v1/conversations/:id/compact  -> { summary, tokens_before, tokens_after, ... }
 *   GET  /api/v1/conversations/:id/context  -> { turns, summary_present, tokens, provider, model, ... }
 *
 * Auth: the collector default-deny gate plus `auth()` per route; a USER claim is
 * required (org + user from the verified claim only). Someone else's conversation
 * is a 404, indistinguishable from an unknown id, and never reaches the model.
 * A turn running in the conversation is a 409 (its CLI continuity record would
 * otherwise re-arm the session this resets). One compaction per conversation at a time.
 */

const compaction = require('./conversationCompaction.js');

function claim(req) {
  const u = req.user;
  if (!u) return null;
  const orgId = u.org_id || u.orgId;
  return orgId && u.id ? { orgId, userId: u.id } : null;
}

function bearer(req) {
  const h = req.headers && req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)access_token=([^;]+)/.exec((req.headers && req.headers.cookie) || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function registerConversationCompactRoutes(app, { store, auth, summarise, storeOpts = {}, isBusy, onCompacted, onFailed, transcriptsDisabled }) {
  const inFlight = new Set();

  app.post('/api/v1/conversations/:id/compact', auth(), async (req, res) => {
    const c = claim(req);
    if (!c) return res.status(403).json({ error: 'user_claim_required' });
    const conversationId = String(req.params.id || '').slice(0, 200);
    const who = { ...c, conversationId };
    // Existence first, so a foreign id is a plain 404 whatever else is true.
    if (!compaction.conversationContext(who, { store, storeOpts })) return res.status(404).json({ error: 'conversation_not_found' });
    if (typeof transcriptsDisabled === 'function' && transcriptsDisabled(c.orgId)) {
      return res.status(409).json({ error: 'transcripts_disabled', message: 'Transcript storage is off for this org, so no summary can be stored.' });
    }
    if (typeof isBusy === 'function' && isBusy(who)) {
      return res.status(409).json({ error: 'turn_running', message: 'A turn is still running in this conversation. Compact after it finishes.' });
    }
    const key = `${c.orgId}\u0000${c.userId}\u0000${conversationId}`;
    if (inFlight.has(key)) return res.status(409).json({ error: 'compact_in_progress' });
    inFlight.add(key);
    try {
      const out = await compaction.compactConversation({ ...who, userAccessToken: bearer(req) }, { store, storeOpts, summarise });
      if (out.status === 'not_found') return res.status(404).json({ error: 'conversation_not_found' });
      if (out.status === 'store_failed') return res.status(500).json({ error: 'summary_not_stored' });
      if (out.status === 'ok' && typeof onCompacted === 'function') {
        try { onCompacted(who, out); } catch { /* evidence is best-effort after a durable store */ }
      }
      return res.json({
        summary: out.summary,
        tokens_before: out.tokens_before,
        tokens_after: out.tokens_after,
        turns_compacted: out.turns_compacted,
        unchanged: out.status === 'unchanged',
        cli_session_reset: out.cli_sessions_reset > 0,
        provider: out.provider || null,
        model: out.model || null,
        // The basis: tools the stored turns recorded, so the user can check any action the summary names.
        tool_activity: Array.isArray(out.tool_activity) ? out.tool_activity : [],
      });
    } catch (err) {
      if (typeof onFailed === 'function') { try { onFailed(who, err); } catch { /* ignore */ } }
      if (err && err.code === 'ai_consent_required') {
        return res.status(403).json({ error: 'ai_consent_required', reason: err.reason || 'no_consent', retryable: !!err.retryable });
      }
      if (err && err.code === 'no_provider') return res.status(503).json({ error: 'no_provider', message: 'No AI provider is configured for this org.' });
      return res.status(502).json({ error: 'compaction_failed', message: 'The model call failed; nothing was changed.' });
    } finally {
      inFlight.delete(key);
    }
  });

  app.get('/api/v1/conversations/:id/context', auth(), (req, res) => {
    const c = claim(req);
    if (!c) return res.status(403).json({ error: 'user_claim_required' });
    const body = compaction.conversationContext({ ...c, conversationId: String(req.params.id || '').slice(0, 200) }, { store, storeOpts });
    if (!body) return res.status(404).json({ error: 'conversation_not_found' });
    return res.json(body);
  });
}

module.exports = { registerConversationCompactRoutes };

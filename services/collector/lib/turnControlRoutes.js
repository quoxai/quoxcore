'use strict';
/**
 * CLI-QUOXON Q2: turn control routes (docs/QUOXON_EVENTS_v1.md).
 *
 *   POST /api/v1/conversations/:cid/turns/:tid/interrupt
 *   POST /api/v1/conversations/:cid/turns/:tid/steer   { text }
 *
 * Auth: the collector default-deny gate plus `auth()` on each route (a USER
 * claim is required; a bare service caller has no org/user to scope by and is
 * refused). Org and user come ONLY from the verified claim. A turn that belongs
 * to another org/user is a 404 indistinguishable from a missing route target.
 */

const MAX_STEER_CHARS = 4000;

function claim(req) {
  const u = req.user;
  if (!u) return null;
  const orgId = u.org_id || u.orgId;
  const userId = u.id;
  return orgId && userId ? { orgId, userId } : null;
}

function registerTurnControlRoutes(app, { registry, auth, policyCheck, onSteerAccepted }) {
  const common = (req, res) => {
    const c = claim(req);
    if (!c) { res.status(403).json({ error: 'user_claim_required' }); return null; }
    const found = registry.lookup({ ...c, conversationId: req.params.cid, turnId: req.params.tid });
    if (found.state === 'foreign') { res.status(404).json({ error: 'turn_not_found' }); return null; }
    if (found.state === 'none' || found.state === 'finished') {
      res.status(200).json({ queued: false, reason: 'turn_finished' });
      return null;
    }
    return found.entry;
  };

  app.post('/api/v1/conversations/:cid/turns/:tid/interrupt', auth(), (req, res) => {
    const entry = common(req, res);
    if (!entry) return undefined;
    registry.interrupt(entry);
    return res.status(202).json({ queued: true });
  });

  app.post('/api/v1/conversations/:cid/turns/:tid/steer', auth(), async (req, res) => {
    const entry = common(req, res);
    if (!entry) return undefined;
    const text = req.body && req.body.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_STEER_CHARS) {
      return res.status(400).json({ error: 'invalid_text', message: `text must be a non-empty string up to ${MAX_STEER_CHARS} chars` });
    }
    if (!entry.supportsSteer) {
      return res.status(409).json({ queued: false, error: 'steer_unsupported', code: 'steer_unsupported', reason: 'steer_unsupported_for_provider' });
    }
    const clean = text.trim();
    // Steer text is model input: it goes through the same AOCL L3 pre-LLM policy gate
    // as the original prompt. Fail closed; nothing is queued on deny or error.
    if (typeof policyCheck === 'function') {
      let verdict;
      try { verdict = await policyCheck(entry, clean); } catch { verdict = { ok: false, reason: 'policy_check_unavailable' }; }
      if (!verdict || verdict.ok !== true) {
        return res.status(403).json({ queued: false, reason: 'steer_denied_by_policy', detail: verdict && verdict.reason ? String(verdict.reason) : undefined });
      }
    }
    if (entry.status !== 'running') return res.status(200).json({ queued: false, reason: 'turn_finished' });
    if (!registry.enqueueSteer(entry, clean)) {
      return res.status(429).json({ queued: false, reason: 'steer_queue_full' });
    }
    if (typeof onSteerAccepted === 'function') {
      try { onSteerAccepted(entry, clean); } catch { /* evidence is best-effort here; the queue already holds it */ }
    }
    return res.status(202).json({ queued: true });
  });
}

module.exports = { registerTurnControlRoutes, MAX_STEER_CHARS };

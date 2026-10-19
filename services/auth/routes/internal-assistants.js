/**
 * QUOXIDENTITY custom-attach fix, Part A (QuoxPlan #487) — internal
 * single-assistant accessor for the collector's agent-attach kit renderer.
 *
 * GET /api/internal/assistants/:id
 *
 * The collector's kit renderer (services/collector/lib/agentAttachKit.js)
 * only knew about static core agents (entityAssistantLoader, the JSON files
 * under src/config/entities/assistants/) — a USER/ORG-created custom
 * assistant (auth SQLite `assistants` table) had no readable kit source, so
 * `quox agent attach <customId>` rendered an empty kit even though
 * grant/attach plumbing was already agent-agnostic. This endpoint is the
 * missing read path: it lets the collector hydrate a custom assistant's
 * persona (system_prompt), model, and allowed tools the same way it already
 * hydrates a core agent's.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY), timing-safe, fail CLOSED —
 * same pattern as routes/internal-orgs.js.
 *
 * ORG-SCOPED SECURITY BOUNDARY: the caller must pass its own org id (header
 * X-Org-Id or query ?org_id=). A row whose org_id does not match the
 * caller's org id resolves to 404 — never the row's data, and never a
 * generic 403 that would confirm the row exists in someone else's org. This
 * is the isolation boundary that stops one org's collector call from
 * reading another org's assistant persona/tools.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { safeParseJson, parseAssistantPersona } from './assistantLlm.js';

const router = Router();

function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying assistants/:id request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

router.get('/assistants/:id', (req, res) => {
  const callerOrgId = req.query.org_id || req.headers['x-org-id'];
  if (!callerOrgId) {
    return res.status(400).json({ error: 'missing_org_id', message: 'org_id query param or x-org-id header required' });
  }

  const db = req.db || getDb();
  let row;
  try {
    // Match by PRIMARY KEY id OR slug: the attach chain's agent_id is
    // whatever string the operator typed (grant-attach/attach take an
    // arbitrary customId, cli/lib/commands/agentAttach.js), which in
    // practice is the human-readable slug, not the ULID. The org_id scope
    // is baked directly into the WHERE clause (not checked after the
    // fetch) so a matching slug/id in a DIFFERENT org can never be the row
    // returned here in the first place.
    row = db.prepare(
      'SELECT id, org_id, name, slug, status, persona_json, model_id, model_config_json, allowed_tools_json FROM assistants WHERE org_id = ? AND (id = ? OR slug = ?)'
    ).get(callerOrgId, req.params.id, req.params.id);
  } catch (err) {
    console.error('[internal-assistants] lookup failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }

  // Row not found (wrong id/slug, OR right id/slug but a DIFFERENT org —
  // the query above already excludes that case) — either way, the same
  // 404 shape, so a cross-org probe cannot distinguish "doesn't exist"
  // from "exists but isn't yours".
  if (!row) {
    return res.status(404).json({ error: 'assistant_not_found' });
  }

  const persona = parseAssistantPersona(row);
  const tools = safeParseJson(row.allowed_tools_json, []);
  const modelConfig = safeParseJson(row.model_config_json, {});

  return res.json({
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    system_prompt: persona.system_prompt || '',
    tools: Array.isArray(tools) ? tools : [],
    model_id: row.model_id || null,
    model_config: modelConfig,
  });
});

/**
 * GET /api/internal/org-agents/:agentId?org_id=
 * quox#1170: is this an ACTIVE custom agent (agents table, `quox agent create`) IN the caller's
 * org? The collector asks before it accepts a JWT agent_id claim for a user-made agent. Same
 * boundary as above: org scope in the WHERE clause, and another org's agent, a retired or
 * inactive one, or a built-in (known to the collector already) is the same 404.
 */
router.get('/org-agents/:agentId', (req, res) => {
  const callerOrgId = req.query.org_id || req.headers['x-org-id'];
  if (!callerOrgId) {
    return res.status(400).json({ error: 'missing_org_id', message: 'org_id query param or x-org-id header required' });
  }
  const db = req.db || getDb();
  let row;
  try {
    row = db.prepare(
      "SELECT agent_id, org_id, status FROM agents WHERE org_id = ? AND agent_id = ? AND status = 'active' AND is_core = 0"
    ).get(callerOrgId, req.params.agentId);
  } catch (err) {
    console.error('[internal-org-agents] lookup failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }
  if (!row) return res.status(404).json({ error: 'agent_not_found' });
  return res.json({ agent_id: row.agent_id, org_id: row.org_id, status: row.status });
});

export default router;

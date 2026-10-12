/**
 * POWERS-P2.C-fix-3 Item 1 — Internal tool-definitions snapshot endpoint
 *
 * GET /api/internal/tool-definitions/snapshot
 *
 * Returns ALL mcp_endpoint and mcp_hosted tool_definitions rows (across ALL
 * orgs) joined with their tool_installations, shaped to match what the
 * collector's /api/internal/tool-definitions/install handler expects on its
 * request body. Used by the collector on boot to reseed its in-memory
 * toolDefinitionsStore after a restart.
 *
 * LIFECYCLE-P1-D1 — Drift-recovery callback endpoint
 *
 * POST /api/internal/powers/available-tools/:toolDefId
 *
 * Called by the collector's _scheduleHostedToolsReprobe after a re-probe.
 * Merges the fresh tool list into tool_installations.config_json.available_tools,
 * marks deprecated entries, clears re-appeared ones, and emits audit events.
 *
 * Auth: X-Service-Key (INTERNAL_SERVICE_KEY) — same timing-safe pattern used
 * by the collector's /api/internal/tool-definitions/install handler.
 *
 * Rationale (CLAUDE.md ZERO TOLERANCE — Data Persistence):
 * The collector's in-memory toolDefinitionsStore is a cache, NOT the source of
 * truth. Auth's tool_definitions table IS the source of truth. Every collector
 * restart silently vaporises the cache. This endpoint lets the collector reseed
 * from auth on boot — server-side DB is always authoritative.
 */

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { safeCompare } from '../utils/crypto.js';
import { applyAvailableToolsDrift } from '../lib/powersAvailableToolsDrift.js';

const router = Router();

/**
 * Internal service key auth middleware (same pattern as identity.js and others).
 * Fails CLOSED when INTERNAL_SERVICE_KEY is not configured.
 */
function requireInternalAuth(req, res, next) {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying snapshot request');
    return res.status(401).json({ error: 'Service key not configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
  return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

/**
 * GET /api/internal/tool-definitions/snapshot
 *
 * Returns array of install-shaped payloads for all mcp_endpoint and
 * mcp_hosted tools across ALL orgs. Each element matches the body shape
 * that /api/internal/tool-definitions/install (collector) expects.
 *
 * Response: { ok: true, count: N, tools: [...] }
 *
 * Each tool element:
 *   {
 *     toolId: string,        // tool_definitions.tool_id
 *     orgId: string,         // tool_installations.org_id
 *     toolName: string,      // tool_definitions.name
 *     source: 'powers',
 *     edition: 'experimental',
 *     executor_type: 'mcp_endpoint' | 'mcp_hosted',
 *     executor_config_payload: object,   // parsed from tool_installations.config_json
 *     agent_id: string | null,           // from agent_tool_assignments
 *   }
 */
router.get('/tool-definitions/snapshot', (req, res) => {
  const db = req.db || getDb();

  let rows;
  try {
    // Join tool_definitions + tool_installations to get org-scoped rows.
    // Filter to mcp_endpoint and mcp_hosted only (the executor types the
    // collector needs to re-register for dispatch). Native/toolsmith tools are
    // seeded from hardcoded TOOL_DEFS at boot; they don't need this reseed.
    //
    // We also pull agent_id from agent_tool_assignments (optional — may be null
    // if no assignment exists yet).
    rows = db.prepare(`
      SELECT
        td.id                 AS toolDefinitionId,
        td.tool_id            AS toolId,
        ti.org_id             AS orgId,
        td.name               AS toolName,
        td.spec_json          AS specJson,
        ti.config_json        AS configJson,
        ti.id                 AS installationId,
        ata.agent_id          AS agentId
      FROM tool_definitions td
      JOIN tool_installations ti ON ti.tool_definition_id = td.id
      LEFT JOIN agent_tool_assignments ata
        ON ata.tool_installation_id = ti.id
        AND ata.enabled = 1
        AND ata.revoked_at IS NULL
      WHERE td.status NOT IN ('disabled', 'deprecated')
        AND ti.enabled = 1
        AND (
          td.category = 'mcp'
          OR td.tool_id LIKE 'powers.%'
          OR (
            ti.config_json LIKE '%"executor_type":"mcp_endpoint"%'
            OR ti.config_json LIKE '%"executor_type":"mcp_hosted"%'
          )
        )
      ORDER BY ti.org_id, td.tool_id
    `).all();
  } catch (err) {
    console.error('[snapshot] DB query failed:', err.message);
    return res.status(500).json({ error: 'db_error', message: err.message });
  }

  const tools = [];

  for (const row of rows) {
    let configJson = {};
    try { configJson = JSON.parse(row.configJson || '{}'); } catch (_) {}

    let specJson = {};
    try { specJson = JSON.parse(row.specJson || '{}'); } catch (_) {}

    // Determine executor_type from config_json (set at install time) or spec_json
    const executorType = configJson.executor_type || specJson.executor_type;
    if (executorType !== 'mcp_endpoint' && executorType !== 'mcp_hosted') {
      // Skip rows that aren't the executor types we need
      continue;
    }

    // Build executor_config_payload matching what collector install handler expects.
    // For mcp_endpoint: { mcp_url, mcp_auth_kind, mcp_auth_value_encrypted, available_tools, ... }
    // For mcp_hosted:   { tool_def_id, repo_url }
    let executorConfigPayload;
    if (executorType === 'mcp_endpoint') {
      executorConfigPayload = {
        mcp_url: configJson.mcp_url,
        mcp_auth_kind: configJson.mcp_auth_kind,
        mcp_auth_value_encrypted: configJson.mcp_auth_value_encrypted,
        tool_name: configJson.tool_name,
        available_tools: configJson.available_tools || [],
        // POWERS-P2.C-fix-4b: include agent_id so collector.hasAgent() finds it
        // after a reseed. Matches the shape live deploys produce.
        agent_id: row.agentId || null,
      };
    } else {
      // mcp_hosted — INTROSPECT-P1: include available_tools from config_json if probed
      // INTROSPECT-P3-fix: tool_def_id = tool_definitions.id = powers_hosted.tool_id
      // (the URL slug powers-host expects). Previously set to tool_installations.id by mistake.
      executorConfigPayload = {
        tool_def_id: row.toolDefinitionId,
        repo_url: configJson.repo_url || specJson.source_url,
        agent_id: row.agentId || null,
        available_tools: Array.isArray(configJson.available_tools) ? configJson.available_tools : [],
      };
    }

    tools.push({
      toolId: row.toolId,
      orgId: row.orgId,
      toolName: row.toolName,
      source: 'powers',
      edition: 'experimental',
      executor_type: executorType,
      executor_config_payload: executorConfigPayload,
      agent_id: row.agentId || null,
    });
  }

  console.log(`[snapshot] Returning ${tools.length} mcp tools for collector reseed`);
  return res.json({ ok: true, count: tools.length, tools });
});

// ─── Plugin backend gateway reseed ────────────────────────────────────────────

/**
 * GET /api/internal/plugins/backends
 *
 * Returns the DISTINCT set of installed plugins that declare a manifest.backend,
 * so the collector can reseed its in-memory plugin-gateway registrations on boot.
 * Plugin backends are one-container-per-plugin (global, not org-scoped), so we
 * dedupe by plugin_id. Same source-of-truth rationale as the tool snapshot: the
 * collector's PLUGIN_BACKENDS map is a cache wiped on every restart; without a
 * reseed, plugin API calls 404 ('backend not registered') until a user happens
 * to re-activate the plugin.
 *
 * Response: { ok: true, count: N, backends: [{ pluginId, image, port, healthPath }] }
 */
router.get('/plugins/backends', (req, res) => {
  const db = req.db || getDb();
  let rows;
  try {
    rows = db.prepare(`SELECT plugin_id, manifest_json FROM plugin_installs WHERE is_enabled = 1`).all();
  } catch (err) {
    // plugin_installs absent on a minimal schema — nothing to reseed.
    return res.json({ ok: true, count: 0, backends: [] });
  }
  const seen = new Set();
  const backends = [];
  for (const r of rows) {
    if (seen.has(r.plugin_id)) continue;
    let manifest;
    try { manifest = JSON.parse(r.manifest_json); } catch { continue; }
    const b = manifest && manifest.backend;
    if (!b || !b.image) continue;
    seen.add(r.plugin_id);
    backends.push({
      pluginId: r.plugin_id,
      image: b.image,
      port: b.port ?? null,
      healthPath: b.healthPath || '/health',
    });
  }
  console.log(`[plugins/backends] Returning ${backends.length} plugin backend(s) for collector reseed`);
  return res.json({ ok: true, count: backends.length, backends });
});

// ─── LIFECYCLE-P1-D1: Drift-recovery callback ─────────────────────────────────

/**
 * POST /api/internal/powers/available-tools/:toolDefId
 *
 * Collector calls this after a successful re-probe of a mcp_hosted tool's
 * tools/list endpoint. Auth merges the fresh tool list into
 * tool_installations.config_json.available_tools:
 *   - New tools: appended with no deprecation marker
 *   - Removed tools: marked with deprecated_at timestamp
 *   - Re-appeared (was deprecated, now back): deprecated_at cleared
 *   - Byte-identical list (sha256 dedup): no-op
 *
 * Body: { tools: [{name, description, inputSchema}, ...] }
 * Response: { ok: true, added: N, deprecated: M, total: T } | { ok: true, no_change: true }
 *
 * Auth: INTERNAL_SERVICE_KEY via X-Service-Key header.
 */
router.post('/powers/available-tools/:toolDefId', (req, res) => {
  const { toolDefId } = req.params;
  const { tools } = req.body || {};

  if (!toolDefId) {
    return res.status(400).json({ error: 'missing_tool_def_id' });
  }

  if (!Array.isArray(tools)) {
    return res.status(400).json({ error: 'invalid_body', message: 'tools must be an array' });
  }

  const db = req.db || getDb();

  console.log(
    '[LIFECYCLE-P1-D1] POST available-tools tool_def_id=%s tools_count=%d',
    toolDefId, tools.length
  );

  const result = applyAvailableToolsDrift(db, toolDefId, tools);

  if (!result.ok) {
    if (result.status === 404) {
      return res.status(404).json({ error: 'installation_not_found', tool_def_id: toolDefId });
    }
    return res.status(500).json({ error: result.error || 'drift_apply_failed' });
  }

  if (result.no_change) {
    console.log('[LIFECYCLE-P1-D1] no_change tool_def_id=%s (sha256 dedup)', toolDefId);
    return res.json({ ok: true, no_change: true });
  }

  console.log(
    '[LIFECYCLE-P1-D1] drift applied tool_def_id=%s added=%d deprecated=%d reappeared=%d total=%d',
    toolDefId, result.added, result.deprecated, result.reappeared, result.total
  );

  return res.json({
    ok: true,
    added: result.added,
    deprecated: result.deprecated,
    unchanged_count: result.unchanged_count,
    reappeared: result.reappeared,
    total: result.total,
  });
});

export default router;

import { Router } from 'express';
import { createHash } from 'crypto';
import { getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { Capabilities } from '../utils/policy.js';
import { hasCapability } from '../utils/policy.js';
import { ulid } from '../utils/helpers.js';
import { encryptLegacy } from '../utils/encryption.js';
import { probeMcpUrl } from '../lib/mcpProbe.js';
import { assertSafeEgressUrl } from '../lib/egressGuard.js';
import { assertJsonResponse, CrossServiceError } from '../lib/crossServiceFetch.js';
import { detectTransport } from '../lib/repoTransportDetector.js';
import {
  bulkPutPowersCredentials,
  putMcpEndpointAuth,
  listPowersCredentials,
  deletePowersCredentialsForTool,
  deleteMcpEndpointAuth,
} from '../lib/powersCredentialAdapter.js';
// LIFECYCLE-P2-D1: Already-installed detection
import { detectExistingRepoDeploy } from '../lib/powersAlreadyInstalled.js';
// LIFECYCLE-P3-D1: WARD witnessing for POWERS audit events
import { witnessAuthAudit } from '../lib/wardAdapter.js';
// LIFECYCLE-P3-D3: AOCL L0-L5 emissions for POWERS routes
import { emitPowersRouteL0toL5 } from '../lib/aoclAdapter.js';
// LIFECYCLE-P3-D4: Durable retry queue for failed audit events
import { queuePendingAuditEvent } from '../jobs/audit-event-reaper.js';

// LIFECYCLE-P3-D2: Fire-and-forget VOLT event emission via collector internal endpoint.
// Auth does not own the VOLT DB — collector does. We use Option B: POST to
// /api/internal/volt/emit on collector, which routes through the existing voltEmitter.
// The correlation ID (corr) is the toolDefId — unique per deploy.
function _emitVoltDeployEvent(eventType, toolDefId, orgId, extra = {}) {
  const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  const payload = {
    corr: toolDefId,
    event_type: eventType,
    context: { org_id: orgId },
    payload: { tool_def_id: toolDefId, org_id: orgId, ...extra },
  };
  // Fire-and-forget — never block the deploy route
  fetch(`${collectorUrl}/api/internal/volt/emit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  }).catch(err => {
    console.warn('[LIFECYCLE-P3-D2] VOLT emit %s failed (non-fatal): %s', eventType, err.message);
  });
}

const GITHUB_REPO_RE = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/;

const router = Router();

// Short-circuits if req.user already populated (test injection).
function requireUserAuth(req, res, next) {
  if (req.user) return next();
  return requireAuth(req, res, next);
}

router.use(requireUserAuth);

function dbFor(req) { return req.db || getDb(); }

function sanitiseToolName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'powers_tool';
}

function writeAuditEvent(db, { orgId, actorId, action, targetType, targetId, metadata }) {
  let auditRecord = null;
  try {
    const id = ulid();
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, orgId, 'user', actorId, action,
      targetType || null, targetId || null,
      'success',
      JSON.stringify(metadata || {}),
      createdAt
    );
    auditRecord = { id, org_id: orgId, actor_type: 'user', actor_id: actorId, action,
      target_type: targetType || null, target_id: targetId || null, status: 'success', created_at: createdAt };
  } catch (_) {
    // Audit failure is non-fatal
  }

  // LIFECYCLE-P3-D1: WARD witness (fire-and-forget). Only witness if the DB write succeeded.
  if (auditRecord) {
    witnessAuthAudit(auditRecord, orgId).catch(() => {
      // witnessAuthAudit already swallows errors internally; this is a final safety net
    });
  }
}

function checkMembership(db, orgId, userId) {
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  if (!org || org.deleted_at) return { ok: false, status: 404, error: 'org_not_found' };

  const membership = db.prepare(
    'SELECT * FROM org_memberships WHERE org_id = ? AND user_id = ? AND status = ?'
  ).get(orgId, userId, 'active');
  if (!membership) return { ok: false, status: 403, error: 'not_org_member' };

  return { ok: true, org, membership };
}

function resolveCapFromMembership(db, user, membership, org, capability) {
  return hasCapability(
    {
      type: 'user',
      id: user?.id,
      orgRole: membership?.role,
      customRoleId: membership?.custom_role_id || null,
    },
    capability,
    { db, orgId: org?.id }
  );
}

// ─── INTROSPECT-P1: Background tools/list probe for mcp_hosted ───────────────

/**
 * After a mcp_hosted finalize succeeds, fire-and-forget this to fetch
 * available_tools from the process supervisor and persist them into
 * tool_installations.config_json.
 *
 * Non-fatal: does NOT affect the 201 response. Failures are logged and silently
 * swallowed — the 201 already confirmed the deploy.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolDefId - tool_definitions.id (ULID) — also powers_hosted.tool_id (the URL slug)
 * @param {string} toolInstId - tool_installations.id (ULID)
 *
 * INTROSPECT-P3-fix: the 4th param (canonical toolId slug) was dropped. powers-host
 * indexes by tool_definitions.id (= toolDefId), not by the canonical string. Using
 * the canonical slug caused a 404 on every probe. Now uses toolDefId for the URL.
 */
async function _scheduleHostedToolsSync(db, toolDefId, toolInstId) {
  const powersHostUrl = process.env.POWERS_HOST_URL || 'http://powers-host:9849';
  // INTROSPECT-P3-fix: URL slug = tool_definitions.id (= powers_hosted.tool_id)
  const url = `${powersHostUrl}/internal/mcp-hosted/${encodeURIComponent(toolDefId)}/tools`;

  console.log('[INTROSPECT-P1] Background tools/list probe starting tool_def_id=%s url=%s', toolDefId, url);

  // Delay to allow the process to cold-start on first invoke.
  // Default 2s. Override via POWERS_TOOLS_PROBE_DELAY_MS (e.g. set to 0 in tests).
  const probeDelay = parseInt(process.env.POWERS_TOOLS_PROBE_DELAY_MS || '2000', 10);
  if (probeDelay > 0) await new Promise(r => setTimeout(r, probeDelay));

  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (err) {
    // 404 is expected if the process hasn't been invoked yet — log and skip
    console.warn('[INTROSPECT-P1] tools/list probe FETCH ERROR tool_def_id=%s: %s', toolDefId, err.message);
    return;
  }

  if (!resp.ok) {
    let bodyExcerpt = '';
    try { bodyExcerpt = (await resp.text()).slice(0, 300); } catch (_) {}
    console.warn(
      '[INTROSPECT-P1] tools/list probe NON-2XX tool_def_id=%s status=%d body=%s',
      toolDefId, resp.status, bodyExcerpt
    );
    return;
  }

  let data;
  try { data = await resp.json(); } catch (err) {
    console.warn('[INTROSPECT-P1] tools/list probe invalid JSON tool_def_id=%s: %s', toolDefId, err.message);
    return;
  }

  const tools = data?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    console.log('[INTROSPECT-P1] tools/list probe returned no tools tool_def_id=%s', toolDefId);
    return;
  }

  // Merge available_tools into tool_installations.config_json
  try {
    const row = db.prepare('SELECT config_json FROM tool_installations WHERE id = ?').get(toolInstId);
    if (!row) {
      console.warn('[INTROSPECT-P1] tool_installations row not found id=%s tool_def_id=%s', toolInstId, toolDefId);
      return;
    }
    let config = {};
    try { config = JSON.parse(row.config_json || '{}'); } catch (_) {}
    config.available_tools = tools;
    db.prepare('UPDATE tool_installations SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(config), new Date().toISOString(), toolInstId);
    console.log('[INTROSPECT-P1] available_tools persisted tool_def_id=%s count=%d', toolDefId, tools.length);
  } catch (err) {
    console.error('[INTROSPECT-P1] DB update failed tool_def_id=%s: %s', toolDefId, err.message);
  }
}

// POST /api/orgs/:orgId/powers/detect
router.post('/orgs/:orgId/powers/detect', async (req, res) => {
  const { orgId } = req.params;
  const { url, authKind = 'none', authValue } = req.body || {};
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) {
    return res.status(mem.status).json({ error: mem.error });
  }

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  if (!url) {
    return res.status(400).json({ error: 'invalid_body', message: 'url is required' });
  }
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'invalid_url', message: 'url must be a valid URL' });
  }
  // #49 S1: block SSRF to internal/metadata addresses before ANY server-side
  // fetch (transport detection below + the MCP probe).
  try {
    await assertSafeEgressUrl(url);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.code || 'blocked_egress', message: e.message });
  }
  if ((authKind === 'bearer' || authKind === 'header') && !authValue) {
    return res.status(400).json({ error: 'invalid_body', message: 'authValue is required when authKind is bearer or header' });
  }

  // POWERS-TEMPLATES-HARDEN Fix 3: detect HTTP transport BEFORE the user
  // commits to a deploy. Only runs for GitHub URLs (non-blocking on failure).
  let transportHint = null;
  if (GITHUB_REPO_RE.test(url)) {
    try {
      const td = await detectTransport(url);
      if (td.transport === 'http' && (td.confidence === 'high' || td.confidence === 'medium')) {
        transportHint = {
          transport_hint: 'http',
          recommendation: td.recommendation ||
            'Use mcp_endpoint deploy flow — this MCP server uses HTTP transport, not stdio. ' +
            'mcp_hosted only supports stdio MCPs.',
          signals: td.signals,
        };
      }
    } catch (err) {
      // Non-fatal — transport detection failure must not block detect response
      console.warn('[powers/detect] transport detection error (non-fatal): %s', err.message);
    }
  }

  const probe = await probeMcpUrl(url, { authKind, authValue });

  if (!probe.ok) {
    return res.status(200).json({
      type: 'unknown',
      error: probe.error,
      ...(transportHint || {}),
    });
  }

  return res.status(200).json({
    type: 'mcp_endpoint',
    probe_result: {
      serverInfo: probe.serverInfo,
      tools: (probe.tools || []).map(t => ({ name: t.name, description: t.description })),
    },
    ...(transportHint || {}),
  });
});

// POST /api/orgs/:orgId/powers/deploy
router.post('/orgs/:orgId/powers/deploy', async (req, res) => {
  const { orgId } = req.params;
  const { url, authKind = 'none', authValue, persona } = req.body || {};
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) {
    return res.status(mem.status).json({ error: mem.error });
  }

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  if (!url) {
    return res.status(400).json({ error: 'invalid_body', message: 'url is required' });
  }
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'invalid_url', message: 'url must be a valid URL' });
  }
  // #49 S1: block SSRF to internal/metadata addresses before the probe.
  try {
    await assertSafeEgressUrl(url);
  } catch (e) {
    return res.status(e.statusCode || 400).json({ error: e.code || 'blocked_egress', message: e.message });
  }

  if (!['none', 'bearer', 'header'].includes(authKind)) {
    return res.status(400).json({ error: 'invalid_body', message: 'authKind must be none, bearer, or header' });
  }

  if (!persona || !persona.agent_id || !persona.name) {
    return res.status(400).json({ error: 'invalid_body', message: 'persona.agent_id and persona.name are required' });
  }
  if (!/^[a-z][a-z0-9_]*$/.test(persona.agent_id)) {
    return res.status(400).json({
      error: 'invalid_agent_id',
      message: 'persona.agent_id must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
    });
  }
  if (typeof persona.name !== 'string' || persona.name.trim() === '') {
    return res.status(400).json({ error: 'invalid_body', message: 'persona.name must be a non-empty string' });
  }

  // Probe before deploy
  const probe = await probeMcpUrl(url, { authKind, authValue, timeoutMs: 5000 });
  if (!probe.ok) {
    return res.status(400).json({ error: 'probe_failed', message: probe.error });
  }

  // Derive identity
  const orgSlug = createHash('sha256').update(orgId).digest('hex').slice(0, 8);
  const toolSlug = sanitiseToolName(probe.serverInfo?.name || persona.agent_id);
  const toolId = `powers.mcp.${orgSlug}.${toolSlug}`;

  // Check uniqueness
  const existingAgent = db.prepare(
    "SELECT id FROM agents WHERE org_id = ? AND agent_id = ? AND status != 'retired'"
  ).get(orgId, persona.agent_id);
  if (existingAgent) {
    return res.status(409).json({ error: 'duplicate_agent_id', message: `An agent with id "${persona.agent_id}" already exists in this org` });
  }

  const existingTool = db.prepare('SELECT id FROM tool_definitions WHERE tool_id = ?').get(toolId);
  if (existingTool) {
    return res.status(409).json({ error: 'duplicate_tool_id', message: `A tool with id "${toolId}" already exists` });
  }

  const now = new Date().toISOString();
  const toolDefId = ulid();
  const toolInstId = ulid();
  const agentUlid = ulid();
  const assignmentId = ulid();

  const specJson = JSON.stringify({
    source: 'powers',
    executor_type: 'mcp_endpoint',
    author_user_id: userId,
    provenance: {
      url,
      server_name: probe.serverInfo?.name,
      server_version: probe.serverInfo?.version,
    },
    tool_names: probe.tools.map(t => t.name),
  });

  const description = probe.serverInfo?.name
    ? `${probe.serverInfo.name} (MCP server)`
    : `${probe.tools.length} MCP tools`;

  // Phase 1: commit tool_definitions + tool_installations only.
  // Agent rows are NOT written yet — they are only valid once the collector
  // has confirmed the tool is registered (sync-before-commit per
  // feedback_sync_before_local_commit.md). If collector sync fails, these
  // rows stay disabled and no orphan agent row is created.
  //
  // A.2 (POWERS-VAULT-MIGRATION): mcp_endpoint auth is now stored in Vault
  // (integration_credentials) via putMcpEndpointAuth(). The config_json stores
  // the credential ID reference. The encrypted value is also carried in
  // mcp_auth_value_encrypted for backward-compatibility with the collector's
  // current reader (agentTools.js) during the transition window.
  let mcpAuthCredentialId = null;
  let mcpAuthValueEncrypted = null;
  db.transaction(() => {
    // Store auth in Vault (same DB transaction — direct SQL, no HTTP)
    const vaultEntry = putMcpEndpointAuth(db, { orgId, toolDefId, authValue, authKind, userId });
    if (vaultEntry) {
      mcpAuthCredentialId = vaultEntry.id;
      // FIX 1 (VAULT P1 cross-service): the collector's agentTools.js reads this
      // config_json copy via collector/lib/encryption.js, which ONLY understands
      // the legacy 3-part iv:authTag:ciphertext format (no v2 reader) and hard-
      // throws on parts.length !== 3. The collector shares MASTER_ENCRYPTION_KEY
      // but has NO access to the vault salt, so it cannot derive the KEK to read a
      // v2 envelope. Therefore this transition-window copy MUST be written in the
      // legacy format the collector understands — NOT the vault v2 ciphertext.
      // (The canonical mcp_auth_credential_id → vault v2 row above is unchanged.)
      mcpAuthValueEncrypted = encryptLegacy(authValue);
    }

    db.prepare(`
      INSERT INTO tool_definitions (
        id, tool_id, name, description, category,
        provider, version,
        spec_json, source_url,
        status, is_core, is_featured,
        requires_config, requires_license,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolDefId, toolId, toolSlug, description, 'mcp',
      'powers', '0.1.0',
      specJson, null,
      'coming_soon', 0, 0,
      0, 0,
      now, now
    );

    db.prepare(`
      INSERT INTO tool_installations (
        id, org_id, tool_definition_id,
        config_json,
        enabled, installed_by, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolInstId, orgId, toolDefId,
      JSON.stringify({
        mcp_url: url,
        mcp_auth_kind: authKind,
        // Vault reference (new canonical path):
        mcp_auth_credential_id: mcpAuthCredentialId,
        // Backward-compat for collector's agentTools.js reader (transition window):
        mcp_auth_value_encrypted: mcpAuthValueEncrypted,
      }),
      1, userId, now, now
    );
  })();

  // Short-circuit for test environments — skip real collector sync
  if (process.env.POWERS_SKIP_COLLECTOR_SYNC === 'true') {
    db.prepare("UPDATE tool_definitions SET status = 'beta' WHERE tool_id = ?").run(toolId);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO agents (
          id, org_id, agent_id, name, description, icon,
          level, parent_agent_id, manager_assistant_id, home_scope_id,
          config_json, system_prompt_additions,
          domains_json, capabilities_json,
          status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        agentUlid, orgId, persona.agent_id, persona.name,
        persona.description || null, persona.icon || null,
        2, null, null, null,
        '{}', persona.system_prompt_additions || null,
        '[]', JSON.stringify(['mcp_invoke']),
        'active', userId, now, now
      );
      db.prepare(`
        INSERT INTO agent_tool_assignments (
          id, org_id, tool_installation_id, agent_id,
          scope_id, access_mode, max_daily_invocations, allowed_operations_json,
          assigned_by, assigned_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assignmentId, orgId, toolInstId, persona.agent_id,
        null, 'full', null, null,
        userId, now, now
      );
    })();
    writeAuditEvent(db, {
      orgId,
      actorId: userId,
      action: 'directory.power.deploy',
      targetType: 'agent',
      targetId: agentUlid,
      metadata: {
        agent_id: persona.agent_id,
        agent_name: persona.name,
        tool_id: toolId,
        tool_name: toolSlug,
        mcp_url: url,
        server_name: probe.serverInfo?.name,
        tool_count: probe.tools.length,
        aocl_layers: ['L6_POLICY', 'L7_SEMANTIC', 'L8_DECISION', 'L9_EXECUTION'],
      },
    });
    return res.status(201).json({
      ok: true,
      tool_id: toolId,
      agent_id: persona.agent_id,
      agent_ulid: agentUlid,
      scope: `org:${orgId}`,
    });
  }

  // Phase 2: collector sync BEFORE local agent rows are committed.
  // Per feedback_sync_before_local_commit.md: the collector having the tool
  // registered is a PRECONDITION for the agent row being valid. If sync fails,
  // tool_definitions stays 'coming_soon' (disabled effectively) and no agent
  // row is written — retry is safe because no orphan rows exist.
  const collectorUrl = process.env.COLLECTOR_URL
    || process.env.QUOX_COLLECTOR_URL
    || 'http://collector:9848';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';

  try {
    await assertJsonResponse(
      'auth→collector mcp_endpoint install',
      `${collectorUrl}/api/internal/tool-definitions/install`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
        },
        body: JSON.stringify({
          toolId,
          orgId,
          toolName: toolSlug,
          source: 'powers',
          edition: 'experimental',
          executor_type: 'mcp_endpoint',
          executor_config_payload: {
            mcp_url: url,
            mcp_auth_kind: authKind,
            // Vault reference (new canonical path):
            mcp_auth_credential_id: mcpAuthCredentialId,
            // Backward-compat for collector's agentTools.js reader (transition window):
            mcp_auth_value_encrypted: mcpAuthValueEncrypted,
            tool_name: probe.tools[0]?.name || toolSlug,
            // INTROSPECT-P1: store full tool objects (name + description + inputSchema)
            // for LLM unfold in P2. Legacy: name+description was the original shape.
            available_tools: probe.tools.map(t => ({
              name: t.name,
              description: t.description,
              ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
            })),
            // POWERS-P2.C-fix-4b: agent_id INSIDE executor_config so collector's
            // hasAgent() can find it via json_extract. Top-level agent_id at
            // line 338 is consumed by collector for cache invalidation only.
            agent_id: persona.agent_id,
          },
          agent_id: persona.agent_id,
        }),
        signal: AbortSignal.timeout(5000),
      },
      { tool_id: toolId, org_id: orgId, agent_id: persona.agent_id }
    );
  } catch (err) {
    // #49 S2: the Phase-1 tool_definitions + tool_installations + vault
    // credential were committed BEFORE this sync. Merely marking the tool
    // disabled leaves those rows behind, so the existingTool guard above
    // returns 409 duplicate_tool_id on EVERY retry — with no recovery path
    // (the 503 didn't even surface toolDefId for a manual DELETE). Roll the
    // Phase-1 rows back (compensating transaction, the inverse of Phase 1) so
    // a retry is genuinely clean.
    console.error(
      '[POWERS] COLLECTOR SYNC FAILED for tool_id=%s org=%s agent_id=%s: %s — rolling back phase-1 rows',
      toolId, orgId, persona.agent_id, err.message
    );
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM tool_installations WHERE id = ?').run(toolInstId);
        db.prepare('DELETE FROM tool_definitions WHERE id = ?').run(toolDefId);
        deleteMcpEndpointAuth(db, orgId, toolDefId);
      })();
    } catch (rbErr) {
      // Rollback itself failed — mark the tool disabled so it is at least inert,
      // and surface tool_def_id so the caller can DELETE it and retry.
      console.error('[POWERS] compensating rollback FAILED for tool_id=%s: %s', toolId, rbErr.message);
      try {
        db.prepare("UPDATE tool_definitions SET status = 'disabled' WHERE tool_id = ?").run(toolId);
      } catch (_) { /* best-effort */ }
      return res.status(503).json({
        error: 'collector_sync_failed',
        message: 'Power could not be registered with the chat runtime, and automatic cleanup failed. Delete the tool (tool_def_id below) and retry, or contact support.',
        tool_id: toolId,
        tool_def_id: toolDefId,
        agent_id: persona.agent_id,
      });
    }
    return res.status(503).json({
      error: 'collector_sync_failed',
      message: 'Power could not be registered with the chat runtime. Please retry.',
      tool_id: toolId,
      agent_id: persona.agent_id,
    });
  }

  // Phase 3: sync confirmed — now commit agent rows. These are guaranteed to be
  // consistent with the collector's store at this point.
  db.transaction(() => {
    db.prepare("UPDATE tool_definitions SET status = 'beta' WHERE tool_id = ?").run(toolId);

    db.prepare(`
      INSERT INTO agents (
        id, org_id, agent_id, name, description, icon,
        level, parent_agent_id, manager_assistant_id, home_scope_id,
        config_json, system_prompt_additions,
        domains_json, capabilities_json,
        status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentUlid, orgId, persona.agent_id, persona.name,
      persona.description || null, persona.icon || null,
      2, null, null, null,
      '{}', persona.system_prompt_additions || null,
      '[]', JSON.stringify(['mcp_invoke']),
      'active', userId, now, now
    );

    db.prepare(`
      INSERT INTO agent_tool_assignments (
        id, org_id, tool_installation_id, agent_id,
        scope_id, access_mode, max_daily_invocations, allowed_operations_json,
        assigned_by, assigned_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId, orgId, toolInstId, persona.agent_id,
      null, 'full', null, null,
      userId, now, now
    );
  })();

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy',
    targetType: 'agent',
    targetId: agentUlid,
    metadata: {
      agent_id: persona.agent_id,
      agent_name: persona.name,
      tool_id: toolId,
      tool_name: toolSlug,
      mcp_url: url,
      server_name: probe.serverInfo?.name,
      tool_count: probe.tools.length,
      aocl_layers: ['L6_POLICY', 'L7_SEMANTIC', 'L8_DECISION', 'L9_EXECUTION'],
    },
  });

  return res.status(201).json({
    ok: true,
    tool_id: toolId,
    agent_id: persona.agent_id,
    agent_ulid: agentUlid,
    scope: `org:${orgId}`,
  });
});

// ─── REPO-DEPLOY ROUTES (mcp_hosted, P2.C) ───────────────────────────────────

// POST /api/orgs/:orgId/powers/deploy/repo
// Phase A: validate → insert rows → call powers-host build → return 202
router.post('/orgs/:orgId/powers/deploy/repo', async (req, res) => {
  const { orgId } = req.params;
  const { repo_url, env_vars = [], persona } = req.body || {};
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  // LIFECYCLE-P3-D2: emit power.deploy.requested (correlation ID assigned after toolDefId is minted — deferred below)

  if (!repo_url) {
    return res.status(400).json({ error: 'invalid_body', message: 'repo_url is required' });
  }

  if (!GITHUB_REPO_RE.test(repo_url)) {
    return res.status(400).json({
      error: 'invalid_repo_url',
      message: 'repo_url must be a public GitHub URL: https://github.com/owner/repo',
    });
  }

  // Validate env_vars shape
  if (!Array.isArray(env_vars)) {
    return res.status(400).json({ error: 'invalid_body', message: 'env_vars must be an array' });
  }
  for (const ev of env_vars) {
    if (!ev.key || typeof ev.key !== 'string' || ev.key.trim() === '') {
      return res.status(400).json({ error: 'invalid_body', message: 'each env_var must have a non-empty key' });
    }
    if (typeof ev.value !== 'string') {
      return res.status(400).json({ error: 'invalid_body', message: 'each env_var value must be a string' });
    }
  }

  // LIFECYCLE-P2-D1: Already-installed detection
  // Check before minting a new toolDefId — if the same repo_url is already
  // deployed to this org, return 409 unless the caller supplies force_suffix.
  const { force_suffix } = req.body || {};
  if (!force_suffix) {
    const existing = detectExistingRepoDeploy(db, orgId, repo_url);
    if (existing) {
      writeAuditEvent(db, {
        orgId,
        actorId: userId,
        action: 'directory.power.deploy_repo.duplicate_detected',
        targetType: 'tool_definition',
        targetId: existing.tool_def_id,
        metadata: { repo_url, existing_tool_def_id: existing.tool_def_id, existing_agent_id: existing.agent_id },
      });
      return res.status(409).json({
        error: 'already_installed',
        message: `This repo is already deployed to your org as agent ${existing.agent_id || existing.tool_id}`,
        existing: {
          tool_def_id: existing.tool_def_id,
          tool_id: existing.tool_id,
          agent_id: existing.agent_id,
          deployed_at: existing.deployed_at,
          current_version: existing.current_version,
          status: existing.status,
        },
        actions: ['update', 'duplicate_with_suffix'],
      });
    }
  }

  // Derive identity
  const orgSlug = createHash('sha256').update(orgId).digest('hex').slice(0, 8);
  const match = GITHUB_REPO_RE.exec(repo_url);
  const repoOwner = match[1];
  const repoName = match[2];
  // LIFECYCLE-P2-D1: append force_suffix to slug when duplicating
  const baseName = `${repoOwner}_${repoName}`;
  const suffixedName = force_suffix ? `${baseName}_${force_suffix}` : baseName;
  const toolSlug = sanitiseToolName(suffixedName);
  const toolId = `powers.mcp.${orgSlug}.${toolSlug}`;
  const toolDefId = ulid();

  // Uniqueness checks — use persona if provided for agent_id, else derive
  const agentIdCandidate = (persona && persona.agent_id) ? persona.agent_id : null;
  if (agentIdCandidate) {
    if (!/^[a-z][a-z0-9_]*$/.test(agentIdCandidate)) {
      return res.status(400).json({
        error: 'invalid_agent_id',
        message: 'persona.agent_id must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
      });
    }
    const existingAgent = db.prepare(
      "SELECT id FROM agents WHERE org_id = ? AND agent_id = ? AND status != 'retired'"
    ).get(orgId, agentIdCandidate);
    if (existingAgent) {
      return res.status(409).json({ error: 'duplicate_agent_id', message: `An agent with id "${agentIdCandidate}" already exists in this org` });
    }
  }

  const existingTool = db.prepare('SELECT id FROM tool_definitions WHERE tool_id = ?').get(toolId);
  if (existingTool) {
    return res.status(409).json({ error: 'duplicate_tool_id', message: `A tool with id "${toolId}" already exists` });
  }

  const now = new Date().toISOString();
  const toolInstId = ulid();

  const specJson = JSON.stringify({
    source: 'powers',
    executor_type: 'mcp_hosted',
    author_user_id: userId,
    provenance: { repo_url, repo_owner: repoOwner, repo_name: repoName },
  });

  const description = `${repoOwner}/${repoName} (hosted MCP)`;

  // Single transaction: tool_definitions + tool_installations + Vault credentials
  // A.2 (POWERS-VAULT-MIGRATION): env vars now stored in integration_credentials via
  // bulkPutPowersCredentials() instead of the deprecated powers_credentials table.
  // Both writes use the same better-sqlite3 DB instance so they share the transaction.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO tool_definitions (
        id, tool_id, name, description, category,
        provider, version,
        spec_json, source_url,
        status, is_core, is_featured,
        requires_config, requires_license,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolDefId, toolId, toolSlug, description, 'mcp',
      'powers', '0.1.0',
      specJson, repo_url,
      'beta', 0, 0,
      0, 0,
      now, now
    );

    db.prepare(`
      INSERT INTO tool_installations (
        id, org_id, tool_definition_id,
        config_json,
        enabled, installed_by, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toolInstId, orgId, toolDefId,
      JSON.stringify({ executor_type: 'mcp_hosted', repo_url }),
      1, userId, now, now
    );

    // Store env vars in Vault (integration_credentials), NOT in powers_credentials.
    // The powers_credentials table is now deprecated and no longer written to.
    if (env_vars.length > 0) {
      bulkPutPowersCredentials(db, {
        orgId,
        toolDefId,
        envVars: env_vars.map(ev => ({ key: ev.key.trim(), value: ev.value })),
        userId,
      });
    }
  })();

  // Call powers-host to kick off the build
  // POWERS-P2.C-fix-3 Item 3: use assertJsonResponse (per feedback_silent_success_cross_service.md)
  // to guarantee pre-log + network error + non-2xx check with body excerpt.
  const powersHostUrl = process.env.POWERS_HOST_URL || 'http://powers-host:9849';

  if (process.env.POWERS_SKIP_BUILD_KICKOFF !== 'true') {
    try {
      await assertJsonResponse(
        'auth→powers-host build kickoff',
        `${powersHostUrl}/internal/powers/build`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo_url, tool_id: toolDefId, org_id: orgId }),
          signal: AbortSignal.timeout(8000),
        },
        { tool_def_id: toolDefId, repo_url }
      );
    } catch (err) {
      // Roll back: mark tool as disabled so it won't be used but leaves audit trail
      try {
        db.prepare("UPDATE tool_definitions SET status = 'disabled' WHERE id = ?").run(toolDefId);
      } catch (_) { /* non-fatal */ }
      console.error('[POWERS] Build kickoff failed for tool_def_id=%s: %s', toolDefId, err.message);
      return res.status(503).json({
        error: 'build_kickoff_failed',
        message: 'Could not start the build process. Please retry.',
        detail: err.message,
      });
    }
  }

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy_repo.initiated',
    targetType: 'tool_definition',
    targetId: toolDefId,
    metadata: { repo_url, tool_id: toolId, env_var_count: env_vars.length },
  });

  // LIFECYCLE-P3-D2: VOLT events (fire-and-forget via collector internal endpoint)
  // power.deploy.requested — start of deploy lifecycle
  _emitVoltDeployEvent('power.deploy.requested', toolDefId, orgId, { repo_url, tool_id: toolId });
  // power.deploy.build_started — if we got here, the kickoff POST succeeded
  _emitVoltDeployEvent('power.deploy.build_started', toolDefId, orgId, { repo_url });

  // LIFECYCLE-P3-D3: AOCL L0-L5 (fire-and-forget)
  emitPowersRouteL0toL5({
    corr: toolDefId,
    actorId: userId,
    orgId,
    route: 'deploy_repo',
    fields: { repo_url, env_var_count: env_vars.length },
  });

  return res.status(202).json({
    ok: true,
    tool_def_id: toolDefId,
    tool_id: toolId,
    build_state: 'pending',
  });
});

// GET /api/orgs/:orgId/powers/deploy/repo/:toolDefId/status
// Proxies powers-host build status + logs; enforces org membership
router.get('/orgs/:orgId/powers/deploy/repo/:toolDefId/status', async (req, res) => {
  const { orgId, toolDefId } = req.params;
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  // H3: build logs may contain env var names + install paths — restrict to AGENTS_MANAGE
  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  // Verify tool belongs to this org
  const toolDef = db.prepare('SELECT id, tool_id FROM tool_definitions WHERE id = ?').get(toolDefId);
  if (!toolDef) return res.status(404).json({ error: 'tool_not_found' });

  const inst = db.prepare('SELECT id FROM tool_installations WHERE tool_definition_id = ? AND org_id = ?').get(toolDefId, orgId);
  if (!inst) return res.status(403).json({ error: 'tool_not_in_org' });

  const powersHostUrl = process.env.POWERS_HOST_URL || 'http://powers-host:9849';

  // Stub mode for tests
  if (process.env.POWERS_SKIP_BUILD_KICKOFF === 'true') {
    // Return a mock pending status from the powers_hosted table if it exists
    const hasPowersHosted = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='powers_hosted'").get();
    if (hasPowersHosted) {
      const hosted = db.prepare('SELECT * FROM powers_hosted WHERE tool_id = ?').get(toolDefId);
      if (hosted) {
        return res.json({
          build_state: hosted.build_state,
          language: hosted.language,
          dockerfile_source: hosted.dockerfile_source,
          image_tag: hosted.image_tag,
          build_failed_reason: hosted.build_failed_reason,
          logs: [],
        });
      }
    }
    return res.json({ build_state: 'pending', logs: [] });
  }

  try {
    const statusResp = await fetch(
      `${powersHostUrl}/internal/powers/build/${toolDefId}/status`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!statusResp.ok) {
      return res.status(statusResp.status).json({ error: 'powers_host_error', message: `Build status fetch failed: HTTP ${statusResp.status}` });
    }
    const data = await statusResp.json();
    return res.json(data);
  } catch (err) {
    return res.status(503).json({ error: 'powers_host_unreachable', message: err.message });
  }
});

// POST /api/orgs/:orgId/powers/deploy/repo/:toolDefId/finalize
// Phase B: build is done → insert agents + agent_tool_assignments → return deployed result
router.post('/orgs/:orgId/powers/deploy/repo/:toolDefId/finalize', async (req, res) => {
  const { orgId, toolDefId } = req.params;
  const { persona } = req.body || {};
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  if (!persona || !persona.agent_id || !persona.name) {
    return res.status(400).json({ error: 'invalid_body', message: 'persona.agent_id and persona.name are required' });
  }
  if (!/^[a-z][a-z0-9_]*$/.test(persona.agent_id)) {
    return res.status(400).json({
      error: 'invalid_agent_id',
      message: 'persona.agent_id must start with a lowercase letter and contain only lowercase letters, numbers, and underscores',
    });
  }

  // Verify tool_definition belongs to this org
  const toolDef = db.prepare('SELECT * FROM tool_definitions WHERE id = ?').get(toolDefId);
  if (!toolDef) return res.status(404).json({ error: 'tool_not_found' });

  const toolInst = db.prepare('SELECT * FROM tool_installations WHERE tool_definition_id = ? AND org_id = ?').get(toolDefId, orgId);
  if (!toolInst) return res.status(403).json({ error: 'tool_not_in_org' });

  // Verify build state via powers-host (or skip in test mode)
  if (process.env.POWERS_SKIP_BUILD_KICKOFF !== 'true') {
    const powersHostUrl = process.env.POWERS_HOST_URL || 'http://powers-host:9849';
    try {
      const statusResp = await fetch(
        `${powersHostUrl}/internal/powers/build/${toolDefId}/status`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (statusResp.ok) {
        const statusData = await statusResp.json();
        if (statusData.build_state !== 'built') {
          return res.status(409).json({
            error: 'build_not_complete',
            message: `Build is in state '${statusData.build_state}', must be 'built' to finalize`,
            build_state: statusData.build_state,
          });
        }
      }
      // If powers-host unreachable, allow finalize to proceed (auth DB is source of truth)
    } catch (_) { /* allow */ }
  }

  // Check uniqueness
  const existingAgent = db.prepare(
    "SELECT id FROM agents WHERE org_id = ? AND agent_id = ? AND status != 'retired'"
  ).get(orgId, persona.agent_id);
  if (existingAgent) {
    return res.status(409).json({ error: 'duplicate_agent_id', message: `An agent with id "${persona.agent_id}" already exists in this org` });
  }

  const now = new Date().toISOString();
  const agentUlid = ulid();
  const assignmentId = ulid();

  // Collector sync BEFORE agent rows are committed.
  // Per feedback_sync_before_local_commit.md: the collector registering the
  // tool is a PRECONDITION for agent rows being valid. Committing agents first
  // then failing the sync creates an orphan agent (visible in /agents, not
  // invocable) with no clean retry path (409 duplicate_agent_id on retry).
  const specParsed = (() => { try { return JSON.parse(toolDef.spec_json || '{}'); } catch { return {}; } })();

  if (process.env.POWERS_SKIP_COLLECTOR_SYNC !== 'true') {
    const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';

    try {
      await assertJsonResponse(
        'auth→collector mcp_hosted install',
        `${collectorUrl}/api/internal/tool-definitions/install`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
          },
          body: JSON.stringify({
            toolId: toolDef.tool_id,
            orgId,
            toolName: toolDef.name,
            source: 'powers',
            edition: 'experimental',
            executor_type: 'mcp_hosted',
            executor_config_payload: {
              tool_def_id: toolDefId,
              repo_url: specParsed.provenance?.repo_url,
              // POWERS-P2.C-fix-4b: see comment on P1 path above.
              agent_id: persona.agent_id,
            },
            agent_id: persona.agent_id,
          }),
          signal: AbortSignal.timeout(5000),
        },
        { tool_id: toolDef.tool_id, tool_def_id: toolDefId, org_id: orgId, agent_id: persona.agent_id }
      );
    } catch (err) {
      // Sync failed — no agent rows written. Retry is safe (no orphan rows).
      console.error(
        '[POWERS] COLLECTOR SYNC FAILED for tool_id=%s org=%s agent_id=%s: %s',
        toolDef.tool_id, orgId, persona.agent_id, err.message
      );
      try {
        db.prepare("UPDATE tool_definitions SET status = 'disabled' WHERE id = ?").run(toolDefId);
      } catch (_) { /* non-fatal status update */ }
      return res.status(503).json({
        error: 'collector_sync_failed',
        message: 'Power could not be registered with the chat runtime. Please retry or contact support.',
        tool_id: toolDef.tool_id,
        agent_id: persona.agent_id,
      });
    }
  }

  // Sync confirmed (or skipped in test mode) — now commit agent rows.
  // These are guaranteed consistent with the collector's store.
  db.transaction(() => {
    db.prepare(`
      INSERT INTO agents (
        id, org_id, agent_id, name, description, icon,
        level, parent_agent_id, manager_assistant_id, home_scope_id,
        config_json, system_prompt_additions,
        domains_json, capabilities_json,
        status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentUlid, orgId, persona.agent_id, persona.name,
      persona.description || null, persona.icon || null,
      2, null, null, null,
      '{}', persona.system_prompt_additions || null,
      '[]', JSON.stringify(['mcp_invoke']),
      'active', userId, now, now
    );

    db.prepare(`
      INSERT INTO agent_tool_assignments (
        id, org_id, tool_installation_id, agent_id,
        scope_id, access_mode, max_daily_invocations, allowed_operations_json,
        assigned_by, assigned_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId, orgId, toolInst.id, persona.agent_id,
      null, 'full', null, null,
      userId, now, now
    );
  })();

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy_repo.finalized',
    targetType: 'agent',
    targetId: agentUlid,
    metadata: {
      agent_id: persona.agent_id,
      agent_name: persona.name,
      tool_id: toolDef.tool_id,
      tool_def_id: toolDefId,
      aocl_layers: ['L6_POLICY', 'L7_SEMANTIC', 'L8_DECISION', 'L9_EXECUTION'],
    },
  });

  // LIFECYCLE-P3-D2: VOLT power.deploy.finalized (fire-and-forget)
  _emitVoltDeployEvent('power.deploy.finalized', toolDefId, orgId, {
    agent_id: persona.agent_id,
    agent_ulid: agentUlid,
  });

  // LIFECYCLE-P3-D3: AOCL L0-L5 for finalize route (fire-and-forget)
  emitPowersRouteL0toL5({
    corr: toolDefId,
    actorId: userId,
    orgId,
    route: 'finalize',
    fields: { agent_id: persona.agent_id },
  });

  // LIFECYCLE-P1-D2: The finalize-time tools/list probe (_scheduleHostedToolsSync) has been
  // removed. It always 404'd because the mcp_hosted process hasn't been spawned yet at finalize
  // time (spawn-on-demand: first invocation triggers the spawn). The probe now runs on the
  // COLLECTOR side after the first successful invocation, when the process is guaranteed running.
  // See: services/collector/lib/agentTools.js _runFirstInvocationProbe()

  return res.status(201).json({
    ok: true,
    tool_id: toolDef.tool_id,
    tool_def_id: toolDefId,
    agent_id: persona.agent_id,
    agent_ulid: agentUlid,
    scope: `org:${orgId}`,
  });
});

// ─── LIFECYCLE-P2-D2: Versioning / update endpoint ───────────────────────────

// POST /api/orgs/:orgId/powers/deploy/repo/:toolDefId/update
// Updates powers_hosted.repo_ref and bumps tool_definitions.version.
// Kicks a fresh build via powers-host (same as original deploy kickoff).
// No rebuild of DB rows needed — just the ref + version fields.
router.post('/orgs/:orgId/powers/deploy/repo/:toolDefId/update', async (req, res) => {
  const { orgId, toolDefId } = req.params;
  const { repo_ref } = req.body || {};
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  if (!repo_ref || typeof repo_ref !== 'string' || repo_ref.trim() === '') {
    return res.status(400).json({ error: 'invalid_body', message: 'repo_ref is required (e.g. "HEAD" or a commit SHA)' });
  }

  const toolDef = db.prepare('SELECT id, tool_id, spec_json, version FROM tool_definitions WHERE id = ?').get(toolDefId);
  if (!toolDef) return res.status(404).json({ error: 'tool_not_found' });

  const inst = db.prepare('SELECT id FROM tool_installations WHERE tool_definition_id = ? AND org_id = ?').get(toolDefId, orgId);
  if (!inst) return res.status(403).json({ error: 'tool_not_in_org' });

  const oldRef = toolDef.version;
  const newVersion = repo_ref.trim();
  const now = new Date().toISOString();

  // Update tool_definitions.version to reflect the new ref
  db.prepare('UPDATE tool_definitions SET version = ?, updated_at = ? WHERE id = ?')
    .run(newVersion, now, toolDefId);

  // Update powers_hosted.repo_ref if the table exists
  const hasPowersHosted = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='powers_hosted'").get();
  if (hasPowersHosted) {
    db.prepare("UPDATE powers_hosted SET repo_ref = ? WHERE tool_id = ?").run(newVersion, toolDefId);
  }

  // Kick off a fresh build (same as original deploy kickoff), unless in test mode
  const powersHostUrl = process.env.POWERS_HOST_URL || 'http://powers-host:9849';
  if (process.env.POWERS_SKIP_BUILD_KICKOFF !== 'true') {
    const specParsed = (() => { try { return JSON.parse(toolDef.spec_json || '{}'); } catch { return {}; } })();
    const repoUrl = specParsed.provenance?.repo_url;
    try {
      await assertJsonResponse(
        'auth→powers-host build kickoff (update)',
        `${powersHostUrl}/internal/powers/build`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo_url: repoUrl, tool_id: toolDefId, org_id: orgId, repo_ref: newVersion }),
          signal: AbortSignal.timeout(8000),
        },
        { tool_def_id: toolDefId, repo_ref: newVersion }
      );
    } catch (err) {
      console.error('[LIFECYCLE-P2-D2] Update build kickoff failed tool_def_id=%s: %s', toolDefId, err.message);
      // Roll back version to old ref
      db.prepare('UPDATE tool_definitions SET version = ?, updated_at = ? WHERE id = ?').run(oldRef, now, toolDefId);
      if (hasPowersHosted) {
        db.prepare("UPDATE powers_hosted SET repo_ref = ? WHERE tool_id = ?").run(oldRef || 'HEAD', toolDefId);
      }
      return res.status(503).json({
        error: 'build_kickoff_failed',
        message: 'Could not start the build process for the new ref. Version rolled back.',
        detail: err.message,
      });
    }
  }

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy_repo.updated',
    targetType: 'tool_definition',
    targetId: toolDefId,
    metadata: { tool_id: toolDef.tool_id, old_ref: oldRef, new_ref: newVersion },
  });

  _emitVoltDeployEvent('power.deploy.updated', toolDefId, orgId, { old_ref: oldRef, new_ref: newVersion });

  return res.status(202).json({
    ok: true,
    tool_def_id: toolDefId,
    tool_id: toolDef.tool_id,
    repo_ref: newVersion,
    build_state: 'pending',
  });
});

// ─── LIFECYCLE-P2-D3: Archive / Restore ──────────────────────────────────────

// POST /api/orgs/:orgId/powers/deploy/repo/:toolDefId/archive
// Soft-archive: disables tool + installation without touching rows.
// Agent, credentials, and powers_hosted rows are preserved.
// Container stops naturally via idle-eviction on powers-host side.
router.post('/orgs/:orgId/powers/deploy/repo/:toolDefId/archive', async (req, res) => {
  const { orgId, toolDefId } = req.params;
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  const toolDef = db.prepare('SELECT id, tool_id FROM tool_definitions WHERE id = ?').get(toolDefId);
  if (!toolDef) return res.status(404).json({ error: 'tool_not_found' });

  const inst = db.prepare('SELECT id FROM tool_installations WHERE tool_definition_id = ? AND org_id = ?').get(toolDefId, orgId);
  if (!inst) return res.status(403).json({ error: 'tool_not_in_org' });

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare("UPDATE tool_definitions SET status = 'disabled', updated_at = ? WHERE id = ?").run(now, toolDefId);
    db.prepare("UPDATE tool_installations SET enabled = 0, disabled_at = ?, disabled_by = ? WHERE id = ?").run(now, userId, inst.id);
  })();

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy_repo.archived',
    targetType: 'tool_definition',
    targetId: toolDefId,
    metadata: { tool_id: toolDef.tool_id },
  });

  _emitVoltDeployEvent('power.deploy.archived', toolDefId, orgId, { tool_id: toolDef.tool_id });

  return res.status(200).json({ ok: true, tool_def_id: toolDefId, status: 'archived' });
});

// POST /api/orgs/:orgId/powers/deploy/repo/:toolDefId/restore
// Reverse of archive — re-enables tool + installation.
router.post('/orgs/:orgId/powers/deploy/repo/:toolDefId/restore', async (req, res) => {
  const { orgId, toolDefId } = req.params;
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  const toolDef = db.prepare('SELECT id, tool_id FROM tool_definitions WHERE id = ?').get(toolDefId);
  if (!toolDef) return res.status(404).json({ error: 'tool_not_found' });

  const inst = db.prepare('SELECT id FROM tool_installations WHERE tool_definition_id = ? AND org_id = ?').get(toolDefId, orgId);
  if (!inst) return res.status(403).json({ error: 'tool_not_in_org' });

  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare("UPDATE tool_definitions SET status = 'beta', updated_at = ? WHERE id = ?").run(now, toolDefId);
    db.prepare("UPDATE tool_installations SET enabled = 1, disabled_at = NULL, disabled_by = NULL, updated_at = ? WHERE id = ?").run(now, inst.id);
  })();

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy_repo.restored',
    targetType: 'tool_definition',
    targetId: toolDefId,
    metadata: { tool_id: toolDef.tool_id },
  });

  _emitVoltDeployEvent('power.deploy.restored', toolDefId, orgId, { tool_id: toolDef.tool_id });

  return res.status(200).json({ ok: true, tool_def_id: toolDefId, status: 'restored' });
});

// ─── LIFECYCLE-P2-D4: Re-config without rebuild ───────────────────────────────

// PATCH /api/orgs/:orgId/powers/deploy/repo/:toolDefId/config
// Updates env_vars (via Vault cred rotation) and/or agent persona fields.
// No rebuild required — new env vars apply on next container spawn.
router.patch('/orgs/:orgId/powers/deploy/repo/:toolDefId/config', async (req, res) => {
  const { orgId, toolDefId } = req.params;
  const { env_vars, persona } = req.body || {};
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  // Require at least one of env_vars or persona
  const hasEnvVars = Array.isArray(env_vars) && env_vars.length > 0;
  const hasPersona = persona && typeof persona === 'object' && Object.keys(persona).length > 0;
  if (!hasEnvVars && !hasPersona) {
    return res.status(400).json({ error: 'invalid_body', message: 'At least one of env_vars or persona is required' });
  }

  const toolDef = db.prepare('SELECT id, tool_id FROM tool_definitions WHERE id = ?').get(toolDefId);
  if (!toolDef) return res.status(404).json({ error: 'tool_not_found' });

  const inst = db.prepare('SELECT id FROM tool_installations WHERE tool_definition_id = ? AND org_id = ?').get(toolDefId, orgId);
  if (!inst) return res.status(403).json({ error: 'tool_not_in_org' });

  // Find the agent associated with this tool
  const assignment = db.prepare(
    'SELECT agent_id FROM agent_tool_assignments WHERE tool_installation_id = ? AND revoked_at IS NULL LIMIT 1'
  ).get(inst.id);

  const now = new Date().toISOString();
  const changedKeys = [];

  db.transaction(() => {
    // Update env_vars in Vault via credential rotation (re-put = update)
    if (hasEnvVars) {
      // Validate env_vars shape
      for (const ev of env_vars) {
        if (!ev.key || typeof ev.key !== 'string' || ev.key.trim() === '') {
          throw Object.assign(new Error('each env_var must have a non-empty key'), { statusCode: 400 });
        }
        if (typeof ev.value !== 'string') {
          throw Object.assign(new Error('each env_var value must be a string'), { statusCode: 400 });
        }
        changedKeys.push(ev.key.trim());
      }

      // bulkPutPowersCredentials rotates (upserts) credentials — secret.access audit fires
      bulkPutPowersCredentials(db, {
        orgId,
        toolDefId,
        envVars: env_vars.map(ev => ({ key: ev.key.trim(), value: ev.value })),
        userId,
      });
    }

    // Update agent persona fields
    if (hasPersona && assignment?.agent_id) {
      const fields = [];
      const values = [];

      if (persona.name && typeof persona.name === 'string') {
        fields.push('name = ?');
        values.push(persona.name.trim());
      }
      if (typeof persona.description === 'string') {
        fields.push('description = ?');
        values.push(persona.description);
      }
      if (typeof persona.icon === 'string') {
        fields.push('icon = ?');
        values.push(persona.icon);
      }
      if (typeof persona.system_prompt_additions === 'string') {
        fields.push('system_prompt_additions = ?');
        values.push(persona.system_prompt_additions);
      }

      if (fields.length > 0) {
        fields.push('updated_at = ?');
        values.push(now);
        values.push(assignment.agent_id);
        values.push(orgId);
        db.prepare(
          `UPDATE agents SET ${fields.join(', ')} WHERE agent_id = ? AND org_id = ?`
        ).run(...values);
      }
    }
  })();

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy_repo.config_updated',
    targetType: 'tool_definition',
    targetId: toolDefId,
    metadata: {
      tool_id: toolDef.tool_id,
      changed_env_keys: changedKeys, // keys only, never values
      persona_updated: hasPersona,
    },
  });

  _emitVoltDeployEvent('power.deploy.config_updated', toolDefId, orgId, {
    tool_id: toolDef.tool_id,
    changed_env_keys: changedKeys,
    persona_updated: hasPersona,
  });

  return res.status(200).json({ ok: true, tool_def_id: toolDefId, changed_env_keys: changedKeys });
});

// DELETE /api/orgs/:orgId/powers/deploy/repo/:toolDefId
// B2: Full transactional teardown — disables tool_definition and cleans up all
// associated rows (integration_credentials, powers_hosted, tool_installations,
// agent_tool_assignments, agents). Pre-finalize: also covers finalized deploys.
// tool_definitions row is kept (status='disabled') for audit reference.
// LIFECYCLE-P2-D3: Requires ?confirm=true to guard against accidental destroys.
router.delete('/orgs/:orgId/powers/deploy/repo/:toolDefId', async (req, res) => {
  const { orgId, toolDefId } = req.params;
  const userId = req.user?.id;
  const db = dbFor(req);

  const mem = checkMembership(db, orgId, userId);
  if (!mem.ok) return res.status(mem.status).json({ error: mem.error });

  if (!resolveCapFromMembership(db, req.user, mem.membership, mem.org, Capabilities.AGENTS_MANAGE)) {
    return res.status(403).json({ error: 'insufficient_permissions', message: 'AGENTS_MANAGE capability required' });
  }

  const toolDef = db.prepare('SELECT id, tool_id, spec_json FROM tool_definitions WHERE id = ?').get(toolDefId);
  if (!toolDef) return res.status(404).json({ error: 'tool_not_found' });

  const inst = db.prepare('SELECT id FROM tool_installations WHERE tool_definition_id = ? AND org_id = ?').get(toolDefId, orgId);
  if (!inst) return res.status(403).json({ error: 'tool_not_in_org' });

  // LIFECYCLE-P2-D3: Require explicit ?confirm=true to prevent accidental destroys
  if (req.query.confirm !== 'true') {
    return res.status(409).json({
      error: 'confirm_required',
      message: 'This is a destructive and irreversible operation. Pass ?confirm=true to proceed.',
      tool_def_id: toolDefId,
      actions: ['archive', 'destroy_confirmed'],
    });
  }

  const now = new Date().toISOString();

  // Determine the agent_id from any assignment for this installation
  const assignment = db.prepare(
    'SELECT agent_id FROM agent_tool_assignments WHERE tool_installation_id = ? LIMIT 1'
  ).get(inst.id);

  // B2: Full transactional teardown
  const teardownResult = db.transaction(() => {
    // 1. Revoke agent_tool_assignments
    const assignmentsRevoked = db.prepare(
      "UPDATE agent_tool_assignments SET revoked_at = ?, revoked_by = ? WHERE tool_installation_id = ? AND revoked_at IS NULL"
    ).run(now, userId, inst.id).changes;

    // 2. Retire the custom agent (if one was created for this tool)
    let agentsRetired = 0;
    if (assignment?.agent_id) {
      agentsRetired = db.prepare(
        "UPDATE agents SET status = 'retired', retired_at = ?, retired_by = ? WHERE org_id = ? AND agent_id = ? AND status != 'retired'"
      ).run(now, userId, orgId, assignment.agent_id).changes;
    }

    // 3. Disable tool_installation
    db.prepare(
      "UPDATE tool_installations SET enabled = 0, disabled_at = ?, disabled_by = ? WHERE id = ?"
    ).run(now, userId, inst.id);

    // 4. Delete integration_credentials (env vars + mcp_endpoint auth)
    const credsDeleted = deletePowersCredentialsForTool(db, orgId, toolDefId);
    const endpointAuthDeleted = deleteMcpEndpointAuth(db, orgId, toolDefId) ? 1 : 0;

    // 5. Remove powers_hosted row (build metadata)
    const hostedDeleted = db.prepare(
      'DELETE FROM powers_hosted WHERE tool_id = ?'
    ).run(toolDefId).changes;

    // 6. Disable tool_definitions (keep row for audit trail)
    db.prepare("UPDATE tool_definitions SET status = 'disabled', updated_at = ? WHERE id = ?")
      .run(now, toolDefId);

    return { assignmentsRevoked, agentsRetired, credsDeleted, endpointAuthDeleted, hostedDeleted };
  })();

  writeAuditEvent(db, {
    orgId,
    actorId: userId,
    action: 'directory.power.deploy_repo.deleted',
    targetType: 'tool_definition',
    targetId: toolDefId,
    metadata: {
      tool_id: toolDef.tool_id,
      teardown: teardownResult,
    },
  });

  // LIFECYCLE-P3-D2: VOLT power.deploy.failed (repurposed as destroy signal — deploy lifecycle ends here)
  _emitVoltDeployEvent('power.deploy.failed', toolDefId, orgId, {
    reason: 'deleted',
    tool_id: toolDef.tool_id,
    teardown: teardownResult,
  });

  // Notify collector to remove from its in-memory store (non-fatal)
  if (process.env.POWERS_SKIP_COLLECTOR_SYNC !== 'true') {
    const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
    fetch(`${collectorUrl}/api/internal/tool-definitions/uninstall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
      },
      body: JSON.stringify({ toolId: toolDef.tool_id, orgId }),
      signal: AbortSignal.timeout(5000),
    }).then(r => {
      if (!r.ok) {
        r.text().then(t => console.warn('[POWERS] DELETE→collector uninstall non-2xx status=%d tool=%s body=%s', r.status, toolDef.tool_id, t.slice(0, 200)));
      }
    }).catch(err => {
      console.warn('[POWERS] DELETE→collector uninstall failed tool=%s: %s', toolDef.tool_id, err.message);
    });
  }

  return res.status(200).json({ ok: true, tool_def_id: toolDefId, status: 'disabled', teardown: teardownResult });
});

// ─── INTERNAL ROUTER (service-to-service, no user auth) ──────────────────────
// Mounted at /api/internal in server.js — separate from user-auth-gated routes.

const internalRouter = Router();

/**
 * GET /powers/credentials/:toolDefId
 * List all Vault credential IDs for a POWERS tool (mcp_hosted env vars + mcp_endpoint auth).
 * Auth: x-service-key header matching INTERNAL_SERVICE_KEY env var.
 * Used by powers-host processSupervisor to enumerate credentials before decrypting.
 *
 * Returns: { credentials: [{ id, label, kind }] }
 */
internalRouter.get('/powers/credentials/:toolDefId', (req, res) => {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    return res.status(401).json({ error: 'service_key_not_configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (!serviceKey || serviceKey !== expectedKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid service key' });
  }

  const { toolDefId } = req.params;
  const orgId = req.query.org_id || req.headers['x-org-id'];

  if (!orgId) {
    return res.status(400).json({ error: 'missing_org_id', message: 'org_id query param or x-org-id header required' });
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT id, label, metadata_json
    FROM integration_credentials
    WHERE org_id = ? AND integration_type = 'custom' AND (
      label LIKE ? OR label = ?
    )
    ORDER BY label
  `).all(orgId, `powers:${toolDefId}:%`, `powers:mcp_endpoint:${toolDefId}`);

  const credentials = rows.map(r => {
    const meta = JSON.parse(r.metadata_json || '{}');
    return { id: r.id, label: r.label, kind: meta.kind || 'unknown' };
  });

  return res.json({ credentials, count: credentials.length });
});

/**
 * POST /powers/audit/secret-access
 * B1: Record a secret.access audit event for mcp_endpoint credential reads.
 * Called by the collector service when it decrypts an mcp_auth_value_encrypted
 * credential at dispatch time — the collector has no direct auth.db access.
 *
 * Auth: x-service-key header matching INTERNAL_SERVICE_KEY env var.
 *
 * Body: { org_id, tool_id, label, credential_id? }
 * Returns: { ok: true }
 */
internalRouter.post('/powers/audit/secret-access', (req, res) => {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying secret-access audit request');
    return res.status(401).json({ error: 'service_key_not_configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (!serviceKey || serviceKey !== expectedKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid service key' });
  }

  const { org_id, tool_id, label, credential_id } = req.body || {};
  if (!org_id || !tool_id) {
    return res.status(400).json({ error: 'missing_fields', message: 'org_id and tool_id are required' });
  }

  const db = getDb();
  const now = new Date().toISOString();
  const auditPayload = {
    org_id,
    actor_type: 'service',
    actor_id: 'collector',
    action: 'secret.access',
    target_type: 'integration_credential',
    target_id: credential_id || null,
    status: 'success',
    metadata: {
      label: label || `powers:mcp_endpoint:${tool_id}`,
      source: 'mcp_endpoint_dispatch',
      context: 'dispatch',
      actor_type: 'service',
    },
    created_at: now,
  };

  // LIFECYCLE-P3-D4: Durable audit — primary write + fallback queue
  let primaryWriteOk = false;
  try {
    const id = ulid();
    db.prepare(`
      INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, org_id, 'service', 'collector', 'secret.access',
      'integration_credential', credential_id || null,
      'success',
      JSON.stringify(auditPayload.metadata),
      now
    );
    primaryWriteOk = true;
    // LIFECYCLE-P3-D1: WARD witness (fire-and-forget)
    witnessAuthAudit({ id, org_id, actor_type: 'service', actor_id: 'collector',
      action: 'secret.access', target_type: 'integration_credential',
      target_id: credential_id || null, status: 'success', created_at: now }, org_id)
      .catch(() => {});
  } catch (writeErr) {
    console.error('[LIFECYCLE-P3-D4] secret.access audit write failed, queueing: %s', writeErr.message);
  }

  // Queue for retry if primary write failed
  if (!primaryWriteOk) {
    queuePendingAuditEvent(db, 'secret.access', auditPayload);
  }

  return res.json({ ok: true });
});

/**
 * GET /powers/audit/pending-stats
 * LIFECYCLE-P3-D4: Returns counts for pending_audit_events table.
 * Used by monitoring / admin dashboards. Service-key auth.
 *
 * Returns: { pending: number, dead_letter: number }
 */
internalRouter.get('/powers/audit/pending-stats', (req, res) => {
  const expectedKey = process.env.INTERNAL_SERVICE_KEY;
  if (!expectedKey) {
    console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured — denying audit/pending-stats request');
    return res.status(401).json({ error: 'service_key_not_configured' });
  }
  const serviceKey = req.headers['x-service-key'];
  if (!serviceKey || serviceKey !== expectedKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const db = getDb();
  try {
    const pending = db.prepare(
      'SELECT COUNT(*) AS cnt FROM pending_audit_events WHERE attempts < 10'
    ).get()?.cnt || 0;
    const deadLetter = db.prepare(
      'SELECT COUNT(*) AS cnt FROM pending_audit_events WHERE attempts >= 10'
    ).get()?.cnt || 0;

    return res.json({ ok: true, pending, dead_letter: deadLetter });
  } catch (err) {
    return res.status(500).json({ error: 'query_failed', message: err.message });
  }
});

export { internalRouter };
export default router;

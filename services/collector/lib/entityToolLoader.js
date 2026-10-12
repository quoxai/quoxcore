/**
 * Entity Tool Loader
 *
 * Reads entity tool JSON files from src/config/entities/tools/ and dynamically
 * registers them into TOOL_DEFS alongside hardcoded native tools.
 *
 * Entity tools define parameters and metadata but have no execute() functions.
 * This module creates executor wrappers based on the tool's endpoint config:
 *   - base + api → direct HTTP API call
 *   - fallback → ssh_exec via bastion
 */

const fs = require('fs');
const path = require('path');

// AGENT-OVERHAUL-2 FIX 2 — reuse the SAME approval gate native tools use
// (e.g. proxmox_vm_action) rather than duplicating resume-token/approval-
// creation logic here. See withApprovalGate's ctx._entityRequiresApproval
// branch in approvalGate.js.
const { withApprovalGate } = require('./approvalGate');

// Internal executor registry — tool providers that run inline (no HTTP proxy)
const INTERNAL_EXECUTORS = {};

/**
 * Register an internal executor for a tool provider.
 * @param {string} name - Provider name (matches endpoints.api in entity JSON)
 * @param {object} executor - Module with execute(toolId, input, ctx) function
 */
function registerInternalExecutor(name, executor) {
  INTERNAL_EXECUTORS[name] = executor;
}

// Auto-register known internal executors
try {
  const geminiExecutor = require('./geminiImageExecutor');
  registerInternalExecutor('gemini_image', geminiExecutor);
} catch (err) {
  // Executor not available — tools will get a fallback error
}

try {
  const coreHealthExecutor = require('./coreHealthExecutor');
  registerInternalExecutor('core_health', coreHealthExecutor);
} catch (err) {
  // Executor not available — tools will get a fallback error
}

try {
  const prometheusExecutor = require('./prometheusExecutor');
  registerInternalExecutor('prometheus', prometheusExecutor);
} catch (err) {
  // Executor not available — tools will get a fallback error
}

try {
  const quoxagentExecutor = require('./quoxagentExecutor');
  registerInternalExecutor('quoxagent', quoxagentExecutor);
} catch (err) {
  // Executor not available — tools will get a fallback error
}

try {
  const bastionSshExecutor = require('./bastionSshExecutor');
  registerInternalExecutor('bastion_ssh', bastionSshExecutor);
} catch (err) {
  // Executor not available — tools will get a fallback error
}

try {
  const mikrotikExecutor = require('./mikrotikExecutor');
  registerInternalExecutor('mikrotik', mikrotikExecutor);
} catch (err) {
  // Executor not available — tools will get a fallback error
}

/**
 * Convert entity tool parameters to Anthropic input_schema format.
 *
 * Entity format: { host: { type: "string", required: true, description: "..." } }
 * Anthropic format: { type: "object", properties: { host: { type: "string", description: "..." } }, required: ["host"] }
 */
function convertParameters(params) {
  if (!params || typeof params !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }

  const properties = {};
  const required = [];

  for (const [name, def] of Object.entries(params)) {
    const prop = { type: def.type || 'string' };
    if (def.description) prop.description = def.description;
    if (def.enum) prop.enum = def.enum;
    if (def.default !== undefined) prop.default = def.default;
    properties[name] = prop;

    if (def.required === true) {
      required.push(name);
    }
  }

  return { type: 'object', properties, required };
}

/**
 * Convert entity tool ID to TOOL_DEFS key name.
 * "docker.logs" → "docker_logs"
 * "mikrotik.discovery.scan" → "mikrotik_discovery_scan"
 */
function entityIdToToolName(entityId) {
  return entityId.replace(/\./g, '_');
}

// AGENT-OVERHAUL-2 FIX 3 — entity licence gate must consult the real
// entitlement source (a signed lease resolved via the auth service's
// has-plugin endpoint, the same source services/collector/lib/licenseGate.js
// uses for data-plane traffic), not LICENSED_PLUGINS env alone. Env is now
// an override/fallback ONLY, per the no-env-only-config hard rule — it is
// consulted when the lease hasn't resolved yet (cold boot) or auth was
// unreachable, never as the primary decision.
//
// Entity tools are registered at module init (loadEntityTools runs
// synchronously as agentTools.js is require()'d — see the call site near
// the bottom of that file), so this cache CANNOT be awaited before the
// first synchronous pass runs: fetch() is async and module init must stay
// synchronous-safe. The workaround: the first pass always uses whatever the
// cache already holds (empty on cold boot -> falls back to env, same
// behaviour as before this fix). refreshEntityToolLicenses() below is
// fired-and-forgotten right after the synchronous load (see agentTools.js);
// once it resolves, any plugin whose lease says "licensed" but whose entity
// tools were skipped on the synchronous pass (env didn't have it) gets
// re-run through loadEntityTools with the SAME toolDefs/agentTools objects
// — since `if (toolDefs[toolName]) skip` only prevents already-registered
// tools from being duplicated, a second pass is a pure upgrade: it can only
// add newly-licensed tools, never remove ones already granted. Revoking a
// licence at runtime is out of scope here (the env-only design being
// replaced never handled that either).
const _leaseCache = new Map(); // pluginId -> boolean (resolved lease result)

function _envLicensedPlugins() {
  return (process.env.LICENSED_PLUGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Check if a plugin is licensed. Source-of-truth order:
 *   1. Resolved lease cache (populated by refreshEntityToolLicenses()) — real
 *      entitlement, verified server-side against the signed lease.
 *   2. LICENSED_PLUGINS env var — fallback ONLY, used when the lease hasn't
 *      resolved yet or auth was unreachable.
 * Always logs which source decided, so a "why did/didn't this plugin load"
 * question has an honest answer in the collector logs rather than a silent
 * env-only decision.
 */
function isPluginLicensed(pluginName) {
  if (_leaseCache.has(pluginName)) {
    const licensed = _leaseCache.get(pluginName);
    console.log(`[EntityToolLoader] License decision for '${pluginName}': LEASE source, licensed=${licensed}`);
    return licensed;
  }
  const licensed = _envLicensedPlugins().includes(pluginName);
  console.log(`[EntityToolLoader] License decision for '${pluginName}': ENV fallback (lease not yet resolved), licensed=${licensed}`);
  return licensed;
}

/**
 * Resolve a plugin's entitlement from the auth service's has-plugin
 * endpoint (whole-install entitlement — no org param, mirrors the
 * `<pluginId>` grammar in services/auth/lib/entitlements.js). Short timeout
 * so a slow/unreachable auth service can't hang collector boot.
 * Never throws — callers get `null` on any failure and should treat that
 * as "lease unresolved", not "unlicensed".
 */
async function _resolveLeaseForPlugin(pluginName) {
  const authBase = process.env.AUTH_SERVICE_URL || process.env.AUTH_INTERNAL_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  try {
    const resp = await fetch(`${authBase}/api/setup/internal/has-plugin?plugin=${encodeURIComponent(pluginName)}`, {
      headers: {
        ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
        'x-internal-call': '1',
      },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      console.warn(`[EntityToolLoader] Lease resolve for '${pluginName}' failed: auth ${resp.status}`);
      return null;
    }
    const body = await resp.json();
    return !!body.licensed;
  } catch (err) {
    console.warn(`[EntityToolLoader] Lease resolve for '${pluginName}' failed (auth unreachable): ${err.message}`);
    return null;
  }
}

/**
 * Fire-and-forget after the synchronous module-init load: resolves every
 * distinct `requires_license` value seen across the entity tool JSON files
 * against the real lease, populates _leaseCache, and — for any plugin that
 * upgrades from unlicensed-at-boot to licensed-via-lease — re-runs
 * loadEntityTools so those tools actually get registered instead of staying
 * gated for the life of the process (the exact "dev loaded ZERO gated tools
 * until LICENSED_PLUGINS was mirrored by hand" failure this fix closes).
 *
 * @param {string} basePath - Same entities/tools directory loadEntityTools reads.
 * @param {object} toolDefs - Same TOOL_DEFS reference passed to loadEntityTools.
 * @param {object} agentTools - Same AGENT_TOOLS reference passed to loadEntityTools.
 * @param {object} deps - Same deps passed to loadEntityTools (e.g. callBastion).
 * @returns {Promise<{ resolved: number, upgraded: string[], reloaded: object|null }>}
 */
async function refreshEntityToolLicenses(basePath, toolDefs, agentTools, deps = {}) {
  let files;
  try {
    files = fs.readdirSync(basePath).filter(f => f.endsWith('.json'));
  } catch (err) {
    return { resolved: 0, upgraded: [], reloaded: null };
  }

  const requiredPlugins = new Set();
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(basePath, file), 'utf8');
      const entityData = JSON.parse(raw);
      if (entityData.requires_license) requiredPlugins.add(entityData.requires_license);
    } catch (err) {
      // Already logged/skipped by the synchronous loadEntityTools pass.
    }
  }

  if (requiredPlugins.size === 0) return { resolved: 0, upgraded: [], reloaded: null };

  const upgraded = [];
  for (const pluginName of requiredPlugins) {
    const wasLicensedBefore = isPluginLicensed(pluginName); // reads env fallback if cache is still cold
    const leaseResult = await _resolveLeaseForPlugin(pluginName);
    if (leaseResult === null) continue; // auth unreachable — keep env fallback in effect
    _leaseCache.set(pluginName, leaseResult);
    console.log(`[EntityToolLoader] Lease resolved for '${pluginName}': licensed=${leaseResult}`);
    if (leaseResult && !wasLicensedBefore) upgraded.push(pluginName);
  }

  let reloaded = null;
  if (upgraded.length > 0) {
    console.log(`[EntityToolLoader] Lease upgraded ${upgraded.length} plugin(s) after boot (${upgraded.join(', ')}) — re-running loadEntityTools to register their tools`);
    reloaded = loadEntityTools(basePath, toolDefs, agentTools, deps);
  }

  return { resolved: requiredPlugins.size, upgraded, reloaded };
}

/**
 * Test-only: clear the resolved lease cache so tests don't leak state
 * between cases. Not used by production code paths.
 */
function __clearLeaseCacheForTesting() {
  _leaseCache.clear();
}

/**
 * Create an executor that calls a direct HTTP API.
 */
function createApiExecutor(baseUrl, toolId) {
  return async (input, ctx) => {
    try {
      const url = `${baseUrl}`;
      const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(serviceKey ? { 'x-service-key': serviceKey } : {})
        },
        body: JSON.stringify({
          tool_id: toolId,
          input,
          agent_id: ctx?.agentId || 'quox'
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!resp.ok) {
        const text = await resp.text();
        return { success: false, error: `API ${resp.status}: ${text}` };
      }
      return await resp.json();
    } catch (err) {
      return { success: false, error: `API call failed for ${toolId}: ${err.message}` };
    }
  };
}

/**
 * Create a fallback executor that routes through bastion SSH.
 */
function createBastionExecutor(toolId, callBastion) {
  return async (input, ctx) => {
    if (!callBastion) {
      return { success: false, error: `No executor available for ${toolId}` };
    }
    const host = input.host || 'localhost';
    return { success: false, error: `Entity tool ${toolId} has no configured executor. Host: ${host}` };
  };
}

/**
 * Create an executor that routes to an internal (inline) executor module.
 */
function createInternalExecutor(executorName, toolId) {
  return async (input, ctx) => {
    const executor = INTERNAL_EXECUTORS[executorName];
    if (!executor || typeof executor.execute !== 'function') {
      return { success: false, error: `Internal executor '${executorName}' not registered for ${toolId}` };
    }
    return executor.execute(toolId, input, ctx);
  };
}

/**
 * Create the appropriate executor for an entity tool based on its endpoints config.
 * Priority: internal → direct API → bastion SSH fallback
 */
function createExecutor(endpoints, toolId, deps) {
  // QUOXTRUST C2/WP2: stamp the chosen kind on the executor fn so the def
  // registration below can derive externalEffect from ONE source of truth
  // (no mirrored branch conditions to drift).
  const tagged = (fn, kind) => { try { fn._executorKind = kind; } catch { /* frozen fn */ } return fn; };
  if (!endpoints) {
    return tagged(createBastionExecutor(toolId, deps.callBastion), 'bastion');
  }

  // Internal executor (runs inline, no HTTP proxy)
  if (endpoints.base === 'internal' && endpoints.api) {
    return tagged(createInternalExecutor(endpoints.api, toolId), 'internal');
  }

  // Direct API first (mikrotik, prometheus, screencap, quoxagent)
  if (endpoints.base && endpoints.api) {
    return tagged(createApiExecutor(`${endpoints.base}${endpoints.api}`, toolId), 'api');
  }

  // Base URL only — POST to base
  if (endpoints.base) {
    return tagged(createApiExecutor(endpoints.base, toolId), 'api');
  }

  return tagged(createBastionExecutor(toolId, deps.callBastion), 'bastion');
}

/**
 * Load entity tool JSON files and register them into TOOL_DEFS.
 *
 * @param {string} basePath - Path to entities/tools/ directory
 * @param {object} toolDefs - TOOL_DEFS object to extend (mutated)
 * @param {object} agentTools - AGENT_TOOLS object to extend (mutated)
 * @param {object} deps - Dependencies: { callBastion }
 * @returns {{ loaded: number, skipped: number, gated: number, metadata: object }}
 */
function loadEntityTools(basePath, toolDefs, agentTools, deps = {}) {
  const result = { loaded: 0, skipped: 0, gated: 0, metadata: {} };

  let files;
  try {
    files = fs.readdirSync(basePath).filter(f => f.endsWith('.json'));
  } catch (err) {
    console.error(`[EntityToolLoader] Failed to read directory ${basePath}: ${err.message}`);
    return result;
  }

  for (const file of files) {
    let entityData;
    try {
      const raw = fs.readFileSync(path.join(basePath, file), 'utf8');
      entityData = JSON.parse(raw);
    } catch (err) {
      console.warn(`[EntityToolLoader] Failed to parse ${file}: ${err.message}`);
      continue;
    }

    // License gating
    if (entityData.requires_license && !isPluginLicensed(entityData.requires_license)) {
      const toolCount = (entityData.tools || []).length;
      result.gated += toolCount;
      continue;
    }

    const category = entityData.category || 'other';
    const subcategory = entityData.subcategory || '';
    const endpoints = entityData.endpoints || null;
    const primaryAgent = entityData.agent_hints?.primary_agent || null;

    for (const tool of entityData.tools || []) {
      if (!tool.id || !tool.description) {
        result.skipped++;
        continue;
      }

      const toolName = entityIdToToolName(tool.id);

      // Skip if hardcoded tool already exists (native takes precedence)
      if (toolDefs[toolName]) {
        result.skipped++;
        continue;
      }

      const inputSchema = convertParameters(tool.parameters);
      const baseExecutor = createExecutor(endpoints, tool.id, deps);

      // AGENT-OVERHAUL-2 FIX 2 — requiresApproval/defconLevel were carried
      // on the entity JSON but never copied into the registered tool def,
      // and the approval gate was only ever wired to native tools. A tool
      // flagged requiresApproval:true now gets wrapped with the same
      // withApprovalGate() native tools use (see proxmox_vm_action in
      // agentTools.js); the entity-metadata branch inside checkApproval
      // makes that gate unconditional for this tool, same as an
      // AGENT_GATED_TOOLS entry, rather than depending on an org policy
      // happening to exist.
      const requiresApproval = tool.requiresApproval === true;
      const defconLevel = tool.defconLevel || null;
      const risk = tool.aoclClassification?.risk || null;
      const executor = requiresApproval
        ? (input, ctx) => withApprovalGate(toolName, input, () => baseExecutor(input, ctx), {
            ...ctx,
            _entityRequiresApproval: true,
            _entityDefconLevel: defconLevel,
          })
        : baseExecutor;

      // Register into TOOL_DEFS
      // QUOXTRUST C2/WP2 external-effect derivation (docs/trust/C2): a bastion
      // executor ALWAYS reaches outside the box; an api executor is external
      // when the entity JSON declares "externalEffect": true (proxmox_vm_start,
      // screencap_upload — requiresApproval:false but still outward) or when
      // the tool is a gated write (requiresApproval). Internal executors never.
      const executorKind = baseExecutor && baseExecutor._executorKind ? baseExecutor._executorKind : 'unknown';
      // A gated write (requiresApproval) is consequential REGARDLESS of executor
      // kind — docker_restart/system_service_restart run 'internal' executors
      // that still restart real containers/services (the w-t3 sweep caught the
      // kind-only rule missing them, 2026-09-28). Bastion is always outward;
      // an api tool can also self-declare via the entity JSON.
      const externalEffect = executorKind === 'bastion'
        ? true
        : (requiresApproval || tool.externalEffect === true);

      toolDefs[toolName] = {
        name: toolName,
        description: tool.description,
        input_schema: inputSchema,
        execute: executor,
        externalEffect,
        // requiresApproval entity tools are wrapped withApprovalGate at load —
        // their dispatch stamp lands inside the gate (ctx._markDispatched).
        gatedInExecute: requiresApproval,
        _executorKind: executorKind,
        _entity: true,  // Mark as entity-loaded (not native)
        _entityId: tool.id,
        _category: category,
        _subcategory: subcategory,
        _provider: entityData.provider || entityData.id,
        _requiresLicense: entityData.requires_license || null,
        _aeeIntent: tool.aeeIntent || null,
        _aoclClassification: tool.aoclClassification || null,
        _requiresApproval: requiresApproval,
        _defconLevel: defconLevel,
        _risk: risk
      };

      // Store metadata for categoriseTool()
      result.metadata[toolName] = {
        category: subcategory || category,
        provider: entityData.provider || entityData.id,
        aeeIntent: tool.aeeIntent || null,
        aoclClassification: tool.aoclClassification || null
      };

      // Extend AGENT_TOOLS: grant to the specialist owner when one is declared.
      const specialistOwner = primaryAgent && primaryAgent !== 'quox' && !!agentTools[primaryAgent];
      if (specialistOwner && !agentTools[primaryAgent].includes(toolName)) {
        agentTools[primaryAgent].push(toolName);
      }

      // Per-tool cross-grant: a specific tool declares extra agents that need
      // direct access beyond its primary owner (e.g. HYPERION needs
      // mikrotik_dhcp_find_free_ip as often as NETWATCH does, for VM
      // provisioning). Goes through the same license-gated registration path
      // as the primary grant above, rather than a hardcoded AGENT_TOOLS
      // entry that would silently dangle if the plugin isn't licensed.
      for (const extraAgent of tool.also_grant || []) {
        if (agentTools[extraAgent] && !agentTools[extraAgent].includes(toolName)) {
          agentTools[extraAgent].push(toolName);
        }
      }

      // TOOL-RETRIEVAL P1 (2026-08-08) — delegate-first orchestrator scoping.
      // This was previously an unconditional "always give orchestrator access"
      // push that force-added EVERY entity tool to quox, bloating it to 148
      // tools and blowing the OpenAI 128-tool cap (20 tools were then silently
      // truncated on every call). The orchestrator now only holds entity tools
      // that NO specialist owns; when a specialist `primary_agent` is declared,
      // quox reaches the capability by delegating to that agent via
      // `delegate_to_agent` instead of carrying the tool itself. A tool with a
      // declared-but-unregistered primary_agent falls through to quox so it is
      // never orphaned.
      if (!specialistOwner && agentTools.quox && !agentTools.quox.includes(toolName)) {
        agentTools.quox.push(toolName);
      }

      result.loaded++;
    }
  }

  return result;
}

module.exports = {
  loadEntityTools,
  convertParameters,
  entityIdToToolName,
  isPluginLicensed,
  refreshEntityToolLicenses,
  createApiExecutor,
  createBastionExecutor,
  createInternalExecutor,
  createExecutor,
  registerInternalExecutor,
  INTERNAL_EXECUTORS,
  __clearLeaseCacheForTesting
};

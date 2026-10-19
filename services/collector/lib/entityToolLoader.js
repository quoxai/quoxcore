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
// Tools whose real work outlasts the 30 s default: a ScreenCap capture drives a headless browser through a
// full page load and takes ~70 s on the dev box (proof browser/screencap-capture: every call aborted at 30 s,
// so the capture could never be proven).
const API_TOOL_TIMEOUT_MS = { 'screencap.capture': 120000 };
const API_DEFAULT_TIMEOUT_MS = 30000;

function createApiExecutor(baseUrl, toolId) {
  const timeoutMs = API_TOOL_TIMEOUT_MS[toolId] || API_DEFAULT_TIMEOUT_MS;
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
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!resp.ok) {
        const text = await resp.text();
        return { success: false, error: `API ${resp.status}: ${text}` };
      }
      return await resp.json();
    } catch (err) {
      // REL424-BROWSER: a connection that never happened (service not installed or not running) names the service
      // and the cause, not a bare "fetch failed". A timeout or an HTTP error connected, so it is never "unreachable".
      const code = err && err.cause && err.cause.code;
      if (code && UNREACHABLE_CODES.has(code)) {
        let origin = baseUrl;
        try { origin = new URL(baseUrl).origin; } catch { /* keep the raw base */ }
        const service = String(toolId).split('.')[0];
        return { success: false, error_code: 'service_unreachable', error: `Could not connect to ${service} service at ${origin} (${code}) for ${toolId}: it is not running or not installed on this instance.` };
      }
      return { success: false, error: `API call failed for ${toolId}: ${err.message}` };
    }
  };
}
const UNREACHABLE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

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
 * quoxai/quox #1051: tool ids an entity toolset declares but cannot run (its
 * internal executor returns not_implemented for them). They are not registered
 * or granted, so no model is offered them. Derived from the executor's own
 * UNSUPPORTED_TOOLS export (mikrotikExecutor.js), so a tool that leaves that
 * map is offered again on the next load with no other change.
 * deps.unavailableToolIds (iterable of entity ids) overrides it, for tests.
 */
function unavailableToolIdsFor(endpoints, deps) {
  if (deps && deps.unavailableToolIds) return new Set(deps.unavailableToolIds);
  const out = new Set(sharedRetiredIds());
  if (!endpoints || endpoints.base !== 'internal' || !endpoints.api) return out;
  const unsupported = INTERNAL_EXECUTORS[endpoints.api]?.UNSUPPORTED_TOOLS;
  if (unsupported && typeof unsupported === 'object') for (const id of Object.keys(unsupported)) out.add(id);
  return out;
}

/**
 * quoxai/quox #1062: ids in the shared unsupported-tools file outside the
 * executor-owned "mikrotik" group (groups "stubs" and "duplicates"): entity
 * tools with no backend, or retired in favour of another tool. They apply to
 * every entity family, whatever its endpoints block. Hardcoded tools may be
 * listed too (e.g. keeper_backup_status); see withdrawRetiredTools.
 */
// WORKER2 review: the groups read are ALLOWLISTED, so a new group in the shared file (e.g. a
// "planned" list) never withdraws a live tool by accident.
const RETIRED_GROUPS = Object.freeze(['stubs', 'duplicates']);
function retiredIdsFromShared(data) {
  const ids = new Set();
  for (const group of RETIRED_GROUPS) {
    const map = data && data[group];
    if (map && typeof map === 'object') for (const id of Object.keys(map)) ids.add(id);
  }
  return ids;
}
// A corrupt file fails visibly: one loud error line, the loader stays up, nothing is withdrawn.
// A file missing from every candidate path still throws: an empty set there would quietly offer
// tools that have no backend.
function loadSharedRetired(candidates, log = console) {
  for (const p of candidates) {
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    try { return retiredIdsFromShared(JSON.parse(raw)); } catch (err) {
      log.error(`[entityToolLoader] ${p} (shared unsupported-tools.json) is corrupt, cannot parse: ${err.message}. NO tools are withdrawn until it is fixed.`);
      return new Set();
    }
  }
  throw new Error('[entityToolLoader] shared/tool-availability/unsupported-tools.json not found');
}
let _sharedRetired = null;
function sharedRetiredIds() {
  if (_sharedRetired) return _sharedRetired;
  _sharedRetired = loadSharedRetired([
    path.join(__dirname, '../../../shared/tool-availability/unsupported-tools.json'), // source tree
    path.join(__dirname, '../shared/tool-availability/unsupported-tools.json'), // image: /app/lib -> /app/shared
  ]);
  return _sharedRetired;
}

/**
 * Remove retired HARDCODED tools (declared directly in agentTools TOOL_DEFS,
 * not by an entity file) from TOOL_DEFS and every AGENT_TOOLS grant, so no
 * model is offered them. Returns the names removed.
 */
function withdrawRetiredTools(toolDefs, agentTools, ids = sharedRetiredIds()) {
  const removed = [];
  for (const id of ids) {
    const name = entityIdToToolName(id);
    if (toolDefs[name]) { delete toolDefs[name]; removed.push(name); }
    for (const agent of Object.keys(agentTools)) {
      const grant = agentTools[agent];
      if (!Array.isArray(grant)) continue;
      for (let i = grant.length - 1; i >= 0; i--) if (grant[i] === name) grant.splice(i, 1);
    }
  }
  return removed;
}

/**
 * Load entity tool JSON files and register them into TOOL_DEFS.
 *
 * @param {string} basePath - Path to entities/tools/ directory
 * @param {object} toolDefs - TOOL_DEFS object to extend (mutated)
 * @param {object} agentTools - AGENT_TOOLS object to extend (mutated)
 * @param {object} deps - Dependencies: { callBastion }
 * @returns {{ loaded: number, skipped: number, gated: number, unavailable: number, metadata: object }}
 */
function loadEntityTools(basePath, toolDefs, agentTools, deps = {}) {
  const result = { loaded: 0, skipped: 0, gated: 0, unavailable: 0, metadata: {} };

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
    const unavailable = unavailableToolIdsFor(endpoints, deps);

    for (const tool of entityData.tools || []) {
      if (!tool.id || !tool.description) {
        result.skipped++;
        continue;
      }

      // #1051: declared but not implemented (returns 501) -> never offered.
      if (unavailable.has(tool.id)) {
        result.unavailable++;
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
      // DEVFLEET-READ: `primary_grant: false` keeps the tool DEFINED (CLI, other agents, tests)
      // but off the owner's grant, where one merged tool (proxmox_read) replaces it.
      if (specialistOwner && tool.primary_grant !== false && !agentTools[primaryAgent].includes(toolName)) {
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
  API_TOOL_TIMEOUT_MS,
  createBastionExecutor,
  createInternalExecutor,
  createExecutor,
  registerInternalExecutor,
  unavailableToolIdsFor,
  withdrawRetiredTools,
  retiredIdsFromShared,
  loadSharedRetired,
  RETIRED_GROUPS,
  INTERNAL_EXECUTORS,
  __clearLeaseCacheForTesting
};

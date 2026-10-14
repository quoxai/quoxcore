/**
 * Connector Bridge
 *
 * Core orchestration layer for Phase 6.4 Connector Activation Framework.
 * Resolves vault credentials → loads connector module → activates tools.
 *
 * Flow:
 *   1. Agent requests a connector tool (e.g., github_list_repos)
 *   2. Bridge resolves credentials from vault via auth service
 *   3. Bridge loads or reuses connector instance from pool
 *   4. Bridge executes the tool with injected credentials
 *   5. VOLT records the tool call
 *
 * All connector errors are isolated — a failing connector never crashes
 * the chat pipeline.
 */

const fs = require('node:fs')
const path = require('node:path')
const { getConnector, CONNECTOR_REGISTRY } = require('./registry')
const { buildConnector } = require('./declarativeRuntime')
const pool = require('./pool')
const { buildInternalServiceHeaders } = require('../internalServiceHeaders.js')
const { isPluginLicensed } = require('../licenseGate')

// LICENSE-LAUNCH LL-6d C5 (class-complete) — GOVERNED CONNECTOR CAPABILITIES.
// A handful of connector tools ARE paid premium capabilities in their own
// right: "file a GitHub issue via github/create_issue" is the 'gripe'
// entitlement. da338a0b gated only executeTool()'s agent-level choke, which
// left every DIRECT executeConnectorTool caller (fleetGripeHandler.js, the
// generic POST /connectors/:c/tools/:t/execute endpoint) and every non-'gripe'
// agent carrying the same tool (BOB) as a bypass. This map governs the
// CAPABILITY (connectorId:toolName), not the actor, so the gate lives at the
// one shared choke every path crosses (executeConnectorTool below) and a new
// call site cannot reappear as a hole. Key = `${connectorId}:${toolName}`,
// value = the plugin entitlement id the org must hold. Same isPluginLicensed
// source as the agent gate; fail CLOSED.
const CAPABILITY_REQUIRES_PLUGIN = {
  // GITQ Stream A: issue creation is gated on the GitQ plugin ('github'). gripe
  // (the one-line filer) folded into GitQ, so its capability moved 'gripe'->'github'.
  'github:create_issue': 'github',
  // X-PLUGIN phase 9 (2026-09-16): every twitter capability is part of the
  // paid X plugin, and each one burns real pay-per-use API money. Before
  // this, an unentitled org could drive all five for free.
  'twitter:verify_credentials': 'x',
  'twitter:get_tweet': 'x',
  'twitter:get_user_tweets': 'x',
  'twitter:search_recent': 'x',
  'twitter:get_mentions': 'x',
  // LI-OVERHAUL P4 (2026-09-16): the LinkedIn paywall was frontend-only —
  // the exact class the X audit found. Every linkedin capability is part of
  // the paid linkedin plugin; before this, an unentitled org could drive all
  // eight for free through any bridge path.
  'linkedin:publish_post': 'linkedin',
  'linkedin:upload_media': 'linkedin',
  'linkedin:get_posts': 'linkedin',
  'linkedin:get_post': 'linkedin',
  'linkedin:get_engagement': 'linkedin',
  'linkedin:get_comments': 'linkedin',
  'linkedin:create_comment': 'linkedin',
  'linkedin:get_org_info': 'linkedin',
  // FB-1 (2026-09-18): the 'facebook_pages' connector (organic Pages only —
  // no ads/marketing surface) sits behind the paid 'facebook' plugin
  // entitlement, same pattern as linkedin above. Connector id is
  // 'facebook_pages' (not 'facebook') to avoid prefix-colliding with the
  // pre-existing 'facebook_ads' declarative spec; the entitlement id is
  // still plain 'facebook'.
  'facebook_pages:get_pages': 'facebook',
  'facebook_pages:get_page_info': 'facebook',
  'facebook_pages:get_page_posts': 'facebook',
  'facebook_pages:get_page_insights': 'facebook',
  'facebook_pages:get_lead_forms': 'facebook',
  'facebook_pages:get_leads': 'facebook',
  'facebook_pages:publish_page_post': 'facebook',
  // IG-1 (2026-09-18): every instagram capability is part of the paid
  // 'instagram' plugin entitlement, same pattern as facebook above. Connector
  // id is plain 'instagram' (no prefix collision to dodge, see registry.js).
  'instagram:discover_account': 'instagram',
  'instagram:get_account': 'instagram',
  'instagram:list_media': 'instagram',
  'instagram:get_media_insights': 'instagram',
  'instagram:get_account_insights': 'instagram',
  'instagram:get_comments': 'instagram',
  'instagram:get_publishing_limit': 'instagram',
  'instagram:publish_media': 'instagram',
  'instagram:reply_comment': 'instagram',
  // TT-2 (2026-09-18): every tiktok capability is part of the paid 'tiktok'
  // plugin entitlement, same pattern as facebook/instagram above.
  'tiktok:get_profile': 'tiktok',
  'tiktok:list_videos': 'tiktok',
  'tiktok:get_video_stats': 'tiktok',
  'tiktok:get_publish_status': 'tiktok',
  'tiktok:publish_video': 'tiktok',
  'tiktok:upload_draft': 'tiktok',
}

/**
 * The plugin entitlement id a connector capability requires, or null for an
 * un-governed capability (the common case — no gate fires).
 */
function getRequiredPluginForCapability(connectorId, toolName) {
  return CAPABILITY_REQUIRES_PLUGIN[`${connectorId}:${toolName}`] || null
}

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}`

// Loaded connector modules (cached per connectorId)
const _modules = new Map()

// VOLT recording callback — injected via initBridge({ voltRecord })
// Signature: voltRecord(eventType, data) → void (fire-and-forget)
let _voltRecord = null

// QUOXTRUST D6/T9 — the AEE audit envelope sink, injected via
// initBridge({ auditEnvelope }) (server.js's storeAuditEnvelope, the same fn the
// native executeTool choke uses). The bridge already emits VOLT tool.call.executed;
// this adds the AEE/WARD per-tool receipt so a connector effect that runs to
// completion is witnessed the SAME way native tools are (parity). Callers that emit
// their own per-tool AEE (/api/v1/tools/execute + the 5 gold paths) set
// context._callerEmitsToolEvidence to opt out; the direct /connectors route, the
// gripe handler, and direct executeTool connector calls have no such emit and now
// get the receipt here. null = unwired (pre-init / unit test) → no-op, never crash.
let _auditEnvelope = null

// Emit the AEE per-tool receipt for a connector execution that reached tool.execute
// (called from runTool's success and catch branches only — never for a policy deny,
// rate-limit, license or activation failure, which return before runTool; those are
// NOT executions). Deduped and best-effort, counted-not-swallowed on failure.
function _emitConnectorEvidence ({ connectorId, toolName, input, context = {}, durationMs, success, error, disposition = 'executed' }) {
  if (context._callerEmitsToolEvidence) return // a gold caller emits its own
  if (!_auditEnvelope) return
  try {
    const { emitToolEvidence } = require('../toolEvidence.js')
    emitToolEvidence({
      toolName: `${connectorId}_${toolName}`, // the agent-facing name policy/native see
      ctx: context,
      input, // T1: emitToolEvidence derives the canonical-action commitment from this
      corrId: context.corr || context.session_id || context.sessionId || undefined,
      durationMs,
      success,
      error,
      source: context.evidenceSource || 'connector-choke',
      disposition,
      storeAuditEnvelope: _auditEnvelope,
    })
  } catch (err) {
    console.warn(`[ConnectorBridge] CHOKE EVIDENCE EMIT FAILED for ${connectorId}/${toolName}: ${err && err.message}`)
  }
}

// QUOXTRUST T3 (D3 durability) — durable execution ledger handle, injected via
// initBridge({ ledgerDb }). null = not configured (no-op, effects proceed, a
// deliberate deployment choice like AEE_STORAGE_CONFIGURED); a configured handle
// whose write THROWS makes a consequential effect fail closed (no dispatch
// without durable intent). Unlike _voltRecord (fire-and-forget), the ledger claim
// is durable-write-BEFORE-effect.
const executionLedger = require('../executionLedger')
let _ledgerDb = null

// CONNFAC Phase 0 — per-connector rate limiting.
// registry.js has declared `rateLimit: { windowMs, max }` on every connector
// since the framework shipped and nothing ever read it, so an agent stuck in a
// tool loop could hammer a provider until it throttled the org's credential.
// Sliding window of call timestamps keyed `${orgId}:${connectorId}`: per org, so
// one tenant cannot spend another tenant's budget, and per connector, so a
// noisy connector does not starve the rest. In-memory and per process, matching
// the connector pool; a connector with no rateLimit declared stays unlimited.
const _rateWindows = new Map()

/**
 * Record a call against the connector's window.
 * @returns {{ retry_after_ms: number } | null} null when the call is allowed.
 */
function _checkRateLimit(orgId, connectorId) {
  const connector = getConnector(connectorId)
  const limit = connector && connector.rateLimit
  if (!limit || !(limit.max > 0) || !(limit.windowMs > 0)) return null

  const key = `${orgId || 'default'}:${connectorId}`
  const now = Date.now()
  const cutoff = now - limit.windowMs
  const hits = (_rateWindows.get(key) || []).filter(ts => ts > cutoff)

  if (hits.length >= limit.max) {
    _rateWindows.set(key, hits)
    // The oldest hit in the window is the one whose expiry frees a slot.
    return { retry_after_ms: Math.max(1, hits[0] + limit.windowMs - now) }
  }

  hits.push(now)
  _rateWindows.set(key, hits)
  return null
}

/**
 * Clear all rate-limit counters (tests).
 */
function _resetRateLimiter() {
  _rateWindows.clear()
}

/**
 * Resolve credentials from vault via auth service.
 * Uses the same internal resolve endpoint as the rest of the collector.
 */
async function resolveConnectorCredentials(orgId, connectorId, opts = {}) {
  const connector = getConnector(connectorId)
  if (!connector) return { error: `Unknown connector: ${connectorId}` }

  // #481: the repository the caller is acting on, when the tool named one.
  // The vault picks the org credential scoped to that repo instead of the org
  // default, so an org holding several PATs of differing reach stops handing
  // every repo the same token. Selection stays inside orgId; this never
  // reaches another tenant's credential.
  const repo = typeof opts.repo === 'string' && opts.repo.trim() ? opts.repo.trim() : null

  try {
    const resp = await fetch(`${AUTH_BASE_URL}/api/setup/internal/resolve`, {
      method: 'POST',
      headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        org_id: orgId || 'default',
        providers: [connector.credentialType],
        ...(repo ? { repo } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (!resp.ok) {
      return { error: `Vault returned ${resp.status} for ${connectorId}` }
    }

    const data = await resp.json()
    return await _credentialsFromProviderData(orgId, connectorId, connector, data?.providers?.[connector.credentialType], repo)
  } catch (err) {
    return { error: `Credential resolution failed for ${connectorId}: ${err.message}` }
  }
}

/**
 * Turn one provider entry from /internal/resolve into a connector's credential
 * set (field aliasing, passthrough fields, the resolve-by-id fallback for
 * multi-field connectors). Shared by the single-connector path above and the
 * batched getAvailableTools rebuild below, so both hand an agent exactly the
 * same credentials.
 */
async function _credentialsFromProviderData(orgId, connectorId, connector, providerData, repo = null) {
  try {
    if (!providerData) {
      return { error: `No ${connectorId} credentials found in vault` }
    }

    // Extract credential fields
    const credentials = {}
    let credentialId = providerData._credential_id || providerData.credentialId || null

    // The resolve endpoint returns { key, source, credentialId } — a generic single-key response.
    // For multi-field connectors (e.g. tailscale needs api_key + tailnet) the full decrypted
    // credential is fetched via resolve-by-id, but only once a field is actually missing: see
    // the missing-field fallback below. CONNFAC Phase 0 removed a second, earlier resolve-by-id
    // call here whose response was parsed and then discarded ("For now" placeholder), costing
    // every multi-field activation an extra round trip to the auth service for nothing.

    // Map generic fields: the resolve endpoint returns 'key' not 'api_key'
    for (const field of connector.requiredFields) {
      const value = providerData[field]
        || (field === 'api_key' && (providerData.key || providerData.token))
        || (field === 'token' && (providerData.key || providerData.api_key))
        || null
      if (value) credentials[field] = value
    }

    // Also capture endpoint_url if present
    if (providerData.endpoint_url) credentials.endpoint_url = providerData.endpoint_url
    if (providerData.email) credentials.email = providerData.email
    // VAULT-INTEG P10: gitlab's base_url is optional in the vault (defaults to
    // gitlab.com inside connectors/types/gitlab.js when absent), so it can't
    // sit in requiredFields — that would make an org with no base_url set
    // fail activation entirely. Pass it through when present, same shape as
    // endpoint_url/email above. Inert for every other connector (none of the
    // other 10 providers return this field).
    if (providerData.base_url) credentials.base_url = providerData.base_url

    // Validate required fields — if any missing, try resolve-by-id for full credential fields
    let missing = connector.requiredFields.filter(f => !credentials[f])
    if (missing.length > 0 && credentialId) {
      try {
        // VAULT-P6.D: org_id threaded (closes P6-F1) — see note above.
        const byIdResp = await fetch(`${AUTH_BASE_URL}/api/setup/internal/resolve-by-id`, {
          method: 'POST',
          headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ credential_id: credentialId, org_id: orgId || null }),
          signal: AbortSignal.timeout(5000),
        })
        if (byIdResp.ok) {
          const byIdData = await byIdResp.json()
          // Use full decrypted fields if available (multi-field connectors)
          if (byIdData.fields && typeof byIdData.fields === 'object') {
            for (const field of missing) {
              if (byIdData.fields[field]) {
                credentials[field] = byIdData.fields[field]
              }
            }
          }
          // Fallback: map generic key to api_key/token field
          if (byIdData.key) {
            for (const field of missing) {
              if ((field === 'api_key' || field === 'token') && !credentials[field]) {
                credentials[field] = byIdData.key
              }
            }
          }
        }
      } catch (e) {
        // Fall through
      }
      missing = connector.requiredFields.filter(f => !credentials[f])
    }

    if (missing.length > 0) {
      return { error: `Missing credential fields for ${connectorId}: ${missing.join(', ')}` }
    }

    // scopeReason says whether this credential was chosen FOR the repo or
    // merely fell through to the org default. Carried out so the caller can
    // log it and name it in an error, rather than a silent fallback looking
    // exactly like a deliberate match.
    return {
      credentials,
      credentialId,
      scopeReason: providerData.scopeReason || null,
      credentialLabel: providerData.credentialLabel || null,
      repo,
    }
  } catch (err) {
    return { error: `Credential resolution failed for ${connectorId}: ${err.message}` }
  }
}

/**
 * Load connector module (cached).
 *
 * CONNFAC Phase 1: a registry entry is either kind:'module' (a hand-written
 * connectors/types/*.js) or kind:'declarative' (a Connector Spec v1 document
 * executed by declarativeRuntime.buildConnector). Both produce the same
 * `{ getTools(credentials) }` object, so everything below this function is
 * identical for the two shapes — and both are cached the same way.
 */
function loadConnectorModule(connectorId) {
  if (_modules.has(connectorId)) return _modules.get(connectorId)

  const connector = getConnector(connectorId)
  if (!connector) throw new Error(`Unknown connector: ${connectorId}`)

  try {
    let mod
    if (connector.kind === 'declarative') {
      const spec = connector.spec || JSON.parse(fs.readFileSync(path.resolve(__dirname, connector.specFile), 'utf8'))
      mod = buildConnector(spec)
    } else {
      mod = require(connector.module)
    }
    _modules.set(connectorId, mod)
    return mod
  } catch (err) {
    throw new Error(`Failed to load connector module ${connectorId}: ${err.message}`)
  }
}

/**
 * Activate a connector for an org — resolves credentials, loads module, pools instance.
 * Returns the instance or an error.
 */
async function activateConnector(orgId, connectorId, opts = {}) {
  // #481: pool per repo, not just per org+connector. Two repos in one org can
  // legitimately need two different credentials, and a shared pool entry would
  // serve the first repo's token to the second for the whole idle window.
  const repo = typeof opts.repo === 'string' && opts.repo.trim() ? opts.repo.trim().toLowerCase() : ''

  // Check pool first
  const existing = pool.getInstance(orgId, connectorId, repo)
  if (existing) return { instance: existing }

  // Resolve credentials
  const resolved = await resolveConnectorCredentials(orgId, connectorId, { repo })
  if (resolved.error) return { error: resolved.error }

  // Load module
  let mod
  try {
    mod = loadConnectorModule(connectorId)
  } catch (err) {
    return { error: err.message }
  }

  // Get tools from module
  const tools = mod.getTools(resolved.credentials)

  // Create instance
  const instance = {
    connectorId,
    orgId,
    credentials: resolved.credentials,
    credentialId: resolved.credentialId,
    credentialLabel: resolved.credentialLabel || null,
    scopeReason: resolved.scopeReason || null,
    repo: repo || null,
    module: mod,
    tools,
  }

  pool.setInstance(orgId, connectorId, instance, repo)
  // Name the credential and WHY it was chosen. "org-default" against a named
  // repo is the shape that files an issue with a token that cannot see it.
  const scope = repo
    ? ` repo=${repo} credential=${resolved.credentialLabel || resolved.credentialId || 'unknown'} via=${resolved.scopeReason || 'unknown'}`
    : ''
  console.log(`[ConnectorBridge] Activated ${connectorId} for org=${orgId} (${tools.length} tools)${scope}`)

  return { instance }
}

/**
 * Execute a connector tool.
 * This is the main entry point called by agentTools.js.
 *
 * @param {string} orgId - Organization ID
 * @param {string} connectorId - Connector ID (e.g., 'github')
 * @param {string} toolName - Tool name (e.g., 'list_repos')
 * @param {Object} input - Tool input parameters
 * @param {Object} context - Execution context (agent_id, corr, etc.)
 * @returns {Object} Tool result
 */
async function executeConnectorTool(orgId, connectorId, toolName, input, context = {}) {
  const startTime = Date.now()

  // QUOXON-PRIVACY: repo gate for issue filing at THE shared choke, so the
  // GRIPE agent, the github proxy and fleet hosts all hit one rule. Public
  // quoxai repos need context.humanConfirmedPublic, set only by server-side
  // human paths; model-supplied tool input (incl. confirm_public) never counts.
  if (connectorId === 'github' && toolName === 'create_issue' && input && typeof input.repo === 'string') {
    const gate = require('../gripeRepoPolicy').evaluateGripeFiling({
      repo: input.repo, title: input.title, body: input.body,
      humanConfirmedPublic: context && context.humanConfirmedPublic === true,
    })
    if (!gate.ok) {
      console.warn(`[ConnectorBridge] gripe repo gate blocked ${input.repo}: ${gate.error}`)
      return { success: false, error: gate.error, message: gate.message, ...(gate.patterns ? { patterns: gate.patterns } : {}), duration_ms: Date.now() - startTime }
    }
  }

  // QUOXTRUST T9/D4 (finding 5.1) — GOV-4 org governance/safety policy, enforced
  // FIRST at THE shared connector choke so it covers every caller (agent
  // executeTool, the direct POST /connectors/:c/tools/:t/execute route, and the
  // gripe handler) and takes precedence over entitlement/rate (an org's "never do
  // X" deny must hold even for an unlicensed capability). Same reference monitor
  // the native tool path uses; keyed on the full `${connectorId}_${toolName}` so a
  // policy written against the agent-facing tool name matches here too. Deps come
  // from approvalGate (already required lazily below for withApprovalGate). No
  // policy store wired → no-op (allow), so bridge unit tests are unaffected.
  {
    const referenceMonitor = require('../referenceMonitor')
    const { checkStorePolicies, isSafeUnderPolicyOutage, createApprovalRequest } = require('../approvalGate')
    const gov = await referenceMonitor.mediateGovernancePolicy(`${connectorId}_${toolName}`, input, {
      orgId: context.orgId || orgId,
      agentId: context.agentId,
      // QUOXTRUST T-AUTH (C1): the toolResume trusted handoff must reach the
      // monitor on the CONNECTOR path too — this minimal ctx rebuild otherwise
      // strands a resumed connector approval at a re-carding loop. (The native
      // path passes the full ctx through executeTool.) NOTE codex M1: the
      // canonical action is still not built on this path — WP2/WP3 scope.
      _claimedApproval: context._claimedApproval,
    }, { checkStorePolicies, isSafeUnderPolicyOutage, createApprovalRequest })
    if (gov.outcome !== referenceMonitor.OUTCOME.ALLOW) {
      // QUOXTRUST WP3.5 (D4): witness the refusal on the connector path too.
      _emitConnectorEvidence({
        connectorId, toolName, input, context,
        durationMs: Date.now() - startTime, success: false,
        error: gov.response?.error || gov.response?.message || `policy_${gov.outcome}`,
        disposition: 'denied',
      })
      return { ...gov.response, connector: connectorId, tool: toolName, duration_ms: Date.now() - startTime }
    }
  }

  // LICENSE-LAUNCH LL-6d C5 — governed-capability entitlement gate. This is the
  // shared choke EVERY path to a connector tool crosses (agentTools.executeTool,
  // fleetGripeHandler, the generic /connectors execute endpoint), so gating here
  // covers them all — including agents with no AGENT_REQUIRES_PLUGIN entry (BOB).
  // Enforced BEFORE activateConnector so an unentitled org never even resolves
  // vault credentials. Fail CLOSED: a lookup that throws denies.
  const requiredPlugin = getRequiredPluginForCapability(connectorId, toolName)
  if (requiredPlugin) {
    const gateOrg = orgId || 'default'
    let licensed = false
    try {
      licensed = await isPluginLicensed(gateOrg, requiredPlugin)
    } catch (_) {
      licensed = false // fail closed
    }
    if (!licensed) {
      console.warn(`[ConnectorBridge] LICENSE denied: ${connectorId}/${toolName} requires the '${requiredPlugin}' entitlement (org=${gateOrg})`)
      return {
        success: false,
        error: `The ${connectorId}/${toolName} capability requires the '${requiredPlugin}' entitlement, which this organization does not hold`,
        licenseRequired: true,
        plugin: requiredPlugin,
        connector: connectorId,
        tool: toolName,
        duration_ms: Date.now() - startTime,
      }
    }
  }

  // CONNFAC Phase 0 — rate limit BEFORE activateConnector, so a throttled call
  // never resolves vault credentials and never reaches the provider.
  const throttled = _checkRateLimit(orgId, connectorId)
  if (throttled) {
    console.warn(`[ConnectorBridge] RATE LIMITED: ${connectorId}/${toolName} for org=${orgId || 'default'} (retry in ${throttled.retry_after_ms}ms)`)
    return {
      success: false,
      error: 'rate_limited',
      rate_limited: true,
      connector: connectorId,
      tool: toolName,
      retry_after_ms: throttled.retry_after_ms,
      duration_ms: Date.now() - startTime,
    }
  }

  // #481: the tool input is where the repository lives (github_create_issue
  // takes `repo` as "owner/name"), so this is the only point in the chain that
  // knows which repo a credential is being asked to reach.
  const repo = input && typeof input.repo === 'string' ? input.repo : null

  // Activate connector (from pool or fresh)
  const { instance, error } = await activateConnector(orgId, connectorId, { repo })
  if (error) {
    return { success: false, error, duration_ms: Date.now() - startTime }
  }

  // Find the tool
  const tool = instance.tools.find(t => t.name === toolName)
  if (!tool) {
    return {
      success: false,
      error: `Tool ${toolName} not found in connector ${connectorId}`,
      available_tools: instance.tools.map(t => t.name),
      duration_ms: Date.now() - startTime,
    }
  }

  const runTool = async (execInput) => {
    // QUOXTRUST T3 (D3 durability) — durable execution intent for consequential
    // external effects. Broadened 2026-09-28 (WP2 gauge-A lever): EVERY connector
    // call is by definition outward to a provider, so any EFFECT-VERB-named
    // connector tool (lib/effectVerbs.js, the same classifier the w-t9 coverage
    // invariant sweeps) claims durable intent — not only the requiresApproval
    // subset. Read-verb connector tools (get/list/search) stay unledgered.
    // Crash mid-send leaves outcome_unknown (never a silent loss or blind retry).
    const { isEffectVerbName } = require('../effectVerbs.js')
    const ledgerOn = !!_ledgerDb && (tool.requiresApproval === true || isEffectVerbName(toolName))
    let intentId = null
    if (ledgerOn) {
      try {
        intentId = executionLedger.claim(_ledgerDb, {
          orgId: context.orgId || orgId,
          tool: `${connectorId}_${toolName}`,
          actionDigest: executionLedger.actionDigest(execInput),
          corr: context.corr || context.session_id || null,
        })
        executionLedger.markDispatched(_ledgerDb, intentId)
      } catch (ledgerErr) {
        // NO DISPATCH WITHOUT DURABLE INTENT — the store is configured but could
        // not record this effect; refuse rather than fire it unrecorded.
        console.error(`[ConnectorBridge] execution ledger write failed for ${connectorId}/${toolName}; failing closed:`, ledgerErr.message)
        return {
          success: false,
          error: 'execution_ledger_unavailable: the durable record could not be written, so this effect was not dispatched',
          durability: 'refused',
          connector: connectorId,
          tool: toolName,
          duration_ms: Date.now() - startTime,
        }
      }
    }

    // VOLT: record credential access (fire-and-forget)
    if (_voltRecord) {
      try {
        _voltRecord('credential.accessed', {
          connector: connectorId,
          tool: toolName,
          credential_id: instance.credentialId,
          agent_id: context.agentId || 'system',
          org_id: context.orgId,
          corr: context.corr || context.session_id,
        })
      } catch (_) { /* VOLT never blocks execution */ }
    }

    // Execute with error isolation
    try {
      const result = await tool.execute(execInput, instance.credentials, context)
      const duration_ms = Date.now() - startTime

      // T3: settle the durable intent (best-effort; a failed resolve leaves the
      // row 'dispatched' → reconcileOnBoot marks it outcome_unknown, which is the
      // safe reading, never a silent success).
      if (ledgerOn) { try { executionLedger.resolve(_ledgerDb, intentId, true) } catch (_) { /* reconcile covers it */ } }

      // VOLT: record tool execution (fire-and-forget)
      if (_voltRecord) {
        try {
          _voltRecord('tool.call.executed', {
            connector: connectorId,
            tool: `${connectorId}_${toolName}`,
            agent_id: context.agentId || 'system',
            org_id: context.orgId,
            corr: context.corr || context.session_id,
            success: true,
            duration_ms,
          })
        } catch (_) { /* VOLT never blocks execution */ }
      }

      // QUOXTRUST D6/T9 — AEE/WARD per-tool receipt (parity with the native choke).
      _emitConnectorEvidence({ connectorId, toolName, input: execInput, context, durationMs: duration_ms, success: true })

      return {
        success: true,
        result,
        connector: connectorId,
        tool: toolName,
        credentialId: instance.credentialId,
        duration_ms,
      }
    } catch (err) {
      const duration_ms = Date.now() - startTime
      console.error(`[ConnectorBridge] Tool ${connectorId}/${toolName} failed:`, err.message)

      // T3: settle a thrown effect as failed. This is correct for the common case
      // (pre-send errors: connection refused, auth, validation). RESIDUAL, honestly
      // noted: a timeout AFTER the bytes hit the wire is genuinely ambiguous and is
      // recorded here as failed rather than outcome_unknown — distinguishing
      // provider-accepted from rejected needs per-provider error classification
      // (the plan's "separate accepted/provider-accepted/delivered"), deferred. A
      // process CRASH mid-send is the case reconcileOnBoot already flags unknown.
      if (ledgerOn) { try { executionLedger.resolve(_ledgerDb, intentId, false, err) } catch (_) { /* reconcile covers it */ } }

      // VOLT: record tool failure (fire-and-forget)
      if (_voltRecord) {
        try {
          _voltRecord('tool.call.executed', {
            connector: connectorId,
            tool: `${connectorId}_${toolName}`,
            agent_id: context.agentId || 'system',
            org_id: context.orgId,
            corr: context.corr || context.session_id,
            success: false,
            error: err.message,
            duration_ms,
          })
        } catch (_) { /* VOLT never blocks execution */ }
      }

      // QUOXTRUST D6/T9 — AEE/WARD per-tool receipt on failure too (a failed
      // execution is witnessed, not silent). Parity with the native choke.
      _emitConnectorEvidence({ connectorId, toolName, input: execInput, context, durationMs: duration_ms, success: false, error: err.message })

      // #481: a 403/404 from the provider when the credential was NOT chosen for
      // this repo is almost always the wrong-token case, and the bare provider
      // error sends the reader to check permissions on GitHub instead of the one
      // fact that explains it. Say which credential was used and why it was
      // picked. Only added when a repo was actually named and the choice was a
      // fallback, so a genuinely-scoped failure keeps the clean message.
      let error = err.message
      if (repo && instance.scopeReason === 'org-default' && /\b(403|404|not found|permission|forbidden)\b/i.test(err.message)) {
        error = `${err.message} (used the org DEFAULT ${connectorId} credential`
          + `${instance.credentialLabel ? ` "${instance.credentialLabel}"` : ''}, which is not scoped to ${repo}. `
          + `If a different credential covers that repo, add ${repo} to its repositories.)`
      }

      return {
        success: false,
        error,
        connector: connectorId,
        tool: toolName,
        repo: repo || undefined,
        credentialId: instance.credentialId,
        scopeReason: instance.scopeReason || undefined,
        duration_ms,
      }
    }
  }

  // LI-OVERHAUL P4 — per-tool HITL gate at the shared choke. A connector tool
  // statically marked requiresApproval in its own definition (linkedin
  // publish_post / create_comment first) must file a human approval before it
  // executes, on EVERY path that crosses this function (agentTools.executeTool,
  // the generic /connectors/:c/tools/:t/execute endpoint, fleetGripeHandler).
  // withApprovalGate owns the whole lifecycle: it verifies _approvalId +
  // _resumeToken with an input-fingerprint bind on resume, and
  // ctx._connectorRequiresApproval makes the gate MANDATORY in checkApproval —
  // without it a flagged tool would execute ungated whenever no org policy
  // happens to match (the approvalGate.js:501/:651 finding).
  if (tool.requiresApproval) {
    const { withApprovalGate } = require('../approvalGate')
    const { _approvalId, _resumeToken, ...cleanInput } = input || {}
    // P9: the connector's own approvalCard(input) supplies the human-facing
    // title/body and the typed payload the inbox renders; a card builder that
    // throws must never block the gate itself (the generic card still works).
    let approvalCard = null
    if (typeof tool.approvalCard === 'function') {
      try { approvalCard = tool.approvalCard(cleanInput) } catch (_) { approvalCard = null }
    }
    return withApprovalGate(`${connectorId}_${toolName}`, input || {}, () => runTool(cleanInput), {
      agentId: context.agentId,
      orgId: orgId || context.orgId || 'default',
      corr: context.corr,
      _connectorRequiresApproval: true,
      _connectorApprovalCard: approvalCard,
    })
  }

  return runTool(input)
}

/**
 * Get all available connector tools for an org.
 * Checks which connectors have credentials in the vault and returns
 * their tool definitions. Used for dynamic tool registration.
 *
 * QUOXON A2 (latency): this is on every chat turn for agents with connector
 * families, often several times per turn. It used to POST /internal/resolve
 * once PER REGISTERED CONNECTOR (222 sequential round trips, 1.7 to 3.2 s per
 * call). Now:
 *   - one batched resolve call per rebuild (the endpoint takes a providers list)
 *   - a per-org cache with a short TTL, keyed strictly by orgId
 *   - single-flight per org, so concurrent turns share one rebuild
 *   - explicit invalidation: deactivateConnector, the internal invalidate route
 *     (auth calls it whenever its credential resolver cache is cleared, i.e. on
 *     every vault credential write), or invalidateAvailableToolsCache()
 *   - failure accounting (Loop & Restart Hygiene): a failed rebuild is counted
 *     and logged, serves the last good value for at most STALE_MAX_MS, backs
 *     off before retrying, and with nothing good to serve it THROWS. An empty
 *     list here would read as "this org has no connectors", which is a lie
 *     when the vault is down.
 *
 * @param {string} orgId
 * @param {{ meta?: object }} [opts] meta, when given, is filled with
 *   { cache: 'hit'|'miss'|'shared'|'stale', ms } for the per-turn timing log.
 */
const TOOLS_CACHE_TTL_MS = 60_000
const TOOLS_CACHE_STALE_MAX_MS = 10 * 60_000
const TOOLS_REBUILD_BACKOFF_BASE_MS = 5_000
const TOOLS_REBUILD_BACKOFF_MAX_MS = 60_000
const TOOLS_BYID_CONCURRENCY = 8

// orgKey -> { tools, builtAt, failures, nextRetryAt, lastError }
const _toolsCache = new Map()
// orgKey -> Promise (single-flight)
const _toolsInflight = new Map()
// orgKey -> generation; bumped by invalidation so an overtaken rebuild is not stored
const _toolsGen = new Map()
let _toolsGenAll = 0
const _toolsStats = { hits: 0, misses: 0, shared: 0, rebuilds: 0, rebuildFailures: 0, staleServed: 0, invalidations: 0 }

function _orgKey(orgId) {
  return String(orgId || 'default')
}

function _genOf(key) {
  return `${_toolsGenAll}:${_toolsGen.get(key) || 0}`
}

async function _rebuildAvailableTools(orgId) {
  const entries = Object.entries(CONNECTOR_REGISTRY)
  const providers = [...new Set(entries.map(([, c]) => c.credentialType).filter(Boolean))]

  const resp = await fetch(`${AUTH_BASE_URL}/api/setup/internal/resolve`, {
    method: 'POST',
    headers: buildInternalServiceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ org_id: orgId || 'default', providers }),
    signal: AbortSignal.timeout(10_000),
  })
  // An error body is not data: a non-2xx is a failed rebuild, not "no connectors".
  if (!resp.ok) throw new Error(`vault resolve returned ${resp.status}`)
  const data = await resp.json()
  const providerMap = (data && typeof data.providers === 'object' && data.providers) || {}

  // Per-connector extraction. Only connectors that need the resolve-by-id
  // fallback make a further call, so this is bounded and normally zero.
  const results = new Array(entries.length)
  let next = 0
  async function worker() {
    while (next < entries.length) {
      const i = next++
      const [connectorId, connector] = entries[i]
      const providerData = providerMap[connector.credentialType]
      if (!providerData) continue
      results[i] = await _credentialsFromProviderData(orgId, connectorId, connector, providerData)
    }
  }
  await Promise.all(Array.from({ length: TOOLS_BYID_CONCURRENCY }, worker))

  const tools = []
  for (let i = 0; i < entries.length; i++) {
    const resolved = results[i]
    if (!resolved || resolved.error) continue // No credentials -> skip
    const [connectorId, connector] = entries[i]
    try {
      const mod = loadConnectorModule(connectorId)
      for (const tool of mod.getTools(resolved.credentials)) {
        tools.push({
          name: `${connectorId}_${tool.name}`,
          description: `[${connector.name}] ${tool.description}`,
          input_schema: tool.input_schema,
          connector: connectorId,
          connectorName: connector.name,
          category: connector.category,
        })
      }
    } catch (err) {
      // A broken module must not hide the others, but it must not be silent either.
      console.warn(`[ConnectorBridge] tools for ${connectorId} unavailable (org=${orgId}): ${err.message}`)
    }
  }
  return tools
}

async function getAvailableTools(orgId, opts = {}) {
  const t0 = Date.now()
  const meta = opts && typeof opts.meta === 'object' && opts.meta ? opts.meta : {}
  const key = _orgKey(orgId)
  const now = Date.now()
  const entry = _toolsCache.get(key)

  if (entry && entry.tools && now - entry.builtAt < TOOLS_CACHE_TTL_MS) {
    _toolsStats.hits++
    meta.cache = 'hit'
    meta.ms = Date.now() - t0
    return entry.tools.slice()
  }

  // Backing off after a failed rebuild: serve the bounded stale value, or the error.
  if (entry && entry.nextRetryAt && now < entry.nextRetryAt) {
    if (entry.tools && now - entry.builtAt < TOOLS_CACHE_STALE_MAX_MS) {
      _toolsStats.staleServed++
      meta.cache = 'stale'
      meta.ms = Date.now() - t0
      return entry.tools.slice()
    }
    throw new Error(`connector tools unavailable for org=${key}: ${entry.lastError || 'rebuild failed'}`)
  }

  if (_toolsInflight.has(key)) {
    _toolsStats.shared++
    const tools = await _toolsInflight.get(key)
    meta.cache = 'shared'
    meta.ms = Date.now() - t0
    return tools.slice()
  }

  _toolsStats.misses++
  const gen = _genOf(key)
  const p = (async () => {
    _toolsStats.rebuilds++
    try {
      const tools = await _rebuildAvailableTools(orgId)
      if (_genOf(key) === gen) {
        _toolsCache.set(key, { tools, builtAt: Date.now(), failures: 0, nextRetryAt: 0, lastError: null })
      }
      return tools
    } catch (err) {
      _toolsStats.rebuildFailures++
      const prev = _toolsCache.get(key)
      const failures = (prev?.failures || 0) + 1
      const backoff = Math.min(TOOLS_REBUILD_BACKOFF_BASE_MS * 2 ** (failures - 1), TOOLS_REBUILD_BACKOFF_MAX_MS)
      const keep = prev?.tools && _genOf(key) === gen && Date.now() - prev.builtAt < TOOLS_CACHE_STALE_MAX_MS
      _toolsCache.set(key, {
        tools: keep ? prev.tools : null,
        builtAt: keep ? prev.builtAt : 0,
        failures,
        nextRetryAt: Date.now() + backoff,
        lastError: err.message,
      })
      if (keep) {
        _toolsStats.staleServed++
        console.warn(`[ConnectorBridge] tools rebuild failed for org=${key} (failure ${failures}, retry in ${backoff}ms): ${err.message}; serving last good list (${prev.tools.length} tools, age ${Date.now() - prev.builtAt}ms)`)
        return prev.tools
      }
      console.warn(`[ConnectorBridge] tools rebuild failed for org=${key} (failure ${failures}, retry in ${backoff}ms): ${err.message}; no good list to serve`)
      throw new Error(`connector tools unavailable for org=${key}: ${err.message}`)
    } finally {
      _toolsInflight.delete(key)
    }
  })()
  _toolsInflight.set(key, p)
  const tools = await p
  meta.cache = 'miss'
  meta.ms = Date.now() - t0
  return tools.slice()
}

/**
 * Drop the cached connector tool list for one org, or for every org when
 * orgId is omitted. A rebuild already in flight is not stored.
 */
function invalidateAvailableToolsCache(orgId) {
  _toolsStats.invalidations++
  if (orgId === undefined || orgId === null || orgId === '') {
    _toolsGenAll++
    _toolsCache.clear()
    return
  }
  const key = _orgKey(orgId)
  _toolsGen.set(key, (_toolsGen.get(key) || 0) + 1)
  _toolsCache.delete(key)
}

function _resetAvailableToolsCache() {
  _toolsCache.clear()
  _toolsInflight.clear()
  _toolsGen.clear()
  _toolsGenAll = 0
  for (const k of Object.keys(_toolsStats)) _toolsStats[k] = 0
}

/**
 * Deactivate a connector for an org (e.g., credential rotation)
 */
function deactivateConnector(orgId, connectorId) {
  pool.removeInstance(orgId, connectorId)
  invalidateAvailableToolsCache(orgId)
  console.log(`[ConnectorBridge] Deactivated ${connectorId} for org=${orgId}`)
}

/**
 * Get bridge status (for monitoring)
 */
function getBridgeStatus() {
  return {
    registeredConnectors: Object.keys(CONNECTOR_REGISTRY).length,
    loadedModules: _modules.size,
    pool: pool.getPoolStatus(),
    toolsCache: { ..._toolsStats, orgs: _toolsCache.size, inflight: _toolsInflight.size, ttlMs: TOOLS_CACHE_TTL_MS },
  }
}

/**
 * Initialize the bridge — start pool cleanup
 */
function initBridge({ voltRecord, ledgerDb, auditEnvelope } = {}) {
  if (voltRecord && typeof voltRecord === 'function') {
    _voltRecord = voltRecord
  }
  if (ledgerDb) {
    _ledgerDb = ledgerDb
  }
  if (auditEnvelope && typeof auditEnvelope === 'function') {
    _auditEnvelope = auditEnvelope
  }
  pool.startCleanup()
  console.log(`[ConnectorBridge] Initialized (${Object.keys(CONNECTOR_REGISTRY).length} connectors registered, VOLT=${_voltRecord ? 'on' : 'off'}, T3-ledger=${_ledgerDb ? 'on' : 'off'}, AEE=${_auditEnvelope ? 'on' : 'off'})`)
}

/**
 * Shutdown the bridge
 */
function shutdownBridge() {
  pool.clearAll()
  _resetAvailableToolsCache()
  _modules.clear()
  console.log('[ConnectorBridge] Shutdown complete')
}

module.exports = {
  activateConnector,
  deactivateConnector,
  executeConnectorTool,
  getAvailableTools,
  invalidateAvailableToolsCache,
  _resetAvailableToolsCache,
  getBridgeStatus,
  initBridge,
  shutdownBridge,
  resolveConnectorCredentials,
  loadConnectorModule,
  _resetRateLimiter,
  _emitConnectorEvidence, // QUOXTRUST D6 — exported for the connector-evidence unit test
}

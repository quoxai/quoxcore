/**
 * License Validator Service
 *
 * Provides Ed25519 signature verification for Quox licenses.
 *
 * LE-3a: the gating authority is the server-side entitlement set, fetched
 * from GET /api/setup/licensing/entitlements (auth service, backed by the
 * quox.ai account-linked lease system — see docs/STREAM_LICENSE_ENFORCE.md
 * §11). On login, entitlements are fetched and cached in a module variable.
 * All runtime checks (isPluginLicensed, hasTier, getLicenseTiers,
 * getLicenseStatus) read from this cache.
 *
 * There is no localStorage fallback. If the server hasn't been queried,
 * all plugins (including free ones) read as unentitled. This is
 * intentional — it makes failures visible instead of masking them, and it
 * fails closed rather than open.
 *
 * The legacy single-license cache (setServerLicense/getStoredLicense/
 * fetchInstanceLicensing/storeLicense/clearLicense) is kept for backward
 * compatibility with the instance-license PUT/DELETE flow but no longer
 * gates anything.
 */

import { queueSync } from './serverSyncQueue'

// Embedded Ed25519 public key — LE-3.0 dev licensing keypair (private half
// only in quox-website api/.env). The previous key (2J4YMI3c…) is RETIRED:
// its private half sat loose on the dev box. Prod mints its own at cutover.
const PUBLIC_KEY_BASE64 = '/BHDWJ2RPT6UmwnCB2z9CJZ+oJhhYgRkMEc/ZrtYFWw='

// SECURITY (LE-AUDIT defense-in-depth): field-format allowlist mirroring the
// auth-service verifier's malformed_field defense
// (services/auth/lib/licenseVerify.js, docs/STREAM_LICENSE_ENFORCE.md §11.1).
// The signed payloads built below (buildSignedData / the plugin-license
// equivalent) are naive concatenations of client-visible license fields with
// NO delimiter at all — the same class of ambiguous-field-boundary risk that
// made the `|`-joined server lease payload forgeable. Restricting every
// signed field to a safe charset before trusting the Ed25519 signature
// closes that class of attack here too, as defense-in-depth alongside the
// server-side gate (this validator is not itself the security boundary —
// the server entitlement set is — but it must not be trivially foolable).
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,100}$/
const SAFE_SCOPE_RE = /^plugin:[A-Za-z0-9._-]{1,90}$/
const SAFE_ENTITLEMENT_RE = /^[A-Za-z0-9._@=-]{1,64}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

function isSafeId(v) {
  return typeof v === 'string' && SAFE_ID_RE.test(v)
}
function isSafeScope(v) {
  return typeof v === 'string' && SAFE_SCOPE_RE.test(v)
}
function isCleanIsoDate(v) {
  return typeof v === 'string' && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v))
}
function areSafeEntitlements(a) {
  return Array.isArray(a) && a.every(e => typeof e === 'string' && SAFE_ENTITLEMENT_RE.test(e))
}

// Plugin to tier mapping — NON-GATING as of LE-3a, and as of LICENSE-LAUNCH
// LL-4c an explicit FALLBACK rather than the answer.
//
// The AUTHORITY for what tier a product is, is the signed product catalogue
// generated on quox.ai (LL-4a), verified at auth-service startup
// (services/auth/lib/signedCatalog.js) and served to this client as `catalog`
// on GET /api/setup/licensing/entitlements (LL-4c). getPluginTier() below
// prefers it and only reads this map when the server sends no catalogue — an
// older auth service, or a box where the owner has not installed the artifact
// yet. The switchover is therefore automatic, with no frontend release.
//
// This list is kept because SOMETHING has to label a plugin pre-cutover, but it
// is drift by construction: it names 33 ids while the authority lists 60, so
// anything added after it was written (qlarity, quoxplan, quoxsignal …) has no
// entry here at all. Do not extend it — extend the catalogue on quox.ai.
const PLUGIN_TIERS = {
  'core': 'free',
  'noc': 'free',
  'advanced-memory': 'tier_b',
  'advanced-voice': 'tier_a',
  'visualizations': 'tier_a',
  'soc': 'tier_b',
  'prometheus': 'tier_a',
  'grafana': 'free',
  'proxmox': 'tier_b',
  'quoxagent-fleet': 'tier_b',
  'cognitive-topology': 'tier_b',
  'files': 'tier_a',
  'aocl-compliance-suite': 'tier_c',
  'aocl-developer-kit': 'free',
  'backup-restore': 'tier_a',
  'core-comms': 'tier_a',
  'mikrotik-routeros': 'tier_b',
  'web-terminal': 'tier_b',
  'action-tracker': 'tier_a',
  'wazuh': 'tier_b',
  'uptime-kuma': 'tier_a',
  'bastion-fleet': 'tier_b',
  'opsdeck': 'tier_a',
  'docker-fleet': 'tier_b',
  'decision-evidence': 'tier_c',
  'linkedin': 'tier_a',
  'facebook': 'tier_a',
  'instagram': 'tier_a',
  'tiktok': 'tier_a',
  'youtube': 'tier_a',
  'github': 'tier_b',
  'system-maintenance': 'free',
  'quoxmind-pro': 'tier_b',
  'quoxmind-complete': 'tier_c',
  'quox-nucleus': 'tier_b',
  'quox-brain2': 'tier_b'
}

// Tier hierarchy (higher includes lower) — NON-GATING as of LE-3a, see
// PLUGIN_TIERS comment above. Retained for hasTier()'s tiers-union math.
const TIER_HIERARCHY = {
  'free': 0,
  'tier_a': 1,
  'tier_b': 2,
  'tier_c': 3
}

// ── Entitlement Cache (LE-3a) ───────────────────────────────────────────────
// Populated once on login from GET /api/setup/licensing/entitlements.
// This is now the gating authority: isPluginLicensed/hasTier/getLicenseTiers/
// getLicenseStatus all read from here, NOT from the legacy single-license
// cache below. Fail closed — until loaded, everything reads as unentitled.
let _entitlementSet = new Set()
let _licensesList = []
let _tiersUnion = new Set()
let _entitlementsLoaded = false
// QTG-PRO: the licence-governed plugin universe as served by the auth
// service (single source of truth: LICENSE_GOVERNED_PLUGINS). null until a
// server payload includes it, in which case the gate stays strictly
// entitlement-based (old-server behaviour, fail closed).
let _governedSet = null
// LICENSE-LAUNCH LL-3b: per-plugin org-band state for org-scoped grants
// (`<pluginId>@orgs=N`), served alongside the flat set. `{}` when the server
// sends none (older auth service) — the gate then keeps its old flat
// behaviour rather than locking everything out.
let _orgBands = {}
// The org context the entitlements response was RESOLVED FOR (server-side
// req.org.id). null for an instance-scoped caller.
let _callerOrgId = null
// LICENSE-LAUNCH LL-4c: pluginId -> tier, from the SIGNED product catalogue the
// auth service serves alongside the entitlements. Empty when the server sends
// none (older auth service, or no snapshot installed yet), in which case
// getPluginTier() reads the PLUGIN_TIERS fallback above.
let _catalogTiers = new Map()

/**
 * Set the server-fetched entitlements into the module cache.
 * @param {{entitlements?: string[], licenses?: Array<{license_id: string, entitlements?: string[], plans?: string[], tiers?: string[], expires_at?: string, lease_expires_at?: string}>, instance_id?: string, governed?: string[], org_bands?: Record<string, {allowance: number, assigned_orgs: string[], assigned_count: number, org_licensed: boolean|null}>, org_id?: string|null}} data
 */
export function setEntitlements(data) {
  const entitlements = Array.isArray(data?.entitlements) ? data.entitlements : []
  _entitlementSet = new Set(entitlements)
  _governedSet = Array.isArray(data?.governed) ? new Set(data.governed) : null
  _orgBands = (data?.org_bands && typeof data.org_bands === 'object') ? data.org_bands : {}
  _callerOrgId = data?.org_id ?? null
  // LL-4c: rows are display metadata ({id, tier, category, sellable}). A row
  // with no id or no tier is skipped rather than poisoning the map — a
  // malformed catalogue must degrade to the fallback list, never blank every
  // tier label in the UI.
  _catalogTiers = new Map()
  if (Array.isArray(data?.catalog)) {
    for (const row of data.catalog) {
      if (!row || typeof row.id !== 'string' || !row.tier) continue
      _catalogTiers.set(row.id, row.tier)
    }
  }
  _licensesList = Array.isArray(data?.licenses) ? data.licenses : []
  _tiersUnion = new Set()
  for (const lic of _licensesList) {
    if (Array.isArray(lic?.tiers)) {
      for (const t of lic.tiers) _tiersUnion.add(t)
    }
  }
  _entitlementsLoaded = true
  // LL-7 reactivity (MED defect): gating views read the synchronous
  // isPluginLicensed at mount and never re-check, so a POST-MOUNT entitlement
  // refresh (org switch, late fetch) leaves them stale — showing the
  // "Activate plugin" gate on an entitled plugin. Broadcast a window event so
  // usePluginLicensed() subscribers re-check. Guarded for non-DOM (test/SSR)
  // callers. This is the ONLY writer of the cache reachable by the app; the
  // shared bundle instance is the same one, so a bundle-rendered view's
  // listener fires too.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event('quox-entitlements-changed'))
  }
}

/**
 * Clear the entitlement cache (e.g. on logout). Falls back to fail-closed
 * (empty set) until the next successful fetchEntitlements().
 */
export function clearEntitlements() {
  _entitlementSet = new Set()
  _governedSet = null
  _orgBands = {}
  _callerOrgId = null
  _catalogTiers = new Map()
  _licensesList = []
  _tiersUnion = new Set()
  _entitlementsLoaded = false
}

/**
 * LICENSE-LAUNCH LL-4c: the tier a plugin is sold at, for DISPLAY.
 *
 * The signed product catalogue served by the auth service wins; PLUGIN_TIERS is
 * the fallback for a server that sends none. Returns null when neither knows
 * the id — an honest "no tier" rather than a guess (callers that need a
 * default apply their own, e.g. pluginClient.getPluginTier).
 *
 * Non-gating, like everything tier-shaped here: the gate is
 * isPluginLicensed()'s server entitlement set.
 * @param {string} pluginName
 * @returns {string|null}
 */
export function getPluginTier(pluginName) {
  return _catalogTiers.get(pluginName) ?? PLUGIN_TIERS[pluginName] ?? null
}

/**
 * LL-3b: the org-band state for one plugin, for UI copy that wants to explain
 * WHY an org-scoped plugin is locked ("1 of 1 seats in use"). Null for a
 * whole-install grant, an unlicensed plugin, or an older server that sends no
 * bands — callers must treat null as "no band, use the flat state".
 * @param {string} pluginName
 * @returns {{allowance: number, assigned_orgs: string[], assigned_count: number, org_licensed: boolean|null}|null}
 */
export function getOrgBand(pluginName) {
  return _orgBands?.[pluginName] ?? null
}

/**
 * LL-3b: the org the cached entitlements were resolved for (server-side
 * req.org.id), or null for an instance-scoped session.
 * @returns {string|null}
 */
export function getCallerOrgId() {
  return _callerOrgId
}

/**
 * Fetch entitlements from the server and populate the module cache.
 * Called once on login from AuthContext. NOT fire-and-forget — must be
 * awaited (same contract as the legacy fetchInstanceLicensing below).
 * @param {Function} fetchFn - fetch function (with credentials)
 * @returns {Promise<Object>} raw entitlements response
 */
export async function fetchEntitlements(fetchFn, { retries = 3, backoffMs = 500, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  // Resilient load: a transient network/5xx blip must not leave the cache
  // empty, which would make every plugin-gated sidebar item vanish
  // (isPluginLicensed fails closed). Retry on network errors and 5xx; do NOT
  // retry a 4xx (auth/authz answer is authoritative — no entitlements is a
  // valid state, not a failure to paper over).
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchFn('/api/setup/licensing/entitlements', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setEntitlements(data)
        return data
      }
      // 4xx is authoritative — stop, do not retry.
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Entitlements fetch failed: HTTP ${res.status}`)
      }
      lastErr = new Error(`Entitlements fetch failed: HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
      // A 4xx already threw above with this exact message — don't retry it.
      if (/HTTP 4\d\d/.test(err.message)) throw err
    }
    if (attempt < retries) await sleep(backoffMs * (attempt + 1))
  }
  throw lastErr
}

/**
 * First license_id in the entitlement cache, for telemetry use only
 * (heartbeatService's Bearer identity). Not a gating check.
 * @returns {string|null}
 */
export function getFirstLicenseId() {
  return _licensesList[0]?.license_id ?? null
}

// ── Legacy Server License Cache (pre-LE-3a) ─────────────────────────────────
// Populated once on login from GET /api/setup/licensing.
// No longer the gating authority (see Entitlement Cache above) — kept for
// backward compatibility (storeLicense/activateLicense/clearLicense/the
// PUT/DELETE flows are unaffected by the entitlement switch).
let _serverLicenseCache = null
let _serverLicenseLoaded = false

/**
 * Set the server-fetched license into module cache.
 * Pass null to indicate the server has no license (free tier).
 * @param {Object|null} license
 */
export function setServerLicense(license) {
  _serverLicenseCache = license
  _serverLicenseLoaded = true
}

/**
 * Clear the server license cache (e.g. on logout).
 */
export function clearServerLicense() {
  _serverLicenseCache = null
  _serverLicenseLoaded = false
}

/**
 * Fetch instance licensing from server and populate module cache.
 * Called once on login from AuthContext. NOT fire-and-forget — must be awaited.
 * @param {Function} fetchFn - fetch function (with credentials)
 * @returns {Promise<Object|null>} licensing data or null
 */
export async function fetchInstanceLicensing(fetchFn) {
  const res = await fetchFn('/api/setup/licensing', { credentials: 'include' })
  if (!res.ok) throw new Error(`Licensing fetch failed: HTTP ${res.status}`)
  const data = await res.json()
  if (data.licensing?.license) {
    setServerLicense(data.licensing.license)
  } else {
    setServerLicense(null)
  }
  return data.licensing
}

// Check if Web Crypto Ed25519 is supported
let ed25519Supported = null

async function checkEd25519Support() {
  if (ed25519Supported !== null) return ed25519Supported

  try {
    // Try to generate a test key to check support
    await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      false,
      ['sign', 'verify']
    )
    ed25519Supported = true
  } catch (err) {
    console.warn('[LicenseValidator] Ed25519 not supported in this browser:', err.message)
    ed25519Supported = false
  }

  return ed25519Supported
}

/**
 * Decode base64 string to Uint8Array
 */
function base64ToBytes(base64) {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

/**
 * Build the canonical signed data (must match Go implementation exactly)
 * Format: ID + CustomerID + JSON(Tiers) + ExpiresAt(ISO8601)
 */
function buildSignedData(license) {
  // Ensure tiers is an array
  const tiers = Array.isArray(license.tiers) ? license.tiers : []

  // JSON stringify tiers (Go uses json.Marshal which produces compact JSON)
  const tiersJSON = JSON.stringify(tiers)

  // Format expires_at as ISO8601 (Go uses RFC3339 which is compatible)
  const expiresAt = new Date(license.expires_at).toISOString()

  // Concatenate exactly as Go does
  const data = license.id + license.customer_id + tiersJSON + expiresAt

  return data
}

/**
 * Verify Ed25519 signature using Web Crypto API
 */
async function verifySignature(license) {
  // Decode public key
  const publicKeyBytes = base64ToBytes(PUBLIC_KEY_BASE64)

  // Import public key
  const publicKey = await crypto.subtle.importKey(
    'raw',
    publicKeyBytes,
    { name: 'Ed25519' },
    false,
    ['verify']
  )

  // Decode signature
  const signatureBytes = base64ToBytes(license.signature)

  // Build signed data
  const signedData = buildSignedData(license)
  const dataBytes = new TextEncoder().encode(signedData)

  // Verify
  const isValid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    signatureBytes,
    dataBytes
  )

  return isValid
}

/**
 * Validate a license object
 * @param {Object|string} licenseInput - License object or JSON string
 * @returns {Promise<{valid: boolean, error?: string, license?: Object, trial?: boolean}>}
 */
export async function validateLicense(licenseInput) {
  try {
    // Parse if string
    let license = licenseInput
    if (typeof licenseInput === 'string') {
      // Trim whitespace
      const trimmed = licenseInput.trim()

      // Check if it looks like JSON
      if (!trimmed.startsWith('{')) {
        return {
          valid: false,
          error: 'Invalid license format. Please paste the complete license key (starts with { and ends with })'
        }
      }

      try {
        license = JSON.parse(trimmed)
      } catch (e) {
        return {
          valid: false,
          error: 'Invalid license format: the license key appears corrupted. Please copy the entire key from your email.'
        }
      }
    }

    // Check required fields
    const requiredFields = ['id', 'customer_id', 'signature', 'expires_at']
    const missingFields = requiredFields.filter(f => !license[f])
    if (missingFields.length > 0) {
      return {
        valid: false,
        error: `Invalid license: missing required fields (${missingFields.join(', ')}). Please use the complete license key.`
      }
    }

    // Check expiration
    const expiresAt = new Date(license.expires_at)
    if (isNaN(expiresAt.getTime())) {
      return { valid: false, error: 'Invalid license: invalid expiration date' }
    }

    if (expiresAt < new Date()) {
      const expiredDate = expiresAt.toLocaleDateString()
      return { valid: false, error: `License expired on ${expiredDate}. Please purchase a new license.` }
    }

    // LE-AUDIT defense-in-depth: reject any signed field outside its safe
    // charset before the signature is ever trusted. See SAFE_ID_RE comment
    // above for why this mirrors the server-side malformed_field defense.
    if (!isSafeId(license.id) || !isSafeId(license.customer_id) ||
        !areSafeEntitlements(Array.isArray(license.tiers) ? license.tiers : []) ||
        !isCleanIsoDate(license.expires_at)) {
      return { valid: false, error: 'malformed_field' }
    }

    // LE-3b: no forgery-accepting shortcuts. Every license must carry a
    // real Ed25519 signature that verifies against the embedded public
    // key — no TRIAL_KEY_FOR_TESTING marker, no trusted `HMAC:` prefix,
    // no unverified-on-unsupported-browser fallback. See
    // docs/STREAM_LICENSE_ENFORCE.md §2.1 for the forgery this closes.
    const hasEd25519 = await checkEd25519Support()
    if (!hasEd25519) {
      return {
        valid: false,
        error: 'This browser cannot verify licence signatures. Use a current browser to activate.'
      }
    }

    // Verify Ed25519 signature
    const isSignatureValid = await verifySignature(license)
    if (!isSignatureValid) {
      return { valid: false, error: 'Invalid license signature. The license key may be corrupted.' }
    }

    return {
      valid: true,
      license,
      message: 'License validated successfully'
    }

  } catch (err) {
    console.error('[LicenseValidator] Validation error:', err)
    return { valid: false, error: `Validation error: ${err.message}` }
  }
}

/**
 * Store a validated license on the server (instance_config).
 * Fails if the server write fails — no silent fallback.
 * @param {Object} license - The validated license object
 * @param {Function} authFetch - Authenticated fetch function
 */
export async function storeLicense(license, authFetch) {
  const res = await authFetch('/api/setup/licensing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license })
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || `Server returned ${res.status}`)
  }

  setServerLicense(license)
  console.log('[LicenseValidator] License stored on server for', license.customer_name)
  return { stored: true }
}

/**
 * Get the stored license from localStorage
 * @returns {Object|null} The stored license or null
 */
export function getStoredLicense() {
  // Module cache only — populated on login from GET /api/setup/licensing.
  // Returns null if not yet loaded (free tier until server responds).
  return _serverLicenseLoaded ? _serverLicenseCache : null
}

/**
 * Clear the license on server and in module cache.
 * @param {Function} authFetch - Authenticated fetch function
 */
export async function clearLicense(authFetch) {
  const res = await authFetch('/api/setup/licensing', { method: 'DELETE' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || `Server returned ${res.status}`)
  }
  clearServerLicense()
  // Re-mark as loaded with null (free tier, not "unknown")
  _serverLicenseLoaded = true
  console.log('[LicenseValidator] License cleared')
  return true
}

/**
 * Check if the stored license is valid (exists and not expired)
 * @returns {Promise<boolean>}
 */
export async function isLicenseValid() {
  const license = getStoredLicense()
  if (!license) return false

  const result = await validateLicense(license)
  return result.valid
}

/**
 * Get the licensed tiers, derived from the entitlement cache (LE-3a).
 * licenses[] don't carry per-plugin tiers on the money path — this is the
 * union of any `tiers` fields present on cached licenses, for legacy plan
 * mapping (requirePlan routes) display only. Always includes 'free'.
 * @returns {string[]} Array of tier strings, always includes 'free'
 */
export function getLicenseTiers() {
  return ['free', ..._tiersUnion]
}

/**
 * Check if a specific tier is licensed, derived from the entitlement
 * cache's tiers union (LE-3a). Non-gating display metadata — see
 * PLUGIN_TIERS/TIER_HIERARCHY comment below.
 * @param {string} tier - The tier to check (e.g., 'tier_b')
 * @returns {boolean}
 */
export function hasTier(tier) {
  if (tier === 'free') return true

  if (_tiersUnion.has(tier)) return true

  // Check tier hierarchy (higher tiers include lower)
  const requiredLevel = TIER_HIERARCHY[tier] || 0
  for (const licensedTier of _tiersUnion) {
    const licensedLevel = TIER_HIERARCHY[licensedTier] || 0
    if (licensedLevel >= requiredLevel) return true
  }

  return false
}

/**
 * Check if a specific plugin is licensed. Reads the server-side entitlement
 * set (LE-3a) — the gating authority. `core` (the shell itself) is always
 * entitled so the app can boot to accept a key.
 * QTG-PRO: mirrors the backend hasPlugin() semantics exactly. A plugin
 * OUTSIDE the licence-governed universe (served alongside the entitlements
 * by the auth service) is not licence-governed and always passes; a plugin
 * inside it requires an explicit entitlement. When the server payload does
 * not include the governed list (older auth service), or entitlements are
 * not loaded yet, everything non-core reads as unentitled (fail closed).
 * @param {string} pluginName - The plugin name (e.g., 'advanced-memory')
 * @returns {boolean}
 */
export function isPluginLicensed(pluginName) {
  if (pluginName === 'core') return true
  // LICENSE-LAUNCH LL-3b: an org-scoped grant (`<pluginId>@orgs=N`) is in the
  // flat entitlement set for the whole INSTALL, but licenses only N orgs. The
  // flat check above therefore showed every org on a multi-org install as
  // licensed, and an excess org only discovered otherwise as a 402 at its
  // public embed. When the server sends a band for this plugin, that band is
  // the answer: it mirrors hasPlugin()'s org-slot semantics, including
  // failing closed (org_licensed === null) when the session carries no org
  // context — exactly as hasPlugin(db, id, undefined) does.
  const band = _orgBands?.[pluginName]
  if (band) return band.org_licensed === true
  if (_entitlementSet.has(pluginName)) return true
  if (_governedSet && !_governedSet.has(pluginName)) return true
  return false
}

/**
 * Explain WHY a plugin is or is not licensed, mirroring isPluginLicensed()'s
 * decision order exactly (so `.licensed` here always equals isPluginLicensed()).
 * The gate was previously a bare boolean, so a blocked plugin page could only
 * say "Activate" with no reason — an org-capped or org-less denial looked
 * identical to an unpurchased one. This surfaces the real cause and the numbers
 * behind it (org slots used vs allowance) so the UI can tell the user what to do.
 * @param {string} pluginName
 * @returns {{ licensed: boolean, code: 'ok'|'loading'|'no_org'|'org_cap'|'org_unassigned'|'unlicensed', title: string, detail: string, used?: number, cap?: number, orgId?: string|null }}
 */
export function getPluginLicenseDiagnosis(pluginName) {
  if (pluginName === 'core') return { licensed: true, code: 'ok', title: 'Active', detail: '' }
  if (!_entitlementsLoaded) {
    return { licensed: false, code: 'loading', title: 'Checking licence', detail: 'Your entitlements have not loaded yet. This should resolve in a moment.' }
  }
  const band = _orgBands?.[pluginName]
  if (band) {
    if (band.org_licensed === true) return { licensed: true, code: 'ok', title: 'Active', detail: '' }
    const used = Number.isInteger(band.assigned_count) ? band.assigned_count : (Array.isArray(band.assigned_orgs) ? band.assigned_orgs.length : 0)
    const cap = Number.isInteger(band.allowance) ? band.allowance : used
    if (!_callerOrgId) {
      return {
        licensed: false, code: 'no_org', orgId: null, used, cap,
        title: 'No organisation in this session',
        detail: 'This plugin is licensed per organisation, but your current session is not carrying an active org, so the licence cannot be matched. Switch organisation (or sign in again) to attach one.'
      }
    }
    if (used >= cap) {
      return {
        licensed: false, code: 'org_cap', orgId: _callerOrgId, used, cap,
        title: `Organisation licence limit reached (${used}/${cap})`,
        detail: `Your licence covers ${cap} organisation${cap === 1 ? '' : 's'} for this plugin, and all ${cap} slots are in use by other organisations. This organisation is not one of them. Raise the org allowance on your licence to add it.`
      }
    }
    return {
      licensed: false, code: 'org_unassigned', orgId: _callerOrgId, used, cap,
      title: 'Organisation not assigned a slot',
      detail: `Your licence has free slots (${used}/${cap} used) but this organisation has not claimed one. It should claim automatically; if this persists, the slot assignment is stuck and needs a reconcile.`
    }
  }
  if (_entitlementSet.has(pluginName)) return { licensed: true, code: 'ok', title: 'Active', detail: '' }
  if (_governedSet && !_governedSet.has(pluginName)) return { licensed: true, code: 'ok', title: 'Active', detail: '' }
  return {
    licensed: false, code: 'unlicensed', title: 'Not included in your licence',
    detail: 'This plugin is part of the licence-governed set but your current licence carries no entitlement for it.'
  }
}

/**
 * LICENSE-LAUNCH LL-6d (C2 class-complete): is this plugin part of the
 * licence-governed universe the auth service served (LICENSE_GOVERNED_PLUGINS)?
 *
 * Used by the client cache-activation gate to distinguish a plugin that MUST
 * clear isPluginLicensed() before activating from cache (governed) from one that
 * is free to activate offline (a custom org upload, or anything when the server
 * sent no governed list). Returns false when the governed universe is unknown
 * (older auth service, or entitlements not fetched yet) so the gate never fires
 * on a guess — the server-filtered /me/plugins list + purge remain the primary
 * boundary for the boot path.
 * @param {string} pluginName
 * @returns {boolean}
 */
export function isGovernedPlugin(pluginName) {
  return _governedSet ? _governedSet.has(pluginName) : false
}

/**
 * QMH-5/2: highest QuoxMind tier currently licensed for this org.
 * Used by the topology UI to pick the right `tierBehavior` copy and to
 * decide whether a metric's `requiresPlugin` gate triggers.
 *
 * The `check` parameter lets unit tests inject a stub instead of
 * mocking module bindings (which doesn't work for same-module callers).
 *
 * @param {object} [opts]
 * @param {(plugin: string) => boolean} [opts.check] - injected license check
 * @returns {'free' | 'pro' | 'complete'}
 */
export function getActiveQuoxMindTier({ check = isPluginLicensed } = {}) {
  if (check('quoxmind-complete')) return 'complete'
  if (check('quoxmind-pro')) return 'pro'
  return 'free'
}

/**
 * Get license status summary for UI, derived from the entitlement cache
 * (LE-3a) — licensed = entitlement set non-empty; expires_at = earliest
 * expiry across cached licenses.
 * @returns {Object} License status info
 */
export function getLicenseStatus() {
  if (!_entitlementsLoaded || _entitlementSet.size === 0) {
    return {
      valid: true,
      licensed: false,
      tiers: ['free'],
      message: 'No license installed'
    }
  }

  // Earliest expiry across all cached licenses
  let earliestExpiresAt = null
  for (const lic of _licensesList) {
    if (!lic?.expires_at) continue
    const d = new Date(lic.expires_at)
    if (isNaN(d.getTime())) continue
    if (!earliestExpiresAt || d < earliestExpiresAt) earliestExpiresAt = d
  }

  if (earliestExpiresAt && earliestExpiresAt < new Date()) {
    return {
      valid: true,
      licensed: false,
      expired: true,
      tiers: ['free'],
      message: 'License has expired',
      expires_at: earliestExpiresAt.toISOString()
    }
  }

  const result = {
    valid: true,
    licensed: true,
    tiers: getLicenseTiers(),
    message: `Licensed (${_entitlementSet.size} entitlement${_entitlementSet.size === 1 ? '' : 's'})`
  }

  if (earliestExpiresAt) {
    result.expires_at = earliestExpiresAt.toISOString()
    result.days_remaining = Math.ceil((earliestExpiresAt - new Date()) / (1000 * 60 * 60 * 24))
  }

  return result
}

/**
 * Activate a license (validate and store on server)
 * @param {string} licenseKey - License JSON string
 * @param {Function} authFetch - Authenticated fetch function
 * @returns {Promise<{success: boolean, error?: string, license?: Object}>}
 */
export async function activateLicense(licenseKey, authFetch) {
  const result = await validateLicense(licenseKey)

  if (!result.valid) {
    return { success: false, error: result.error }
  }

  try {
    await storeLicense(result.license, authFetch)
  } catch (err) {
    return { success: false, error: `Failed to save license: ${err.message}` }
  }

  return {
    success: true,
    license: result.license,
    trial: result.trial,
    message: result.message
  }
}

// ── Per-plugin license support (third-party plugins) ──────────────────────
//
// Server-backed as of this fix (mirrors the instance-license pattern above):
// GET/PUT/DELETE /api/setup/plugin-licenses[/:pluginId], stored in
// instance_config on the auth service (instance-wide, same as the instance
// license). localStorage is now a FALLBACK ONLY — used if the server hasn't
// been fetched yet or is unreachable — never the primary store. This is
// additive/non-breaking: existing localStorage data keeps working as a
// fallback, and callers that don't pass an authFetch still get a
// best-effort server write via the plain `fetch` used elsewhere in this
// codebase for credentialed requests (see thirdPartyPluginHost.js).

const PLUGIN_LICENSE_STORAGE_KEY = 'quox-plugin-licenses'
// H1 fix: guards the one-time upload of pre-existing localStorage-only
// plugin licenses to the server, so a licensed instance whose
// instance_config row was never populated (existing installs, before the
// server-backed plugin-license table shipped) gets durably migrated
// exactly once rather than re-PUT on every login.
const PLUGIN_LICENSE_MIGRATED_KEY = 'quox-plugin-licenses-migrated'

// Embedded Ed25519 public key for plugin licenses (same key or separate — configurable)
const PLUGIN_LICENSE_PUBLIC_KEY = PUBLIC_KEY_BASE64

// ── Server plugin-license cache ─────────────────────────────────────────
// Populated on login from GET /api/setup/plugin-licenses (mirrors
// _serverLicenseCache above). null/not-loaded falls back to localStorage.
let _serverPluginLicensesCache = null
let _serverPluginLicensesLoaded = false

/**
 * Set the server-fetched plugin licenses into the module cache.
 * @param {Object<string, {key: string, license: Object}>} licenses
 */
export function setServerPluginLicenses(licenses) {
  _serverPluginLicensesCache = licenses || {}
  _serverPluginLicensesLoaded = true
}

/**
 * Clear the server plugin-license cache (e.g. on logout). Falls back to
 * localStorage again until the next successful fetch.
 */
export function clearServerPluginLicenses() {
  _serverPluginLicensesCache = null
  _serverPluginLicensesLoaded = false
}

/**
 * Fetch all plugin licenses from server and populate the module cache.
 * Called once on login from AuthContext, alongside fetchInstanceLicensing.
 * @param {Function} fetchFn - fetch function (with credentials)
 * @returns {Promise<Object>} licenses map (pluginId -> {license, ...})
 */
export async function fetchPluginLicenses(fetchFn) {
  const res = await fetchFn('/api/setup/plugin-licenses', { credentials: 'include' })
  if (!res.ok) throw new Error(`Plugin licenses fetch failed: HTTP ${res.status}`)
  const data = await res.json()
  const licenses = data.licenses || {}
  setServerPluginLicenses(licenses)
  // H1: best-effort, non-blocking — upload any pre-existing localStorage-only
  // licenses to the (possibly empty, on an un-migrated instance) server table.
  // Never awaited by the caller and never throws — a slow/unreachable server
  // must not delay login. See migrateLocalPluginLicensesToServer().
  migrateLocalPluginLicensesToServer(licenses)
  return licenses
}

/**
 * Read the raw localStorage plugin-license map, ignoring the server cache
 * entirely. Internal helper — used by getStoredPluginLicenses() (merge) and
 * migrateLocalPluginLicensesToServer() (diff against server).
 * @returns {Object<string, {key: string, license: Object}>}
 */
function readLocalPluginLicenses() {
  try {
    const stored = localStorage.getItem(PLUGIN_LICENSE_STORAGE_KEY)
    if (!stored) return {}
    return JSON.parse(stored)
  } catch {
    return {}
  }
}

/**
 * Get all stored plugin licenses — the UNION of the server cache and
 * localStorage.
 *
 * H1 fix: on any existing instance the new server-backed `instance_config`
 * `plugin-license.%` table is empty (no migration of pre-existing
 * localStorage licenses ran before this fix shipped). Previously this
 * function returned the server cache ALONE once loaded, so an empty server
 * response (`{}`) silently shadowed a user's working localStorage licenses,
 * making previously-licensed third-party plugins read as UNLICENSED after
 * the next login. Now: server entries are authoritative on conflict (a
 * pluginId present on both sides uses the server's copy — the durable,
 * cross-device source of truth), but a pluginId present ONLY in
 * localStorage is never dropped — it keeps working until (or unless) it is
 * migrated up to the server by migrateLocalPluginLicensesToServer().
 * @returns {Object<string, {key: string, license: Object}>}
 */
export function getStoredPluginLicenses() {
  const local = readLocalPluginLicenses()
  if (!_serverPluginLicensesLoaded) return local

  return { ...local, ..._serverPluginLicensesCache }
}

/**
 * H1 fix: one-time migration of pre-existing localStorage-only plugin
 * licenses up to the server, so they become durably server-persisted
 * (the actual point of the server-backed plugin-license table) instead of
 * living only in the browser that happened to activate them.
 *
 * Runs after every successful fetchPluginLicenses() call, but is guarded by
 * a `migrated` flag in localStorage so it only ever uploads once per
 * browser — it must not re-PUT a license the user deliberately removed
 * (removePluginLicense() already deletes both sides) on every subsequent
 * login.
 *
 * Best-effort: failures are logged, never thrown, and never block the
 * caller (fetchPluginLicenses is not awaiting this) — mirrors
 * putPluginLicenseOnServer()'s existing "additive, not blocking" contract.
 * @param {Object<string, {key: string, license: Object}>} serverLicenses - the just-fetched server cache
 */
async function migrateLocalPluginLicensesToServer(serverLicenses) {
  try {
    if (localStorage.getItem(PLUGIN_LICENSE_MIGRATED_KEY) === '1') return

    const local = readLocalPluginLicenses()
    const localOnlyIds = Object.keys(local).filter(id => !serverLicenses?.[id] && local[id]?.license)

    for (const pluginId of localOnlyIds) {
      const result = await putPluginLicenseOnServer(pluginId, local[pluginId].license)
      if (result.ok) {
        console.log(`[LicenseValidator] Migrated localStorage-only plugin license for ${pluginId} to server`)
      } else {
        console.warn(`[LicenseValidator] Migration: failed to persist localStorage license for ${pluginId} to server: ${result.error}`)
      }
    }

    // Mark migrated even on partial/total failure — this is a best-effort,
    // fire-once upload; a transient server outage shouldn't turn into a
    // login-time PUT storm on every subsequent session. Licenses that
    // failed to migrate simply remain localStorage-only (still honoured by
    // the union in getStoredPluginLicenses()) until the user re-activates
    // them, which PUTs again via activatePluginLicense().
    localStorage.setItem(PLUGIN_LICENSE_MIGRATED_KEY, '1')
  } catch (err) {
    console.error('[LicenseValidator] Plugin license migration failed:', err.message)
  }
}

/**
 * Save plugin licenses to localStorage (fallback) and update the in-memory
 * server cache optimistically. Does NOT perform the server write itself —
 * callers that mutate a single plugin's license (activatePluginLicense,
 * removePluginLicense) also PUT/DELETE against the server; this function
 * only persists the merged local view.
 */
function savePluginLicenses(licenses) {
  try {
    localStorage.setItem(PLUGIN_LICENSE_STORAGE_KEY, JSON.stringify(licenses))
    queueSync('pluginLicenses', licenses)
  } catch (err) {
    console.error('[LicenseValidator] Failed to save plugin licenses:', err)
  }
  // Keep the server cache (if loaded) in sync with the optimistic local write
  // so isThirdPartyPluginLicensed() reflects the change immediately, without
  // waiting for a re-fetch.
  if (_serverPluginLicensesLoaded) {
    _serverPluginLicensesCache = licenses
  }
}

/**
 * PUT a single plugin's license to the server (authoritative store).
 * Best-effort: failures are logged but do not throw — the localStorage
 * write in savePluginLicenses() remains the fallback so activation still
 * works if the server is briefly unreachable (mirrors "additive, not
 * blocking" instruction; unlike the instance license's storeLicense(),
 * which does throw on failure — plugin licenses keep the softer contract
 * they already had pre-fix).
 * @param {string} pluginId
 * @param {Object} license - validated license object
 */
async function putPluginLicenseOnServer(pluginId, license) {
  try {
    const res = await fetch(`/api/setup/plugin-licenses/${encodeURIComponent(pluginId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license })
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      console.error(`[LicenseValidator] Server rejected plugin license for ${pluginId}:`, err.message || res.status)
      return { ok: false, error: err.message || `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    console.error(`[LicenseValidator] Failed to reach server for plugin license ${pluginId}:`, err.message)
    return { ok: false, error: err.message }
  }
}

/**
 * DELETE a single plugin's license from the server.
 * Best-effort, same rationale as putPluginLicenseOnServer.
 * @param {string} pluginId
 */
async function deletePluginLicenseOnServer(pluginId) {
  try {
    const res = await fetch(`/api/setup/plugin-licenses/${encodeURIComponent(pluginId)}`, {
      method: 'DELETE',
      credentials: 'include'
    })
    if (!res.ok) {
      console.error(`[LicenseValidator] Server rejected plugin license removal for ${pluginId}: HTTP ${res.status}`)
      return { ok: false }
    }
    return { ok: true }
  } catch (err) {
    console.error(`[LicenseValidator] Failed to reach server to remove plugin license ${pluginId}:`, err.message)
    return { ok: false, error: err.message }
  }
}

/**
 * Validate a plugin-scoped license key.
 * Verifies Ed25519 signature, checks scope matches pluginId, checks expiry.
 *
 * @param {string} pluginId - The plugin this license should be for
 * @param {Object|string} licenseInput - License object or JSON string
 * @returns {Promise<{valid: boolean, error?: string, license?: Object}>}
 */
export async function validatePluginLicense(pluginId, licenseInput) {
  try {
    let license = licenseInput
    if (typeof licenseInput === 'string') {
      const trimmed = licenseInput.trim()
      if (!trimmed.startsWith('{')) {
        return { valid: false, error: 'Invalid license format. Paste the complete JSON license key.' }
      }
      try {
        license = JSON.parse(trimmed)
      } catch {
        return { valid: false, error: 'Invalid JSON in license key.' }
      }
    }

    // Check required fields
    const required = ['id', 'customer_id', 'signature', 'expires_at', 'scope']
    const missing = required.filter(f => !license[f])
    if (missing.length > 0) {
      return { valid: false, error: `Missing fields: ${missing.join(', ')}` }
    }

    // Check scope matches plugin
    const expectedScope = `plugin:${pluginId}`
    if (license.scope !== expectedScope) {
      return { valid: false, error: `License scope mismatch: expected ${expectedScope}, got ${license.scope}` }
    }

    // Check expiry
    const expiresAt = new Date(license.expires_at)
    if (isNaN(expiresAt.getTime())) {
      return { valid: false, error: 'Invalid expiration date' }
    }
    if (expiresAt < new Date()) {
      return { valid: false, error: `Plugin license expired on ${expiresAt.toLocaleDateString()}` }
    }

    // LE-AUDIT defense-in-depth: same field-format allowlist as
    // validateLicense above, applied to this scope-based signed payload.
    if (!isSafeId(license.id) || !isSafeId(license.customer_id) ||
        !isSafeScope(license.scope) || !isCleanIsoDate(license.expires_at)) {
      return { valid: false, error: 'malformed_field' }
    }

    // LE-3b: no forgery-accepting shortcuts, same as validateLicense above.
    const hasEd25519 = await checkEd25519Support()
    if (!hasEd25519) {
      return {
        valid: false,
        error: 'This browser cannot verify licence signatures. Use a current browser to activate.'
      }
    }

    // Build signed data for plugin licenses: id + customer_id + scope + expires_at
    const signedData = license.id + license.customer_id + license.scope + license.expires_at
    const dataBytes = new TextEncoder().encode(signedData)

    const publicKeyBytes = base64ToBytes(PLUGIN_LICENSE_PUBLIC_KEY)
    const publicKey = await crypto.subtle.importKey(
      'raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']
    )
    const signatureBytes = base64ToBytes(license.signature)
    const isValid = await crypto.subtle.verify('Ed25519', publicKey, signatureBytes, dataBytes)

    if (!isValid) {
      return { valid: false, error: 'Invalid license signature.' }
    }

    return { valid: true, license }
  } catch (err) {
    return { valid: false, error: `Validation error: ${err.message}` }
  }
}

/**
 * Activate a plugin license (validate, store on server, mirror to localStorage).
 * The server PUT is authoritative (survives browser clears/new devices);
 * the localStorage write remains as a fallback. Server write is best-effort
 * (does not throw) so activation still succeeds locally if the server is
 * briefly unreachable — see putPluginLicenseOnServer().
 * @param {string} pluginId
 * @param {string} licenseKey - JSON string
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function activatePluginLicense(pluginId, licenseKey) {
  const result = await validatePluginLicense(pluginId, licenseKey)
  if (!result.valid) {
    return { success: false, error: result.error }
  }

  const serverResult = await putPluginLicenseOnServer(pluginId, result.license)

  const licenses = getStoredPluginLicenses()
  // MED fix (LE-AUDIT): `verified: true` is set ONLY here, at the moment
  // validatePluginLicense() has just confirmed a real Ed25519 signature.
  // isThirdPartyPluginLicensed() below trusts ONLY entries carrying this
  // flag — an attacker hand-editing localStorage['quox-plugin-licenses']
  // cannot set it (this module's exports never let a caller write it
  // directly), so a forged/unsigned entry reads as unlicensed.
  licenses[pluginId] = { key: licenseKey, license: result.license, verified: true }
  savePluginLicenses(licenses)

  if (!serverResult.ok) {
    console.warn(`[LicenseValidator] Plugin license for ${pluginId} activated locally but NOT persisted to server: ${serverResult.error}`)
  } else {
    console.log(`[LicenseValidator] Plugin license activated for ${pluginId}`)
  }
  return { success: true, license: result.license }
}

/**
 * Shared scope + expiry check for a plugin-license entry (`{key, license}`).
 * Does NOT check the signature — callers are responsible for only handing
 * this entries whose provenance is already trusted (see
 * isThirdPartyPluginLicensed below).
 * @param {{license?: Object}} entry
 * @param {string} pluginId
 * @returns {boolean}
 */
function pluginLicenseEntryLooksValid(entry, pluginId) {
  if (!entry || !entry.license) return false
  const expiresAt = new Date(entry.license.expires_at)
  if (expiresAt < new Date()) return false
  if (entry.license.scope !== `plugin:${pluginId}`) return false
  return true
}

/**
 * Check if a third-party plugin has a valid license. LE-3a: checks the
 * server entitlement set first (gating authority); falls back to the
 * existing per-plugin scope system for custom/third-party uploads that
 * aren't part of a quox.ai entitlement grant.
 *
 * MED fix (LE-AUDIT): this used to also trust a raw localStorage entry
 * whose scope + expiry merely LOOKED right, with no signature verification
 * at all — an attacker could hand-edit `quox-plugin-licenses` in DevTools
 * ({license:{scope:'plugin:x', expires_at:'2099-...'}}) and unlock a paid
 * plugin for free. Since this function is synchronous and Ed25519 verify is
 * async, it cannot re-verify here — instead:
 *   - the SERVER cache (`_serverPluginLicensesCache`, populated only from a
 *     GET to the auth service) is trusted as-is, same as before this fix —
 *     a hand-edited localStorage value can never masquerade as server data;
 *   - a LOCALSTORAGE-ONLY entry is trusted ONLY if it carries
 *     `verified: true`, a flag written exclusively by
 *     activatePluginLicense() at the moment it actually confirmed a real
 *     Ed25519 signature via validatePluginLicense(). A forged/hand-edited
 *     entry never carries that flag and reads as unlicensed.
 * @param {string} pluginId
 * @returns {boolean}
 */
export function isThirdPartyPluginLicensed(pluginId) {
  // LL-3b: the quox.ai entitlement branch is org-aware for the same reason
  // isPluginLicensed() is — an org-scoped grant covers N orgs, not the whole
  // install. A band that excludes this org falls through to the per-plugin
  // license paths below rather than short-circuiting to licensed.
  const band = _orgBands?.[pluginId]
  if (band ? band.org_licensed === true : _entitlementSet.has(pluginId)) return true

  if (_serverPluginLicensesLoaded) {
    const serverEntry = _serverPluginLicensesCache?.[pluginId]
    if (pluginLicenseEntryLooksValid(serverEntry, pluginId)) return true
  }

  const localEntry = readLocalPluginLicenses()[pluginId]
  if (localEntry?.verified === true && pluginLicenseEntryLooksValid(localEntry, pluginId)) return true

  return false
}

/**
 * Remove a stored plugin license (localStorage + best-effort server DELETE).
 * Kept synchronous (fire-and-forget server call, like queueSync above) so
 * existing callers that don't await this keep working unchanged.
 * @param {string} pluginId
 */
export function removePluginLicense(pluginId) {
  const licenses = getStoredPluginLicenses()
  delete licenses[pluginId]
  savePluginLicenses(licenses)
  deletePluginLicenseOnServer(pluginId).catch(() => { /* already logged inside */ })
}

// Export tier mapping for use in other modules
export { PLUGIN_TIERS, TIER_HIERARCHY }

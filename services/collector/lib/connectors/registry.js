/**
 * Connector Registry
 *
 * Maps vault credential types to connector configurations.
 * Each connector defines its tools, required credential fields,
 * and the module that implements tool execution.
 *
 * Wave 1: GitHub, Jira, Notion, Linear (config-only)
 *
 * CONNFAC Phase 1: hand-written modules (kind:'module') and declarative
 * Connector Specs (kind:'declarative', discovered from specs/) share one map.
 */

const fs = require('node:fs')
const path = require('node:path')
const { validateSpec } = require('./specSchema')

const CONNECTOR_REGISTRY = {
  github: {
    id: 'github',
    name: 'GitHub',
    category: 'developer',
    credentialType: 'github',
    requiredFields: ['token'],
    module: './types/github.js',
    description: 'GitHub repositories, issues, pull requests, and actions',
    docs: 'https://docs.github.com/en/rest',
    rateLimit: { windowMs: 60_000, max: 30 },
    kind: 'module',
  },

  jira: {
    id: 'jira',
    name: 'Jira',
    category: 'project_management',
    credentialType: 'jira',
    requiredFields: ['token', 'endpoint_url'],
    module: './types/jira.js',
    description: 'Jira issues, projects, sprints, and boards',
    docs: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    rateLimit: { windowMs: 60_000, max: 20 },
    kind: 'module',
  },

  notion: {
    id: 'notion',
    name: 'Notion',
    category: 'files_knowledge',
    credentialType: 'notion',
    requiredFields: ['token'],
    module: './types/notion.js',
    description: 'Notion pages, databases, and blocks',
    docs: 'https://developers.notion.com/',
    rateLimit: { windowMs: 60_000, max: 20 },
    kind: 'module',
  },

  linear: {
    id: 'linear',
    name: 'Linear',
    category: 'project_management',
    credentialType: 'linear',
    requiredFields: ['token'],
    module: './types/linear.js',
    description: 'Linear issues, projects, cycles, and teams',
    docs: 'https://developers.linear.app/docs/graphql/working-with-the-graphql-api',
    rateLimit: { windowMs: 60_000, max: 20 },
    kind: 'module',
  },

  tailscale: {
    id: 'tailscale',
    name: 'Tailscale',
    category: 'cloud_hosting',
    credentialType: 'tailscale',
    requiredFields: ['api_key', 'tailnet'],
    module: './types/tailscale.js',
    description: 'Tailscale mesh VPN — devices, routes, keys, DNS, ACLs, audit',
    docs: 'https://tailscale.com/api',
    rateLimit: { windowMs: 60_000, max: 30 },
    kind: 'module',
  },

  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    category: 'marketing_email',
    credentialType: 'linkedin',
    requiredFields: ['access_token'],
    module: './types/linkedin.js',
    description: 'LinkedIn posts, engagement, and organisation pages',
    docs: 'https://learn.microsoft.com/en-us/linkedin/',
    rateLimit: { windowMs: 60_000, max: 20 },
    kind: 'module',
  },

  // FB-1: registry id is 'facebook_pages', NOT 'facebook' — a bare 'facebook'
  // id would prefix-collide with the pre-existing 'facebook_ads' declarative
  // spec (specs/facebook_ads.connector.json, Meta Ads, out of this plugin's
  // organic-only scope), and connector-vs-connector prefix collisions are an
  // UNCONDITIONAL registry failure (registry.js validateConnectorNamespace)
  // that can never be allowlisted. The plugin entitlement id stays 'facebook'
  // (see bridge.js CAPABILITY_REQUIRES_PLUGIN) — only the connector/tool-name
  // prefix changed.
  facebook_pages: {
    id: 'facebook_pages',
    name: 'Facebook Pages',
    category: 'social',
    credentialType: 'meta',
    requiredFields: ['access_token'],
    module: './types/facebook.js',
    description: 'Facebook Pages (organic): reads, insights, leads, and governed publishing',
    docs: 'https://developers.facebook.com/docs/graph-api/',
    rateLimit: { windowMs: 60_000, max: 20 },
    kind: 'module',
  },

  // IG-1: Instagram professional accounts, reached via the linked Facebook
  // Page using the SAME 'meta' vault credential as facebook_pages. Plain id
  // 'instagram' is safe here (no pre-existing 'instagram_*' declarative spec
  // to prefix-collide with, unlike facebook_pages/facebook_ads above).
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    category: 'social',
    credentialType: 'meta',
    requiredFields: ['access_token'],
    module: './types/instagram.js',
    description: 'Instagram professional accounts (organic): reads, insights, comments, and governed publishing',
    docs: 'https://developers.facebook.com/docs/instagram-platform/',
    rateLimit: { windowMs: 60_000, max: 20 },
    kind: 'module',
  },

  // TT-1: plain id 'tiktok' is safe here (no pre-existing 'tiktok_*'
  // declarative spec to prefix-collide with, unlike facebook_pages/
  // facebook_ads above).
  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    category: 'social',
    credentialType: 'tiktok',
    requiredFields: ['access_token', 'client_key'],
    module: './types/tiktok.js',
    description: 'TikTok content, reads, and governed video publishing',
    docs: 'https://developers.tiktok.com/doc/overview/',
    rateLimit: { windowMs: 60_000, max: 10 },
    kind: 'module',
  },

  twitter: {
    id: 'twitter',
    name: 'Twitter/X',
    category: 'social',
    credentialType: 'twitter',
    requiredFields: ['api_key', 'api_secret', 'access_token', 'access_secret'],
    module: './types/twitter.js',
    description: 'Twitter/X credential verification (OAuth 1.0a)',
    docs: 'https://docs.x.com/x-api/introduction',
    rateLimit: { windowMs: 60_000, max: 15 },
    kind: 'module',
  },

  youtube: {
    id: 'youtube',
    name: 'YouTube',
    category: 'media',
    credentialType: 'youtube',
    requiredFields: ['access_token', 'refresh_token', 'client_id', 'client_secret'],
    module: './types/youtube.js',
    description: 'YouTube channel management — upload, metadata, playlists, thumbnails',
    docs: 'https://developers.google.com/youtube/v3',
    rateLimit: { windowMs: 60_000, max: 50 },
    kind: 'module',
  },

  // VAULT-INTEG P10: grow the executable connector count by product pull —
  // all four credential types are already vault-wired and live-tested
  // (slack/gitlab/discord in integrationTypeRegistry.js; grafana in b01b2907).

  slack: {
    id: 'slack',
    name: 'Slack',
    category: 'communication',
    credentialType: 'slack',
    requiredFields: ['bot_token'],
    module: './types/slack.js',
    description: 'Slack channels — post messages, list channels, read history',
    docs: 'https://api.slack.com/docs',
    rateLimit: { windowMs: 60_000, max: 30 },
    kind: 'module',
  },

  gitlab: {
    id: 'gitlab',
    name: 'GitLab',
    category: 'developer',
    credentialType: 'gitlab',
    requiredFields: ['private_token'],
    module: './types/gitlab.js',
    description: 'GitLab issues and merge requests',
    docs: 'https://docs.gitlab.com/ee/api/',
    rateLimit: { windowMs: 60_000, max: 30 },
    kind: 'module',
  },

  discord: {
    id: 'discord',
    name: 'Discord',
    category: 'communication',
    credentialType: 'discord',
    requiredFields: ['bot_token'],
    module: './types/discord.js',
    description: 'Discord channels — list, read, and post messages via a bot token',
    docs: 'https://discord.com/developers/docs/intro',
    rateLimit: { windowMs: 60_000, max: 30 },
    kind: 'module',
  },

  grafana: {
    id: 'grafana',
    name: 'Grafana',
    category: 'monitoring',
    credentialType: 'grafana',
    requiredFields: ['api_key', 'base_url'],
    module: './types/grafana.js',
    description: 'Grafana dashboards and alert rules (read-only)',
    docs: 'https://grafana.com/docs/grafana/latest/developers/http_api/',
    rateLimit: { windowMs: 60_000, max: 30 },
    kind: 'module',
  },
}

// ---------------------------------------------------------------------------
// CONNFAC Phase 1 — declarative spec discovery.
//
// A Connector Spec v1 JSON in specs/ registers as a first-class connector with
// kind:'declarative', executed by declarativeRuntime.js. Registration is PROOF
// GATED: a spec only registers when specs/proofs/<id>.proof.json says the
// provider was actually reached (SHAPE_PROVEN or LIVE_PROVEN), or answered an
// auth wall AND the spec carries documentary path provenance (tools_source).
// Without that gate a generated spec would become an advertised agent tool on
// nothing but a scaffolder's guess about the API.
// ---------------------------------------------------------------------------

const SPECS_DIR = path.join(__dirname, 'specs')
const PROOFS_DIR = path.join(SPECS_DIR, 'proofs')
const PROVEN_OVERALL = new Set(['SHAPE_PROVEN', 'LIVE_PROVEN'])

function _hasToolsSource(spec) {
  const src = spec && spec.tools_source
  if (typeof src === 'string') return src.trim().length > 0
  if (Array.isArray(src)) return src.length > 0
  return false
}

/**
 * Read and judge the shape-proof receipt for a spec.
 * @returns {{ ok: boolean, reason?: string, proof?: Object }}
 */
function checkProofGate(spec, proofsDir = PROOFS_DIR) {
  const proofPath = path.join(proofsDir, `${spec.id}.proof.json`)
  let proof
  try {
    proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'))
  } catch (err) {
    return { ok: false, reason: `no readable shape proof at ${proofPath} (${err.code || err.message})` }
  }

  const overall = proof && proof.overall
  if (PROVEN_OVERALL.has(overall)) return { ok: true, proof }
  if (overall === 'AUTH_WALL') {
    if (_hasToolsSource(spec)) return { ok: true, proof }
    return { ok: false, reason: "proof overall is AUTH_WALL and the spec declares no tools_source (no documentary path provenance)" }
  }
  return { ok: false, reason: `proof overall '${overall}' does not satisfy the gate (need SHAPE_PROVEN, LIVE_PROVEN, or AUTH_WALL with tools_source)` }
}

/**
 * Registry entry for a validated, proven spec.
 */
function specToEntry(spec) {
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    credentialType: spec.credentialType,
    requiredFields: Array.isArray(spec.requiredFields) ? spec.requiredFields.slice() : [],
    description: spec.description || `${spec.name} (declarative connector)`,
    docs: spec.docs || null,
    rateLimit: spec.rateLimit || null,
    kind: 'declarative',
    spec,
  }
}

/**
 * Discover declarative connector specs.
 *
 * Reads `<dir>/*.connector.json` only — NOT drafts/, NOT any subdirectory:
 * a draft is by definition unfinished, and shipping one by accident is exactly
 * the failure this gate exists to prevent.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.dir]             specs directory (parameterised for tests)
 * @param {string}  [opts.proofsDir]       proofs directory (defaults to <dir>/proofs)
 * @param {string[]}[opts.staticToolNames] static TOOL_DEFS names, for exact-name clashes
 * @returns {{ entries: Object, failures: Array<{id: string, reason: string}> }}
 */
function discoverSpecs(opts = {}) {
  const dir = opts.dir || SPECS_DIR
  const proofsDir = opts.proofsDir || path.join(dir, 'proofs')
  const entries = {}
  const failures = []

  let files
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.endsWith('.connector.json'))
      .map(d => d.name)
      .sort()
  } catch (err) {
    // No specs directory at all is a legitimate state (nothing generated yet).
    if (err.code !== 'ENOENT') failures.push({ id: dir, reason: `specs directory unreadable: ${err.message}` })
    return { entries, failures }
  }

  for (const file of files) {
    const fallbackId = file.replace(/\.connector\.json$/, '')
    let spec
    try {
      spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    } catch (err) {
      failures.push({ id: fallbackId, reason: `unreadable spec JSON: ${err.message}` })
      continue
    }

    const result = validateSpec(spec, { staticToolNames: opts.staticToolNames })
    if (!result.ok) {
      failures.push({ id: (spec && spec.id) || fallbackId, reason: `invalid spec: ${result.errors.join('; ')}` })
      continue
    }
    if (spec.id !== fallbackId) {
      failures.push({ id: spec.id, reason: `spec id '${spec.id}' does not match filename '${file}'` })
      continue
    }
    if (entries[spec.id]) {
      failures.push({ id: spec.id, reason: 'duplicate spec id in the specs directory' })
      continue
    }

    const gate = checkProofGate(spec, proofsDir)
    if (!gate.ok) {
      failures.push({ id: spec.id, reason: gate.reason })
      continue
    }

    entries[spec.id] = specToEntry(spec)
  }

  return { entries, failures }
}

/**
 * Resolve STATIC entries that declare kind:'declarative' with a specFile.
 *
 * This is the port path for a connector that is already live as a module: the
 * entry keeps its hand-curated registry metadata and gains a spec. Such an
 * entry may set `bypassProofGate: true` — the connector has been executing
 * against the real provider in production, which is stronger evidence than a
 * blind shape probe, and its parity test is what holds it honest.
 *
 * @returns {Array<{id: string, reason: string}>} failures (entry left in place)
 */
function loadStaticSpecEntries(entries, opts = {}) {
  const baseDir = opts.baseDir || __dirname
  const failures = []

  for (const [id, entry] of Object.entries(entries || {})) {
    if (!entry || entry.kind !== 'declarative' || entry.spec) continue
    if (!entry.specFile) {
      failures.push({ id, reason: "registry entry is kind:'declarative' but declares neither spec nor specFile" })
      continue
    }
    const specPath = path.resolve(baseDir, entry.specFile)
    let spec
    try {
      spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
    } catch (err) {
      failures.push({ id, reason: `unreadable specFile ${entry.specFile}: ${err.message}` })
      continue
    }
    const result = validateSpec(spec, { staticToolNames: opts.staticToolNames })
    if (!result.ok) {
      failures.push({ id, reason: `invalid specFile ${entry.specFile}: ${result.errors.join('; ')}` })
      continue
    }
    if (spec.id !== id) {
      failures.push({ id, reason: `specFile ${entry.specFile} declares id '${spec.id}'` })
      continue
    }
    if (!entry.bypassProofGate) {
      const gate = checkProofGate(spec, opts.proofsDir || PROOFS_DIR)
      if (!gate.ok) {
        failures.push({ id, reason: gate.reason })
        continue
      }
    }
    entry.spec = spec
  }

  return failures
}

/**
 * A spec failure is fatal in dev and test (a broken spec must never reach a
 * commit) and survivable in production (a bad spec must not take down chat).
 */
function applyFailurePolicy(failures) {
  if (!failures || failures.length === 0) return
  const env = process.env.NODE_ENV || 'development'
  const strict = env === 'test' || env === 'development'
  const lines = failures.map(f => `[ConnectorRegistry] skipping spec ${f.id}: ${f.reason}`)
  if (strict) throw new Error(lines.join('\n'))
  for (const line of lines) console.warn(line)
}

/**
 * Get connector config by ID
 */
function getConnector(connectorId) {
  return CONNECTOR_REGISTRY[connectorId] || null
}

/**
 * Get all registered connector IDs
 */
function listConnectors() {
  return Object.values(CONNECTOR_REGISTRY)
}

/**
 * Get connector by vault credential type
 */
function getConnectorForCredentialType(credentialType) {
  return Object.values(CONNECTOR_REGISTRY).find(c => c.credentialType === credentialType) || null
}

/**
 * Get all connectors in a category
 */
function getConnectorsByCategory(category) {
  return Object.values(CONNECTOR_REGISTRY).filter(c => c.category === category)
}

// A connector id has to survive being used as a bare tool-name prefix.
const SAFE_CONNECTOR_ID = /^[a-z0-9_-]+$/

/**
 * CONNFAC Phase 0 — namespace collision detector.
 *
 * agentTools.parseConnectorTool() prefix-matches `<connectorId>_` against the
 * incoming tool name BEFORE any static tool lookup, and returns as soon as one
 * matches. So a connector id that prefixes a static tool name (or another
 * connector id) silently hijacks it: the call goes to the connector bridge and
 * the real implementation never runs. Nothing checked for that, so this is the
 * check.
 *
 * @param {string[]} staticToolNames - names of the natively registered tools
 *   (TOOL_DEFS keys) that the connector prefix match runs ahead of.
 * @param {string[]} connectorIds - defaults to the live registry; overridable
 *   so the rule can be tested without mutating the registry.
 * @returns {string[]} human-readable collision descriptions, empty when clean.
 */
function validateConnectorNamespace(staticToolNames = [], connectorIds = Object.keys(CONNECTOR_REGISTRY)) {
  const collisions = []

  for (const id of connectorIds) {
    if (!SAFE_CONNECTOR_ID.test(id)) {
      collisions.push(`connector id '${id}' is not a safe tool-name prefix (expected ${SAFE_CONNECTOR_ID})`)
    }
  }

  for (const a of connectorIds) {
    for (const b of connectorIds) {
      if (a === b) continue
      if (`${b}_`.startsWith(`${a}_`)) {
        collisions.push(`connector id '${a}' prefixes connector id '${b}': every '${b}_*' tool would route to '${a}'`)
      }
    }
  }

  for (const name of staticToolNames) {
    for (const id of connectorIds) {
      if (name.startsWith(`${id}_`)) {
        collisions.push(`static tool '${name}' is shadowed by connector '${id}': it routes to the connector bridge, never to its own implementation`)
      }
    }
  }

  return collisions
}

/**
 * CONNFAC P7.4 — classify namespace collisions against the reviewed allowlist.
 *
 * Precedence, canonical: (1) an EXACT name match in the hardcoded TOOL_DEFS map
 * wins; (2) every other `<connectorId>_*` name routes to the connector bridge
 * (proved by test/connectorStaticPrecedence.test.js). A static tool sharing a
 * connector's prefix is therefore benign ONLY while no exact name clash exists,
 * and each such pair must be justified in knownCollisions.json — a structured,
 * reviewed data file, not an inline test array grown to make a suite green.
 *
 * Buckets:
 *   known      — collision matches an ACTIVE entry (its connector is registered)
 *   unexpected — collision with no matching entry; connector-vs-connector prefix
 *                collisions and unsafe connector ids land here UNCONDITIONALLY,
 *                they can never be allowlisted
 *   stale      — active entry whose collision no longer occurs (remove it)
 *
 * Entries whose connector is NOT registered are dormant: ignored entirely, so a
 * collision set can be pre-seeded for an unmerged branch without going stale.
 */
function loadKnownCollisions() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'knownCollisions.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

function classifyNamespaceCollisions(staticToolNames = [], connectorIds = Object.keys(CONNECTOR_REGISTRY), entries = loadKnownCollisions()) {
  const found = validateConnectorNamespace(staticToolNames, connectorIds)
  const registered = new Set(connectorIds)
  const active = entries.filter((e) => e && registered.has(e.connector))

  const known = []
  const unexpected = []
  const matched = new Set()
  for (const collision of found) {
    // Only the static-shadow shape is allowlistable.
    const m = collision.match(/^static tool '([^']+)' is shadowed by connector '([^']+)'/)
    const entry = m && active.find((e) => e.tool === m[1] && e.connector === m[2])
    if (entry) {
      known.push(collision)
      matched.add(entry)
    } else {
      unexpected.push(collision)
    }
  }
  const stale = active
    .filter((e) => !matched.has(e))
    .map((e) => `known collision entry '${e.tool}' / '${e.connector}' no longer occurs — remove it from knownCollisions.json`)

  return { known, unexpected, stale }
}

// ---------------------------------------------------------------------------
// Load-time registration: resolve static specFile entries, merge discovered
// specs, then re-run the namespace check over the UNION. The six pre-existing
// static-tool collisions are pinned upstream in test/connectorNamespace.test.js
// against the live TOOL_DEFS; what this check catches is a NEW connector id
// that collides with an existing one, which is the failure a generated spec
// can actually introduce.
// ---------------------------------------------------------------------------

const _registrationFailures = []

_registrationFailures.push(...loadStaticSpecEntries(CONNECTOR_REGISTRY))

const _discovered = discoverSpecs()
_registrationFailures.push(..._discovered.failures)
for (const [id, entry] of Object.entries(_discovered.entries)) {
  if (CONNECTOR_REGISTRY[id]) {
    _registrationFailures.push({ id, reason: 'a static connector already owns this id' })
    continue
  }
  CONNECTOR_REGISTRY[id] = entry
}

for (const collision of validateConnectorNamespace([], Object.keys(CONNECTOR_REGISTRY))) {
  _registrationFailures.push({ id: 'namespace', reason: collision })
}

applyFailurePolicy(_registrationFailures)

module.exports = {
  CONNECTOR_REGISTRY,
  getConnector,
  listConnectors,
  getConnectorForCredentialType,
  getConnectorsByCategory,
  validateConnectorNamespace,
  classifyNamespaceCollisions,
  loadKnownCollisions,
  discoverSpecs,
  checkProofGate,
  loadStaticSpecEntries,
  specToEntry,
  applyFailurePolicy,
}

/**
 * Declarative connector runtime (CONNFAC Phase 1).
 *
 * buildConnector(spec) returns the SAME object shape a hand-written
 * connectors/types/*.js module exports — `{ getTools(credentials) }` yielding
 * `[{ name, description, input_schema, write, execute(input, creds, ctx) }]` —
 * so bridge.js can load a spec exactly where it loads a module and nothing
 * downstream can tell the difference.
 *
 * The norms below are copied from the hand-written modules deliberately, not
 * invented: one fetch helper per connector, AbortSignal.timeout(15000),
 * `<Name> API <status>: <first 200 bytes>` on non-2xx, and pruned responses
 * rather than raw provider payloads.
 *
 * v1 limits (see docs/STREAM_CONNECTOR_FACTORY_PLAN.md §4.2): one request per
 * tool, `pick`-only response mapping (no computed fields), one clamp helper,
 * no conditional logic beyond "drop the key when its input is absent".
 */

const crypto = require('node:crypto')

const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_CLAMP_DEFAULT = 20
const DEFAULT_CLAMP_MAX = 50
const DEFAULT_EXPIRY_BUFFER_SEC = 60
const ERROR_BODY_SLICE = 200

// oauth2_client_credentials (RFC 6749 §4.4) defaults.
const DEFAULT_CLIENT_CREDENTIALS_GRANT = 'client_credentials'
const DEFAULT_CLIENT_AUTH = 'basic'
const DEFAULT_TOKEN_LIFETIME_SEC = 3600

// google_service_account (RFC 7523 JWT-bearer) defaults.
const DEFAULT_SERVICE_ACCOUNT_FIELD = 'service_account_json'
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const JWT_LIFETIME_SEC = 3600

const PLACEHOLDER_ONLY = /^\{\{([^{}]+)\}\}$/
const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function getPath(source, dotted) {
  if (source === undefined || source === null) return undefined
  let cursor = source
  for (const part of String(dotted).split('.')) {
    if (cursor === undefined || cursor === null) return undefined
    cursor = cursor[part]
  }
  return cursor
}

/**
 * Resolve one {{token}} against the tool input and the credentials.
 * Returns undefined for anything absent — callers decide whether that is a
 * dropped query param, a dropped body key, or a hard error (paths, auth).
 */
/**
 * {{suffix <credentialField> <sep>}} — the part of a credential value after its
 * LAST separator. Mailchimp keys embed their datacenter (xxxx-us21) and the API
 * host IS that datacenter, so the host has to be derived from the key.
 *
 * It renders the suffix or NOTHING. A value with no separator never falls back
 * to the whole field: that would put the entire key in a URL, which is the
 * mistake this helper exists to prevent.
 */
function parseSuffixHelper(trimmed) {
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 3) return null
  const [, ref, sep] = parts
  if (!ref || ref.startsWith('input.') || sep.length !== 1) return null
  return { ref, sep }
}

function suffixOf(value, sep) {
  const str = String(value)
  const index = str.lastIndexOf(sep)
  return index < 0 ? undefined : str.slice(index + 1)
}

function resolveToken(token, { input, creds }) {
  const trimmed = String(token).trim()

  if (trimmed.startsWith('suffix ')) {
    const helper = parseSuffixHelper(trimmed)
    if (!helper) return undefined
    const raw = creds ? creds[helper.ref] : undefined
    if (raw === undefined || raw === null || raw === '') return undefined
    return suffixOf(raw, helper.sep)
  }

  if (trimmed.startsWith('clamp ')) {
    const [, ref, rawDefault, rawMax] = trimmed.split(/\s+/)
    const fallback = rawDefault === undefined ? DEFAULT_CLAMP_DEFAULT : Number(rawDefault)
    const cap = rawMax === undefined ? DEFAULT_CLAMP_MAX : Number(rawMax)
    const raw = resolveToken(ref, { input, creds })
    const n = Number(raw)
    const value = Number.isFinite(n) ? n : fallback
    return Math.min(value, cap)
  }

  if (trimmed.startsWith('input.')) return getPath(input, trimmed.slice('input.'.length))
  return creds ? creds[trimmed] : undefined
}

/**
 * Render a template string.
 * A string that is EXACTLY one placeholder keeps the resolved JSON type
 * ("{{input.count}}" with count=5 renders the number 5, not "5"); anything
 * else is string interpolation. An unresolved token anywhere yields undefined
 * so the caller can drop the field.
 */
function renderTemplate(str, ctx, { encode = false } = {}) {
  const only = PLACEHOLDER_ONLY.exec(str)
  if (only) {
    const value = resolveToken(only[1], ctx)
    if (value === undefined || value === null) return undefined
    return encode ? encodeURIComponent(String(value)) : value
  }

  let missing = false
  PLACEHOLDER.lastIndex = 0
  const out = str.replace(PLACEHOLDER, (_m, token) => {
    const value = resolveToken(token, ctx)
    if (value === undefined || value === null) { missing = true; return '' }
    return encode ? encodeURIComponent(String(value)) : String(value)
  })
  return missing ? undefined : out
}

/**
 * Deep-render a request body. Keys whose value resolves to nothing are dropped
 * (the `if (filter) body.filter = filter` idiom every hand-written module uses),
 * and an object that had keys but rendered to none is dropped with them.
 */
function renderBody(value, ctx) {
  if (typeof value === 'string') return renderTemplate(value, ctx)
  if (Array.isArray(value)) {
    const out = value.map(v => renderBody(v, ctx)).filter(v => v !== undefined)
    return out
  }
  if (isPlainObject(value)) {
    const out = {}
    let kept = 0
    for (const [key, raw] of Object.entries(value)) {
      const renderedKey = renderTemplate(key, ctx)
      const rendered = renderBody(raw, ctx)
      if (renderedKey === undefined || rendered === undefined) continue
      out[String(renderedKey)] = rendered
      kept++
    }
    if (Object.keys(value).length > 0 && kept === 0) return undefined
    return out
  }
  return value
}

function truncateStrings(value, cap) {
  if (typeof value === 'string') return value.length > cap ? value.slice(0, cap) : value
  if (Array.isArray(value)) return value.map(v => truncateStrings(v, cap))
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = truncateStrings(v, cap)
    return out
  }
  return value
}

/**
 * A root-array pick: `{ "[]": { id: "id", ... } }`, the spec v1.1 form for the
 * providers that answer with a TOP-LEVEL JSON array (datadog list_monitors,
 * netlify/acuity/sentry lists, sendgrid stats), which the dotted walk below
 * cannot address at all.
 */
function isRootArrayPick(pick) {
  const keys = Object.keys(pick)
  return keys.length === 1 && keys[0] === '[]' && isPlainObject(pick['[]'])
}

/**
 * Walk a `response.pick` map over a parsed payload.
 *   "total": "total"                  → dest.total  = payload.total
 *   "incidents[]": { id: "id", ... }  → dest.incidents = payload.incidents.map(sub-pick)
 *   "[]": { id: "id", ... }           → the payload IS the array; map it
 * Source paths are dotted.
 *
 * A root-array pick against a non-array body returns the body untouched rather
 * than throwing: a provider that answers `{}` on an empty account, or an object
 * on one endpoint and an array on another, must not break the tool.
 */
function applyPick(pick, payload) {
  if (isRootArrayPick(pick)) {
    const sub = pick['[]']
    if (!Array.isArray(payload)) return payload
    return payload.map(item => applyPick(sub, item))
  }

  const out = {}
  for (const [key, source] of Object.entries(pick)) {
    if (key.endsWith('[]')) {
      const dest = key.slice(0, -2)
      const arr = getPath(payload, dest)
      out[dest] = Array.isArray(arr) ? arr.map(item => applyPick(source, item)) : []
    } else {
      out[key] = getPath(payload, source)
    }
  }
  return out
}

function requireCredential(creds, field, spec, why) {
  const value = creds ? creds[field] : undefined
  if (value === undefined || value === null || value === '') {
    throw new Error(`${spec.name} connector: missing credential field '${field}' (${why})`)
  }
  return value
}

/**
 * Render a template that may only draw on CREDENTIALS (base URLs, static
 * headers, auth headers, token requests): every placeholder is required, so a
 * missing one throws before a request is built rather than silently dropping.
 * Supports the {{suffix ...}} helper; `why` is the wording of the error.
 */
function renderCredentialTemplate(template, spec, creds, why) {
  return template.replace(PLACEHOLDER, (_m, token) => {
    const trimmed = String(token).trim()
    if (trimmed.startsWith('suffix ')) {
      const helper = parseSuffixHelper(trimmed)
      if (!helper) {
        throw new Error(`${spec.name} connector: malformed helper {{${trimmed}}} (expected {{suffix <credentialField> <separator>}})`)
      }
      const value = requireCredential(creds, helper.ref, spec, why)
      const suffix = suffixOf(value, helper.sep)
      if (suffix === undefined || suffix === '') {
        // The value itself is never quoted here: it is the credential.
        throw new Error(`${spec.name} connector: credential field '${helper.ref}' has no '${helper.sep}' separator, so {{${trimmed}}} cannot render a suffix`)
      }
      return suffix
    }
    return String(requireCredential(creds, trimmed, spec, why))
  })
}

function resolveBaseUrl(spec, creds) {
  const raw = spec.base_url
  if (typeof raw === 'string') return raw.replace(/\/+$/, '')

  if (isPlainObject(raw)) {
    if (typeof raw.template === 'string' && raw.template) {
      const rendered = renderCredentialTemplate(raw.template, spec, creds, 'it templates the base URL')
      return rendered.replace(/\/+$/, '')
    }
    if (typeof raw.fromCredential === 'string' && raw.fromCredential) {
      const value = requireCredential(creds, raw.fromCredential, spec, 'it supplies the base URL')
      return String(value).replace(/\/+$/, '')
    }
  }

  throw new Error(`${spec.name} connector: spec has no usable base_url`)
}

/**
 * Build the per-request Authorization (or equivalent) material.
 * Returns { headers, queryParams } — async because the token-exchange types
 * (oauth2_refresh, oauth2_client_credentials, google_service_account) may have
 * to mint an access token first.
 */
async function buildAuth(spec, creds, state) {
  const auth = spec.auth || {}
  const headers = {}
  const queryParams = []

  if (auth.type === 'bearer') {
    headers.Authorization = `Bearer ${requireCredential(creds, auth.field, spec, 'bearer auth')}`
  } else if (auth.type === 'basic') {
    // userLiteral is a DOCUMENTED constant, never a credential lookup: Mailchimp
    // accepts `Basic anystring:<key>`. userSuffix appends a literal to the
    // credential value: Zendesk wants `{email}/token:<api_token>`.
    const user = typeof auth.userLiteral === 'string' && auth.userLiteral
      ? auth.userLiteral
      : `${requireCredential(creds, auth.userField, spec, 'basic auth')}${typeof auth.userSuffix === 'string' ? auth.userSuffix : ''}`
    // passField "" is legitimate: tailscale authenticates with base64(api_key + ':').
    const pass = auth.passField ? requireCredential(creds, auth.passField, spec, 'basic auth') : ''
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  } else if (auth.type === 'header') {
    headers[auth.header] = renderCredentialTemplate(auth.template, spec, creds, `the ${auth.header} header`)
  } else if (auth.type === 'query') {
    queryParams.push([auth.param, String(requireCredential(creds, auth.field, spec, 'query auth'))])
  } else if (auth.type === 'oauth2_refresh') {
    headers.Authorization = `Bearer ${await getAccessToken(spec, creds, state)}`
  } else if (auth.type === 'oauth2_client_credentials') {
    headers.Authorization = `Bearer ${await getClientCredentialsToken(spec, creds, state)}`
  } else if (auth.type === 'google_service_account') {
    headers.Authorization = `Bearer ${await getServiceAccountToken(spec, creds, state)}`
  } else if (auth.type === 'none') {
    // Nothing to inject. Legitimate only when the credential rides elsewhere
    // (telegram templates the bot token into base_url); specSchema warns when
    // no credential is referenced anywhere at all.
  } else {
    throw new Error(`${spec.name} connector: unsupported auth type '${auth.type}'`)
  }

  return { headers, queryParams }
}

/**
 * youtube-style refresh, generalised. The cache lives in the per-getTools()
 * state object, so it is scoped to one pooled instance (one org's credentials)
 * and can never hand another tenant's token out. Single-flight: concurrent
 * tool calls share one refresh.
 */
async function getAccessToken(spec, creds, state) {
  const auth = spec.auth
  const refreshToken = requireCredential(creds, auth.refreshTokenField, spec, 'oauth2 refresh')
  const now = Date.now()

  if (state.accessToken && state.key === refreshToken && state.expiresAt > now) return state.accessToken
  if (state.inflight && state.key === refreshToken) return state.inflight

  state.key = refreshToken
  state.accessToken = null
  state.expiresAt = 0
  state.inflight = (async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: String(requireCredential(creds, auth.clientIdField, spec, 'oauth2 refresh')),
      client_secret: String(requireCredential(creds, auth.clientSecretField, spec, 'oauth2 refresh')),
      refresh_token: String(refreshToken),
    })
    const resp = await fetch(auth.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`${spec.name} token refresh ${resp.status}: ${text.slice(0, ERROR_BODY_SLICE)}`)
    }
    const data = await resp.json()
    if (!data || !data.access_token) throw new Error(`${spec.name} token refresh returned no access_token`)
    const buffer = Number.isFinite(auth.expiryBufferSec) ? auth.expiryBufferSec : DEFAULT_EXPIRY_BUFFER_SEC
    const lifetime = Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : 3600
    state.accessToken = data.access_token
    state.expiresAt = Date.now() + Math.max(0, lifetime - buffer) * 1000
    return state.accessToken
  })()

  try {
    return await state.inflight
  } finally {
    state.inflight = null
  }
}

/**
 * Resolve a client-credentials token endpoint. `{ template }` is rendered from
 * the credentials, because some providers put a per-customer identifier in the
 * URL itself (Microsoft's tenant id). A missing credential throws before any
 * request is made, naming the field.
 */
function resolveTokenUrl(spec, creds) {
  const raw = spec.auth ? spec.auth.token_url : undefined
  if (typeof raw === 'string' && raw) return raw
  if (isPlainObject(raw) && typeof raw.template === 'string' && raw.template) {
    return renderCredentialTemplate(raw.template, spec, creds, 'it templates the token URL')
  }
  throw new Error(`${spec.name} connector: auth.token_url is required for oauth2_client_credentials auth`)
}

/**
 * Render `auth.extra_form` into ordered form entries. Values are literals or a
 * single credential placeholder (Zoom's account_id). Returned as pairs so the
 * form keeps spec order, which makes the request reproducible in a log.
 */
function renderExtraForm(spec, creds) {
  const extra = spec.auth ? spec.auth.extra_form : undefined
  if (extra === undefined || extra === null) return []
  if (!isPlainObject(extra)) {
    throw new Error(`${spec.name} connector: auth.extra_form must be a flat object of form field → value`)
  }
  const out = []
  for (const [field, template] of Object.entries(extra)) {
    if (typeof template !== 'string') {
      out.push([field, String(template)])
      continue
    }
    out.push([field, renderCredentialTemplate(template, spec, creds, `the '${field}' token-request field`)])
  }
  return out
}

/**
 * Mint a token with the RFC 6749 §4.4 client-credentials grant.
 *
 * Two provider dialects, both declarative: `client_auth: 'basic'` (the default,
 * PayPal and Spotify) sends id:secret as a Basic header, `'form'` (Microsoft)
 * sends both in the body. `grant_type` is overridable because Zoom's
 * server-to-server flow calls the same exchange 'account_credentials'.
 *
 * Same cache discipline as getAccessToken: the state object belongs to one
 * getTools() instance (one org's credentials), so a minted token never crosses
 * tenants, and concurrent tool calls share a single mint. The cache key holds a
 * DIGEST of the identifying material, never the secret itself.
 */
async function getClientCredentialsToken(spec, creds, state) {
  const auth = spec.auth
  const clientId = requireCredential(creds, auth.clientIdField, spec, 'oauth2 client credentials')
  const clientSecret = requireCredential(creds, auth.clientSecretField, spec, 'oauth2 client credentials')
  const tokenUrl = resolveTokenUrl(spec, creds)
  const extraForm = renderExtraForm(spec, creds)
  const grantType = typeof auth.grant_type === 'string' && auth.grant_type ? auth.grant_type : DEFAULT_CLIENT_CREDENTIALS_GRANT
  const clientAuth = auth.client_auth === 'form' ? 'form' : DEFAULT_CLIENT_AUTH
  const scope = typeof auth.scope === 'string' && auth.scope ? auth.scope : null

  const cacheKey = crypto.createHash('sha256')
    .update(JSON.stringify([tokenUrl, String(clientId), grantType, scope, extraForm]))
    .digest('hex')
  const now = Date.now()

  if (state.accessToken && state.key === cacheKey && state.expiresAt > now) return state.accessToken
  if (state.inflight && state.key === cacheKey) return state.inflight

  state.key = cacheKey
  state.accessToken = null
  state.expiresAt = 0
  state.inflight = (async () => {
    const form = new URLSearchParams()
    form.set('grant_type', grantType)
    if (scope) form.set('scope', scope)
    for (const [field, value] of extraForm) form.set(field, value)

    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (clientAuth === 'form') {
      form.set('client_id', String(clientId))
      form.set('client_secret', String(clientSecret))
    } else {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    }

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      // Some providers echo the submitted secret back in the error body; the
      // status and the provider's own error code are what a caller needs.
      throw new Error(`${spec.name} token request ${resp.status}: ${redactSecrets(text, [clientSecret]).slice(0, ERROR_BODY_SLICE)}`)
    }
    const data = await resp.json()
    if (!data || !data.access_token) throw new Error(`${spec.name} token request returned no access_token`)
    const buffer = Number.isFinite(auth.expiryBufferSec) ? auth.expiryBufferSec : DEFAULT_EXPIRY_BUFFER_SEC
    const lifetime = Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : DEFAULT_TOKEN_LIFETIME_SEC
    state.accessToken = data.access_token
    state.expiresAt = Date.now() + Math.max(0, lifetime - buffer) * 1000
    return state.accessToken
  })()

  try {
    return await state.inflight
  } finally {
    state.inflight = null
  }
}

/** Replace any literal credential value inside provider text with [REDACTED]. */
function redactSecrets(text, secrets) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    const value = String(secret ?? '')
    if (value.length < 4) continue
    out = out.split(value).join('[REDACTED]')
  }
  return out
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Read a Google service-account key out of the vault credential.
 * The value may be the raw JSON string the provider hands out, or an already
 * parsed object (some vault paths JSON-decode on the way in).
 *
 * Every error names the FIELD and nothing else: a message that quoted the
 * malformed value would print private key material into a log line.
 */
function parseServiceAccountKey(spec, creds, field) {
  const raw = requireCredential(creds, field, spec, 'google service-account auth')

  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`${spec.name} connector: credential field '${field}' is not valid JSON (expected a Google service-account key)`)
    }
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${spec.name} connector: credential field '${field}' must be a Google service-account JSON object`)
  }

  const clientEmail = parsed.client_email
  const privateKey = parsed.private_key
  if (typeof clientEmail !== 'string' || !clientEmail) {
    throw new Error(`${spec.name} connector: credential field '${field}' has no client_email`)
  }
  if (typeof privateKey !== 'string' || !privateKey) {
    throw new Error(`${spec.name} connector: credential field '${field}' has no private_key`)
  }

  const tokenUri = typeof parsed.token_uri === 'string' && parsed.token_uri ? parsed.token_uri : GOOGLE_TOKEN_URI
  return { clientEmail, privateKey, tokenUri }
}

/**
 * Assemble and RS256-sign the JWT assertion (RFC 7523 §2.1 / Google's
 * server-to-server flow). node:crypto only — no new dependencies.
 */
function signServiceAccountAssertion(spec, field, { clientEmail, privateKey, tokenUri, scope }) {
  const iat = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({
    iss: clientEmail,
    scope,
    aud: tokenUri,
    exp: iat + JWT_LIFETIME_SEC,
    iat,
  }))
  const signingInput = `${header}.${payload}`

  let signature
  try {
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(signingInput)
    signer.end()
    signature = signer.sign(privateKey)
  } catch {
    // The underlying OpenSSL error is dropped deliberately: it can echo the key.
    throw new Error(`${spec.name} connector: credential field '${field}' does not contain a usable RSA private key`)
  }

  return `${signingInput}.${base64url(signature)}`
}

/**
 * Mint a Google access token from a service-account key. Same cache discipline
 * as getAccessToken above: the state object belongs to one getTools() instance
 * (one org's credentials), so a token minted here never crosses tenants, and
 * concurrent tool calls share a single mint.
 */
async function getServiceAccountToken(spec, creds, state) {
  const auth = spec.auth
  const field = typeof auth.field === 'string' && auth.field ? auth.field : DEFAULT_SERVICE_ACCOUNT_FIELD
  const scope = auth.scope
  if (typeof scope !== 'string' || !scope) {
    throw new Error(`${spec.name} connector: auth.scope is required for google_service_account auth`)
  }

  const key = parseServiceAccountKey(spec, creds, field)
  const cacheKey = `${key.clientEmail}|${scope}`
  const now = Date.now()

  if (state.accessToken && state.key === cacheKey && state.expiresAt > now) return state.accessToken
  if (state.inflight && state.key === cacheKey) return state.inflight

  state.key = cacheKey
  state.accessToken = null
  state.expiresAt = 0
  state.inflight = (async () => {
    const body = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: signServiceAccountAssertion(spec, field, { ...key, scope }),
    })
    const resp = await fetch(key.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`${spec.name} token request ${resp.status}: ${text.slice(0, ERROR_BODY_SLICE)}`)
    }
    const data = await resp.json()
    if (!data || !data.access_token) throw new Error(`${spec.name} token request returned no access_token`)
    const buffer = Number.isFinite(auth.expiryBufferSec) ? auth.expiryBufferSec : DEFAULT_EXPIRY_BUFFER_SEC
    const lifetime = Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : JWT_LIFETIME_SEC
    state.accessToken = data.access_token
    state.expiresAt = Date.now() + Math.max(0, lifetime - buffer) * 1000
    return state.accessToken
  })()

  try {
    return await state.inflight
  } finally {
    state.inflight = null
  }
}

function buildUrl(spec, tool, input, creds) {
  const request = tool.request
  const ctx = { input, creds }

  const path = request.path.replace(PLACEHOLDER, (_m, token) => {
    const value = resolveToken(token, ctx)
    if (value === undefined || value === null || value === '') {
      throw new Error(`${spec.name} ${tool.name}: missing value for path placeholder {{${String(token).trim()}}}`)
    }
    return encodeURIComponent(String(value))
  })

  const params = new URLSearchParams()
  for (const [param, template] of Object.entries(request.query || {})) {
    const value = typeof template === 'string' ? renderTemplate(template, ctx) : template
    if (value === undefined || value === null) continue // the param is skipped entirely
    if (Array.isArray(value)) {
      for (const v of value) if (v !== undefined && v !== null) params.append(param, String(v))
    } else {
      params.append(param, String(value))
    }
  }

  return { path, params }
}

/**
 * Build a connector from a Connector Spec v1 document.
 * @param {Object} spec - a spec that has already passed specSchema.validateSpec
 * @returns {{ getTools: (credentials: Object) => Array }}
 */
function buildConnector(spec) {
  if (!isPlainObject(spec)) throw new Error('buildConnector: spec must be an object')
  if (!Array.isArray(spec.tools)) throw new Error(`buildConnector: spec '${spec.id}' has no tools array`)
  if (typeof spec.custom_tools_module === 'string' && spec.custom_tools_module) {
    throw new Error(`${spec.name || spec.id}: custom_tools_module is not supported by declarative runtime v1`)
  }

  function getTools(credentials) {
    // Per-instance auth state. bridge.js calls getTools() once per pooled
    // instance (per org), so an access token minted here never crosses orgs.
    const authState = { accessToken: null, expiresAt: 0, inflight: null, key: null }

    async function request(tool, input, creds) {
      const baseUrl = resolveBaseUrl(spec, creds)
      const { path, params } = buildUrl(spec, tool, input, creds)
      const { headers: authHeaders, queryParams } = await buildAuth(spec, creds, authState)
      for (const [k, v] of queryParams) params.append(k, v)

      const headers = { 'Content-Type': 'application/json' }
      for (const [name, template] of Object.entries(spec.static_headers || {})) {
        headers[name] = renderCredentialTemplate(template, spec, creds, `the ${name} header`)
      }
      for (const [name, template] of Object.entries(tool.request.headers || {})) {
        const value = renderTemplate(template, { input, creds })
        if (value !== undefined) headers[name] = String(value)
      }
      Object.assign(headers, authHeaders)

      const query = params.toString()
      const url = `${baseUrl}${path}${query ? `?${query}` : ''}`

      const options = {
        method: String(tool.request.method || 'GET').toUpperCase(),
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
      if (tool.request.body !== undefined) {
        const body = renderBody(tool.request.body, { input, creds })
        if (body !== undefined) options.body = JSON.stringify(body)
      }

      const resp = await fetch(url, options)
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`${spec.name} API ${resp.status}: ${text.slice(0, ERROR_BODY_SLICE)}`)
      }
      return resp.json()
    }

    return spec.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      write: tool.write === true,
      // A declarative write is ALWAYS approval-gated: the bridge choke wraps
      // only tool.requiresApproval in withApprovalGate, and the spec format
      // has no field for it, so deriving it from `write` is the only path
      // that keeps a spec'd write from executing ungated (openrouter
      // chat_completion shipped exactly that way).
      ...(tool.write === true ? { requiresApproval: true } : {}),
      execute: async (input, creds) => {
        const payload = await request(tool, input || {}, creds || credentials || {})
        const response = tool.response || {}
        let shaped = isPlainObject(response.pick) ? applyPick(response.pick, payload) : payload
        if (Number.isFinite(response.truncate) && response.truncate > 0) {
          shaped = truncateStrings(shaped, response.truncate)
        }
        return shaped
      },
    }))
  }

  return { getTools }
}

module.exports = {
  buildConnector,
  // exported for tests
  _internals: { renderTemplate, renderBody, applyPick, resolveToken, resolveBaseUrl, truncateStrings },
}

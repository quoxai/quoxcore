/**
 * Connector Spec v1 — validator (CONNFAC Phase 1).
 *
 * A Connector Spec is the declarative form of a connector module: the same
 * contract types/*.js implements by hand, expressed as JSON so it can be
 * generated, diffed and proved. declarativeRuntime.js executes a spec;
 * this file decides whether a spec is fit to execute at all.
 *
 * Hand-rolled on purpose: the collector must stay dependency-light, and a
 * JSON-schema library would still not express the cross-field rules that
 * matter here (placeholders referencing declared inputs, auth blocks that are
 * complete for their type, tool names that survive the `<id>_<tool>` prefix
 * routing in agentTools.parseConnectorTool).
 *
 * NOT checked here: connector-id prefix collisions against other connectors
 * and against static tool names. Those are a REGISTRY-wide property, so they
 * are checked once at registration time by registry.validateConnectorNamespace.
 *
 * validateSpec(spec, opts) → { ok, errors: string[], warnings: string[] }
 *   opts.staticToolNames      — optional: flags EXACT `<id>_<tool>` name clashes
 *   opts.knownCredentialTypes — optional: warn-only credentialType check. The
 *                               auth-side integration registry is deliberately
 *                               NOT imported here (collector stays self-contained).
 */

const ID_PATTERN = /^[a-z0-9_-]+$/
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
const FULL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const AUTH_TYPES = new Set([
  'bearer', 'basic', 'header', 'query',
  'oauth2_refresh', 'oauth2_client_credentials', 'google_service_account', 'none',
])

// oauth2_client_credentials: how the client id/secret pair reaches the token
// endpoint. 'basic' (PayPal, Spotify) is the RFC 6749 §2.3.1 default; 'form'
// (Microsoft identity platform) puts both in the request body.
const CLIENT_AUTH_MODES = new Set(['basic', 'form'])

// google_service_account: the vault field holding the provider's JSON key.
const DEFAULT_SERVICE_ACCOUNT_FIELD = 'service_account_json'

// Fields the scaffolder and the shape-proof harness attach. The runtime ignores
// them; the schema must not reject them (a spec that round-trips through the
// factory tooling has to stay valid).
const KNOWN_TOP_LEVEL = new Set([
  'spec_version', 'id', 'name', 'category', 'credentialType', 'requiredFields',
  'description', 'docs', 'rateLimit', 'base_url', 'auth', 'static_headers',
  'tools', 'test', 'custom_tools_module', 'agents',
  '_scaffold', '_sources', 'tools_source',
])

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Every {{...}} token in a string, trimmed, in source order.
 */
function placeholdersIn(str) {
  const out = []
  if (typeof str !== 'string') return out
  let m
  PLACEHOLDER.lastIndex = 0
  while ((m = PLACEHOLDER.exec(str)) !== null) out.push(m[1].trim())
  return out
}

/**
 * Collect every placeholder token in a nested value (strings, arrays, objects).
 */
function collectPlaceholders(value, out = []) {
  if (typeof value === 'string') {
    out.push(...placeholdersIn(value))
  } else if (Array.isArray(value)) {
    for (const v of value) collectPlaceholders(v, out)
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      out.push(...placeholdersIn(k))
      collectPlaceholders(v, out)
    }
  }
  return out
}

/**
 * Decide whether one placeholder token is resolvable, given the credential
 * fields the connector declares and the input properties the tool declares.
 * Returns null when fine, or a human-readable reason.
 */
function checkToken(token, { credFields, inputProps, where, allowInput }) {
  const trimmed = String(token).trim()
  if (!trimmed) return `${where}: empty placeholder {{}}`

  if (trimmed.startsWith('clamp ')) {
    if (!allowInput) return `${where}: the clamp helper is only available inside a tool request ({{${trimmed}}})`
    const parts = trimmed.split(/\s+/)
    const [, ref, def, cap] = parts
    if (parts.length > 4) return `${where}: clamp takes at most 3 arguments ({{clamp input.x <default> <max>}}), got {{${trimmed}}}`
    if (!ref) return `${where}: clamp needs a value reference ({{clamp input.x 20 50}})`
    if (def !== undefined && !Number.isFinite(Number(def))) return `${where}: clamp default '${def}' is not a number`
    if (cap !== undefined && !Number.isFinite(Number(cap))) return `${where}: clamp max '${cap}' is not a number`
    return checkToken(ref, { credFields, inputProps, where: `${where} (clamp arg)`, allowInput })
  }

  // {{suffix <credentialField> <sep>}} — the part of a credential AFTER its last
  // separator. Mailchimp keys carry their datacenter that way (xxxx-us21) and
  // the API host IS the datacenter. Credentials only: a tool input can never
  // name a datacenter, and rendering a whole secret into a host is the exact
  // mistake this helper exists to avoid.
  if (trimmed.startsWith('suffix ')) {
    const parts = trimmed.split(/\s+/)
    if (parts.length !== 3) {
      return `${where}: suffix takes exactly 2 arguments ({{suffix <credentialField> <separator>}}), got {{${trimmed}}}`
    }
    const [, ref, sep] = parts
    if (sep.length !== 1) return `${where}: suffix separator '${sep}' must be a single character`
    if (ref.startsWith('input.')) {
      return `${where}: {{${trimmed}}} may only reference a credential field, not a tool input`
    }
    if (!credFields.has(ref)) {
      return `${where}: {{${trimmed}}} references '${ref}', which is not listed in requiredFields`
    }
    return null
  }

  if (trimmed.startsWith('input.')) {
    if (!allowInput) return `${where}: {{${trimmed}}} references tool input outside a tool request`
    const prop = trimmed.slice('input.'.length).split('.')[0]
    if (!prop) return `${where}: {{${trimmed}}} names no input property`
    if (!inputProps.has(prop)) {
      return `${where}: {{${trimmed}}} is not declared in the tool's input_schema.properties`
    }
    return null
  }

  if (!credFields.has(trimmed)) {
    return `${where}: {{${trimmed}}} is neither a requiredField nor a declared tool input`
  }
  return null
}

/**
 * A token endpoint: an absolute URL string, or `{ template }` whose placeholders
 * all name declared credential fields (Microsoft's
 * https://login.microsoftonline.com/{{tenant_id}}/oauth2/v2.0/token). A tool
 * input can never reach a token exchange, so `input.` is rejected here.
 */
function checkTokenUrl(tokenUrl, type, credFields, errors) {
  if (typeof tokenUrl === 'string') {
    if (!/^https?:\/\//.test(tokenUrl)) {
      errors.push(`auth.token_url: '${tokenUrl}' must be an absolute http(s) URL`)
    }
    return
  }
  if (isPlainObject(tokenUrl) && typeof tokenUrl.template === 'string' && tokenUrl.template) {
    const tokens = placeholdersIn(tokenUrl.template)
    if (tokens.length === 0 && !/^https?:\/\//.test(tokenUrl.template)) {
      errors.push(`auth.token_url.template: '${tokenUrl.template}' must be an absolute http(s) URL`)
    }
    for (const token of tokens) {
      const bad = checkToken(token, {
        credFields, inputProps: new Set(), where: 'auth.token_url.template', allowInput: false,
      })
      if (bad) errors.push(bad)
    }
    return
  }
  errors.push(`auth.token_url: required for auth.type '${type}' — an absolute http(s) URL or { template } referencing requiredFields`)
}

function checkAuth(spec, auth, credFields, errors, warnings) {
  if (!isPlainObject(auth)) {
    errors.push('auth: must be an object')
    return
  }
  const type = auth.type
  if (!AUTH_TYPES.has(type)) {
    errors.push(`auth.type: '${type}' is not one of ${[...AUTH_TYPES].join(', ')}`)
    return
  }

  const needsCredField = (key) => {
    const field = auth[key]
    if (typeof field !== 'string' || !field) {
      errors.push(`auth.${key}: required (a credential field name) for auth.type '${type}'`)
      return
    }
    if (!credFields.has(field)) {
      errors.push(`auth.${key}: '${field}' is not listed in requiredFields`)
    }
  }

  if (type === 'bearer') {
    needsCredField('field')
  } else if (type === 'basic') {
    // The username is not always a credential: Mailchimp documents
    // `Basic anystring:<key>` (userLiteral) and Zendesk
    // `Basic {email}/token:<token>` (userField + userSuffix). The PASSWORD is
    // always a credential field — passLiteral would put a secret in a spec file.
    const hasUserField = auth.userField !== undefined
    const hasUserLiteral = auth.userLiteral !== undefined
    if (hasUserField && hasUserLiteral) {
      errors.push("auth: exactly one of auth.userField or auth.userLiteral for auth.type 'basic' (got both)")
    } else if (hasUserLiteral) {
      if (typeof auth.userLiteral !== 'string' || !auth.userLiteral) {
        errors.push('auth.userLiteral: must be a non-empty string (a documented literal username, never a secret)')
      }
      if (auth.userSuffix !== undefined) {
        errors.push('auth.userSuffix: only valid alongside auth.userField (fold it into auth.userLiteral instead)')
      }
    } else {
      needsCredField('userField')
      if (auth.userSuffix !== undefined) {
        if (typeof auth.userSuffix !== 'string' || !auth.userSuffix) {
          errors.push('auth.userSuffix: must be a non-empty literal string appended to the userField value')
        } else if (auth.userSuffix.includes('{{')) {
          errors.push('auth.userSuffix: must be a literal, not a template')
        }
      }
    }
    if (auth.passLiteral !== undefined) {
      errors.push('auth.passLiteral: not supported — a basic-auth password is a credential, so use auth.passField')
    }
    // passField may be "" — tailscale authenticates with base64(api_key + ':').
    if (auth.passField !== undefined && typeof auth.passField !== 'string') {
      errors.push('auth.passField: must be a string (use "" for an empty password)')
    } else if (auth.passField) {
      if (!credFields.has(auth.passField)) errors.push(`auth.passField: '${auth.passField}' is not listed in requiredFields`)
    }
  } else if (type === 'header') {
    if (typeof auth.header !== 'string' || !auth.header) errors.push("auth.header: required for auth.type 'header'")
    if (typeof auth.template !== 'string' || !auth.template) {
      errors.push("auth.template: required for auth.type 'header'")
    } else {
      for (const token of placeholdersIn(auth.template)) {
        const bad = checkToken(token, { credFields, inputProps: new Set(), where: 'auth.template', allowInput: false })
        if (bad) errors.push(bad)
      }
    }
  } else if (type === 'query') {
    if (typeof auth.param !== 'string' || !auth.param) errors.push("auth.param: required for auth.type 'query'")
    needsCredField('field')
  } else if (type === 'oauth2_refresh') {
    if (typeof auth.token_url !== 'string' || !/^https?:\/\//.test(auth.token_url)) {
      errors.push("auth.token_url: required absolute URL for auth.type 'oauth2_refresh'")
    }
    needsCredField('clientIdField')
    needsCredField('clientSecretField')
    needsCredField('refreshTokenField')
    if (auth.expiryBufferSec !== undefined && !(Number.isFinite(auth.expiryBufferSec) && auth.expiryBufferSec >= 0)) {
      errors.push('auth.expiryBufferSec: must be a non-negative number')
    }
  } else if (type === 'oauth2_client_credentials') {
    // token_url may be templated: Microsoft's endpoint carries the tenant id,
    // which is a per-customer credential field, not a constant.
    checkTokenUrl(auth.token_url, type, credFields, errors)
    needsCredField('clientIdField')
    needsCredField('clientSecretField')
    // scope is OPTIONAL here, unlike google_service_account: PayPal and Zoom
    // mint a token without one, while Graph refuses without .default.
    if (auth.scope !== undefined && (typeof auth.scope !== 'string' || !auth.scope)) {
      errors.push('auth.scope: must be a non-empty string when present')
    }
    if (auth.grant_type !== undefined && (typeof auth.grant_type !== 'string' || !auth.grant_type)) {
      errors.push("auth.grant_type: must be a non-empty string when present (defaults to 'client_credentials')")
    }
    if (auth.client_auth !== undefined && !CLIENT_AUTH_MODES.has(auth.client_auth)) {
      errors.push(`auth.client_auth: must be one of ${[...CLIENT_AUTH_MODES].join(', ')} (defaults to basic)`)
    }
    if (auth.extra_form !== undefined) {
      if (!isPlainObject(auth.extra_form)) {
        errors.push('auth.extra_form: must be a flat object of token-request form field → literal or {{credentialField}}')
      } else {
        for (const [field, value] of Object.entries(auth.extra_form)) {
          if (typeof value !== 'string' && !Number.isFinite(value)) {
            errors.push(`auth.extra_form['${field}']: must be a string or a number (no nested objects)`)
            continue
          }
          for (const token of placeholdersIn(String(value))) {
            const bad = checkToken(token, {
              credFields, inputProps: new Set(), where: `auth.extra_form['${field}']`, allowInput: false,
            })
            if (bad) errors.push(bad)
          }
        }
      }
    }
    if (auth.expiryBufferSec !== undefined && !(Number.isFinite(auth.expiryBufferSec) && auth.expiryBufferSec >= 0)) {
      errors.push('auth.expiryBufferSec: must be a non-negative number')
    }
  } else if (type === 'google_service_account') {
    // The OAuth scope cannot be inferred from the key: Google mints a token FOR
    // a scope, so a spec that omits it can never authenticate.
    if (typeof auth.scope !== 'string' || !auth.scope) {
      errors.push("auth.scope: required space-delimited OAuth scope string for auth.type 'google_service_account'")
    }
    if (auth.field !== undefined) {
      needsCredField('field')
    } else if (!credFields.has(DEFAULT_SERVICE_ACCOUNT_FIELD)) {
      errors.push(`auth.field: omitted, so '${DEFAULT_SERVICE_ACCOUNT_FIELD}' is assumed, but it is not listed in requiredFields`)
    }
    if (auth.expiryBufferSec !== undefined && !(Number.isFinite(auth.expiryBufferSec) && auth.expiryBufferSec >= 0)) {
      errors.push('auth.expiryBufferSec: must be a non-negative number')
    }
  } else if (type === 'none') {
    // Legitimate only when the credential rides somewhere else — telegram's
    // base_url template https://api.telegram.org/bot{{bot_token}}. With no
    // credential referenced anywhere, the connector is unauthenticated, which
    // is far more often a mistake than a design.
    const carriers = []
    const baseUrl = spec.base_url
    if (isPlainObject(baseUrl) && typeof baseUrl.template === 'string') carriers.push(...placeholdersIn(baseUrl.template))
    if (isPlainObject(spec.static_headers)) {
      for (const value of Object.values(spec.static_headers)) {
        if (typeof value === 'string') carriers.push(...placeholdersIn(value))
      }
    }
    if (carriers.length === 0) {
      warnings.push("auth: type 'none' and no credential is referenced in base_url.template or static_headers — this connector will call the provider unauthenticated")
    }
  }
}

function checkBaseUrl(baseUrl, credFields, errors) {
  if (typeof baseUrl === 'string') {
    if (!/^https?:\/\//.test(baseUrl)) errors.push(`base_url: '${baseUrl}' must be an absolute http(s) URL`)
    return
  }
  if (!isPlainObject(baseUrl)) {
    errors.push('base_url: required — an absolute URL string, { fromCredential }, or { template }')
    return
  }
  const hasFrom = typeof baseUrl.fromCredential === 'string' && baseUrl.fromCredential
  const hasTemplate = typeof baseUrl.template === 'string' && baseUrl.template
  if (!hasFrom && !hasTemplate) {
    errors.push('base_url: object form needs fromCredential and/or template')
    return
  }
  if (hasFrom && !credFields.has(baseUrl.fromCredential)) {
    errors.push(`base_url.fromCredential: '${baseUrl.fromCredential}' is not listed in requiredFields`)
  }
  if (hasTemplate) {
    const tokens = placeholdersIn(baseUrl.template)
    if (tokens.length === 0) {
      if (!/^https?:\/\//.test(baseUrl.template)) errors.push(`base_url.template: '${baseUrl.template}' must be an absolute http(s) URL`)
    }
    for (const token of tokens) {
      const bad = checkToken(token, { credFields, inputProps: new Set(), where: 'base_url.template', allowInput: false })
      if (bad) errors.push(bad)
    }
  }
}

function checkTool(tool, index, { specId, credFields, seenNames, staticToolNames, errors, warnings }) {
  const at = `tools[${index}]`
  if (!isPlainObject(tool)) {
    errors.push(`${at}: must be an object`)
    return
  }

  const name = tool.name
  if (typeof name !== 'string' || !name) {
    errors.push(`${at}.name: required string`)
  } else {
    if (!TOOL_NAME_PATTERN.test(name)) errors.push(`${at}.name: '${name}' must match ${TOOL_NAME_PATTERN}`)
    const fullName = `${specId}_${name}`
    if (!FULL_TOOL_NAME_PATTERN.test(fullName)) {
      errors.push(`${at}.name: the routed tool name '${fullName}' must match ${FULL_TOOL_NAME_PATTERN}`)
    }
    if (seenNames.has(name)) errors.push(`${at}.name: duplicate tool name '${name}'`)
    seenNames.add(name)
    if (staticToolNames && staticToolNames.includes(fullName)) {
      errors.push(`${at}.name: '${fullName}' collides with an existing static tool of the same name`)
    }
  }

  if (typeof tool.description !== 'string' || !tool.description) errors.push(`${at}.description: required string`)

  const inputProps = new Set()
  if (!isPlainObject(tool.input_schema)) {
    errors.push(`${at}.input_schema: required object`)
  } else {
    if (tool.input_schema.type !== 'object') errors.push(`${at}.input_schema.type: must be 'object'`)
    if (tool.input_schema.properties !== undefined && !isPlainObject(tool.input_schema.properties)) {
      errors.push(`${at}.input_schema.properties: must be an object`)
    } else {
      for (const prop of Object.keys(tool.input_schema.properties || {})) inputProps.add(prop)
    }
    if (tool.input_schema.required !== undefined) {
      if (!Array.isArray(tool.input_schema.required)) {
        errors.push(`${at}.input_schema.required: must be an array`)
      } else {
        for (const req of tool.input_schema.required) {
          if (!inputProps.has(req)) errors.push(`${at}.input_schema.required: '${req}' is not a declared property`)
        }
      }
    }
  }

  const request = tool.request
  if (!isPlainObject(request)) {
    errors.push(`${at}.request: required object`)
  } else {
    const method = String(request.method || '').toUpperCase()
    if (!HTTP_METHODS.has(method)) errors.push(`${at}.request.method: '${request.method}' is not a supported HTTP method`)
    if (typeof request.path !== 'string' || !request.path.startsWith('/')) {
      errors.push(`${at}.request.path: required string starting with '/'`)
    }
    if (request.query !== undefined && !isPlainObject(request.query)) errors.push(`${at}.request.query: must be an object`)
    if (request.body !== undefined && !isPlainObject(request.body) && !Array.isArray(request.body)) {
      errors.push(`${at}.request.body: must be an object or array`)
    }
    if (request.headers !== undefined && !isPlainObject(request.headers)) errors.push(`${at}.request.headers: must be an object`)

    const tokens = [
      ...placeholdersIn(request.path),
      ...collectPlaceholders(request.query || {}),
      ...collectPlaceholders(request.body === undefined ? {} : request.body),
      ...collectPlaceholders(request.headers || {}),
    ]
    for (const token of tokens) {
      const bad = checkToken(token, { credFields, inputProps, where: `${at}.request`, allowInput: true })
      if (bad) errors.push(bad)
    }
  }

  if (tool.response !== undefined) {
    if (!isPlainObject(tool.response)) {
      errors.push(`${at}.response: must be an object`)
    } else {
      if (tool.response.pick !== undefined && !isPlainObject(tool.response.pick)) {
        errors.push(`${at}.response.pick: must be an object`)
      } else if (isPlainObject(tool.response.pick)) {
        checkPick(tool.response.pick, `${at}.response.pick`, errors)
      }
      if (tool.response.truncate !== undefined && !(Number.isFinite(tool.response.truncate) && tool.response.truncate > 0)) {
        errors.push(`${at}.response.truncate: must be a positive number`)
      }
    }
  }

  if (tool._probe !== undefined) {
    checkProbe(tool._probe, `${at}._probe`, { credFields, inputProps, allowInput: true }, errors, warnings)
  }

  if (tool.write !== undefined && typeof tool.write !== 'boolean') errors.push(`${at}.write: must be a boolean`)

  if (tool.request && isPlainObject(tool.request) && String(tool.request.method || '').toUpperCase() === 'GET' && tool.write === true) {
    warnings.push(`${at}: marked write:true but issues a GET`)
  }
}

/**
 * Spec v1.1 `_probe`: safe public values the SHAPE-PROOF HARNESS may substitute
 * for a placeholder when a dummy value cannot route (tenant-slug APIs such as
 * sentry's /organizations/{org_slug}/). The runtime ignores it entirely.
 *
 * Shape is an error (a malformed hint would silently mis-substitute); an
 * unresolvable key is a warning, because the harness simply ignores hints it
 * cannot place and the connector still works.
 */
function checkProbe(probe, at, { credFields, inputProps, allowInput }, errors, warnings) {
  if (!isPlainObject(probe)) {
    errors.push(`${at}: must be a flat object of placeholder name → safe probe value`)
    return
  }
  for (const [key, value] of Object.entries(probe)) {
    if (typeof value !== 'string' && !Number.isFinite(value)) {
      errors.push(`${at}['${key}']: probe values must be a string or a number (no nested objects)`)
      continue
    }
    const bad = checkToken(key, { credFields, inputProps, where: at, allowInput })
    if (bad) warnings.push(`${bad} — the shape-proof harness will ignore this probe hint`)
  }
}

function checkPick(pick, at, errors) {
  const keys = Object.keys(pick)
  // Spec v1.1: "[]" means "the payload IS the array" (datadog, netlify, sendgrid,
  // acuity, sentry all answer with a top-level array). A root array has no
  // siblings, so mixing it with other keys is always a mistake.
  if (keys.includes('[]') && keys.length > 1) {
    errors.push(`${at}['[]']: a root-array pick must be the only key (found ${keys.length})`)
  }
  for (const [key, source] of Object.entries(pick)) {
    if (key.endsWith('[]')) {
      if (!isPlainObject(source)) {
        errors.push(`${at}['${key}']: an array pick must map to an object of sub-picks`)
      } else {
        checkPick(source, `${at}['${key}']`, errors)
      }
    } else if (typeof source !== 'string' || !source) {
      errors.push(`${at}['${key}']: must be a dotted source path string`)
    }
  }
}

/**
 * Validate a Connector Spec v1 document.
 */
function validateSpec(spec, opts = {}) {
  const errors = []
  const warnings = []
  const staticToolNames = Array.isArray(opts.staticToolNames) ? opts.staticToolNames : null
  const knownCredentialTypes = Array.isArray(opts.knownCredentialTypes) ? opts.knownCredentialTypes : null

  if (!isPlainObject(spec)) {
    return { ok: false, errors: ['spec: must be a JSON object'], warnings }
  }

  if (spec.spec_version !== 1) errors.push(`spec_version: expected 1, got ${JSON.stringify(spec.spec_version)}`)

  const specId = spec.id
  if (typeof specId !== 'string' || !specId) {
    errors.push('id: required string')
  } else if (!ID_PATTERN.test(specId)) {
    errors.push(`id: '${specId}' must match ${ID_PATTERN} (it is used as a bare tool-name prefix)`)
  }

  if (typeof spec.name !== 'string' || !spec.name) errors.push('name: required string')
  if (typeof spec.category !== 'string' || !spec.category) errors.push('category: required string')
  if (typeof spec.credentialType !== 'string' || !spec.credentialType) {
    errors.push('credentialType: required string')
  } else if (knownCredentialTypes && !knownCredentialTypes.includes(spec.credentialType)) {
    warnings.push(`credentialType: '${spec.credentialType}' was not found in the supplied integration type registry`)
  }

  const credFields = new Set()
  if (!Array.isArray(spec.requiredFields)) {
    errors.push('requiredFields: required array of credential field names')
  } else {
    for (const field of spec.requiredFields) {
      if (typeof field !== 'string' || !field) errors.push(`requiredFields: '${field}' is not a field name`)
      else credFields.add(field)
    }
  }
  // The vault passes these through for any connector that has them; a spec may
  // reference them without declaring them required (gitlab's optional base_url).
  for (const optional of ['endpoint_url', 'email', 'base_url']) credFields.add(optional)

  if (spec.docs !== undefined && typeof spec.docs !== 'string') errors.push('docs: must be a string')
  if (spec.description !== undefined && typeof spec.description !== 'string') errors.push('description: must be a string')

  if (spec.rateLimit !== undefined) {
    if (!isPlainObject(spec.rateLimit)) {
      errors.push('rateLimit: must be an object { windowMs, max }')
    } else {
      if (!(Number.isFinite(spec.rateLimit.windowMs) && spec.rateLimit.windowMs > 0)) errors.push('rateLimit.windowMs: must be a positive number')
      if (!(Number.isFinite(spec.rateLimit.max) && spec.rateLimit.max > 0)) errors.push('rateLimit.max: must be a positive number')
    }
  } else {
    warnings.push('rateLimit: not declared — this connector will not be rate limited')
  }

  checkBaseUrl(spec.base_url, credFields, errors)
  checkAuth(spec, spec.auth, credFields, errors, warnings)

  if (spec.static_headers !== undefined) {
    if (!isPlainObject(spec.static_headers)) {
      errors.push('static_headers: must be an object of header name → value')
    } else {
      for (const [header, value] of Object.entries(spec.static_headers)) {
        if (typeof value !== 'string') {
          errors.push(`static_headers['${header}']: must be a string`)
          continue
        }
        for (const token of placeholdersIn(value)) {
          const bad = checkToken(token, { credFields, inputProps: new Set(), where: `static_headers['${header}']`, allowInput: false })
          if (bad) errors.push(bad)
        }
      }
    }
  }

  // The shape-proof harness reads this block; the runtime ignores it.
  if (spec.test !== undefined) {
    if (!isPlainObject(spec.test)) {
      errors.push('test: must be an object { method, path, query?, body? }')
    } else {
      if (!HTTP_METHODS.has(String(spec.test.method || '').toUpperCase())) errors.push(`test.method: '${spec.test.method}' is not a supported HTTP method`)
      if (typeof spec.test.path !== 'string' || !spec.test.path.startsWith('/')) errors.push("test.path: required string starting with '/'")
      if (spec.test.query !== undefined && !isPlainObject(spec.test.query)) errors.push('test.query: must be an object')
      if (spec.test._probe !== undefined) {
        checkProbe(spec.test._probe, 'test._probe', { credFields, inputProps: new Set(), allowInput: false }, errors, warnings)
      }
    }
  }

  if (!Array.isArray(spec.tools)) {
    errors.push('tools: required array (may be empty)')
  } else {
    const seenNames = new Set()
    spec.tools.forEach((tool, i) => checkTool(tool, i, {
      specId: typeof specId === 'string' ? specId : '',
      credFields, seenNames, staticToolNames, errors, warnings,
    }))
    if (spec.tools.length === 0) warnings.push('tools: empty — this spec registers no tools')
  }

  if (spec.custom_tools_module !== undefined && spec.custom_tools_module !== null && typeof spec.custom_tools_module !== 'string') {
    errors.push('custom_tools_module: must be a module path string or null')
  }
  if (spec.agents !== undefined && !(Array.isArray(spec.agents) && spec.agents.every(a => typeof a === 'string'))) {
    errors.push('agents: must be an array of agent ids')
  }

  for (const key of Object.keys(spec)) {
    if (!KNOWN_TOP_LEVEL.has(key)) warnings.push(`unknown top-level field '${key}' (ignored by the runtime)`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

module.exports = { validateSpec }

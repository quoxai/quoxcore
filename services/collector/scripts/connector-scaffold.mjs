#!/usr/bin/env node
/**
 * connector-scaffold — reverse-engineer Connector Spec v1 skeletons from the
 * vault's integration type registry (services/auth/config/integrationTypeRegistry.js).
 *
 * Mechanism: sentinel injection. For each integration type we build fake
 * credentials where every field key maps to a unique marker
 * (`QXSENT7a<fieldKey>QXSENT7z`), then call the type's own `testEndpoint` /
 * `testHeaders` / `testBody` / `testParams` with them. Wherever a sentinel
 * surfaces tells us what the type does with that credential: a bearer header,
 * a basic pair, a raw header template, a query param, or the host itself.
 * Nothing is guessed from names except as a last resort, and everything that
 * had to be guessed lands in `_scaffold.needs_review`.
 *
 * Output is a DRAFT skeleton: `tools` is deliberately EMPTY. Filling
 * `tools[]` from the vendor's API docs is the next (human or agent) step;
 * this script only removes the boilerplate around it.
 *
 * Two deliberate deltas from the spec in docs/STREAM_CONNECTOR_FACTORY_PLAN.md 4.2:
 *   1. top-level `test` — the shape-proof auth-proving call lifted from the
 *      registry's own connection test. It is NOT an agent tool.
 *   2. `base_url.template` — emitted ONLY when a credential-derived base URL
 *      carries surrounding text that `{ fromCredential }` alone would lose
 *      (datadog's `https://api.{{site}}`, shopify's `https://{{shop_domain}}`).
 *      Always paired with a `base_url_template` review flag.
 *
 * Usage:
 *   node scripts/connector-scaffold.mjs --ids pagerduty,stripe,datadog
 *   node scripts/connector-scaffold.mjs --all [--force] [--out <dir>]
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import { INTEGRATION_TYPES } from '../../auth/config/integrationTypeRegistry.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.join(HERE, '..', 'lib', 'connectors', 'specs', 'drafts');

export const SENTINEL_PREFIX = 'QXSENT7a';
export const SENTINEL_SUFFIX = 'QXSENT7z';

// Matched case-insensitively: WHATWG URL lowercases the host, so a sentinel
// that lands in the host comes back as `qxsent7ashop_domainqxsent7z`.
const SENTINEL_RE = /QXSENT7a([A-Za-z0-9_%.-]+?)QXSENT7z/gi;

/** Sentinel marker for one credential field key. */
export function sentinelFor(fieldKey) {
  return `${SENTINEL_PREFIX}${fieldKey}${SENTINEL_SUFFIX}`;
}

/** Build the fake credential object handed to the registry's test functions. */
export function buildSentinels(fields = []) {
  const creds = {};
  for (const f of fields) {
    if (f && f.key) creds[f.key] = sentinelFor(f.key);
  }
  return creds;
}

/**
 * Map a sentinel capture back to the real field key (case and URL-encoding
 * survive-proof). Returns null when the capture matches no declared field.
 */
function resolveFieldKey(captured, fieldKeys) {
  let candidate = captured;
  try {
    candidate = decodeURIComponent(captured);
  } catch {
    /* leave as-is: a stray % is not our problem */
  }
  const lower = candidate.toLowerCase();
  return fieldKeys.find((k) => k.toLowerCase() === lower) || null;
}

/** Every field key whose sentinel appears in `str`, in order of appearance. */
export function findSentinelFields(str, fieldKeys) {
  if (typeof str !== 'string') return [];
  const out = [];
  SENTINEL_RE.lastIndex = 0;
  let m;
  while ((m = SENTINEL_RE.exec(str)) !== null) {
    const key = resolveFieldKey(m[1], fieldKeys);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Replace every sentinel in `str` with its `{{field}}` template placeholder. */
export function templatize(str, fieldKeys) {
  if (typeof str !== 'string') return str;
  return str.replace(SENTINEL_RE, (full, captured) => {
    const key = resolveFieldKey(captured, fieldKeys);
    return key ? `{{${key}}}` : full;
  });
}

/** Deep-templatize a JSON-ish value (objects, arrays, strings). */
export function templatizeDeep(value, fieldKeys) {
  if (typeof value === 'string') return templatize(value, fieldKeys);
  if (Array.isArray(value)) return value.map((v) => templatizeDeep(v, fieldKeys));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = templatizeDeep(v, fieldKeys);
    return out;
  }
  return value;
}

/**
 * Run the type's own test config against sentinel credentials.
 * Throws are the caller's business: a type that cannot survive sentinel
 * injection (mattermost/rocketchat run `new URL(creds.webhook_url)`) is a
 * recorded skip, never a silent partial scaffold.
 */
export function resolveTestConfig(type) {
  const fields = Array.isArray(type.fields) ? type.fields : [];
  const creds = buildSentinels(fields);
  const endpoint =
    typeof type.testEndpoint === 'function' ? type.testEndpoint(creds) : type.testEndpoint;
  const headers =
    typeof type.testHeaders === 'function' ? type.testHeaders(creds) : type.testHeaders || {};
  const body = typeof type.testBody === 'function' ? type.testBody(creds) : type.testBody;
  const params =
    typeof type.testParams === 'function' ? type.testParams(creds) : type.testParams || null;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('testEndpoint did not resolve to a string');
  }
  return { endpoint, headers: headers || {}, body, params, fieldKeys: fields.map((f) => f.key) };
}

// Credential fields that conventionally hold a whole base URL, used only when
// the registry gives a bare relative endpoint like '/api/v4/user'.
const BASE_URL_FIELD_CANDIDATES = [
  'base_url',
  'instance_url',
  'server_url',
  'endpoint_url',
  'host_url',
  'url',
  'host',
  'domain',
];

/**
 * Split a resolved test endpoint into a spec `base_url`, a path, and a query
 * object. Sentinels in the host become `{ fromCredential }`; sentinels in the
 * path or query become `{{field}}` templates.
 */
export function inferEndpointParts(endpoint, fieldKeys) {
  const needsReview = [];
  let base_url = null;
  let rest = endpoint;

  const scheme = endpoint.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  const leadingSentinel = endpoint.match(
    new RegExp(`^${SENTINEL_PREFIX}([A-Za-z0-9_%.-]+?)${SENTINEL_SUFFIX}`, 'i')
  );

  if (scheme) {
    const afterScheme = endpoint.slice(scheme[0].length);
    const cut = afterScheme.search(/[/?#]/);
    const hostPart = cut === -1 ? afterScheme : afterScheme.slice(0, cut);
    rest = cut === -1 ? '' : afterScheme.slice(cut);
    const hostFields = findSentinelFields(hostPart, fieldKeys);
    if (hostFields.length > 0) {
      const template = scheme[0] + templatize(hostPart, fieldKeys);
      base_url = { fromCredential: hostFields[0] };
      // Only carry a template when {{field}} alone would lose the scheme or
      // surrounding host text (datadog `api.{{site}}`, shopify `{{shop_domain}}`).
      base_url.template = template;
      needsReview.push('base_url_template');
      if (hostFields.length > 1) needsReview.push('multi_credential_host');
    } else {
      base_url = scheme[0] + hostPart;
    }
  } else if (leadingSentinel) {
    // `${creds.base_url}/api/v1/version` — the credential holds a full URL.
    const key = resolveFieldKey(leadingSentinel[1], fieldKeys);
    base_url = key ? { fromCredential: key } : null;
    if (!key) needsReview.push('unresolved_base_credential');
    rest = endpoint.slice(leadingSentinel[0].length);
  } else if (endpoint.startsWith('/')) {
    // Bare relative endpoint: the registry resolves it against a base_url field.
    const key = BASE_URL_FIELD_CANDIDATES.find((c) => fieldKeys.includes(c));
    base_url = key ? { fromCredential: key } : null;
    needsReview.push(key ? 'relative_endpoint' : 'base_url_unknown');
    rest = endpoint;
  } else {
    needsReview.push('unparsable_endpoint');
    rest = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  }

  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx);
  const qIdx = rest.indexOf('?');
  const rawPath = qIdx === -1 ? rest : rest.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? '' : rest.slice(qIdx + 1);

  const query = {};
  if (rawQuery) {
    for (const [k, v] of new URLSearchParams(rawQuery).entries()) query[k] = v;
  }

  const pathFields = findSentinelFields(rawPath, fieldKeys);

  return {
    base_url,
    path: templatize(rawPath || '/', fieldKeys) || '/',
    rawQuery: query,
    pathFields,
    needsReview,
  };
}

function decodeBasic(value) {
  try {
    return Buffer.from(value.slice('Basic '.length).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Infer the spec `auth` block plus `static_headers` from resolved headers,
 * query params and path. Returns the auth param it consumed so the caller can
 * keep it out of the `test.query` block (the runtime injects it).
 */
export function inferAuth({ headers = {}, query = {}, pathFields = [], fieldKeys = [] }) {
  const needsReview = [];
  const static_headers = {};
  const sentinelHeaders = [];

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      static_headers[name] = value;
      continue;
    }
    // A Basic header hides its sentinels inside base64, so probe the decoded
    // form too: scanning the raw value alone silently misses all 55 basic types.
    const decoded = /^Basic\s/i.test(value) ? decodeBasic(value) : null;
    const carriesCredential =
      findSentinelFields(value, fieldKeys).length > 0 ||
      (decoded !== null && findSentinelFields(decoded, fieldKeys).length > 0);
    if (carriesCredential) sentinelHeaders.push([name, value]);
    else static_headers[name] = value;
  }

  let auth = null;
  let consumedQueryParam = null;

  if (sentinelHeaders.length > 0) {
    const [name, value] = sentinelHeaders[0];
    const fields = findSentinelFields(value, fieldKeys);
    const bearerExact = new RegExp(
      `^Bearer\\s+${SENTINEL_PREFIX}([A-Za-z0-9_%.-]+?)${SENTINEL_SUFFIX}$`,
      'i'
    ).exec(value);

    if (bearerExact && fields.length === 1) {
      auth = { type: 'bearer', field: fields[0] };
    } else if (/^Basic\s/i.test(value)) {
      const decoded = decodeBasic(value);
      if (decoded === null) {
        auth = { type: 'header', header: name, template: templatize(value, fieldKeys) };
        needsReview.push('basic_decode_failed');
      } else {
        const sep = decoded.indexOf(':');
        const left = sep === -1 ? decoded : decoded.slice(0, sep);
        const right = sep === -1 ? '' : decoded.slice(sep + 1);
        const userFields = findSentinelFields(left, fieldKeys);
        const passFields = findSentinelFields(right, fieldKeys);
        auth = {
          type: 'basic',
          userField: userFields[0] || '',
          passField: passFields[0] || '',
        };
        if (!userFields.length) needsReview.push('basic_literal_user');
        if (!passFields.length && right.length > 0) needsReview.push('basic_literal_password');
      }
    } else {
      auth = { type: 'header', header: name, template: templatize(value, fieldKeys) };
    }

    for (const [extraName, extraValue] of sentinelHeaders.slice(1)) {
      static_headers[extraName] = templatize(extraValue, fieldKeys);
    }
    if (sentinelHeaders.length > 1) needsReview.push('multi_auth_headers');
  } else {
    const sentinelParams = Object.entries(query).filter(
      ([, v]) => findSentinelFields(v, fieldKeys).length > 0
    );
    if (sentinelParams.length > 0) {
      const [param, value] = sentinelParams[0];
      auth = { type: 'query', param, field: findSentinelFields(value, fieldKeys)[0] };
      consumedQueryParam = param;
      if (sentinelParams.length > 1) needsReview.push('multi_query_auth');
    } else if (pathFields.length > 0) {
      needsReview.push('auth_in_path');
    } else {
      needsReview.push('no_auth_detected');
    }
  }

  return { auth, static_headers, needsReview, consumedQueryParam };
}

const OAUTH_REFRESH_SHAPE = ['refresh_token', 'client_id', 'client_secret'];

/** Best-effort oauth2 refresh block when the credential fields carry that shape. */
export function inferOAuth2(fieldKeys, endpoint) {
  if (!OAUTH_REFRESH_SHAPE.every((k) => fieldKeys.includes(k))) return null;
  return {
    type: 'oauth2_refresh',
    token_url: /token|oauth/i.test(endpoint) ? endpoint : null,
    clientIdField: 'client_id',
    clientSecretField: 'client_secret',
    refreshTokenField: 'refresh_token',
    expiryBufferSec: 60,
  };
}

/** Every `{{field}}` placeholder in a template string. */
function placeholderFields(str) {
  if (typeof str !== 'string') return [];
  return [...str.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]);
}

/**
 * Credential fields the inferred auth block and base_url actually need at
 * runtime, in registry field order. These become spec-required regardless of
 * whether the vault form marks them optional.
 */
export function collectReferencedFields({ auth, base_url, fieldKeys = [] }) {
  const refs = [];
  const push = (k) => {
    if (k && fieldKeys.includes(k) && !refs.includes(k)) refs.push(k);
  };

  if (auth && typeof auth === 'object') {
    push(auth.field);
    push(auth.userField);
    push(auth.passField);
    push(auth.clientIdField);
    push(auth.clientSecretField);
    push(auth.refreshTokenField);
    for (const k of placeholderFields(auth.template)) push(k);
  }

  if (typeof base_url === 'string') {
    for (const k of placeholderFields(base_url)) push(k);
  } else if (base_url && typeof base_url === 'object') {
    push(base_url.fromCredential);
    for (const k of placeholderFields(base_url.template)) push(k);
  }

  return refs;
}

const CATEGORY_KEYWORDS = [
  ['incident_management', /incident|on-?call|pager|alerting|escalation/i],
  ['monitoring', /monitor|metric|observab|telemetry|uptime|\bapm\b|log management|status page/i],
  ['security', /security|vulnerab|\bsiem\b|threat|malware|pentest|compliance|identity|\bsso\b|password manager/i],
  ['payments', /payment|billing|invoic|subscription|checkout|payout|accounting/i],
  ['crm', /\bcrm\b|customer relationship|sales pipeline|\bleads?\b|contact management/i],
  ['marketing', /marketing|\bseo\b|advertis|\bads\b|campaign|social media|analytics platform/i],
  ['email', /\bemail\b|\bsmtp\b|newsletter|transactional mail|mailbox|inbox/i],
  ['communication', /chat|messaging|\bsms\b|telephony|voice|video (call|conferenc)|notification/i],
  ['developer', /\bgit\b|repositor|source code|\bci\/?cd\b|continuous (integration|deployment)|build pipeline|package registry|error tracking|feature flag/i],
  ['project_management', /project management|issue track|task management|kanban|sprint|roadmap|work management/i],
  ['knowledge', /wiki|knowledge base|documentation|note-?taking|notes and/i],
  ['storage', /file storage|cloud storage|object storage|\bbackup\b|file sharing|\bdrive\b/i],
  ['data', /database|data warehouse|\bsql\b|business intelligence|\betl\b|data pipeline|spreadsheet/i],
  ['ai', /\bai\b|\bllm\b|language model|machine learning|inference|image generation|speech|transcription/i],
  ['ecommerce', /e-?commerce|online store|shopping|inventory|marketplace|point of sale/i],
  ['hr', /\bhr\b|payroll|recruit|applicant|employee|people ops/i],
  ['forms', /\bforms?\b|survey|feedback collection|questionnaire/i],
  ['productivity', /calendar|schedul|meeting|to-?do|automation platform|workflow automation/i],
  ['infrastructure', /cloud (platform|provider|infrastructure)|hosting|virtual machine|kubernetes|container|\bdns\b|\bcdn\b|networking|server management|infrastructure/i],
];

/** Best-effort category from the type's description and name. */
export function inferCategory(type) {
  const haystack = `${type.description || ''} ${type.name || ''}`;
  for (const [category, re] of CATEGORY_KEYWORDS) {
    if (re.test(haystack)) return category;
  }
  return 'uncategorized';
}

/**
 * Turn one integration type entry into a Connector Spec v1 draft skeleton.
 * Throws only on unrecoverable resolution failure (caller records a skip).
 */
export function scaffoldType(type, { generatedAt = new Date().toISOString() } = {}) {
  const resolved = resolveTestConfig(type);
  const { endpoint, headers, body, params, fieldKeys } = resolved;

  const parts = inferEndpointParts(endpoint, fieldKeys);
  const query = { ...parts.rawQuery };
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) query[k] = String(v);
  }

  const authResult = inferAuth({ headers, query, pathFields: parts.pathFields, fieldKeys });
  const needsReview = [...parts.needsReview, ...authResult.needsReview];

  let auth = authResult.auth;
  const oauth = inferOAuth2(fieldKeys, endpoint);
  let detectedAuth = null;
  if (oauth) {
    detectedAuth = auth;
    auth = oauth;
    needsReview.push('oauth2');
  }

  if (authResult.consumedQueryParam) delete query[authResult.consumedQueryParam];
  const testQuery = {};
  for (const [k, v] of Object.entries(query)) testQuery[k] = templatize(v, fieldKeys);

  const test = { method: (type.testMethod || 'GET').toUpperCase(), path: parts.path };
  if (Object.keys(testQuery).length > 0) test.query = testQuery;
  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || typeof body === 'object') {
      test.body = templatizeDeep(body, fieldKeys);
    } else {
      needsReview.push('unserializable_test_body');
    }
  }

  // A field the connector must have at runtime is required by the SPEC even
  // when the vault form marks it optional (self-hosted services with optional
  // tokens, oauth_token variants). Union them in and flag the divergence.
  const declaredRequired = (type.fields || []).filter((f) => f.required).map((f) => f.key);
  const referenced = collectReferencedFields({ auth, base_url: parts.base_url, fieldKeys });
  const requiredFields = (type.fields || [])
    .map((f) => f.key)
    .filter((k) => declaredRequired.includes(k) || referenced.includes(k));
  for (const key of referenced) {
    if (!declaredRequired.includes(key)) needsReview.push(`auth_field_optional_in_registry:${key}`);
  }
  const concreteAuth =
    auth && ['bearer', 'basic', 'header', 'query'].includes(auth.type) && !oauth;
  const confidence =
    concreteAuth && needsReview.length === 0 && typeof parts.base_url === 'string'
      ? 'high'
      : concreteAuth && needsReview.every((r) => r === 'relative_endpoint')
        ? 'high'
        : 'low';

  const spec = {
    spec_version: 1,
    id: type.id,
    name: type.name || type.id,
    category: inferCategory(type),
    credentialType: type.id,
    requiredFields,
    docs: type.docs || null,
    base_url: parts.base_url,
    auth,
    tools: [],
    test,
    _scaffold: {
      generated_at: generatedAt,
      source: 'integrationTypeRegistry',
      confidence,
      needs_review: [...new Set(needsReview)],
    },
  };

  if (Object.keys(authResult.static_headers).length > 0) {
    spec.static_headers = authResult.static_headers;
  }
  if (detectedAuth) spec._scaffold.detected_auth = detectedAuth;

  // Key order for readability: spec fields, then tools, then the scaffold note.
  return {
    spec_version: spec.spec_version,
    id: spec.id,
    name: spec.name,
    category: spec.category,
    credentialType: spec.credentialType,
    requiredFields: spec.requiredFields,
    docs: spec.docs,
    base_url: spec.base_url,
    auth: spec.auth,
    ...(spec.static_headers ? { static_headers: spec.static_headers } : {}),
    test: spec.test,
    tools: spec.tools,
    _scaffold: spec._scaffold,
  };
}

/** Ids already served by a hand-written connector module. */
export function existingConnectorIds() {
  try {
    const { CONNECTOR_REGISTRY } = require('../lib/connectors/registry.js');
    const ids = new Set(Object.keys(CONNECTOR_REGISTRY));
    for (const entry of Object.values(CONNECTOR_REGISTRY)) {
      if (entry && entry.credentialType) ids.add(entry.credentialType);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Scaffold a set of integration types into `outDir`.
 * Returns an honest summary: nothing is counted as scaffolded unless a file
 * was written (or would have been, in dryRun).
 */
export function runScaffold({
  ids = null,
  all = false,
  force = false,
  outDir = DEFAULT_OUT_DIR,
  types = INTEGRATION_TYPES,
  skipExisting = true,
  dryRun = false,
} = {}) {
  const generatedAt = new Date().toISOString();
  const existing = skipExisting ? existingConnectorIds() : new Set();
  const targetIds = ids && ids.length ? ids : all ? Object.keys(types) : [];

  const summary = {
    outDir,
    scaffolded: [],
    lowConfidence: [],
    skippedNoEndpoint: [],
    skippedExisting: [],
    skippedFileExists: [],
    skippedUnknownId: [],
    errors: [],
  };

  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

  for (const id of targetIds) {
    const type = types[id];
    if (!type) {
      summary.skippedUnknownId.push(id);
      continue;
    }
    if (!type.testEndpoint) {
      summary.skippedNoEndpoint.push(id);
      continue;
    }
    if (existing.has(id)) {
      summary.skippedExisting.push(id);
      continue;
    }
    const file = path.join(outDir, `${id}.connector.json`);
    if (!force && fs.existsSync(file)) {
      summary.skippedFileExists.push(id);
      continue;
    }
    let spec;
    try {
      spec = scaffoldType(type, { generatedAt });
    } catch (err) {
      summary.errors.push({ id, reason: err && err.message ? err.message : String(err) });
      continue;
    }
    if (!dryRun) fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    summary.scaffolded.push(id);
    if (spec._scaffold.confidence === 'low') summary.lowConfidence.push(id);
  }

  return summary;
}

function parseArgs(argv) {
  const opts = { ids: null, all: false, force: false, out: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') opts.all = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--ids') opts.ids = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--ids=')) opts.ids = arg.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--out') opts.out = path.resolve(String(argv[++i] || ''));
    else if (arg.startsWith('--out=')) opts.out = path.resolve(arg.slice(6));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function printSummary(summary) {
  const line = (label, arr) => {
    if (!arr.length) return;
    const shown = arr.slice(0, 20).join(', ');
    console.log(`  ${label.padEnd(22)} ${arr.length}${arr.length ? `  (${shown}${arr.length > 20 ? ', ...' : ''})` : ''}`);
  };
  console.log(`\nⓆ QUOX │ connector-scaffold │ out ${summary.outDir}`);
  console.log(`  ${'scaffolded'.padEnd(22)} ${summary.scaffolded.length}`);
  line('low confidence', summary.lowConfidence);
  line('skipped no endpoint', summary.skippedNoEndpoint);
  line('skipped existing', summary.skippedExisting);
  line('skipped file exists', summary.skippedFileExists);
  line('skipped unknown id', summary.skippedUnknownId);
  if (summary.errors.length) {
    console.log(`  ${'skipped error'.padEnd(22)} ${summary.errors.length}`);
    for (const e of summary.errors.slice(0, 30)) console.log(`     ${e.id}: ${e.reason}`);
    if (summary.errors.length > 30) console.log(`     ... ${summary.errors.length - 30} more`);
  }
  console.log('');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (!opts.all && (!opts.ids || opts.ids.length === 0)) {
    console.error('usage: node scripts/connector-scaffold.mjs [--ids a,b,c] [--all] [--force] [--out <dir>]');
    process.exit(2);
  }
  const summary = runScaffold({
    ids: opts.ids,
    all: opts.all,
    force: opts.force,
    outDir: opts.out,
  });
  printSummary(summary);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();

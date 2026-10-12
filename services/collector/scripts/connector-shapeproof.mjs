#!/usr/bin/env node
/**
 * connector-shapeproof — blind shape-proof harness for Connector Spec v1 files.
 *
 * We cannot hold accounts for 400+ services, so we prove the WIRING rather than
 * the data: every request in a spec is fired at the REAL host with a dummy
 * credential, and the response is classified. A structured 401/403 at the
 * expected path proves DNS, TLS, base_url, the auth header name and the path
 * are all right; a real credential would flip that same call to 2xx.
 *
 * Every network spec also gets a CONTROL probe: the same host and auth against a
 * deterministic bogus path. Stripe answers 404 there and 401 on the real path,
 * so the difference proves the path (SHAPE_PROVEN). PagerDuty answers 401 to
 * both, so the auth wall sits in front of routing and the path stays unproven
 * (AUTH_WALL).
 *
 * Usage:
 *   node scripts/connector-shapeproof.mjs <spec-file>... \
 *     [--out <proofs dir>] [--concurrency 4] [--timeout 10000] [--include-writes]
 *
 * Safety model:
 *   - Write-marked tools are fired ONLY when --include-writes is passed AND the
 *     spec's test call came back 401/403 (auth is enforced upstream of the
 *     handler, so a dummy-cred write cannot mutate). Otherwise: SKIPPED_WRITE.
 *   - oauth2_refresh specs are never probed: a token endpoint round-trip with
 *     dummy client credentials proves nothing about the API surface.
 *   - base_url {fromCredential} specs are never probed: there is no host to
 *     reach until a customer supplies their instance domain.
 *
 * Honesty rules baked in:
 *   - Status is checked before the body is ever looked at. An error body is not
 *     data.
 *   - Proof files are evidence artifacts. Failures are recorded, never dropped.
 *
 * See docs/STREAM_CONNECTOR_FACTORY_PLAN.md §4.2 for Connector Spec v1.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUNNER = 'shapeproof/1';
export const DUMMY_PREFIX = 'QUOXSHAPEPROOFDUMMY';

// Auth types where a real runtime first exchanges credentials for a bearer
// token. The harness cannot run that exchange blind, but the API surface behind
// it still answers a dummy bearer exactly as it answers an expired one.
export const TOKEN_FLOW_AUTH_TYPES = new Set([
  'oauth2_refresh',
  'oauth2_client_credentials',
  'google_service_account'
]);
export const DUMMY_BEARER = DUMMY_PREFIX + 'TOKEN';

export const TOKEN_FLOW_NOTE =
  'This spec authenticates through a token exchange, which is NOT blind-provable: the harness probes ' +
  'the API surface with a dummy bearer token, so the endpoints, paths and auth handling are tested but ' +
  'the token-acquisition flow itself is not.';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_GAP_MS = 300;
const RETRY_DELAY_MS = 2000;
const EXCERPT_CHARS = 200;

// Worst first: used to pick a spec's overall class when it is not fully proven.
const SEVERITY = ['FAIL', 'AMBIGUOUS', 'INCONCLUSIVE', 'AUTH_WALL', 'SHAPE_PROVEN'];

export const METHOD_NOTES =
  'Every network spec is probed against a control request at a deliberately bogus path on the same ' +
  'host with the same dummy credential. AUTH_WALL means host, TLS and auth rejection are proven but ' +
  'the path is not: the API answers the control path with the same status and the same error identity, ' +
  'so only a real credential can confirm the route, however structured the body looks. If the control ' +
  'probe itself could not be run, every result that depends on the differential is INCONCLUSIVE, never ' +
  'FAIL. A structured 400/405/422 whose status or error code differs from the ' +
  'control proves the endpoint is live and routed (structured_4xx). A 404 whose error identity ' +
  'differs from the control 404 proves the route pattern matched and identifier validation ran ' +
  '(identifier_404_differential); a 404 indistinguishable from the control is a wrong path, FAIL. ' +
  'When the credential rides in the base_url path (telegram-style), an invalid one makes every subpath ' +
  'unroutable, so an identical structured 4xx envelope everywhere is AUTH_WALL (path_credential_wall): ' +
  'host, TLS and the API\'s own structured envelope are proven, and the paths rest on documentary ' +
  'provenance rather than on this run.';

/* ------------------------------------------------------------------ *
 * dummy credentials + inputs
 * ------------------------------------------------------------------ */

/**
 * Dummy credential value for one required field: header-safe, obviously fake,
 * and traceable back to this runner if it ever shows up in someone's logs.
 */
export function dummyCredential(field) {
  return DUMMY_PREFIX + String(field || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function buildDummyCredentials(spec) {
  const creds = {};
  for (const field of spec?.requiredFields || []) creds[field] = dummyCredential(field);
  return creds;
}

/** Benign placeholder values derived from a tool's declared input schema. */
export function dummyInputs(inputSchema) {
  const out = {};
  const props = inputSchema?.properties || {};
  for (const [name, def] of Object.entries(props)) {
    switch (def?.type) {
      case 'number':
      case 'integer': out[name] = 1; break;
      case 'boolean': out[name] = false; break;
      case 'array': out[name] = []; break;
      case 'object': out[name] = {}; break;
      default: out[name] = 'quoxprobe';
    }
  }
  return out;
}

/**
 * Apply a request's optional `_probe` hints over the generic dummy inputs.
 * Shape: { "input.<name>": "<safe public value>" }. Tenant-slug APIs (Sentry)
 * 404 a made-up org slug at the gateway before routing, so a known-public slug
 * is the only way to reach the route at all. CREDENTIALS ARE NEVER HINTED:
 * anything that is not an `input.` key is ignored, by design.
 */
export function applyProbeHints(inputs, probe) {
  const out = { ...inputs };
  for (const [key, value] of Object.entries(probe || {})) {
    const match = /^input\.(.+)$/.exec(key);
    if (!match) continue;
    out[match[1]] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * templating
 * ------------------------------------------------------------------ */

function lookup(ctx, expr) {
  const parts = String(expr).split('.');
  let cur = ctx;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function resolveToken(token, ctx) {
  const trimmed = token.trim();
  // {{suffix <credentialField> <sep>}} — the part of a credential after its LAST
  // separator (Mailchimp's datacenter: xxxx-us21 → us21). A dummy credential has
  // no separator, so this renders EMPTY rather than the whole value: a
  // suffix-hosted spec needs a base_url._probe datacenter to be probeable, and
  // leaking a whole credential into a host is never the fallback.
  const suffix = trimmed.match(/^suffix\s+(\S+)\s+(\S)$/);
  if (suffix) {
    const [, ref, sep] = suffix;
    if (ref.startsWith('input.')) return '';
    const value = lookup(ctx, ref);
    if (value === undefined || value === null) return '';
    const index = String(value).lastIndexOf(sep);
    return index < 0 ? '' : String(value).slice(index + 1);
  }
  // Single helper supported in v1: {{clamp input.max_results 20 50}}
  const clamp = trimmed.match(/^clamp\s+(\S+)\s+(-?\d+)\s+(-?\d+)$/);
  if (clamp) {
    const [, ref, minRaw, maxRaw] = clamp;
    const min = Number(minRaw);
    const max = Number(maxRaw);
    const raw = Number(lookup(ctx, ref));
    if (!Number.isFinite(raw)) return min;
    return Math.min(Math.max(raw, min), max);
  }
  return lookup(ctx, trimmed);
}

/**
 * Substitute {{...}} placeholders in a string template.
 * `encode` URL-encodes each substituted value (path segments, never headers).
 * Unresolved placeholders collapse to '' so callers can drop empty params.
 */
export function substitute(template, ctx, { encode = false } = {}) {
  return String(template).replace(/\{\{([^}]+)\}\}/g, (_m, token) => {
    const value = resolveToken(token, ctx);
    if (value === undefined || value === null) return '';
    const asString = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return encode ? encodeURIComponent(asString) : asString;
  });
}

/**
 * Substitute inside an arbitrary JSON value (used for request bodies).
 * A string that is exactly one placeholder keeps the resolved value's type.
 */
export function substituteValue(value, ctx) {
  if (typeof value === 'string') {
    const solo = value.match(/^\{\{([^}]+)\}\}$/);
    if (solo) {
      const resolved = resolveToken(solo[1], ctx);
      return resolved === undefined ? null : resolved;
    }
    return substitute(value, ctx);
  }
  if (Array.isArray(value)) return value.map((v) => substituteValue(v, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteValue(v, ctx);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * auth
 * ------------------------------------------------------------------ */

/**
 * Apply a spec's auth block as the declarative runtime would, with one
 * deliberate difference: token-flow auth types (oauth2_refresh,
 * oauth2_client_credentials, google_service_account) get a DUMMY bearer instead
 * of an exchanged one. The
 * API surface behind the exchange rejects it exactly as it rejects an expired
 * token, so every classification rule still applies; the exchange itself does
 * not get proven, and the results say so.
 * `none` injects nothing: the credential rides in the base_url template.
 * Returns { headers, url }.
 */
export function applyAuth(auth, creds, { headers = {}, url } = {}) {
  const outHeaders = { ...headers };
  const target = url instanceof URL ? new URL(url.toString()) : new URL(String(url));
  if (!auth || !auth.type) return { headers: outHeaders, url: target };

  switch (auth.type) {
    case 'bearer':
      outHeaders.Authorization = `Bearer ${creds[auth.field] ?? ''}`;
      break;
    case 'basic': {
      // userLiteral is a documented constant (mailchimp: `anystring:<key>`);
      // userSuffix appends a literal to the credential (zendesk: `{email}/token`).
      const user = typeof auth.userLiteral === 'string' && auth.userLiteral
        ? auth.userLiteral
        : `${creds[auth.userField] ?? ''}${typeof auth.userSuffix === 'string' ? auth.userSuffix : ''}`;
      const pass = auth.passField ? (creds[auth.passField] ?? '') : '';
      outHeaders.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      break;
    }
    case 'header': {
      const headerName = auth.header || 'Authorization';
      outHeaders[headerName] = auth.template
        ? substitute(auth.template, creds)
        : String(creds[auth.field] ?? '');
      break;
    }
    case 'query':
      target.searchParams.set(auth.param, String(creds[auth.field] ?? ''));
      break;
    case 'oauth2_refresh':
    case 'oauth2_client_credentials':
    case 'google_service_account':
      outHeaders.Authorization = `Bearer ${DUMMY_BEARER}`;
      break;
    case 'none':
      break;
    default:
      break;
  }
  return { headers: outHeaders, url: target };
}

/* ------------------------------------------------------------------ *
 * request building
 * ------------------------------------------------------------------ */

/**
 * Does the credential ride in the PATH (a base_url template referencing a
 * required field, telegram-style)? If it does, an invalid credential makes
 * every subpath unroutable, so the auth wall can present as any status at all.
 */
export function baseUrlCarriesCredential(spec) {
  const template = baseUrlTemplate(spec);
  if (!template || !template.includes('{{')) return false;
  const fields = new Set(spec?.requiredFields || []);
  return placeholdersOf(template).some((token) => fields.has(token));
}

/**
 * The credential FIELD each placeholder in a template needs. A
 * {{suffix <field> <sep>}} helper resolves to its referenced field, so a
 * suffix-hosted base_url still counts as fillable (and as credential-derived
 * routing, which keeps its classification conservative).
 */
function placeholdersOf(template) {
  return [...String(template).matchAll(/\{\{([^}]+)\}\}/g)]
    .map((m) => {
      const token = m[1].trim().replace(/^cred\./, '');
      const suffix = token.match(/^suffix\s+(\S+)\s+\S$/);
      return suffix ? suffix[1].replace(/^cred\./, '') : token;
    });
}

/**
 * The base_url template, in either accepted form. `{ template: "..." }` is the
 * CANONICAL v1.1 object form the declarative runtime renders; a plain string
 * containing `{{...}}` is NOT rendered by the runtime, so it is read here only
 * so a hand-built diagnostic spec still probes. Never author the string form.
 * `{ fromCredential: ... }` has no template and stays unprobeable.
 */
function baseUrlTemplate(spec) {
  const base = spec?.base_url;
  if (typeof base === 'string') return base;
  if (base && typeof base === 'object' && typeof base.template === 'string') return base.template;
  return null;
}

/** Optional public credential values for rendering the base_url only. */
function baseUrlProbeValues(spec) {
  const probe = spec?.base_url && typeof spec.base_url === 'object' ? spec.base_url._probe : null;
  const out = {};
  for (const [key, value] of Object.entries(probe || {})) {
    out[String(key).replace(/^cred\./, '')] = value;
  }
  return out;
}

/**
 * Resolve a spec's base_url. A string base may itself be a credential template
 * (telegram: `https://api.telegram.org/bot{{bot_token}}`), which the dummy
 * credentials fill in. `{ fromCredential: ... }` has no host to probe blind.
 */
export function resolveBaseUrl(spec, creds = {}) {
  const base = spec?.base_url;
  const template = baseUrlTemplate(spec);
  if (template === null) return null; // fromCredential-only: nothing to probe blind

  if (typeof base !== 'string') {
    // Object form: only probeable when every placeholder is a credential field
    // we can fill with a dummy (or a public _probe value).
    const values = { ...creds, ...baseUrlProbeValues(spec) };
    const fillable = placeholdersOf(template).every((token) => values[token] !== undefined);
    if (!fillable) return null;
    return substitute(template, { ...values, cred: values }).replace(/\/+$/, '');
  }

  const filled = template.includes('{{') ? substitute(template, { ...creds, cred: creds }) : template;
  return filled.replace(/\/+$/, '');
}

/**
 * Build a fully-resolved probe request for a spec's `test` block or a tool.
 * Dummy substitutions stay visible in the returned URL: the proof file has to
 * show exactly what was fired.
 */
export function buildRequest({ spec, request, inputs = {}, creds = {} }) {
  const base = resolveBaseUrl(spec, creds);
  if (!base) throw new Error('base_url is credential-derived; cannot build a blind probe');

  const ctx = { ...creds, cred: creds, input: inputs };
  const method = String(request?.method || 'GET').toUpperCase();
  const rawPath = substitute(request?.path || '/', ctx, { encode: true });
  const url = new URL(base + (rawPath.startsWith('/') ? rawPath : '/' + rawPath));

  for (const [key, tpl] of Object.entries(request?.query || {})) {
    const value = substitute(tpl, ctx);
    if (value !== '') url.searchParams.set(key, value);
  }

  let headers = { ...(spec?.static_headers || {}) };
  let body = null;
  if (request?.body !== undefined && request?.body !== null && method !== 'GET' && method !== 'HEAD') {
    body = JSON.stringify(substituteValue(request.body, ctx));
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const authed = applyAuth(spec?.auth, creds, { headers, url });
  headers = authed.headers;

  return { method, url: authed.url.toString(), headers, body };
}

/* ------------------------------------------------------------------ *
 * classification
 * ------------------------------------------------------------------ */

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function isJsonBody(body) {
  const text = String(body ?? '').trim();
  if (!text) return false;
  if (!(text.startsWith('{') || text.startsWith('['))) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

function looksHtml(body) {
  const text = String(body ?? '').trim().slice(0, 400).toLowerCase();
  return text.startsWith('<!doctype html') || text.startsWith('<html') || text.includes('<html');
}

/**
 * A compact error shape: short, single-line-ish, not HTML. Plenty of APIs
 * answer an unauthenticated call with `Unauthorized` or `invalid token`, which
 * is still a structured, deliberate answer from the API surface.
 */
function isCompactError(body) {
  const text = String(body ?? '').trim();
  if (!text || text.length > 200) return false;
  if (looksHtml(text)) return false;
  return true;
}

function parseJsonBody(body) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  if (!(text.startsWith('{') || text.startsWith('['))) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// Error-shape keys seen in the wild. ClickUp answers `{"err":...,"ECODE":...}`
// and Resend `{"statusCode":...,"name":...}`; a list that only knew
// error/errors/message/code read both as unstructured and skipped the
// differential rules entirely.
const ERROR_KEYS = [
  'error', 'errors', 'message', 'code', 'error_code', 'errorCode', 'detail', 'type',
  'err', 'ECODE', 'ecode', 'msg', 'reason', 'title', 'error_description', 'statusCode'
];

/** Does a parsed body carry an API-level error shape (not just any JSON)? */
function hasErrorShape(json) {
  if (!json) return false;
  const root = Array.isArray(json) ? json[0] : json;
  if (!root || typeof root !== 'object') return false;
  return ERROR_KEYS.some((k) => Object.prototype.hasOwnProperty.call(root, k));
}

/**
 * The endpoint-level error identity of a body: Cloudflare's `errors[0].code`
 * (6003 bad auth vs 7003 bad identifier vs 10404 bogus route) is the signal
 * that separates "this endpoint rejected my input" from "this route does not
 * exist". Returns a comparable string, or null when nothing is extractable.
 */
export function structuredErrorCode(body) {
  const json = parseJsonBody(body);
  if (!json) return null;
  const root = Array.isArray(json) ? json[0] : json;
  if (!root || typeof root !== 'object') return null;
  // Gong answers {"errors":["..."],"requestId":"<random>"}: an errors array of
  // plain STRINGS. Missing this made the identity unextractable, which sent the
  // comparison to a body hash that the random requestId always made differ, so
  // an auth wall could earn a phantom differential.
  const errorsList = Array.isArray(root.errors) ? root.errors : (Array.isArray(root.error) ? root.error : null);
  const firstErrorString = errorsList?.find((e) => typeof e === 'string' && e !== '');

  const candidates = [
    firstErrorString,
    root.code,
    root.error_code,
    root.errorCode,
    root.ECODE,
    root.ecode,
    root.type,
    Array.isArray(root.errors) ? root.errors[0]?.code : undefined,
    Array.isArray(root.errors) ? root.errors[0]?.message : undefined,
    root.error && typeof root.error === 'object' ? (root.error.code ?? root.error.type ?? root.error.message) : undefined,
    typeof root.error === 'string' ? root.error : undefined,
    root.message,
    root.detail,
    root.err,
    root.msg,
    root.reason,
    root.title,
    root.error_description
  ];
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return String(c);
  }
  return null;
}

// Resend answers every path, control included, with an identical structured
// 400 saying the API key is invalid. That is an auth wall wearing a 400.
const AUTH_FAILURE_PATTERN = /api.?key|token|auth|unauthori[sz]ed|credential/i;

function looksAuthFailure(body) {
  const json = parseJsonBody(body);
  if (!json) return false;
  const root = Array.isArray(json) ? json[0] : json;
  if (!root || typeof root !== 'object') return false;
  return ['message', 'name', 'error', 'detail', 'err', 'msg', 'reason', 'title', 'error_description', 'type']
    .map((k) => root[k])
    .some((v) => typeof v === 'string' && AUTH_FAILURE_PATTERN.test(v));
}

/** The sorted top-level key set of a parsed body, as a comparable string. */
function keyShape(json) {
  if (Array.isArray(json)) {
    const first = json[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return 'array{' + Object.keys(first).sort().join(',') + '}';
    }
    return 'array[' + typeof first + ']';
  }
  return '{' + Object.keys(json || {}).sort().join(',') + '}';
}

/**
 * Is the control's answer INDISTINGUISHABLE from this one? Same status and the
 * same error identity (error code when both bodies expose one, else body hash).
 * An identical control dominates every body-quality rule: a pretty JSON 401 at
 * a path that does not exist is still just the auth wall talking.
 * Returns the comparison basis, or null when the two differ or no control ran.
 */
function controlIdentical({ status, body, controlStatus, controlBody }) {
  if (controlStatus === null || controlStatus === undefined) return null;
  if (Number(controlStatus) !== Number(status)) return null;
  const mine = structuredErrorCode(body);
  const theirs = structuredErrorCode(controlBody);
  if (mine !== null && theirs !== null) return mine === theirs ? 'error_code' : null;
  // No extractable identity: compare the KEY SHAPE before the raw hash, so a
  // stamped volatile field (requestId, timestamp, trace id) cannot fabricate a
  // differential out of two structurally identical envelopes.
  const mineJson = parseJsonBody(body);
  const theirsJson = parseJsonBody(controlBody);
  if (mineJson && theirsJson) {
    return keyShape(mineJson) === keyShape(theirsJson) ? 'key_shape' : null;
  }
  return sha256(body ?? '') === sha256(controlBody ?? '') ? 'body_sha' : null;
}

/**
 * Is the control probe's status usable as a differential signal? A transient
 * status (429/5xx) or a 2xx on a deliberately bogus path tells us nothing.
 */
function usableControl(controlStatus) {
  const code = Number(controlStatus);
  if (!Number.isFinite(code)) return false;
  if (code === 429) return false;
  return code >= 400 && code <= 499;
}

/**
 * Classify one probe response. Status FIRST, always: an error body is not data.
 * `controlStatus` is the status the same host+auth returned for a deliberately
 * bogus control path; it is what separates "the path is right" from "the auth
 * wall answers everything the same way".
 * Returns { classification, flags }.
 */
export function classify({
  status, headers, body, error, requestUrl,
  controlStatus = null, controlBody = null, controlUnavailable = false,
  pathCredential = false
} = {}) {
  const flags = {};

  if (error) {
    flags.network_error = String(error.code || error.name || 'error');
    flags.detail = String(error.message || error).slice(0, 200);
    return { classification: 'FAIL', flags };
  }

  const code = Number(status);

  // Credential-in-the-path wall (telegram): when the credential rides in the
  // base_url, a bad one makes every subpath unroutable, so the wall can wear
  // ANY status and any wording. Telegram answers the byte-identical
  // {"ok":false,"error_code":404,"description":"Not Found"} at /getMe, at
  // /sendMessage and at the control path alike. That is host, TLS and the
  // API's own structured envelope proven; the paths rest on documentary
  // provenance. This rule is deliberately NOT available to header or query
  // auth, where an identical 404 still means a wrong path.
  if (pathCredential && !controlUnavailable && code >= 400 && code <= 499) {
    const identical = controlIdentical({ status: code, body, controlStatus, controlBody });
    if (identical && hasErrorShape(parseJsonBody(body))) {
      flags.path_credential_wall = true;
      flags.path_unproven = true;
      flags.control_status = Number(controlStatus);
      flags.control_match = identical;
      return { classification: 'AUTH_WALL', flags };
    }
  }

  if (code === 401 || code === 403) {
    // A control probe we could not run cannot be read either way: the honest
    // answer is INCONCLUSIVE, never a claim of proof and never a FAIL.
    if (controlUnavailable) {
      flags.control_unavailable = true;
      return { classification: 'INCONCLUSIVE', flags };
    }
    // An identical control DOMINATES every body-quality rule below: same status,
    // same error identity at a path that cannot exist means the auth wall
    // answers everything the same way (Calendly, Pipedrive), so the path is
    // unproven no matter how pretty the body is.
    const identical = controlIdentical({ status: code, body, controlStatus, controlBody });
    if (identical) {
      flags.auth_wall = true;
      flags.path_unproven = true;
      flags.control_status = Number(controlStatus);
      flags.control_match = identical;
      return { classification: 'AUTH_WALL', flags };
    }
    if (getHeader(headers, 'www-authenticate')) {
      flags.www_authenticate = true;
      return { classification: 'SHAPE_PROVEN', flags };
    }
    if (isJsonBody(body)) {
      flags.structured_body = 'json';
      return { classification: 'SHAPE_PROVEN', flags };
    }
    if (looksHtml(body)) {
      flags.html_error_body = true;
      return { classification: 'AMBIGUOUS', flags };
    }
    if (isCompactError(body)) {
      flags.structured_body = 'compact';
      return { classification: 'SHAPE_PROVEN', flags };
    }
    // Empty or unstructured 401/403: lean on the control probe. A DIFFERENT
    // status for a bogus path (Stripe: 404 bogus / 401 real) proves the path;
    // an IDENTICAL 401/403 (PagerDuty) proves only the auth wall.
    flags.unstructured_body = true;
    if (usableControl(controlStatus) && Number(controlStatus) !== code) {
      flags.differential_path_proof = true;
      flags.control_status = Number(controlStatus);
      return { classification: 'SHAPE_PROVEN', flags };
    }
    if (Number(controlStatus) === code) {
      flags.auth_wall = true;
      flags.path_unproven = true;
      flags.control_status = Number(controlStatus);
      return { classification: 'AUTH_WALL', flags };
    }
    return { classification: 'AMBIGUOUS', flags };
  }

  if (code === 429 || (code >= 500 && code <= 599)) {
    flags.transient = true;
    return { classification: 'INCONCLUSIVE', flags };
  }

  // An auth wall does not have to wear a 401. Resend rejects a dummy key with a
  // structured 400 at every path, control included; identical answer plus an
  // auth-failure message means the path is unproven, not merely unclear.
  if (code >= 400 && code <= 499 && !controlUnavailable) {
    const identical = controlIdentical({ status: code, body, controlStatus, controlBody });
    if (identical && hasErrorShape(parseJsonBody(body)) && looksAuthFailure(body)) {
      flags.auth_wall = true;
      flags.path_unproven = true;
      flags.auth_wall_in_4xx = code;
      flags.control_status = Number(controlStatus);
      flags.control_match = identical;
      return { classification: 'AUTH_WALL', flags };
    }
  }

  // Identifier-404 differential: a 404 whose error identity DIFFERS from the
  // control's own 404 means the route pattern matched and identifier validation
  // ran (Cloudflare: 7003 bad identifier vs 10404 bogus route). A 404 that is
  // indistinguishable from the control's is still a wrong path.
  if (code === 404) {
    // Without a control we cannot tell a wrong path from an identifier
    // rejection, and a flaky control must never manufacture a FAIL.
    if (controlUnavailable) {
      flags.control_unavailable = true;
      return { classification: 'INCONCLUSIVE', flags };
    }
    if (Number(controlStatus) === 404) {
      // Same comparison ladder as everywhere else (error identity, then key
      // shape for JSON, then hash) so a volatile stamped field cannot invent a
      // differential here either.
      const identical = controlIdentical({ status: code, body, controlStatus, controlBody });
      if (!identical && String(body ?? '') !== '') {
        const mine = structuredErrorCode(body);
        const theirs = structuredErrorCode(controlBody);
        flags.identifier_404_differential = true;
        if (mine !== null && theirs !== null) {
          flags.error_code = mine;
          flags.control_error_code = theirs;
        } else {
          flags.differential_basis = parseJsonBody(body) && parseJsonBody(controlBody) ? 'key_shape' : 'body_sha';
        }
        return { classification: 'SHAPE_PROVEN', flags };
      }
    }
    flags.path_wrong = true;
    return { classification: 'FAIL', flags };
  }

  // Structured 4xx differential: a JSON error body at 400/405/422 proves the
  // endpoint is live and rejected the dummy input at endpoint level; a control
  // that answers differently (status or error code) proves the routing too.
  // 401/403 never reach here: their rules above already settle them.
  if ((code === 400 || code === 405 || code === 422) && hasErrorShape(parseJsonBody(body))) {
    flags.structured_4xx = code;
    if (controlUnavailable) {
      flags.control_unavailable = true;
      return { classification: 'INCONCLUSIVE', flags };
    }
    const mine = structuredErrorCode(body);
    const theirs = structuredErrorCode(controlBody);
    if (usableControl(controlStatus)) {
      const statusDiffers = Number(controlStatus) !== code;
      const codeDiffers = mine !== null && theirs !== null && mine !== theirs;
      if (statusDiffers || codeDiffers) {
        flags.differential_path_proof = true;
        flags.control_status = Number(controlStatus);
        if (codeDiffers) flags.control_error_code = theirs;
        return { classification: 'SHAPE_PROVEN', flags };
      }
    }
    flags.endpoint_exists = true;
    return { classification: 'AMBIGUOUS', flags };
  }

  if (code >= 300 && code <= 399) {
    const location = getHeader(headers, 'location');
    flags.redirect_to = location ? String(location).slice(0, 200) : null;
    let offHost = true;
    try {
      const from = new URL(String(requestUrl));
      const to = new URL(String(location), from);
      offHost = to.host !== from.host;
    } catch { offHost = true; }
    if (offHost) {
      flags.off_host_redirect = true;
      return { classification: 'FAIL', flags };
    }
    return { classification: 'AMBIGUOUS', flags };
  }

  // A 2xx with a parseable JSON body is the STRONGEST blind proof there is: the
  // endpoint answered end to end. `no_auth_required` stays alongside so STATUS
  // can still say the auth path on these endpoints is unverified.
  if (code >= 200 && code <= 299) {
    flags.no_auth_required = true;
    if (parseJsonBody(body) !== null) {
      flags.public_endpoint = true;
      return { classification: 'SHAPE_PROVEN', flags };
    }
    flags.unparseable_body = true;
    return { classification: 'AMBIGUOUS', flags };
  }

  // An HTML page from anything that is not a 2xx or a 401/403 means we very
  // likely hit a marketing page or an error page, not the API surface.
  if (looksHtml(body)) {
    flags.html_error_page = true;
    return { classification: 'FAIL', flags };
  }

  // 400 / 405 / 422 and friends: the endpoint exists, the shape is unclear.
  flags.endpoint_exists = true;
  return { classification: 'AMBIGUOUS', flags };
}

/* ------------------------------------------------------------------ *
 * redaction + hashing
 * ------------------------------------------------------------------ */

/** Strip anything token-shaped out of a body before it lands in a proof file. */
export function redact(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED_JWT]')
    .replace(/(set-cookie\s*:\s*)[^\n;]+/gi, '$1[REDACTED]')
    .replace(
      /("(?:access_token|refresh_token|id_token|token|api_key|apiKey|secret|password|session)"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED]$2'
    )
    // RFC1918 addresses in a response body are LAN topology (RouterOS
    // ip/address + ip/route leaked 192.168.x into a committed proof, 66a94297).
    .replace(
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
      '[RFC1918_REDACTED]'
    );
}

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

export function excerpt(body) {
  return redact(body).slice(0, EXCERPT_CHARS);
}

/* ------------------------------------------------------------------ *
 * probing
 * ------------------------------------------------------------------ */

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fireOnce(req, { fetchImpl, timeoutMs }) {
  const started = Date.now();
  try {
    const res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    });
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    return { status: res.status, headers: res.headers, body: text, latency_ms: Date.now() - started };
  } catch (error) {
    return { error, latency_ms: Date.now() - started };
  }
}

/**
 * Fire one probe, retrying exactly once and only for a TRANSIENT INCONCLUSIVE
 * (429/5xx). An INCONCLUSIVE caused by a dead control probe is not retried:
 * re-firing cannot bring the control back.
 */
async function probe(name, req, opts, control = {}, specTraits = {}) {
  const {
    status: controlStatus = null, body: controlBody = null, unavailable: controlUnavailable = false
  } = control || {};
  const { pathCredential = false } = specTraits || {};
  const verdictOf = (attempt) =>
    classify({
      ...attempt, requestUrl: req.url, controlStatus, controlBody, controlUnavailable, pathCredential
    });

  let attempt = await fireOnce(req, opts);
  let verdict = verdictOf(attempt);
  let retried = false;

  if (verdict.classification === 'INCONCLUSIVE' && verdict.flags.transient) {
    await opts.sleep(opts.retryDelayMs);
    retried = true;
    attempt = await fireOnce(req, opts);
    verdict = verdictOf(attempt);
  }

  const flags = { ...verdict.flags };
  if (retried) flags.retried = true;

  return {
    name,
    method: req.method,
    url: req.url,
    status: attempt.status ?? null,
    latency_ms: attempt.latency_ms ?? null,
    classification: verdict.classification,
    body_sha256: attempt.error ? null : sha256(attempt.body),
    body_excerpt: attempt.error ? null : excerpt(attempt.body),
    flags
  };
}

/**
 * Deterministic bogus path for the control probe: same spec, same path, every
 * run, so two proof files are comparable. Never random.
 */
export function controlPath(specId) {
  return '/quox-shapeproof-control-' + sha256(String(specId ?? '')).slice(0, 8);
}

/**
 * The control probe: same base_url, same auth, a path that cannot exist. Its
 * status is the differential that separates SHAPE_PROVEN from AUTH_WALL. It is
 * diagnostic, so it never counts towards the spec's overall class.
 */
async function controlProbe(spec, creds, opts) {
  const req = buildRequest({
    spec,
    request: { method: 'GET', path: controlPath(spec?.id) },
    inputs: {},
    creds
  });
  // A network flake on the control must not sink a whole spec, so it gets one
  // retry of its own before we call it unavailable.
  let attempt = await fireOnce(req, opts);
  let retried = false;
  if (attempt.error) {
    await opts.sleep(opts.retryDelayMs);
    retried = true;
    attempt = await fireOnce(req, opts);
  }

  const flags = { control_probe: true, bogus_path: true };
  if (retried) flags.retried = true;
  if (attempt.error) {
    flags.network_error = String(attempt.error.code || attempt.error.name || 'error');
    flags.control_unavailable = true;
  }

  const result = {
    name: '_control',
    method: req.method,
    url: req.url,
    status: attempt.status ?? null,
    latency_ms: attempt.latency_ms ?? null,
    classification: 'CONTROL',
    body_sha256: attempt.error ? null : sha256(attempt.body),
    body_excerpt: attempt.error ? null : excerpt(attempt.body),
    flags
  };
  // The RAW control body stays out of the proof file (the excerpt is redacted
  // and truncated) but is needed in memory for the error-identity comparison.
  return { result, rawBody: attempt.error ? null : attempt.body, unavailable: !!attempt.error };
}

function skipped(name, request, reason) {
  return {
    name,
    method: String(request?.method || 'GET').toUpperCase(),
    url: null,
    status: null,
    latency_ms: null,
    classification: 'SKIPPED_WRITE',
    body_sha256: null,
    body_excerpt: null,
    flags: { reason }
  };
}

export function aggregateOverall(results) {
  const fired = results.filter(
    (r) => r.classification !== 'SKIPPED_WRITE' && r.classification !== 'CONTROL'
  );
  if (fired.length === 0) return 'INCONCLUSIVE';
  if (fired.every((r) => r.classification === 'SHAPE_PROVEN')) return 'SHAPE_PROVEN';
  for (const level of SEVERITY) {
    if (fired.some((r) => r.classification === level)) return level;
  }
  return 'INCONCLUSIVE';
}

function proofEnvelope(spec, results, overall, notes, methodNotes = METHOD_NOTES) {
  return {
    spec_id: spec?.id ?? null,
    spec_version: spec?.spec_version ?? null,
    checked_at: new Date().toISOString(),
    runner: RUNNER,
    results,
    overall,
    method_notes: methodNotes,
    notes
  };
}

/**
 * Shape-prove one spec. No network is touched for a credential-derived base URL
 * (nothing to reach) or for a token-flow spec with no endpoints at all; both are
 * honest "cannot prove blind" outcomes rather than a pass or a fail.
 */
export async function proveSpec(spec, options = {}) {
  const opts = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    includeWrites: options.includeWrites === true,
    gapMs: options.gapMs ?? DEFAULT_GAP_MS,
    retryDelayMs: options.retryDelayMs ?? RETRY_DELAY_MS,
    sleep: options.sleep || defaultSleep
  };

  const notes = [];
  const creds = buildDummyCredentials(spec);
  const tools = Array.isArray(spec?.tools) ? spec.tools : [];
  const tokenFlow = TOKEN_FLOW_AUTH_TYPES.has(spec?.auth?.type);
  const specTraits = { pathCredential: baseUrlCarriesCredential(spec) };
  const methodNotes = tokenFlow ? `${METHOD_NOTES} ${TOKEN_FLOW_NOTE}` : METHOD_NOTES;

  if (!resolveBaseUrl(spec, creds)) {
    notes.push('base_url is credential-derived (per-customer instance); no host to probe blind.');
    return proofEnvelope(spec, [], 'NEEDS_INSTANCE', notes, methodNotes);
  }

  // A token-flow spec is still worth probing: the API surface answers a dummy
  // bearer the same way it answers an expired one. Only a spec with nothing to
  // fire at stays OAUTH_UNPROVABLE.
  if (tokenFlow && !spec?.test && tools.length === 0) {
    notes.push(`${spec.auth.type} auth and no probeable endpoint: the token exchange alone proves nothing about an API surface.`);
    return proofEnvelope(spec, [], 'OAUTH_UNPROVABLE', notes, methodNotes);
  }
  if (tokenFlow) {
    notes.push(`${spec.auth.type} auth: probed with a dummy bearer token; the token-acquisition flow is NOT proven by this run.`);
  }
  const results = [];

  // 1. Control probe: a path that cannot exist, same host and auth. Fired first
  //    so every later call can be read against it.
  const { result: controlResult, rawBody: controlRawBody, unavailable } = await controlProbe(spec, creds, opts);
  results.push(controlResult);
  const control = { status: controlResult.status, body: controlRawBody, unavailable };
  if (unavailable) {
    notes.push(
      `control probe failed twice at network level (${controlResult.flags.network_error}); ` +
      'results that depend on the differential are INCONCLUSIVE, not FAIL.'
    );
  }
  if (opts.gapMs > 0) await opts.sleep(opts.gapMs);

  // 2. The auth-proving call: the spec's own `test` block, else the first read tool.
  let testRequest = spec?.test || null;
  let testSourceTool = null;
  let testInputs = {};
  if (!testRequest) {
    const firstRead = tools.find((t) => t?.write !== true);
    if (firstRead) {
      testRequest = firstRead.request;
      testSourceTool = firstRead.name;
      testInputs = applyProbeHints(dummyInputs(firstRead.input_schema), firstRead._probe);
      notes.push(`no test block; used read tool '${firstRead.name}' as the auth-proving call.`);
    }
  }

  let testStatus = null;
  if (testRequest) {
    // A test block may carry its own _probe hints (tenant slug and friends).
    const inputs = testSourceTool ? testInputs : applyProbeHints(testInputs, spec?.test?._probe);
    const req = buildRequest({ spec, request: testRequest, inputs, creds });
    const result = await probe('test', req, opts, control, specTraits);
    if (testSourceTool) result.flags.source_tool = testSourceTool;
    results.push(result);
    testStatus = result.status;
  } else {
    notes.push('no test block and no read tool: nothing could prove auth for this spec.');
  }

  const authEnforced = testStatus === 401 || testStatus === 403;

  // 3. Every tool request, sequentially and politely.
  for (const tool of tools) {
    if (testSourceTool && tool.name === testSourceTool) continue;

    if (tool?.write === true) {
      if (!opts.includeWrites) {
        results.push(skipped(tool.name, tool.request, 'writes_not_included'));
        continue;
      }
      if (!authEnforced) {
        results.push(skipped(tool.name, tool.request, 'test_call_did_not_prove_auth_gate'));
        continue;
      }
    }

    if (opts.gapMs > 0) await opts.sleep(opts.gapMs);
    const toolInputs = applyProbeHints(dummyInputs(tool.input_schema), tool._probe);
    const req = buildRequest({ spec, request: tool.request, inputs: toolInputs, creds });
    const result = await probe(tool.name, req, opts, control, specTraits);
    if (tool.write === true) result.flags.write_fired_behind_auth_gate = true;
    results.push(result);
  }

  if (tokenFlow) {
    for (const result of results) result.flags.token_flow_untested = true;
  }

  return proofEnvelope(spec, results, aggregateOverall(results), notes, methodNotes);
}

/* ------------------------------------------------------------------ *
 * LIVE mode (CONNFAC live-proof pipeline)
 *
 * Real credentials against a real instance, normally an ephemeral container
 * the pipeline just provisioned. The bar is HIGHER than blind mode: every
 * fired call (the test block plus every read tool, inputs seeded from the
 * same _probe hints) must answer 2xx with a parseable JSON body to earn
 * LIVE_PROVEN; a single failure fails the whole spec. A 200 that is not
 * JSON is a FAIL on purpose: self-hosted services answer unknown routes
 * with 200 login HTML (hibob taught the blind matrix the same lesson).
 *
 * Every credential VALUE, including the instance host, is scrubbed from the
 * serialized proof: proofs are committed, and a LAN address in a committed
 * file is exactly what the privacy gate exists to prevent. The caller's
 * targetLabel (container image+tag) is recorded instead, which is the
 * honest description of what was proven against.
 * ------------------------------------------------------------------ */

function classifyLive(attempt) {
  if (attempt.error) {
    return { classification: 'INCONCLUSIVE', flags: { live: true, network_error: String(attempt.error.code || attempt.error.name || 'error') } };
  }
  if (attempt.status < 200 || attempt.status >= 300) {
    return { classification: 'FAIL', flags: { live: true, non_2xx: true } };
  }
  try {
    JSON.parse(attempt.body);
  } catch {
    return { classification: 'FAIL', flags: { live: true, body_not_json: true } };
  }
  return { classification: 'LIVE_PROVEN', flags: { live: true } };
}

async function probeLive(name, req, opts) {
  let attempt = await fireOnce(req, opts);
  let verdict = classifyLive(attempt);
  let retried = false;
  if (verdict.classification === 'INCONCLUSIVE') {
    await opts.sleep(opts.retryDelayMs);
    retried = true;
    attempt = await fireOnce(req, opts);
    verdict = classifyLive(attempt);
  }
  const flags = { ...verdict.flags };
  if (retried) flags.retried = true;
  return {
    name,
    method: req.method,
    url: req.url,
    status: attempt.status ?? null,
    latency_ms: attempt.latency_ms ?? null,
    classification: verdict.classification,
    body_sha256: attempt.error ? null : sha256(attempt.body),
    body_excerpt: attempt.error ? null : excerpt(attempt.body),
    flags
  };
}

/**
 * Replace every credential value (len >= 4) anywhere in the proof. A value
 * that is a substring of the spec's own id or name is an identifier, not a
 * secret (username "elastic" vs spec id "elasticsearch" turned the proof's
 * own spec_id into [LIVE_REDACTED]search on the first ES run) — skipped.
 */
export function scrubCredentialValues(proof, creds) {
  let raw = JSON.stringify(proof);
  const specText = `${proof?.spec_id ?? ''} ${proof?.name ?? ''}`.toLowerCase();
  const values = Object.values(creds || {})
    .filter((v) => typeof v === 'string' && v.length >= 4)
    .filter((v) => !specText.includes(v.toLowerCase()))
    .sort((a, b) => b.length - a.length); // longest first so substrings scrub cleanly
  for (const v of values) {
    raw = raw.split(v).join('[LIVE_REDACTED]');
    // A host credential also leaks as its bare authority (no scheme).
    try {
      const u = new URL(v);
      if (u.host) raw = raw.split(u.host).join('[LIVE_REDACTED]');
      if (u.hostname) raw = raw.split(u.hostname).join('[LIVE_REDACTED]');
    } catch { /* not a URL, nothing more to scrub */ }
  }
  return JSON.parse(raw);
}

export async function proveSpecLive(spec, liveCreds, options = {}) {
  const opts = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    gapMs: options.gapMs ?? DEFAULT_GAP_MS,
    retryDelayMs: options.retryDelayMs ?? RETRY_DELAY_MS,
    sleep: options.sleep || defaultSleep
  };
  const notes = [];
  const creds = { ...(liveCreds || {}) };
  const results = [];

  // Blind mode refuses fromCredential hosts (nothing to probe); live mode has
  // the credential in hand, so literalize it into a spec copy and everything
  // downstream (resolveBaseUrl, buildRequest) works unchanged. __live_base_url
  // wins outright: some templates bake a scheme (https://{{host}}:{{port}})
  // the ephemeral test target does not serve; the override is deployment
  // plumbing for the proof run, never part of the spec, and is scrubbed from
  // the proof like every other credential value.
  if (typeof creds.__live_base_url === 'string' && creds.__live_base_url) {
    spec = { ...spec, base_url: creds.__live_base_url.replace(/\/+$/, '') };
  } else if (spec?.base_url && typeof spec.base_url === 'object' && spec.base_url.fromCredential) {
    const host = creds[spec.base_url.fromCredential];
    if (typeof host === 'string' && host && !spec.base_url.template) {
      spec = { ...spec, base_url: host.replace(/\/+$/, '') };
    }
  }
  const tools = Array.isArray(spec?.tools) ? spec.tools : [];

  if (!resolveBaseUrl(spec, creds)) {
    notes.push('live mode: base_url did not resolve from the supplied credentials.');
    const envelope = { ...proofEnvelope(spec, [], 'FAIL', notes), mode: 'live', target: options.targetLabel ?? null };
    return scrubCredentialValues(envelope, creds);
  }

  if (spec?.test) {
    const inputs = applyProbeHints({}, spec.test._probe);
    const req = buildRequest({ spec, request: spec.test, inputs, creds });
    results.push(await probeLive('test', req, opts));
  }

  for (const tool of tools) {
    if (tool?.write === true) {
      results.push(skipped(tool.name, tool.request, 'writes_not_included'));
      continue;
    }
    if (opts.gapMs > 0) await opts.sleep(opts.gapMs);
    // Live seeding fires what a real agent would: REQUIRED inputs (dummy
    // value unless _probe pins better) plus _probe-pinned optionals. Junk in
    // optional params earns honest 400s from real APIs (meilisearch's
    // statuses=quoxprobe taught this on the first ever live run).
    const required = new Set(tool.input_schema?.required || []);
    const allDummies = dummyInputs(tool.input_schema);
    const requiredOnly = Object.fromEntries(Object.entries(allDummies).filter(([k]) => required.has(k)));
    const toolInputs = applyProbeHints(requiredOnly, tool._probe);
    const req = buildRequest({ spec, request: tool.request, inputs: toolInputs, creds });
    results.push(await probeLive(tool.name, req, opts));
  }

  const fired = results.filter((r) => r.classification !== 'SKIPPED_WRITE');
  let overall;
  if (fired.length === 0) overall = 'INCONCLUSIVE';
  else if (fired.every((r) => r.classification === 'LIVE_PROVEN')) overall = 'LIVE_PROVEN';
  else if (fired.some((r) => r.classification === 'INCONCLUSIVE') && !fired.some((r) => r.classification === 'FAIL')) overall = 'INCONCLUSIVE';
  else overall = 'FAIL';

  notes.push('live proof: real credentials against a live instance; every fired call must be 2xx JSON.');
  const envelope = {
    ...proofEnvelope(spec, results, overall, notes,
      'LIVE mode: each call fired with real credentials; LIVE_PROVEN requires HTTP 2xx and a parseable JSON body on every non-write call. Credential values (including the instance host) are scrubbed from this file; `target` names what was proven against.'),
    mode: 'live',
    target: options.targetLabel ?? null
  };
  return scrubCredentialValues(envelope, creds);
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const opts = {
    files: [],
    out: null,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    includeWrites: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--concurrency') opts.concurrency = Math.max(1, Number(argv[++i]) || DEFAULT_CONCURRENCY);
    else if (arg === '--timeout') opts.timeoutMs = Math.max(1, Number(argv[++i]) || DEFAULT_TIMEOUT_MS);
    else if (arg === '--include-writes') opts.includeWrites = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--creds') opts.credsPath = argv[++i];
    else if (arg === '--target') opts.targetLabel = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
    else opts.files.push(arg);
  }
  return opts;
}

function tally(results) {
  const counts = { proven: 0, authwall: 0, ambiguous: 0, failed: 0, inconclusive: 0, skipped: 0 };
  for (const r of results) {
    if (r.classification === 'SHAPE_PROVEN' || r.classification === 'LIVE_PROVEN') counts.proven++;
    else if (r.classification === 'AUTH_WALL') counts.authwall++;
    else if (r.classification === 'AMBIGUOUS') counts.ambiguous++;
    else if (r.classification === 'FAIL') counts.failed++;
    else if (r.classification === 'INCONCLUSIVE') counts.inconclusive++;
    else if (r.classification === 'SKIPPED_WRITE') counts.skipped++;
  }
  return counts;
}

async function runPool(items, concurrency, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.files.length === 0) {
    console.error('usage: connector-shapeproof.mjs <spec-file>... [--out <dir>] [--concurrency 4] [--timeout 10000] [--include-writes]');
    return 2;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = opts.out
    ? path.resolve(opts.out)
    : path.resolve(here, '..', 'lib', 'connectors', 'specs', 'proofs');
  await mkdir(outDir, { recursive: true });

  const proofs = await runPool(opts.files, opts.concurrency, async (file) => {
    let spec;
    try {
      spec = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      console.log(`${path.basename(file)}  SPEC_UNREADABLE  ${e.message}`);
      return { file, proof: null, unreadable: true };
    }
    let proof;
    if (opts.live) {
      if (!opts.credsPath) throw new Error('--live requires --creds <file.json>');
      const liveCreds = JSON.parse(await readFile(opts.credsPath, 'utf8'));
      proof = await proveSpecLive(spec, liveCreds, {
        timeoutMs: opts.timeoutMs,
        targetLabel: opts.targetLabel ?? null
      });
    } else {
      proof = await proveSpec(spec, {
        timeoutMs: opts.timeoutMs,
        includeWrites: opts.includeWrites
      });
    }
    const id = proof.spec_id || path.basename(file).replace(/\.connector\.json$/, '');
    await writeFile(path.join(outDir, `${id}.proof.json`), JSON.stringify(proof, null, 2) + '\n', 'utf8');
    const c = tally(proof.results);
    console.log(
      `${id}  ${proof.overall}  proven=${c.proven} authwall=${c.authwall} ambiguous=${c.ambiguous} failed=${c.failed} inconclusive=${c.inconclusive} skipped=${c.skipped}`
    );
    return { file, proof };
  });

  const unreadable = proofs.filter((p) => p.unreadable).length;
  const byOverall = {};
  for (const p of proofs) {
    if (!p.proof) continue;
    byOverall[p.proof.overall] = (byOverall[p.proof.overall] || 0) + 1;
  }
  const summary = Object.entries(byOverall).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
  console.log(`\nshapeproof: ${proofs.length - unreadable} spec(s) probed · ${summary}${unreadable ? ` · unreadable=${unreadable}` : ''}`);
  console.log(`proofs written to ${outDir}`);

  const failed = proofs.some((p) => p.unreadable || p.proof?.overall === 'FAIL');
  return failed ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { console.error('shapeproof failed:', e.message); process.exit(1); });
}

export { main };

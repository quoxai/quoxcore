/**
 * OAuth 1.0a request signing (RFC 5849), dependency-free (node:crypto only).
 *
 * Used by the twitter.js connector (X/Twitter API v1.1-style OAuth 1.0a User
 * Context auth is still required for v2 endpoints signed with user context).
 * Not a general-purpose OAuth1 client: no request-token/access-token dance,
 * signing only. Callers already hold a long-lived apiKey/apiSecret (consumer)
 * + accessToken/accessSecret (user) pair from the vault.
 *
 * RFC 5849 rules implemented exactly:
 *  - Percent-encoding is RFC 3986 "strict" (encodeURIComponent PLUS escaping
 *    the 4 characters JS leaves unescaped that RFC 3986 reserves: ! * ' ( )).
 *  - The parameter string is built from the UNION of: URL query params, the
 *    caller-supplied `params` (POST body form fields — NEVER JSON bodies,
 *    see below), and the oauth_* params, encoded, then sorted by encoded key
 *    then encoded value (RFC 5849 3.4.1.3.2).
 *  - Signature base string = METHOD & enc(baseUrl) & enc(paramString), all
 *    upper-case method, baseUrl WITHOUT query string.
 *  - Signing key = enc(consumerSecret) & enc(tokenSecret) (tokenSecret may be
 *    empty during the request-token step; not used by this module today).
 *
 * KNOWN LIMITATION (X-PLUGIN P2 adversarial review, finding 8) — REPEATED
 * PARAMETER NAMES ARE NOT RFC 5849 COMPLIANT: RFC 5849 §3.4.1.3 "Request
 * Parameters" requires that when a parameter name occurs more than once
 * (e.g. a query string or form body containing `a=1&a=2`), EVERY occurrence
 * is carried into the parameter string as its own entry — signing must
 * cover the full multiset, not a deduplicated set. This implementation
 * folds same-named params into a single JS object key (`queryParams[key] =
 * value` from `parsedUrl.searchParams.entries()`, then
 * `{ ...queryParams, ...params, ...oauthParams }`), so a duplicate key
 * silently keeps only the LAST occurrence and the earlier one(s) never
 * reach the signature at all. This is a documented gap, not a fixed bug:
 * every caller today (twitter.js's verify_credentials GET, xTools.js's
 * tweets POST/DELETE) sends no repeated parameter names, so it has no live
 * consequence. Do not extend this signer to a caller that needs true
 * multi-value parameter support without first reworking the pipeline to
 * carry an array of [key, value] pairs end-to-end instead of a single
 * object — the object-keyed shape is the root cause and a targeted patch
 * on top of it would just relocate the same loss.
 *
 * JSON body exclusion: OAuth 1.0a signing only ever covers
 * application/x-www-form-urlencoded bodies and query params (RFC 5849 §3.4.1.3
 * "Parameter Sources" — the request body only contributes when its Content-Type
 * is x-www-form-urlencoded). twitter.js's tools are reads today, so this does
 * not yet matter in practice, but any future caller must pass form-style
 * params via `params`, never sign a JSON body's fields here.
 */

const crypto = require('node:crypto');

/**
 * RFC 3986 strict percent-encoding. encodeURIComponent() already encodes
 * everything RFC 3986 requires except ! * ' ( ) — escape those explicitly.
 */
function percentEncode(str) {
  return encodeURIComponent(String(str)).replace(/[!*'()]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function defaultNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function defaultTimestamp() {
  return String(Math.floor(Date.now() / 1000));
}

/**
 * Build an RFC 5849 `Authorization: OAuth ...` header value.
 *
 * @param {{method: string, url: string, params?: Record<string,string>}} request
 *   method: HTTP method. url: full request URL (query string params are
 *   folded into the signature automatically). params: additional signable
 *   parameters not already in the URL query string (form-encoded body
 *   fields only — never JSON body fields).
 * @param {{apiKey: string, apiSecret: string, accessToken: string, accessSecret: string}} credentials
 * @param {{nonce?: string, timestamp?: string}} [overrides] injectable for deterministic tests
 * @returns {string} the full `OAuth ...` header value (without the "Authorization: " prefix)
 */
function buildOAuth1Header(request, credentials, overrides = {}) {
  const { method, url, params = {} } = request;
  const { apiKey, apiSecret, accessToken, accessSecret } = credentials;
  const nonce = overrides.nonce || defaultNonce();
  const timestamp = overrides.timestamp || defaultTimestamp();

  const oauthParams = {
    oauth_consumer_key: apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  const parsedUrl = new URL(url);
  const queryParams = {};
  for (const [key, value] of parsedUrl.searchParams.entries()) {
    queryParams[key] = value;
  }
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

  const signableParams = { ...queryParams, ...params, ...oauthParams };

  const encodedPairs = Object.keys(signableParams).map((key) => {
    return [percentEncode(key), percentEncode(signableParams[key])];
  });
  encodedPairs.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  const paramString = encodedPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(apiSecret)}&${percentEncode(accessSecret || '')}`;

  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const headerString = Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(', ');

  return `OAuth ${headerString}`;
}

module.exports = { buildOAuth1Header, percentEncode };

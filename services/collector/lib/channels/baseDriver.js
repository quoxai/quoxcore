/**
 * Base Driver — Shared utilities for channel drivers.
 *
 * Provides common HTTP methods for webhook-based and API-based channels.
 */

const crypto = require('crypto');
const net = require('net');
const dnsPromises = require('dns').promises;

/**
 * Validate a URL is safe to make outbound requests to.
 * Blocks private/internal IPs, loopback, link-local, and metadata endpoints.
 * @param {string} urlStr - URL to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateOutboundUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Only allow HTTPS and HTTP
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return { valid: false, error: `Blocked protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
    return { valid: false, error: 'Blocked: loopback address' };
  }

  // Block cloud metadata endpoints
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return { valid: false, error: 'Blocked: cloud metadata endpoint' };
  }

  // Block RFC 1918 private ranges and link-local
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return { valid: false, error: 'Blocked: private IP (10.x)' };
    if (a === 172 && b >= 16 && b <= 31) return { valid: false, error: 'Blocked: private IP (172.16-31.x)' };
    if (a === 192 && b === 168) return { valid: false, error: 'Blocked: private IP (192.168.x)' };
    if (a === 169 && b === 254) return { valid: false, error: 'Blocked: link-local (169.254.x)' };
  }

  return { valid: true };
}

// ── QCL-SECURITY P1-7 — DNS-resolving SSRF guard ────────────────────────────
// validateOutboundUrl() above is a cheap, synchronous, literal-IP-only check
// used on the hot path for REST/webhook connector calls (unchanged — kept
// synchronous so those call sites don't need touching). It has two gaps the
// audit flagged (P1-7 / P2-2): it doesn't resolve hostnames (a name that
// *resolves* to an internal IP passes), and it doesn't understand IPv6
// (loopback ::1, unique-local fc00::/7, link-local fe80::/10, or an
// IPv4-mapped IPv6 literal smuggling a blocked v4 address through).
//
// validateOutboundUrlResolved() below is the async, DNS-aware version used
// by /knowledge/crawl (an org-admin-only route since Phase 2, but an admin
// still shouldn't be able to make the crawler hit internal services). It
// re-uses validateOutboundUrl()'s literal-IP fast path first, then resolves
// the hostname and validates every returned address.

function ipv4Blocked(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = parts;
  if (a === 0) return true;                          // 0.0.0.0/8 unspecified
  if (a === 10) return true;                          // 10/8 private
  if (a === 127) return true;                         // 127/8 loopback
  if (a === 169 && b === 254) return true;             // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16/12 private
  if (a === 192 && b === 168) return true;             // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64/10 CGNAT
  if (a >= 224) return true;                            // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

// Decode an IPv4-mapped IPv6 address (::ffff:a.b.c.d or the hex form the
// WHATWG URL parser canonicalises it to, ::ffff:xxxx:xxxx) to dotted v4.
function mappedV4(ipv6lower) {
  if (ipv6lower.includes('.')) {
    const v4 = ipv6lower.slice(ipv6lower.lastIndexOf(':') + 1);
    return net.isIP(v4) === 4 ? v4 : null;
  }
  const m = ipv6lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

function ipv6Blocked(ip) {
  const lower = ip.toLowerCase();
  const v4 = mappedV4(lower);
  if (v4) return ipv4Blocked(v4);
  if (lower === '::1' || lower === '::') return true;               // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // fc00::/7 unique-local (ULA)
  if (lower.startsWith('ff')) return true;                             // ff00::/8 multicast
  return false;
}

function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true; // not a valid IP literal → block
}

/**
 * DNS-resolving SSRF guard. Validates scheme, then resolves the hostname
 * (or parses an IP literal directly — including IPv6 and IPv4-mapped-IPv6
 * forms) and blocks loopback/link-local/private/ULA/metadata addresses.
 * The WHATWG URL parser already canonicalises decimal/octal/hex-encoded
 * IPv4 hosts (e.g. `http://2130706433`) to dotted-quad, so those are caught
 * by the same IP check without special-casing.
 *
 * @param {string} urlStr
 * @param {object} [opts]
 * @param {object} [opts.resolver] - dns.promises-compatible resolver (test hook)
 * @returns {Promise<{valid: boolean, error?: string, ips?: string[]}>}
 */
async function validateOutboundUrlResolved(urlStr, { resolver = dnsPromises } = {}) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return { valid: false, error: `Blocked protocol: ${parsed.protocol}` };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost') return { valid: false, error: 'Blocked: loopback address' };
  if (host === 'metadata.google.internal') return { valid: false, error: 'Blocked: cloud metadata endpoint' };

  let ips;
  if (net.isIP(host)) {
    ips = [host];
  } else {
    try {
      const recs = await resolver.lookup(host, { all: true });
      ips = recs.map((r) => r.address);
    } catch {
      return { valid: false, error: `Blocked: DNS resolution failed for ${host}` };
    }
  }
  if (!ips.length) return { valid: false, error: `Blocked: no DNS records for ${host}` };

  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      return { valid: false, error: `Blocked: ${host} resolves to a non-routable/internal address (${ip})` };
    }
  }
  return { valid: true, ips };
}

/**
 * Fetch `urlStr` with SSRF validation re-applied on every redirect hop.
 * Disables fetch's automatic redirect-follow (`redirect: 'manual'`) and
 * manually validates + follows each `Location` header, so a page that
 * 302s the caller to an internal address (or to metadata) is blocked at
 * the hop, not just on the initial URL. Returns the final Response once a
 * non-redirect status is reached, or throws if a hop fails validation or
 * `maxRedirects` is exceeded.
 *
 * @param {string} urlStr
 * @param {object} [fetchOpts] - passed through to fetch() on every hop
 * @param {object} [opts]
 * @param {number} [opts.maxRedirects=5]
 * @param {object} [opts.resolver] - dns.promises-compatible resolver (test hook)
 */
async function fetchWithRedirectValidation(urlStr, fetchOpts = {}, { maxRedirects = 5, resolver = dnsPromises } = {}) {
  let currentUrl = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await validateOutboundUrlResolved(currentUrl, { resolver });
    if (!check.valid) {
      const err = new Error(check.error);
      err.code = 'ssrf_blocked';
      throw err;
    }
    const resp = await fetch(currentUrl, { ...fetchOpts, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      currentUrl = new URL(resp.headers.get('location'), currentUrl).toString();
      continue;
    }
    return resp;
  }
  const err = new Error(`Too many redirects (>${maxRedirects})`);
  err.code = 'too_many_redirects';
  throw err;
}

/**
 * Send a webhook POST request with optional HMAC signing.
 * @param {string} url - Webhook URL
 * @param {object} payload - JSON payload
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - Timeout in ms
 * @param {object} [options.headers] - Additional headers
 * @param {boolean} [options.skipUrlValidation=false] - Skip SSRF checks (for trusted internal URLs)
 * @returns {Promise<{ok: boolean, status: number, body: string}>}
 */
async function sendWebhook(url, payload, options = {}) {
  const { timeout = 10000, headers = {}, skipUrlValidation = false } = options;

  if (!skipUrlValidation) {
    const urlCheck = validateOutboundUrl(url);
    if (!urlCheck.valid) throw new Error(`URL validation failed: ${urlCheck.error}`);
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });

  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body };
}

/**
 * Send an API request (for REST-based channels like Telegram, Twilio).
 * @param {string} baseUrl - Base URL
 * @param {string} path - API path
 * @param {object} payload - JSON payload
 * @param {object} [auth] - Auth options { type: 'bearer'|'basic', token?, user?, pass? }
 * @param {number} [timeout=10000]
 * @returns {Promise<{ok: boolean, status: number, data: object}>}
 */
async function sendApi(baseUrl, path, payload, auth = null, timeout = 10000, skipUrlValidation = false) {
  const fullUrl = `${baseUrl}${path}`;
  if (!skipUrlValidation) {
    const urlCheck = validateOutboundUrl(fullUrl);
    if (!urlCheck.valid) throw new Error(`URL validation failed: ${urlCheck.error}`);
  }

  const headers = { 'Content-Type': 'application/json' };

  if (auth) {
    if (auth.type === 'bearer') {
      headers['Authorization'] = `Bearer ${auth.token}`;
    } else if (auth.type === 'basic') {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    }
  }

  const resp = await fetch(fullUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });

  let data;
  try { data = await resp.json(); } catch { data = {}; }
  return { ok: resp.ok, status: resp.status, data };
}

/**
 * Create HMAC-SHA256 signature for webhook payload.
 * @param {string} payload - Raw JSON string
 * @param {string} secret - Signing secret
 * @returns {string} hex-encoded signature
 */
function hmacSign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

module.exports = {
  sendWebhook,
  sendApi,
  hmacSign,
  validateOutboundUrl,
  // QCL-SECURITY P1-7
  validateOutboundUrlResolved,
  fetchWithRedirectValidation,
  isBlockedIp,
  ipv4Blocked,
  ipv6Blocked,
};

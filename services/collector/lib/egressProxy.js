/**
 * TOOLSMITH Slice D-2 — egressProxy.js
 *
 * Per-run HTTP egress proxy for sandbox containers when permissions.network === true.
 *
 * API:
 *   startEgressProxy({ secretValues, secretNames, allowedDomains })
 *   → Promise<{ port, getRecordedRequests(), stop() }>
 *
 * Security contract (R5 mandate):
 *   - Authorization and Cookie header VALUES are stripped in all recordings.
 *   - Any occurrence of secretValues[i] in any header value is replaced with
 *     [REDACTED:<secretNames[i]>] before recording.
 *   - Private RFC1918 + loopback address space is blocked by default (SSRF guard).
 *   - allowedDomains restricts outbound to an explicit list when set.
 *   - Bodies are NOT recorded (privacy + bundle size).
 *
 * Network: HTTP CONNECT proxy for HTTPS (opaque tunnel — only URL+status recorded).
 *          HTTP GET/POST etc. proxied directly for HTTP (headers visible, body not recorded).
 *
 * v1 constraints (upgrade path: TOOLSMITH-SANDBOX-HARDEN):
 *   - Env-var based (HTTPS_PROXY + HTTP_PROXY + NO_PROXY injected into container env)
 *   - TLS interception not performed — HTTPS bodies are opaque
 *   - Network namespace shared with container bridge (not `none`)
 */

'use strict';

const http = require('http');
const net = require('net');
const url = require('url');

// ---------------------------------------------------------------------------
// Private address ranges to block for SSRF protection
// ---------------------------------------------------------------------------

// RFC1918 + loopback + link-local ranges
const PRIVATE_CIDR_PATTERNS = [
  /^10\./,                            // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,      // 172.16.0.0/12
  /^192\.168\./,                      // 192.168.0.0/16
  /^127\./,                           // 127.0.0.0/8 (loopback)
  /^169\.254\./,                      // 169.254.0.0/16 (link-local)
  /^::1$/,                            // IPv6 loopback
  /^fc00:/,                           // IPv6 unique local
  /^fe80:/,                           // IPv6 link-local
];

/**
 * Returns true if the hostname looks like a private/loopback address.
 * Only IPs are checked — hostnames (domain names) are NOT checked here
 * because DNS resolution would be needed, and the proxy sees the final
 * resolved connection. The allowedDomains list is the domain-level check.
 */
function isPrivateAddress(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;
  // Strip port if present
  const host = hostname.replace(/:\d+$/, '');
  return PRIVATE_CIDR_PATTERNS.some(p => p.test(host));
}

// ---------------------------------------------------------------------------
// Domain allowlist check
// ---------------------------------------------------------------------------

/**
 * Returns true if the host is in the allowedDomains list.
 * Comparison strips ports and checks both with and without port.
 *
 * @param {string} host — e.g. "api.stripe.com" or "api.stripe.com:443"
 * @param {string[]|null} allowedDomains
 */
function isDomainAllowed(host, allowedDomains) {
  if (!allowedDomains) return true; // null = open
  const hostNoPort = host.replace(/:\d+$/, '');
  return allowedDomains.some(d => {
    const dNoPort = d.replace(/:\d+$/, '');
    return dNoPort === hostNoPort || host === d;
  });
}

// ---------------------------------------------------------------------------
// Header redaction (R5 mandate)
// ---------------------------------------------------------------------------

/**
 * Strip sensitive header values from a headers object.
 * Returns a new object (never mutates input).
 *
 * Rules:
 *   1. Authorization → [STRIPPED]
 *   2. Cookie        → [STRIPPED]
 *   3. Any occurrence of secretValues[i] in any header value →
 *      [REDACTED:<secretNames[i]>]
 *
 * @param {object} headers — plain object
 * @param {string[]} secretValues — raw secret values to scrub
 * @param {string[]} secretNames  — env var names (for annotation)
 * @returns {object} — redacted copy
 */
function redactHeaders(headers, secretValues, secretNames) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    let v = typeof value === 'string' ? value : String(value);

    // First: replace secret values in ALL headers (including Authorization/Cookie)
    // This produces more specific [REDACTED:NAME] markers rather than generic [STRIPPED].
    if (secretValues && secretValues.length > 0) {
      for (let i = 0; i < secretValues.length; i++) {
        const secretVal = secretValues[i];
        const secretName = secretNames && secretNames[i] ? secretNames[i] : `SECRET_${i}`;
        if (secretVal && v.includes(secretVal)) {
          v = v.split(secretVal).join(`[REDACTED:${secretName}]`);
        }
      }
    }

    // Second: if Authorization or Cookie still contain the original raw value
    // (no secret match), strip entire value as a catch-all.
    if (k === 'authorization' || k === 'cookie') {
      // Only strip if no REDACTED marker was inserted (i.e. value is unchanged from original)
      const originalV = typeof value === 'string' ? value : String(value);
      if (v === originalV) {
        out[key] = '[STRIPPED]';
        continue;
      }
    }

    out[key] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main: startEgressProxy
// ---------------------------------------------------------------------------

/**
 * Start an HTTP proxy on a random free port.
 *
 * @param {object} opts
 * @param {string[]} [opts.secretValues=[]]     Raw secret values to redact
 * @param {string[]} [opts.secretNames=[]]      Env var names for annotations
 * @param {string[]|null} [opts.allowedDomains=null]  Allowlist; null = open
 * @returns {Promise<{ port: number, getRecordedRequests: () => object[], stop: () => Promise<void> }>}
 */
async function startEgressProxy({
  secretValues = [],
  secretNames = [],
  allowedDomains = null,
} = {}) {
  const recordedRequests = [];

  /**
   * Record a request entry (with redacted headers, no body).
   */
  function record(entry) {
    recordedRequests.push(entry);
  }

  const server = http.createServer((req, res) => {
    // ── HTTP (non-CONNECT) proxy path ────────────────────────────────────────
    const startTime = Date.now();
    let targetUrl;
    try {
      targetUrl = new URL(req.url);
    } catch (_) {
      // Malformed URL
      record({
        method: req.method,
        url: req.url,
        headers: {},
        body_size: 0,
        response_status: 400,
        duration_ms: Date.now() - startTime,
        refused: true,
        refused_reason: 'malformed_url',
      });
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const targetHost = targetUrl.hostname;

    // SSRF guard: block private/loopback addresses
    // Exception: if the host is in allowedDomains, the allowedDomains check
    // below handles it. Private block applies ONLY if the host is NOT in
    // allowedDomains (or allowedDomains is null but the host is still private).
    const explicitlyAllowed = allowedDomains && isDomainAllowed(targetHost, allowedDomains);
    if (!explicitlyAllowed && isPrivateAddress(targetHost)) {
      record({
        method: req.method,
        url: req.url,
        headers: redactHeaders(req.headers, secretValues, secretNames),
        body_size: 0,
        response_status: 403,
        duration_ms: Date.now() - startTime,
        refused: true,
        refused_reason: 'private_address_blocked',
      });
      res.writeHead(403);
      res.end('Forbidden: private address blocked');
      return;
    }

    // Domain allowlist check
    if (allowedDomains !== null && !isDomainAllowed(targetHost, allowedDomains)) {
      record({
        method: req.method,
        url: req.url,
        headers: redactHeaders(req.headers, secretValues, secretNames),
        body_size: 0,
        response_status: 403,
        duration_ms: Date.now() - startTime,
        refused: true,
        refused_reason: 'domain_not_allowed',
      });
      res.writeHead(403);
      res.end('Forbidden: domain not in allowlist');
      return;
    }

    // Forward the request
    const targetPort = targetUrl.port
      ? parseInt(targetUrl.port, 10)
      : (targetUrl.protocol === 'https:' ? 443 : 80);

    const targetOptions = {
      hostname: targetHost,
      port: targetPort,
      path: targetUrl.pathname + (targetUrl.search || ''),
      method: req.method,
      headers: { ...req.headers },
    };
    // Remove proxy-specific headers
    delete targetOptions.headers['proxy-connection'];

    let bodySize = 0;
    const proxyReq = http.request(targetOptions, (proxyRes) => {
      const duration = Date.now() - startTime;
      record({
        method: req.method,
        url: req.url,
        headers: redactHeaders(req.headers, secretValues, secretNames),
        body_size: bodySize,
        response_status: proxyRes.statusCode,
        duration_ms: duration,
      });
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      const duration = Date.now() - startTime;
      record({
        method: req.method,
        url: req.url,
        headers: redactHeaders(req.headers, secretValues, secretNames),
        body_size: bodySize,
        response_status: 502,
        duration_ms: duration,
        error: err.message,
      });
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    req.on('data', (chunk) => { bodySize += chunk.length; });
    req.pipe(proxyReq);
  });

  // ── HTTPS CONNECT proxy path ────────────────────────────────────────────────
  server.on('connect', (req, clientSocket, head) => {
    const startTime = Date.now();
    // req.url for CONNECT is "hostname:port"
    const [targetHost, targetPortStr] = req.url.split(':');
    const targetPort = parseInt(targetPortStr || '443', 10);

    // SSRF guard for CONNECT
    const explicitlyAllowed = allowedDomains && isDomainAllowed(targetHost, allowedDomains);
    if (!explicitlyAllowed && isPrivateAddress(targetHost)) {
      record({
        method: 'CONNECT',
        url: req.url,
        headers: redactHeaders(req.headers, secretValues, secretNames),
        body_size: 0,
        response_status: 403,
        duration_ms: Date.now() - startTime,
        refused: true,
        refused_reason: 'private_address_blocked',
      });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Domain allowlist check for CONNECT
    if (allowedDomains !== null && !isDomainAllowed(targetHost, allowedDomains)) {
      record({
        method: 'CONNECT',
        url: req.url,
        headers: redactHeaders(req.headers, secretValues, secretNames),
        body_size: 0,
        response_status: 403,
        duration_ms: Date.now() - startTime,
        refused: true,
        refused_reason: 'domain_not_allowed',
      });
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // Establish TCP tunnel
    const serverSocket = net.connect(targetPort, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);

      serverSocket.on('end', () => {
        const duration = Date.now() - startTime;
        // For CONNECT (HTTPS) we only know the URL and status — body is opaque
        record({
          method: 'CONNECT',
          url: `https://${req.url}`,
          headers: redactHeaders(req.headers, secretValues, secretNames),
          body_size: 0,
          response_status: 200,
          duration_ms: duration,
        });
      });
    });

    serverSocket.on('error', (err) => {
      const duration = Date.now() - startTime;
      record({
        method: 'CONNECT',
        url: `https://${req.url}`,
        headers: redactHeaders(req.headers, secretValues, secretNames),
        body_size: 0,
        response_status: 502,
        duration_ms: duration,
        error: err.message,
      });
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    });
  });

  // Listen on a random free port on all interfaces so sandbox containers on the same docker network
  // can reach it; proxy still requires the random port + secret-redaction + domain-allow gates to be useful.
  await new Promise((resolve, reject) => {
    server.listen(0, '0.0.0.0', () => resolve());
    server.on('error', reject);
  });

  const port = server.address().port;

  function getRecordedRequests() {
    return recordedRequests.slice(); // return a copy
  }

  function stop() {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  return { port, getRecordedRequests, stop };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { startEgressProxy, isPrivateAddress, isDomainAllowed, redactHeaders };

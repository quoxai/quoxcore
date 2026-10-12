'use strict';

/**
 * QUOX-SECURITY Phase 0: production lookupDnsTxt/fetchWellKnown
 * implementations, injected as verifyTarget()'s deps at the API layer
 * (securityEngagement.js itself stays pure and dependency-injected, see
 * that file's own header).
 *
 * fetchWellKnown resolves and fetches a user-supplied domain server-side,
 * a textbook SSRF vector, so assertSafeEgressHost must run before any
 * fetch. Ported (CommonJS) from services/auth/lib/egressGuard.js (stream
 * #49, finding S1) rather than rewritten from scratch: collector and auth
 * are separate deployed services and cannot cross-require, but the
 * blocked-range logic needs to stay identical. Keep both files in sync if
 * either changes.
 */

const dns = require('node:dns/promises');
const net = require('node:net');

function badEgress(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = 'blocked_egress';
  return err;
}

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed, block
  const [a, b] = p;
  if (a === 0) return true;                        // 0.0.0.0/8 (unspecified)
  if (a === 10) return true;                        // 10/8 private
  if (a === 127) return true;                       // 127/8 loopback
  if (a === 169 && b === 254) return true;          // 169.254/16 link-local (incl. metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 private
  if (a === 192 && b === 168) return true;           // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64/10 CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224) return true;                          // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

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
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true;                             // ff00::/8 multicast
  return false;
}

function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true; // not a valid IP, block
}

/**
 * Validate that `host` is safe to fetch server-side. Throws a blocked_egress
 * error when it resolves to any non-routable/internal/metadata address.
 * @param {string} host
 * @param {{resolver?: object}} deps
 * @returns {Promise<{ips: string[]}>}
 */
async function assertSafeEgressHost(host, deps = {}) {
  const resolver = deps.resolver || dns;
  let ips;
  if (net.isIP(host)) {
    ips = [host];
  } else {
    try {
      const recs = await resolver.lookup(host, { all: true });
      ips = recs.map((r) => r.address);
    } catch {
      throw badEgress(`dns_resolution_failed: ${host}`);
    }
  }
  if (!ips.length) throw badEgress(`no_dns_records: ${host}`);
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      throw badEgress(`blocked_host: ${host} resolves to a non-routable/internal address`);
    }
  }
  return { ips };
}

/**
 * TXT record lookup for the dns_txt verification method. Never throws on
 * "no records", an absent TXT record is a legitimate not-yet-verified
 * state, not an error.
 */
async function lookupDnsTxt(domain, deps = {}) {
  const resolver = deps.resolver || dns;
  try {
    const chunks = await resolver.resolveTxt(domain);
    return chunks.map((parts) => parts.join(''));
  } catch (err) {
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') return [];
    throw err;
  }
}

/**
 * Fetches the fixed well-known verification path over https and returns
 * the trimmed body. Guard runs BEFORE the fetch; redirect:'manual' so a
 * 3xx to an internal host is surfaced as a failure, never silently
 * followed (the same redirect-to-internal bypass class egressGuard.js
 * documents as a residual risk for automatic redirect handling).
 */
async function fetchWellKnown(domain, deps = {}) {
  await assertSafeEgressHost(domain, deps);
  const fetchImpl = deps.fetchImpl || fetch;
  const url = `https://${domain}/.well-known/quox-verification`;
  const resp = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (!resp.ok) {
    throw badEgress(`http_${resp.status}: well-known verification file not reachable at ${url}`);
  }
  const body = await resp.text();
  return body.trim();
}

module.exports = { assertSafeEgressHost, lookupDnsTxt, fetchWellKnown };

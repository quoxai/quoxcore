// SSRF egress guard (copied from services/auth/lib/egressGuard.js; quoxbrain has its own Docker build context so it cannot import across services).
//
// Brain capture (URL clip) fetches a user-supplied URL server-side (MCP probe /
// repo transport detection) and previously did so with no host validation —
// an authed org member could point it at internal services (collector:9848),
// the cloud metadata endpoint (169.254.169.254), etc., and the upstream body
// was reflected back. This guard resolves the host and rejects any URL that
// resolves to a non-routable / internal / metadata address before the fetch.
//
// DNS rebinding (BRAIN2-W5 056): assertSafeEgressUrl returns the validated
// addresses and pinnedFetch() connects to EXACTLY those, so the host is never
// re-resolved between validation and connect. (The redirect:'manual' handling
// in the callers re-validates every hop.)

import dnsPromises from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

function badEgress(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = 'blocked_egress';
  err.expose = true; // client error — safe to surface the message
  return err;
}

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = p;
  if (a === 0) return true;                       // 0.0.0.0/8 (unspecified)
  if (a === 10) return true;                      // 10/8 private
  if (a === 127) return true;                     // 127/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254/16 link-local (incl. metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true;        // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224) return true;                      // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

// Decode an IPv4-mapped IPv6 address to dotted v4, handling BOTH the dotted
// form (::ffff:169.254.169.254) and the hex form the WHATWG URL parser
// canonicalises it to (::ffff:a9fe:a9fe). Returns null if not mapped.
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
  // IPv4-mapped (::ffff:a.b.c.d / ::ffff:xxxx:xxxx) — check the embedded v4.
  const v4 = mappedV4(lower);
  if (v4) return ipv4Blocked(v4);
  if (lower === '::1' || lower === '::') return true;     // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true;                            // ff00::/8 multicast
  return false;
}

function isBlockedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Blocked(ip);
  if (fam === 6) return ipv6Blocked(ip);
  return true; // not a valid IP → block
}

/**
 * Validate that `rawUrl` is safe to fetch server-side. Throws a 400 Error
 * (statusCode/code/expose set) when the scheme is not http(s) or the host
 * resolves to any non-routable / internal / metadata address.
 * @returns {Promise<{url: URL, ips: string[]}>}
 */
export async function assertSafeEgressUrl(rawUrl, { resolver = dnsPromises } = {}) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw badEgress('invalid_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw badEgress(`unsupported_scheme: ${u.protocol.replace(':', '')} (only http/https allowed)`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

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
  return { url: u, ips };
}

export const _internal = { isBlockedIp, ipv4Blocked, ipv6Blocked };

/**
 * fetch-compatible (subset) request that connects ONLY to the pre-validated
 * `ips` (Host header / TLS SNI still use the original hostname). Returns
 * { status, ok, headers.get(), body } where body is an async-iterable of
 * Buffers, which is all fetchUrl/readCapped needs. redirect is never followed.
 */
export function pinnedFetch(rawUrl, ips, { signal, headers = {} } = {}) {
  const u = new URL(rawUrl);
  const lib = u.protocol === 'https:' ? https : http;
  let i = 0;
  const lookup = (_host, opts, cb) => {
    const ip = ips[i++ % ips.length];
    if (opts && opts.all) return cb(null, [{ address: ip, family: net.isIP(ip) }]);
    return cb(null, ip, net.isIP(ip));
  };
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: 'GET', headers, lookup, signal }, (res) => {
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v ?? null); } },
        body: Readable.from(res),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

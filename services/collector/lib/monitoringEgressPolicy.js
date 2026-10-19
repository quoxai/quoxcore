/**
 * monitoringEgressPolicy.js (quox#1061)
 *
 * Egress policy for ORG-supplied monitoring integration URLs (today:
 * ALERTMANAGER_URL). An org member who can `quox settings set` must not be
 * able to aim the collector's server-side fetch at the collector's own
 * internals (cross-tenant SSRF).
 *
 * The collector's general guard (securityDomainVerification.assertSafeEgressHost)
 * also blocks RFC1918, which would make a LAN Alertmanager (the normal case)
 * impossible. This policy keeps the same shape (resolve DNS once, check
 * EVERY resolved address, refuse on any failure) but with a monitoring
 * deny list:
 *   - scheme other than http/https, or embedded credentials
 *   - loopback (127/8, ::1), unspecified (0/8, ::), link-local incl. cloud
 *     metadata (169.254/16, fe80::/10), multicast/reserved (224/4+, ff00::/8),
 *     IPv4-mapped forms of all of these
 *   - localhost / *.localhost, docker/cloud internal names, and the Quox
 *     stack's own compose service names and quox-* container names
 * RFC1918, CGNAT and IPv6 ULA stay ALLOWED, after the deny list.
 *
 * Instance-scope and env values are owner/operator controlled and are NOT
 * run through this policy.
 *
 * Residual: the use-time check resolves DNS, then fetch() resolves again.
 * A rebinding window between the two remains (no connection pinning
 * without a declared undici dependency); redirects are not followed.
 */

'use strict';

const net = require('net');
const dns = require('dns').promises;

const DENIED_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal', 'gateway.docker.internal', 'metadata.google.internal', 'metadata',
  // Quox compose service names (docker-compose*.yml)
  'dashboard', 'auth', 'files', 'collector', 'tasks', 'repobrain', 'orchestrator', 'memory',
  'quoxbrain', 'qlarity', 'quoxplan', 'quoxsignal', 'quoxseo', 'qdrant', 'postgres',
  'quoxflow', 'powers-host', 'screencap', 'synapse', 'matrix', 'redis',
]);

function ipv4Denied(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;               // 0/8 unspecified
  if (a === 127) return true;             // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a >= 224) return true;              // multicast + reserved + broadcast
  return false;
}

function mappedV4(lower) {
  if (lower.includes('.')) {
    const v4 = lower.slice(lower.lastIndexOf(':') + 1);
    return net.isIP(v4) === 4 ? v4 : null;
  }
  const m = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

function ipv6Denied(ip) {
  const lower = ip.toLowerCase();
  const v4 = mappedV4(lower);
  if (v4) return ipv4Denied(v4);
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true;  // multicast
  return false;
}

function isDeniedIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Denied(ip);
  if (fam === 6) return ipv6Denied(ip);
  return true;
}

function hostOf(u) {
  // URL keeps IPv6 literals bracketed; strip for net.isIP.
  return u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function isDeniedHostname(host) {
  if (DENIED_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost')) return true;
  if (host.startsWith('quox-')) return true; // quox-* container / compose-project names
  return false;
}

/**
 * Synchronous literal check (set time and the first step of use time).
 * @returns {string|null} refusal reason, or null when the literal is acceptable
 */
function orgMonitoringUrlRefusal(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http or https is allowed';
  if (u.username || u.password) return 'embedded credentials are not allowed';
  const host = hostOf(u);
  if (!host) return 'URL has no host';
  if (net.isIP(host)) {
    return isDeniedIp(host) ? `blocked address ${host} (loopback, link-local, metadata or unspecified)` : null;
  }
  if (isDeniedHostname(host)) return `blocked host ${host} (internal service or localhost)`;
  return null;
}

/**
 * Use-time check: literal check, then resolve DNS once and check every
 * resolved address. Throws with a plain reason on refusal.
 */
async function assertOrgMonitoringUrlSafe(rawUrl, deps = {}) {
  const literal = orgMonitoringUrlRefusal(rawUrl);
  if (literal) throw new Error(literal);
  const host = hostOf(new URL(String(rawUrl).trim()));
  if (net.isIP(host)) return { ips: [host] };
  const resolver = deps.resolver || dns;
  let ips;
  try {
    ips = (await resolver.lookup(host, { all: true })).map((r) => r.address);
  } catch {
    throw new Error(`could not resolve ${host}`);
  }
  if (!ips.length) throw new Error(`could not resolve ${host}`);
  for (const ip of ips) {
    if (isDeniedIp(ip)) throw new Error(`blocked host ${host} resolves to ${ip} (loopback, link-local, metadata or unspecified)`);
  }
  return { ips };
}

module.exports = { orgMonitoringUrlRefusal, assertOrgMonitoringUrlSafe, isDeniedIp };

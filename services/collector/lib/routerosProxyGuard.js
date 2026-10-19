/**
 * RouterOS Proxy Guard
 *
 * Security fix for WEB-REFACTOR note #2289 (2026-08-06): POST
 * /api/v1/mikrotik/proxy was an authenticated SSRF. Past the auth gate the
 * CALLER supplied host, port, path and method directly in the request body,
 * so any authenticated session could drive the collector as a proxy to any
 * internal host/port with any HTTP method (rejectUnauthorized: false).
 *
 * Mirrors the PVE-PROXY fix already in this file's sibling route
 * (server.js, GET/ALL /api/v1/monitoring/proxy/:service/*): the outbound
 * target is sourced from server-stored config, never the request body (see
 * routerosConfigStore.js), and the caller may only choose FROM an explicit
 * allowlist of REST path + method pairs — every one built from the actual
 * call sites in src/services/routerosClient.js's proxyApiCall().
 *
 * assertRouterosEgressHost() below deliberately does NOT reuse this file's
 * neighbour, lib/channels/baseDriver.js's validateOutboundUrlResolved()
 * (the collector's general DNS-resolving SSRF guard) wholesale: that guard
 * blocks every RFC1918 private range (10/8, 172.16/12, 192.168/16) plus
 * CGNAT (100.64/10) by design, because it protects a *caller-supplied* URL
 * fetch (webhook/channel drivers, /knowledge/crawl) where any private-range
 * target IS the SSRF. A MikroTik router is, by definition, a private-LAN
 * device — the whole point of this feature is reaching one — so running
 * the general guard here would 400 every real deployment. The PVE-PROXY
 * route above has the identical shape (Proxmox nodes also sit on private
 * ranges, e.g. 192.0.2.x) and for the same reason does not run any
 * egress guard at all, relying solely on "target comes from stored config,
 * not the request" + its method allowlist.
 *
 * This guard adds one narrower layer PVE-PROXY doesn't have: it blocks the
 * subset of addresses that are NEVER a legitimate RouterOS target for ANY
 * org — loopback, link-local (including the 169.254.169.254 cloud metadata
 * address), unspecified, multicast and reserved ranges — so a malicious or
 * mistaken stored config can't pivot the collector against itself or a
 * cloud metadata endpoint, while leaving every real private-LAN router
 * reachable.
 */

const net = require('net');
const dnsPromises = require('dns').promises;

// Every REST path + method routerosClient.js's proxyApiCall() sends through
// the proxy (grepped from src/services/routerosClient.js). Anything not on
// this list is rejected with 403 before the stored credentials are ever
// attached to an outbound request.
const IFACE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOSTNAME_RE = /^[A-Za-z0-9.-]{1,253}$/;
const PING_MAX_COUNT = 5;

function hasExactKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const actual = Object.keys(body);
  return actual.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(body, k));
}

/** {interface:"<name>", once:""} and nothing else. */
function validateMonitorTrafficBody(body) {
  if (!hasExactKeys(body, ['interface', 'once'])) return false;
  return typeof body.interface === 'string' && IFACE_NAME_RE.test(body.interface) && body.once === '';
}

/** {address:"<ipv4|hostname>", count:"1".."5"} and nothing else. */
function validatePingBody(body) {
  if (!hasExactKeys(body, ['address', 'count'])) return false;
  const { address, count } = body;
  if (typeof address !== 'string') return false;
  const addrOk = net.isIPv4(address) || (HOSTNAME_RE.test(address) && !address.startsWith('-'));
  if (!addrOk) return false;
  const countStr = typeof count === 'number' ? String(count) : count;
  if (typeof countStr !== 'string' || !/^[1-9][0-9]?$/.test(countStr)) return false;
  return Number(countStr) >= 1 && Number(countStr) <= PING_MAX_COUNT;
}

const ROUTEROS_ID = '[0-9A-Za-z*]{1,64}'; // RouterOS `.id` values, e.g. "*1A"
const ALLOWED_ROUTEROS_REQUESTS = [
  { method: 'GET', pattern: /^\/system\/resource$/ },
  { method: 'GET', pattern: /^\/system\/health$/ },
  { method: 'GET', pattern: /^\/ip\/arp$/ },
  { method: 'GET', pattern: /^\/ip\/dhcp-server\/lease$/ },
  { method: 'GET', pattern: /^\/ip\/pool$/ },
  { method: 'PATCH', pattern: new RegExp(`^/ip/dhcp-server/lease/${ROUTEROS_ID}$`) },
  { method: 'DELETE', pattern: new RegExp(`^/ip/dhcp-server/lease/${ROUTEROS_ID}$`) },
  { method: 'POST', pattern: /^\/ip\/firewall\/address-list$/ },
  { method: 'GET', pattern: /^\/interface\/wireguard\/peers$/ },
  { method: 'GET', pattern: /^\/ip\/ipsec\/active-peers$/ },
  // NETWATCH read-only tools (listing / passive reads; no writes).
  { method: 'GET', pattern: /^\/interface$/ },
  { method: 'GET', pattern: /^\/ip\/firewall\/filter$/ },
  { method: 'GET', pattern: /^\/ip\/firewall\/nat$/ },
  { method: 'GET', pattern: /^\/ip\/dns$/ },
  { method: 'GET', pattern: /^\/ip\/dns\/cache$/ },
  { method: 'GET', pattern: /^\/ip\/neighbor$/ },
  // The two POSTs are read-only probes but still carry a body, so the guard
  // validates the body shape itself (exact keys, validated values).
  { method: 'POST', pattern: /^\/interface\/monitor-traffic$/, validateBody: validateMonitorTrafficBody },
  { method: 'POST', pattern: /^\/ping$/, validateBody: validatePingBody },
];

/**
 * @param {string} method
 * @param {string} path
 * @param {*} [body] request body; entries with a validateBody (the read-only
 *   POST probes) are refused unless the body passes it.
 * @returns {boolean}
 */
function isAllowedRouterosRequest(method, path, body) {
  if (typeof method !== 'string' || typeof path !== 'string' || !path) return false;
  // Defence in depth — routerosClient.js never sends a query string,
  // fragment, or anything but a clean absolute path.
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('..')) {
    return false;
  }
  const upperMethod = method.toUpperCase();
  return ALLOWED_ROUTEROS_REQUESTS.some(
    (entry) => entry.method === upperMethod && entry.pattern.test(path) &&
      (!entry.validateBody || entry.validateBody(body))
  );
}

// ── narrow egress guard: loopback / link-local / metadata / unspecified only ──
// (private-LAN ranges are intentionally NOT blocked — see module doc comment)

function ipv4Dangerous(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → block
  const [a, b] = parts;
  if (a === 0) return true;                    // 0.0.0.0/8 unspecified
  if (a === 127) return true;                   // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;       // 169.254.0.0/16 link-local incl. 169.254.169.254 metadata
  if (a >= 224) return true;                     // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
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

function ipv6Dangerous(ip) {
  const lower = ip.toLowerCase();
  const v4 = mappedV4(lower);
  if (v4) return ipv4Dangerous(v4);
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

function isDangerousIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return ipv4Dangerous(ip);
  if (fam === 6) return ipv6Dangerous(ip);
  return true; // not a valid IP literal → block
}

/**
 * Validate that `host` (from server-stored config, never the request body)
 * is safe to dial. Resolves hostnames the same way
 * baseDriver.js#validateOutboundUrlResolved does. Private-LAN ranges are
 * allowed on purpose — see module doc comment.
 *
 * @param {string} host
 * @param {object} [opts]
 * @param {object} [opts.resolver] - dns.promises-compatible resolver (test hook)
 * @returns {Promise<{valid: boolean, error?: string, ips?: string[]}>}
 */
async function assertRouterosEgressHost(host, { resolver = dnsPromises } = {}) {
  if (typeof host !== 'string' || !host) {
    return { valid: false, error: 'router host is required' };
  }
  const bare = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (bare === 'localhost') {
    return { valid: false, error: 'Blocked: localhost is not a valid router address' };
  }
  if (bare === 'metadata.google.internal') {
    return { valid: false, error: 'Blocked: cloud metadata endpoint' };
  }

  let ips;
  if (net.isIP(bare)) {
    ips = [bare];
  } else {
    try {
      const recs = await resolver.lookup(bare, { all: true });
      ips = recs.map((r) => r.address);
    } catch {
      return { valid: false, error: `Blocked: DNS resolution failed for ${bare}` };
    }
  }
  if (!ips.length) return { valid: false, error: `Blocked: no DNS records for ${bare}` };

  for (const ip of ips) {
    if (isDangerousIp(ip)) {
      return { valid: false, error: `Blocked: ${bare} resolves to a loopback/link-local/metadata address (${ip})` };
    }
  }
  return { valid: true, ips };
}

module.exports = {
  ALLOWED_ROUTEROS_REQUESTS,
  isAllowedRouterosRequest,
  assertRouterosEgressHost,
};

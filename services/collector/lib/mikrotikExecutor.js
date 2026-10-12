/**
 * MikroTik RouterOS Executor
 *
 * Inline executor for mikrotik entity tools (src/config/entities/tools/mikrotik.json),
 * registered via entityToolLoader.js's INTERNAL_EXECUTORS (same seam as
 * prometheusExecutor.js / quoxagentExecutor.js — the house pattern for an
 * entity toolset that bridges to a local collector-side endpoint).
 *
 * This module owns ONLY the tool_id -> RouterOS REST {path, method}
 * translation. Every real call is made by self-POSTing to the already
 * hardened POST /api/v1/mikrotik/proxy route (server.js), which is the one
 * place that sources the target host/credentials from the per-org store
 * (routerosConfigStore.js) and checks the path+method allowlist
 * (routerosProxyGuard.js). Nothing here re-implements or duplicates that
 * allowlist — see UNSUPPORTED_TOOLS below, which is cross-checked against
 * ALLOWED_ROUTEROS_REQUESTS only to keep the two lists honest with each
 * other, never to authorize a call.
 *
 * Declared tools with no REST equivalent on the proxy's allowlist (CDP/MNDP
 * discovery, generic interface/traffic stats, firewall rule listing,
 * unblock, ping/DNS diagnostics, AI issue analysis, change preview) return a
 * structured "not_implemented" error naming the gap instead of fabricating
 * data — see the WEB-REFACTOR-27 task note and NETWATCH tools bridge report.
 */

const { ALLOWED_ROUTEROS_REQUESTS } = require('./routerosProxyGuard');

function getCollectorUrl() {
  return process.env.COLLECTOR_URL || 'http://localhost:9848';
}

// Declared mikrotik.json tools that have no allowlisted RouterOS REST path
// (and src/services/routerosClient.js does not call one for them either —
// per WEB-REFACTOR-27, the allowlist is only extended for paths already
// used by a real panel, never invented here). Keep this in sync with
// mikrotik.json's tool ids; a tool id present in BOTH this map and the
// switch below is a bug.
const UNSUPPORTED_TOOLS = {
  'mikrotik.discovery.scan':
    'CDP/MNDP neighbor discovery has no RouterOS REST endpoint on the hardened proxy allowlist (routerosProxyGuard.js); it is not implemented.',
  'mikrotik.monitoring.interfaces':
    'No /interface listing path is on the RouterOS proxy allowlist and src/services/routerosClient.js does not call one either; interface statistics are not implemented.',
  'mikrotik.monitoring.traffic':
    'No interface traffic/bandwidth path is on the RouterOS proxy allowlist and src/services/routerosClient.js does not call one either; traffic monitoring is not implemented.',
  'mikrotik.firewall.rules':
    'No firewall filter/NAT/mangle listing path is on the RouterOS proxy allowlist; only POST /ip/firewall/address-list (block) is allowed. Listing rules is not implemented.',
  'mikrotik.firewall.unblock_ip':
    'No DELETE path for /ip/firewall/address-list is on the RouterOS proxy allowlist. src/services/routerosClient.js#unblockDevice is itself a stub that never calls the router, so there is nothing real to bridge to yet.',
  'mikrotik.diagnostics.analyze_issue':
    'No RouterOS REST path backs AI-powered issue analysis; it has not been built.',
  'mikrotik.diagnostics.ping_test':
    'No ping/probe path is on the RouterOS proxy allowlist; connectivity testing from the router is not implemented.',
  'mikrotik.diagnostics.dns_check':
    'No DNS-check path is on the RouterOS proxy allowlist; DNS resolution testing from the router is not implemented.',
  'mikrotik.automation.preview':
    'No RouterOS REST path backs configuration-change preview; it has not been built.',
};

function isPathMethodAllowed(method, path) {
  const upper = String(method || '').toUpperCase();
  return ALLOWED_ROUTEROS_REQUESTS.some((entry) => entry.method === upper && entry.pattern.test(path));
}

/**
 * Self-call the hardened RouterOS proxy. Returns the proxy's own response
 * shape ({ success, data, ... } or { success: false, error, status, ... }) —
 * callers below thread that straight back to the agent when a single
 * RouterOS call is enough, or combine several into a richer result.
 */
async function proxyCall(base, orgId, path, method, body) {
  if (!isPathMethodAllowed(method, path)) {
    // Defensive only — every path below is a literal from
    // ALLOWED_ROUTEROS_REQUESTS. If this ever fires it is a bug in this
    // file, not a runtime/user condition, so fail the same honest way the
    // proxy itself would.
    return { success: false, error: 'method_not_allowed', detail: `${method} ${path} is not on the RouterOS proxy allowlist`, status: 403 };
  }
  try {
    // The proxy sits behind requireServiceOrUserAuth(); this executor runs
    // inside the collector, so it authenticates with the service key. Without
    // this header every call 401s and the auth-error body used to be returned
    // as if it were router data (found by the first AGENT-OVERHAUL
    // proof-drive, 2026-08-07).
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
    const resp = await fetch(`${base}/api/v1/mikrotik/proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { 'x-service-key': serviceKey } : {}),
      },
      body: JSON.stringify({ path, method, body: body || null, org_id: orgId || undefined }),
      signal: AbortSignal.timeout(20000),
    });
    let result;
    try {
      result = await resp.json();
    } catch {
      return { success: false, error: `RouterOS proxy returned a non-JSON response (HTTP ${resp.status})`, status: resp.status };
    }
    if (!resp.ok) {
      return {
        success: false,
        error: result.error || `RouterOS proxy rejected the call (HTTP ${resp.status})`,
        detail: result.message || result.detail,
        status: resp.status,
      };
    }
    return result;
  } catch (err) {
    return { success: false, error: `RouterOS proxy request failed: ${err.message}`, status: 0 };
  }
}

// Same health-score formula src/services/routerosClient.js#getRouter already
// ships (not invented here) — reused so the agent's number matches the
// RouterOS panel's number for the same router.
function computeHealthScore(resource, sensors) {
  const tempItem = Array.isArray(sensors)
    ? sensors.find((h) => h.name === 'temperature' || h.name === 'cpu-temperature')
    : null;
  const temperature = Number(tempItem?.value) || 0;
  const cpuLoad = Number(resource?.['cpu-load']) || 0;
  const totalMem = Number(resource?.['total-memory']) || 0;
  const freeMem = Number(resource?.['free-memory']) || 0;
  const memUsed = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;
  const score = Math.round(100 - (cpuLoad * 0.3 + memUsed * 0.3 + Math.max(0, temperature - 50) * 0.4));
  return { score: Math.max(0, Math.min(100, score)), cpu: cpuLoad, memory: Math.round(memUsed), temperature };
}

module.exports = {
  UNSUPPORTED_TOOLS,

  async execute(toolId, input, ctx) {
    if (UNSUPPORTED_TOOLS[toolId]) {
      return {
        success: false,
        error: 'not_implemented',
        detail: UNSUPPORTED_TOOLS[toolId],
        status: 501,
      };
    }

    const base = getCollectorUrl();
    const orgId = ctx?.orgId || null;

    switch (toolId) {
      case 'mikrotik.monitoring.health': {
        const resource = await proxyCall(base, orgId, '/system/resource', 'GET');
        if (!resource.success) return resource;
        const health = await proxyCall(base, orgId, '/system/health', 'GET');
        const scored = computeHealthScore(resource.data, health.success ? health.data : null);
        return {
          success: true,
          health: { resource: resource.data, sensors: health.success ? health.data : null },
          score: scored.score,
          issues: health.success ? [] : [`sensor data unavailable: ${health.error}`],
        };
      }

      case 'mikrotik.discovery.inventory': {
        const arp = await proxyCall(base, orgId, '/ip/arp', 'GET');
        if (!arp.success) return arp;
        const devices = (arp.data || []).filter((e) => e.address && e['mac-address']);
        return {
          success: true,
          routers: [{ id: input.router_id || 'primary' }],
          devices: input.include_devices === false ? [] : devices,
          total: devices.length,
        };
      }

      case 'mikrotik.dhcp.leases': {
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        if (!leases.success) return leases;
        return { success: true, leases: leases.data || [], total: (leases.data || []).length };
      }

      case 'mikrotik.dhcp.reserve': {
        if (!input.mac_address || !input.address) {
          return { success: false, error: 'mac_address and address are required', status: 400 };
        }
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        if (!leases.success) return leases;
        const match = (leases.data || []).find(
          (l) => l['mac-address'] === input.mac_address && l.address === input.address
        );
        if (!match) {
          return {
            success: false,
            error: 'lease_not_found',
            detail: `No existing DHCP lease matches mac_address=${input.mac_address} address=${input.address}. The device must have a current lease before it can be reserved.`,
            status: 404,
          };
        }
        const leaseId = match['.id'];
        const patch = await proxyCall(base, orgId, `/ip/dhcp-server/lease/${leaseId}`, 'PATCH', {
          'make-static': true,
        });
        if (!patch.success) return patch;
        return { success: true, lease: { ...match, dynamic: false }, preview: { id: leaseId, action: 'make-static' } };
      }

      case 'mikrotik.dhcp.conflict_check': {
        const arp = await proxyCall(base, orgId, '/ip/arp', 'GET');
        if (!arp.success) return arp;
        const macByIp = {};
        const conflicts = [];
        for (const entry of arp.data || []) {
          if (!entry.address) continue;
          const prevMac = macByIp[entry.address];
          if (prevMac && prevMac !== entry['mac-address']) {
            conflicts.push({ address: entry.address, macs: [prevMac, entry['mac-address']] });
          }
          macByIp[entry.address] = entry['mac-address'];
        }
        return {
          success: true,
          conflicts,
          healthy: conflicts.length === 0,
          plain_english: conflicts.length === 0
            ? 'No IP address conflicts found.'
            : `${conflicts.length} address(es) claimed by more than one device.`,
        };
      }

      case 'mikrotik.dhcp.pool_status': {
        const pools = await proxyCall(base, orgId, '/ip/pool', 'GET');
        if (!pools.success) return pools;
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        if (!leases.success) return leases;
        const leaseAddrs = new Set((leases.data || []).map((l) => l.address).filter(Boolean));
        const formatted = (pools.data || []).map((pool) => ({
          id: pool['.id'],
          name: pool.name,
          ranges: pool.ranges,
          used: [...leaseAddrs].filter((ip) => ipInRanges(ip, pool.ranges)).length,
        }));
        return {
          success: true,
          pools: formatted,
          total_used: formatted.reduce((sum, p) => sum + p.used, 0),
          total_avail: formatted.length,
        };
      }

      case 'mikrotik.dhcp.find_free_ip': {
        const count = Math.min(Math.max(parseInt(input.count, 10) || 1, 1), 20);
        const pools = await proxyCall(base, orgId, '/ip/pool', 'GET');
        if (!pools.success) return pools;
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        if (!leases.success) return leases;
        const arp = await proxyCall(base, orgId, '/ip/arp', 'GET');
        // ARP is best-effort: a router with ARP unavailable still has lease
        // data to check against, so don't fail the whole lookup over it —
        // just don't claim the ARP cross-check ran.
        const used = new Set((leases.data || []).map((l) => l.address).filter(Boolean));
        if (arp.success) {
          for (const entry of arp.data || []) {
            if (entry.address) used.add(entry.address);
          }
        }

        let candidatePools = pools.data || [];
        if (input.pool) {
          candidatePools = candidatePools.filter((p) => p.name === input.pool);
          if (candidatePools.length === 0) {
            return { success: false, error: 'pool_not_found', detail: `No DHCP pool named "${input.pool}"`, status: 404 };
          }
        }

        const freeIps = [];
        const MAX_SCANNED = 8192;
        let scanned = 0;
        for (const pool of candidatePools) {
          for (const range of String(pool.ranges || '').split(',')) {
            const [startStr, endStr] = range.split('-').map((s) => s.trim());
            if (!startStr) continue;
            const startNum = ipToNumber(startStr);
            const endNum = endStr ? ipToNumber(endStr) : startNum;
            for (let n = startNum; n <= endNum && scanned < MAX_SCANNED; n++, scanned++) {
              const ip = numberToIp(n);
              if (!used.has(ip)) freeIps.push({ address: ip, pool: pool.name });
              if (freeIps.length >= count) break;
            }
            if (freeIps.length >= count) break;
          }
          if (freeIps.length >= count) break;
        }

        return {
          success: true,
          free_ips: freeIps,
          pool_searched: input.pool || 'all',
          pools_scanned: candidatePools.length,
          arp_checked: arp.success,
          note: scanned >= MAX_SCANNED && freeIps.length < count
            ? `Scanned ${MAX_SCANNED} addresses (pool range cap) without finding ${count} free — pool may be exhausted or ranges are larger than the scan cap.`
            : undefined,
        };
      }

      case 'mikrotik.firewall.block_ip': {
        if (!input.ip) return { success: false, error: 'ip is required', status: 400 };
        const result = await proxyCall(base, orgId, '/ip/firewall/address-list', 'POST', {
          list: 'blocked-devices',
          address: input.ip,
          comment: input.reason || 'Blocked by NETWATCH',
        });
        if (!result.success) return result;
        return { success: true, blocked: true, entry: result.data };
      }

      case 'mikrotik.vpn.wireguard_peers': {
        const peers = await proxyCall(base, orgId, '/interface/wireguard/peers', 'GET');
        if (!peers.success) return peers;
        return { success: true, peers: peers.data || [], total: (peers.data || []).length };
      }

      case 'mikrotik.vpn.health': {
        const wg = await proxyCall(base, orgId, '/interface/wireguard/peers', 'GET');
        const ipsec = await proxyCall(base, orgId, '/ip/ipsec/active-peers', 'GET');
        if (!wg.success && !ipsec.success) return wg;
        const wgPeers = wg.success ? wg.data || [] : [];
        const ipsecPeers = ipsec.success ? ipsec.data || [] : [];
        const connected = wgPeers.filter((p) => p['last-handshake']).length + ipsecPeers.length;
        const total = wgPeers.length + ipsecPeers.length;
        return {
          success: true,
          health: { wireguard: wgPeers, ipsec: ipsecPeers },
          score: total === 0 ? null : Math.round((connected / total) * 100),
          issues: [
            ...(wg.success ? [] : [`wireguard peers unavailable: ${wg.error}`]),
            ...(ipsec.success ? [] : [`ipsec peers unavailable: ${ipsec.error}`]),
          ],
        };
      }

      default:
        return { success: false, error: `Unknown mikrotik tool: ${toolId}`, status: 400 };
    }
  },
};

// Mirrors the pool-usage helpers already in src/services/routerosClient.js
// (calculatePoolSize/isIpInPool) — same range-string format ("a.b.c.d-a.b.c.e,...").
function ipInRanges(ip, ranges) {
  if (!ranges) return false;
  const ipNum = ipToNumber(ip);
  return String(ranges)
    .split(',')
    .some((range) => {
      const [start, end] = range.split('-').map((s) => s.trim());
      if (!start) return false;
      const startNum = ipToNumber(start);
      const endNum = end ? ipToNumber(end) : startNum;
      return ipNum >= startNum && ipNum <= endNum;
    });
}

function ipToNumber(ip) {
  return String(ip)
    .split('.')
    .reduce((acc, octet) => (acc << 8) + (parseInt(octet, 10) || 0), 0) >>> 0;
}

function numberToIp(num) {
  return [24, 16, 8, 0].map((shift) => (num >>> shift) & 0xff).join('.');
}

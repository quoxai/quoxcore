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
  _internals: { parseRosDuration, summarizeWgPeer, rangesSize },

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
        const res = firstRow(resource.data);
        const sensors = health.success && Array.isArray(health.data) ? health.data : [];
        const scored = computeHealthScore(res, sensors);
        const tempItem = sensors.find((h) => h.name === 'temperature' || h.name === 'cpu-temperature');
        const totalMem = Number(res['total-memory']) || 0;
        const freeMem = Number(res['free-memory']) || 0;
        const issues = [];
        if (!health.success) issues.push(`sensor data unavailable: ${health.error}`);
        else if (!tempItem) issues.push('this router reports no temperature sensor (virtual CHR and some models have none): temperature is unknown, not 0');
        return {
          success: true,
          // One flat, labelled read of the four things people ask for. Unknown stays null, never 0.
          summary: {
            cpu_load_pct: res['cpu-load'] !== undefined ? Number(res['cpu-load']) : null,
            cpu_count: Number(res['cpu-count']) || null,
            memory_total_bytes: totalMem || null,
            memory_free_bytes: totalMem ? freeMem : null,
            memory_used_pct: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null,
            temperature_c: tempItem && tempItem.value !== undefined ? Number(tempItem.value) : null,
            uptime: res.uptime ?? null,
            uptime_s: parseRosDuration(res.uptime),
            version: res.version ?? null,
            board_name: res['board-name'] ?? null,
            architecture: res['architecture-name'] ?? null,
          },
          health: { resource: resource.data, sensors: health.success ? health.data : null },
          score: scored.score,
          issues,
        };
      }

      case 'mikrotik.discovery.inventory': {
        // The configured router as it describes itself (/system/resource: platform, board,
        // version; never a placeholder), any MikroTik neighbours it sees, and the devices it
        // knows about (ARP, named by DHCP lease). Its /system/identity name is not on the
        // read allowlist, so it is not claimed.
        const resource = await proxyCall(base, orgId, '/system/resource', 'GET');
        if (!resource.success) return resource;
        const arp = await proxyCall(base, orgId, '/ip/arp', 'GET');
        if (!arp.success) return arp;
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        const neigh = await proxyCall(base, orgId, '/ip/neighbor', 'GET');
        const res = firstRow(resource.data);
        const routers = [{
          role: 'configured',
          platform: res.platform ?? null,
          board_name: res['board-name'] ?? null,
          version: res.version ?? null,
          architecture: res['architecture-name'] ?? null,
          uptime: res.uptime ?? null,
        }];
        for (const n of neigh.success && Array.isArray(neigh.data) ? neigh.data : []) {
          if (!/mikrotik/i.test(String(n.platform || ''))) continue;
          routers.push({ identity: n.identity ?? null, role: 'neighbor', address: n.address ?? null, mac: n['mac-address'] ?? null, interface: n.interface ?? null, version: n.version ?? null, board_name: n.board ?? null });
        }
        const leaseRows = leases.success && Array.isArray(leases.data) ? leases.data : [];
        const leaseByMac = new Map(leaseRows.filter((l) => l['mac-address']).map((l) => [String(l['mac-address']).toUpperCase(), l]));
        const seen = new Set();
        const devices = [];
        for (const e of Array.isArray(arp.data) ? arp.data : []) {
          if (!e.address || !e['mac-address']) continue;
          const lease = leaseByMac.get(String(e['mac-address']).toUpperCase());
          seen.add(e.address);
          devices.push({
            address: e.address,
            mac: e['mac-address'],
            interface: e.interface ?? null,
            host_name: lease?.['host-name'] ?? null,
            dhcp_status: lease?.status ?? null,
            seen_in_arp: true,
          });
        }
        for (const l of leaseRows) {
          if (l.status !== 'bound' || !l.address || seen.has(l.address)) continue;
          devices.push({ address: l.address, mac: l['mac-address'] ?? null, interface: null, host_name: l['host-name'] ?? null, dhcp_status: l.status, seen_in_arp: false });
        }
        return {
          success: true,
          routers,
          router_count: routers.length,
          devices: input.include_devices === false ? [] : devices,
          total: devices.length,
          sources: { resource: true, arp: true, dhcp_leases: leases.success, neighbors: neigh.success },
        };
      }

      case 'mikrotik.dhcp.leases': {
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        if (!leases.success) return leases;
        const rows = Array.isArray(leases.data) ? leases.data : [];
        const byStatus = {};
        for (const l of rows) byStatus[l.status || 'unknown'] = (byStatus[l.status || 'unknown'] || 0) + 1;
        return { success: true, leases: rows, total: rows.length, bound: byStatus.bound || 0, by_status: byStatus };
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
        // RouterOS REST has no duplicate-address-detection endpoint, so this is the
        // router's own view: one address claimed by more than one MAC across its ARP
        // table and its DHCP lease table (static or dynamic). The limit is returned too.
        const arp = await proxyCall(base, orgId, '/ip/arp', 'GET');
        if (!arp.success) return arp;
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        const byIp = new Map();
        const claim = (ip, mac, source) => {
          if (!ip || !mac) return;
          const m = String(mac).toUpperCase();
          if (!byIp.has(ip)) byIp.set(ip, new Map());
          const macs = byIp.get(ip);
          if (!macs.has(m)) macs.set(m, new Set());
          macs.get(m).add(source);
        };
        const arpRows = Array.isArray(arp.data) ? arp.data : [];
        for (const e of arpRows) {
          if (isTrue(e.invalid)) continue;
          claim(e.address, e['mac-address'], 'arp');
        }
        const leaseRows = leases.success && Array.isArray(leases.data) ? leases.data : [];
        for (const l of leaseRows) {
          if (isTrue(l.disabled)) continue;
          claim(l.address, l['mac-address'], isTrue(l.dynamic) ? 'dhcp_dynamic_lease' : 'dhcp_static_lease');
        }
        const conflicts = [];
        for (const [address, macs] of byIp) {
          if (macs.size < 2) continue;
          conflicts.push({ address, macs: [...macs.keys()], claims: [...macs].map(([mac, src]) => ({ mac, seen_in: [...src] })) });
        }
        return {
          success: true,
          conflicts,
          healthy: conflicts.length === 0,
          checked: { arp_entries: arpRows.length, dhcp_leases: leaseRows.length, lease_cross_check: leases.success },
          plain_english: conflicts.length === 0
            ? `No IP address conflicts found in the router's ARP table (${arpRows.length} entries)${leases.success ? ` or DHCP leases (${leaseRows.length})` : ' (DHCP leases could not be read, so only ARP was checked)'}.`
            : `${conflicts.length} address(es) claimed by more than one device.`,
          limits: 'RouterOS REST exposes no duplicate-address detection: this compares the router\'s ARP and DHCP lease tables, so two devices that never both appear there can be missed.',
          ...(leases.success ? {} : { issues: [`dhcp leases unavailable: ${leases.error}`] }),
        };
      }

      case 'mikrotik.dhcp.pool_status': {
        const pools = await proxyCall(base, orgId, '/ip/pool', 'GET');
        if (!pools.success) return pools;
        const leases = await proxyCall(base, orgId, '/ip/dhcp-server/lease', 'GET');
        if (!leases.success) return leases;
        const leaseRows = Array.isArray(leases.data) ? leases.data : [];
        const formatted = (Array.isArray(pools.data) ? pools.data : []).map((pool) => {
          const inPool = leaseRows.filter((l) => l.address && ipInRanges(l.address, pool.ranges));
          const size = rangesSize(pool.ranges);
          const used = new Set(inPool.map((l) => l.address)).size;
          return {
            id: pool['.id'],
            name: pool.name,
            ranges: pool.ranges,
            size,
            used,
            bound: inPool.filter((l) => l.status === 'bound').length,
            free: Math.max(size - used, 0),
            used_pct: size ? Math.round((used / size) * 1000) / 10 : null,
            next_pool: pool['next-pool'] || null,
          };
        });
        const totalSize = formatted.reduce((sum, p) => sum + p.size, 0);
        const totalUsed = formatted.reduce((sum, p) => sum + p.used, 0);
        return {
          success: true,
          pools: formatted,
          pool_count: formatted.length,
          total_size: totalSize,
          total_used: totalUsed,
          // Free addresses across all pools (this used to be the pool COUNT, which was wrong).
          total_avail: Math.max(totalSize - totalUsed, 0),
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
        // Never hand raw rows on: RouterOS returns private-key / preshared-key here.
        const list = (Array.isArray(peers.data) ? peers.data : []).map(summarizeWgPeer);
        return {
          success: true,
          peers: list,
          total: list.length,
          connected: list.filter((p) => p.connected).length,
          connected_rule: WG_CONNECTED_RULE,
        };
      }

      case 'mikrotik.vpn.health': {
        const wg = await proxyCall(base, orgId, '/interface/wireguard/peers', 'GET');
        const ipsec = await proxyCall(base, orgId, '/ip/ipsec/active-peers', 'GET');
        if (!wg.success && !ipsec.success) return wg;
        const wgPeers = (wg.success && Array.isArray(wg.data) ? wg.data : []).map(summarizeWgPeer);
        const ipsecPeers = (ipsec.success && Array.isArray(ipsec.data) ? ipsec.data : []).map((p) => ({
          id: p['.id'] ?? null,
          remote_address: p['remote-address'] ?? null,
          local_address: p['local-address'] ?? null,
          state: p.state ?? null,
          uptime: p.uptime ?? null,
          established: p.state === 'established',
        }));
        const up = wgPeers.filter((p) => p.connected).length + ipsecPeers.filter((p) => p.established).length;
        const total = wgPeers.length + ipsecPeers.length;
        const issues = [
          ...(wg.success ? [] : [`wireguard peers unavailable: ${wg.error}`]),
          ...(ipsec.success ? [] : [`ipsec peers unavailable: ${ipsec.error}`]),
          ...wgPeers.filter((p) => !p.disabled && !p.connected).map((p) => `wireguard peer ${p.name || p.public_key || p.id} has no handshake in the last 3 minutes`),
        ];
        return {
          success: true,
          health: { wireguard: wgPeers, ipsec: ipsecPeers },
          tunnels_total: total,
          tunnels_up: up,
          score: total === 0 ? null : Math.round((up / total) * 100),
          issues,
          connected_rule: WG_CONNECTED_RULE,
          plain_english: total === 0
            ? 'No VPN tunnels are configured: 0 WireGuard peers and 0 active IPsec peers.'
            : `${up} of ${total} VPN tunnel(s) up.`,
        };
      }

      default:
        return { success: false, error: `Unknown mikrotik tool: ${toolId}`, status: 400 };
    }
  },
};

const WG_CONNECTED_RULE = 'a WireGuard peer counts as connected when it is enabled and its last handshake is at most 180 s old (WireGuard re-handshakes every 2 minutes on an active session)';

function isTrue(v) {
  return v === true || v === 'true';
}

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || {};
  return data && typeof data === 'object' ? data : {};
}

/** RouterOS duration ("3w2d4h5m6s", "1m23s", "00:01:02") to seconds; null when absent/unparseable. */
function parseRosDuration(v) {
  if (v === undefined || v === null || v === '') return null;
  const str = String(v).trim();
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(str);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const unit = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
  const re = /(\d+(?:\.\d+)?)(ms|w|d|h|m|s)/g;
  let total = 0;
  let consumed = '';
  let match;
  while ((match = re.exec(str)) !== null) {
    total += Number(match[1]) * unit[match[2]];
    consumed += match[0];
  }
  if (!consumed || consumed !== str) return null;
  return Math.floor(total);
}

/** A WireGuard peer row with its secrets dropped (private-key / preshared-key never leave). */
function summarizeWgPeer(p) {
  const hs = parseRosDuration(p['last-handshake']);
  const disabled = isTrue(p.disabled);
  const ep = p['current-endpoint-address'] || p['endpoint-address'] || null;
  const port = p['current-endpoint-port'] || p['endpoint-port'] || null;
  return {
    id: p['.id'] ?? null,
    name: p.name || p.comment || null,
    interface: p.interface ?? null,
    endpoint: ep ? (port ? `${ep}:${port}` : ep) : null,
    allowed_address: p['allowed-address'] ?? null,
    public_key: p['public-key'] ?? null,
    disabled,
    last_handshake: p['last-handshake'] ?? null,
    last_handshake_s: hs,
    connected: !disabled && hs !== null && hs <= 180,
    rx_bytes: Number(p.rx) || 0,
    tx_bytes: Number(p.tx) || 0,
  };
}

/** Number of addresses in a RouterOS range string ("a-b,c,d-e"). */
function rangesSize(ranges) {
  if (!ranges) return 0;
  return String(ranges).split(',').reduce((sum, range) => {
    const [start, end] = range.split('-').map((x) => x.trim());
    if (!start) return sum;
    const a = ipToNumber(start);
    const b = end ? ipToNumber(end) : a;
    return sum + (b >= a ? b - a + 1 : 0);
  }, 0);
}

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

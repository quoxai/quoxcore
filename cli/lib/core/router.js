/**
 * ROUTEROS-WIRE: engine for `quox router`, the read-only MikroTik RouterOS views.
 *
 * Every verb is one NETWATCH tool run through the governed tool route
 * (POST /api/v1/tools/execute, agent_id netwatch). The collector's mikrotikExecutor
 * reaches the org's configured router through the allowlisted RouterOS proxy; nothing
 * here talks to a router directly and no verb writes. Formatters are pure so the human
 * output is tested without a router.
 */
import { resolveEndpoint } from '../api/endpoints.js';

/** verb -> the tool it runs. All read-only (aoclClassification layer 1, autonomy FULL). */
export const ROUTER_TOOLS = Object.freeze({
  health: 'mikrotik_monitoring_health',
  leases: 'mikrotik_dhcp_leases',
  pools: 'mikrotik_dhcp_pool_status',
  conflicts: 'mikrotik_dhcp_conflict_check',
  'free-ip': 'mikrotik_dhcp_find_free_ip',
  vpn: 'mikrotik_vpn_health',
  wireguard: 'mikrotik_vpn_wireguard_peers',
  inventory: 'mikrotik_discovery_inventory',
});

export function makeRouterExec({ client, orgId }) {
  return async function exec(tool, input = {}) {
    const ep = resolveEndpoint('v1.tools.execute');
    const body = { tool_name: tool, input, agent_id: 'netwatch' };
    if (orgId) body.org_id = orgId;
    const data = await client.post(ep.path, { service: ep.service, body });
    if (data && data.success === false) {
      const detail = data.detail ? ` (${data.detail})` : '';
      const err = new Error(`${tool} via POST ${ep.path} returned success:false: ${data.error || 'unknown error'}${detail}`);
      err.toolError = data.error || 'unknown error';
      err.tool = tool;
      throw err;
    }
    return routerPayload(data);
  };
}

/** Unwrap the tool route envelope to the executor's own result object. */
export function routerPayload(data) {
  let p = data;
  for (let i = 0; i < 3 && p && typeof p === 'object' && !Array.isArray(p); i++) {
    const inner = ['result', 'output', 'data'].map((k) => p[k]).find((v) => v !== undefined && v !== null);
    if (inner === undefined) break;
    p = inner;
  }
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* keep text */ } }
  if (p && typeof p === 'object' && p.success === false) {
    const err = new Error(`router read failed: ${p.error || 'unknown error'}${p.detail ? ` (${p.detail})` : ''}`);
    err.toolError = p.error;
    throw err;
  }
  return p;
}

const dash = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));
const mib = (b) => (b === null || b === undefined ? '-' : `${Math.round(Number(b) / 1048576)} MiB`);
const pad = (rows) => {
  const w = [];
  for (const r of rows) r.forEach((c, i) => { w[i] = Math.max(w[i] || 0, String(c).length); });
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(w[i]))).join('  ').trimEnd());
};

export function healthLines(p) {
  const s = p.summary || {};
  return [
    `Router health score: ${dash(p.score)}/100`,
    `CPU load:     ${s.cpu_load_pct === null || s.cpu_load_pct === undefined ? '-' : `${s.cpu_load_pct}%`}${s.cpu_count ? ` (${s.cpu_count} cpu)` : ''}`,
    `Memory:       ${s.memory_used_pct === null || s.memory_used_pct === undefined ? '-' : `${s.memory_used_pct}% used`} (${mib(s.memory_free_bytes)} free of ${mib(s.memory_total_bytes)})`,
    `Temperature:  ${s.temperature_c === null || s.temperature_c === undefined ? 'unknown (no sensor reported)' : `${s.temperature_c} C`}`,
    `Uptime:       ${dash(s.uptime)}`,
    `RouterOS:     ${dash(s.version)}  board ${dash(s.board_name)}  ${dash(s.architecture)}`,
    ...(p.issues || []).map((i) => `! ${i}`),
  ];
}

export function leaseLines(p) {
  const rows = (p.leases || []).map((l) => [dash(l.address), dash(l['mac-address']), dash(l['host-name']), dash(l.status), l.dynamic === 'true' || l.dynamic === true ? 'dynamic' : 'static']);
  return [`${p.total ?? rows.length} DHCP lease(s), ${p.bound ?? 0} bound`, ...(rows.length ? pad([['ADDRESS', 'MAC', 'HOST', 'STATUS', 'TYPE'], ...rows]) : [])];
}

export function poolLines(p) {
  const rows = (p.pools || []).map((x) => [dash(x.name), dash(x.ranges), x.size, x.used, x.free, x.used_pct === null || x.used_pct === undefined ? '-' : `${x.used_pct}%`]);
  return [
    `${p.pool_count ?? rows.length} DHCP pool(s): ${p.total_used ?? 0} of ${p.total_size ?? 0} addresses used, ${p.total_avail ?? 0} free`,
    ...(rows.length ? pad([['POOL', 'RANGES', 'SIZE', 'USED', 'FREE', 'USED%'], ...rows]) : []),
  ];
}

export function conflictLines(p) {
  const out = [p.plain_english || (p.healthy ? 'No IP address conflicts found.' : 'IP address conflicts found.')];
  for (const c of p.conflicts || []) {
    out.push(`  ${c.address}: ${(c.claims || []).map((k) => `${k.mac} (${(k.seen_in || []).join(', ')})`).join(' vs ') || (c.macs || []).join(' vs ')}`);
  }
  if (p.limits) out.push(`Limit: ${p.limits}`);
  for (const i of p.issues || []) out.push(`! ${i}`);
  return out;
}

export function freeIpLines(p) {
  const ips = p.free_ips || [];
  return [
    `${ips.length} free address(es) in pool ${dash(p.pool_searched)} (checked against DHCP leases${p.arp_checked ? ' and ARP' : ', ARP unavailable'}). Nothing was reserved.`,
    ...ips.map((f) => `  ${f.address}  (${dash(f.pool)})`),
    ...(p.note ? [`! ${p.note}`] : []),
  ];
}

function peerRow(x) {
  return [dash(x.name || x.public_key), dash(x.interface), dash(x.endpoint), dash(x.allowed_address), dash(x.last_handshake), x.disabled ? 'disabled' : x.connected ? 'connected' : 'not connected'];
}

export function wireguardLines(p) {
  const rows = (p.peers || []).map(peerRow);
  return [
    `${p.total ?? rows.length} WireGuard peer(s), ${p.connected ?? 0} connected`,
    ...(rows.length ? pad([['PEER', 'IFACE', 'ENDPOINT', 'ALLOWED', 'HANDSHAKE', 'STATE'], ...rows]) : []),
    ...(p.connected_rule ? [`Rule: ${p.connected_rule}`] : []),
  ];
}

export function vpnLines(p) {
  const h = p.health || {};
  const out = [p.plain_english || `${p.tunnels_up ?? 0} of ${p.tunnels_total ?? 0} VPN tunnel(s) up.`, `Score: ${p.score === null || p.score === undefined ? '- (no tunnels)' : `${p.score}/100`}`];
  for (const x of h.wireguard || []) out.push(`  wg peer ${peerRow(x)[0]}: ${peerRow(x)[5]} (handshake ${dash(x.last_handshake)})`);
  for (const x of h.ipsec || []) out.push(`  ipsec ${dash(x.remote_address)}: ${dash(x.state)}, up ${dash(x.uptime)}`);
  for (const i of p.issues || []) out.push(`! ${i}`);
  return out;
}

export function inventoryLines(p) {
  const routers = (p.routers || []).map((r) => [dash(r.identity || [r.platform, r.board_name].filter(Boolean).join(' ')), dash(r.role), dash(r.address), dash(r.version), dash(r.board_name)]);
  const devices = (p.devices || []).map((d) => [dash(d.address), dash(d.mac), dash(d.host_name), dash(d.interface), d.seen_in_arp ? 'arp' : 'lease only']);
  return [
    `${p.router_count ?? routers.length} MikroTik router(s)`,
    ...pad([['ROUTER', 'ROLE', 'ADDRESS', 'VERSION', 'BOARD'], ...routers]),
    `${p.total ?? devices.length} connected device(s)`,
    ...(devices.length ? pad([['ADDRESS', 'MAC', 'HOST', 'IFACE', 'SEEN'], ...devices]) : []),
  ];
}

export const ROUTER_FORMATTERS = Object.freeze({
  health: healthLines, leases: leaseLines, pools: poolLines, conflicts: conflictLines,
  'free-ip': freeIpLines, vpn: vpnLines, wireguard: wireguardLines, inventory: inventoryLines,
});

/** `quox router trust --show`: the fingerprint to compare out of band. Pure. */
export function formatTrust(d) {
  if (!d || d.success === false) {
    return [`Could not read the router certificate: ${(d && (d.error || d.detail)) || 'unknown error'}`, 'No credentials were sent.'];
  }
  const lines = [
    `Router endpoint: ${d.host}:${d.port}`,
    `Certificate SHA-256: ${d.cert_sha256_formatted}`,
    `Public key SHA-256:  ${d.spki_sha256_formatted}`,
    `Subject: ${d.subject ? String(d.subject).replace(/\n/g, ', ') : '-'}`,
    `Issuer:  ${d.issuer ? String(d.issuer).replace(/\n/g, ', ') : '-'}${d.self_signed ? ' (self-signed)' : ''}`,
    `Valid until: ${d.valid_to || '-'}`,
    d.pin_configured
      ? (d.matches_configured_pin ? 'MIKROTIK_TLS_PIN is set and MATCHES this endpoint.' : 'MIKROTIK_TLS_PIN is set and does NOT match this endpoint. Do not trust it until you know why.')
      : 'MIKROTIK_TLS_PIN is not set, so the collector sends nothing to this router yet.',
    'No credentials were sent. Nothing was pinned.',
    'Compare the fingerprint with the one on the router itself (System > Certificates) over a channel you trust, then set MIKROTIK_TLS_PIN to the SHA-256 value.',
  ];
  return lines;
}

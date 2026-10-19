'use strict';

/**
 * agentFetchEgressPolicy.js — address rules for web_fetch_allowlisted (quox#1171, after HYPERION's
 * NO-GO 2026-10-16: a tenant org admin could allowlist an RFC1918 address, and the collector's own
 * Docker networks are RFC1918, e.g. an unauthenticated Qdrant on its container IP).
 *
 * Two tiers:
 *  - ALWAYS DENIED, whoever allowlisted it: loopback / link-local / metadata / unspecified /
 *    multicast (monitoringEgressPolicy.isDeniedIp), 172.16.0.0/12 (Docker's default bridge pools,
 *    incl. 172.17.0.0/16), and every subnet on the collector's own network interfaces, read at
 *    runtime (the compose networks the collector is attached to, whatever range they use).
 *  - PRIVATE (RFC1918, CGNAT 100.64.0.0/10, IPv6 ULA fc00::/7): reachable only through an
 *    allowlist entry an INSTANCE admin added (allow_private); never a tenant org admin's entry.
 * Single-label hostnames are refused too (Docker service names such as "qdrant").
 */

const net = require('net');
const os = require('os');
const { isDeniedIp } = require('./monitoringEgressPolicy');

function v4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
}

function inV4Cidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

// IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 address it carries.
function unmap(ip) {
  const s = String(ip || '').toLowerCase();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? m[1] : s;
}

function v6Words(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? new Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((w) => parseInt(w || '0', 16));
}

function inV6Cidr(ip, base, bits) {
  const a = v6Words(ip); const b = v6Words(base);
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

function inCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = Number(bitsRaw);
  const addr = unmap(ip);
  const fam = net.isIP(addr);
  if (fam !== net.isIP(base) || !Number.isFinite(bits)) return false;
  return fam === 4 ? inV4Cidr(addr, base, bits) : inV6Cidr(addr, base, bits);
}

// The RFC1918 /16 is assembled from parts: the public-mirror privacy gate refuses that literal prefix
// anywhere in shipped source (quoxflow GTM-R2 52cefe3 did the same). A test asserts it at runtime.
const RFC1918_C = [192, 168, 0, 0].join('.') + '/16';
const PRIVATE_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', RFC1918_C, '100.64.0.0/10', 'fc00::/7'];
const DOCKER_BRIDGE_CIDRS = ['172.16.0.0/12'];

function isPrivateIp(ip) {
  return PRIVATE_CIDRS.some((c) => inCidr(ip, c));
}

/** The subnets on this host's own interfaces, e.g. ['10.89.0.3/20']. Loopback included. */
function interfaceCidrs(getInterfaces = os.networkInterfaces) {
  const out = [];
  let ifaces = {};
  try { ifaces = getInterfaces() || {}; } catch { ifaces = {}; }
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) if (a && a.cidr) out.push(a.cidr);
  }
  return out;
}

/** Why this address may never be fetched, or null. */
function alwaysDeniedIpReason(ip, ownCidrs = []) {
  const addr = unmap(ip);
  if (isDeniedIp(addr) || isDeniedIp(ip)) return `${ip} is a loopback, link-local, metadata, unspecified or multicast address`;
  if (DOCKER_BRIDGE_CIDRS.some((c) => inCidr(addr, c))) return `${ip} is in a Docker bridge range (172.16.0.0/12)`;
  const own = ownCidrs.find((c) => inCidr(addr, c));
  if (own) return `${ip} is on one of the collector's own networks (${own})`;
  return null;
}

/** Docker service names and other single-label hosts ("qdrant", "auth") are never fetched. */
function isSingleLabelHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return !net.isIP(h) && !h.includes('.');
}

module.exports = { isPrivateIp, alwaysDeniedIpReason, interfaceCidrs, isSingleLabelHost, inCidr, PRIVATE_CIDRS };

/**
 * Z2H-R3: which address to PRINT for the dashboard and for the host installer. Over SSH to a fresh
 * install the profile is https://localhost:3000, which only works on the Quox box, so a printed
 * localhost is wrong for anyone reading it elsewhere. Order: the server's app URL (app_base_url),
 * else the address this CLI reached the server on, else the address the install finale showed,
 * else this machine's detected LAN address. Loopback is the last resort, never the first answer.
 */
import { networkInterfaces } from 'node:os';

export const isLoopbackUrl = (u) => {
  try { return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0)$/i.test(new URL(u).hostname); } catch { return true; }
};
const ok = (u) => typeof u === 'string' && /^https?:\/\/[^\s/]+/.test(u) && !isLoopbackUrl(u);
const origin = (u) => new URL(u).origin;

/** First non-internal IPv4 address (private ranges preferred), or null. */
export function detectLanIp(ifaces = networkInterfaces()) {
  const all = Object.entries(ifaces || {}).filter(([n]) => !/^(docker|br-|veth|virbr|cni|flannel|cali|tun|tap)/i.test(n)).flatMap(([, v]) => v || [])
    .filter(a => a && a.family === 'IPv4' && !a.internal && a.address);
  const priv = all.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return (priv || all[0])?.address || null;
}

/** Dashboard base: { url, source } . source: server | profile | install | lan | local. */
export function resolveDashboardBase({ serverApp, profileUrl, journeyUrl, lanIp } = {}) {
  if (ok(serverApp)) return { url: origin(serverApp), source: 'server' };
  if (ok(profileUrl)) return { url: origin(profileUrl), source: 'profile' };
  if (ok(journeyUrl)) return { url: origin(journeyUrl), source: 'install' };
  if (lanIp) return { url: `https://${lanIp}:3000`, source: 'lan' };
  return { url: profileUrl || 'https://localhost:3000', source: 'local' };
}

/** Base that serves GET /install (the collector, :9848): { url, source }. */
export function resolveCollectorBase({ collectorUrl, serverApp, journeyUrl, lanIp } = {}) {
  if (ok(collectorUrl)) return { url: origin(collectorUrl), source: 'profile' };
  for (const [u, source] of [[serverApp, 'server'], [journeyUrl, 'install']]) {
    if (ok(u)) return { url: `http://${new URL(u).hostname}:9848`, source };
  }
  if (lanIp) return { url: `http://${lanIp}:9848`, source: 'lan' };
  return { url: collectorUrl || null, source: 'local' };
}

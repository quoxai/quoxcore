function parseAllowedOrigins(env = process.env) {
  const raw = env.ALLOWED_ORIGINS || env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3002,http://localhost:5173,https://localhost:3002,https://localhost:3443'
  return raw
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function parseDashboardPorts(env = process.env) {
  const raw = env.COLLECTOR_DASHBOARD_PORTS || '3000,3002,3443,5173,443,80'
  return raw
    .split(',')
    .map(port => port.trim())
    .filter(Boolean)
}

function isCollectorAllowedOrigin(origin, {
  allowedOrigins = parseAllowedOrigins(),
  dashboardPorts = parseDashboardPorts(),
} = {}) {
  if (!origin) return true
  if (allowedOrigins.includes(origin)) return true

  try {
    const originUrl = new URL(origin)
    const hostname = originUrl.hostname
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    const isLAN = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/.test(hostname)
    // Tailscale MagicDNS (*.ts.net) is a private mesh: an origin is only
    // resolvable/reachable by devices on the same tailnet, so it carries the
    // same trust as a LAN host. Without this, dashboards accessed over Tailscale
    // (e.g. maestro.tail9baf78.ts.net) get their plugin-gateway calls CORS-blocked.
    const isTailnet = /\.ts\.net$/i.test(hostname)
    const effectivePort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80')
    return dashboardPorts.includes(effectivePort) && (isLocal || isLAN || isTailnet)
  } catch {
    return false
  }
}

module.exports = {
  isCollectorAllowedOrigin,
  parseAllowedOrigins,
  parseDashboardPorts,
}

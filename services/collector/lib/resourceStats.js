/**
 * resourceStats.js — Qluster Phase 2 box-side patch
 *
 * Dependency-free (Node built-ins only) machine resource sampler used by
 * GET /api/v1/health/resources. Consumed by Qluster (external fleet
 * controller) to poll per-box CPU/memory/disk utilisation.
 *
 * Also hosts the opt-in read-token middleware shared by the resources and
 * aggregate health routes (see server.js). The middleware is a no-op unless
 * QUOXCORE_READ_TOKEN is set in the environment — zero behaviour change for
 * existing consumers when unset.
 */

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ─── CPU ────────────────────────────────────────────────────────────────

function readProcStatTotals() {
  const raw = fs.readFileSync('/proc/stat', 'utf8');
  const line = raw.split('\n')[0]; // first line: aggregate "cpu  ..." across all cores
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== 'cpu') return null;
  const fields = parts.slice(1).map(Number); // user nice system idle iowait irq softirq steal guest guest_nice
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  const idleAll = idle + iowait;
  const busy = user + nice + system + irq + softirq + steal;
  const total = busy + idleAll;
  return { busy, total };
}

async function sampleCpuPercent() {
  const first = readProcStatTotals();
  if (!first) throw new Error('no /proc/stat');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = readProcStatTotals();
  const busyDelta = second.busy - first.busy;
  const totalDelta = second.total - first.total;
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
}

async function getCpuStats() {
  const cores = os.cpus().length || 1;
  const load1 = os.loadavg()[0];
  let percent;
  try {
    percent = await sampleCpuPercent();
  } catch {
    // /proc unavailable (e.g. non-Linux) — fall back to load average heuristic
    percent = Math.min(100, Math.max(0, (load1 / cores) * 100));
  }
  return {
    percent: round1(percent),
    cores,
    load1: round1(load1),
  };
}

// ─── Memory ─────────────────────────────────────────────────────────────

function readMeminfoAvailable() {
  const raw = fs.readFileSync('/proc/meminfo', 'utf8');
  let totalKb = null;
  let availKb = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('MemTotal:')) {
      totalKb = parseInt(line.match(/\d+/)[0], 10);
    } else if (line.startsWith('MemAvailable:')) {
      availKb = parseInt(line.match(/\d+/)[0], 10);
    }
    if (totalKb !== null && availKb !== null) break;
  }
  if (totalKb === null || availKb === null) return null;
  return { totalBytes: totalKb * 1024, availableBytes: availKb * 1024 };
}

function getMemoryStats() {
  let totalBytes = os.totalmem();
  let usedBytes;

  // Prefer /proc/meminfo's MemAvailable — os.freemem() undercounts on Linux
  // because it doesn't account for reclaimable page cache/buffers.
  try {
    const meminfo = readMeminfoAvailable();
    if (meminfo) {
      totalBytes = meminfo.totalBytes;
      usedBytes = meminfo.totalBytes - meminfo.availableBytes;
    }
  } catch {
    // fall through to os.* below
  }

  if (usedBytes === undefined) {
    usedBytes = os.totalmem() - os.freemem();
  }

  const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return {
    percent: round1(Math.min(100, Math.max(0, percent))),
    total_bytes: totalBytes,
    used_bytes: Math.max(0, usedBytes),
  };
}

// ─── Disk ───────────────────────────────────────────────────────────────

async function getDiskStats() {
  const mount = '/';
  try {
    const stats = await fs.promises.statfs(mount);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const percent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return {
      percent: round1(Math.min(100, Math.max(0, percent))),
      total_bytes: totalBytes,
      used_bytes: usedBytes,
      mount,
    };
  } catch {
    return {
      percent: 0,
      total_bytes: 0,
      used_bytes: 0,
      mount,
    };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

async function getResourceStats() {
  const [cpu, disk] = await Promise.all([getCpuStats(), getDiskStats()]);
  const memory = getMemoryStats();
  return {
    cpu,
    memory,
    disk,
    ts: new Date().toISOString(),
  };
}

// ─── Opt-in read token middleware ──────────────────────────────────────
//
// STRICTLY OPT-IN: when QUOXCORE_READ_TOKEN is unset (default everywhere
// today) this middleware is a no-op — zero behaviour change for existing
// consumers. When set, requests must carry `Authorization: Bearer <token>`
// matching it (timing-safe compare) or receive a 401.

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against a same-length dummy so the branch above doesn't
    // introduce an obvious short-circuit timing signal.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireReadToken(req, res, next) {
  const configuredToken = process.env.QUOXCORE_READ_TOKEN;
  if (!configuredToken) {
    // Opt-in feature disabled — behave exactly as before.
    return next();
  }

  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  const match = typeof authHeader === 'string' && authHeader.match(/^Bearer\s+(.+)$/);
  const provided = match ? match[1].trim() : '';

  if (!provided || !timingSafeEqualStrings(provided, configuredToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

module.exports = {
  getResourceStats,
  requireReadToken,
  // exported for unit testing / reuse
  getCpuStats,
  getMemoryStats,
  getDiskStats,
};

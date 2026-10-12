'use strict';
/**
 * INCIDENT-700: event loop watchdog. Names the blocking route in the collector's
 * own log. Tracks in-flight requests (method + route pattern only, never query
 * strings or bodies), measures tick drift, logs a one-line culprit list.
 */
const { monitorEventLoopDelay } = require('perf_hooks');
const crypto = require('crypto');

const MAX_INFLIGHT = 2000;
const MAX_TALLY = 200;
const MAX_RECENT = 500;
const RECENT_KEEP_MS = 70000;

// Routes that intentionally hold the connection open (long-poll / SSE / stream).
// They are in flight during every stall BY DESIGN, so they are never suspects:
// they are only counted as "waiting (long-poll): N". Substring match on the route.
// Extend this list when adding a route that parks a request. Responses with
// Content-Type text/event-stream are also treated as long-lived automatically.
// Env EVENTLOOP_LONGPOLL_PATHS (comma list) ADDS to this list.
const LONG_POLL_PATHS = [
  '/slots/:name/wait', // GET /api/v1/slots/:name/wait (quox slot wait)
  '/leases/dial-queue', // GET /api/v1/contactsq/leases/dial-queue
  '/wait', '/stream', '/events', '/sse', '/subscribe', '/listen',
];

function normalizePath(p) {
  return String(p || '/')
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
    .replace(/\/[0-9A-HJKMNP-TV-Z]{26}(?=\/|$)/g, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/:id');
}

function routeOf(req) {
  const pattern = req.route && req.route.path;
  if (pattern && typeof pattern === 'string') return `${req.baseUrl || ''}${pattern}`;
  return normalizePath(`${req.baseUrl || ''}${req.path || req.url || '/'}`);
}

function create(opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || ((m) => console.warn(m));
  const now = opts.now || (() => Date.now());
  const enabled = env.EVENTLOOP_WATCHDOG !== '0';
  const warnMs = Number(env.EVENTLOOP_BLOCK_WARN_MS) || 1000;
  const slowMs = Number(env.SLOWROUTE_WARN_MS) || 2000;
  const tickMs = opts.tickMs || 1000;
  const summaryMs = opts.summaryMs || 60000;
  const longPoll = LONG_POLL_PATHS.concat(
    String(env.EVENTLOOP_LONGPOLL_PATHS || '').split(',').map((x) => x.trim()).filter(Boolean));
  const recent = []; // finished requests {route, start, end}, to attribute blocks to them

  const inflight = new Map(); // id -> {method, route, org, start, req}
  const tally = new Map(); // route -> {blocks, maxMs, lastAt}
  const slowSeen = new Map(); // route -> {at, suppressed}
  let seq = 0;
  let win = { blocks: 0, maxMs: 0, routes: new Map() };
  let timer = null;
  let hist = null;
  let lastTick = now();
  let totalBlocks = 0;

  function currentRoute(e) {
    // Route pattern is only known once Express matched; resolve lazily.
    return e.req ? routeOf(e.req) : e.route;
  }

  function middleware(req, res, next) {
    if (!enabled) return next();
    if (inflight.size >= MAX_INFLIGHT) return next();
    const id = ++seq;
    const entry = { method: req.method, start: now(), req, res, org: null };
    inflight.set(id, entry);
    let done = false;
    const end = (kind) => {
      if (done) return;
      done = true;
      inflight.delete(id);
      const endAt = now();
      if (!isLongLived(entry, res)) {
        recent.push({ route: `${entry.method} ${routeOf(req)}`, start: entry.start, end: endAt });
        if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
      }
      if (kind !== 'finish') return;
      const ms = endAt - entry.start;
      if (ms > slowMs && !isLongLived(entry, res)) slowRoute(entry.method, routeOf(req), ms, res.statusCode);
    };
    res.on('finish', () => end('finish'));
    res.on('close', () => end('close'));
    next();
  }

  function slowRoute(method, route, ms, status) {
    const key = `${method} ${route}`;
    const t = now();
    const s = slowSeen.get(key);
    if (s && t - s.at < 60000) { s.suppressed++; return; }
    const sup = s ? s.suppressed : 0;
    if (!s && slowSeen.size >= MAX_TALLY) slowSeen.clear();
    slowSeen.set(key, { at: t, suppressed: 0 });
    log(`[SlowRoute] ${method} ${route} ${ms}ms status=${status}` + (sup ? ` (+${sup} suppressed)` : ''));
  }

  function isLongLived(e, res) {
    const route = currentRoute(e);
    if (longPoll.some((p) => route.includes(p))) return true;
    const r = res || e.res;
    const ct = r && typeof r.getHeader === 'function' ? r.getHeader('content-type') : null;
    return !!ct && String(ct).includes('text/event-stream');
  }

  // In-flight, non-long-poll requests (nearest the block start first) plus a count
  // of parked long-poll/SSE requests, which are never suspects.
  function topInflight(n = 5, blockStart = null) {
    const t = now();
    const bs = blockStart == null ? t : blockStart;
    const all = [...inflight.values()].map((e) => ({ e, long: isLongLived(e), start: e.start }));
    const waiting = all.filter((x) => x.long).length;
    const rest = all.filter((x) => !x.long).sort((a, b) => {
      const ab = a.start <= bs, bb = b.start <= bs;
      if (ab !== bb) return ab ? -1 : 1;
      return Math.abs(bs - a.start) - Math.abs(bs - b.start);
    });
    return {
      waiting,
      list: rest.slice(0, n).map((x) => ({ route: `${x.e.method} ${currentRoute(x.e)}`, age: t - x.start })),
    };
  }

  // Suspects: non-long-poll requests that STARTED or FINISHED during the block
  // window. The watchdog cannot see which request held the thread (no per-request
  // on-thread timing), so this is a heuristic, labelled as such in the log.
  function suspectsFor(blockStart) {
    const t = now();
    while (recent.length && t - recent[0].end > RECENT_KEEP_MS) recent.shift();
    const seen = new Map();
    const add = (route, at) => { const v = seen.get(route); if (!v || at < v) seen.set(route, at); };
    for (const e of inflight.values()) if (e.start >= blockStart && !isLongLived(e)) add(`${e.method} ${currentRoute(e)}`, e.start);
    for (const r of recent) if (r.start >= blockStart || r.end >= blockStart) add(r.route, Math.max(r.start, blockStart));
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([route]) => route);
  }

  function bump(map, route, ms, cap) {
    let r = map.get(route);
    if (!r) {
      if (map.size >= cap) return;
      r = { blocks: 0, maxMs: 0 };
      map.set(route, r);
    }
    r.blocks++;
    if (ms > r.maxMs) r.maxMs = ms;
    r.lastAt = now();
  }

  function onBlock(ms) {
    const blockStart = now() - ms;
    const top = topInflight(5, blockStart);
    const suspects = suspectsFor(blockStart);
    totalBlocks++;
    win.blocks++;
    if (ms > win.maxMs) win.maxMs = ms;
    for (const r of suspects.slice(0, 3)) { bump(tally, r, ms, MAX_TALLY); bump(win.routes, r, ms, MAX_TALLY); }
    log(`[LoopWatchdog] event loop blocked ~${ms}ms; in flight: ` +
      (top.list.length ? top.list.map((t) => `${t.route} (${t.age}ms)`).join(', ') : 'none') +
      `; waiting (long-poll): ${top.waiting}; ` +
      (suspects.length
        ? `suspects (requests that started/finished during the block, not proof): ${suspects.slice(0, 5).join(', ')}`
        : 'suspects: no request started during the block (likely a timer/background job or a request already in flight)'));
  }

  function tick() {
    const t = now();
    const drift = t - lastTick - tickMs;
    lastTick = t;
    if (drift > warnMs) onBlock(drift);
  }

  function summary() {
    if (win.blocks > 0) {
      const p99 = hist ? Math.round(hist.percentile(99) / 1e6) : 0;
      const top = [...win.routes.entries()].sort((a, b) => b[1].blocks - a[1].blocks).slice(0, 5)
        .map(([r, v]) => `${r} x${v.blocks} max ${v.maxMs}ms`).join(', ') || 'none attributed';
      log(`[LoopWatchdog] last 60s: blocked ${win.blocks}x, max ${win.maxMs}ms, p99 lag ${p99}ms, top routes (started/finished during blocks, long-poll excluded): ${top}`);
      log('[LoopWatchdog] profile to find the cause: see reference-collector-cpu-profile-recipe');
    }
    win = { blocks: 0, maxMs: 0, routes: new Map() };
    if (hist) hist.reset();
  }

  function start() {
    if (!enabled || timer) return;
    try { hist = monitorEventLoopDelay({ resolution: 20 }); hist.enable(); } catch { hist = null; }
    lastTick = now();
    timer = setInterval(tick, tickMs);
    timer.unref();
    timer.sumTimer = setInterval(summary, summaryMs);
    timer.sumTimer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer.sumTimer); clearInterval(timer); timer = null; }
    if (hist) { try { hist.disable(); } catch { /* ignore */ } hist = null; }
  }

  function snapshot() {
    return {
      enabled,
      warn_ms: warnMs,
      total_blocks: totalBlocks,
      p99_lag_ms: hist ? Math.round(hist.percentile(99) / 1e6) : null,
      max_lag_ms: hist ? Math.round(hist.max / 1e6) : null,
      in_flight: inflight.size,
      top_in_flight: topInflight(5).list,
      waiting_long_poll: topInflight(0).waiting,
      routes: [...tally.entries()].sort((a, b) => b[1].blocks - a[1].blocks)
        .map(([route, v]) => ({ route, blocks: v.blocks, max_ms: v.maxMs, last_at: v.lastAt })),
    };
  }

  function handler(req, res) {
    const key = (env.INTERNAL_SERVICE_KEY || '');
    const given = String(req.headers['x-service-key'] || '');
    const a = Buffer.from(key), b = Buffer.from(given);
    if (!key || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(snapshot());
  }

  return { middleware, handler, start, stop, tick, summary, snapshot, enabled };
}

module.exports = { create, routeOf, normalizePath };

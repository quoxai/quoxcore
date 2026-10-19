'use strict';
/**
 * The Mirror: what CommanderQ sees about one org, built server-side from server reads only.
 *
 * Before (2026-10-16): the Mirror was built in the BROWSER (src/services/reflectionService.js and
 * mirrorIndex.js): memory counted from localStorage, health from an implant score, tools/workflows/
 * plugins from frontend-only registries. TUI and non-browser turns never saw it; they got a
 * whole-collector fleet line instead (#1125, a cross-tenant leak).
 *
 * Now: buildMirror({ orgId, deps }) asks each owning service for the caller's org. Every section is
 * either a value or { unknown: { code, service, message } }: nothing is null without a reason, and a
 * failed read is never shown as zero. The fleet heartbeat map is not org-scoped, so the Mirror carries
 * no fleet count at all. createMirrorCache keys everything by org. mirrorSummary() is the compact block
 * injected into CommanderQ's [SELF-KNOWLEDGE] on every path; GET /api/v1/mind/mirror serves the same
 * object to the TUI (/mirror) and the dashboard Mirror tab.
 *
 * deps (each async, each takes orgId first): serviceChecks(), memoryUsers(orgId), memoryStats(orgId,
 * userId), toolCounts(orgId), workflowCount(orgId), plugins(orgId), agents(orgId), implants(orgId),
 * qortex(orgId), repobrain(orgId), codebase(orgId). A missing dep is reported as NOT_WIRED.
 */

const IDENTITY = { name: 'CommanderQ', role: 'Multi-Agent Executive System', description: 'the Quox orchestrator for this org' };

/** An error -> { code, service, message }. */
function why(service, err) {
  const S = String(service).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const message = String((err && (err.body && (err.body.error || err.body.message))) || (err && err.message) || err || 'read failed').slice(0, 300) || 'read failed';
  let code;
  if (err && Number.isInteger(err.status)) code = `${S}_HTTP_${err.status}`;
  else if (err && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(message))) code = `${S}_TIMEOUT`;
  else if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(message))) code = `${S}_UNREACHABLE`;
  else if (err && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) code = err.code;
  else code = `${S}_READ_FAILED`;
  return { code, service, message };
}

async function read(deps, name, service, ...args) {
  if (typeof deps[name] !== 'function') return { unknown: { code: 'NOT_WIRED', service, message: `no ${service} reader is wired into the Mirror builder` } };
  try { return { value: await deps[name](...args) }; } catch (err) { return { unknown: why(service, err) }; }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Sum of file counts, or null when no repo reports one (unknown, not zero). */
const fileTotal = (repos) => (repos.some((t) => typeof t.file_count === 'number') ? repos.reduce((a, t) => a + num(t.file_count), 0) : null);

function healthSection(r) {
  if (r.unknown) return { unknown: r.unknown };
  const all = r.value || {};
  // A service this install does not ship (status not_installed) is neither up nor down: it is left out of
  // the count and named separately, the same rule as aggregateHealth.computeHealthScore.
  const notInstalled = Object.keys(all).filter((n) => all[n] && all[n].status === 'not_installed');
  const checks = Object.fromEntries(Object.entries(all).filter(([n]) => !notInstalled.includes(n)));
  const names = Object.keys(checks);
  if (!names.length) return { unknown: { code: 'HEALTH_NO_SERVICES', service: 'collector', message: 'the service health fan-out returned no services' } };
  const w = { ok: 1, degraded: 0.5 };
  const score = Math.round((names.reduce((a, n) => a + (w[checks[n] && checks[n].status] || 0), 0) / names.length) * 100);
  const up = names.filter((n) => checks[n] && checks[n].status === 'ok');
  return {
    score,
    status: score >= 90 ? 'healthy' : score >= 60 ? 'degraded' : 'critical',
    activeServices: up.length,
    totalServices: names.length,
    down: names.filter((n) => !checks[n] || checks[n].status === 'down'),
    degraded: names.filter((n) => checks[n] && checks[n].status === 'degraded'),
    notInstalled,
    services: names.map((n) => ({ name: n, status: (checks[n] && checks[n].status) || 'down', latency_ms: checks[n] && Number.isFinite(checks[n].latency_ms) ? checks[n].latency_ms : null })),
  };
}

async function memorySection(deps, orgId) {
  const users = await read(deps, 'memoryUsers', 'memory', orgId);
  if (users.unknown) return { unknown: users.unknown };
  const ids = Array.isArray(users.value) ? users.value.filter(Boolean) : [];
  const stats = await Promise.all(ids.map((u) => read(deps, 'memoryStats', 'memory', orgId, u)));
  const bad = stats.find((s) => s.unknown);
  if (bad) return { unknown: bad.unknown };
  const by_type = {};
  let total = 0, entities = 0, relations = 0;
  for (const { value: s } of stats) {
    total += num(s && s.memories && s.memories.total);
    entities += num(s && s.entities && s.entities.total);
    relations = Math.max(relations, num(s && s.relations)); // relations are org-wide in the memory store
    for (const [k, v] of Object.entries((s && s.memories && s.memories.by_type) || {})) by_type[k] = (by_type[k] || 0) + num(v);
  }
  return { total, entities, relations, users: ids.length, by_type, scope: 'org' };
}

function pluginsSection(r) {
  if (r.unknown) return { unknown: r.unknown };
  const list = (Array.isArray(r.value) ? r.value : []).map((p) => ({
    id: p.plugin_id || p.id, name: p.name || p.plugin_id || p.id, version: p.version || null,
    enabled: p.enabled !== false && p.is_enabled !== false, tier: p.tier || 'custom',
  }));
  return { installed: list.length, enabled: list.filter((p) => p.enabled).length, list };
}

const SERVICE_OF = { 'quox-memory': 'memory', 'quox-brain2': 'quoxbrain', 'quox-nucleus': 'repobrain' };

function implantReason(i) {
  if (i.status === 'license-required') return { code: 'LICENSE_REQUIRED', service: 'auth', message: i.summary || 'requires a licence' };
  if (i.status === 'unreachable') return { code: 'IMPLANT_STATS_UNREACHABLE', service: 'tasks', message: i.summary || 'implant stats could not be read' };
  if (i.status === 'collecting') return { code: 'COLLECTING', service: 'tasks', message: i.summary || 'no signals recorded yet' };
  if (i.status === 'not-reported') return { code: 'NOT_REPORTED', service: SERVICE_OF[i.id] || 'tasks', message: i.summary || 'no live stats source for this implant' };
  if (i.status === 'weak') return { code: 'LOW_HEALTH', service: 'tasks', message: i.summary || `health ${i.health_score}` };
  return null;
}

function overlay(base, r, metricOf, lastOf) {
  if (r.unknown) return { ...base, status: 'unreachable', health: null, metric: null, reason: r.unknown };
  const metric = metricOf(r.value);
  return { ...base, status: metric.count > 0 ? 'healthy' : 'collecting', health: null, metric: metric.text, last_activity: lastOf ? lastOf(r.value) : base.last_activity,
    reason: metric.count > 0 ? { code: 'NO_HEALTH_SCORE', service: SERVICE_OF[base.id], message: 'this implant reports counts, not a health score' } : { code: 'COLLECTING', service: SERVICE_OF[base.id], message: 'nothing stored yet for this org' } };
}

async function implantsSection(deps, orgId, memory, qortexR, repoR) {
  const r = await read(deps, 'implants', 'tasks', orgId);
  if (r.unknown) return { unknown: r.unknown };
  return (Array.isArray(r.value) ? r.value : []).map((i) => {
    const base = { id: i.id, short: i.short, name: i.name, tier: i.tier || null, status: i.status, health: typeof i.health_score === 'number' ? i.health_score : null,
      metric: i.summary || null, last_activity: i.last_activity || null };
    if (i.id === 'quox-memory') {
      return overlay(base, memory.unknown ? { unknown: memory.unknown } : { value: memory },
        (m) => ({ count: m.total, text: `${m.total} memories, ${m.entities} entities` }));
    }
    if (i.id === 'quox-brain2') {
      return overlay(base, qortexR, (b) => ({ count: num(b && b.noteCount), text: `${num(b && b.noteCount)} notes` }), (b) => (b && b.newestNoteAt) || null);
    }
    if (i.id === 'quox-nucleus') {
      return overlay(base, repoR, (x) => {
        const repos = (x && x.repos) || [];
        const files = fileTotal(repos);
        return { count: repos.length, text: files == null ? `${repos.length} repos indexed` : `${repos.length} repos, ${files} files` };
      });
    }
    const reason = implantReason(i);
    return reason ? { ...base, reason } : base;
  });
}

function fabricSection(codeR, repoR) {
  if (codeR.unknown && repoR.unknown) return { unknown: codeR.unknown, repobrain_unknown: repoR.unknown };
  const out = {};
  if (codeR.unknown) out.projects_unknown = codeR.unknown;
  else {
    const p = Array.isArray(codeR.value) ? codeR.value : [];
    const scans = p.map((x) => x.last_scan || x.lastScan).filter(Boolean).sort();
    out.projectCount = p.length;
    out.totalRoutes = p.reduce((a, x) => a + num(x.metrics && x.metrics.routeCount), 0);
    out.totalServices = p.reduce((a, x) => a + num(x.metrics && x.metrics.serviceCount), 0);
    out.invariantStatus = p.some((x) => x.invariant_status === 'fail') ? 'fail' : p.length ? 'pass' : 'none';
    out.lastScan = scans.length ? scans[scans.length - 1] : null;
    if (!out.lastScan) out.lastScan_reason = { code: 'NO_SCAN', service: 'collector', message: 'no codebase scan stored for this org' };
  }
  if (repoR.unknown) out.repobrain_unknown = repoR.unknown;
  else {
    const repos = (repoR.value && repoR.value.repos) || [];
    out.repos = repos.length;
    out.indexedFiles = fileTotal(repos);
    if (out.indexedFiles == null) out.indexedFiles_reason = { code: 'NOT_REPORTED', service: 'repobrain', message: 'RepoBrain /api/targets carries no file counts' };
  }
  return out;
}

async function buildMirror({ orgId, deps = {}, now = Date.now() } = {}) {
  if (!orgId) throw new Error('buildMirror: org is required');
  const [healthR, memory, tools, workflows, pluginsR, agents, qortexR, repoR, codeR] = await Promise.all([
    read(deps, 'serviceChecks', 'collector'),
    memorySection(deps, orgId),
    read(deps, 'toolCounts', 'collector', orgId),
    read(deps, 'workflowCount', 'quoxflow', orgId),
    read(deps, 'plugins', 'auth', orgId),
    read(deps, 'agents', 'collector', orgId),
    read(deps, 'qortex', 'quoxbrain', orgId),
    read(deps, 'repobrain', 'repobrain', orgId),
    read(deps, 'codebase', 'collector', orgId),
  ]);
  const implants = await implantsSection(deps, orgId, memory, qortexR, repoR);
  const capabilities = {
    tools: tools.unknown ? { unknown: tools.unknown } : { platform: num(tools.value.platform), org: num(tools.value.org), total: num(tools.value.platform) + num(tools.value.org) },
    workflows: workflows.unknown ? { unknown: workflows.unknown } : num(workflows.value),
    agents: agents.unknown ? { unknown: agents.unknown } : { count: num(agents.value.count), entitled: num(agents.value.entitled), list: agents.value.list || [] },
  };
  const m = {
    version: '2.0.0',
    org_id: orgId,
    generatedAt: new Date(now).toISOString(),
    generatedBy: 'server',
    identity: IDENTITY,
    health: healthSection(healthR),
    memory,
    capabilities,
    plugins: pluginsSection(pluginsR),
    implants,
    codebaseFabric: fabricSection(codeR, repoR),
  };
  if (Array.isArray(implants)) {
    const by = {};
    for (const i of implants) by[i.status] = (by[i.status] || 0) + 1;
    m.implantSummary = { total: implants.length, by_status: by, healthy: by.healthy || 0 };
  }
  const unknowns = [];
  const note = (section, v) => { if (v && v.unknown) unknowns.push({ section, ...v.unknown }); };
  note('health', m.health); note('memory', m.memory); note('plugins', m.plugins); note('implants', m.implants); note('codebaseFabric', m.codebaseFabric);
  note('capabilities.tools', capabilities.tools); note('capabilities.workflows', capabilities.workflows); note('capabilities.agents', capabilities.agents);
  m.unknowns = unknowns;
  return m;
}

/** Per-org cache: { get(orgId) -> { mirror, age_ms, fresh }, peek(orgId) }. Never serves one org's build to another. */
function createMirrorCache({ build, ttlMs = 30000, now = () => Date.now(), maxOrgs = 500 } = {}) {
  const entries = new Map(); // orgId -> { at, mirror, inflight }
  const view = (e) => ({ mirror: e.mirror, age_ms: Math.max(0, now() - e.at), fresh: now() - e.at <= ttlMs * 2, refreshed_at: new Date(e.at).toISOString(), refresh_ms: ttlMs });
  async function refresh(orgId) {
    const e = entries.get(orgId) || {};
    if (e.inflight) return e.inflight;
    let p = null;
    p = (async () => {
      try {
        const mirror = await build(orgId);
        const done = { at: now(), mirror };
        entries.set(orgId, done);
        if (entries.size > maxOrgs) entries.delete(entries.keys().next().value);
        return done;
      } finally {
        const cur = entries.get(orgId);
        if (cur && cur.inflight === p) delete cur.inflight; // a failed build must not wedge this org
      }
    })();
    entries.set(orgId, { ...e, inflight: p });
    return p;
  }
  return {
    async get(orgId) {
      if (!orgId) throw new Error('mirror cache: org is required');
      const e = entries.get(orgId);
      if (e && e.mirror && now() - e.at <= ttlMs) return view(e);
      return view(await refresh(orgId));
    },
    /** Cached view only (no build): null when this org has none yet. Triggers a background refresh when stale. */
    peek(orgId) {
      const e = orgId && entries.get(orgId);
      if (!e || !e.mirror) return null;
      if (now() - e.at > ttlMs) refresh(orgId).catch(() => {});
      return view(e);
    },
  };
}

const ICON = { healthy: '●', degraded: '◐', collecting: '◐', weak: '◐', 'license-required': '🔒', unreachable: '⚠', 'not-reported': '·' };
const unk = (u) => `${u.code}, ${u.service}: ${u.message}`;

/** The compact, sectioned block injected into CommanderQ (and shown first by /mirror). */
function mirrorSummary(m) {
  if (!m) return '';
  const L = [`## QuoxMind Mirror (this org, built ${m.generatedAt} from server reads)`];
  const h = m.health;
  L.push(h.unknown ? `Health: unknown (${unk(h.unknown)})` : `Health: ${h.score}% | ${h.activeServices}/${h.totalServices} services up${h.down.length ? ` | down: ${h.down.join(', ')}` : ''}${h.degraded.length ? ` | degraded: ${h.degraded.join(', ')}` : ''}${h.notInstalled && h.notInstalled.length ? ` | not installed: ${h.notInstalled.join(', ')}` : ''}`);
  if (Array.isArray(m.implants)) {
    const s = m.implantSummary;
    L.push(`Implants: ${s.healthy}/${s.total} healthy (${Object.entries(s.by_status).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    L.push(m.implants.map((i) => `${ICON[i.status] || '·'}${String(i.name).replace(/^Quox/, '')}${i.metric ? `(${String(i.metric).slice(0, 40)})` : ''}`).join(' '));
  }
  const mem = m.memory;
  L.push(mem.unknown ? `Memory: unknown (${unk(mem.unknown)})` : `Memory: ${mem.total} memories, ${mem.entities} entities, ${mem.relations} relations across ${mem.users} users`);
  const c = m.capabilities;
  const part = (label, v, f) => (v && v.unknown ? `${label}: unknown` : f(v));
  L.push([
    part('Tools', c.tools, (t) => `Tools: ${t.total} (${t.platform} platform, ${t.org} org)`),
    part('Workflows', c.workflows, (w) => `Workflows: ${w}`),
    part('Agents', c.agents, (a) => `Agents: ${a.count} (${a.entitled} entitled)`),
  ].join(' | '));
  const p = m.plugins;
  L.push(p.unknown ? `Plugins: unknown (${unk(p.unknown)})` : `Plugins: ${p.installed} installed, ${p.enabled} enabled${p.list.length ? ` (${p.list.slice(0, 10).map((x) => x.id).join(', ')}${p.list.length > 10 ? ', ...' : ''})` : ''}`);
  const f = m.codebaseFabric;
  if (f.unknown) L.push(`Codebase: unknown (${unk(f.unknown)})`);
  else L.push(`Codebase: ${f.repos != null ? `${f.repos} repos indexed${f.indexedFiles != null ? `, ${f.indexedFiles} files` : ''}` : 'RepoBrain unknown'}${f.projectCount != null ? ` | ${f.projectCount} scanned projects, ${f.totalRoutes} routes, invariants ${f.invariantStatus}` : ''}`);
  for (const u of m.unknowns || []) L.push(`Unknown: ${u.section} (${unk(u)})`);
  L.push('For details use execution_intelligence (mirror_index, implant_detail, engine_health).');
  return L.join('\n');
}

module.exports = { buildMirror, createMirrorCache, mirrorSummary, why, IDENTITY };

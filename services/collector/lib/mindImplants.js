'use strict';
/**
 * QuoxMind cognitive implants read model (`quox mind ...`, GET /api/v1/mind/*).
 *
 * Static facts (name, purpose, tier) come from the same registry the
 * execution_intelligence tool reads (src/config/cognitiveImplants.js, via
 * loadCognitiveImplants). Live status comes from the tasks service
 * /api/engine/<implant>/stats endpoints, org-scoped by X-Org-Id. Where an
 * implant has no stats endpoint, or has recorded nothing, we say so; nothing
 * is invented.
 */

// Registry id -> tasks-service stats path (undefined = no stats endpoint here).
const STATS_PATH = {
  'quox-sense': 'sense',
  'quox-temporal': 'temporal',
  'quox-focus': 'focus',
  'quox-value': 'value',
  'quox-guard': 'guard',
  'quox-insight': 'insight',
  'quox-executive': 'executive',
  'quox-predict': 'predict',
  'quox-reflect': 'reflect',
  'quox-dream': 'dream',
  'quox-learn': 'learn',
};

const SHORT_ALIAS = { repobrain: 'quox-nucleus', nucleus: 'quox-nucleus', qortex: 'quox-brain2', brain2: 'quox-brain2' };

function shortName(id) {
  if (id === 'quox-nucleus') return 'repobrain';
  if (id === 'quox-brain2') return 'qortex';
  return String(id).replace(/^quox-/, '');
}

function resolveImplantId(input, registry) {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  if (registry[raw]) return raw;
  if (SHORT_ALIAS[raw]) return SHORT_ALIAS[raw];
  if (registry[`quox-${raw}`]) return `quox-${raw}`;
  // Display names as people and models say them ("QuoxPredict", "Quox Predict implant", "Predict implant")
  const squash = (x) => String(x).toLowerCase().replace(/\s*implant$/i, '').replace(/[^a-z0-9]/g, '');
  const want = squash(raw);
  if (!want) return null;
  for (const id of Object.keys(registry)) {
    const nm = registry[id] && registry[id].name;
    if (squash(id) === want || squash(`quox-${want}`) === squash(id) || (nm && squash(nm) === want)) return id;
  }
  if (SHORT_ALIAS[want]) return SHORT_ALIAS[want];
  return null;
}

function oneLine(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : s;
}

function lastActivity(fields) {
  let best = null;
  for (const [k, v] of Object.entries(fields || {})) {
    if (!/^last.*At$/.test(k) || !v) continue;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

function statusFromStats(stats) {
  if (!stats) return { status: 'not-reported', detail: 'live stats are not exposed for this implant here' };
  // QUOXMIND #1111: a fetcher that measures activity directly (no health score)
  // states its own status, e.g. memory 'active' / 'idle'.
  if (stats.reportedStatus) return { status: stats.reportedStatus, detail: stats.primaryMetric?.label || '' };
  if (stats.failureReason) {
    const code = stats.failureReason.code;
    if (code === 'LICENSE_REQUIRED') return { status: 'license-required', detail: `requires ${stats.failureReason.requiredPlugin || 'a plugin'}` };
    return { status: 'unreachable', detail: stats.failureReason.message || code };
  }
  if (stats.healthScore === null || stats.healthScore === undefined) {
    return { status: 'collecting', detail: stats.primaryMetric?.label || 'collecting' };
  }
  const h = stats.healthScore;
  return { status: h >= 70 ? 'healthy' : h >= 40 ? 'degraded' : 'weak', detail: stats.primaryMetric?.label || '' };
}

const MEMORY_URL_DEFAULT = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const ACTIVE_WINDOW_MS = 7 * 24 * 3600 * 1000;

// QUOXMIND #1111: QuoxMemory's live numbers come from the memory service's
// org-scope stats (counts only), not the tasks service.
async function fetchMemoryStats(fetchFn, memoryUrl, headers) {
  try {
    const r = await fetchFn(`${memoryUrl}/api/memory/stats?scope=org`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { stats: null, error: `memory service returned ${r.status}` };
    const b = await r.json();
    const total = b.memories?.total ?? 0;
    const agents = Object.keys(b.by_agent || {}).filter((a) => a !== '(none)').length;
    const lastIso = b.last_write_at ? new Date(`${String(b.last_write_at).replace(' ', 'T')}Z`).toISOString() : null;
    const recent = lastIso && Date.now() - Date.parse(lastIso) < ACTIVE_WINDOW_MS;
    return {
      stats: {
        reportedStatus: total > 0 && recent ? 'active' : 'idle',
        healthScore: null,
        primaryMetric: { label: `${total} memories across ${agents} agents (${b.memories?.not_valid ?? 0} superseded or deleted), ${b.pinned ?? 0} pinned` },
        fields: { lastWriteAt: lastIso, valid: total, notValid: b.memories?.not_valid ?? 0, pinned: b.pinned ?? 0, agents },
      },
      error: null,
    };
  } catch (err) {
    return { stats: null, error: err.message };
  }
}

const BRAIN_URL_DEFAULT = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;

// Proof qortex/brain-note-count: Qortex's live numbers come from quoxbrain
// /brain/status (counts only), read as the asking user when there is one so the
// count includes their personal notes; the org Mirror (no user) gets org scope.
async function fetchQortexStats(fetchFn, brainUrl, headers, userId) {
  try {
    const h = { ...headers, 'X-User-Id': userId || 'service' };
    const r = await fetchFn(`${brainUrl}/brain/status?embeddings=none`, { headers: h, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { stats: null, error: `quoxbrain returned ${r.status}` };
    const b = await r.json();
    const n = Number(b?.noteCount);
    if (!Number.isFinite(n)) return { stats: null, error: 'quoxbrain status carried no note count' };
    const sc = b.noteCountByScope || {};
    const split = Number.isFinite(Number(sc.org)) && Number.isFinite(Number(sc.user)) ? ` (${Number(sc.org)} shared across the org, ${Number(sc.user)} personal)` : '';
    const newest = b.newestNoteAt || null;
    const recent = newest && Date.now() - Date.parse(newest) < ACTIVE_WINDOW_MS;
    return {
      stats: {
        reportedStatus: n > 0 && recent ? 'active' : 'idle',
        healthScore: null,
        primaryMetric: { label: `${n} notes${split}` },
        fields: { lastNoteAt: newest, noteCount: n, orgNotes: sc.org ?? null, personalNotes: sc.user ?? null },
      },
      error: null,
    };
  } catch (err) {
    return { stats: null, error: err.message };
  }
}

async function fetchStats(fetchFn, tasksUrl, headers, implantId, memoryUrl = MEMORY_URL_DEFAULT, brainUrl = BRAIN_URL_DEFAULT, userId = null) {
  if (implantId === 'quox-memory') return fetchMemoryStats(fetchFn, memoryUrl, headers);
  if (implantId === 'quox-brain2') return fetchQortexStats(fetchFn, brainUrl, headers, userId);
  const path = STATS_PATH[implantId];
  if (!path) return { stats: null, error: null };
  try {
    const r = await fetchFn(`${tasksUrl}/api/engine/${path}/stats`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { stats: null, error: `tasks service returned ${r.status}` };
    return { stats: await r.json(), error: null };
  } catch (err) {
    return { stats: null, error: err.message };
  }
}

// QUOXMIND-PROOF: one org-scoped read of every implant's firing evidence
// (tasks /api/engine/activity). A failure is carried as an error string so the
// entries say "unknown", never a silent 0.
async function fetchActivity(fetchFn, tasksUrl, headers) {
  try {
    const r = await fetchFn(`${tasksUrl}/api/engine/activity`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { implants: null, error: `tasks activity returned ${r.status}` };
    const body = await r.json();
    return { implants: body.implants || {}, error: null };
  } catch (err) {
    return { implants: null, error: err.message };
  }
}

function activityFields(id, act) {
  if (!act || act.error) {
    return { last_fired: null, fired_7d: null, activity_source: null, activity_error: act?.error || null };
  }
  const a = act.implants[id];
  if (!a) return { last_fired: null, fired_7d: null, activity_source: null, activity_error: null };
  const out = { last_fired: a.last_fired_at || null, fired_7d: a.fired_7d ?? null, activity_source: a.source || null, activity_error: a.error || null };
  if (typeof a.idle_runs_7d === 'number') out.idle_runs_7d = a.idle_runs_7d;
  return out;
}

function buildEntry(cfg, id, { stats, error }, act) {
  const st = error
    ? { status: 'unreachable', detail: error }
    : statusFromStats(stats);
  const last = lastActivity(stats?.fields);
  return {
    id,
    short: shortName(id),
    name: cfg.name,
    kind: cfg.kind || null,
    tier: cfg.tier || null,
    purpose: oneLine(cfg.description),
    status: st.status,
    health_score: stats && typeof stats.healthScore === 'number' ? stats.healthScore : null,
    summary: st.detail,
    last_activity: last,
    activity: last ? `last activity ${last}` : 'no activity recorded',
    ...activityFields(id, act),
  };
}

async function listImplants({ orgId, registry, tasksUrl, memoryUrl, brainUrl, userId, serviceKey, fetchFn = fetch }) {
  const headers = { 'X-Org-Id': orgId, 'X-Service-Key': serviceKey || '' };
  const ids = Object.keys(registry);
  const [results, act] = await Promise.all([
    Promise.all(ids.map((id) => fetchStats(fetchFn, tasksUrl, headers, id, memoryUrl, brainUrl, userId))),
    fetchActivity(fetchFn, tasksUrl, headers),
  ]);
  return ids.map((id, i) => buildEntry(registry[id], id, results[i], act));
}

async function implantDetail({ orgId, registry, tasksUrl, memoryUrl, brainUrl, userId, serviceKey, implantId, fetchFn = fetch }) {
  const id = resolveImplantId(implantId, registry);
  if (!id) return null;
  const headers = { 'X-Org-Id': orgId, 'X-Service-Key': serviceKey || '' };
  const [res, act] = await Promise.all([fetchStats(fetchFn, tasksUrl, headers, id, memoryUrl, brainUrl, userId), fetchActivity(fetchFn, tasksUrl, headers)]);
  const cfg = registry[id];
  return {
    ...buildEntry(cfg, id, res, act),
    inspired_by: cfg.inspiredBy || null,
    description: cfg.description || '',
    how_to_grow: cfg.howToGrow || null,
    connected_to: cfg.connectedTo || [],
    metrics: res.stats?.fields || {},
    primary_metric: res.stats?.primaryMetric || null,
    generated_at: res.stats?.generatedAt || null,
  };
}

function summarizeHealth(entries) {
  const by = {};
  for (const e of entries) by[e.status] = (by[e.status] || 0) + 1;
  const scored = entries.filter((e) => typeof e.health_score === 'number');
  const avg = scored.length ? Math.round(scored.reduce((a, e) => a + e.health_score, 0) / scored.length) : null;
  const active = entries.filter((e) => e.last_activity).length;
  return {
    total: entries.length,
    by_status: by,
    scored: scored.length,
    average_health: avg,
    with_activity: active,
    no_activity: entries.length - active,
    unreachable: by.unreachable || 0,
    // QUOXMIND-PROOF firing evidence: measured counts only; null = unknown.
    fired_7d_total: entries.reduce((a, e) => a + (typeof e.fired_7d === 'number' ? e.fired_7d : 0), 0),
    fired_7d_implants: entries.filter((e) => typeof e.fired_7d === 'number' && e.fired_7d > 0).length,
    silent_7d: entries.filter((e) => e.fired_7d === 0).length,
    activity_unknown: entries.filter((e) => typeof e.fired_7d !== 'number').length,
  };
}

module.exports = { listImplants, implantDetail, summarizeHealth, resolveImplantId, shortName, lastActivity, STATS_PATH };

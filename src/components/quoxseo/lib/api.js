/**
 * QuoxSEO API client — tiny fetch wrapper against the collector proxy.
 *
 * Routed through the collector proxy (services/collector/server.js's
 * /api/v1/quoxseo/* -> QUOXSEO_URL), the same pattern as QuoxSignal's own
 * client (src/components/quoxsignal/lib/api.js) and QuoxPlan's
 * (src/services/quoxplanApiClient.js). This module never talks to the
 * QuoxSEO backend directly.
 *
 * House rule: server-side is the source of truth. This module holds an
 * in-memory (per browser-session, cleared on reload) cache only, never
 * localStorage, for read data.
 */

const API_BASE = '/collector/api/v1/quoxseo';

/** In-memory cache, keyed by request URL/cacheKey. Cleared on full page reload. */
const cache = new Map();

/** In-flight promises, keyed by the same cacheKey as `cache`, so two callers racing
 *  past the cache-miss check share one request instead of firing a duplicate. */
const inFlight = new Map();

/**
 * Thrown on any non-2xx response. Carries the parsed status and body so callers can
 * tell an entitlement gate apart from a genuine backend fault: the collector's default-deny
 * gate returns 403 with a body like { error: 'entitlement_required' } or
 * { error: 'quoxseo_org_gate' }, see isEntitlementError() below.
 */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** True when `err` is the collector's entitlement gate rather than a backend fault. */
export function isEntitlementError(err) {
  if (!(err instanceof ApiError) || err.status !== 403) return false;
  const reason = err.body?.error;
  return reason === 'entitlement_required' || reason === 'quoxseo_org_gate';
}

async function request(path, { cacheKey, force = false } = {}) {
  const key = cacheKey ?? path;
  if (!force && cache.has(key)) return cache.get(key);
  if (!force && inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    // Session cookie authenticates through the collector proxy, mirroring
    // services/quoxplanApiClient.js and quoxsignal's lib/api.js (collector
    // accepts cookie or Bearer).
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        // ignore body parse failures, the status is still informative
      }
      throw new ApiError(res.status, body);
    }
    const data = await res.json();
    cache.set(key, data);
    return data;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    // Clear on settle (success or failure) so a failed request doesn't wedge every
    // later caller behind a promise that will never resolve again.
    inFlight.delete(key);
  }
}

export function clearApiCache() {
  cache.clear();
  inFlight.clear();
}

function buildQuery(params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, v);
  }
  return qs.toString();
}

export const api = {
  /** Health probe, special-cased by the collector proxy to the backend's bare /health. Never cached. */
  async health() {
    const res = await fetch(`${API_BASE}/health`, { credentials: 'include' });
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
    return res.json();
  },

  /**
   * GET /api/v1/quoxseo/properties -> { properties: [{ id, origin, gsc_property }] }, the
   * org's property list for the PROPERTY SWITCHER. Not site-scoped itself.
   */
  getProperties(opts) {
    return request(`${API_BASE}/properties`, { cacheKey: 'properties', ...opts });
  },

  /**
   * GET /api/v1/quoxseo/summary[?site_id=] -> { summary, crawls, property } for an org with
   * at least one crawl, or { empty: true } for an org that has never run one. Omitting
   * `siteId` defaults server-side to the org's first property.
   */
  getSummary(siteId, opts) {
    const qsStr = buildQuery({ site_id: siteId });
    return request(`${API_BASE}/summary${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `summary:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/urls?filter=&q=&sort=&limit=&site_id= -> { crawl_id, total, urls, property }.
   * `filter` is one of orphans|noindex|errors|no-gsc|discovered, or omitted for all URLs.
   */
  listUrls(params = {}, siteId, opts) {
    const qsStr = buildQuery({ ...params, site_id: siteId });
    return request(`${API_BASE}/urls${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `urls:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/opportunities?type=&limit=&site_id= ->
   * { property, crawl_id, summary: { total, by_type, top_score }, opportunities }.
   * `type` is one of striking_distance|ctr_gap|orphan_with_traffic|thin_with_traffic, or
   * omitted for all opportunity types. `limit` defaults to 100.
   */
  listOpportunities(params = {}, siteId, opts) {
    const qsStr = buildQuery({ limit: 100, ...params, site_id: siteId });
    return request(`${API_BASE}/opportunities${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `opportunities:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/queries?view=&limit=&site_id= ->
   * { property, crawl_id, query_rows, cannibalisation, keyword_opportunities, brand }.
   * `view` is one of cannibalisation|keywords|brand, or omitted to get all three. `limit`
   * defaults to 100.
   */
  listQueries(params = {}, siteId, opts) {
    const qsStr = buildQuery({ limit: 100, ...params, site_id: siteId });
    return request(`${API_BASE}/queries${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `queries:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/issues?severity=&type=&limit=&site_id= ->
   * { property, crawl_id, summary: { total, by_severity, by_type }, issues }.
   * `severity` is one of high|medium|low, or omitted for all severities. `limit` defaults to 200.
   */
  listIssues(params = {}, siteId, opts) {
    const qsStr = buildQuery({ limit: 200, ...params, site_id: siteId });
    return request(`${API_BASE}/issues${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `issues:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/trends?scope=&limit=&site_id= ->
   * { property, crawl_id, windows, urls, url_summary, queries, query_summary }.
   * `scope` is url|query, or omitted to get both. Winners & losers over time
   * from a period compare (last 28d vs prior 28d), read from durable storage.
   */
  listTrends(params = {}, siteId, opts) {
    const qsStr = buildQuery({ limit: 100, ...params, site_id: siteId });
    return request(`${API_BASE}/trends${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `trends:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/inspection?filter=&limit=&site_id= ->
   * { property, coverage: { total, indexed, not_indexed, by_state }, conflicts, inspections }.
   * Google URL Inspection: index-coverage truth + conflicts where Google
   * disagrees with the page. `filter` is indexed|not-indexed, or omitted.
   */
  listInspection(params = {}, siteId, opts) {
    const qsStr = buildQuery({ limit: 200, ...params, site_id: siteId });
    return request(`${API_BASE}/inspection${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `inspection:${qsStr}`,
      ...opts
    });
  },

  /** GET /api/v1/quoxseo/crawls[?site_id=] -> { crawls, property }, each carrying its WARD witness state. */
  listCrawls(siteId, opts) {
    const qsStr = buildQuery({ site_id: siteId });
    return request(`${API_BASE}/crawls${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `crawls:${qsStr}`,
      ...opts
    });
  },

  /** GET /api/v1/quoxseo/changes?limit=&crawl_id=&site_id= -> { changes, property }, the witnessed diff log. */
  listChanges(params = {}, siteId, opts) {
    const qsStr = buildQuery({ ...params, site_id: siteId });
    return request(`${API_BASE}/changes${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `changes:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/verify[?site_id=] -> { chain_status, all_ok, crawls }. Recomputes
   * hashes and Ed25519 signatures server-side from the warehouse rows and the exported WARD
   * chain. Always forced (never served from cache): this is a deliberate re-check the owner
   * asks for, not a passive read, so a stale cached verdict would defeat the point of the
   * button. `siteId` is accepted for signature consistency; verify is org-wide.
   */
  verify(siteId, opts) {
    const qsStr = buildQuery({ site_id: siteId });
    return request(`${API_BASE}/verify${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: 'verify',
      force: true,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/settings -> { org_id, settings: { dataforseo_credential_id: { value,
   * source }, ... } }. Every value is a POINTER (a vault credential id, a property string, a
   * number), never a secret, so this is safe to read from the browser. Used only to detect
   * whether a DataForSEO credential is configured, to soften the activation banner.
   */
  getSettings(opts) {
    return request(`${API_BASE}/settings`, { cacheKey: 'settings', ...opts });
  },

  /**
   * GET /api/v1/quoxseo/keywords?limit=&site_id= -> { property, keywords: [{ keyword, volume,
   * cpc, competition, difficulty, intent, source, fetched_at }] }. DataForSEO-backed keyword
   * research: the full keyword universe for this property.
   */
  listKeywords(params = {}, siteId, opts) {
    const qsStr = buildQuery({ ...params, site_id: siteId });
    return request(`${API_BASE}/keywords${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `keywords:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/track[?site_id=] -> { property, tracked: [{ keyword, location_code,
   * device, added_at }], latest_checks }. The keywords this org has chosen to track.
   */
  listTracked(siteId, opts) {
    const qsStr = buildQuery({ site_id: siteId });
    return request(`${API_BASE}/track${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `track:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/rank[?site_id=] -> { property, crawl_id, witnessed, prev_crawl_id,
   * rows: [{ query, position, prev_position, movement, impressions, clicks }] }. Search
   * Console positions for the latest crawl, matched against tracked keywords by query text.
   */
  listRank(siteId, opts) {
    const qsStr = buildQuery({ site_id: siteId });
    return request(`${API_BASE}/rank${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `rank:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/rank/history?query=&site_id= -> { property, query, points: [{
   * crawl_id, date, position, impressions, clicks, witnessed }], first, latest, best, delta,
   * witnessed_all }. Position history for one tracked keyword, across crawls.
   */
  getRankHistory(query, siteId, opts) {
    const qsStr = buildQuery({ query, site_id: siteId });
    return request(`${API_BASE}/rank/history${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `rank-history:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/gaps[?site_id=] -> { property, competitors: [{ competitor, keywords,
   * fetched_at }] }. Competitor summary: how many keywords DataForSEO has on file for each
   * tracked competitor domain.
   */
  listGaps(siteId, opts) {
    const qsStr = buildQuery({ site_id: siteId });
    return request(`${API_BASE}/gaps${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `gaps:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxseo/gaps?competitor=&site_id= -> { property, competitor, crawl_id,
   * witnessed, summary: { gap_keywords, gap_volume, they_beat_us, we_are_absent },
   * keyword_gaps: [{ keyword, their_position, volume, our_position, our_impressions,
   * competitor_url }], page_gaps: [{ url, keywords, volume, top_keyword }] }. The attack list
   * for one competitor: keywords they rank for that we don't, or rank worse for.
   */
  getGapDetail(competitor, siteId, opts) {
    const qsStr = buildQuery({ competitor, site_id: siteId });
    return request(`${API_BASE}/gaps${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `gap-detail:${qsStr}`,
      ...opts
    });
  }
};

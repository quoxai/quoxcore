/**
 * QuoxSignal API client — tiny fetch wrapper against the collector proxy.
 *
 * SIGNAL-EMBED dashboard embed: routed through the collector proxy
 * (services/collector/server.js's /api/v1/signal/* -> QUOXSIGNAL_URL), the
 * exact same pattern as QuoxPlan's own client
 * (src/services/quoxplanApiClient.js hitting /collector/api/v1/quoxplan).
 * This module never talks to port 3108 directly.
 *
 * House rule: server-side is the source of truth. This module holds an
 * in-memory (per browser-session, cleared on reload) cache only — never
 * localStorage — for read data.
 *
 * SCOUT's chat is NOT proxied here: it goes through the shared
 * ChatEngine/collector `/collector/chat` dispatch via ScoutChatSidebar
 * (agentId="scout"), the same governed path every other dashboard agent
 * uses — see ScoutChatSidebar.jsx. The standalone app's own POST
 * /api/v1/chat route has no equivalent in this client on purpose.
 */

const API_BASE = '/collector/api/v1/signal';

/** In-memory cache, keyed by request URL. Cleared on full page reload. */
const cache = new Map();

/**
 * In-flight promises, keyed by the same cacheKey as `cache` above.
 *
 * SIGNAL-PERF: the Proposals tab was firing the same item URL 3-4 times in a
 * single load because several hooks (useItemsByIds, useEnrichments, and any
 * re-render-triggered re-run of either) all raced past the `cache.has(key)`
 * check before the first response had come back, so none of them saw a hit
 * yet. Deduping on the request itself, not just the resolved value, closes
 * that window: the second caller gets the exact same in-flight promise
 * instead of issuing a second identical fetch.
 */
const inFlight = new Map();

async function request(path, { cacheKey, force = false } = {}) {
  const key = cacheKey ?? path;
  if (!force && cache.has(key)) return cache.get(key);
  if (!force && inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    // Session cookie authenticates through the collector proxy, mirroring
    // services/quoxplanApiClient.js (collector accepts cookie or Bearer).
    const res = await fetch(path, { credentials: 'include' });
    if (!res.ok) {
      let bodyExcerpt = '';
      try {
        bodyExcerpt = (await res.text()).slice(0, 200);
      } catch {
        // ignore body read failures, the status is still informative
      }
      throw new Error(`API ${res.status} ${res.statusText} for ${path}: ${bodyExcerpt}`);
    }
    const data = await res.json();
    cache.set(key, data);
    return data;
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    // Clear on settle (success or failure) so a failed request doesn't wedge
    // every later caller behind a promise that will never resolve again.
    inFlight.delete(key);
  }
}

export function clearApiCache() {
  cache.clear();
  inFlight.clear();
}

// F06 (engagement trust-proof-isolation-sweep-c1): path-keyed cache is org-blind,
// so an in-SPA org switch could show org A's signal data to org B. Clear on the
// house org-switch signal, mirroring assistantStorage.js / fileStorage.js.
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', clearApiCache);
}

function invalidateCache(prefix) {
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(prefix)) cache.delete(key);
  }
}

/** Thrown by write-path helpers below. Carries the parsed error body so callers can surface `body.error`. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function mutate(path, { method = 'POST', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = res.status === 204 ? null : await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new ApiError(res.status, payload);
  }
  return payload;
}

export const api = {
  /** Health probe, special-cased by the collector proxy to the backend's bare /health. Never cached. */
  async health() {
    const res = await fetch(`${API_BASE}/health`, { credentials: 'include' });
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
    return res.json();
  },

  /** GET /api/v1/items?source=&stage=&topic=&limit= -> { items }. */
  listItems(params = {}, opts) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const qsStr = qs.toString();
    return request(`${API_BASE}/items${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `items:${qsStr}`,
      ...opts
    });
  },

  /** GET /api/v1/items/:id -> item with segments. */
  /** GET /api/v1/budgets -> { org, sources }. Drives the spend indicator: the product
   *  promises cost is visible BEFORE you spend, which is hollow if nothing ever says what
   *  you have already spent. */
  listBudgets(opts) {
    return request(`${API_BASE}/budgets`, { cacheKey: 'budgets', ...opts });
  },

  /**
   * GET /api/v1/items?ids=a,b,c -> { items }. One request for many ids.
   *
   * SIGNAL-PERF: the Proposals tab resolved each proposal's originating item individually,
   * so a cold load of ten proposals issued 18 of these joins on top of the two list calls.
   * The server answers each in 12 to 45ms; the cost was request COUNT, queueing behind the
   * browser's per-host connection limit. Server-side cap is 200 ids per request.
   */
  listItemsByIds(ids, opts) {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (list.length === 0) return Promise.resolve({ items: [] });
    const qs = `ids=${encodeURIComponent(list.join(','))}`;
    return request(`${API_BASE}/items?${qs}`, { cacheKey: `items:ids:${list.slice().sort().join(',')}`, ...opts });
  },

  getItem(id, opts) {
    return request(`${API_BASE}/items/${encodeURIComponent(id)}`, {
      cacheKey: `item:${id}`,
      ...opts
    });
  },

  /**
   * POST /api/v1/items/:id/stage -> updated item. Records intent to move an
   * item to its next stage — the single action every item card exposes.
   */
  async advanceStage(id, to) {
    const data = await mutate(`${API_BASE}/items/${encodeURIComponent(id)}/stage`, {
      body: { to, actor: 'owner' }
    });
    invalidateCache('items:');
    invalidateCache(`item:${id}`);
    invalidateCache('stats');
    return data;
  },

  /** GET /api/v1/sources -> { sources }, each carrying its health. */
  listSources(opts) {
    return request(`${API_BASE}/sources`, { cacheKey: 'sources', ...opts });
  },

  /**
   * POST /api/v1/sources -> created source. SIGNAL-UX item 5: the only
   * way to follow a source used to be the CLI (`signal follow`) — this is
   * the dashboard's equivalent of that same POST /sources call.
   */
  async createSource(payload) {
    const data = await mutate(`${API_BASE}/sources`, {
      body: { actor: 'owner', ...payload }
    });
    invalidateCache('sources');
    return data;
  },

  /** PATCH /api/v1/sources/:id -> updated source. Used for label edits and autonomy level changes. */
  async patchSource(id, patch) {
    const data = await mutate(`${API_BASE}/sources/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { actor: 'owner', ...patch }
    });
    invalidateCache('sources');
    return data;
  },

  /**
   * DELETE /api/v1/sources/:id -> 204, or 200 with counts when purging.
   * Default unfollow detaches items (they stay in the feed, label kept);
   * `purge: 'discovered'` also removes the source's unprocessed items
   * (transcribed/analysed work always survives), `purge: 'all'` removes
   * every item that has not produced a proposal.
   */
  async deleteSource(id, { purge } = {}) {
    const qs = purge ? `?purge=${encodeURIComponent(purge)}` : '';
    const data = await mutate(`${API_BASE}/sources/${encodeURIComponent(id)}${qs}`, {
      method: 'DELETE',
      body: { actor: 'owner' }
    });
    invalidateCache('sources');
    invalidateCache('items:');
    return data;
  },

  /**
   * POST /api/v1/items/:id/dismiss|undismiss -> updated item. Server-side
   * discard (items.dismissed_at): survives browser clears and follows the
   * org, unlike the retired localStorage discard set. The default GET /items
   * excludes dismissed rows; ?dismissed=1 is the discarded view.
   */
  async dismissItem(id) {
    const data = await mutate(`${API_BASE}/items/${encodeURIComponent(id)}/dismiss`, {
      body: { actor: 'owner' }
    });
    invalidateCache('items:');
    invalidateCache(`item:${id}`);
    invalidateCache('stats');
    return data;
  },

  async undismissItem(id) {
    const data = await mutate(`${API_BASE}/items/${encodeURIComponent(id)}/undismiss`, {
      body: { actor: 'owner' }
    });
    invalidateCache('items:');
    invalidateCache(`item:${id}`);
    invalidateCache('stats');
    return data;
  },

  /**
   * PATCH /api/v1/budgets/source/:id -> the source's budget row.
   *
   * SIGNAL-P8: the daily cap was readable here (listBudgets) but only writable from the
   * CLI (`signal budget --source <label> --daily <usd>`). The first-run wizard asks for a
   * cap as part of following a source, so the dashboard needs the same write the CLI has.
   */
  async setSourceDailyCap(id, dailyCapUsd) {
    const data = await mutate(`${API_BASE}/budgets/source/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { daily_cap_usd: dailyCapUsd, actor: 'owner' }
    });
    invalidateCache('budgets');
    return data;
  },

  /**
   * GET /api/v1/triage-lenses -> { lenses }. This org's CUSTOM lenses only: the built-in
   * presets are JSON files inside the quox-signal repo and never rows in this table (see
   * server/src/api/triageLenses.js), so callers merge these over lib/triageLenses.js's
   * preset list, exactly as `signal lens list` does.
   */
  listTriageLenses(opts) {
    return request(`${API_BASE}/triage-lenses`, { cacheKey: 'triage-lenses', ...opts });
  },

  /** GET /api/v1/proposals/:id -> proposal, or null on 404 (an item may not have one yet). */
  async getProposalForItem(itemId, opts) {
    for (const candidate of [itemId, `${itemId}-p`]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await request(`${API_BASE}/proposals/${encodeURIComponent(candidate)}`, {
          cacheKey: `proposal:${candidate}`,
          ...opts
        });
      } catch (e) {
        if (!String(e.message).startsWith('API 404')) throw e;
      }
    }
    return null;
  },

  /** GET /api/v1/proposals?status= -> { proposals }. Powers the Proposals (HITL) view. */
  listProposals(params = {}, opts) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, v);
    }
    const qsStr = qs.toString();
    return request(`${API_BASE}/proposals${qsStr ? `?${qsStr}` : ''}`, {
      cacheKey: `proposals:${qsStr}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/stats -> { items, proposals } station counts for the
   * pipeline bar. Never cached beyond the shared request cache — the bar is
   * the pipeline's speedometer and must move when the pipeline does.
   */
  getStats(opts) {
    return request(`${API_BASE}/stats`, { cacheKey: 'stats', ...opts });
  },

  /**
   * PATCH /api/v1/proposals/:id -> updated proposal. The Discuss & update
   * station: revise the summary after discussion, up until handoff (the
   * server 409s once submitted or rejected).
   */
  async updateProposal(id, fields) {
    const data = await mutate(`${API_BASE}/proposals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { ...fields, actor: 'owner' }
    });
    invalidateCache('proposals:');
    invalidateCache(`proposal:${id}`);
    invalidateCache('stats');
    return data;
  },

  /**
   * POST /api/v1/proposals/:id/decision -> updated proposal. The whole HITL
   * surface: this records a decision, it never triggers a downstream action.
   */
  async decideProposal(id, status) {
    const data = await mutate(`${API_BASE}/proposals/${encodeURIComponent(id)}/decision`, {
      body: { status, actor: 'owner' }
    });
    invalidateCache('proposals:');
    invalidateCache(`proposal:${id}`);
    invalidateCache('stats');
    return data;
  },

  /**
   * POST /api/v1/proposals/:id/handoff -> updated proposal + drafted/submitted
   * payload. `dryRun` defaults true so a preview click never accidentally
   * writes to QuoxPlan's roadmap.
   */
  async handoffProposal(id, dryRun = true) {
    const data = await mutate(`${API_BASE}/proposals/${encodeURIComponent(id)}/handoff`, {
      body: { dry_run: dryRun, actor: 'owner' }
    });
    invalidateCache('proposals:');
    invalidateCache(`proposal:${id}`);
    invalidateCache('stats');
    return data;
  },

  /**
   * GET /api/v1/proposals/:id/enrichments -> { enrichments }, oldest first.
   *
   * An enrichment is real paid analysis, so it lives server-side and follows the user across
   * browsers and devices. Ordered oldest first because this is an append log, not a latest
   * value: the point is that you can see the original verdict and everything added after it.
   */
  listEnrichments(proposalId, opts) {
    return request(`${API_BASE}/proposals/${encodeURIComponent(proposalId)}/enrichments`, {
      cacheKey: `enrichments:${proposalId}`,
      ...opts
    });
  },

  /**
   * POST /api/v1/proposals/:id/enrichments -> the created enrichment.
   *
   * APPEND ONLY, enforced at the storage layer as well as here: there is deliberately no
   * update and no delete route, because the product promises a re-run never overwrites the
   * earlier verdict, and a promise the storage layer does not keep is not a promise.
   */
  async appendEnrichment(proposalId, { kind, body, costUsd, model }) {
    const data = await mutate(`${API_BASE}/proposals/${encodeURIComponent(proposalId)}/enrichments`, {
      body: { kind, body, cost_usd: costUsd, model, actor: 'owner' }
    });
    invalidateCache(`enrichments:${proposalId}`);
    return data;
  },

  /** GET /api/v1/items/:id/lenses -> { lenses }. Full history of applyLens() runs. */
  listLensResults(itemId, opts) {
    return request(`${API_BASE}/items/${encodeURIComponent(itemId)}/lenses`, {
      cacheKey: `lenses:${itemId}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/sources/:id/avatar -> raw image, 404 when the source has none.
   * Not run through request()/mutate() — this is a URL builder for an <img
   * src>, so the browser does the fetch (with the session cookie) and the
   * component's own onError handles the 404 quietly.
   */
  sourceAvatarUrl(sourceId) {
    return `${API_BASE}/sources/${encodeURIComponent(sourceId)}/avatar`;
  },

  /** GET /api/v1/items/:id/thumbnail -> raw image, 404 when the item has none. Same URL-builder pattern as sourceAvatarUrl(). */
  itemThumbnailUrl(itemId) {
    return `${API_BASE}/items/${encodeURIComponent(itemId)}/thumbnail`;
  }
};

/**
 * QuoxPlan API client — tiny fetch wrapper against the P0 server.
 *
 * LL-7i4a: relocated here (from the quoxplan plugin's lib/api.js) to a CORE
 * service so the onboarding flow (src/pages/views/OnboardView.jsx) no longer
 * imports the quoxplan plugin, letting quoxplan be stripped into a signed
 * first-party bundle. Behaviour is unchanged from the plugin-local original.
 *
 * House rule: server-side is the source of truth. This module holds an
 * in-memory (per browser-session, cleared on reload) cache only — never
 * localStorage — for read data. View preferences (e.g. timeline zoom) are
 * allowed to use localStorage and live next to their component instead.
 */

// QUOXPLAN-P4 dashboard embed: routed through the collector proxy
// (server.js /api/v1/quoxplan/* -> QUOXPLAN_URL), same pattern as RepoBrain's
// nucleusClient.js hitting /collector/api/v1/nucleus.
const API_BASE = '/collector/api/v1/quoxplan';

// QUOXPLAN-P5: NOT under API_BASE — this is a standalone collector route
// (server.js /api/v1/quoxplan-meta/scopes) that passes through to the auth
// service's own org-scopes list, not the QuoxPlan backend.
const META_BASE = '/collector/api/v1/quoxplan-meta';

/** In-memory cache, keyed by request URL. Cleared on full page reload. */
const cache = new Map();

async function request(path, { cacheKey, force = false } = {}) {
  const key = cacheKey ?? path;
  if (!force && cache.has(key)) return cache.get(key);

  // Session cookie authenticates through the collector proxy, mirroring
  // nucleusClient/quoxbrainClient (collector accepts cookie or Bearer).
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
}

export function clearApiCache() {
  cache.clear();
}

/** Drops every cache entry whose key equals or starts with `prefix`. */
function invalidateCache(prefix) {
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Thrown by write-path helpers below. Carries the parsed error body so
 * callers can surface `body.error` and (for dependency mutations) the
 * `body.cycle` chain via lib/cycleError.js's formatCycleError().
 */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `API error ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Governed write helper — the P2 counterpart to `request()`. Never caches;
 * always invalidates the read cache for what it touched so the next
 * `useAsync` retry sees fresh data. Every mutation call site is responsible
 * for stamping `actor: 'owner'` in its body per house rule.
 */
async function mutate(path, { method = 'POST', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new ApiError(res.status, payload);
  }
  return payload;
}

export const api = {
  /** Health probe, special-cased by the collector proxy to the backend's bare /health. Never cached — used for the live health dot. */
  async health() {
    const res = await fetch(`${API_BASE}/health`, { credentials: 'include' });
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
    return res.json();
  },

  /** GET /api/v1/roadmaps -> { roadmaps: [...] } */
  listRoadmaps(opts) {
    return request(`${API_BASE}/roadmaps`, opts);
  },

  /**
   * GET /api/v1/roadmaps/:id/streams?lens=focus|tier|all&scope=<name> ->
   * { roadmap_id, lens, scope, streams }. `scope` (QUOXPLAN-P5) is the
   * division/department name from the scope selector — omit or pass a
   * falsy value for "All scopes" (unfiltered, current behaviour).
   */
  listStreams(roadmapId, lens = 'focus', scope, opts) {
    const qs = new URLSearchParams({ lens });
    if (scope) qs.set('scope', scope);
    return request(`${API_BASE}/roadmaps/${encodeURIComponent(roadmapId)}/streams?${qs}`, {
      cacheKey: `streams:${roadmapId}:${lens}${scope ? `:${scope}` : ''}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/roadmaps/:id/timeline?scope=<name> -> { roadmap_id, scope, timeline }.
   * `scope` (QUOXPLAN-P5) — see listStreams above.
   */
  getTimeline(roadmapId, scope, opts) {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    return request(`${API_BASE}/roadmaps/${encodeURIComponent(roadmapId)}/timeline${qs}`, {
      cacheKey: `timeline:${roadmapId}${scope ? `:${scope}` : ''}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/quoxplan-meta/scopes -> { scopes }. The caller's org's
   * division/department scopes (M-ROOMS scopes model), used to populate the
   * scope selector. Always [] (never an error) when the org has no scopes
   * configured, so the selector hides itself cleanly.
   */
  getScopes(opts) {
    return request(`${META_BASE}/scopes`, { cacheKey: 'scopes', ...opts });
  },

  /** GET /api/v1/streams/:id -> { stream, phases, plan, notes, events, depends_on, dependents } */
  getStream(id, opts) {
    return request(`${API_BASE}/streams/${encodeURIComponent(id)}`, {
      cacheKey: `stream:${id}`,
      ...opts
    });
  },

  /** GET /api/v1/events?since=&roadmap_id=&limit= -> { events } */
  getEvents(params = {}, opts) {
    const qs = new URLSearchParams(params).toString();
    return request(`${API_BASE}/events${qs ? `?${qs}` : ''}`, opts);
  },

  // ── P2 write path — every call stamps actor: 'owner' and invalidates the
  // read cache for whatever it touched. ──────────────────────────────────

  /**
   * PATCH /api/v1/streams/:id -> full stream detail (same shape as
   * getStream). `patch` may include any of name, summary, tier, status,
   * effort, effort_days, tags, depends_on, confirm_owner. 403 when
   * status: 'COMPLETE' is sent without confirm_owner: true; 422 with
   * { error, cycle } on a dependency cycle.
   */
  async patchStream(id, patch) {
    const data = await mutate(`${API_BASE}/streams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { actor: 'owner', ...patch }
    });
    invalidateCache(`stream:${id}`);
    const roadmapId = data?.stream?.roadmap_id;
    if (roadmapId) {
      invalidateCache(`streams:${roadmapId}`);
      invalidateCache(`timeline:${roadmapId}`);
    }
    return data;
  },

  /** POST /api/v1/streams/:id/notes -> note. `actor` defaults to 'owner'; NotesQ passes 'quox-dashboard' (same as the CLI's 'quox-cli'). */
  async addNote(streamId, body, actor = 'owner') {
    const data = await mutate(`${API_BASE}/streams/${encodeURIComponent(streamId)}/notes`, {
      body: { body, author: actor, actor }
    });
    invalidateCache(`stream:${streamId}`);
    return data;
  },

  /** POST /api/v1/streams/:id/phases -> updated ordered phase list. */
  async addPhase(streamId, title) {
    const data = await mutate(`${API_BASE}/streams/${encodeURIComponent(streamId)}/phases`, {
      body: { title, actor: 'owner' }
    });
    invalidateCache(`stream:${streamId}`);
    return data;
  },

  /**
   * PATCH /api/v1/phases/:phaseId -> updated ordered phase list.
   * `streamId` is not part of the URL — it's only needed here to invalidate
   * that stream's cache entry.
   */
  async updatePhase(streamId, phaseId, patch) {
    const data = await mutate(`${API_BASE}/phases/${encodeURIComponent(phaseId)}`, {
      method: 'PATCH',
      body: { actor: 'owner', ...patch }
    });
    invalidateCache(`stream:${streamId}`);
    return data;
  },

  /** DELETE /api/v1/phases/:phaseId -> updated ordered phase list. */
  async deletePhase(streamId, phaseId) {
    const data = await mutate(`${API_BASE}/phases/${encodeURIComponent(phaseId)}`, {
      method: 'DELETE',
      body: { actor: 'owner' }
    });
    invalidateCache(`stream:${streamId}`);
    return data;
  },

  /** PUT /api/v1/streams/:id/plan -> { version }. */
  async putPlan(streamId, body) {
    const data = await mutate(`${API_BASE}/streams/${encodeURIComponent(streamId)}/plan`, {
      method: 'PUT',
      body: { body, actor: 'owner' }
    });
    invalidateCache(`stream:${streamId}`);
    invalidateCache(`plan-versions:${streamId}`);
    return data;
  },

  /** GET /api/v1/streams/:id/plan/versions -> version list. Never cached — the version dropdown must always see the latest write. */
  getPlanVersions(streamId) {
    return request(`${API_BASE}/streams/${encodeURIComponent(streamId)}/plan/versions`, { force: true });
  },

  /** GET /api/v1/streams/:id/plan/versions/:v -> full historical plan body. */
  getPlanVersion(streamId, version) {
    return request(`${API_BASE}/streams/${encodeURIComponent(streamId)}/plan/versions/${encodeURIComponent(version)}`, {
      cacheKey: `plan-version:${streamId}:${version}`
    });
  },

  /**
   * POST /api/v1/roadmaps/:id/reprioritise -> ordered ids. `order` is the
   * full new top-level stream id order for the roadmap.
   */
  async reprioritise(roadmapId, order) {
    const data = await mutate(`${API_BASE}/roadmaps/${encodeURIComponent(roadmapId)}/reprioritise`, {
      body: { order, actor: 'owner' }
    });
    invalidateCache(`streams:${roadmapId}`);
    invalidateCache(`timeline:${roadmapId}`);
    return data;
  },

  /**
   * POST /api/v1/roadmaps -> created roadmap (no open_action_items on this
   * shape yet — the onboarding wizard's "name your roadmap" step calls
   * refreshRoadmaps() on RoadmapContext right after to pick up the full
   * listRoadmaps() shape before navigating).
   */
  async createRoadmap({ id, name, description }) {
    const data = await mutate(`${API_BASE}/roadmaps`, {
      body: { id, name, description: description || null, actor: 'owner' }
    });
    invalidateCache(`${API_BASE}/roadmaps`);
    return data;
  },

  // ── P7 action items ─────────────────────────────────────────────────────

  /** GET /api/v1/streams/:id/action-items -> { stream_id, action_items }. */
  getActionItems(streamId, opts) {
    return request(`${API_BASE}/streams/${encodeURIComponent(streamId)}/action-items`, {
      cacheKey: `action-items:${streamId}`,
      ...opts
    });
  },

  /**
   * GET /api/v1/roadmaps/:id/action-items?status= -> { roadmap_id, status, action_items }.
   * Cross-stream, roadmap-level list used by Focus's open-action-items strip.
   */
  getRoadmapActionItems(roadmapId, status, opts) {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return request(`${API_BASE}/roadmaps/${encodeURIComponent(roadmapId)}/action-items${qs}`, {
      cacheKey: `roadmap-action-items:${roadmapId}${status ? `:${status}` : ''}`,
      ...opts
    });
  },

  /** POST /api/v1/streams/:id/action-items -> created action item. */
  async addActionItem(streamId, { title, due_at } = {}) {
    const data = await mutate(`${API_BASE}/streams/${encodeURIComponent(streamId)}/action-items`, {
      body: { title, due_at: due_at ?? null, actor: 'owner' }
    });
    invalidateCache(`stream:${streamId}`);
    invalidateCache(`action-items:${streamId}`);
    return data;
  },

  /**
   * PATCH /api/v1/action-items/:id -> updated action item. `streamId` is not
   * part of the URL — only needed to invalidate that stream's caches.
   */
  async patchActionItem(streamId, itemId, patch) {
    const data = await mutate(`${API_BASE}/action-items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: { actor: 'owner', ...patch }
    });
    invalidateCache(`stream:${streamId}`);
    invalidateCache(`action-items:${streamId}`);
    return data;
  }
};

/**
 * QuoxLens API client — tiny fetch wrapper against the collector proxy.
 *
 * QUOXLENS-UI: routed through the collector's own /api/v1/lens/* read
 * routes (services/collector/routes/quoxlens.js), NOT a proxy to a separate
 * microservice — QuoxLens has no standalone server the way QuoxSignal does;
 * the collector reads directly off src/config/lenses/ and
 * services/collector/eval/lenses/ on disk. Same client shape as
 * quoxsignal/lib/api.js otherwise: session cookie auth, in-memory
 * per-session cache, never localStorage.
 *
 * EVIDENCE-LIVE added applyLens()/getVerdictEvidence() (POST /apply plus the
 * shared AEE bundle read-back) — every other method here remains read-only;
 * no method mutates a finding's lifecycle. That is still a separate, later
 * phase.
 */

const API_BASE = '/collector/api/v1/lens';

/** In-memory cache, keyed by request URL. Cleared on full page reload. */
const cache = new Map();

async function request(path, { cacheKey, force = false } = {}) {
  const key = cacheKey ?? path;
  if (!force && cache.has(key)) return cache.get(key);

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

/** Build a safe path from a scope that may contain slashes (e.g. "website/homepage"). */
function scopePath(scope) {
  return String(scope)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export const api = {
  /** Health probe for the CommandStrip pill. Never cached. */
  async health() {
    const res = await fetch(`${API_BASE}/health`, { credentials: 'include' });
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
    return res.json();
  },

  /** GET /lenses -> { lenses }. Every Lens with its stance, blind spots, and unproven status. */
  listLenses(opts) {
    return request(`${API_BASE}/lenses`, { cacheKey: 'lenses', ...opts });
  },

  /** GET /lenses/:id -> one Lens in full, including its body and every eval result on disk. */
  getLens(id, opts) {
    return request(`${API_BASE}/lenses/${encodeURIComponent(id)}`, { cacheKey: `lens:${id}`, ...opts });
  },

  /** GET /results -> { results }. Every eval result, newest first, per_artifact trimmed. */
  listResults(opts) {
    return request(`${API_BASE}/results`, { cacheKey: 'results', ...opts });
  },

  /** GET /findings -> { scopes, states }. Lifecycle summary per scope, for leading with what needs attention. */
  listFindingScopes(opts) {
    return request(`${API_BASE}/findings`, { cacheKey: 'findings', ...opts });
  },

  /** GET /findings/<scope> -> one scope in full: every finding, its lifecycle state, and its verbatim evidence quotes. */
  getFindingScope(scope, opts) {
    return request(`${API_BASE}/findings/${scopePath(scope)}`, { cacheKey: `findings:${scope}`, ...opts });
  },

  /**
   * EVIDENCE-LIVE: POST /apply -> a single-lens verdict, per docs/LENS_CONTRACT.md.
   * Never cached (a caller applying twice expects two independent judgements).
   */
  async applyLens(payload) {
    const res = await fetch(`${API_BASE}/apply`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((data && (data.detail || data.error)) || `apply failed: ${res.status}`);
    }
    return data;
  },

  /**
   * EVIDENCE-LIVE: fetch the AEE envelope + VOLT bundle for one Lens
   * application's `evidence.corr` (see applyLens's response). Hits the
   * collector's shared AEE bundle endpoint directly, NOT under
   * /api/v1/lens/* — this is a general collector endpoint, the same one
   * quoxsignal/lib/evidenceApi.js already uses for its own evidence trail.
   * Never throws — a missing/unreachable bundle resolves to null, which
   * buildAppliedEvidenceTrail() treats as "nothing recorded" (MISSING).
   */
  async getVerdictEvidence(corr) {
    if (!corr) return null;
    try {
      const res = await fetch(`/collector/aee/conversation/${encodeURIComponent(corr)}/bundle`, {
        credentials: 'include',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },
};

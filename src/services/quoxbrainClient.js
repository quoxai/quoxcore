/**
 * Quoxbrain Client - Server API client for the QuoxQortex knowledge-graph service
 * Stream QUOXBRAIN #163, P0.4 (frontend)
 *
 * Mirrors memoryClient.js's base-URL resolver + `_fetch` pattern (Bearer +
 * credentials:'include'). Unlike memoryClient there is NO localStorage
 * fallback here — quoxbrain is a server-authoritative knowledge graph over a
 * real vault on disk; there is nothing honest to synthesize client-side when
 * the service is unavailable. Every method throws on failure so the view can
 * render an honest error state instead of fabricating data.
 */

function normalizeQuoxbrainPath(path = '') {
  if (!path) return ''
  return path.startsWith('/') ? path : `/${path}`
}

export function resolveQuoxbrainServiceBase({ env = import.meta.env, location = globalThis?.window?.location } = {}) {
  const explicitBase = env?.VITE_QUOXBRAIN_API_URL
    || env?.VITE_QUOXBRAIN_SERVICE_URL
    || 'http://localhost:3106'

  if (location) {
    const protocol = location.protocol || ''
    const hostname = location.hostname || ''
    const isRemoteBrowser = protocol === 'https:' || !['localhost', '127.0.0.1'].includes(hostname)

    if (isRemoteBrowser) {
      return '/api/quoxbrain'
    }
  }

  if (env?.DEV) {
    return explicitBase.replace(/\/$/, '')
  }

  return '/api/quoxbrain'
}

export function buildQuoxbrainServiceUrl(path = '', options = {}) {
  return `${resolveQuoxbrainServiceBase(options)}${normalizeQuoxbrainPath(path)}`
}

const QUOXBRAIN_SERVICE_URL = resolveQuoxbrainServiceBase()

async function parseErrorBody(res) {
  try {
    const body = await res.json()
    return body?.error || body?.message || null
  } catch {
    return null
  }
}

class QuoxbrainClient {
  constructor() {
    this.token = null
  }

  /**
   * Set authentication token for API calls (Bearer path — mirrors
   * memoryClient; in practice the httpOnly access_token cookie sent via
   * credentials:'include' is what the quoxbrain service's auth middleware
   * accepts, same as every other Quox service).
   */
  setToken(token) {
    this.token = token
  }

  getHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }
    return headers
  }

  /**
   * Internal fetch wrapper — ensures credentials (httpOnly cookies) are always sent.
   */
  _fetch(url, options = {}) {
    return fetch(url, {
      credentials: 'include',
      ...options,
      headers: { ...this.getHeaders(), ...options.headers }
    })
  }

  // ==========================================================================
  // VAULTS
  // ==========================================================================

  /** GET /vaults — org's registered vaults. */
  async listVaults() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/vaults`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** POST /vaults {name, source_path, source_type?, scope?} — register (and synchronously index). */
  async createVault({ name, source_path, source_type = 'local', scope = 'org' }) {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/vaults`, {
      method: 'POST',
      body: JSON.stringify({ name, source_path, source_type, scope })
    })
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** POST /vaults/:id/reindex — re-walk the vault, update notes/edges. */
  async reindexVault(id) {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/vaults/${id}/reindex`, {
      method: 'POST'
    })
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** GET /vaults/:id/graph → {nodes, edges} (resolved edges only). */
  async getGraph(vaultId) {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/vaults/${vaultId}/graph`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** GET /vaults/:id/notes?q&limit&offset — listing/browsing (q -> FTS5). */
  async listNotes(vaultId, { q, limit, offset } = {}) {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (limit != null) params.set('limit', String(limit))
    if (offset != null) params.set('offset', String(offset))
    const qs = params.toString()
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/vaults/${vaultId}/notes${qs ? `?${qs}` : ''}`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** GET /vaults/:id/tags → [{tag, count}]. */
  async getTags(vaultId) {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/vaults/${vaultId}/tags`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** GET /vaults/:id/search?q — keyword search (FTS5, falls back to LIKE server-side). */
  async searchNotes(vaultId, q) {
    const params = new URLSearchParams({ q })
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/vaults/${vaultId}/search?${params}`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  // ==========================================================================
  // BRAIN (P2.5b-2) — scope-union reads across every vault the caller can see
  // (org + own user-scope + shared), with sources/scopes/languages as
  // narrowing facets instead of a per-vault picker. `facets` is always
  // {sources?, scopes?, languages?, limit?} — arrays travel as CSV on the GET
  // querystring, JSON arrays in the POST body (mirrors the server's two
  // parsing conventions in services/quoxbrain/server.js).
  // ==========================================================================

  /** GET /brain/sources -> {sources, scopes, languages, totalNotes} — facet metadata for the whole brain. */
  async getBrainSources() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/sources`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** GET /brain/graph?sources=&scopes=&languages=&limit= -> {nodes, edges, truncated, total} — the union graph. */
  async getBrainGraph({ sources, scopes, languages, limit } = {}) {
    const params = new URLSearchParams()
    if (Array.isArray(sources) && sources.length > 0) params.set('sources', sources.join(','))
    if (Array.isArray(scopes) && scopes.length > 0) params.set('scopes', scopes.join(','))
    if (Array.isArray(languages) && languages.length > 0) params.set('languages', languages.join(','))
    if (limit != null) params.set('limit', String(limit))
    const qs = params.toString()
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/graph${qs ? `?${qs}` : ''}`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** POST /brain/search {query, limit?, sources?, scopes?, languages?} -> {results, tookMs}. */
  async brainSearch(query, { sources, scopes, languages, limit = 20 } = {}) {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/search`, {
      method: 'POST',
      body: JSON.stringify({ query, limit, sources, scopes, languages })
    })
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /** GET /brain/suggestions -> {suggestions:[{question,reason,source,noteId}], message?, generatedAt} (corpus-derived "Ask Qortex" starters). */
  async brainSuggestions({ count = 8 } = {}) {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/suggestions?count=${encodeURIComponent(count)}`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /**
   * GET /brain/status -> { noteCount, sources:[{vaultId,name,count}], status:'dormant'|'forming'|'growing'|'alive'|'dense',
   * milestone:{next,current,remaining,label}|null, embeddings:{total,embedded,missing,percent} }:
   * the growth-story heartbeat (BRAIN2-PRODUCT Phase D) plus semantic-search
   * embedding coverage (a service-key caller instead gets embeddings.byOrg,
   * an array of the same shape per org, not used by this client since a JWT
   * user always gets the flat own-org shape above).
   */
  async getBrainStatus() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/status`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /**
   * GET /brain/usage -> { week: {search,context,note_read,graph,byExternalSource},
   * total: {same shape}, lastAgentQueryAt: ISO|null, lastSearchAt: ISO|null }:
   * the usage ledger (BRAIN2-PRODUCT P3a) — makes "is it used?" a visible
   * number for the settings cockpit's Usage card, instead of an inference.
   */
  async getUsage() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/usage`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /**
   * GET /brain/egress -> { egress, excludeTokens, vaults, effective } (BRAIN2-V3 B4):
   * what leaves this instance (embedding provider+model, whether QuoxDream
   * sends note text to the LLM, agent passage egress) plus the effective
   * value + source of the Qortex tuning knobs, read from live config.
   */
  async getEgress() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/egress`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  /**
   * GET /brain/config/effective -> { knobs: [{ key, effective, source, restartRequired,
   * scope, note? }] } (BRAIN2-V2 V2-10): what the RUNNING brain uses for every
   * allowlisted QUOXBRAIN_* knob and where that value came from. Org admin only.
   */
  async getEffectiveConfig() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/config/effective`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  // ==========================================================================
  // CAPTURE (BRAIN2-V3 A2)
  // ==========================================================================

  /**
   * POST /brain/capture -> { noteId, status: created|updated|unchanged, title }.
   * Writes into the caller's NotesQ vault server-side (editable in NotesQ,
   * searchable immediately). Send `text`, or `url` alone to clip a page.
   */
  async captureNote({ text, title, url, tags, scope } = {}) {
    const body = {}
    if (scope === 'org' || scope === 'user') body.scope = scope // BRAIN2-W7 E 135
    if (text) body.text = text
    if (title) body.title = title
    if (url) body.url = url
    if (tags && tags.length) body.tags = tags
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }

  // Recoverable capture draft (BRAIN2-W8): server-side, org + user scoped.
  /** GET /brain/capture/draft -> {title,text,updatedAt}|null */
  async getCaptureDraft() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/capture/draft`)
    if (!res.ok) throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    return (await res.json()).draft || null
  }

  /** PUT /brain/capture/draft {title,text}; a blank draft clears it server-side. */
  async saveCaptureDraft({ title = '', text = '' } = {}) {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/capture/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text })
    })
    if (!res.ok) throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    return (await res.json()).draft || null
  }

  /** DELETE /brain/capture/draft */
  async clearCaptureDraft() {
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/brain/capture/draft`, { method: 'DELETE' })
    if (!res.ok) throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    return null
  }

  // ==========================================================================
  // NOTES
  // ==========================================================================

  /**
   * GET /notes/:id[?range=charStart:charEnd] → {title, frontmatter, body, tags,
   * backlinks, outlinks, truncated?}. Without `range`, the server caps body at
   * its preview size and flags `truncated`. Pass `range` (matches the
   * server's own `range` querystring contract) to fetch a further char slice
   * for progressive "Load more" reads once a note comes back truncated —
   * BRAIN2-PRODUCT P1d.
   */
  async getNote(id, { range } = {}) {
    const qs = range ? `?range=${encodeURIComponent(range)}` : ''
    const res = await this._fetch(`${QUOXBRAIN_SERVICE_URL}/notes/${id}${qs}`)
    if (!res.ok) {
      throw new Error((await parseErrorBody(res)) || `HTTP ${res.status}`)
    }
    return res.json()
  }
}

// Singleton instance (mirrors getMemoryClient()).
let quoxbrainClientInstance = null

export function getQuoxbrainClient() {
  if (!quoxbrainClientInstance) {
    quoxbrainClientInstance = new QuoxbrainClient()
  }
  return quoxbrainClientInstance
}

export default QuoxbrainClient

// ==========================================================================
// BRAIN OVERVIEW (BRAIN2-PRODUCT P2a) — the all-orgs "one brain" header stat.
//
// Deliberately NOT a method on QuoxbrainClient above: every method on that
// class talks to the quoxbrain service directly (QUOXBRAIN_SERVICE_URL /
// `/api/quoxbrain`), which is single-org by construction (the service scopes
// every read to the caller's current org). The overview is a cross-org RBAC
// summary the COLLECTOR computes (only orgs the caller belongs to), so this
// mirrors brain2FeedClient.js's `{authFetch}` pattern instead — same
// collector-origin `/collector/api/*` path, same caller-supplied authFetch
// (from useAuth()), no localStorage fallback (server-authoritative).
// ==========================================================================

const BRAIN_OVERVIEW_PROXY_PATH = '/collector/api/brain/overview'

/**
 * GET /collector/api/brain/overview -> { total, orgs: [{org_id, noteCount, newestNoteAt|null, error?}] }
 *
 * Returns `null` (not a throw) on a 404 specifically — that's the
 * feature-detection signal for "collector hasn't been rebuilt with this
 * route yet", which callers should treat as graceful degradation, not an
 * error to surface. Any other non-2xx still throws.
 */
export async function getBrainOverview({ authFetch } = {}) {
  if (!authFetch) return null
  const res = await authFetch(BRAIN_OVERVIEW_PROXY_PATH)
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const message = body?.error?.message || body?.error || body?.message || `HTTP ${res.status}`
    const err = new Error(message)
    err.status = res.status
    throw err
  }
  return res.json()
}

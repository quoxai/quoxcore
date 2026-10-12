/**
 * Memory Client - Server-side memory API with localStorage fallback
 * Phase 5 of Memory Overhaul (#153)
 *
 * Provides a clean API for the memory service with automatic fallback
 * to localStorage when the server is unavailable.
 */

import { orgGet, orgSet, personalGet, personalSet } from './orgScopedStorage'

function normalizeMemoryPath(path = '') {
  if (!path) return ''
  return path.startsWith('/') ? path : `/${path}`
}

export function resolveMemoryServiceBase({ env = import.meta.env, location = globalThis?.window?.location } = {}) {
  const explicitBase = env?.VITE_MEMORY_API_URL
    || env?.VITE_MEMORY_SERVICE_URL
    || 'http://localhost:3103'

  if (location) {
    const protocol = location.protocol || ''
    const hostname = location.hostname || ''
    const isRemoteBrowser = protocol === 'https:' || !['localhost', '127.0.0.1'].includes(hostname)

    if (isRemoteBrowser) {
      return '/api/memory'
    }
  }

  if (env?.DEV) {
    return explicitBase.replace(/\/$/, '')
  }

  return '/api/memory'
}

export function buildMemoryServiceUrl(path = '', options = {}) {
  return `${resolveMemoryServiceBase(options)}${normalizeMemoryPath(path)}`
}

const MEMORY_SERVICE_URL = resolveMemoryServiceBase()
const MIGRATION_KEY = 'quox_memory_migrated_v1'

class MemoryClient {
  constructor() {
    this.serverAvailable = null // null = unknown, true/false after check
    this.lastHealthCheck = 0
    this.healthCheckInterval = 30000 // 30 seconds
    this.token = null
    // Issue #165 fix: Pending writes loaded lazily on first flush/save
    this.pendingWrites = null
  }

  /**
   * Load pending writes from localStorage (lazy — called on first access)
   */
  loadPendingWrites() {
    try {
      const stored = personalGet('mem-pending')
      return stored ? JSON.parse(stored) : []
    } catch (err) {
      console.warn('[MemoryClient] Failed to load pending writes:', err.message)
      return []
    }
  }

  /**
   * Get pending writes, lazy-loading from localStorage on first access
   */
  getPendingWrites() {
    if (this.pendingWrites === null) {
      this.pendingWrites = this.loadPendingWrites()
    }
    return this.pendingWrites
  }

  /**
   * Persist pending writes to localStorage
   */
  savePendingWrites() {
    try {
      personalSet('mem-pending', JSON.stringify(this.getPendingWrites()))
    } catch (err) {
      console.warn('[MemoryClient] Failed to save pending writes:', err.message)
    }
  }

  /**
   * Set authentication token for API calls
   */
  setToken(token) {
    this.token = token
  }

  /**
   * Check if memory service is available
   */
  async checkHealth() {
    const now = Date.now()
    if (this.serverAvailable !== null && now - this.lastHealthCheck < this.healthCheckInterval) {
      return this.serverAvailable
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)

      const res = await this._fetch(`${MEMORY_SERVICE_URL}/health`, {
        signal: controller.signal
      })
      clearTimeout(timeout)

      this.serverAvailable = res.ok
      this.lastHealthCheck = now

      if (this.serverAvailable && this.getPendingWrites().length > 0) {
        this.flushPendingWrites()
      }

      return this.serverAvailable
    } catch (err) {
      console.warn('[MemoryClient] Health check failed:', err.message)
      this.serverAvailable = false
      this.lastHealthCheck = now
      return false
    }
  }

  /**
   * Get authorization headers
   */
  getHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }
    return headers
  }

  /**
   * Internal fetch wrapper — ensures credentials (httpOnly cookies) are always sent
   */
  _fetch(url, options = {}) {
    return fetch(url, {
      credentials: 'include',
      ...options,
      headers: { ...this.getHeaders(), ...options.headers }
    })
  }

  // ==========================================================================
  // MEMORIES API
  // ==========================================================================

  /**
   * Save a memory
   * @param {object} memory - { type, content, importance?, tags? }
   */
  async saveMemory(memory) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory`, {
          method: 'POST',
          body: JSON.stringify({
            memory_type: memory.type,
            content: memory.content,
            importance: memory.importance || 'medium',
            tags: memory.tags || [],
            agent_id: memory.agentId,
            source_conversation_id: memory.conversationId
          })
        })

        if (!res.ok) {
          // quox#571 part 3: a quota rejection is a VERDICT, not an outage.
          // The old path threw a bare `HTTP 403`, marked the healthy server
          // unavailable, and "saved" into localStorage — so background
          // extraction silently stopped learning server-side and nobody knew.
          // A quota-refused write must fail honestly, not fall back.
          let body = null
          try { body = await res.json() } catch { /* non-JSON error body */ }
          if (res.status === 403) {
            const reason = body?.reason || body?.error || 'Memory quota exceeded'
            console.error(`[MemoryClient] Memory write REFUSED by quota (not saved anywhere): ${reason}`)
            try {
              window.dispatchEvent(new CustomEvent('quox:memory-quota-exceeded', {
                detail: { reason, limit: body?.limit, current: body?.current, upgrade: body?.upgrade || null },
              }))
            } catch { /* non-browser context */ }
            return { success: false, quota_exceeded: true, error: reason, limit: body?.limit, current: body?.current }
          }
          throw new Error(body?.error ? `HTTP ${res.status}: ${body.error}` : `HTTP ${res.status}`)
        }

        return await res.json()
      } catch (err) {
        console.warn('[MemoryClient] Server save failed, using localStorage:', err.message)
        this.serverAvailable = false
      }
    }

    // Fallback to localStorage
    return this.saveMemoryLocal(memory)
  }

  /**
   * Save memory to localStorage (fallback)
   */
  saveMemoryLocal(memory) {
    const baseKey = `learned-${memory.type}`
    const existing = JSON.parse(personalGet(baseKey) || '[]')
    const newMemory = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      ...memory,
      created_at: new Date().toISOString()
    }
    existing.push(newMemory)
    personalSet(baseKey, JSON.stringify(existing.slice(-100))) // Keep last 100

    // Queue for later sync (Issue #165: persisted to localStorage)
    this.getPendingWrites().push({ type: 'memory', data: memory })
    this.savePendingWrites()

    // SAY WHERE IT LANDED. The queue makes this recoverable rather than lost,
    // but it is NOT yet durable: it lives in one browser until a sync
    // succeeds, so clearing site data or never returning loses it.
    //
    // saveMemory() returns this object straight to its caller, and the caller
    // previously could not distinguish it from a server write. A UI that says
    // "Saved" for both is making a durability claim it cannot support, which
    // is the exact shape the house persistence rule exists to prevent.
    // Callers that do not check these flags behave as before.
    return { ...newMemory, durable: false, pending_sync: true, storage: 'local' }
  }

  /**
   * List memories with optional filters (no search query required)
   * @param {object} options - { type?, limit?, offset? }
   */
  async getMemories({ type, limit = 50, offset = 0 } = {}) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const params = new URLSearchParams({ limit: limit.toString(), offset: offset.toString() })
        if (type && type !== 'all') {
          params.set('memory_type', type)
        }

        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory?${params}`)

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        const data = await res.json()
        return data.memories || data.results || []
      } catch (err) {
        console.warn('[MemoryClient] Server list failed, using localStorage:', err.message)
        this.serverAvailable = false
      }
    }

    // Fallback to localStorage
    const types = type && type !== 'all' ? [type] : ['preference', 'fact', 'decision', 'constraint', 'observation']
    const results = []
    for (const t of types) {
      const data = JSON.parse(personalGet(`learned-${t}`) || '[]')
      for (const item of data) {
        results.push({ ...item, memory_type: t })
      }
    }
    return results
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(offset, offset + limit)
  }

  /**
   * Search memories
   * @param {object} options - { query, type?, limit? }
   */
  async searchMemories({ query, type, limit = 10 }) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const params = new URLSearchParams({ q: query, limit: limit.toString() })
        if (type && type !== 'all') {
          params.set('type', type)
        }

        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/search?${params}`)

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        const data = await res.json()
        return data.results || []
      } catch (err) {
        console.warn('[MemoryClient] Server search failed, using localStorage:', err.message)
        this.serverAvailable = false
      }
    }

    // Fallback to localStorage search
    return this.searchMemoriesLocal(query, type, limit)
  }

  /**
   * Search memories in localStorage (fallback)
   */
  searchMemoriesLocal(query, type, limit) {
    const results = []
    const queryLower = query.toLowerCase()
    const types = type && type !== 'all' ? [type] : ['preference', 'fact', 'decision', 'constraint', 'observation']

    for (const t of types) {
      const data = JSON.parse(personalGet(`learned-${t}`) || '[]')
      for (const item of data) {
        if (item.content && item.content.toLowerCase().includes(queryLower)) {
          results.push({ ...item, memory_type: t })
        }
      }
    }

    // Sort by recency and limit
    return results
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit)
  }

  /**
   * Get memory by ID
   */
  async getMemory(id) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/${id}`)

        if (!res.ok) {
          if (res.status === 404) return null
          throw new Error(`HTTP ${res.status}`)
        }

        return await res.json()
      } catch (err) {
        console.warn('[MemoryClient] Server get failed:', err.message)
      }
    }

    // Fallback: search localStorage for matching ID
    for (const type of ['preference', 'fact', 'decision', 'constraint', 'observation']) {
      const data = JSON.parse(personalGet(`learned-${type}`) || '[]')
      const found = data.find(m => m.id === id)
      if (found) return { ...found, memory_type: type }
    }

    return null
  }

  /**
   * Update a memory
   */
  async updateMemory(id, updates) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(updates)
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        return await res.json()
      } catch (err) {
        console.warn('[MemoryClient] Server update failed:', err.message)
      }
    }

    // Fallback: update in localStorage
    for (const type of ['preference', 'fact', 'decision', 'constraint', 'observation']) {
      const baseKey = `learned-${type}`
      const data = JSON.parse(personalGet(baseKey) || '[]')
      const idx = data.findIndex(m => m.id === id)
      if (idx !== -1) {
        data[idx] = { ...data[idx], ...updates, updated_at: new Date().toISOString() }
        personalSet(baseKey, JSON.stringify(data))
        return data[idx]
      }
    }

    return null
  }

  /**
   * Delete a memory
   */
  async deleteMemory(id) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/${id}`, {
          method: 'DELETE'
        })

        if (!res.ok && res.status !== 404) {
          throw new Error(`HTTP ${res.status}`)
        }

        return { deleted: true }
      } catch (err) {
        console.warn('[MemoryClient] Server delete failed:', err.message)
      }
    }

    // Fallback: delete from localStorage
    for (const type of ['preference', 'fact', 'decision', 'constraint', 'observation']) {
      const baseKey = `learned-${type}`
      const data = JSON.parse(personalGet(baseKey) || '[]')
      const filtered = data.filter(m => m.id !== id)
      if (filtered.length !== data.length) {
        personalSet(baseKey, JSON.stringify(filtered))
        return { deleted: true }
      }
    }

    return { deleted: false }
  }

  /**
   * Save memories in batch via POST /api/memory/batch
   * @param {Array} memories - Array of { type, content, importance?, tags?, source_conversation_id? }
   * @returns {Promise<object>} { memories_created, errors }
   */
  async saveBatch(memories) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/batch`, {
          method: 'POST',
          body: JSON.stringify({
            memories: memories.map(m => ({
              memory_type: m.type || m.memory_type || 'fact',
              content: m.content,
              importance: m.importance || 'medium',
              tags: m.tags || [],
              provenance: m.provenance || 'import',
              source_conversation_id: m.source_conversation_id || null
            }))
          })
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        return await res.json()
      } catch (err) {
        console.warn('[MemoryClient] Server batch save failed, falling back to localStorage:', err.message)
        this.serverAvailable = false
      }
    }

    // Fallback: save individually to localStorage
    let saved = 0
    for (const m of memories) {
      this.saveMemoryLocal(m)
      saved++
    }
    return { memories_created: saved, errors: [], fallback: true }
  }

  // ==========================================================================
  // ENTITIES API
  // ==========================================================================

  /**
   * Create or update an entity
   */
  async saveEntity(entity) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/entity`, {
          method: 'POST',
          body: JSON.stringify({
            name: entity.name,
            entity_type: entity.type,
            attributes: entity.attributes || {}
          })
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        return await res.json()
      } catch (err) {
        console.warn('[MemoryClient] Server entity save failed:', err.message)
      }
    }

    // Fallback to localStorage
    return this.saveEntityLocal(entity)
  }

  /**
   * Save entity to localStorage (fallback)
   * Issue #165 fix: Added pending queue for later sync (consistent with saveMemoryLocal)
   */
  saveEntityLocal(entity) {
    const existing = JSON.parse(orgGet('entities') || '[]')

    // Check if exists
    const idx = existing.findIndex(e => e.name === entity.name && e.type === entity.type)
    const newEntity = {
      id: entity.id || `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      name: entity.name,
      entity_type: entity.type,
      attributes: entity.attributes || {},
      created_at: new Date().toISOString()
    }

    if (idx !== -1) {
      // Update existing
      existing[idx] = { ...existing[idx], ...newEntity, updated_at: new Date().toISOString() }
    } else {
      existing.push(newEntity)
    }

    orgSet('entities', JSON.stringify(existing.slice(-500))) // Keep last 500

    // Queue for later sync (Issue #165: persisted to localStorage)
    this.getPendingWrites().push({ type: 'entity', data: entity })
    this.savePendingWrites()

    return newEntity
  }

  /**
   * Search entities
   */
  async searchEntities({ query, type, limit = 10 }) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const params = new URLSearchParams({ q: query, limit: limit.toString() })
        if (type) {
          params.set('type', type)
        }

        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/entity/search?${params}`)

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        const data = await res.json()
        return data.results || []
      } catch (err) {
        console.warn('[MemoryClient] Server entity search failed:', err.message)
      }
    }

    // Fallback to localStorage
    const entities = JSON.parse(orgGet('entities') || '[]')
    const queryLower = query.toLowerCase()

    return entities
      .filter(e => {
        if (type && e.entity_type !== type) return false
        if (e.name.toLowerCase().includes(queryLower)) return true
        if (e.attributes && JSON.stringify(e.attributes).toLowerCase().includes(queryLower)) return true
        return false
      })
      .slice(0, limit)
  }

  /**
   * Get all entities
   */
  async getEntities({ type, limit = 50 } = {}) {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const params = new URLSearchParams({ limit: limit.toString() })
        if (type) {
          params.set('type', type)
        }

        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/entity?${params}`)

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        const data = await res.json()
        return data.entities || []
      } catch (err) {
        console.warn('[MemoryClient] Server entity list failed:', err.message)
      }
    }

    // Fallback to localStorage
    const entities = JSON.parse(orgGet('entities') || '[]')
    return entities
      .filter(e => !type || e.entity_type === type)
      .slice(0, limit)
  }

  /**
   * Get a single entity with its relations (GET /api/entity/:id).
   * Used by the knowledge graph view to build real edges from
   * entity_relations — never fabricated. Returns null on any failure
   * (server down, 404, network error) rather than throwing, so callers
   * can skip that entity's edges honestly instead of crashing the graph.
   */
  async getEntity(id) {
    const serverOk = await this.checkHealth()
    if (!serverOk) return null

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/entity/${id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn('[MemoryClient] Server entity fetch failed:', err.message)
      return null
    }
  }

  // ==========================================================================
  // CORE MEMORIES API
  // ==========================================================================

  /**
   * Get core memories for an agent
   *
   * TRUST-GATE-1.9: the server is authoritative for core memories. On any
   * failure (server down, non-2xx, network error) this logs loudly and
   * throws — it does NOT silently fall back to a stale localStorage copy.
   * Callers that want offline resilience must catch and decide explicitly.
   */
  async getCoreMemories(agentId = 'quox') {
    const serverOk = await this.checkHealth()

    if (!serverOk) {
      const err = new Error('[MemoryClient] Core memory server unavailable — refusing silent localStorage fallback')
      console.error(err.message, { agentId })
      throw err
    }

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/core?agent_id=${agentId}`)

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      }

      const data = await res.json()
      return data.memories || []
    } catch (err) {
      console.error('[MemoryClient] Server core memories fetch failed:', err.message, { agentId })
      throw err
    }
  }

  /**
   * Set a core memory
   *
   * TRUST-GATE-1.9: writes to the server via PUT /api/memory/core (upsert).
   * On failure this logs loudly and throws instead of silently writing to
   * localStorage — a silent local write would lie to the caller about
   * whether the memory actually persisted server-side.
   */
  async setCoreMemory(agentId, label, content) {
    const serverOk = await this.checkHealth()

    if (!serverOk) {
      const err = new Error('[MemoryClient] Core memory server unavailable — refusing silent localStorage fallback')
      console.error(err.message, { agentId, label })
      throw err
    }

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/core`, {
        method: 'PUT',
        body: JSON.stringify({ agent_id: agentId, label, content })
      })

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      }

      return await res.json()
    } catch (err) {
      console.error('[MemoryClient] Server core memory set failed:', err.message, { agentId, label })
      throw err
    }
  }

  // ==========================================================================
  // IDENTITY API (TRUST-GATE-1.15 / 1.16)
  // ==========================================================================

  // ==========================================================================
  // DECISIONS (belief timeline + reinstate) - server-side only, no fallback
  // ==========================================================================

  async _jsonOrThrow(res) {
    if (!res.ok) {
      let msg = ''
      try { msg = (await res.json())?.error || '' } catch { /* error body is not data */ }
      const err = new Error(msg || `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return res.json()
  }

  /** GET /api/memory/timeline?q&limit -> { decisions: [...] } */
  async getDecisionTimeline({ q = '', limit = 20 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (q) params.set('q', q)
    const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/timeline?${params}`)
    return this._jsonOrThrow(res)
  }

  /** GET /api/memory/:id/history -> { history: [...] } */
  async getMemoryHistory(id) {
    const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/${encodeURIComponent(id)}/history`)
    return this._jsonOrThrow(res)
  }

  /** POST /api/memory/:id/reinstate -> { reinstated, retired } (403 / 409 carry err.status) */
  async reinstateMemory(id) {
    const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/${encodeURIComponent(id)}/reinstate`, { method: 'POST' })
    return this._jsonOrThrow(res)
  }

  /**
   * Get a namespaced identity blob (profile, projects, narratives,
   * syntheses, trends, personalization, reflection_state,
   * importance_evolution, alerts).
   *
   * TRUST-GATE-1.15: the server is authoritative for the user's memory
   * identity. On any failure (server down, non-2xx, network error) this
   * logs loudly and throws — it does NOT silently fall back to a stale or
   * empty value. Callers (memoryManager's write-through/hydration helpers)
   * decide what to do on failure.
   *
   * @returns {Promise<{namespace: string, data: any, updated_at: string|null}>}
   */
  async getIdentity(namespace) {
    const serverOk = await this.checkHealth()

    if (!serverOk) {
      const err = new Error('[MemoryClient] Identity server unavailable — refusing silent fallback')
      console.error(err.message, { namespace })
      throw err
    }

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/identity/${namespace}`)

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      }

      return await res.json()
    } catch (err) {
      console.error('[MemoryClient] Server identity fetch failed:', err.message, { namespace })
      throw err
    }
  }

  /**
   * Set a namespaced identity blob.
   *
   * TRUST-GATE-1.15: writes to the server via PUT /api/memory/identity/:namespace
   * (full-document upsert). On failure this logs loudly and throws instead
   * of silently succeeding — a silent failure here would lie to the caller
   * about whether the user's identity data actually persisted server-side.
   */
  async setIdentity(namespace, data) {
    const serverOk = await this.checkHealth()

    if (!serverOk) {
      const err = new Error('[MemoryClient] Identity server unavailable — refusing silent fallback')
      console.error(err.message, { namespace })
      throw err
    }

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/identity/${namespace}`, {
        method: 'PUT',
        body: JSON.stringify({ data })
      })

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`)
      }

      return await res.json()
    } catch (err) {
      console.error('[MemoryClient] Server identity set failed:', err.message, { namespace })
      throw err
    }
  }

  // ==========================================================================
  // MIGRATION
  // ==========================================================================

  /**
   * Check if migration has been completed
   */
  isMigrated() {
    return localStorage.getItem(MIGRATION_KEY) !== null
  }

  /**
   * Migrate localStorage data to server
   */
  async migrate() {
    if (this.isMigrated()) {
      console.log('[MemoryClient] Already migrated')
      return { migrated: true, skipped: true }
    }

    const serverOk = await this.checkHealth()
    if (!serverOk) {
      console.warn('[MemoryClient] Server not available, skipping migration')
      return { migrated: false, reason: 'server_unavailable' }
    }

    console.log('[MemoryClient] Starting migration...')

    const memories = []
    const entities = []

    // Collect learned memories
    for (const type of ['preference', 'fact', 'decision', 'constraint', 'observation']) {
      const items = JSON.parse(personalGet(`learned-${type}`) || '[]')
      for (const item of items) {
        memories.push({
          memory_type: type,
          content: item.content,
          importance: item.importance || 'medium',
          tags: item.tags || [],
          created_at: item.created_at
        })
      }
    }

    // Collect entities
    const entityData = JSON.parse(orgGet('entities') || '[]')
    for (const entity of entityData) {
      entities.push({
        name: entity.name,
        entity_type: entity.type || entity.entity_type,
        attributes: entity.attributes || {}
      })
    }

    console.log(`[MemoryClient] Migrating ${memories.length} memories and ${entities.length} entities`)

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/migrate`, {
        method: 'POST',
        body: JSON.stringify({ memories, entities })
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      const result = await res.json()
      localStorage.setItem(MIGRATION_KEY, new Date().toISOString())
      console.log('[MemoryClient] Migration complete:', result)

      return { migrated: true, ...result }
    } catch (err) {
      console.error('[MemoryClient] Migration failed:', err)
      return { migrated: false, error: err.message }
    }
  }

  /**
   * Flush pending writes when server becomes available
   * Issue #165 fix: Persist queue after modifications
   * Issue #167 fix: Added retry limit to prevent infinite loops
   */
  async flushPendingWrites() {
    const writes = this.getPendingWrites()
    if (writes.length === 0) return

    const MAX_RETRIES = 3

    console.log(`[MemoryClient] Flushing ${writes.length} pending writes`)

    const toFlush = writes.splice(0, writes.length)
    this.savePendingWrites() // Persist empty queue

    for (const item of toFlush) {
      try {
        // Direct API call without local fallback to avoid re-queuing
        const url = item.type === 'memory'
          ? `${MEMORY_SERVICE_URL}/api/memory`
          : `${MEMORY_SERVICE_URL}/api/entity`

        const res = await this._fetch(url, {
          method: 'POST',
          body: JSON.stringify(item.data)
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
      } catch (err) {
        console.warn('[MemoryClient] Failed to flush item:', err.message)

        // Track retries and re-queue only if under limit
        const retries = (item.retries || 0) + 1
        if (retries < MAX_RETRIES) {
          writes.push({ ...item, retries })
        } else {
          console.warn('[MemoryClient] Dropping item after max retries:', item.type, item.data?.content?.slice(0, 50))
        }
      }
    }

    // Persist any re-queued items
    if (writes.length > 0) {
      this.savePendingWrites()
    }
  }

  // ==========================================================================
  // CONVERSATION ARCHIVES
  // ==========================================================================

  /**
   * Batch save conversations with messages
   * @param {Array} conversations - Array of { conversation_id, platform, title, messages[], topics, metadata }
   */
  async saveConversationBatch(conversations) {
    const serverOk = await this.checkHealth()
    if (!serverOk) {
      console.warn('[MemoryClient] Server unavailable, cannot save conversations')
      return { saved: 0, skipped: 0, errors: [{ error: 'server_unavailable' }] }
    }

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/conversations/batch`, {
        method: 'POST',
        body: JSON.stringify({ conversations })
      })

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }

      return await res.json()
    } catch (err) {
      console.warn('[MemoryClient] Conversation batch save failed:', err.message)
      return { saved: 0, skipped: 0, errors: [{ error: err.message }] }
    }
  }

  /**
   * List conversations with filters
   */
  async getConversations({ platform, limit = 50, offset = 0 } = {}) {
    const serverOk = await this.checkHealth()
    if (!serverOk) return []

    try {
      const params = new URLSearchParams({ limit: limit.toString(), offset: offset.toString() })
      if (platform) params.set('platform', platform)

      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/conversations?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      return data.conversations || []
    } catch (err) {
      console.warn('[MemoryClient] Conversation list failed:', err.message)
      return []
    }
  }

  /**
   * Get a single conversation with all messages
   */
  async getConversation(id) {
    const serverOk = await this.checkHealth()
    if (!serverOk) return null

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/conversations/${id}`)
      if (!res.ok) {
        if (res.status === 404) return null
        throw new Error(`HTTP ${res.status}`)
      }
      return await res.json()
    } catch (err) {
      console.warn('[MemoryClient] Conversation get failed:', err.message)
      return null
    }
  }

  /**
   * Search conversations using FTS5
   */
  async searchConversations(query, { platform, limit = 20 } = {}) {
    const serverOk = await this.checkHealth()
    if (!serverOk) return []

    try {
      const params = new URLSearchParams({ q: query, limit: limit.toString() })
      if (platform) params.set('platform', platform)

      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/conversations/search?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      return data.results || []
    } catch (err) {
      console.warn('[MemoryClient] Conversation search failed:', err.message)
      return []
    }
  }

  /**
   * Get conversation archive stats
   */
  async getConversationStats() {
    const serverOk = await this.checkHealth()
    if (!serverOk) return { conversations: 0, messages: 0, by_platform: {} }

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/conversations/stats`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn('[MemoryClient] Conversation stats failed:', err.message)
      return { conversations: 0, messages: 0, by_platform: {} }
    }
  }

  // ==========================================================================
  // QUOTA API
  // ==========================================================================

  /**
   * Get server-authoritative quota and tier info for current user
   * @returns {Promise<object|null>} { quota, limits, tier } or null if unavailable
   */
  async getQuota() {
    const serverOk = await this.checkHealth()
    if (!serverOk) return null

    try {
      const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/quota`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn('[MemoryClient] Quota fetch failed:', err.message)
      return null
    }
  }

  // ==========================================================================
  // STATS
  // ==========================================================================

  /**
   * Get memory statistics
   */
  async getStats() {
    const serverOk = await this.checkHealth()

    if (serverOk) {
      try {
        const res = await this._fetch(`${MEMORY_SERVICE_URL}/api/memory/stats`)

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        return await res.json()
      } catch (err) {
        console.warn('[MemoryClient] Server stats failed:', err.message)
      }
    }

    // Fallback: calculate from localStorage
    const stats = {
      memories: { total: 0, by_type: {} },
      entities: { total: 0 },
      server_available: this.serverAvailable,
      pending_writes: this.getPendingWrites().length
    }

    for (const type of ['preference', 'fact', 'decision', 'constraint', 'observation']) {
      const count = JSON.parse(personalGet(`learned-${type}`) || '[]').length
      stats.memories.by_type[type] = count
      stats.memories.total += count
    }

    stats.entities.total = JSON.parse(orgGet('entities') || '[]').length

    return stats
  }
}

// Singleton instance
let memoryClientInstance = null

// Reset singleton on org switch so pending writes and health state reset for new org
if (typeof window !== 'undefined') {
  window.addEventListener('quox-org-switch', () => {
    if (memoryClientInstance) {
      memoryClientInstance.pendingWrites = null
      memoryClientInstance.serverAvailable = null
      memoryClientInstance.lastHealthCheck = 0
    }
  })
}

export function getMemoryClient() {
  if (!memoryClientInstance) {
    memoryClientInstance = new MemoryClient()
  }
  return memoryClientInstance
}

export default MemoryClient

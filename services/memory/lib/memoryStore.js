// Memory CRUD operations
import { ulid } from 'ulid'
import { getDatabase } from './db.js'

// =============================================================================
// QSKL-13: memory_role write guard
// Only 'fact' is accepted for new writes.
// 'procedure' → skills layer, 'session_history' → sessions layer, anything else → UNKNOWN_KIND.
// Read paths are NOT affected — existing rows with any memory_role remain readable.
// =============================================================================

const ALLOWED_WRITE_ROLES = ['fact']

function buildRoleError(memory_role) {
  if (memory_role === 'procedure') {
    const err = new Error(
      "Procedures belong in the skills layer — they are versioned, reviewable, and load on demand. Memory is for durable facts only."
    )
    err.code = 'WRONG_LAYER'
    err.layer = 'skills'
    err.suggested_action = "skill_manage({action:'create', body_md:'<your procedure>', title:'<short title>'})"
    err.reason = "Procedures belong in the skills layer — they are versioned, reviewable, and load on demand. Memory is for durable facts only."
    return err
  }

  if (memory_role === 'session_history') {
    const err = new Error(
      "Session history is captured automatically as you work — do not write it to memory. Use session_search to recall past work."
    )
    err.code = 'WRONG_LAYER'
    err.layer = 'sessions'
    err.suggested_action = "session_search({query:'<keywords>', limit:10})"
    err.reason = "Session history is captured automatically as you work — do not write it to memory. Use session_search to recall past work."
    return err
  }

  const err = new Error(`Only 'fact' is accepted for memory_save. Provided: '${memory_role}'.`)
  err.code = 'UNKNOWN_KIND'
  err.allowed = ['fact']
  err.reason = `Only 'fact' is accepted for memory_save. Provided: '${memory_role}'.`
  return err
}

// =============================================================================
// MEMORIES
// =============================================================================

export function createMemory({
  org_id,
  user_id,
  agent_id = null,
  memory_type,
  content,
  importance = 'medium',
  stability = 'stable',
  tags = [],
  provenance = 'model_inference',
  confidence = 0.8,
  source_conversation_id = null,
  source_message_id = null,
  memory_role = 'fact',
  metadata = null
}) {
  // QSKL-13: reject disallowed roles BEFORE any DB interaction
  if (!ALLOWED_WRITE_ROLES.includes(memory_role)) {
    throw buildRoleError(memory_role)
  }

  const db = getDatabase()
  const id = ulid()

  // TRUST-GATE-1.12a: `metadata` column exists in schema (memories.metadata
  // TEXT) and is already parsed back by parseMemoryRow() on read, but the
  // INSERT never included it — every write silently dropped it.
  const stmt = db.prepare(`
    INSERT INTO memories (
      id, org_id, user_id, agent_id, memory_type, content, importance, stability,
      tags, provenance, confidence, source_conversation_id, source_message_id, memory_role, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    id, org_id, user_id, agent_id, memory_type, content, importance, stability,
    JSON.stringify(tags), provenance, confidence, source_conversation_id, source_message_id, memory_role,
    metadata ? JSON.stringify(metadata) : null
  )

  const created = getMemory(id)

  // MEM-INJECT core-memory promotion-on-write: the durable replacement for
  // the read-time critical-memory fallback in
  // collector/lib/memoryImplant.js. A critical-importance write is upserted
  // into core_memories immediately so it's always loaded for that agent,
  // instead of being rediscovered on every chat turn via an over-fetch.
  // Never allowed to fail the write it's attached to.
  if (created && created.importance === 'critical') {
    promoteCriticalToCore(created)
  }

  return created
}

export function getMemory(id) {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
  return row ? parseMemoryRow(row) : null
}

export function updateMemory(id, updates) {
  const db = getDatabase()

  const allowedFields = [
    'content', 'importance', 'stability', 'tags', 'confidence',
    'valid', 'superseded_by', 'verified_at', 'verified_by', 'metadata',
    'memory_role'
  ]

  const fields = []
  const values = []

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`)
      // JSON serialize tags and metadata
      const jsonFields = ['tags', 'metadata']
      if (jsonFields.includes(key)) {
        values.push(JSON.stringify(value))
      } else if (key === 'valid' && typeof value === 'boolean') {
        // quox#571 Part 4: `valid` is an INTEGER column and better-sqlite3 v11
        // refuses to bind a JS boolean ("SQLite3 can only bind numbers,
        // strings, bigints, buffers, and null"). The consolidate route passes
        // `valid: false` to soft-delete merged/superseded/archived memories, so
        // EVERY such item silently threw and consolidation invalidated nothing
        // (and never decremented quota). Coerce boolean → 0/1 at the boundary.
        values.push(value ? 1 : 0)
      } else {
        values.push(value)
      }
    }
  }

  if (fields.length === 0) return getMemory(id)

  fields.push(`updated_at = datetime('now')`)
  values.push(id)

  const stmt = db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`)
  stmt.run(...values)

  return getMemory(id)
}

export function deleteMemory(id, hard = false) {
  const db = getDatabase()

  if (hard) {
    db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return { deleted: true }
  } else {
    // Soft delete
    db.prepare(`UPDATE memories SET valid = 0, updated_at = datetime('now') WHERE id = ?`).run(id)
    return { deleted: true, soft: true }
  }
}

// BRAIN2-W5 092: QuoxDream writes org-scope beliefs under this shared owner;
// every member of the org may read them (org_id is still always enforced).
// User-scope beliefs stay private to their user_id.
export const ORG_SHARED_USER_ID = '__org__'

/**
 * Account erasure (GDPR Art. 17, FND_01M4HZQ5P004YSXH0BWY04YSXH), across every org.
 * Hard-deletes everything owned by the user: memories, core memories, entities
 * (and any relation touching them), conversation summaries, archived
 * conversations with their messages, identity blobs and quota rows. FTS rows
 * follow through the delete triggers. Org-shared beliefs (ORG_SHARED_USER_ID)
 * are never a user, so they are refused rather than erased. One transaction.
 */
export function eraseUser(userId) {
  if (typeof userId !== 'string' || !userId.trim() || userId === ORG_SHARED_USER_ID) throw new Error('eraseUser: a real userId is required')
  const db = getDatabase()
  const out = {}
  db.transaction(() => {
    out.relations = db.prepare(`DELETE FROM entity_relations WHERE source_entity_id IN (SELECT id FROM entities WHERE user_id = ?)
      OR target_entity_id IN (SELECT id FROM entities WHERE user_id = ?)`).run(userId, userId).changes
    out.conversationMessages = db.prepare('DELETE FROM conversation_messages WHERE conversation_archive_id IN (SELECT id FROM conversation_archives WHERE user_id = ?)').run(userId).changes
    for (const [k, t] of [['memories', 'memories'], ['coreMemories', 'core_memories'], ['entities', 'entities'], ['summaries', 'conversation_summaries'],
      ['conversations', 'conversation_archives'], ['identityBlobs', 'identity_blobs'], ['quotas', 'memory_quotas']]) {
      out[k] = db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId).changes
    }
  })()
  return out
}

export function listMemories({ org_id, user_id, agent_id, memory_type, valid = true, limit = 50, offset = 0, agent_scope = false, source_message_id = null }) {
  const db = getDatabase()

  // QUOXIDENTITY F8: an agent's namespace is keyed by (org_id, agent_id), not
  // by the single user_id whose token happened to write each row. agent_scope
  // reads the whole agent namespace within the org, dropping the user_id
  // filter — org isolation is always preserved. Requires an agent_id: without
  // one there is no namespace to scope to, so we fall back to strict
  // user-scoping rather than returning the whole org.
  const scopeToAgent = agent_scope && !!agent_id

  let query = scopeToAgent
    ? 'SELECT * FROM memories WHERE org_id = ?'
    : 'SELECT * FROM memories WHERE org_id = ? AND user_id IN (?, ?)'
  const params = scopeToAgent ? [org_id] : [org_id, user_id, ORG_SHARED_USER_ID]

  if (source_message_id) {
    query += ' AND source_message_id = ?'
    params.push(source_message_id)
  }

  if (agent_id) {
    query += ' AND agent_id = ?'
    params.push(agent_id)
  }

  if (memory_type && memory_type !== 'all') {
    query += ' AND memory_type = ?'
    params.push(memory_type)
  }

  if (valid !== null) {
    query += ' AND valid = ?'
    params.push(valid ? 1 : 0)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(query).all(...params)
  return rows.map(parseMemoryRow)
}

/**
 * BRAIN2-W5 031: distinct users that own valid memories in one org. Read-only,
 * org-scoped; used by the Feed's memory source (service callers only, see
 * GET /api/memory/org-users) to feed each user's memories into a user-scoped
 * vault instead of reading only the 'service' user.
 */
export function listMemoryUserIds({ org_id, limit = 1000 }) {
  const db = getDatabase()
  return db.prepare('SELECT DISTINCT user_id FROM memories WHERE org_id = ? AND valid = 1 AND user_id IS NOT NULL ORDER BY user_id LIMIT ?')
    .all(org_id, limit).map((r) => r.user_id)
}

/**
 * QUOXIDENTITY F9: turn a raw search string into a recall-first FTS5 query.
 * FTS5 treats a bare multi-token string as implicit AND and splits on
 * punctuation (so "quox.ai" requires BOTH "quox" AND "ai"). For a recall-first
 * memory search that collapses to ~1 hit on any multi-term query (measured: a
 * 6-term query matched 1 of 7 relevant rows). We tokenise on non-alphanumerics
 * and OR the tokens; bm25 still ranks the strongest matches first, so
 * precision-ordering is preserved while recall jumps (same query: 7 of 7).
 * Quoting each token also neutralises FTS operators in user input.
 * Returns null when nothing usable remains (caller falls back to LIKE).
 */
function toRecallFtsQuery(raw) {
  const tokens = String(raw || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' OR ')
}

export function searchMemories({ org_id, user_id, query, memory_type, agent_id, limit = 10, agent_scope = false }) {
  const db = getDatabase()

  // QUOXIDENTITY F9: recall-first FTS query (OR-joined, bm25-ranked). Falls
  // back to the raw query if tokenisation leaves nothing usable.
  const ftsQuery = toRecallFtsQuery(query) || query

  // QUOXIDENTITY F8: same agent-namespace scoping as listMemories — search the
  // whole agent namespace within the org when agent_scope is set with an
  // agent_id, dropping user_id (org isolation preserved).
  const scopeToAgent = agent_scope && !!agent_id

  // Use FTS5 for search
  let sql = `
    SELECT m.*,
           bm25(memories_fts) as rank
    FROM memories m
    JOIN memories_fts ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.org_id = ?
      ${scopeToAgent ? '' : 'AND m.user_id IN (?, ?)'}
      AND m.valid = 1
  `
  const params = scopeToAgent ? [ftsQuery, org_id] : [ftsQuery, org_id, user_id, ORG_SHARED_USER_ID]

  if (memory_type && memory_type !== 'all') {
    sql += ' AND m.memory_type = ?'
    params.push(memory_type)
  }

  if (agent_id) {
    sql += ' AND m.agent_id = ?'
    params.push(agent_id)
  }

  sql += ' ORDER BY rank LIMIT ?'
  params.push(limit)

  try {
    const rows = db.prepare(sql).all(...params)

    // Update access stats for returned memories
    const ids = rows.map(r => r.id)
    if (ids.length > 0) {
      const updateStmt = db.prepare(`
        UPDATE memories
        SET last_accessed_at = datetime('now'), access_count = access_count + 1
        WHERE id = ?
      `)
      for (const id of ids) {
        updateStmt.run(id)
      }
    }

    return rows.map(parseMemoryRow)
  } catch (error) {
    // FTS5 query syntax error - fall back to LIKE search
    console.warn('[Memory] FTS5 search failed, falling back to LIKE:', error.message)
    return searchMemoriesLike({ org_id, user_id, query, memory_type, agent_id, limit, agent_scope })
  }
}

function searchMemoriesLike({ org_id, user_id, query, memory_type, agent_id, limit, agent_scope = false }) {
  const db = getDatabase()

  // QUOXIDENTITY F8: mirror searchMemories' agent-namespace scoping in the
  // fallback path. Without this, an FTS syntax error silently reinstated the
  // user_id filter and hid service-written handoffs from an agent-scoped read.
  const scopeToAgent = agent_scope && !!agent_id

  let sql = `
    SELECT * FROM memories
    WHERE org_id = ? AND valid = 1
      ${scopeToAgent ? '' : 'AND user_id IN (?, ?)'}
    AND (content LIKE ? OR tags LIKE ?)
  `
  const likeQuery = `%${query}%`
  const params = scopeToAgent
    ? [org_id, likeQuery, likeQuery]
    : [org_id, user_id, ORG_SHARED_USER_ID, likeQuery, likeQuery]

  if (memory_type && memory_type !== 'all') {
    sql += ' AND memory_type = ?'
    params.push(memory_type)
  }

  if (agent_id) {
    sql += ' AND agent_id = ?'
    params.push(agent_id)
  }

  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const rows = db.prepare(sql).all(...params)
  return rows.map(parseMemoryRow)
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

// =============================================================================
// BELIEF HISTORY (codex cycle 4 #10): decision timeline + correction queue.
// Supersession links old -> new through superseded_by; these walk it.
// `user_ids` is the caller's visibility set (their own id, plus
// ORG_SHARED_USER_ID for org beliefs); rows outside it are never returned.
// =============================================================================

const HISTORY_MAX = 50

function visibleRow(db, id, org_id, user_ids) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
  return row && row.org_id === org_id && user_ids.includes(row.user_id) ? row : null
}

function historyEntry(row) {
  const m = parseMemoryRow(row)
  return { ...m, superseded_reason: m.metadata?.superseded_reason || m.metadata?.contradiction_resolution || null, superseded_at: m.metadata?.superseded_at || null }
}

/** The full supersession chain containing `id`, oldest first. [] when not visible. */
export function getBeliefHistory(id, { org_id, user_ids = [] } = {}) {
  const db = getDatabase()
  let row = visibleRow(db, id, org_id, user_ids)
  if (!row) return []
  // Walk back to the oldest ancestor (follow the newest predecessor each step).
  const seen = new Set([row.id])
  for (let i = 0; i < HISTORY_MAX; i++) {
    const prev = db.prepare('SELECT * FROM memories WHERE superseded_by = ? AND org_id = ? ORDER BY created_at DESC').all(row.id, org_id).find((r) => user_ids.includes(r.user_id) && !seen.has(r.id))
    if (!prev) break
    seen.add(prev.id); row = prev
  }
  const chain = [row]
  const ids = new Set([row.id])
  for (let i = 0; i < HISTORY_MAX && row.superseded_by; i++) {
    const next = visibleRow(db, row.superseded_by, org_id, user_ids)
    if (!next || ids.has(next.id)) break
    ids.add(next.id); chain.push(next); row = next
  }
  return chain.map(historyEntry)
}

/** Decisions that changed: one entry per chain, newest change first. */
export function getDecisionTimeline({ org_id, user_ids = [], q = '', limit = 50 } = {}) {
  const db = getDatabase()
  if (!user_ids.length) return []
  const marks = user_ids.map(() => '?').join(',')
  const retired = db.prepare(`SELECT * FROM memories WHERE org_id = ? AND user_id IN (${marks}) AND superseded_by IS NOT NULL ORDER BY updated_at DESC LIMIT 2000`).all(org_id, ...user_ids)
  const needle = String(q || '').trim().toLowerCase()
  const chains = new Map()
  for (const r of retired) {
    const h = getBeliefHistory(r.id, { org_id, user_ids })
    if (h.length < 2) continue
    const key = h[h.length - 1].id
    if (chains.has(key)) continue
    if (needle && !h.some((m) => String(m.content).toLowerCase().includes(needle))) continue
    const lastChange = h.reduce((t, m) => (m.superseded_at && m.superseded_at > t ? m.superseded_at : t), '')
    chains.set(key, { current: h[h.length - 1], history: h, last_change: lastChange || null, changes: h.length - 1 })
  }
  return [...chains.values()].sort((a, b) => String(b.last_change || '').localeCompare(String(a.last_change || ''))).slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
}

/**
 * Correction: the user says a retired belief was right. It becomes live again,
 * the belief that retired it is retired in turn (linked back, marked disputed),
 * and the disputed wording is remembered so Dream does not re-apply the same
 * wrong correction when it re-reads the source.
 */
export function reinstateBelief(id, { by } = {}) {
  const db = getDatabase()
  const old = getMemory(id)
  if (!old || old.valid || !old.superseded_by) throw new Error('memory is not superseded')
  const winner = getMemory(old.superseded_by)
  if (!winner || winner.org_id !== old.org_id || winner.user_id !== old.user_id) throw new Error('superseding memory not found')
  const at = new Date().toISOString()
  db.transaction(() => {
    const disputed = [...new Set([...(old.metadata?.disputed_claims || []), winner.content])]
    updateMemory(old.id, { valid: true, superseded_by: null, metadata: { ...(old.metadata || {}), reinstated_at: at, reinstated_by: by || null, disputed_claims: disputed } })
    updateMemory(winner.id, { valid: false, superseded_by: old.id, metadata: { ...(winner.metadata || {}), superseded_reason: `corrected by user: reinstated "${String(old.content).slice(0, 120)}"`, superseded_at: at, disputed: true } })
  })()
  return { reinstated: getMemory(old.id), retired: getMemory(winner.id) }
}

function parseMemoryRow(row) {
  return {
    ...row,
    tags: safeJsonParse(row.tags, []),
    metadata: safeJsonParse(row.metadata, null),
    valid: Boolean(row.valid)
  }
}

// =============================================================================
// CORE MEMORIES
// =============================================================================

export function getCoreMemories({ org_id, user_id, agent_id, agent_scope = false }) {
  const db = getDatabase()
  // QUOXIDENTITY F8: core memories auto-promoted from an attached session's
  // critical writes land under the agent service user, not 'service'. Scope the
  // core read to the agent namespace (org + agent_id) when agent_scope is set.
  if (agent_scope && agent_id) {
    return db.prepare(`
      SELECT * FROM core_memories
      WHERE org_id = ? AND agent_id = ?
      ORDER BY label
    `).all(org_id, agent_id)
  }
  const rows = db.prepare(`
    SELECT * FROM core_memories
    WHERE org_id = ? AND user_id = ? AND agent_id = ?
    ORDER BY label
  `).all(org_id, user_id, agent_id)
  return rows
}

export function upsertCoreMemory({ org_id, user_id, agent_id, label, content, token_count = 0 }) {
  const db = getDatabase()
  const id = ulid()

  const stmt = db.prepare(`
    INSERT INTO core_memories (id, org_id, user_id, agent_id, label, content, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, user_id, agent_id, label) DO UPDATE SET
      content = excluded.content,
      token_count = excluded.token_count,
      updated_at = datetime('now')
  `)

  stmt.run(id, org_id, user_id, agent_id, label, content, token_count)

  return db.prepare(`
    SELECT * FROM core_memories
    WHERE org_id = ? AND user_id = ? AND agent_id = ? AND label = ?
  `).get(org_id, user_id, agent_id, label)
}

export function deleteCoreMemory({ org_id, user_id, agent_id, label }) {
  const db = getDatabase()
  db.prepare(`
    DELETE FROM core_memories
    WHERE org_id = ? AND user_id = ? AND agent_id = ? AND label = ?
  `).run(org_id, user_id, agent_id, label)
  return { deleted: true }
}

// Per-agent cap on auto-promoted core memories. Kept small — core_memories
// is the "always-loaded, <500 tokens each" tier (see db/schema.sql), not a
// second copy of the whole memory table.
export const CORE_MEMORY_CAP_PER_AGENT = 5

/**
 * MEM-INJECT core-memory promotion-on-write.
 *
 * Durable replacement for the read-time critical-memory fallback added in
 * collector/lib/memoryImplant.js (fetchCriticalMemoriesFallback), which
 * over-fetches recent memories on every chat turn and filters client-side
 * because nothing durably populated core_memories. This upserts
 * importance:'critical' memories into core_memories at write time instead,
 * so the fallback degrades to a true no-op for anything written after this
 * change (it still covers pre-existing critical memories written before
 * promotion-on-write shipped).
 *
 * label = the source memory's own id. This makes the upsert idempotent for
 * re-saves of the same memory row (converges on one core_memories row
 * instead of duplicating) while staying distinct from the human-curated
 * labels (user_profile, project_context, ...) written via the existing
 * /api/memory/consolidate promote_to_core path.
 *
 * Capped at CORE_MEMORY_CAP_PER_AGENT per (org, user, agent): when a *new*
 * label would exceed the cap, the oldest core memories for that agent
 * (LRU by updated_at, then created_at) are evicted first to make room.
 * Re-promoting an already-promoted memory (existing label) never evicts.
 *
 * Never throws — a promotion failure must not fail the memory write it's
 * attached to. Returns the upserted core_memories row, or null if the
 * memory isn't critical or the promotion failed.
 */
export function promoteCriticalToCore(memory, { capPerAgent = CORE_MEMORY_CAP_PER_AGENT } = {}) {
  if (!memory || memory.importance !== 'critical') return null

  try {
    const db = getDatabase()
    const { org_id, user_id, content } = memory
    const agent_id = memory.agent_id || 'quox'
    const label = memory.id

    const existing = db.prepare(`
      SELECT id FROM core_memories WHERE org_id = ? AND user_id = ? AND agent_id = ? AND label = ?
    `).get(org_id, user_id, agent_id, label)

    if (!existing) {
      const { count } = db.prepare(`
        SELECT COUNT(*) as count FROM core_memories WHERE org_id = ? AND user_id = ? AND agent_id = ?
      `).get(org_id, user_id, agent_id)

      if (count >= capPerAgent) {
        const evictCount = count - capPerAgent + 1
        const oldest = db.prepare(`
          SELECT id FROM core_memories
          WHERE org_id = ? AND user_id = ? AND agent_id = ?
          ORDER BY updated_at ASC, created_at ASC, rowid ASC
          LIMIT ?
        `).all(org_id, user_id, agent_id, evictCount)
        const del = db.prepare('DELETE FROM core_memories WHERE id = ?')
        for (const row of oldest) del.run(row.id)
      }
    }

    return upsertCoreMemory({
      org_id,
      user_id,
      agent_id,
      label,
      content,
      token_count: Math.ceil((content || '').length / 4)
    })
  } catch (err) {
    console.error(`[MemoryStore] core-promotion failed for memory ${memory?.id}: ${err.message}`)
    return null
  }
}

// =============================================================================
// ENTITIES
// =============================================================================

// fleet #383: soft delete hides, recreate revives. The ON CONFLICT
// DO UPDATE clause below clears deleted_at, so calling createEntity again
// for the same (org_id, user_id, name, entity_type) after a soft delete
// resurrects the row instead of leaving it invisibly soft-deleted forever.
// That is what makes the deleted_at IS NULL filter on the post-upsert
// SELECT correct rather than a landmine: by the time this SELECT runs, a
// previously-deleted row has already had its deleted_at cleared.
export function createEntity({ org_id, user_id, name, entity_type, attributes = {} }) {
  const db = getDatabase()
  const id = ulid()

  const stmt = db.prepare(`
    INSERT INTO entities (id, org_id, user_id, name, entity_type, attributes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, user_id, name, entity_type) DO UPDATE SET
      attributes = excluded.attributes,
      last_referenced = datetime('now'),
      reference_count = reference_count + 1,
      deleted_at = NULL
  `)

  stmt.run(id, org_id, user_id, name, entity_type, JSON.stringify(attributes))

  const row = db.prepare(`
    SELECT * FROM entities WHERE org_id = ? AND user_id = ? AND name = ? AND entity_type = ? AND deleted_at IS NULL
  `).get(org_id, user_id, name, entity_type)
  return row ? parseEntityRow(row) : null
}

export function getEntity(id) {
  const db = getDatabase()
  // fleet #383: soft-deleted entities vanish from reads — mirror how a
  // soft-deleted memory is filtered out.
  const entity = db.prepare('SELECT * FROM entities WHERE id = ? AND deleted_at IS NULL').get(id)
  if (!entity) return null

  // Get relations — exclude soft-deleted relations AND relations whose
  // joined source/target entity has itself been soft-deleted (fleet #383).
  const relations = db.prepare(`
    SELECT r.*,
           s.name as source_name, s.entity_type as source_type,
           t.name as target_name, t.entity_type as target_type
    FROM entity_relations r
    JOIN entities s ON r.source_entity_id = s.id
    JOIN entities t ON r.target_entity_id = t.id
    WHERE (r.source_entity_id = ? OR r.target_entity_id = ?)
      AND r.deleted_at IS NULL
      AND s.deleted_at IS NULL
      AND t.deleted_at IS NULL
  `).all(id, id)

  return {
    ...parseEntityRow(entity),
    relations: relations.map(r => ({
      id: r.id,
      type: r.relation_type,
      direction: r.source_entity_id === id ? 'outgoing' : 'incoming',
      related: r.source_entity_id === id
        ? { id: r.target_entity_id, name: r.target_name, type: r.target_type }
        : { id: r.source_entity_id, name: r.source_name, type: r.source_type },
      context: r.context,
      // D4: expose edge strength — weight is the co-occurrence evidence
      // count (heuristic, incremented on repeat co-occurrence), confidence
      // remains the semantic field for manual/LLM-asserted relations.
      weight: r.weight,
      confidence: r.confidence
    }))
  }
}

export function searchEntities({ org_id, user_id, query, entity_type, limit = 10 }) {
  const db = getDatabase()

  try {
    // Try FTS5 first
    let sql = `
      SELECT e.*, bm25(entities_fts) as rank
      FROM entities e
      JOIN entities_fts ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
        AND e.org_id = ?
        AND e.user_id = ?
        AND e.deleted_at IS NULL
    `
    const params = [query, org_id, user_id]

    if (entity_type) {
      sql += ' AND e.entity_type = ?'
      params.push(entity_type)
    }

    sql += ' ORDER BY rank LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params)
    return rows.map(parseEntityRow)
  } catch {
    // Fallback to LIKE
    let sql = `
      SELECT * FROM entities
      WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
      AND (name LIKE ? OR attributes LIKE ?)
    `
    const likeQuery = `%${query}%`
    const params = [org_id, user_id, likeQuery, likeQuery]

    if (entity_type) {
      sql += ' AND entity_type = ?'
      params.push(entity_type)
    }

    sql += ' ORDER BY reference_count DESC LIMIT ?'
    params.push(limit)

    const rows = db.prepare(sql).all(...params)
    return rows.map(parseEntityRow)
  }
}

export function listEntities({ org_id, user_id, entity_type, limit = 50, offset = 0 }) {
  const db = getDatabase()

  let sql = 'SELECT * FROM entities WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL'
  const params = [org_id, user_id]

  if (entity_type) {
    sql += ' AND entity_type = ?'
    params.push(entity_type)
  }

  sql += ' ORDER BY reference_count DESC, last_referenced DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(sql).all(...params)
  return rows.map(parseEntityRow)
}

function parseEntityRow(row) {
  return {
    ...row,
    attributes: safeJsonParse(row.attributes, {})
  }
}

// =============================================================================
// ENTITY RELATIONS
// =============================================================================

// fleet #383: soft delete hides, recreate revives — same contract as
// createEntity above. The ON CONFLICT clause clears deleted_at, so the
// deleted_at IS NULL filter on the post-write SELECT below finds the
// resurrected row rather than returning null for a relation that was just
// successfully (re)created.
export function createRelation({ org_id, source_entity_id, relation_type, target_entity_id, context = null, confidence = 0.8 }) {
  const db = getDatabase()
  const id = ulid()

  const stmt = db.prepare(`
    INSERT INTO entity_relations (id, org_id, source_entity_id, relation_type, target_entity_id, context, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_entity_id, relation_type, target_entity_id) DO UPDATE SET
      context = excluded.context,
      confidence = excluded.confidence,
      deleted_at = NULL
  `)

  stmt.run(id, org_id, source_entity_id, relation_type, target_entity_id, context, confidence)

  return db.prepare('SELECT * FROM entity_relations WHERE source_entity_id = ? AND relation_type = ? AND target_entity_id = ? AND deleted_at IS NULL')
    .get(source_entity_id, relation_type, target_entity_id)
}

// fleet #383: fetch a single relation for the delete route's 404/403 checks.
// Filtered by deleted_at IS NULL, same as every other relation read — an
// already soft-deleted relation reads back as "not found".
export function getRelation(id) {
  const db = getDatabase()
  return db.prepare('SELECT * FROM entity_relations WHERE id = ? AND deleted_at IS NULL').get(id) || null
}

// fleet #383: delete an entity. Hard removes the entity row (the FTS delete
// trigger handles the entities_fts index) and every relation touching it.
// Soft stamps deleted_at on the entity AND cascades the same stamp to its
// not-already-deleted relations, using ONE datetime('now') read so the
// entity and its cascaded relations carry the identical timestamp rather
// than two independent (if practically indistinguishable) calls.
export function deleteEntity(id, hard = false) {
  const db = getDatabase()

  if (hard) {
    const relResult = db.prepare(
      'DELETE FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ?'
    ).run(id, id)
    db.prepare('DELETE FROM entities WHERE id = ?').run(id)
    return { deleted: true, relations_removed: relResult.changes }
  }

  const ts = db.prepare("SELECT datetime('now') as ts").get().ts

  const relResult = db.prepare(`
    UPDATE entity_relations
    SET deleted_at = ?
    WHERE (source_entity_id = ? OR target_entity_id = ?) AND deleted_at IS NULL
  `).run(ts, id, id)

  db.prepare('UPDATE entities SET deleted_at = ? WHERE id = ?').run(ts, id)

  return { deleted: true, soft: true, relations_removed: relResult.changes }
}

// fleet #383: delete a single relation, no cascade.
export function deleteRelation(id, hard = false) {
  const db = getDatabase()

  if (hard) {
    db.prepare('DELETE FROM entity_relations WHERE id = ?').run(id)
    return { deleted: true }
  }

  db.prepare(`UPDATE entity_relations SET deleted_at = datetime('now') WHERE id = ?`).run(id)
  return { deleted: true, soft: true }
}

// D4: co-occurrence linker — undirected weighted upsert.
// Canonical ordering (lexicographically smaller id = source_entity_id)
// collapses A-B / B-A into a single row; the pre-existing
// UNIQUE(source_entity_id, relation_type, target_entity_id) constraint
// then guarantees the ON CONFLICT increments the same row forever instead
// of ever inserting a duplicate. weight is an evidence-count heuristic
// (repeat co-occurrence, including retried writes, increments it — it is
// not a strictly-witnessed count); confidence stays fixed at 0.5 for
// auto-linked co-occurrence, leaving confidence as the semantic field
// manual/LLM relations (e.g. depends_on) actually vary.
// fleet #383: soft delete hides, recreate revives — the ON CONFLICT clause
// clears deleted_at, so a co-occurrence pair that was soft-deleted comes
// back the next time the pair co-occurs, instead of staying invisible.
export function upsertCoOccurrence({ org_id, a_id, b_id, context = null, confidence = 0.5 }) {
  const db = getDatabase()
  const id = ulid()
  const [source_entity_id, target_entity_id] = a_id < b_id ? [a_id, b_id] : [b_id, a_id]

  const stmt = db.prepare(`
    INSERT INTO entity_relations (id, org_id, source_entity_id, relation_type, target_entity_id, context, confidence, weight, last_seen)
    VALUES (?, ?, ?, 'co_occurs_with', ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(source_entity_id, relation_type, target_entity_id) DO UPDATE SET
      weight = weight + 1,
      last_seen = datetime('now'),
      deleted_at = NULL
  `)

  stmt.run(id, org_id, source_entity_id, target_entity_id, context, confidence)

  return db.prepare(`
    SELECT * FROM entity_relations
    WHERE source_entity_id = ? AND relation_type = 'co_occurs_with' AND target_entity_id = ? AND deleted_at IS NULL
  `).get(source_entity_id, target_entity_id)
}

// =============================================================================
// CONVERSATION SUMMARIES
// =============================================================================

export function createConversationSummary({ org_id, user_id, conversation_id, agent_id = null, summary, key_facts = [], entities_mentioned = [], message_count = 0, token_count = 0 }) {
  const db = getDatabase()
  const id = ulid()

  const stmt = db.prepare(`
    INSERT INTO conversation_summaries (id, org_id, user_id, conversation_id, agent_id, summary, key_facts, entities_mentioned, message_count, token_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      summary = excluded.summary,
      key_facts = excluded.key_facts,
      entities_mentioned = excluded.entities_mentioned,
      message_count = excluded.message_count,
      token_count = excluded.token_count
  `)

  stmt.run(id, org_id, user_id, conversation_id, agent_id, summary, JSON.stringify(key_facts), JSON.stringify(entities_mentioned), message_count, token_count)

  return getConversationSummary(conversation_id)
}

export function getConversationSummary(conversation_id) {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(conversation_id)
  if (!row) return null
  return {
    ...row,
    key_facts: safeJsonParse(row.key_facts, []),
    entities_mentioned: safeJsonParse(row.entities_mentioned, [])
  }
}

// =============================================================================
// MIGRATION
// =============================================================================

export function createMigration({ user_id, source, memories_count = 0, entities_count = 0 }) {
  const db = getDatabase()
  const id = ulid()

  db.prepare(`
    INSERT INTO migrations (id, user_id, source, memories_count, entities_count, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(id, user_id, source, memories_count, entities_count)

  return { id }
}

export function completeMigration(id, error = null) {
  const db = getDatabase()
  db.prepare(`
    UPDATE migrations SET
      status = ?,
      error = ?,
      completed_at = datetime('now')
    WHERE id = ?
  `).run(error ? 'failed' : 'completed', error, id)
}

export function getMigrationStatus(user_id) {
  const db = getDatabase()
  return db.prepare(`
    SELECT * FROM migrations WHERE user_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(user_id)
}

// =============================================================================
// STATS
// =============================================================================

export function getStats({ org_id, user_id }) {
  const db = getDatabase()

  const memoryCounts = db.prepare(`
    SELECT memory_type, COUNT(*) as count
    FROM memories
    WHERE org_id = ? AND user_id = ? AND valid = 1
    GROUP BY memory_type
  `).all(org_id, user_id)

  const entityCounts = db.prepare(`
    SELECT entity_type, COUNT(*) as count
    FROM entities
    WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
    GROUP BY entity_type
  `).all(org_id, user_id)

  const coreMemoryCount = db.prepare(`
    SELECT COUNT(*) as count FROM core_memories WHERE org_id = ? AND user_id = ?
  `).get(org_id, user_id)

  const conversationCount = db.prepare(`
    SELECT COUNT(*) as count FROM conversation_summaries WHERE org_id = ? AND user_id = ?
  `).get(org_id, user_id)

  const relationCount = db.prepare(`
    SELECT COUNT(*) as count FROM entity_relations WHERE org_id = ? AND deleted_at IS NULL
  `).get(org_id)

  return {
    memories: {
      total: memoryCounts.reduce((sum, r) => sum + r.count, 0),
      by_type: Object.fromEntries(memoryCounts.map(r => [r.memory_type, r.count]))
    },
    entities: {
      total: entityCounts.reduce((sum, r) => sum + r.count, 0),
      by_type: Object.fromEntries(entityCounts.map(r => [r.entity_type, r.count]))
    },
    core_memories: coreMemoryCount.count,
    conversations: conversationCount.count,
    relations: relationCount.count
  }
}

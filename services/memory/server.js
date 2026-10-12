// QuoxCORE Memory Service
// Server-side memory persistence with FTS5 search

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import jwt from 'jsonwebtoken'
import { readFileSync } from 'fs'
import { pathToFileURL } from 'node:url'
import { initDatabase, closeDatabase, getDatabase } from './lib/db.js'
import * as store from './lib/memoryStore.js'
import * as archiveStore from './lib/archiveStore.js'
import * as quotaStore from './lib/quotaStore.js'
import * as identityStore from './lib/identityStore.js'
// TRUST-GATE-1.12a: internal service auth (X-Service-Key + X-Org-Id/X-User-Id)
// extracted so it can be unit-tested directly (services/memory/test/serviceAuth.test.js)
import { authenticate, assertServiceKeyConfiguredForProduction } from './middleware/auth.js'
// D4: co-occurrence entity linker (revives the knowledge graph)
import { linkCoOccurringEntities } from './lib/entityLinker.js'

import { ulid } from 'ulid'

// Version resolution: QUOXCORE_VERSION build arg → canonical /app/VERSION file
// → '0.0.0'. Prevents silently reporting the placeholder when the build arg is
// not passed. NOTE: this service's Docker build context is ./services/memory
// (see docker-compose.yml), so the repo-root VERSION file is NOT COPY'd into the
// image — /app/VERSION will be absent unless the compose context is widened, and
// this resolver correctly falls back to the env var / '0.0.0'. Read once at load.
const RESOLVED_VERSION = (() => {
  if (process.env.QUOXCORE_VERSION) return process.env.QUOXCORE_VERSION
  try {
    const v = readFileSync('/app/VERSION', 'utf8').trim()
    if (v) return v
  } catch { /* file absent — fall through */ }
  return '0.0.0'
})()

// TRUST-GATE-OPS: refuse to boot with test-only env flags in production
// (same guard as collector — see lib/bootGuard.js)
const { guardTestEnvFlags } = await import('./lib/bootGuard.js')
const _bootGuardResult = guardTestEnvFlags(process.env)
if (_bootGuardResult.shouldAbort) {
  console.error(`[boot] Refusing to start with test-only env flags set: ${_bootGuardResult.presentFlags.join(',')}. Set ALLOW_TEST_FLAGS=true to bypass (test contexts only).`)
  process.exit(1)
} else if (_bootGuardResult.presentFlags.length > 0) {
  console.warn(`[boot] WARNING: test-only env flags active under ALLOW_TEST_FLAGS=true: ${_bootGuardResult.presentFlags.join(',')}`)
}

const app = express()
const PORT = process.env.PORT || 3103
const DB_PATH = process.env.DB_PATH || './data/memory.db'
const JWT_SECRET = process.env.JWT_SECRET
const ADMIN_SERVICE_KEY = process.env.ADMIN_SERVICE_KEY || null

// ─── AEE Audit Helper ──────────────────────────────────────────────────────
const MEM_INTENTS = {
  MEMORY_CREATED: 'quox.memory.created',
  MEMORY_UPDATED: 'quox.memory.updated',
  MEMORY_DELETED: 'quox.memory.deleted',
  CORE_UPSERTED: 'quox.memory.core_upserted',
  CORE_DELETED: 'quox.memory.core_deleted',
  ENTITY_CREATED: 'quox.memory.entity_created',
  ENTITY_DELETED: 'quox.memory.entity_deleted',
  RELATION_CREATED: 'quox.memory.relation_created',
  RELATION_DELETED: 'quox.memory.relation_deleted',
  SUMMARY_CREATED: 'quox.memory.summary_created',
  MIGRATED: 'quox.memory.migrated',
  BATCH_CREATED: 'quox.memory.batch_created',
  CONSOLIDATED: 'quox.memory.consolidated',
  CONV_BATCH_IMPORTED: 'quox.memory.conv_batch_imported',
  CONV_DELETED: 'quox.memory.conv_deleted',
  TIER_SET: 'quox.memory.tier_set',
  QUOTA_RECALCULATED: 'quox.memory.quota_recalculated',
  IDENTITY_UPSERTED: 'quox.memory.identity_upserted',
  // D4: co-occurrence entity linker
  RELATIONS_LINKED: 'quox.memory.relations_linked',
}

let _auditStmt = null
function storeAuditEnvelope(intent, payload) {
  try {
    const db = getDatabase()
    if (!_auditStmt) {
      _auditStmt = db.prepare(
        'INSERT OR IGNORE INTO audit_envelopes (id, ts, intent, from_addr, to_addr, payload) VALUES (?, ?, ?, ?, ?, ?)'
      )
    }
    _auditStmt.run(ulid(), new Date().toISOString(), intent, 'service.memory', 'system.aee', JSON.stringify(payload || {}))
  } catch (err) {
    console.warn('[MemoryAudit]', err.message)
  }
}

// MC5 fix: Validate JWT_SECRET is set at startup
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required')
  console.error('Set JWT_SECRET to a secure random value matching the auth service')
  process.exit(1)
}

// TRUST-GATE-1.12a: fail loud in production if INTERNAL_SERVICE_KEY is unset
// (internal collector→memory calls would otherwise silently 401). Warns only
// outside production.
assertServiceKeyConfiguredForProduction()

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(helmet({ contentSecurityPolicy: false }))
app.use(express.json({ limit: '10mb' }))
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true)
    const allowed = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()) || ['http://localhost:3000']
    if (allowed.includes(origin)) return callback(null, true)
    try {
      const url = new URL(origin)
      const isLAN = /^(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|localhost|127\.0\.0\.1)$/.test(url.hostname)
      const dashPorts = ['3000', '3443', '443', '80']
      const portMatch = dashPorts.includes(url.port) || (url.port === '' && dashPorts.includes(url.protocol === 'https:' ? '443' : '80'))
      if (isLAN && portMatch) return callback(null, true)
    } catch {}
    callback(new Error('Not allowed by CORS'))
  },
  credentials: true
}))

// Request logging
app.use((req, res, next) => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    if (req.path !== '/health') {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`)
    }
  })
  next()
})

// Parse cookies from raw Cookie header (same pattern as collector/utils/httpAuth.js)
function parseCookieHeader(cookieHeader) {
  const cookies = {}
  if (!cookieHeader) return cookies
  cookieHeader.split(';').forEach(c => {
    const [name, ...rest] = c.trim().split('=')
    if (name) cookies[name.trim()] = rest.join('=').trim()
  })
  return cookies
}

// Extract JWT token from Bearer header or httpOnly cookie
function extractToken(req) {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  // Fall back to httpOnly access_token cookie (set by auth service)
  const cookies = parseCookieHeader(req.headers.cookie)
  if (cookies.access_token) {
    return cookies.access_token
  }
  return null
}

// JWT + internal service-key authentication — see ./middleware/auth.js
// (TRUST-GATE-1.12a: extracted so X-Service-Key/X-Org-Id/X-User-Id auth is
// unit-testable and org isolation for service-key calls is provable).

// Admin-only middleware — requires either ADMIN_SERVICE_KEY header or JWT role=admin
function requireAdmin(req, res, next) {
  // Check service key first (for internal service-to-service calls)
  const serviceKey = req.headers['x-service-key'];
  if (ADMIN_SERVICE_KEY && serviceKey === ADMIN_SERVICE_KEY) {
    return next();
  }
  // Check JWT role
  // An org owner's JWT carries role 'owner', which outranks 'admin' (2026-10-11).
  if (req.user?.role === 'admin' || req.user?.role === 'owner') {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
}

// Optional auth for health checks
function optionalAuth(req, res, next) {
  const token = extractToken(req)
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET)
      req.user = decoded
      req.user_id = decoded.sub || decoded.user_id || decoded.userId
      // TRUST-GATE-MT: same personal-bucket rule as middleware/auth.js —
      // org-less tokens must not share the 'default' org.
      req.org_id = decoded.org_id || decoded.orgId
        || (req.user_id ? `user:${req.user_id}` : 'default')
    } catch {
      // Ignore invalid tokens for optional auth
    }
  }
  next()
}

// =============================================================================
// HEALTH
// =============================================================================

app.get('/health', (req, res) => {
  // Prove the DEPENDENCY, not just that this process can answer.
  //
  // This returned a hardcoded 'ok', so the build daemon's post-build probe and
  // every other consumer learned only that the HTTP server was up. The
  // collector's equivalent did the same and answered "healthy" on 2026-08-19
  // while its database was unwritable and the disk was 100% full. Auth has
  // done a real SELECT 1 here for a while; this is that same check, which is
  // cheap and actually fails when the thing that matters has failed.
  let db = true
  let dbError = null
  try {
    getDatabase().prepare('SELECT 1').get()
  } catch (err) {
    db = false
    dbError = err.message
  }
  res.json({
    status: db ? 'ok' : 'degraded',
    db,
    ...(dbError ? { db_error: dbError } : {}),
    service: 'quox-memory',
    version: RESOLVED_VERSION,
    timestamp: new Date().toISOString(),
  })
})

// =============================================================================
// MEMORIES
// =============================================================================

// Create memory (with quota enforcement)
app.post('/api/memory', authenticate, (req, res) => {
  try {
    // Accept 'type' as alias for 'memory_type' (common API convention)
    if (req.body.type && !req.body.memory_type) {
      req.body.memory_type = req.body.type;
    }
    // Enforce tier limits on learned memory types
    const memoryType = req.body.memory_type;
    if (!memoryType) {
      return res.status(400).json({ error: 'memory_type is required (e.g. fact, preference, decision, observation, entity)' });
    }
    const check = quotaStore.checkWriteAllowed(req.org_id, req.user_id, memoryType);
    if (!check.allowed) {
      return res.status(403).json({
        error: 'Memory quota exceeded',
        ...check,
      });
    }

    // Spread body first, then override org_id/user_id from JWT to prevent tenant injection
    const { org_id: _o, user_id: _u, ...safeBody } = req.body;
    const memory = store.createMemory({
      ...safeBody,
      org_id: req.org_id,
      user_id: req.user_id,
    })

    // Update quota counters
    quotaStore.incrementQuota(req.org_id, req.user_id, memoryType);

    storeAuditEnvelope(MEM_INTENTS.MEMORY_CREATED, { memoryId: memory?.id, type: memoryType })
    res.status(201).json(memory)
  } catch (error) {
    // QSKL-13: structured rejection for wrong-layer / unknown-kind writes
    if (error.code === 'WRONG_LAYER') {
      return res.status(400).json({
        ok: false,
        error_code: error.code,
        layer: error.layer,
        suggested_action: error.suggested_action,
        reason: error.reason
      })
    }
    if (error.code === 'UNKNOWN_KIND') {
      return res.status(400).json({
        ok: false,
        error_code: error.code,
        allowed: error.allowed,
        reason: error.reason
      })
    }
    console.error('[Memory] Create error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get memory by ID
// MC4 fix: Skip reserved paths to prevent route collision with /search, /stats, etc.
const RESERVED_MEMORY_PATHS = new Set(['search', 'stats', 'export', 'core', 'migration', 'batch', 'consolidate', 'quota', 'org-users', 'timeline'])

// Codex cycle 4 #10: decision timeline + correction queue. Visibility is the
// caller's own beliefs plus the org-shared ones Dream writes (same rule as list).
const beliefScope = (req) => ({ org_id: req.org_id, user_ids: [req.user_id, store.ORG_SHARED_USER_ID] })

app.get('/api/memory/timeline', authenticate, (req, res) => {
  try {
    res.json({ decisions: store.getDecisionTimeline({ ...beliefScope(req), q: req.query.q || '', limit: req.query.limit }) })
  } catch (error) {
    console.error('[Memory] timeline error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/memory/:id/history', authenticate, (req, res) => {
  try {
    const history = store.getBeliefHistory(req.params.id, beliefScope(req))
    if (history.length === 0) return res.status(404).json({ error: 'Memory not found' })
    res.json({ history })
  } catch (error) {
    console.error('[Memory] history error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/api/memory/:id/reinstate', authenticate, (req, res) => {
  try {
    const m = store.getMemory(req.params.id)
    if (!m || m.org_id !== req.org_id) return res.status(404).json({ error: 'Memory not found' })
    // Own beliefs: the owner. Org-shared beliefs: an org admin/owner or the service.
    const role = req.user?.role
    const mayOrg = m.user_id === store.ORG_SHARED_USER_ID && (req.service === true || role === 'admin' || role === 'owner')
    if (m.user_id !== req.user_id && !mayOrg) return res.status(403).json({ error: 'Access denied' })
    let out
    try { out = store.reinstateBelief(m.id, { by: req.user_id }) } catch (e) { return res.status(409).json({ error: e.message }) }
    quotaStore.incrementQuota(out.reinstated.org_id, out.reinstated.user_id, out.reinstated.memory_type)
    quotaStore.decrementQuota(out.retired.org_id, out.retired.user_id, out.retired.memory_type)
    storeAuditEnvelope(MEM_INTENTS.MEMORY_UPDATED, { memoryId: m.id, action: 'reinstate', retiredId: out.retired.id })
    res.json(out)
  } catch (error) {
    console.error('[Memory] reinstate error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/memory/:id', authenticate, (req, res, next) => {
  // MC4 fix: Let specific routes handle reserved paths
  if (RESERVED_MEMORY_PATHS.has(req.params.id)) {
    return next('route')  // Skip to next matching route
  }

  try {
    const memory = store.getMemory(req.params.id)
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    // Verify ownership
    if (memory.org_id !== req.org_id || memory.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    res.json(memory)
  } catch (error) {
    console.error('[Memory] Get error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Update memory
app.patch('/api/memory/:id', authenticate, (req, res) => {
  try {
    const existing = store.getMemory(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    if (existing.org_id !== req.org_id || existing.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const memory = store.updateMemory(req.params.id, req.body)
    storeAuditEnvelope(MEM_INTENTS.MEMORY_UPDATED, { memoryId: req.params.id, fields: Object.keys(req.body || {}) })
    res.json(memory)
  } catch (error) {
    console.error('[Memory] Update error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete memory (soft by default)
// Account erasure (FND_01M4HZQ5P004YSXH0BWY04YSXH): called by the collector's
// GDPR handler on account deletion. Instance service key only (req.service is
// set by the key branch of authenticate, never by a JWT). Erases across orgs.
app.post('/internal/erase-user', authenticate, (req, res) => {
  if (req.service !== true) return res.status(403).json({ error: 'service_key_required' })
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
  if (!userId) return res.status(400).json({ error: 'userId required' })
  try {
    const out = store.eraseUser(userId)
    console.log(`[Memory] erase-user ${userId}: ${JSON.stringify(out)}`)
    res.json({ erased: true, ...out })
  } catch (error) {
    console.error('[Memory] erase-user failed:', error.message)
    res.status(error.message.includes('userId') ? 400 : 500).json({ error: 'erase failed' })
  }
})

app.delete('/api/memory/:id', authenticate, (req, res) => {
  try {
    const existing = store.getMemory(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Memory not found' })
    }
    if (existing.org_id !== req.org_id || existing.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const hard = req.query.hard === 'true'
    const result = store.deleteMemory(req.params.id, hard)

    // Decrement quota counters on delete
    quotaStore.decrementQuota(req.org_id, req.user_id, existing.memory_type);

    storeAuditEnvelope(MEM_INTENTS.MEMORY_DELETED, { memoryId: req.params.id, hard })
    res.json(result)
  } catch (error) {
    console.error('[Memory] Delete error:', error)
    res.status(500).json({ error: error.message })
  }
})

// List memories
app.get('/api/memory', authenticate, (req, res) => {
  try {
    const { agent_id, memory_type, valid, limit = 50, offset = 0, agent_scope, source_message_id } = req.query
    const memories = store.listMemories({
      source_message_id: typeof source_message_id === 'string' ? source_message_id : null,
      org_id: req.org_id,
      user_id: req.user_id,
      agent_id,
      memory_type,
      valid: valid === undefined ? true : valid === 'true',
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      // QUOXIDENTITY F8: agent-namespace read (drops user_id). Honoured only for
      // trusted internal service callers, never for a plain user JWT — a user
      // must not be able to broaden their own read past their user_id.
      agent_scope: agent_scope === '1' && req.user?.role === 'service'
    })
    res.json({ memories, count: memories.length })
  } catch (error) {
    console.error('[Memory] List error:', error)
    res.status(500).json({ error: error.message })
  }
})

// BRAIN2-W5 031: users that own memories in this org. Internal service callers
// only (X-Service-Key); a user JWT gets 403. Org comes from X-Org-Id, so one
// org can never enumerate another's users. Registered before /api/memory/:id.
app.get('/api/memory/org-users', authenticate, (req, res) => {
  if (req.user?.role !== 'service') return res.status(403).json({ error: 'service callers only' })
  try {
    res.json({ users: store.listMemoryUserIds({ org_id: req.org_id }) })
  } catch (error) {
    console.error('[Memory] org-users error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Search memories (FTS5)
app.get('/api/memory/search', authenticate, (req, res) => {
  try {
    const { q, query, type, agent_id, limit = 10, agent_scope } = req.query
    const searchQuery = q || query
    if (!searchQuery) {
      return res.status(400).json({ error: 'Query parameter (q) required' })
    }

    const results = store.searchMemories({
      org_id: req.org_id,
      user_id: req.user_id,
      query: searchQuery,
      memory_type: type,
      agent_id,
      limit: parseInt(limit, 10),
      // QUOXIDENTITY F8: agent-namespace search, internal service callers only.
      agent_scope: agent_scope === '1' && req.user?.role === 'service'
    })
    res.json({ results, count: results.length })
  } catch (error) {
    console.error('[Memory] Search error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// CORE MEMORIES
// =============================================================================

// Get core memories for agent
app.get('/api/memory/core', authenticate, (req, res) => {
  try {
    const { agent_id, agent_scope } = req.query
    if (!agent_id) {
      return res.status(400).json({ error: 'agent_id required' })
    }

    const memories = store.getCoreMemories({
      org_id: req.org_id,
      user_id: req.user_id,
      agent_id,
      // QUOXIDENTITY F8: agent-namespace core read, internal service callers only.
      agent_scope: agent_scope === '1' && req.user?.role === 'service'
    })
    res.json({ memories })
  } catch (error) {
    console.error('[Core Memory] Get error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Upsert core memory
app.put('/api/memory/core', authenticate, (req, res) => {
  try {
    const { agent_id, label, content, token_count } = req.body
    if (!agent_id || !label || !content) {
      return res.status(400).json({ error: 'agent_id, label, and content required' })
    }

    const memory = store.upsertCoreMemory({
      org_id: req.org_id,
      user_id: req.user_id,
      agent_id,
      label,
      content,
      token_count
    })
    storeAuditEnvelope(MEM_INTENTS.CORE_UPSERTED, { agentId: agent_id, label })
    res.json(memory)
  } catch (error) {
    console.error('[Core Memory] Upsert error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete core memory
app.delete('/api/memory/core', authenticate, (req, res) => {
  try {
    const { agent_id, label } = req.query
    if (!agent_id || !label) {
      return res.status(400).json({ error: 'agent_id and label required' })
    }

    const result = store.deleteCoreMemory({
      org_id: req.org_id,
      user_id: req.user_id,
      agent_id,
      label
    })
    storeAuditEnvelope(MEM_INTENTS.CORE_DELETED, { agentId: agent_id, label })
    res.json(result)
  } catch (error) {
    console.error('[Core Memory] Delete error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// IDENTITY (TRUST-GATE-1.15 / 1.16)
// Generic namespaced document store for user "identity" data that used to
// live ONLY in browser localStorage (profile, projects, narratives,
// syntheses, trends, personalization, reflection_state,
// importance_evolution, alerts). One blob per (org, user, namespace) —
// deliberately NOT 8+ bespoke schemas; this data is document-shaped and
// versioned by updated_at.
// =============================================================================

const IDENTITY_NAMESPACES = new Set([
  'profile', 'projects', 'narratives', 'syntheses', 'trends',
  'personalization', 'reflection_state', 'importance_evolution', 'alerts',
  // G2a: privacy settings (levels/expirations/anonymized) were localStorage-only
  // — a fresh browser reset them to defaults. Now server-authoritative here.
  'privacy',
  // QMH2-CONSOLIDATION: WSM / Beliefs / Failures / Style used to live ONLY
  // in browser localStorage + a duplicate sync to auth-service preferences
  // JSON (the wrong store). They now write through here — identity_blobs is
  // the sanctioned org+user+namespace-scoped store — and the auth-prefs
  // duplication has been retired.
  'working_set', 'beliefs', 'failures', 'style',
  // D2-PROMOTION-PIPELINE: the memory promotion pipeline (cold storage
  // imports, promotion rules, promotion log, import stats) moved here from a
  // raw, non-org-scoped global localStorage key plus a duplicate write to
  // auth-service users.preferences_json (the same wrong-store pattern
  // QMH2-CONSOLIDATION retired above). See src/services/memoryPromotion.js.
  'promotion',
  // BRAIN2-V2 P2d: Brain2 workspace layout prefs (rail collapse + dock width).
  // A DEDICATED namespace nothing else writes, so its full-document PUT has no
  // cross-writer clobber. Pure disposable UI geometry — no saved views.
  'brain_workspace',
])

// Get an identity blob for the caller's namespace
app.get('/api/memory/identity/:namespace', authenticate, (req, res) => {
  try {
    const { namespace } = req.params
    if (!IDENTITY_NAMESPACES.has(namespace)) {
      return res.status(400).json({ error: `Unknown identity namespace: ${namespace}` })
    }
    const result = identityStore.getIdentity(req.org_id, req.user_id, namespace)
    res.json({ namespace, data: result?.data ?? null, updated_at: result?.updated_at ?? null })
  } catch (error) {
    console.error('[Identity] Get error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Upsert an identity blob for the caller's namespace
app.put('/api/memory/identity/:namespace', authenticate, (req, res) => {
  try {
    const { namespace } = req.params
    if (!IDENTITY_NAMESPACES.has(namespace)) {
      return res.status(400).json({ error: `Unknown identity namespace: ${namespace}` })
    }
    if (!('data' in req.body)) {
      return res.status(400).json({ error: 'data is required' })
    }
    const result = identityStore.setIdentity(req.org_id, req.user_id, namespace, req.body.data)
    storeAuditEnvelope(MEM_INTENTS.IDENTITY_UPSERTED, { namespace })
    res.json(result)
  } catch (error) {
    console.error('[Identity] Put error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// ENTITIES
// =============================================================================

// Create/upsert entity (with quota enforcement)
app.post('/api/entity', authenticate, (req, res) => {
  try {
    // fleet #374: accept the short natural names as aliases for the
    // canonical column names, same convention POST /api/memory already
    // uses for type -> memory_type (line ~215). The internal column names
    // were leaking out as the API contract, so any caller writing the
    // obvious `type`/`metadata` got a 400. Normalising at the edge fixes
    // this for every client at once rather than per-caller.
    if (req.body.type && !req.body.entity_type) req.body.entity_type = req.body.type
    if (req.body.metadata && !req.body.attributes) req.body.attributes = req.body.metadata

    const { name, entity_type, attributes } = req.body
    if (!name || !entity_type) {
      return res.status(400).json({ error: 'name and entity_type required (aliases accepted: type, metadata)' })
    }

    // Check entity quota (only for new entities, not upserts)
    const check = quotaStore.checkEntityAllowed(req.org_id, req.user_id);
    if (!check.allowed) {
      return res.status(403).json({
        error: 'Entity quota exceeded',
        ...check,
      });
    }

    const entity = store.createEntity({
      org_id: req.org_id,
      user_id: req.user_id,
      name,
      entity_type,
      attributes
    })

    // Increment entity quota (createEntity uses UPSERT, so only count if actually new)
    if (entity && !entity.updated) {
      quotaStore.incrementEntityQuota(req.org_id, req.user_id);
    }

    storeAuditEnvelope(MEM_INTENTS.ENTITY_CREATED, { entityId: entity?.id, type: entity_type, name: (name || '').slice(0, 100) })
    res.status(201).json(entity)
  } catch (error) {
    console.error('[Entity] Create error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get entity with relations
// fleet #368: /search must be registered before the /:id route below —
// Express matches routes in registration order, so /:id was catching
// "search" as a literal id first and every search request 404'd with
// "Entity not found" (id="search") before this handler was ever reached.
app.get('/api/entity/search', authenticate, (req, res) => {
  try {
    const { q, query, type, limit = 10 } = req.query
    const searchQuery = q || query
    if (!searchQuery) {
      return res.status(400).json({ error: 'Query parameter (q) required' })
    }

    const results = store.searchEntities({
      org_id: req.org_id,
      user_id: req.user_id,
      query: searchQuery,
      entity_type: type,
      limit: parseInt(limit, 10)
    })
    res.json({ results, count: results.length })
  } catch (error) {
    console.error('[Entity] Search error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/api/entity/:id', authenticate, (req, res) => {
  try {
    const entity = store.getEntity(req.params.id)
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' })
    }
    if (entity.org_id !== req.org_id || entity.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    res.json(entity)
  } catch (error) {
    console.error('[Entity] Get error:', error)
    res.status(500).json({ error: error.message })
  }
})

// List entities
app.get('/api/entity', authenticate, (req, res) => {
  try {
    const { type, limit = 50, offset = 0 } = req.query
    const entities = store.listEntities({
      org_id: req.org_id,
      user_id: req.user_id,
      entity_type: type,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    })
    res.json({ entities, count: entities.length })
  } catch (error) {
    console.error('[Entity] List error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Create relation
app.post('/api/entity/relation', authenticate, (req, res) => {
  try {
    // fleet #377: same alias normalisation as POST /api/entity above —
    // every field here had a different name than any caller would guess,
    // so this endpoint had never successfully been called from the CLI.
    if (req.body.from_id && !req.body.source_entity_id) req.body.source_entity_id = req.body.from_id
    if (req.body.to_id && !req.body.target_entity_id) req.body.target_entity_id = req.body.to_id
    if (req.body.type && !req.body.relation_type) req.body.relation_type = req.body.type

    const { source_entity_id, relation_type, target_entity_id, context, confidence } = req.body
    if (!source_entity_id || !relation_type || !target_entity_id) {
      return res.status(400).json({ error: 'source_entity_id, relation_type, and target_entity_id required (aliases accepted: from_id, to_id, type)' })
    }

    const relation = store.createRelation({
      org_id: req.org_id,
      source_entity_id,
      relation_type,
      target_entity_id,
      context,
      confidence
    })
    storeAuditEnvelope(MEM_INTENTS.RELATION_CREATED, { relationType: relation_type, source: source_entity_id, target: target_entity_id })
    res.status(201).json(relation)
  } catch (error) {
    console.error('[Relation] Create error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete relation (soft by default). Registered BEFORE DELETE /api/entity/:id
// below, same defensive ordering as GET /api/entity/search vs GET /api/entity/:id
// above — fleet #383.
app.delete('/api/entity/relation/:id', authenticate, (req, res) => {
  try {
    const existing = store.getRelation(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Relation not found' })
    }
    if (existing.org_id !== req.org_id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const hard = req.query.hard === 'true'
    const result = store.deleteRelation(req.params.id, hard)

    storeAuditEnvelope(MEM_INTENTS.RELATION_DELETED, { relationId: req.params.id, hard })
    res.json(result)
  } catch (error) {
    console.error('[Relation] Delete error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete entity (soft by default). Cascades to the entity's relations —
// hard deletes them, soft-deletes them with the same timestamp. fleet #383.
app.delete('/api/entity/:id', authenticate, (req, res) => {
  try {
    const existing = store.getEntity(req.params.id)
    if (!existing) {
      return res.status(404).json({ error: 'Entity not found' })
    }
    if (existing.org_id !== req.org_id || existing.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const hard = req.query.hard === 'true'
    // quox#571 Part 4, Fix 1b: entity_count only ever grew before this —
    // decrement on delete so entities freed up don't march toward the cap
    // forever. Gate on the entity not being already soft-deleted (a repeat
    // delete of an already-gone entity must not under-count). Use the entity's
    // OWN org/user (matched to req scope above) for symmetry with increment.
    const alreadyGone = !hard && existing.deleted_at != null
    const result = store.deleteEntity(req.params.id, hard)
    if (!alreadyGone) {
      quotaStore.decrementEntityQuota(existing.org_id, existing.user_id)
    }

    storeAuditEnvelope(MEM_INTENTS.ENTITY_DELETED, { entityId: req.params.id, hard, relationsRemoved: result.relations_removed })
    res.json(result)
  } catch (error) {
    console.error('[Entity] Delete error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// CONVERSATION SUMMARIES
// =============================================================================

// Get conversation summary
app.get('/api/conversation/:id/summary', authenticate, (req, res) => {
  try {
    const summary = store.getConversationSummary(req.params.id)
    if (!summary) {
      return res.status(404).json({ error: 'Summary not found' })
    }
    if (summary.org_id !== req.org_id || summary.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    res.json(summary)
  } catch (error) {
    console.error('[Summary] Get error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Create/update conversation summary
app.post('/api/conversation/:id/summary', authenticate, (req, res) => {
  try {
    // Strip tenant fields from body to prevent injection
    const { org_id: _o, user_id: _u, ...safeSummaryBody } = req.body;
    const summary = store.createConversationSummary({
      ...safeSummaryBody,
      org_id: req.org_id,
      user_id: req.user_id,
      conversation_id: req.params.id,
    })
    storeAuditEnvelope(MEM_INTENTS.SUMMARY_CREATED, { conversationId: req.params.id })

    // D4: co-occurrence linker — a summary's entities_mentioned list is one
    // "document". entities_mentioned holds entity NAMES (see live callers /
    // tests), so resolve to ids scoped to this org/user before linking.
    // Never lets a linking failure fail the summary write.
    try {
      const mentionedNames = Array.isArray(summary?.entities_mentioned) ? summary.entities_mentioned : []
      if (mentionedNames.length >= 2) {
        const db = getDatabase()
        const placeholders = mentionedNames.map(() => '?').join(',')
        const resolved = db.prepare(`
          SELECT id FROM entities WHERE org_id = ? AND user_id = ? AND name IN (${placeholders})
        `).all(req.org_id, req.user_id, ...mentionedNames)
        const entityIds = resolved.map((r) => r.id)
        const linkResult = linkCoOccurringEntities(db, {
          org_id: req.org_id,
          user_id: req.user_id,
          entityIds,
          sourceKind: 'summary',
          sourceRef: req.params.id
        })
        if (linkResult.pairs_linked > 0 || linkResult.pairs_skipped > 0) {
          storeAuditEnvelope(MEM_INTENTS.RELATIONS_LINKED, { source: 'summary', conversationId: req.params.id, ...linkResult })
        }
      }
    } catch (linkErr) {
      console.warn('[Summary] Entity linking failed (non-fatal):', linkErr.message)
    }

    res.status(201).json(summary)
  } catch (error) {
    console.error('[Summary] Create error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// MIGRATION
// =============================================================================

// Migrate from localStorage
app.post('/api/memory/migrate', authenticate, (req, res) => {
  try {
    const { memories = [], entities = [] } = req.body

    // Check if already migrated
    const existingMigration = store.getMigrationStatus(req.user_id)
    if (existingMigration?.status === 'completed') {
      return res.json({
        status: 'already_migrated',
        migrated_at: existingMigration.completed_at
      })
    }

    // Create migration record
    const migration = store.createMigration({
      user_id: req.user_id,
      source: 'localStorage',
      memories_count: memories.length,
      entities_count: entities.length
    })

    try {
      // Import memories
      let memoriesImported = 0
      for (const m of memories) {
        store.createMemory({
          org_id: req.org_id,
          user_id: req.user_id,
          agent_id: m.agent_id || null,
          memory_type: m.type || m.memory_type || 'fact',
          content: m.content,
          importance: m.importance || 'medium',
          tags: m.tags || [],
          provenance: 'model_inference',
          source_conversation_id: m.conversation_id || null
        })
        memoriesImported++
      }

      // Import entities
      let entitiesImported = 0
      const migratedEntityIds = []
      for (const e of entities) {
        const createdEntity = store.createEntity({
          org_id: req.org_id,
          user_id: req.user_id,
          name: e.name,
          entity_type: e.type || e.entity_type || 'concept',
          attributes: e.attributes || {}
        })
        if (createdEntity?.id) migratedEntityIds.push(createdEntity.id)
        entitiesImported++
      }

      // D4: co-occurrence linker — this migrate call is one "document";
      // never lets a linking failure fail the migration itself.
      try {
        const linkResult = linkCoOccurringEntities(getDatabase(), {
          org_id: req.org_id,
          user_id: req.user_id,
          entityIds: migratedEntityIds,
          sourceKind: 'migrate'
        })
        if (linkResult.pairs_linked > 0 || linkResult.pairs_skipped > 0) {
          storeAuditEnvelope(MEM_INTENTS.RELATIONS_LINKED, { source: 'migrate', ...linkResult })
        }
      } catch (linkErr) {
        console.warn('[Migration] Entity linking failed (non-fatal):', linkErr.message)
      }

      store.completeMigration(migration.id)

      storeAuditEnvelope(MEM_INTENTS.MIGRATED, { memoriesImported, entitiesImported })
      res.json({
        status: 'completed',
        memories_imported: memoriesImported,
        entities_imported: entitiesImported
      })
    } catch (error) {
      store.completeMigration(migration.id, error.message)
      throw error
    }
  } catch (error) {
    console.error('[Migration] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Check migration status
app.get('/api/memory/migration/status', authenticate, (req, res) => {
  try {
    const status = store.getMigrationStatus(req.user_id)
    res.json(status || { status: 'not_started' })
  } catch (error) {
    console.error('[Migration] Status error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// STATS & EXPORT
// =============================================================================

// Get memory statistics
app.get('/api/memory/stats', authenticate, (req, res) => {
  try {
    const stats = store.getStats({
      org_id: req.org_id,
      user_id: req.user_id
    })
    res.json(stats)
  } catch (error) {
    console.error('[Stats] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// QUOTAS & TIERS
// =============================================================================

// Get current quota and tier status
app.get('/api/memory/quota', authenticate, (req, res) => {
  try {
    const quota = quotaStore.getQuota(req.org_id, req.user_id);
    const limits = quotaStore.TIER_LIMITS[quota.tier] || quotaStore.TIER_LIMITS.free;
    res.json({ ...quota, limits });
  } catch (error) {
    console.error('[Quota] Get error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set user tier (admin only — called by plugin activation)
app.post('/api/memory/quota/tier', authenticate, requireAdmin, (req, res) => {
  try {
    const { tier, source, expires_at } = req.body;
    if (!tier || !['free', 'premium'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be "free" or "premium"' });
    }
    const updated = quotaStore.setTier(req.org_id, req.user_id, tier, source || 'plugin', expires_at || null);
    const limits = quotaStore.TIER_LIMITS[updated.tier] || quotaStore.TIER_LIMITS.free;
    storeAuditEnvelope(MEM_INTENTS.TIER_SET, { tier, source: source || 'plugin' })
    res.json({ ...updated, limits });
  } catch (error) {
    console.error('[Quota] Set tier error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Recalculate quota counts from actual data (admin only)
app.post('/api/memory/quota/recalculate', authenticate, requireAdmin, (req, res) => {
  try {
    const updated = quotaStore.recalculateQuota(req.org_id, req.user_id);
    const limits = quotaStore.TIER_LIMITS[updated.tier] || quotaStore.TIER_LIMITS.free;
    storeAuditEnvelope(MEM_INTENTS.QUOTA_RECALCULATED, {})
    res.json({ ...updated, limits });
  } catch (error) {
    console.error('[Quota] Recalculate error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// EXPORT
// =============================================================================

// Export all memories (for backup/GDPR)
app.get('/api/memory/export', authenticate, (req, res) => {
  try {
    const memories = store.listMemories({
      org_id: req.org_id,
      user_id: req.user_id,
      valid: null, // Include deleted
      limit: 10000
    })

    const entities = store.listEntities({
      org_id: req.org_id,
      user_id: req.user_id,
      limit: 10000
    })

    const coreMemories = []
    // Get core memories for all agents
    const agents = ['quox', 'sentinel', 'cipher', 'nova', 'atlas', 'metrics', 'oracle', 'beacon', 'codex']
    for (const agent_id of agents) {
      const agentCore = store.getCoreMemories({ org_id: req.org_id, user_id: req.user_id, agent_id })
      coreMemories.push(...agentCore)
    }

    res.json({
      exported_at: new Date().toISOString(),
      user_id: req.user_id,
      org_id: req.org_id,
      memories,
      entities,
      core_memories: coreMemories
    })
  } catch (error) {
    console.error('[Export] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// BATCH OPERATIONS (n8n workflow support)
// =============================================================================

// Batch create memories and entities
// Issue #165 fix: Added transaction wrapping for atomicity
app.post('/api/memory/batch', authenticate, (req, res) => {
  const db = getDatabase()
  const results = {
    memories_created: 0,
    entities_created: 0,
    errors: []
  }

  try {
    const { memories = [], entities = [] } = req.body

    // Begin transaction for atomic batch operations
    db.exec('BEGIN TRANSACTION')

    // Create memories
    for (const m of memories) {
      try {
        store.createMemory({
          org_id: req.org_id,
          user_id: req.user_id,
          agent_id: m.agent_id || null,
          memory_type: m.type || m.memory_type || 'fact',
          content: m.content,
          importance: m.importance || 'medium',
          tags: m.tags || [],
          provenance: m.provenance || 'model_inference',
          source_conversation_id: m.source_conversation_id || null
        })
        results.memories_created++
      } catch (err) {
        results.errors.push({ type: 'memory', content: m.content?.slice(0, 50), error: err.message })
      }
    }

    // Create entities
    const batchEntityIds = []
    for (const e of entities) {
      try {
        const createdEntity = store.createEntity({
          org_id: req.org_id,
          user_id: req.user_id,
          name: e.name,
          entity_type: e.type || e.entity_type || 'concept',
          attributes: e.attributes || {}
        })
        if (createdEntity?.id) batchEntityIds.push(createdEntity.id)
        results.entities_created++
      } catch (err) {
        results.errors.push({ type: 'entity', name: e.name, error: err.message })
      }
    }

    // D4: co-occurrence linker — this batch call is one "document". Runs
    // inline inside the same open transaction (bounded cost, see
    // lib/entityLinker.js); a linking failure must never fail the batch.
    let linkResult = { pairs_linked: 0, pairs_skipped: 0 }
    try {
      linkResult = linkCoOccurringEntities(db, {
        org_id: req.org_id,
        user_id: req.user_id,
        entityIds: batchEntityIds,
        sourceKind: 'batch'
      })
    } catch (linkErr) {
      console.warn('[Batch] Entity linking failed (non-fatal):', linkErr.message)
    }

    // Commit if we created anything, otherwise rollback
    if (results.memories_created > 0 || results.entities_created > 0) {
      db.exec('COMMIT')
      storeAuditEnvelope(MEM_INTENTS.BATCH_CREATED, { memoriesCreated: results.memories_created, entitiesCreated: results.entities_created })
      if (linkResult.pairs_linked > 0 || linkResult.pairs_skipped > 0) {
        storeAuditEnvelope(MEM_INTENTS.RELATIONS_LINKED, { source: 'batch', ...linkResult })
      }
    } else {
      db.exec('ROLLBACK')
    }

    res.status(201).json({
      status: 'completed',
      count: results.memories_created + results.entities_created,
      ...results
    })
  } catch (error) {
    // Rollback on error
    try {
      db.exec('ROLLBACK')
    } catch (rollbackErr) {
      console.error('[Batch] Rollback failed:', rollbackErr)
    }
    console.error('[Batch] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// CONSOLIDATION (n8n workflow support)
// =============================================================================

// Apply consolidation actions from Claude analysis
// Issue #165 fix: Added transaction wrapping for atomicity
app.post('/api/memory/consolidate', authenticate, (req, res) => {
  const db = getDatabase()
  const results = {
    merged: 0,
    resolved: 0,
    promoted: 0,
    archived: 0,
    errors: []
  }

  try {
    const { duplicates = [], contradictions = [], promote_to_core = [], archive_ids = [] } = req.body

    // quox#571 Part 4, Fix 1a: consolidation invalidates learned memories but
    // never decremented the quota, so a background scheduler silently drifted
    // learned_count upward and falsely capped honest users. Track every
    // (org,user) whose memory we invalidate here; decrement per-memory below,
    // then recalculate those users' quotas from real data after commit as the
    // self-heal backstop (Fix 1c). The scheduler authenticates as the 'service'
    // user, so we key on each memory ROW's own org_id/user_id, never req scope.
    const affectedQuota = new Map()
    const trackAffected = (orgId, userId) => affectedQuota.set(`${orgId}\u0000${userId}`, { orgId, userId })
    const decrementForInvalidated = (mem) => {
      if (quotaStore.decrementQuotaForInvalidatedMemory(mem)) trackAffected(mem.org_id, mem.user_id)
    }

    const mergeMeta = (id, extra) => ({ ...(store.getMemory(id)?.metadata || {}), ...extra })

    // Begin transaction for atomic consolidation
    db.exec('BEGIN TRANSACTION')

    // Merge duplicates - keep first, mark others as superseded
    // MC6 fix: Added ownership verification for all memory IDs
    for (const dup of duplicates) {
      try {
        const { memory_ids, merged_content, reason } = dup
        if (!memory_ids || memory_ids.length < 2) continue

        // MC6 fix: Verify ownership of ALL memories before modifying any
        const accessDenied = memory_ids.some(id => {
          const mem = store.getMemory(id)
          return !mem || mem.org_id !== req.org_id || mem.user_id !== req.user_id
        })
        if (accessDenied) {
          results.errors.push({ type: 'merge', ids: memory_ids, error: 'Access denied to one or more memories' })
          continue
        }

        // Update first memory with merged content
        const keepId = memory_ids[0]
        // Merge into existing metadata (it carries source dates, supersedes links
        // and a user's disputed_claims); only replace content when some is given.
        store.updateMemory(keepId, {
          ...(merged_content ? { content: merged_content } : {}),
          metadata: mergeMeta(keepId, { merged_from: memory_ids.slice(1), merge_reason: reason })
        })

        // Mark others as superseded
        for (const id of memory_ids.slice(1)) {
          decrementForInvalidated(store.getMemory(id)) // Fix 1a: before invalidation, while still valid
          store.updateMemory(id, {
            valid: false,
            superseded_by: keepId,
            metadata: mergeMeta(id, { superseded_reason: 'duplicate_merge' })
          })
        }
        results.merged++
      } catch (err) {
        results.errors.push({ type: 'merge', ids: dup.memory_ids, error: err.message })
      }
    }

    // Resolve contradictions - mark superseded memory as invalid
    // MC6 fix: Added ownership verification
    for (const contra of contradictions) {
      try {
        const { memory_ids, supersede_id, resolution, superseded_at } = contra
        if (!supersede_id) continue

        // MC6 fix: Verify ownership before modification
        const supersedeMem = store.getMemory(supersede_id)
        if (!supersedeMem || supersedeMem.org_id !== req.org_id || supersedeMem.user_id !== req.user_id) {
          results.errors.push({ type: 'contradiction', id: supersede_id, error: 'Access denied' })
          continue
        }

        const keepId = memory_ids?.find(id => id !== supersede_id)
        // BRAIN2-W7 D 006: the winner gets the same ownership check as the loser.
        if (keepId) {
          const keepMem = store.getMemory(keepId)
          if (!keepMem || keepMem.org_id !== req.org_id || keepMem.user_id !== req.user_id) {
            results.errors.push({ type: 'contradiction', id: keepId, error: 'Winning memory not found or access denied' })
            continue
          }
        }
        decrementForInvalidated(supersedeMem) // Fix 1a
        store.updateMemory(supersede_id, {
          valid: false,
          superseded_by: keepId || null,
          metadata: mergeMeta(supersede_id, { contradiction_resolution: resolution, superseded_reason: resolution, superseded_at: superseded_at || new Date().toISOString() })
        })
        results.resolved++
      } catch (err) {
        results.errors.push({ type: 'contradiction', id: contra.supersede_id, error: err.message })
      }
    }

    // Promote to core memories
    for (const promo of promote_to_core) {
      try {
        const { memory_id, label, reason } = promo
        if (!memory_id || !label) continue

        const memory = store.getMemory(memory_id)
        if (!memory) continue

        // Verify ownership
        if (memory.org_id !== req.org_id || memory.user_id !== req.user_id) continue

        store.upsertCoreMemory({
          org_id: req.org_id,
          user_id: req.user_id,
          agent_id: memory.agent_id || 'quox',
          label,
          content: memory.content,
          token_count: Math.ceil(memory.content.length / 4)
        })

        // Mark original with promoted flag
        store.updateMemory(memory_id, {
          importance: 'critical',
          metadata: mergeMeta(memory_id, { promoted_to_core: label, promotion_reason: reason })
        })
        results.promoted++
      } catch (err) {
        results.errors.push({ type: 'promote', id: promo.memory_id, error: err.message })
      }
    }

    // Archive stale memories
    for (const id of archive_ids) {
      try {
        const memory = store.getMemory(id)
        if (!memory) continue
        if (memory.org_id !== req.org_id || memory.user_id !== req.user_id) continue

        decrementForInvalidated(memory) // Fix 1a
        store.updateMemory(id, {
          valid: false,
          metadata: mergeMeta(id, { archived_reason: 'stale', archived_at: new Date().toISOString() })
        })
        results.archived++
      } catch (err) {
        results.errors.push({ type: 'archive', id, error: err.message })
      }
    }

    // Commit transaction
    db.exec('COMMIT')

    // quox#571 Part 4, Fix 1c: self-heal backstop. After the invalidations are
    // durable, recalculate each affected user's quota straight from real data
    // so any arithmetic drift (or historical drift from before this fix) is
    // corrected. Cheap: only users touched this pass, and only when something
    // was actually invalidated. Never fails the request — a recalc miss must
    // not undo a committed consolidation.
    for (const { orgId, userId } of affectedQuota.values()) {
      try {
        quotaStore.recalculateQuota(orgId, userId)
      } catch (recalcErr) {
        console.error(`[Consolidation] quota recalc failed for ${orgId}/${userId}:`, recalcErr.message)
      }
    }

    storeAuditEnvelope(MEM_INTENTS.CONSOLIDATED, { merged: results.merged, resolved: results.resolved, promoted: results.promoted, archived: results.archived })
    res.json({
      status: 'completed',
      timestamp: new Date().toISOString(),
      ...results
    })
  } catch (error) {
    // Rollback on error
    try {
      db.exec('ROLLBACK')
    } catch (rollbackErr) {
      console.error('[Consolidation] Rollback failed:', rollbackErr)
    }
    console.error('[Consolidation] Error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// CONVERSATION ARCHIVES
// =============================================================================

// List conversations with filters
app.get('/api/conversations', authenticate, (req, res) => {
  try {
    const { platform, limit = 50, offset = 0 } = req.query
    const conversations = archiveStore.getConversations({
      org_id: req.org_id,
      user_id: req.user_id,
      platform,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    })
    res.json({ conversations, count: conversations.length })
  } catch (error) {
    console.error('[Conversations] List error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get archive stats
app.get('/api/conversations/stats', authenticate, (req, res) => {
  try {
    const stats = archiveStore.getArchiveStats(req.org_id, req.user_id)
    res.json(stats)
  } catch (error) {
    console.error('[Conversations] Stats error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Search conversations (FTS5)
app.get('/api/conversations/search', authenticate, (req, res) => {
  try {
    const { q, query, platform, limit = 20 } = req.query
    const searchQuery = q || query
    if (!searchQuery) {
      return res.status(400).json({ error: 'Query parameter q is required' })
    }
    const results = archiveStore.searchConversations({
      org_id: req.org_id,
      user_id: req.user_id,
      query: searchQuery,
      platform,
      limit: parseInt(limit, 10)
    })
    res.json({ results, count: results.length })
  } catch (error) {
    console.error('[Conversations] Search error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Get single conversation with messages
app.get('/api/conversations/:id', authenticate, (req, res) => {
  try {
    const conversation = archiveStore.getConversation(req.params.id)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }
    if (conversation.org_id !== req.org_id || conversation.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    res.json(conversation)
  } catch (error) {
    console.error('[Conversations] Get error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Batch import conversations
app.post('/api/conversations/batch', authenticate, (req, res) => {
  try {
    const { conversations } = req.body
    if (!conversations || !Array.isArray(conversations)) {
      return res.status(400).json({ error: 'conversations array is required' })
    }
    const results = archiveStore.saveConversationBatch(
      conversations,
      req.org_id,
      req.user_id
    )
    storeAuditEnvelope(MEM_INTENTS.CONV_BATCH_IMPORTED, { count: conversations.length })
    res.status(201).json(results)
  } catch (error) {
    console.error('[Conversations] Batch import error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Delete conversation
app.delete('/api/conversations/:id', authenticate, (req, res) => {
  try {
    const conversation = archiveStore.getConversation(req.params.id)
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }
    if (conversation.org_id !== req.org_id || conversation.user_id !== req.user_id) {
      return res.status(403).json({ error: 'Access denied' })
    }
    archiveStore.deleteConversation(req.params.id)
    storeAuditEnvelope(MEM_INTENTS.CONV_DELETED, { conversationId: req.params.id })
    res.json({ deleted: true })
  } catch (error) {
    console.error('[Conversations] Delete error:', error)
    res.status(500).json({ error: error.message })
  }
})

// CLI-PARITY WP1.1: runtime route-introspection helper for GET /__routes.
// Loaded fail-safe via a guarded dynamic import — a static top-level
// `import` of a missing file is a hard boot failure in ESM, so any
// Dockerfile/path drift would crash-loop the whole memory service.
// Degrades to an empty route list instead. This service's Docker build
// context is ./services/memory (see docker-compose.yml
// `memory.build.context`), so it can't reach services/shared/* — a local
// copy lives at ./lib/.
let __listRoutes = () => []
try {
  const mod = await import('./lib/routeIntrospection.cjs')
  __listRoutes = mod.listRoutes
} catch (err) {
  console.warn('[ROUTE_INTROSPECTION] Failed to load ./lib/routeIntrospection.cjs:', err.message)
}

// CLI-PARITY WP1.1: GET /__routes — fully-resolved route table for the CLI's
// live-vs-static endpoint diff. Mounted last (after every app.use/route
// above) so listRoutes(app) reflects every router actually attached to this
// app instance.
// Auth: same `authenticate` middleware every other route in this service
// uses (accepts X-Service-Key OR JWT — see ./middleware/auth.js).
app.get('/__routes', authenticate, (req, res) => {
  res.json({ service: 'memory', routes: __listRoutes(app) })
})

// =============================================================================
// START SERVER
// =============================================================================

// Global error sanitizer — prevent internal details leaking to users
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'cors_rejected', message: 'Origin not allowed' })
  }
  console.error(`[Memory] Unhandled error on ${req.method} ${req.path}:`, err.message)
  const safeMessage = (process.env.NODE_ENV === 'production')
    ? 'An internal error occurred'
    : err.message?.substring(0, 200) || 'Unknown error'
  res.status(err.status || 500).json({ error: safeMessage })
})

// Initialize database
initDatabase(DB_PATH)

// quox#571 Part 4: only bind the port and install signal handlers when this
// file is run directly (`node server.js`, as the Docker start command does).
// When imported as a module (integration tests using supertest against the
// default export), skip listen() so the test runner isn't held open by a live
// socket. The team's route tests previously copied handler logic into minimal
// apps solely to avoid this import-binds-a-port trap — this guard removes it.
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (isMain) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Memory Service] Running on port ${PORT}`)
    console.log(`[Memory Service] Database: ${DB_PATH}`)
    console.log(`[Memory Service] Environment: ${process.env.NODE_ENV || 'development'}`)
  })

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[Memory Service] SIGTERM received, shutting down...')
    server.close(() => {
      closeDatabase()
      process.exit(0)
    })
  })

  process.on('SIGINT', () => {
    console.log('[Memory Service] SIGINT received, shutting down...')
    server.close(() => {
      closeDatabase()
      process.exit(0)
    })
  })
}

export default app

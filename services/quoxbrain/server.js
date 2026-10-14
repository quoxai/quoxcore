// QuoxCORE Brain Service (P0.1 foundation)
// Knowledge graph / vault indexing service — mirrors services/memory's boot
// sequence exactly. NO parser/ingest/vault business routes yet (P0.2/P0.3);
// this phase proves the service boots, has a migrated schema, and is
// auth-gated + org-scoped.

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { readFileSync, realpathSync } from 'fs'
import { sep, resolve } from 'path'
import { pathToFileURL } from 'node:url'
import { initDatabase, closeDatabase, getDatabase } from './lib/db.js'
import { authenticate, assertServiceKeyConfiguredForProduction } from './middleware/auth.js'
import * as store from './lib/vaultStore.js'
import { indexVault, ingestDocuments } from './lib/ingest.js'
import * as notesq from './lib/notesq.js'
import * as notesqInsights from './lib/notesqInsights.js'
import * as notesqSchedules from './lib/notesqSchedules.js'
import { resolveSafeVaultPath } from './lib/vaultRoot.js'
import { ensureLegHeads, LEG_HEAD_N, buildNoteExcerpt, prefetchQueryEmbedding, assembleContext, tryHybridFusion, isHybridEnabled, dedupeByNote, resolveOrgRetrievalConfig, searchChunksWithQuota } from './lib/contextAssembler.js'
import { computeRelevance, rerankVetoHolds } from './lib/relevance.js'
import { getEmbeddingProviderCached, composeEmbeddingsStatus, getEmbeddingCoverageCached } from './lib/embeddingStatus.js'
import { describeEffectiveConfig } from './lib/effectiveConfig.js'
import { resolveDreamLlmAllowed, resolveEmbedExclusions, describeEgress, resolveRelevanceThresholds, resolveQueryEmbedTimeout, resolveRerankEnabledDetailed, resolveExpandEnabledDetailed } from './lib/brainConfig.js'
import { groundingForTop, modeEntities, normalizeGroundingMode, DEFAULT_GROUNDING_MODE } from './lib/entityGrounding.js'
import { maybeRerank, RERANK_TOP_N, RERANK_TOP_N_EXPANDED } from './lib/rerank.js'
import { resolveExpansion } from './lib/expand.js'
import { guaranteedNoteIds, perResultExplain, explainTarget, hasActiveFacets } from './lib/explain.js'
import { filterCitable } from './lib/citationGuard.js'
import { registerSuggestionRoutes } from './lib/suggestions.js'
import { registerCaptureRoutes } from './lib/capture.js'
import { registerCaptureDraftRoutes } from './lib/captureDrafts.js'
import { registerSubscriptionRoutes } from './lib/topicSubscriptions.js'
import { registerBriefRoutes } from './lib/brief.js'
import { streamExport } from './lib/exportNotes.js'
import { startDreamScheduler } from './lib/dreamScheduler.js'
import { startAnnBackfillScheduler } from './lib/annBackfillScheduler.js'
import { startRetractionScheduler } from './lib/retractionOutbox.js'
import { orgBudgetMiddleware } from './lib/tenantBudget.js'
import { denseBackendStatus, annSyncPending } from './lib/annIndex.js'
import { startEmbeddingBackfillScheduler } from './lib/embeddingBackfillScheduler.js'

// Version resolution: QUOXCORE_VERSION build arg → canonical /app/VERSION file
// → '0.0.0'. Prevents silently reporting the placeholder when the build arg is
// not passed. NOTE: this service's Docker build context is ./services/quoxbrain
// (see docker-compose.yml), so the repo-root VERSION file is NOT COPY'd into
// the image — /app/VERSION will be absent unless the compose context is
// widened, and this resolver correctly falls back to the env var / '0.0.0'.
const RESOLVED_VERSION = (() => {
  if (process.env.QUOXCORE_VERSION) return process.env.QUOXCORE_VERSION
  try {
    const v = readFileSync('/app/VERSION', 'utf8').trim()
    if (v) return v
  } catch { /* file absent — fall through */ }
  return '0.0.0'
})()

// TRUST-GATE-OPS: refuse to boot with test-only env flags in production
// (same guard as collector/memory — see lib/bootGuard.js)
const { guardTestEnvFlags } = await import('./lib/bootGuard.js')
const _bootGuardResult = guardTestEnvFlags(process.env)
if (_bootGuardResult.shouldAbort) {
  console.error(`[boot] Refusing to start with test-only env flags set: ${_bootGuardResult.presentFlags.join(',')}. Set ALLOW_TEST_FLAGS=true to bypass (test contexts only).`)
  process.exit(1)
} else if (_bootGuardResult.presentFlags.length > 0) {
  console.warn(`[boot] WARNING: test-only env flags active under ALLOW_TEST_FLAGS=true: ${_bootGuardResult.presentFlags.join(',')}`)
}

const app = express()
const PORT = process.env.PORT || 3106
const DB_PATH = process.env.DB_PATH || './data/quoxbrain.db'
const JWT_SECRET = process.env.JWT_SECRET

// Validate JWT_SECRET is set at startup (mirrors services/memory/server.js)
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required')
  console.error('Set JWT_SECRET to a secure random value matching the auth service')
  process.exit(1)
}

// Fail loud in production if INTERNAL_SERVICE_KEY is unset (internal
// collector→brain calls would otherwise silently 401). Warns only outside
// production.
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

// =============================================================================
// HEALTH
// =============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'quox-brain', version: RESOLVED_VERSION, timestamp: new Date().toISOString() })
})

// =============================================================================
// VAULTS (P0.3 — registration, listing, reindex, delete, graph, notes, tags,
// search. All org-scoped via req.org_id, set by the authenticate middleware
// — never trust a client-supplied org_id in the body.)
// =============================================================================

// Trusted internal service-key callers are implicitly admin (see the
// requireAdmin comment further down); a plain JWT caller must carry
// role === 'admin'. Used inline (rather than as route middleware) by
// POST /vaults, where the gate only applies conditionally (scope='shared').
// 2026-10-11: the JWT carries the raw membership role, so an org owner is
// 'owner' (which outranks 'admin'); owners were refused on admin-only routes.
function isAdminCaller(req) {
  return Boolean(req.service) || req.user?.role === 'admin' || req.user?.role === 'owner'
}

// BRAIN2-AUDIT: 'shared' vaults are instance-wide (every org reads them and
// they are injected into every org's prompts), so creating or writing one needs
// INSTANCE authority. req.user.role === 'admin' is the ORG role and must not
// confer it. services/auth issues no instance-admin claim in the JWT
// (instance_admins is a DB table checked by its own middleware), so the only
// instance-level caller this service can verify is the trusted service key.
function isInstanceAuthority(req) {
  return Boolean(req.service)
}

// BRAIN2-W3 A (002): write/reindex/delete on an ORG-scoped vault needs an org
// admin/owner (or the trusted service key). Members keep read. user-scope
// vaults stay owner-only and shared vaults stay instance-authority only, both
// enforced by store.canWriteVault; this only adds the role gate for org vaults.
// (Deliberately NOT inside canWriteVault: NotesQ lets members write org notes.)
function canWriteVaultRoute(req, vault) {
  const isAdmin = isInstanceAuthority(req)
  if (!store.canWriteVault(vault, { orgId: req.org_id, userId: req.user_id, isAdmin })) return false
  if ((vault.scope || 'org') === 'org') {
    return isAdmin || req.user?.role === 'admin' || req.user?.role === 'owner'
  }
  return true
}

const VALID_SCOPES = new Set(['org', 'user', 'shared'])

// BRAIN2-V3 B4: "What leaves this instance" + the effective Brain2 knobs for
// the cockpit's settings panel. Everything is read from live config (the
// collector's embed-provider probe, stored org settings, env), never prose.
app.get('/brain/egress', authenticate, async (req, res) => {
  try {
    const [providerInfo, dream, tokens, thresholds, timeout, rerankCfg, expandCfg] = await Promise.all([
      getEmbeddingProviderCached(),
      resolveDreamLlmAllowed(req.org_id),
      resolveEmbedExclusions(req.org_id),
      resolveRelevanceThresholds(req.org_id),
      resolveQueryEmbedTimeout(req.org_id),
      resolveRerankEnabledDetailed(req.org_id),
      resolveExpandEnabledDetailed(req.org_id),
    ])
    const vaults = store.listVaults(req.org_id, null)
    const lower = new Set(tokens.map((t) => t.toLowerCase()))
    const excludedVaults = vaults
      .filter((v) => tokens.includes(v.id) || lower.has(String(v.name || '').toLowerCase()))
      .map((v) => ({ id: v.id, name: v.name }))
    res.json({
      egress: describeEgress({ providerInfo, dreamAllowed: dream.allowed, excludedVaults, rerank: rerankCfg, expand: expandCfg }),
      excludeTokens: tokens,
      vaults: vaults.map((v) => ({ id: v.id, name: v.name })),
      effective: {
        QUOXDREAM_ALLOW_LLM_TEXT: { value: String(dream.allowed), source: dream.source },
        QUOXBRAIN_QUERY_EMBED_TIMEOUT_MS: { value: String(timeout.value), source: timeout.source },
        BRAIN_RERANK_ENABLED: { value: String(rerankCfg.enabled), source: rerankCfg.source },
        BRAIN_EXPAND_ENABLED: { value: String(expandCfg.enabled), source: expandCfg.source },
        ...Object.fromEntries(['QUOXBRAIN_MIN_COVERAGE', 'QUOXBRAIN_MIN_DENSE_COSINE', 'QUOXBRAIN_MIN_DENSE_FLOOR', 'QUOXBRAIN_MIN_DENSE_COSINE_LARGE', 'QUOXBRAIN_MIN_DENSE_FLOOR_LARGE'].map((k) => [k, {
          value: String({ QUOXBRAIN_MIN_COVERAGE: thresholds.minCoverage, QUOXBRAIN_MIN_DENSE_COSINE: thresholds.minDenseCosine, QUOXBRAIN_MIN_DENSE_FLOOR: thresholds.minDenseFloor, QUOXBRAIN_MIN_DENSE_COSINE_LARGE: thresholds.minDenseCosineLarge, QUOXBRAIN_MIN_DENSE_FLOOR_LARGE: thresholds.minDenseFloorLarge }[k]),
          source: thresholds.sources[k],
        }])),
      },
    })
  } catch (error) {
    console.error('[Brain] Get egress error:', error)
    res.status(500).json({ error: error.message })
  }
})

// BRAIN2-V2 V2-10 "settings truth": what the RUNNING brain actually uses for
// every allowlisted QUOXBRAIN_* knob, with its source and whether a change needs
// a restart. Read-only; org admin or the trusted service key. The UI diffs this
// against the stored settings to flag drift. Allowlist lives in
// lib/effectiveConfig.js, so no secret-shaped env can ever appear here.
app.get('/brain/config/effective', authenticate, async (req, res) => {
  try {
    if (!isAdminCaller(req)) return res.status(403).json({ error: 'Org admin required' })
    res.json({ knobs: await describeEffectiveConfig(req.org_id) })
  } catch (error) {
    console.error('[Brain] Get effective config error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Usage ledger (BRAIN2-PRODUCT P3a) — the calling channel for a usage_events
// row. A trusted service-key caller may declare itself via X-Quox-Source
// (defaulting to 'service' when absent); a plain JWT caller is always 'ui'
// — never client-declarable, same trust boundary as req.org_id/req.user_id.
function usageSource(req) {
  if (req.service) return req.headers['x-quox-source'] || 'service'
  return 'ui'
}

// Register a vault (and index it synchronously — see lib/ingest.js).
//
// SCOPE TIERS (P2.5a, roadmap QUOXBRAIN #163): `scope` defaults to 'org'
// (today's behaviour, unchanged). 'user' makes the vault follow req.user_id
// into every org they act in (owner_user_id is set from the AUTHENTICATED
// caller — never client-supplied). 'shared' is instance-wide and gated
// behind admin (mirrors the existing requireAdmin gate on
// POST /admin/vault-roots). Filesystem-backed (non-'push') vaults are
// deliberately kept 'org'-scope only in P2.5a — resolveSafeVaultPath's
// per-org root allowlist has no concept of a cross-org or instance-wide
// filesystem root, so a 'user'/'shared' vault MUST be source_type='push'
// (content arrives via POST /vaults/:id/documents instead of a fs walk).
app.post('/vaults', authenticate, async (req, res) => {
  try {
    const { name, source_type = 'local', source_path, scope = 'org' } = req.body || {}
    if (!name) {
      return res.status(400).json({ error: 'name is required' })
    }
    if (!VALID_SCOPES.has(scope)) {
      return res.status(400).json({ error: `scope must be one of: ${[...VALID_SCOPES].join(', ')}` })
    }
    if (scope === 'shared' && !isInstanceAuthority(req)) {
      return res.status(403).json({ error: 'Instance-level authority (service key) required to create a shared-scope vault; org admin is not sufficient' })
    }
    if (scope !== 'org' && source_type !== 'push') {
      return res.status(400).json({ error: `scope='${scope}' vaults must be source_type='push' (filesystem-backed user/shared vaults are out of scope for P2.5a)` })
    }
    if (typeof source_path === 'string' && source_path.startsWith('notesq:')) {
      return res.status(403).json({ error: 'use_notesq_routes' })
    }
    // BRAIN2-W3 A (002): registering an ORG-scope vault needs org admin/owner or the
    // service key, same as writing one. Members keep user-scope vaults. NotesQ
    // creates its vaults via store.createVault directly, not this route.
    if (scope === 'org' && !(isInstanceAuthority(req) || req.user?.role === 'admin' || req.user?.role === 'owner')) {
      return res.status(403).json({ error: 'Org admin or owner required to create an org-scope vault' })
    }
    const owner_user_id = scope === 'user' ? req.user_id : null

    // Push vaults (P2b-1) are logical containers, not filesystem-backed —
    // content arrives exclusively via POST /vaults/:id/documents below
    // (chat DB, git commits, auth.db, etc). There is no real path to
    // validate, so resolveSafeVaultPath/org_vault_roots are skipped
    // entirely for this source_type; source_path is just an optional
    // logical label (e.g. "push:docs"), defaulted from the vault name when
    // omitted so the UNIQUE(org_id, source_path) constraint still holds.
    // A user-scope default is owner-qualified so one org vault and each
    // user's private vault of the same name can coexist (031, 2026-10-06).
    if (source_type === 'push') {
      const vault = store.createVault({ org_id: req.org_id, name, source_type, source_path: source_path || (scope === 'user' ? `push:${name}:user:${owner_user_id}` : `push:${name}`), scope, owner_user_id })
      // BRAIN2-W3 A (003): UNIQUE(org_id, source_path) hands back the EXISTING row
      // on conflict; never return another owner's / another scope's vault.
      if (vault.scope !== scope || (vault.owner_user_id || null) !== (owner_user_id || null)) {
        return res.status(409).json({ error: 'vault_exists', message: 'A vault with this source_path already exists with a different scope or owner' })
      }
      const indexed = await indexVault(vault) // no-op for push vaults — see lib/ingest.js
      return res.status(201).json(indexed)
    }

    if (!source_path) {
      return res.status(400).json({ error: 'name and source_path are required' })
    }

    // Validate the path is under QUOXBRAIN_VAULT_ROOT BEFORE persisting
    // anything — see lib/vaultRoot.js (traversal/symlink-escape guard).
    try {
      resolveSafeVaultPath(source_path, req.org_id)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    const vault = store.createVault({ org_id: req.org_id, name, source_type, source_path, scope, owner_user_id })
    if (vault.scope !== scope || (vault.owner_user_id || null) !== (owner_user_id || null)) {
      return res.status(409).json({ error: 'vault_exists', message: 'A vault with this source_path already exists with a different scope or owner' })
    }
    const indexed = await indexVault(vault)
    res.status(201).json(indexed)
  } catch (error) {
    console.error('[Brain] Create vault error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/vaults', authenticate, (req, res) => {
  try {
    res.json(store.listVaults(req.org_id, req.user_id))
  } catch (error) {
    console.error('[Brain] List vaults error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/vaults/:id', authenticate, (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    res.json(vault)
  } catch (error) {
    console.error('[Brain] Get vault error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.post('/vaults/:id/reindex', authenticate, async (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    if (vault.app === 'notesq') return res.status(403).json({ error: 'use_notesq_routes' })
    if (!canWriteVaultRoute(req, vault)) {
      return res.status(403).json({ error: 'Not authorized to write this vault' })
    }
    const indexed = await indexVault(vault)
    res.json(indexed)
  } catch (error) {
    console.error('[Brain] Reindex vault error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Bulk document push-ingest (P2b-1) — the non-filesystem ingestion path the
// P2b readers (chat DB, git commits, auth.db, etc) call to get content into
// the brain. Works for any vault (push OR local), scope-checked via
// store.getVault (read visibility) + store.canWriteVault (write authority —
// P2.5a: a 'user'-scope vault is writable only by its owner, a 'shared'
// vault only by an admin, regardless of which org is currently pushing).
// See lib/ingest.js ingestDocuments() for the idempotent content-hash-skip /
// upsert / re-chunk logic.
const MAX_DOCUMENTS_PER_CALL = 500

app.post('/vaults/:id/documents', authenticate, async (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    if (vault.app === 'notesq') return res.status(403).json({ error: 'use_notesq_routes' })
    if (!canWriteVaultRoute(req, vault)) {
      return res.status(403).json({ error: 'Not authorized to write this vault' })
    }

    const { documents, deleteAbsent = false, deletions } = req.body || {}
    if (deletions !== undefined && (!Array.isArray(deletions) || deletions.length > MAX_DOCUMENTS_PER_CALL || deletions.some((d) => typeof d !== 'string'))) {
      return res.status(400).json({ error: `deletions must be an array of at most ${MAX_DOCUMENTS_PER_CALL} rel_path strings` })
    }
    const hasDeletions = Array.isArray(deletions) && deletions.length > 0
    if (!Array.isArray(documents) || (documents.length === 0 && !hasDeletions)) {
      return res.status(400).json({ error: 'documents (non-empty array) is required' })
    }
    if (documents.length > MAX_DOCUMENTS_PER_CALL) {
      return res.status(400).json({ error: `documents exceeds the ${MAX_DOCUMENTS_PER_CALL}-per-call limit` })
    }

    const result = await ingestDocuments(vault, documents, { deleteAbsent: Boolean(deleteAbsent), deletions: hasDeletions ? deletions : null })
    res.json(result)
  } catch (error) {
    console.error('[Brain] Document ingest error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.delete('/vaults/:id', authenticate, (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    if (vault.app === 'notesq') return res.status(403).json({ error: 'use_notesq_routes' })
    if (!canWriteVaultRoute(req, vault)) {
      return res.status(403).json({ error: 'Not authorized to write this vault' })
    }
    // Delete keyed to the vault's OWN org_id (not req.org_id) — a 'user'/
    // 'shared' vault's stored org_id is its creation org, which may differ
    // from the org the (already-authorized) caller is currently acting in.
    const result = store.deleteVault(vault.org_id, req.params.id)
    res.json(result)
  } catch (error) {
    console.error('[Brain] Delete vault error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// NOTESQ (P0 substrate) — markdown notes in app='notesq' push vaults with
// revisions + optimistic concurrency. SERVICE-KEY ONLY: the collector is the
// single governed entry point; a JWT caller is refused. Admin comes ONLY from
// X-User-Is-Admin on the service-key path (isAdminCaller treats every service
// caller as admin, which is wrong here).
// =============================================================================

function notesqGate(req, res, next) {
  if (!req.service) return res.status(403).json({ error: 'notesq_requires_governed_path' })
  req.notesqAdmin = String(req.headers['x-user-is-admin'] || '').toLowerCase() === 'true'
  next()
}

function notesqHandler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (err) {
      if (err instanceof notesq.NotesqError) {
        return res.status(err.status).json({ error: err.code, ...err.extra })
      }
      console.error('[Brain] NotesQ error:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  }
}

const nid = (req) => ({ orgId: req.org_id, userId: req.user_id })

app.post('/notesq/vault', authenticate, notesqGate, notesqHandler((req, res) => {
  const vault = notesq.ensureNotesVault({ ...nid(req), scope: req.body?.scope })
  res.json({ vault: notesq.publicVault(vault) })
}))

app.get('/notesq/notes', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json(notesq.listNotes({ ...nid(req), scope: req.query.scope || 'all', limit: req.query.limit, offset: req.query.offset,
    q: req.query.q, collection: req.query.collection, tag: req.query.tag, pinned: req.query.pinned, archived: req.query.archived || 'exclude' }))
}))

app.get('/notesq/facets', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json(notesq.getFacets({ ...nid(req), scope: req.query.scope || 'all' }))
}))

app.get('/notesq/titles', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json(notesq.searchTitles({ ...nid(req), scope: req.query.scope || 'all', q: req.query.q }))
}))

app.get('/notesq/notes/:id', authenticate, notesqGate, notesqHandler((req, res) => {
  const note = notesq.getNote({ ...nid(req), id: req.params.id })
  if (!note) return res.status(404).json({ error: 'not_found' })
  res.json({ note })
}))

app.get('/notesq/notes/:id/related', authenticate, notesqGate, notesqHandler(async (req, res) => {
  const out = await notesq.relatedNotes({ ...nid(req), id: req.params.id, limit: req.query.limit })
  if (!out) return res.status(404).json({ error: 'not_found' })
  res.json(out)
}))

app.get('/notesq/notes/:id/suggestions', authenticate, notesqGate, notesqHandler(async (req, res) => {
  const out = await notesqInsights.suggestLinks({ ...nid(req), id: req.params.id, limit: req.query.limit })
  if (!out) return res.status(404).json({ error: 'not_found' })
  res.json(out)
}))

app.get('/notesq/health', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json(notesqInsights.notebookHealth({ ...nid(req), scope: req.query.scope || 'org', staleDays: req.query.stale_days }))
}))

// ONE-BRAIN CX6 gardener (scheduler-only): whom to run notebookHealth for in one org.
app.get('/internal/garden/users', authenticate, (req, res) => {
  if (!req.service) return res.status(403).json({ error: 'service key required' })
  if (!req.org_id) return res.status(400).json({ error: 'org context required' })
  res.json({ users: notesqInsights.gardenUsers(req.org_id) })
})

app.post('/notesq/notes', authenticate, notesqGate, notesqHandler(async (req, res) => {
  const { scope, content, markdown, properties, author_kind } = req.body || {}
  const out = await notesq.createNote({ ...nid(req), scope, content, markdown, properties, authorKind: author_kind })
  res.status(201).json(out)
}))

app.put('/notesq/notes/:id', authenticate, notesqGate, notesqHandler(async (req, res) => {
  const { content, markdown, properties, base_hash, author_kind } = req.body || {}
  const out = await notesq.updateNote({ ...nid(req), isAdmin: req.notesqAdmin, id: req.params.id, content, markdown, properties, baseHash: base_hash, authorKind: author_kind })
  res.status(200).json(out)
}))

// Optimistic-concurrency token for destructive writes: body.expected_hash,
// ?expected_hash=, or If-Match. Checked by the service inside the mutation's
// own lock/transaction (409 {error:'conflict', currentHash}, nothing changed).
const expectedHashOf = (req) => {
  const v = req.body?.expected_hash ?? req.query?.expected_hash ?? String(req.headers['if-match'] || '').replace(/^W\//, '').replace(/^"|"$/g, '')
  return typeof v === 'string' && v ? v : undefined
}

app.delete('/notesq/notes/:id', authenticate, notesqGate, notesqHandler(async (req, res) => {
  const out = await notesq.deleteNote({ ...nid(req), isAdmin: req.notesqAdmin, id: req.params.id, authorKind: req.headers['x-author-kind'], purge: req.query.purge === 'true', expectedHash: expectedHashOf(req) })
  res.json(out)
}))

app.get('/notesq/notes/:id/revisions', authenticate, notesqGate, notesqHandler((req, res) => {
  const revisions = notesq.listRevisions({ ...nid(req), id: req.params.id })
  if (!revisions) return res.status(404).json({ error: 'not_found' })
  res.json({ revisions })
}))

app.get('/notesq/notes/:id/revisions/:rev', authenticate, notesqGate, notesqHandler((req, res) => {
  const revision = notesq.getRevision({ ...nid(req), id: req.params.id, rev: req.params.rev })
  if (!revision) return res.status(404).json({ error: 'not_found' })
  res.json(revision)
}))

app.post('/notesq/notes/:id/restore', authenticate, notesqGate, notesqHandler(async (req, res) => {
  const out = await notesq.restoreRevision({ ...nid(req), isAdmin: req.notesqAdmin, id: req.params.id, rev: req.body?.rev, authorKind: req.body?.author_kind, expectedHash: expectedHashOf(req) })
  res.json(out)
}))

// NotesQ schedules (AQ-9D P4). User routes are scoped by org+user; the
// schedules-due / claim / result routes are service-side (cross-org) and
// drive the scheduler.
function schedUser(req) {
  // authenticate defaults a header-less service call to user_id 'service'; treat as missing.
  if (!req.user_id || req.user_id === 'service') throw new notesq.NotesqError(400, 'user_required')
  return nid(req)
}

app.get('/notesq/schedules', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json({ schedules: notesqSchedules.listSchedules(schedUser(req)) })
}))

app.post('/notesq/schedules', authenticate, notesqGate, notesqHandler((req, res) => {
  const schedule = notesqSchedules.createSchedule({ ...schedUser(req), ...(req.body || {}) })
  res.status(201).json({ schedule })
}))

app.patch('/notesq/schedules/:id', authenticate, notesqGate, notesqHandler((req, res) => {
  const schedule = notesqSchedules.setEnabled({ ...schedUser(req), id: req.params.id, enabled: req.body?.enabled })
  res.json({ schedule })
}))

app.delete('/notesq/schedules/:id', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json(notesqSchedules.deleteSchedule({ ...schedUser(req), id: req.params.id }))
}))

app.get('/notesq/schedules-due', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json({ schedules: notesqSchedules.listDue(req.query.now, req.query.limit) })
}))

app.post('/notesq/schedules/:id/claim', authenticate, notesqGate, notesqHandler((req, res) => {
  res.json(notesqSchedules.claim(req.params.id, req.body?.period))
}))

app.post('/notesq/schedules/:id/result', authenticate, notesqGate, notesqHandler((req, res) => {
  const b = req.body || {}
  const out = notesqSchedules.recordResult(req.params.id, { period: b.period, outcome: b.outcome, error: b.error, previous_period: b.previous_period })
  const { org_id, ...schedule } = out
  res.json({ schedule })
}))

// Hard node/edge cap + pagination (P1b, contract §2 "Unchanged from P0"
// note) — interim protection until P4's proper k-hop traversal; the full
// graph is still assembled in memory (store.getGraph is unchanged) and
// simply sliced here rather than over-engineering pushdown pagination for
// what P4 replaces anyway.
const GRAPH_NODE_CAP_DEFAULT = 500
const GRAPH_EDGE_CAP = 1000

app.get('/vaults/:id/graph', authenticate, (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })

    const graph = store.getGraph(req.org_id, req.user_id, req.params.id)
    const limit = Math.min(Math.max(Number(req.query.limit) || GRAPH_NODE_CAP_DEFAULT, 1), GRAPH_NODE_CAP_DEFAULT)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const total = graph.nodes.length
    const nodes = graph.nodes.slice(offset, offset + limit)
    const edges = graph.edges.slice(0, GRAPH_EDGE_CAP)
    const truncated = (offset + nodes.length < total) || (graph.edges.length > edges.length)

    res.json({ nodes, edges, truncated, total })
  } catch (error) {
    console.error('[Brain] Get graph error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/vaults/:id/notes', authenticate, (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    const { limit = 50, offset = 0, q } = req.query
    // 007: clamp both; a negative LIMIT is unbounded in SQLite.
    const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200)
    const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0)
    res.json(store.listNotes(req.org_id, req.user_id, req.params.id, { limit: safeLimit, offset: safeOffset, q }))
  } catch (error) {
    console.error('[Brain] List notes error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/vaults/:id/tags', authenticate, (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    res.json(store.getTags(req.org_id, req.user_id, req.params.id))
  } catch (error) {
    console.error('[Brain] Get tags error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/vaults/:id/search', authenticate, (req, res) => {
  try {
    const vault = store.getVault(req.org_id, req.user_id, req.params.id)
    if (!vault) return res.status(404).json({ error: 'Vault not found' })
    const q = req.query.q
    if (!q) return res.status(400).json({ error: 'q query param is required' })
    res.json(store.searchNotes(req.org_id, req.user_id, req.params.id, q))
  } catch (error) {
    console.error('[Brain] Search notes error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// NOTES
// =============================================================================

// Never return an unbounded body (audit P2-10) — default cap on the
// no-range path, flagged with `truncated` when the real body is longer.
const NOTE_PREVIEW_CHARS = 8 * 1024
const RANGE_RE = /^(\d+):(\d+)$/
const NOTE_RANGE_MAX_CHARS = 256 * 1024

app.get('/notes/:id', authenticate, (req, res) => {
  try {
    const note = store.getNote(req.org_id, req.user_id, req.params.id)
    if (!note) return res.status(404).json({ error: 'Note not found' })
    store.recordUsageEvent({ org_id: req.org_id, user_id: req.user_id || null, surface: 'note_read', source: usageSource(req) })

    // Column whitelist (contract §2, audit P2-10; extended P1b for the
    // frontend NoteReader contract) — org_id/content_hash/mtime never leave
    // the brain via this route. relPath (legacy) is kept alongside rel_path;
    // vault_id/scope are now included since the frontend reads them directly.
    const base = {
      id: note.id,
      kind: note.kind,
      source_type: note.source_type,
      title: note.title,
      frontmatter: note.frontmatter,
      relPath: note.rel_path,
      rel_path: note.rel_path,
      vault_id: note.vault_id,
      scope: note.scope,
      tags: note.tags,
      backlinks: note.backlinks,
      outlinks: note.outlinks,
      occurredAt: note.occurred_at,
      updatedAt: note.updated_at,
      // W10 B: revision token (whole-note content hash) so an agent edit can
      // prove which version it read. A hash, not content; org_id/mtime stay private.
      revision: note.content_hash
    }

    const range = req.query.range
    if (range !== undefined) {
      const match = RANGE_RE.exec(String(range))
      if (!match) return res.status(400).json({ error: 'range must be charStart:charEnd (non-negative integers)' })
      const rawStart = parseInt(match[1], 10)
      const rawEnd = parseInt(match[2], 10)
      if (rawStart > rawEnd) return res.status(400).json({ error: 'range charStart must be <= charEnd' })
      const bodyLen = note.body?.length || 0
      const charStart = Math.min(rawStart, bodyLen)
      const charEnd = Math.min(rawEnd, bodyLen, charStart + NOTE_RANGE_MAX_CHARS)
      return res.json({ ...base, body: note.body.slice(charStart, charEnd), body_length: bodyLen })
    }

    const body = note.body || ''
    const truncated = body.length > NOTE_PREVIEW_CHARS
    res.json({ ...base, body: body.slice(0, NOTE_PREVIEW_CHARS), truncated, body_length: body.length })
  } catch (error) {
    console.error('[Brain] Get note error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// BRAIN (P1b — the three frozen retrieval endpoints,
// docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §2). Thin wrapper over vaultStore's
// P1a chunk-native search (searchChunks) + the budgeted assembler
// (lib/contextAssembler.js). org_id/user_id always from req.org_id/
// req.user_id (authenticate middleware) — never body/param for JWT users;
// service-key callers scope via X-Org-Id/X-User-Id exactly like the /vaults
// routes above. Retrieval is the scope UNION (P2.5a) of org_id's own
// 'org'-scope content, user_id's 'user'-scope content (from any org), and
// every 'shared'-scope vault — see vaultStore.scopeClause().
// =============================================================================

// sources/scopes/languages (P2.5b-1, roadmap QUOXBRAIN #163) — the same
// brain-level facet filters GET /brain/graph and /brain/sources expose,
// threaded through to retrieval so the UI's facet selection narrows
// /brain/search and /brain/context too, not just the graph. All optional;
// response shapes below are unchanged (request-only additions).
// Per-caller query-embed bound: header X-Query-Embed-Timeout-Ms or body
// embedTimeoutMs (clamped in contextAssembler). Unset keeps the 1.5s default
// that the collector implant relies on; agent/CLI callers may ask for up to 4s.
function embedTimeoutOf(req) {
  return req.get('x-query-embed-timeout-ms') || req.body?.embedTimeoutMs
}

// CORTEX-BENCH (latency tail): a trusted service caller may cap the LLM
// rerank wait (clamped 1-6s). A rerank still pending after that is stuck in
// collector congestion; the fused order is kept, as on any rerank failure.
function rerankBudget(req) {
  const ms = Number(req.body?.rerankTimeoutMs)
  return isInstanceAuthority(req) && Number.isFinite(ms) && ms > 0 ? { rerankTimeoutMs: Math.min(Math.max(ms, 1000), 6000) } : {}
}

// ONE-BRAIN CX2: validate optional since/until. Date-only `until` means the
// whole of that day. Returns { filters } (empty when neither given, so the
// no-filter request is byte-identical) or { error }.
function parseDateWindow(since, until) {
  const filters = {}
  for (const [key, raw] of [['since', since], ['until', until]]) {
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(raw.trim())) {
      return { error: `${key} must be an ISO date or datetime string (e.g. 2026-10-05 or 2026-10-05T09:00:00Z)` }
    }
    const t = raw.trim()
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(t)
    const ms = Date.parse(dateOnly ? `${t}T00:00:00.000Z` : t)
    if (!Number.isFinite(ms)) return { error: `${key} is not a valid date: ${raw}` }
    filters[key] = new Date(dateOnly && key === 'until' ? ms + 86400000 - 1 : ms).toISOString()
  }
  if (filters.since && filters.until && filters.since > filters.until) return { error: 'since must not be after until' }
  return { filters }
}

app.post('/brain/search', authenticate, orgBudgetMiddleware, async (req, res) => {
  try {
    const { query, limit = 10, offset = 0, vaultIds, kinds, sources, scopes, languages, includeText } = req.body || {}
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' })
    }
    // ONE-BRAIN CX2: optional date window rides the facet filters below.
    const dateWindow = parseDateWindow(req.body?.since, req.body?.until)
    if (dateWindow.error) return res.status(400).json({ error: dateWindow.error })

    const clampedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50)
    const safeOffset = Math.max(Number(offset) || 0, 0)
    // ONE-BRAIN CX6: opt-in explanation of the ranking; absent -> response unchanged.
    const explainOn = req.body?.explain === true
    const explainSink = explainOn ? {} : null
    const explainNoteId = explainOn && typeof req.body?.noteId === 'string' && req.body.noteId ? req.body.noteId : null
    let guaranteed = null

    const start = Date.now()
    // CORTEX-BENCH: per-stage timings ride on the response (stageMs) so slow
    // searches can be localised from the caller.
    const stageMs = {}
    const mark = (k) => { stageMs[k] = Date.now() - start }

    // BRAIN2-SEMANTIC (2026-08-25): search was FTS-only while hybrid fusion
    // lived solely in /brain/context — `quox brain search` never touched the
    // dense leg no matter what the flags said. Hybrid engages here for plain
    // queries AND facet-filtered ones (BRAIN2-W2 2): the sparse leg applies the
    // facets in SQL and tryHybridFusion filters dense candidates by the same
    // facets (as /brain/context does), so fused rows never violate them. `retrieval` in the response says which path actually
    // served, so a fallback is visible, never silent.
    const facetFilters = { vaultIds, kinds, sources, scopes, languages, ...dateWindow.filters }
    // VAULT-INTEG P17: resolved per-org via configResolver.getSetting()
    // (contextAssembler.isHybridEnabled) rather than a bare env read — see
    // that function's own comment for the fail-safe/env-fallback contract.
    // BRAIN2-W6: per-request arm override for the eval. Instance-authority
    // (service key) callers only; for JWT callers, or any value outside the
    // three arms, it is ignored. It only chooses which legs run: the same
    // scope/org/facet/exclusion filters apply on every arm.
    const armRaw = req.body?.retrieval
    const arm = isInstanceAuthority(req) && ['fts', 'dense', 'hybrid'].includes(armRaw) ? armRaw : null
    const hybridWanted = arm ? arm === 'hybrid' : await isHybridEnabled(req.org_id)
    // CORTEX-BENCH: start the query embed now so its network round trip
    // overlaps the settings reads and the synchronous sparse search.
    if (hybridWanted || arm === 'dense') prefetchQueryEmbedding(req.org_id, query)
    // Eval-only fusion weight sweep, same instance-authority gate as the arm.
    const denseWeight = isInstanceAuthority(req) && Number.isFinite(req.body?.denseWeight) ? req.body.denseWeight : undefined
    const kindPriors = isInstanceAuthority(req) && req.body?.kindPriors && typeof req.body.kindPriors === 'object' ? req.body.kindPriors : undefined
    // BRAIN2-V2 V2-7: recency weighting, service-key eval override until measured ({weight, halfLifeDays}).
    const recency = isInstanceAuthority(req) && req.body?.recency && typeof req.body.recency === 'object' ? req.body.recency : undefined
    const orgCfg = await resolveOrgRetrievalConfig(req.org_id, { user_id: req.user_id })
    mark('config')
    let retrieval = 'fts'
    const degradedSink = {}
    // BRAIN2-W13 C: opt-in query expansion (own BRAIN_EXPAND_ENABLED switch, default off; eval override body.expand, service key only).
    const expandOverride = isInstanceAuthority(req) && typeof req.body?.expand === 'boolean' ? req.body.expand : undefined
    const expandStarter = (arm === 'fts' || (!arm && !hybridWanted)) ? null : await resolveExpansion({ orgId: req.org_id, query, override: expandOverride })
    const expandSink = {}
    let rawResults
    let ranked = []
    let chunkPool = []
    let denseTop = null
    let embedSpace = null
    let denseCoverage = null

    if (arm === 'dense') {
      // Dense leg only (empty sparse pool). No embeddings or no query vector:
      // insufficient, labelled dense. Never a silent FTS fallback.
      const poolSize = Math.min(Math.max((clampedLimit + safeOffset) * 3, 30), 200)
      const fused = await tryHybridFusion(req.org_id, req.user_id, query, [], poolSize, { degradedSink, queryEmbedTimeoutMs: embedTimeoutOf(req), orgQueryEmbedTimeoutMs: orgCfg.orgQueryEmbedTimeoutMs, excludedVaultIdSet: orgCfg.excludedVaultIdSet, filters: facetFilters, denseWeight, kindPriors, recency, ...(explainSink ? { explainSink } : {}), ...(expandStarter ? { expand: expandStarter, expandSink } : {}) })
      if (!fused) {
        return res.json({ results: [], retrieval: 'dense', ...(degradedSink.degraded ? { degraded: degradedSink.degraded } : {}), relevance: { coverage: 0, dense: null, bm25: null, insufficient: true }, insufficient: true, reason: 'dense retrieval unavailable: no embeddings or query vector for this org', tookMs: Date.now() - start })
      }
      retrieval = 'dense'
      denseTop = fused.denseTop ?? null
      embedSpace = fused.embedSpace ?? null
      denseCoverage = fused.denseCoverage ?? null
      chunkPool = fused
      ranked = dedupeByNote(fused)
      rawResults = ranked.slice(safeOffset, safeOffset + clampedLimit)
    } else if (hybridWanted) {
      // Wider sparse pool than one page so fusion has something to re-rank,
      // then paginate the fused ranking.
      const poolSize = Math.min(Math.max((clampedLimit + safeOffset) * 3, 30), 200)
      const sparsePool = searchChunksWithQuota(store.searchChunks, req.org_id, req.user_id, { query, ...facetFilters }, poolSize)
      mark('sparse')
      const fused = await tryHybridFusion(req.org_id, req.user_id, query, sparsePool, poolSize, { degradedSink, queryEmbedTimeoutMs: embedTimeoutOf(req), orgQueryEmbedTimeoutMs: orgCfg.orgQueryEmbedTimeoutMs, excludedVaultIdSet: orgCfg.excludedVaultIdSet, filters: facetFilters, denseWeight, kindPriors, recency, ...(explainSink ? { explainSink } : {}), ...(expandStarter ? { expand: expandStarter, expandSink } : {}) })
      if (fused) {
        retrieval = 'hybrid'
        denseTop = fused.denseTop ?? null
        embedSpace = fused.embedSpace ?? null
        denseCoverage = fused.denseCoverage ?? null
        chunkPool = fused
        const legWindow = expandSink.status === 'llm' ? RERANK_TOP_N_EXPANDED : RERANK_TOP_N
        const preLegs = dedupeByNote(fused)
        ranked = ensureLegHeads(preLegs, fused.legHeads, {
          window: legWindow, perLeg: LEG_HEAD_N,
          chunkNote: new Map(fused.map((r) => [r.chunkId, r.noteId])),
        })
        if (explainOn) guaranteed = guaranteedNoteIds(preLegs, ranked, legWindow)
      rawResults = ranked.slice(safeOffset, safeOffset + clampedLimit)
      } else {
        chunkPool = sparsePool
        ranked = dedupeByNote(sparsePool)
        rawResults = ranked.slice(safeOffset, safeOffset + clampedLimit)
      }
    } else {
      // One hit per note (BRAIN2-AUDIT): overfetch chunks, collapse to the best
      // chunk per note, then paginate the collapsed ranking.
      const facetPool = Math.min(Math.max((clampedLimit + safeOffset) * 3, 30), 200)
      chunkPool = searchChunksWithQuota(store.searchChunks, req.org_id, req.user_id, { query, vaultIds, kinds, sources, scopes, languages, ...dateWindow.filters }, facetPool)
      ranked = dedupeByNote(chunkPool)
      rawResults = ranked.slice(safeOffset, safeOffset + clampedLimit)
    }

    mark('fused')
    let results = filterCitable(rawResults, { context: 'brain/search' })
    // Absolute relevance (BRAIN2-AUDIT): hits are still returned, but flagged.
    const topTexts = store.getChunkDetails(req.org_id, req.user_id, results.slice(0, 5).map((r) => r.chunkId))
    const relevance = computeRelevance(query, topTexts, { denseTop, embedModel: embedSpace, bm25Top: results[0]?.score ?? null, thresholds: orgCfg.thresholds })
    // BRAIN2-W11 B: opt-in LLM rerank of the fused top-N. Never when abstaining.
    // Eval override (service key only): body.rerank true|false.
    mark('relevance')
    let rerank
    const rerankOverride = isInstanceAuthority(req) && typeof req.body?.rerank === 'boolean' ? req.body.rerank : undefined
    const citableRanked = filterCitable(ranked, { context: 'brain/search rerank' })
    const rr = await maybeRerank({
      orgId: req.org_id, query, ranked: citableRanked, insufficient: relevance.insufficient, override: rerankOverride,
      topN: expandSink.status === 'llm' ? RERANK_TOP_N_EXPANDED : undefined,
      // 2026-10-11: dated passages for the reranker, service-key eval override until measured.
      // Default 'auto' (2026-10-11, measured on dev7 and the dev9 temporal set: no
      // loss, small gains): dates only passages whose titles share a subject.
      // Service-key evals can force true/false.
      dated: isInstanceAuthority(req) && typeof req.body?.rerankDated === 'boolean' ? req.body.rerankDated : 'auto',
      idOf: (r) => r.chunkId,
      textOf: (r) => r.snippet || r.title || '',
      loadTexts: (head) => new Map(store.getChunkDetails(req.org_id, req.user_id, head.map((r) => r.chunkId)).map((d) => [String(d.chunkId), d.text])),
    }, rerankBudget(req))
    mark('rerank')
    if (rr.rerank) rerank = rr.rerank
    if (rr.rerank === 'llm') results = rr.ranked.slice(safeOffset, safeOffset + clampedLimit)
    // BRAIN2-W12 C: the reranker said nothing answers the query -> abstain.
    let relevanceOut = relevance
    if (rr.rerankVerdict === 'none' && !relevance.insufficient) {
      relevanceOut = rerankVetoHolds(relevance, { thresholds: orgCfg.thresholds, embedModel: embedSpace })
        ? { ...relevance, insufficient: true, rerankVerdict: 'none' }
        : { ...relevance, rerankVerdict: 'none', rerankVetoOverruled: true }
    }
    // 2026-10-10: a question naming a specific thing (product, vendor,
    // codename) that none of the top results' salient text mentions is not
    // answered by them (lib/entityGrounding.js). Hits stay, flagged. Salient =
    // title, path, matched passage and the note's first 1200 chars.
    // Opt-in grounding mode: instance-authority callers only (measurement).
    const groundingModeReq = isInstanceAuthority(req) ? normalizeGroundingMode(req.body?.groundingMode) : DEFAULT_GROUNDING_MODE
    const modeEnts = groundingModeReq !== 'legacy' ? modeEntities(query, groundingModeReq, (t, v, l) => store.sampleTermChunks(req.org_id, req.user_id, v, l), `${req.org_id}\u0000${req.user_id || ''}`) : null
    let groundingOut = { entities: [], missing: [], ungrounded: false, evaluated: false }
    if (!relevanceOut.insufficient && results.length) {
      const top = results.slice(0, 3)
      const passages = new Map(store.getChunkDetails(req.org_id, req.user_id, top.map((r) => r.chunkId).filter(Boolean)).map((d) => [d.chunkId, d.text]))
      const g = groundingForTop(query, top, {
        ...(modeEnts ? { entities: modeEnts } : {}),
        passageOf: (r) => passages.get(r.chunkId) || r.snippet || '',
        headOf: (r) => { const n = r.noteId ? store.getNote(req.org_id, req.user_id, r.noteId) : null; return typeof n?.body === 'string' ? n.body.slice(0, 1200) : '' },
      })
      groundingOut = { entities: g.entities, missing: g.missing, ungrounded: g.ungrounded, evaluated: true }
      if (g.ungrounded) relevanceOut = { ...relevanceOut, insufficient: true, ungrounded: g.missing }
    }
    if (modeEnts) relevanceOut = { ...relevanceOut, groundingMode: groundingModeReq, entities: modeEnts }
    // BRAIN2-W4 A: opt-in chunk text (capped) so a citation support check sees
    // the passage the agent saw, not the truncated FTS highlight. Off by default
    // so the dashboard payload is unchanged.
    if (includeText === true && results.length) {
      const byChunk = new Map(store.getChunkDetails(req.org_id, req.user_id, results.map((r) => r.chunkId).filter(Boolean)).map((d) => [d.chunkId, d.text]))
      for (const r of results) {
        const t = byChunk.get(r.chunkId)
        if (typeof t === 'string' && t) r.text = t.slice(0, 2000)
      }
    }
    // CORTEX-BENCH: callers that want whole short notes (recall) get them in
    // this response instead of a second round of GET /notes calls, which
    // queued behind other brain work and cost 2-3s. Same visibility rule as
    // GET /notes/:id (store.getNote is scope-checked).
    const fullMax = Number(req.body?.fullNoteMaxChars)
    if (Number.isFinite(fullMax) && fullMax > 0 && results.length) {
      const topN = Math.min(Math.max(Number(req.body?.fullNoteTopN) || 3, 1), 5)
      const seen = new Set()
      for (const r of results.slice(0, topN)) {
        if (!r.noteId || seen.has(r.noteId)) continue
        seen.add(r.noteId)
        try {
          const note = store.getNote(req.org_id, req.user_id, r.noteId)
          const cap = Math.min(fullMax, 8000)
          if (!note || typeof note.body !== 'string') continue
          if (note.body.length <= cap) { r.noteBody = note.body; continue }
          // ONE-BRAIN CX1: too long to return whole -> head plus this note's
          // best-matching chunks (pool order = match order), not one chunk.
          const ids = r.chunkId ? [r.chunkId] : []
          for (const c of chunkPool) if (c.noteId === r.noteId && c.chunkId && !ids.includes(c.chunkId) && ids.push(c.chunkId) >= 4) break
          const det = new Map(store.getChunkDetails(req.org_id, req.user_id, ids).map((d) => [d.chunkId, d]))
          const ranges = ids.map((id) => det.get(id)).filter(Boolean).map((d) => ({ start: d.charStart, end: d.charEnd }))
          r.noteBody = buildNoteExcerpt(note.body, ranges, { maxChars: cap, headChars: 1500 })
          r.noteBodyPartial = true
        } catch { /* passage stays */ }
      }
    }
    mark('text')
    store.recordUsageEvent({ org_id: req.org_id, user_id: req.user_id || null, surface: 'search', source: usageSource(req) })
    let explain
    if (explainOn) {
      const finalRanked = rr.rerank === 'llm' ? rr.ranked : citableRanked
      explain = {
        perResult: perResultExplain(results, { sink: explainSink, chunkPool, retrieval, guaranteed, finalRanked, rerank: rr.rerank }),
        relevance: relevanceOut,
        rerank: rerank ?? 'off',
        grounding: groundingOut,
      }
      if (explainNoteId) {
        let visible = false
        let anyPass = null
        try {
          visible = Boolean(store.getNote(req.org_id, req.user_id, explainNoteId))
          if (visible && hasActiveFacets(facetFilters)) {
            const ids = store.getNoteChunkIds(req.org_id, req.user_id, explainNoteId)
            anyPass = store.filterChunkIdsByFacets(req.org_id, req.user_id, ids, facetFilters).size > 0
          }
        } catch { visible = false }
        explain.target = explainTarget(explainNoteId, {
          visible, facetsActive: hasActiveFacets(facetFilters), anyChunkPassesFacets: anyPass,
          ranked: citableRanked, finalRanked, offset: safeOffset, limit: clampedLimit, results, rerank: rr.rerank,
          retrieval, sink: explainSink?.sparseCandidates !== undefined ? explainSink : null, relevanceInsufficient: Boolean(relevanceOut.insufficient),
        })
      }
    }
    // Pin the retrieved revision so citation records attest to THIS version.
    const pinHashes = store.getNoteContentHashes(req.org_id, results.map((r) => r.noteId))
    for (const r of results) if (r && pinHashes[r.noteId]) r.noteHash = pinHashes[r.noteId]
    res.json({ stageMs, results, retrieval, ...(expandSink.status ? { expand: expandSink.status } : {}), ...(rerank ? { rerank } : {}), ...(rr.rerankVerdict ? { rerankVerdict: rr.rerankVerdict } : {}), ...(degradedSink.degraded && retrieval === 'fts' ? { degraded: degradedSink.degraded } : {}), relevance: relevanceOut, insufficient: relevanceOut.insufficient, ...(retrieval !== 'fts' && store.denseWindowTruncated(req.org_id) ? { denseWindowTruncated: true } : {}), ...(denseCoverage?.status === 'partial' ? { denseCoverage } : {}), tookMs: Date.now() - start, ...(explain ? { explain } : {}) })
  } catch (error) {
    console.error('[Brain] Search error:', error)
    res.status(500).json({ error: error.message })
  }
})

// BRAIN2-W8: portable export of the caller's VISIBLE notes (same scope rule as
// search + the org's vault exclusions). Streams JSONL (default) or a tar of .md
// files with YAML front matter (?format=markdown). ?scope=org|user|shared narrows.
app.get('/export', authenticate, async (req, res) => {
  const format = String(req.query.format || 'jsonl').toLowerCase()
  if (!['jsonl', 'markdown'].includes(format)) return res.status(400).json({ error: 'format must be jsonl or markdown' })
  const scope = req.query.scope
  if (scope !== undefined && !['org', 'user', 'shared'].includes(scope)) return res.status(400).json({ error: 'scope must be org, user or shared' })
  try {
    const orgCfg = await resolveOrgRetrievalConfig(req.org_id, { user_id: req.user_id })
    res.status(200)
    res.setHeader('Content-Type', format === 'markdown' ? 'application/x-tar' : 'application/x-ndjson')
    res.setHeader('Content-Disposition', `attachment; filename="brain-export.${format === 'markdown' ? 'tar' : 'jsonl'}"`)
    res.setHeader('Cache-Control', 'no-store')
    await streamExport(res, { orgId: req.org_id, userId: req.user_id, excludedVaultIdSet: orgCfg.excludedVaultIdSet, scope }, format)
  } catch (error) {
    console.error('[Brain] Export error:', error)
    if (!res.headersSent) res.status(500).json({ error: error.message })
    else res.destroy(error)
  }
})

registerSuggestionRoutes(app, authenticate)
registerCaptureRoutes(app, { authenticate })
registerCaptureDraftRoutes(app, { authenticate })
registerSubscriptionRoutes(app, { authenticate })
registerBriefRoutes(app, authenticate)

app.post('/brain/context', authenticate, orgBudgetMiddleware, async (req, res) => {
  try {
    const { query, tokenBudget = 800, vaultIds, kinds, minScore = 0, sources, scopes, languages } = req.body || {}
    const rerankOverride = isInstanceAuthority(req) && typeof req.body?.rerank === 'boolean' ? req.body.rerank : undefined
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query is required' })
    }
    const dateWindow = parseDateWindow(req.body?.since, req.body?.until)
    if (dateWindow.error) return res.status(400).json({ error: dateWindow.error })

    // assembleContext is async as of P4-WP2 (docs/STREAM_QUOXBRAIN_SECONDBRAIN_LENS.md
    // §P4) — it awaits the embedding seam ONLY when QUOXBRAIN_HYBRID_ENABLED='true';
    // otherwise it resolves synchronously-equivalent, same as before.
    const result = await assembleContext(req.org_id, req.user_id, { query, tokenBudget: Number(tokenBudget) || 800, vaultIds, kinds, minScore: Number(minScore) || 0, sources, scopes, languages, ...dateWindow.filters, queryEmbedTimeoutMs: embedTimeoutOf(req), rerank: rerankOverride, groundingMode: isInstanceAuthority(req) ? req.body?.groundingMode : undefined })
    store.recordUsageEvent({ org_id: req.org_id, user_id: req.user_id || null, surface: 'context', source: usageSource(req) })
    if (result.retrieval === 'hybrid' && store.denseWindowTruncated(req.org_id)) result.denseWindowTruncated = true
    if (Array.isArray(result.passages)) {
      const pinHashes = store.getNoteContentHashes(req.org_id, result.passages.map((p) => p.noteId))
      for (const p of result.passages) if (p?.citation && pinHashes[p.noteId]) p.citation.noteHash = pinHashes[p.noteId]
    }
    res.json(result)
  } catch (error) {
    console.error('[Brain] Context assembly error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// BRAIN-LEVEL GRAPH + FACETS (P2.5b-1, roadmap QUOXBRAIN #163) — cross-vault,
// scope-union reads so the frontend can render ONE brain with sources as
// filterable facets instead of a per-vault picker. Both routes union across
// EVERY vault visible to (req.org_id, req.user_id) via vaultStore's existing
// scope union (P2.5a) — facet filters below only ever NARROW that union,
// never widen it past what the caller is already authorized to see.
// =============================================================================

const BRAIN_GRAPH_NODE_CAP_DEFAULT = 800
const BRAIN_GRAPH_NODE_CAP_MAX = 2000
const BRAIN_GRAPH_EDGE_CAP = 1000

// Comma-separated query-string facet params (GET /brain/graph is a GET, so
// arrays travel as CSV, unlike the JSON-array body params on
// /brain/search /brain/context above).
function parseCsvParam(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

app.get('/brain/graph', authenticate, (req, res) => {
  try {
    const sources = parseCsvParam(req.query.sources)
    const scopes = parseCsvParam(req.query.scopes)
    const languages = parseCsvParam(req.query.languages)
    const limit = Math.min(Math.max(Number(req.query.limit) || BRAIN_GRAPH_NODE_CAP_DEFAULT, 1), BRAIN_GRAPH_NODE_CAP_MAX)
    const offset = Math.max(Number(req.query.offset) || 0, 0)

    const graph = store.getBrainGraph(req.org_id, req.user_id, { sources, scopes, languages, limit, offset })

    // The node page and the edge cap used to be applied INDEPENDENTLY, which
    // shipped edges pointing at ids that were not in `nodes` (a 1,200-note org
    // returned 800 nodes and 1,000 edges, ~800 of them dangling). Both graph
    // renderers throw "node not found: <id>" on one, so the payload must be
    // self-contained: keep only edges whose BOTH endpoints made this page,
    // THEN cap.
    const pageNodeIds = new Set(graph.nodes.map((n) => n.id))
    const pageEdges = graph.edges.filter((e) => pageNodeIds.has(e.source) && pageNodeIds.has(e.target))
    const edges = pageEdges.slice(0, BRAIN_GRAPH_EDGE_CAP)
    const truncated = (offset + graph.nodes.length < graph.total) || (graph.edgesTotal > edges.length)

    store.recordUsageEvent({ org_id: req.org_id, user_id: req.user_id || null, surface: 'graph', source: usageSource(req) })
    // Counts mirror the node pattern (`nodes` returned vs `total` in the whole
    // union): `edgesInPage` is the links between the returned nodes before the
    // edge cap (so `edges.length` vs `edgesInPage` is what the UI renders as
    // "N of M links shown"), `edgesTotal` is the union-wide link count.
    res.json({ nodes: graph.nodes, edges, truncated, total: graph.total, edgesInPage: pageEdges.length, edgesTotal: graph.edgesTotal })
  } catch (error) {
    console.error('[Brain] Get brain graph error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/brain/sources', authenticate, (req, res) => {
  try {
    res.json(store.getBrainSources(req.org_id, req.user_id))
  } catch (error) {
    console.error('[Brain] Get brain sources error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Brain-status pill + milestone progress bar (Brain2 D-WP1, roadmap
// QUOXBRAIN2, docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md screen 3). Bounded —
// getBrainStatus is a single grouped COUNT(*), never a body-scan.
//
// `embeddings` (no-env-only-config #setecastronomy): hybrid retrieval's
// dense leg silently starves when chunk_embeddings lags note_chunks, so
// coverage must be a visible number, not an inference from manual SQL. A
// plain JWT caller only ever sees its own org's totals (getEmbeddingCoverage
// against req.org_id, already resolved by authenticate, with no query-param
// override possible for a user token). A trusted service-key caller
// (req.service) gets the cross-org breakdown instead, matching the house
// pattern noted in middleware/auth.js: only a service-key caller is trusted
// with visibility beyond its own org.
app.get('/brain/status', authenticate, async (req, res) => {
  try {
    const status = store.getBrainStatus(req.org_id, { ownerUserId: req.user_id })
    Object.assign(status, denseBackendStatus())
    // ?embeddings=none — BRAIN2 P2a: the collector's /api/brain/overview fans
    // out one status call per org the caller belongs to, in parallel; the
    // cross-org embeddings coverage below is the expensive part (hundreds of
    // ms each, serialized on this single-threaded process) and blew the
    // overview's per-call timeout for many-org users, zeroing the whole
    // header. Callers that only need counts can skip it.
    if (req.query.embeddings !== 'none') {
      // BRAIN2-SEMANTIC: coverage is composed with the collector's zero-spend
      // provider probe into an honest state (ready | indexing | no_provider |
      // unknown) — see lib/embeddingStatus.js. Probe cached 60s in-process.
      const providerInfo = await getEmbeddingProviderCached()
      // quox#557: coverage cached 60s per key — the all-orgs scan was 5-6s
      // of every poll while only moving at backfill speed.
      status.embeddings = req.service
        ? { byOrg: getEmbeddingCoverageCached('all-orgs', () => store.getEmbeddingCoverageAllOrgs()), provider: providerInfo?.provider ?? null, model: providerInfo?.model ?? null }
        : composeEmbeddingsStatus(getEmbeddingCoverageCached(`org:${req.org_id}`, () => store.getEmbeddingCoverage(req.org_id)), providerInfo, annSyncPending(getDatabase()))
    }
    res.json(status)
  } catch (error) {
    console.error('[Brain] Get brain status error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Usage ledger (BRAIN2-PRODUCT P3a) — "is it used?" as a visible number.
// Org-scoped by req.org_id exactly like every other route (service callers
// scope via X-Org-Id, resolved by the authenticate middleware — no query
// param override here). See lib/vaultStore.js getUsage() for the shape.
app.get('/brain/usage', authenticate, (req, res) => {
  try {
    res.json(store.getUsage(req.org_id))
  } catch (error) {
    console.error('[Brain] Get usage error:', error)
    res.status(500).json({ error: error.message })
  }
})

// QuoxDream consolidation coverage (BRAIN2-V2 phase V2-4) — how far the
// dream watermark has actually got through this org's notes. Read-only:
// lib/vaultStore.js getDreamCoverage() is COUNT/MIN/MAX over notes +
// dream_cursor + dream_runs, and touches nothing the scheduler owns.
//
// A dedicated route rather than another block on GET /brain/status: that
// route's `embeddings` block already had to grow a ?embeddings=none escape
// hatch after its cost blew the collector's overview timeout (see its
// comment above), so this follows GET /brain/usage's pattern instead and
// leaves /brain/status's cost profile untouched.
//
// Org scope comes from req.org_id (resolved by authenticate) — never a query
// param, same as /brain/usage.
app.get('/brain/dream/status', authenticate, (req, res) => {
  try {
    res.json(store.getDreamCoverage(req.org_id))
  } catch (error) {
    console.error('[Brain] Get dream coverage error:', error)
    res.status(500).json({ error: error.message })
  }
})

// Recent autonomic activity feed (BRAIN2 visualiser) — a real, windowed read
// over ingest (notes), dream (consolidation runs) and embedding (recency
// only) activity. HONESTY: every count/id/timestamp below comes straight
// from a query in lib/vaultStore.js; nothing here is invented or estimated.
// `embedding.recentlyEmbeddedChunks` is explicitly labelled a recency proxy
// (chunk_embeddings.updated_at), NOT a discrete run event — the backfill
// scheduler writes embeddings independently of any single "run".
//
// window is a query param in seconds, clamped to [30, 3600] (default 300) so
// a caller can't request an unbounded or degenerate-tiny scan. Org/user scope
// comes from req.org_id/req.user_id (resolved by authenticate), same as
// every other route here — never a query-param override.
// QUOXON E5: decisions recorded since a time (notes tagged `decision`), for the collector's /api/v1/away.
app.get('/brain/decisions', authenticate, (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since.trim() : ''
  const t = Date.parse(since)
  if (!since || !Number.isFinite(t)) return res.status(400).json({ error: 'since must be an ISO time' })
  try {
    const r = store.getDecisionsSince(req.org_id, req.user_id, { sinceIso: new Date(t).toISOString(), limit: req.query.limit })
    res.json({ since: new Date(t).toISOString(), count: r.count, decisions: r.items })
  } catch (err) {
    console.error('[brain/decisions]', err.message)
    res.status(500).json({ error: 'decisions read failed' })
  }
})

app.get('/brain/activity', authenticate, (req, res) => {
  const parsedWindow = parseInt(req.query.window, 10)
  const windowSeconds = Math.min(3600, Math.max(30, Number.isFinite(parsedWindow) ? parsedWindow : 300))
  const nowIso = new Date().toISOString()
  const sinceIso = new Date(Date.now() - windowSeconds * 1000).toISOString()

  try {
    const recentNotes = store.getRecentNotes(req.org_id, req.user_id, { sinceIso, limit: 150 })
    const dreamCoverage = store.getDreamCoverage(req.org_id)
    const dreamActivity = store.getDreamActivity(req.org_id, sinceIso, 10)
    const recentlyEmbeddedChunks = store.getRecentlyEmbeddedChunkCount(req.org_id, sinceIso)

    // active = a run started but never finished (still running), OR its
    // start fell inside the requested window (ISO-8601 strings compare
    // lexicographically, same convention used elsewhere in this file).
    const active = Boolean(dreamCoverage.lastRunAt) &&
      (!dreamCoverage.lastRunFinishedAt || dreamCoverage.lastRunAt >= sinceIso)

    res.json({
      now: nowIso,
      windowSeconds,
      ingest: { count: recentNotes.count, noteIds: recentNotes.noteIds },
      dream: {
        active,
        lastRunAt: dreamCoverage.lastRunAt || null,
        notesReadRecent: dreamActivity.notesReadRecent,
        recentRuns: dreamActivity.recentRuns
      },
      embedding: {
        recentlyEmbeddedChunks,
        note: 'recency proxy from chunk_embeddings.updated_at, not a run event'
      }
    })
  } catch (error) {
    console.error('[Brain] Get brain activity error:', error)
    res.status(200).json({
      now: nowIso,
      windowSeconds,
      ingest: { count: 0, noteIds: [] },
      dream: { active: false, lastRunAt: null, notesReadRecent: 0, recentRuns: [] },
      embedding: { recentlyEmbeddedChunks: 0, note: 'recency proxy from chunk_embeddings.updated_at, not a run event' },
      error: error.message
    })
  }
})

// Citation ledger (BRAIN2-V2 phase V2-1) — the storage half of citation-rate
// telemetry. An agent calls quoxbrain_search, then answers; the collector
// detects which of the retrieved notes the final answer actually cited and
// reports it here, one row per answer. The RATE (grounded/answers) is derived
// at read time in GET /brain/usage's `citations` block.
//
// Org scope comes from req.org_id (resolved by authenticate) — never from the
// body, same tenant-injection defence as every other route here. user_id
// likewise prefers the authenticated identity; body.user_id is only the
// fallback for a service caller passing the end user through.
app.post('/brain/citations', authenticate, (req, res) => {
  // BRAIN2-AUDIT: the collector (X-Service-Key) is the only legitimate writer.
  // A JWT user could otherwise inflate their org's grounding rate.
  if (!req.service) return res.status(403).json({ error: 'citations_require_service_key' })
  try {
    const { corr = null, agent_id = null, retrieved_count, cited_count, supported_count = null, overlap_count = null, fabricated_count = null, cited_note_ids = [], records = [] } = req.body || {}

    const isCount = (v) => Number.isInteger(v) && v >= 0
    if (!isCount(retrieved_count) || !isCount(cited_count)) {
      return res.status(400).json({ error: 'retrieved_count and cited_count must be non-negative integers' })
    }
    if (cited_count > retrieved_count) {
      return res.status(400).json({ error: 'cited_count cannot exceed retrieved_count' })
    }

    if (supported_count !== null && supported_count !== undefined) {
      if (!isCount(supported_count)) return res.status(400).json({ error: 'supported_count must be a non-negative integer' })
      if (supported_count > cited_count) return res.status(400).json({ error: 'supported_count cannot exceed cited_count' })
    }
    if (overlap_count !== null && overlap_count !== undefined) {
      if (!isCount(overlap_count)) return res.status(400).json({ error: 'overlap_count must be a non-negative integer' })
      if (overlap_count + (supported_count ?? 0) > cited_count) return res.status(400).json({ error: 'overlap_count plus supported_count cannot exceed cited_count' })
    }

    if (fabricated_count !== null && fabricated_count !== undefined && !isCount(fabricated_count)) {
      return res.status(400).json({ error: 'fabricated_count must be a non-negative integer' })
    }

    store.recordCitationEvent({
      org_id: req.org_id,
      user_id: req.user_id ?? req.body?.user_id ?? null,
      agent_id,
      corr,
      retrieved_count,
      cited_count,
      supported_count: supported_count ?? null,
      overlap_count: overlap_count ?? null,
      fabricated_count: fabricated_count ?? null,
      cited_note_ids: Array.isArray(cited_note_ids) ? cited_note_ids : []
    })

    // BRAIN2-W13 A 118: durable per-reference records for this turn.
    if (Array.isArray(records) && records.length) {
      store.recordCitationRecords({
        org_id: req.org_id,
        user_id: req.user_id ?? req.body?.user_id ?? null,
        session: typeof corr === 'string' ? corr : null,
        records
      })
    }

    res.status(201).json({ ok: true })
  } catch (error) {
    console.error('[Brain] Record citation event error:', error)
    res.status(500).json({ error: error.message })
  }
})

// BRAIN2-W13 A 118: read back the durable per-turn citation records. Org from
// req.org_id; a user caller (JWT) is narrowed to their own turns, a service
// caller may name the user through X-User-Id (authenticate resolves it).
app.get('/brain/citations', authenticate, (req, res) => {
  try {
    const session = typeof req.query.session === 'string' && req.query.session ? req.query.session : null
    const records = store.listCitationRecords(req.org_id, { userId: req.user_id || null, session, limit: req.query.limit })
    res.json({ records })
  } catch (error) {
    console.error('[Brain] List citation records error:', error)
    res.status(500).json({ error: error.message })
  }
})

// ONE-BRAIN CX5: relevance judgements, the labelled eval set behind
// `quox brain eval`. Org from req.org_id only, never the body. A user caller
// reads/deletes only their own rows; a service caller sees the org's.
app.post('/brain/judgements', authenticate, (req, res) => {
  try {
    const { query, noteId = null, verdict, source = null } = req.body || {}
    const row = store.addRelevanceJudgement({ org_id: req.org_id, user_id: req.user_id || null, query, note_id: noteId, verdict, source })
    const { created, ...judgement } = row
    res.status(created ? 201 : 200).json({ judgement, created })
  } catch (error) {
    if (error.code === 'note_not_found') return res.status(404).json({ error: 'Note not found' })
    if (['bad_verdict', 'bad_query', 'note_required'].includes(error.code)) return res.status(400).json({ error: error.code })
    console.error('[Brain] Add judgement error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/brain/judgements', authenticate, (req, res) => {
  try {
    const judgements = store.listRelevanceJudgements(req.org_id, { userId: req.service ? null : (req.user_id || null), limit: req.query.limit })
    res.json({ judgements })
  } catch (error) {
    console.error('[Brain] List judgements error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.delete('/brain/judgements/:id', authenticate, (req, res) => {
  try {
    const ok = store.deleteRelevanceJudgement(req.org_id, req.params.id, { userId: req.service ? null : (req.user_id || '\u0000none') })
    if (!ok) return res.status(404).json({ error: 'Judgement not found' })
    res.json({ deleted: true })
  } catch (error) {
    console.error('[Brain] Delete judgement error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// ADMIN — org vault-root grants (R2, docs/STREAM_QUOXBRAIN_P1_CONTRACT.md §5).
// Beyond the default <QUOXBRAIN_VAULT_ROOT>/<org_id> subdir every org already
// owns (lib/vaultRoot.js orgAllowedRoots), an admin can grant an org read
// access to an additional root under the container's QUOXBRAIN_VAULT_ROOT —
// e.g. the shared NodeBrain demo vault, going forward.
// =============================================================================

// Mirrors services/memory/server.js requireAdmin: a trusted internal
// service-key caller (authenticate already verified X-Service-Key against
// INTERNAL_SERVICE_KEY, setting req.service = true) is implicitly admin;
// otherwise the caller's JWT must carry role 'admin' or 'owner'. Same check as
// isAdminCaller() above (used inline for the conditional POST /vaults
// scope='shared' gate); this is the middleware form for routes that are
// ALWAYS admin-only.
function requireAdmin(req, res, next) {
  if (isAdminCaller(req)) return next()
  return res.status(403).json({ error: 'Admin access required' })
}

// Account erasure (FND_01M4HZQ5P004YSXH0BWY04YSXH). Called by the collector's
// GDPR handler only: instance service key required, never a user JWT. Erases
// across every org (account deletion is account-wide); see store.eraseUser.
app.post('/internal/erase-user', authenticate, (req, res) => {
  if (!isInstanceAuthority(req)) return res.status(403).json({ error: 'service_key_required' })
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
  if (!userId) return res.status(400).json({ error: 'userId required' })
  try {
    const out = store.eraseUser(userId, { conversations: req.body?.conversations })
    console.log(`[Brain] erase-user ${userId}: ${JSON.stringify(out)}`)
    res.json({ erased: true, ...out })
  } catch (error) {
    console.error('[Brain] erase-user failed:', error.message)
    res.status(500).json({ error: 'erase failed' })
  }
})

app.post('/admin/vault-roots', authenticate, requireAdmin, (req, res) => {
  try {
    const { org_id, root_path, restricted = false } = req.body || {}
    if (!org_id || !root_path) {
      return res.status(400).json({ error: 'org_id and root_path are required' })
    }
    // BRAIN2-W3 A (001): an org admin may only manage roots for their OWN org.
    if (!isInstanceAuthority(req) && org_id !== req.org_id) {
      return res.status(403).json({ error: 'Org admins may only grant roots to their own org' })
    }

    const configuredRoot = process.env.QUOXBRAIN_VAULT_ROOT
    if (!configuredRoot) {
      return res.status(400).json({ error: 'QUOXBRAIN_VAULT_ROOT is not configured' })
    }

    let realRoot, realGrant
    try {
      realRoot = realpathSync(configuredRoot)
      realGrant = realpathSync(root_path)
    } catch (err) {
      return res.status(400).json({ error: `root_path does not resolve to a real directory: ${err.message}` })
    }

    // Can't grant a path outside the container's own vault root (e.g. /etc)
    // — a grant only ever widens which SUBDIR of the existing sandbox an org
    // can see, never the sandbox boundary itself.
    const withinRoot = realGrant === realRoot || realGrant.startsWith(realRoot + sep)
    if (!withinRoot) {
      return res.status(400).json({ error: 'root_path must be under the configured QUOXBRAIN_VAULT_ROOT' })
    }

    // BRAIN2-W3 A (001): a grant may never overlap ANOTHER org's default subdir
    // (<root>/<other_org>), whether it is that dir, inside it, or an ancestor
    // (incl. the whole root). Org admins are further confined to their own
    // default subtree; only the service key may grant other shared paths.
    const overlaps = (a, b) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep)
    for (const other of store.listKnownOrgIds().filter((o) => o !== org_id)) {
      let otherSub
      try { otherSub = realpathSync(resolve(realRoot, other)) } catch { otherSub = resolve(realRoot, other) }
      if (overlaps(realGrant, otherSub)) {
        return res.status(403).json({ error: "root_path overlaps another org's vault directory" })
      }
    }
    if (realGrant === realRoot) {
      return res.status(403).json({ error: 'root_path may not be the whole vault root' })
    }
    if (!isInstanceAuthority(req)) {
      let ownSub = null
      try { ownSub = realpathSync(resolve(realRoot, org_id)) } catch { /* no subdir yet */ }
      const inOwn = ownSub && ownSub !== realRoot && ownSub.startsWith(realRoot + sep) &&
        (realGrant === ownSub || realGrant.startsWith(ownSub + sep))
      if (!inOwn) {
        return res.status(403).json({ error: "Org admins may only grant paths inside their own org's vault directory" })
      }
    }

    const grant = store.createVaultRootGrant({ org_id, root_path: realGrant, restricted: Boolean(restricted) })
    res.status(201).json(grant)
  } catch (error) {
    console.error('[Brain] Create vault-root grant error:', error)
    res.status(500).json({ error: error.message })
  }
})

app.get('/admin/vault-roots', authenticate, requireAdmin, (req, res) => {
  try {
    const { org_id } = req.query
    if (!org_id) return res.status(400).json({ error: 'org_id query param is required' })
    if (!isInstanceAuthority(req) && org_id !== req.org_id) {
      return res.status(403).json({ error: 'Org admins may only list their own org grants' })
    }
    res.json(store.listVaultRootGrants(org_id))
  } catch (error) {
    console.error('[Brain] List vault-root grants error:', error)
    res.status(500).json({ error: error.message })
  }
})

// =============================================================================
// START SERVER
// =============================================================================

// Global error sanitizer — prevent internal details leaking to users
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'cors_rejected', message: 'Origin not allowed' })
  }
  console.error(`[Brain] Unhandled error on ${req.method} ${req.path}:`, err.message)
  const safeMessage = (process.env.NODE_ENV === 'production')
    ? 'An internal error occurred'
    : err.message?.substring(0, 200) || 'Unknown error'
  res.status(err.status || 500).json({ error: safeMessage })
})

// Initialize database
initDatabase(DB_PATH)

// Usage ledger 90-day cleanup (BRAIN2-PRODUCT P3a) — best-effort, runs once
// per boot (mirrors the other schedulers' startup calls below); keeps
// usage_events from growing unbounded. Never throws — see
// lib/vaultStore.js cleanupOldUsageEvents.
store.cleanupOldUsageEvents()

// Citation ledger 90-day cleanup (BRAIN2-V2 phase V2-1) — same best-effort
// boot-time hygiene as the usage ledger above. Never throws.
store.cleanupOldCitationEvents()

// Only bind the HTTP listener when this file is the entrypoint (`node server.js`).
// When imported by tests (supertest), we must NOT call app.listen — otherwise the
// listener keeps `node --test` alive forever and multiple importing test files
// collide on PORT. The ESM entrypoint check is import-timing-safe (unlike a
// NODE_ENV flag, which import hoisting would evaluate too late).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Brain Service] Running on port ${PORT}`)
    console.log(`[Brain Service] Database: ${DB_PATH}`)
    console.log(`[Brain Service] Environment: ${process.env.NODE_ENV || 'development'}`)
  })

  startDreamScheduler()
  startEmbeddingBackfillScheduler()
  startAnnBackfillScheduler()
  startRetractionScheduler()

  // Best-effort dense cache warm so the first search after boot is not a cold
  // load. Non-blocking; failures are logged, never fatal.
  setTimeout(async () => {
    try {
      for (const orgId of store.listEmbeddedOrgIds()) {
        const t0 = Date.now()
        try {
          const n = await store.warmDenseCache(orgId)
          console.log(`[Brain Service] dense cache warmed for org ${orgId}: ${n} vectors in ${Date.now() - t0}ms`)
        } catch (err) {
          console.error(`[Brain Service] dense cache warm failed for org ${orgId}: ${err.message}`)
        }
      }
    } catch (err) {
      console.error(`[Brain Service] dense cache warm skipped (org listing failed): ${err.message}`)
    }
  }, 1000)

  const shutdown = (sig) => {
    console.log(`[Brain Service] ${sig} received, shutting down...`)
    server.close(() => {
      closeDatabase()
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

export default app

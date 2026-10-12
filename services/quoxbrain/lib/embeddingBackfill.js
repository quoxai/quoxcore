// embeddingBackfill.js — Brain2 P4-WP2 embedding backfill
// (docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase F,
//  docs/STREAM_QUOXBRAIN_SECONDBRAIN_LENS.md §P4)
//
// Populates migrations/001-chunks.sql's `chunk_embeddings` table for chunks
// that don't have a row there yet, using lib/embeddingClient.js's embedTexts
// (collector /internal/embed seam, Gemini gemini-embedding-001, 768-dim).
// Idempotent: a chunk with an existing chunk_embeddings row is never
// re-selected, so a second run against the same corpus embeds nothing.
//
// Bounded + injectable, mirroring lib/quoxDream.js's resolveDeps() shape —
// every network call goes through `deps.embedFn` so this module is fully
// unit-testable with no network.

import { syncChunks } from './annIndex.js'
import { getDatabase } from './db.js'
import { embedTextsDetailed } from './embeddingClient.js'
import { resolveEmbedExclusionsDetailed, excludedVaultIds } from './brainConfig.js'
import { invalidateDenseCache } from './vaultStore.js'

// Matches embeddingClient.js's EMBED_DIM / migrations/001-chunks.sql's
// chunk_embeddings.dim column. EMBED_MODEL is only the stamp of last resort
// (legacy embedFn injection with no model info) — the real path stamps the
// model the collector actually used per text (BRAIN2-SEMANTIC 2026-08-25:
// the constant stamp is what mis-labelled 44k rows across two spaces).
const EMBED_MODEL = 'gemini-embedding-001'
const EMBED_DIM = 768

// PER-TEXT BYTE GUARD (2026-08-31 poison-batch incident, org
// 01KKNKH398KKEWB36JXRYR70QH): chunker.js's MAX_CHARS (1200 chars) bounds a
// NORMAL chunk, but chunker.js documents an explicit escape hatch — "a
// fence atom that is itself larger than MAX_CHARS is flushed as its own
// oversize chunk" — and a raw session transcript fed straight into a note
// body can land in note_chunks.text as a single multi-MB atom. The
// collector already truncates any text over EMBED_MAX_INPUT_CHARS
// (routes/quoxchat.js, 24000 chars) before it ever reaches the provider, so
// anything past that point buys nothing but network/JSON overhead — and is
// the likely reason this org's batches blew embeddingClient's 45s timeout
// on every attempt while other orgs' batches (no outsized text) embedded
// fine in the same window. Cap client-side at that SAME collector boundary,
// converted to bytes with a worst-case 4-bytes/char UTF-8 margin, so a text
// the collector would have accepted whole is never rejected here, and a
// text that was only ever going to be truncated to noise is never sent.
const EMBED_TEXT_MAX_BYTES = 24000 * 4 // 96,000 bytes

// DURABLE RETIREMENT (2026-08-31 poison-batch incident): sentinel `model`
// stamps used to permanently take a chunk out of BOTH the "missing
// embeddings" pass (getChunksMissingEmbeddings' `ce.chunk_id IS NULL` check
// is satisfied by any row, sentinel or real) and the space-healing pass
// (explicitly excluded below) — without a schema migration. `vector` is
// left NULL for these rows, which already keeps them out of dense search
// (vaultStore.js loadDenseVectors filters `ce.vector IS NOT NULL`). This
// reuses the existing chunk_embeddings table rather than adding new
// per-chunk retry-state schema (embeddingBackfillScheduler.js's own comment
// notes none exists today, by design).
const RETIRED_OVERSIZE_MODEL = '__quoxbrain_retired_oversize__'
const RETIRED_POISON_MODEL = '__quoxbrain_retired_poison__'

function resolveDeps(deps = {}, orgId) {
  // Detailed (texts[]) -> { vectors, models } function — defaults to the real
  // collector seam, forwarding this run's orgId so the collector can resolve
  // org-scoped BYOK provider keys. Tests inject a fake directly, no fetch
  // mocking needed. A legacy vectors-only `embedFn` injection still works:
  // wrapped, with models falling back to EMBED_MODEL.
  if (deps.embedDetailedFn) return { embedDetailedFn: deps.embedDetailedFn }
  if (deps.embedFn) {
    return {
      embedDetailedFn: async (texts) => {
        const vectors = await deps.embedFn(texts)
        const list = Array.isArray(vectors) ? vectors : []
        return { vectors: list, models: list.map((v) => (v ? EMBED_MODEL : null)) }
      },
    }
  }
  return { embedDetailedFn: (texts) => embedTextsDetailed(texts, { orgId }) }
}

function now() {
  return new Date().toISOString()
}

/**
 * Chunks visible to `orgId` (its OWN creation org — this is a maintenance
 * job over org_id, not a scope-union retrieval read) that have no
 * chunk_embeddings row yet, joined to notes per the task's read shape.
 * Bounded by `limit`.
 */
function getChunksMissingEmbeddings(orgId, limit, excluded = new Set()) {
  const db = getDatabase()
  // BRAIN2-V3 B4: chunks in vaults the org excluded from embedding are never
  // selected, so their text never reaches the embed client. (Vault ids are a
  // bounded per-org set, well inside SQLite's variable limit.)
  const rows = db.prepare(`
    SELECT nc.id AS chunkId, nc.org_id AS orgId, nc.note_id AS noteId, nc.text AS text, nc.vault_id AS vaultId
    FROM note_chunks nc
    JOIN notes n ON n.id = nc.note_id
    LEFT JOIN chunk_embeddings ce ON ce.chunk_id = nc.id
    WHERE nc.org_id = ? AND ce.chunk_id IS NULL
      ${excluded.size > 0 ? `AND nc.vault_id NOT IN (${[...excluded].map(() => '?').join(',')})` : ''}
    ORDER BY nc.rowid
    LIMIT ?
  `).all(orgId, ...excluded, limit)
  return rows
}

/** Encodes a plain number[] vector as the Buffer BLOB shape
 * vaultStore.denseSearchChunks' decodeVectorBlob expects back:
 * a Float32Array's raw bytes. */
function encodeVectorBlob(vector) {
  return Buffer.from(new Float32Array(vector).buffer)
}

/**
 * Backfills chunk_embeddings for chunks belonging to `orgId` that don't have
 * one yet. Never throws — any embedFn failure for a batch is caught and
 * counted, not fatal to the run. Distinct outcomes matter to the caller
 * (INFRA-CPU, 2026-08-30 CPU incident; poison-batch incident, 2026-08-31):
 *   - `failed`: a TOTAL call failure (network down, embeddingClient's 45s
 *     timeout on a non-timeout-triggering error — best-effort contract
 *     returns [] rather than throwing) — every sendable candidate this run
 *     is unembeddable because the request itself never came back. Also
 *     covers a per-text sub-call that embeddingClient.js never (re)sent at
 *     all this tick because its per-tick bisection budget ran out or it
 *     judged the embed endpoint down (`budgetExhausted`/`endpointDown` —
 *     STABILITY-AUDITS, 2026-08-31 systemic-slowness incident): neither
 *     says anything about the text itself, so it is NOT durably retired,
 *     just counted failed like any other total failure.
 *   - `skipped`: the provider responded 200 and explicitly declined an
 *     individual text (`null` entry within an otherwise successful batch).
 *   - `retiredOversize`: a text over EMBED_TEXT_MAX_BYTES was never sent at
 *     all, and is durably retired (see RETIRED_OVERSIZE_MODEL) so it never
 *     blocks this org's queue again.
 *   - `retiredPoison`: a text was sent but timed out
 *     SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS times in a row (embeddingClient.js's
 *     `timedOutRetired` flag) and is durably retired the same way — this is
 *     what stops a single poison text from permanently blocking every other
 *     chunk in the org's queue, the live bug this fixes (org
 *     01KKNKH398KKEWB36JXRYR70QH, 372 docs that could never embed).
 * Conflating any of these previously made a dead embed seam, a declined
 * text, and a permanently-poison text indistinguishable from one another,
 * so callers never saw the right signal to act on.
 *
 * @param {string} orgId
 * @param {{limit?:number, dryRun?:boolean}} [opts] - `limit` bounds how many
 *   un-embedded chunks a single call processes (default 200); `dryRun` calls
 *   embedFn (so the report is honest about what WOULD happen) but performs
 *   no INSERT — including no retirement row.
 * @param {object} [deps] - injectable { embedFn }
 * @returns {Promise<{embedded:number, skipped:number, healed:number, failed:number, retiredOversize:number, retiredPoison:number, error:string|null}>}
 */
const DEFAULT_POISON_REQUEUE_MS = 24 * 60 * 60 * 1000
const POISON_REQUEUE_MAX_ROWS = 50
function poisonRequeueMs() {
  const n = Number(process.env.QUOXBRAIN_EMBED_POISON_REQUEUE_MS)
  return process.env.QUOXBRAIN_EMBED_POISON_REQUEUE_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_POISON_REQUEUE_MS
}

/** Deletes up to POISON_REQUEUE_MAX_ROWS poison sentinels older than the cooling period so the chunks become "missing" again. */
function requeueRetiredPoison(db, orgId) {
  const cutoff = new Date(Date.now() - poisonRequeueMs()).toISOString()
  const info = db.prepare(`
    DELETE FROM chunk_embeddings WHERE chunk_id IN (
      SELECT chunk_id FROM chunk_embeddings
      WHERE org_id = ? AND model = ? AND vector IS NULL AND updated_at < ?
      ORDER BY updated_at LIMIT ?)
  `).run(orgId, RETIRED_POISON_MODEL, cutoff, POISON_REQUEUE_MAX_ROWS)
  if (info.changes > 0) console.log(`[EmbedBackfill] org=${orgId} requeued ${info.changes} timeout-retired chunk(s) after the cooling period`)
  return info.changes
}

export async function backfillEmbeddings(orgId, { limit = 200, dryRun = false } = {}, deps = {}) {
  const { embedDetailedFn } = resolveDeps(deps, orgId)

  // BRAIN2-V3 B4: per-org "Exclude sources from embedding" (setting >
  // env). Resolved once per run. Excluded vault text is never selected
  // below, and embedAndWrite re-checks as defence in depth.
  // BRAIN2-W2 2: privacy fail-closed. If the exclusion setting cannot be read
  // and no last-known-good exists for this org, we cannot know which vaults
  // are excluded, so NOTHING is embedded this tick (counted as a failure so
  // the scheduler backs off and the log says why). A resolver throw is the
  // same: never "no exclusions".
  let excluded = new Set()
  try {
    const { tokens, known } = await resolveEmbedExclusionsDetailed(orgId, deps)
    if (!known) {
      const msg = `embed exclusion setting unavailable and no last-known-good for org=${orgId}; skipping embedding this tick (fail closed)`
      console.error(`[EmbedBackfill] ${msg}`)
      return { embedded: 0, skipped: 0, healed: 0, failed: 1, retiredOversize: 0, retiredPoison: 0, error: msg }
    }
    if (tokens.length > 0) {
      const vaults = getDatabase().prepare('SELECT id, name FROM vaults WHERE org_id = ?').all(orgId)
      excluded = excludedVaultIds(tokens, vaults)
    }
  } catch (err) {
    const msg = `exclusion lookup failed for org=${orgId}: ${err.message}; skipping embedding this tick (fail closed)`
    console.error(`[EmbedBackfill] ${msg}`)
    return { embedded: 0, skipped: 0, healed: 0, failed: 1, retiredOversize: 0, retiredPoison: 0, error: msg }
  }

  let embedded = 0
  let skipped = 0
  let healed = 0
  let failed = 0
  let retiredOversize = 0
  let retiredPoison = 0
  let error = null

  const upsertRows = (db, toWrite) => {
    const upsert = db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, org_id, model, dim, vector, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        model = excluded.model, dim = excluded.dim,
        vector = excluded.vector, updated_at = excluded.updated_at
    `)
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        upsert.run(r.chunkId, r.orgId, r.model, EMBED_DIM, encodeVectorBlob(r.vector), now())
      }
    })
    tx(toWrite)
    // 075: new/changed vectors must be visible to dense search now, not after the cache TTL.
    for (const o of new Set(toWrite.map((r) => r.orgId))) invalidateDenseCache(o)
  }

  // DURABLE RETIREMENT: writes a chunk_embeddings row with a sentinel model
  // and a NULL vector, which (a) satisfies getChunksMissingEmbeddings' "not
  // missing" check so this chunk is never re-selected, and (b) is excluded
  // from dense search (vaultStore.js's `ce.vector IS NOT NULL` filter) and
  // from the space-healing mismatch query below, so a retired chunk is
  // never resurrected into a retry loop by either path.
  const retireChunk = (db, candidate, model) => {
    if (dryRun) return
    db.prepare(`
      INSERT INTO chunk_embeddings (chunk_id, org_id, model, dim, vector, updated_at)
      VALUES (?, ?, ?, 0, NULL, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        model = excluded.model, dim = excluded.dim,
        vector = excluded.vector, updated_at = excluded.updated_at
    `).run(candidate.chunkId, candidate.orgId, model, now())
  }

  /** Embeds `candidates`, returns { written, skippedHere, failedHere,
   * retiredOversizeHere, retiredPoisonHere, currentModel }. */
  const embedAndWrite = async (db, candidates) => {
    // PER-TEXT BYTE GUARD: filter oversize texts out BEFORE they're ever
    // sent — the collector would only truncate them anyway (see
    // EMBED_TEXT_MAX_BYTES' comment), and a multi-MB text in a batch
    // payload is the plausible reason a batch never came back inside
    // embeddingClient's timeout in the first place.
    const sendable = []
    let retiredOversizeHere = 0
    for (const c of candidates) {
      if (c.vaultId && excluded.has(c.vaultId)) continue
      const byteLen = Buffer.byteLength(c.text || '', 'utf8')
      if (byteLen > EMBED_TEXT_MAX_BYTES) {
        retireChunk(db, c, RETIRED_OVERSIZE_MODEL)
        retiredOversizeHere += 1
        console.warn(`[EmbedBackfill] chunk=${c.chunkId} note=${c.noteId} org=${c.orgId} is ${byteLen} bytes, over the ${EMBED_TEXT_MAX_BYTES}-byte per-text embed cap — retired without being sent (will not be retried)`)
        continue
      }
      sendable.push(c)
    }

    if (sendable.length === 0) {
      return { written: 0, skippedHere: 0, failedHere: 0, retiredOversizeHere, retiredPoisonHere: 0, currentModel: null }
    }

    const { vectors, models, timedOutRetired, budgetExhausted, endpointDown } = await embedDetailedFn(sendable.map((c) => c.text))
    // A TOTAL call failure (embeddingClient's best-effort contract — network
    // down, HTTP error, malformed response) — every sendable candidate is
    // unembeddable this run because the request itself never came back,
    // none written. This is `failed`, not `skipped`: nothing about the text
    // was declined, the seam just didn't answer. (A batch-level TIMEOUT no
    // longer reaches this branch at all in the normal case — embeddingClient
    // bisects timeouts down to individual texts, see embeddingClient.js's
    // ADAPTIVE SPLIT ON TIMEOUT comment — so this now only fires for a
    // seam that's genuinely down.)
    if (!Array.isArray(vectors) || vectors.length === 0) {
      return { written: 0, skippedHere: 0, failedHere: sendable.length, retiredOversizeHere, retiredPoisonHere: 0, currentModel: null }
    }

    const rows = []
    let skippedHere = 0
    let retiredPoisonHere = 0
    let failedHere = 0
    for (let i = 0; i < sendable.length; i++) {
      const vector = vectors[i]
      if (!Array.isArray(vector) || vector.length === 0) {
        // STABILITY-AUDITS (2026-08-31 systemic-slowness incident): a text
        // whose sub-call was never (re)sent because embeddingClient's
        // per-tick bisection budget ran out, or because it judged the embed
        // endpoint down for the rest of this tick (budgetExhausted[i] /
        // endpointDown[i]), is an ordinary FAILED text — same bucket as a
        // total call failure, since the provider never got a chance to
        // answer. Unlike timedOutRetired, neither says anything about the
        // text itself, so there is no basis to durably retire it — it stays
        // retry-eligible next tick. This is also what keeps
        // embeddingBackfillScheduler.js's per-org failure streak
        // (8e1a0958's per-org backoff) from fully resetting on a tick that
        // made SOME progress before the budget/endpoint cut it off short:
        // the scheduler only clears the streak when a tick's `failed` count
        // is zero, so counting these here (rather than as `skipped`)
        // preserves the sawtooth instead of re-arming the storm on every
        // partial-progress tick.
        if ((budgetExhausted && budgetExhausted[i]) || (endpointDown && endpointDown[i])) {
          failedHere += 1
        } else if (timedOutRetired && timedOutRetired[i]) {
          // A text that timed out SINGLE_TEXT_TIMEOUT_MAX_ATTEMPTS times in
          // a row (embeddingClient's timedOutRetired flag) is genuinely
          // poison — durably retire it so it stops blocking the rest of the
          // org's queue, the exact failure mode of the poison-batch
          // incident. A text the provider merely explicitly declined
          // (ordinary null, no timeout) stays an ordinary `skipped` — it may
          // well embed next run.
          retireChunk(db, sendable[i], RETIRED_POISON_MODEL)
          retiredPoisonHere += 1
          const byteLen = Buffer.byteLength(sendable[i].text || '', 'utf8')
          console.warn(`[EmbedBackfill] chunk=${sendable[i].chunkId} note=${sendable[i].noteId} org=${sendable[i].orgId} (${byteLen} bytes) timed out repeatedly and is being durably retired (will not be retried again)`)
        } else {
          skippedHere += 1
        }
        continue
      }
      // A vector with no model report is stamped EMBED_MODEL (legacy
      // collector fallback) rather than dropped: better an old-style stamp
      // than a hole, and healing corrects it once models flow.
      rows.push({ chunkId: sendable[i].chunkId, orgId: sendable[i].orgId, vector, model: models?.[i] || EMBED_MODEL })
    }

    if (!dryRun && rows.length > 0) {
      upsertRows(db, rows)
      // ANN live sync (no-op unless QUOXBRAIN_ANN=qdrant); never throws, a
      // failure rewinds the ANN backfill cursor so the job re-syncs the rows.
      await syncChunks(db, rows.map((r) => r.chunkId))
    }
    return { written: rows.length, skippedHere, failedHere, retiredOversizeHere, retiredPoisonHere, currentModel: rows.find((r) => r.model)?.model || null }
  }

  try {
    const db = getDatabase()
    let currentModel = null
    let budget = limit

    // 085: poison retirement is for chunks that timed out repeatedly, but a
    // provider outage looks identical. Re-open old sentinels so the chunk is
    // attempted again; a truly poisonous text just re-retires and waits again.
    if (!dryRun) requeueRetiredPoison(db, orgId)

    const missing = getChunksMissingEmbeddings(orgId, budget, excluded)
    if (missing.length > 0) {
      const r = await embedAndWrite(db, missing)
      embedded = r.written
      skipped += r.skippedHere
      failed += r.failedHere
      retiredOversize += r.retiredOversizeHere
      retiredPoison += r.retiredPoisonHere
      currentModel = r.currentModel
      budget -= missing.length
    }

    // SPACE HEALING (BRAIN2-SEMANTIC): rows embedded under a different model
    // live in a different vector space and are invisible to (or noise in)
    // dense search — re-embed them under the provider resolving NOW. When the
    // missing pass didn't reveal the current model, probe with one tiny embed.
    if (budget > 0) {
      // Sentinel-retired rows don't count as "has embeddings" — an org whose
      // ONLY chunk_embeddings rows are retirement sentinels (every real
      // chunk oversize/poison-retired) has nothing to heal, and without this
      // exclusion every tick would waste a probe embed call forever trying
      // to learn a "current model" for space healing that will never find
      // anything to re-embed.
      const hasEmbeddings = db.prepare(
        'SELECT 1 FROM chunk_embeddings ce JOIN note_chunks nc ON nc.id = ce.chunk_id WHERE nc.org_id = ? AND ce.model NOT IN (?, ?) LIMIT 1'
      ).get(orgId, RETIRED_OVERSIZE_MODEL, RETIRED_POISON_MODEL)
      if (!currentModel && hasEmbeddings) {
        // Nothing was missing, so this run never learned which provider
        // resolves right now — probe with one tiny embed. Skipped entirely
        // for orgs with no embeddings (nothing to heal).
        const probe = await embedDetailedFn(['quoxbrain embedding model probe'])
        currentModel = probe?.models?.find(Boolean) || null
      }
      if (!hasEmbeddings) currentModel = null
      if (currentModel) {
        // Sentinel-retired rows (RETIRED_OVERSIZE_MODEL / RETIRED_POISON_MODEL)
        // always mismatch currentModel too — explicitly excluded so a
        // retired chunk is never re-selected for healing and re-attempted.
        // 083: excluded vaults are filtered IN SQL, before LIMIT, so excluded
        // mismatched rows cannot occupy the whole batch and starve eligible ones.
        const mismatched = db.prepare(`
          SELECT nc.id AS chunkId, nc.org_id AS orgId, nc.note_id AS noteId, nc.text AS text, nc.vault_id AS vaultId
          FROM note_chunks nc
          JOIN chunk_embeddings ce ON ce.chunk_id = nc.id
          WHERE nc.org_id = ? AND ce.model != ? AND ce.model NOT IN (?, ?)
            AND (nc.vault_id IS NULL OR nc.vault_id NOT IN (SELECT value FROM json_each(?)))
          ORDER BY nc.rowid
          LIMIT ?
        `).all(orgId, currentModel, RETIRED_OVERSIZE_MODEL, RETIRED_POISON_MODEL, JSON.stringify([...excluded]), budget)
        if (mismatched.length > 0) {
          const r = await embedAndWrite(db, mismatched)
          healed = r.written
          skipped += r.skippedHere
          failed += r.failedHere
          retiredOversize += r.retiredOversizeHere
          retiredPoison += r.retiredPoisonHere
        }
      }
    }
  } catch (err) {
    error = err.message
  }

  return { embedded, skipped, healed, failed, retiredOversize, retiredPoison, error }
}

export { EMBED_TEXT_MAX_BYTES, RETIRED_OVERSIZE_MODEL, RETIRED_POISON_MODEL }
export default { backfillEmbeddings }

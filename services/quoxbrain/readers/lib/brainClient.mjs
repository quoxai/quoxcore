// brainClient.mjs — tiny HTTP client the P2b filesystem readers use to talk
// to the brain service's push-ingest API (P2b-1, POST /vaults + POST
// /vaults/:id/documents). Readers are host-runnable node scripts, not brain
// internals — everything here goes over the wire like any other internal
// service caller (X-Service-Key + X-Org-Id), never a direct db import.
//
// Best-effort logging only (console.log/error) — no dependency on the
// brain service's own logger, no retry/backoff machinery yet (readers are
// re-run manually or by a future scheduler; a failed run is safe to retry
// wholesale thanks to the API's own content-hash idempotency).

const BASE_URL = (process.env.QUOXBRAIN_URL || 'http://127.0.0.1:3106').replace(/\/$/, '')
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY

// Bulk push-ingest caps documents per call at 500 server-side — batch below
// that so a large corpus never trips the 400. A large corpus (e.g. the full
// docs/ tree, ~12MB across ~500 files) can ALSO trip the server's own
// express.json({ limit: '10mb' }) body-size cap well before it hits 500
// documents — so batches are split on whichever limit comes first: count
// or approximate serialized byte size (with headroom below the 10mb cap
// for JSON structural overhead + header bytes).
const BATCH_SIZE = 500
const MAX_BATCH_BYTES = 6 * 1024 * 1024

function splitIntoBatches(docs) {
  const batches = []
  let current = []
  let currentBytes = 0

  for (const doc of docs) {
    const docBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8')
    const wouldOverflow = current.length > 0 &&
      (current.length >= BATCH_SIZE || currentBytes + docBytes > MAX_BATCH_BYTES)
    if (wouldOverflow) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(doc)
    currentBytes += docBytes
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function headers(orgId, userId) {
  const h = { 'Content-Type': 'application/json', 'X-Org-Id': orgId }
  if (SERVICE_KEY) h['X-Service-Key'] = SERVICE_KEY
  // X-User-Id sets req.user_id for service callers — required so a scope='user'
  // vault is owned by (and writable by) the intended user, and its writes pass
  // canWriteVault's owner check (P2.5a).
  if (userId) h['X-User-Id'] = userId
  return h
}

async function readJsonOrThrow(res, context) {
  let body
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const message = body?.error || res.statusText
    throw new Error(`${context} failed (${res.status}): ${message}`)
  }
  return body
}

/**
 * Finds an existing push-vault by name for the given org, creating it
 * (source_type: 'push') if it doesn't exist yet. Safe to call on every
 * reader run — GET /vaults + name match is idempotent.
 *
 * @param {string} orgId
 * @param {string} name
 * @returns {Promise<string>} vault id
 */
export async function ensurePushVault(orgId, name, { scope = 'org', userId } = {}) {
  const listRes = await fetch(`${BASE_URL}/vaults`, { headers: headers(orgId, userId) })
  const vaults = await readJsonOrThrow(listRes, 'GET /vaults')

  const existing = Array.isArray(vaults)
    ? vaults.find((v) => v.name === name && v.source_type === 'push' && (v.scope || 'org') === scope)
    : null
  if (existing) {
    console.log(`[brainClient] using existing ${scope} push vault "${name}" (${existing.id})`)
    return existing.id
  }

  const createRes = await fetch(`${BASE_URL}/vaults`, {
    method: 'POST',
    headers: headers(orgId, userId),
    body: JSON.stringify({ name, source_type: 'push', scope })
  })
  const created = await readJsonOrThrow(createRes, 'POST /vaults')
  console.log(`[brainClient] created ${scope} push vault "${name}" (${created.id})`)
  return created.id
}

/**
 * Pushes documents into a vault, batching at BATCH_SIZE per call, and
 * aggregates the {added,updated,skipped,chunks} counters across batches.
 *
 * @param {string} orgId
 * @param {string} vaultId
 * @param {Array<{relPath:string, content:string, title?:string, kind?:string, sourceType?:string, occurredAt?:string}>} docs
 * @param {{deleteAbsent?: boolean}} [opts] - deleteAbsent only makes sense
 *   applied on the FINAL batch of a full-corpus push (it resyncs against
 *   everything the vault currently holds vs. what's been seen so far in this
 *   run) — callers doing a partial/windowed push should leave it false.
 * @returns {Promise<{added:number, updated:number, skipped:number, chunks:number}>}
 */
export async function pushDocuments(orgId, vaultId, docs, { deleteAbsent = false, userId, emptyConfirmed = false } = {}) {
  const totals = { added: 0, updated: 0, skipped: 0, chunks: 0 }
  // Codex cycle 4: an empty "snapshot" is far more often a failed read than a
  // real emptying of the source; never wipe a vault on one. Say so instead.
  // Codex cycle 5 F5: unless the reader CONFIRMS it read the source root and
  // it is genuinely empty (the last file was deleted). Then every indexed note
  // goes, through the same paged listing + explicit deletions as a split push.
  if (!Array.isArray(docs) || docs.length === 0) {
    if (deleteAbsent && emptyConfirmed) {
      const known = await listVaultRelPaths(orgId, vaultId, { userId })
      if (!known) totals.deleteSkipped = 'vault listing incomplete: nothing deleted'
      else totals.deleted = await deleteRelPaths(orgId, vaultId, known, userId)
    } else if (deleteAbsent) {
      totals.deleteSkipped = 'empty snapshot: nothing deleted'
    }
    return totals
  }

  const batches = splitIntoBatches(docs)
  // A snapshot that fits one request stays atomic (the server resyncs against
  // that request). A split snapshot must NOT send deleteAbsent per request:
  // the server would delete everything absent from that one batch (a
  // 501-document push used to leave only the 501st). Instead every batch is
  // pushed, then notes absent from the WHOLE snapshot are tombstoned.
  const atomic = deleteAbsent && batches.length === 1
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const res = await fetch(`${BASE_URL}/vaults/${vaultId}/documents`, {
      method: 'POST',
      headers: headers(orgId, userId),
      body: JSON.stringify({ documents: batch, deleteAbsent: atomic })
    })
    const result = await readJsonOrThrow(res, `POST /vaults/${vaultId}/documents`)
    totals.added += result.added || 0
    totals.updated += result.updated || 0
    totals.skipped += result.skipped || 0
    totals.chunks += result.chunks || 0
  }
  if (deleteAbsent && !atomic) {
    const known = await listVaultRelPaths(orgId, vaultId, { userId })
    if (!known) {
      totals.deleteSkipped = 'vault listing incomplete: nothing deleted'
    } else {
      const seen = new Set(docs.map((d) => d.relPath))
      const gone = known.filter((rp) => !seen.has(rp))
      if (gone.length) totals.deleted = await deleteRelPaths(orgId, vaultId, gone, userId)
    }
  }

  console.log(`[brainClient] pushed ${docs.length} document(s) into vault ${vaultId}:`, totals)
  return totals
}

async function deleteRelPaths(orgId, vaultId, relPaths, userId) {
  let deleted = 0
  for (let i = 0; i < relPaths.length; i += BATCH_SIZE) {
    const res = await fetch(`${BASE_URL}/vaults/${vaultId}/documents`, {
      method: 'POST', headers: headers(orgId, userId), body: JSON.stringify({ documents: [], deletions: relPaths.slice(i, i + BATCH_SIZE) })
    })
    const r = await readJsonOrThrow(res, `POST /vaults/${vaultId}/documents (deletions)`)
    deleted += r.deleted ?? relPaths.slice(i, i + BATCH_SIZE).length
  }
  return deleted
}

// Every rel_path in a vault, paged until an EMPTY page (the server caps page
// size), or null if any page fails: deletion must never run on a partial view.
async function listVaultRelPaths(orgId, vaultId, { userId, pageSize = 200, maxNotes = 200000 } = {}) {
  const out = []
  try {
    for (let offset = 0; offset < maxNotes;) {
      const res = await fetch(`${BASE_URL}/vaults/${vaultId}/notes?limit=${pageSize}&offset=${offset}`, { headers: headers(orgId, userId) })
      if (!res.ok) return null
      const body = await res.json()
      const notes = Array.isArray(body) ? body : (body?.notes || null)
      if (!Array.isArray(notes)) return null
      if (notes.length === 0) return out
      for (const n of notes) { const rp = n?.rel_path || n?.relPath; if (rp) out.push(rp) }
      offset += notes.length
    }
    return null
  } catch {
    return null
  }
}

export default { ensurePushVault, pushDocuments }

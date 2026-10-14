/**
 * brainFeedClient.js — CJS port of services/quoxbrain/readers/lib/brainClient.mjs
 * for The Feed (WP1, F1 slice).
 *
 * The collector is CJS (`require`); the quoxbrain readers are ESM
 * (`.mjs`, `import`/`export`) and are host-runnable scripts, not a
 * dependency the collector can import directly. This module ports the
 * same two functions — ensurePushVault + pushDocuments — with the same
 * wire contract (POST /vaults, POST /vaults/:id/documents, X-Service-Key +
 * X-Org-Id (+X-User-Id) auth, ≤500 docs/call batching) so The Feed's
 * ingesters talk to the brain identically to the readers.
 *
 * Best-effort by design (unlike brainClient.mjs, which throws on a bad
 * response and lets the caller decide): The Feed is a background
 * autopilot job (mirroring reflectionMiningScheduler's "never crash the
 * collector" contract) — every function here catches its own errors and
 * returns a `{ error }`-shaped result instead of throwing.
 */

'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const feedWatermark = require('./feedWatermark.js');

const MAX_DOC_REJECTIONS = 3;
const skipStore = new AsyncLocalStorage();

/**
 * Runs fn with a collector array: any document pushDocuments gives up on (rejected
 * MAX_DOC_REJECTIONS times in a row) is appended as {relPath, reason, attempts},
 * so the scheduler can show it in the feed's last_status.
 */
function collectSkips(sink, fn) { return skipStore.run(sink, fn); }

const BASE_URL = (process.env.QUOXBRAIN_URL || 'http://quoxbrain:3106').replace(/\/$/, '');
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

// Same caps as brainClient.mjs: bulk push-ingest caps documents per call at
// 500 server-side; batches also split on approx serialized byte size so a
// large corpus never trips express.json's body-size limit either.
const BATCH_SIZE = 500;
const MAX_BATCH_BYTES = 6 * 1024 * 1024;

function splitIntoBatches(docs) {
  const batches = [];
  let current = [];
  let currentBytes = 0;

  for (const doc of docs) {
    const docBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    const wouldOverflow = current.length > 0 &&
      (current.length >= BATCH_SIZE || currentBytes + docBytes > MAX_BATCH_BYTES);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(doc);
    currentBytes += docBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function headers(orgId, userId) {
  const h = { 'Content-Type': 'application/json', 'X-Org-Id': orgId };
  if (SERVICE_KEY) h['X-Service-Key'] = SERVICE_KEY;
  if (userId) h['X-User-Id'] = userId;
  return h;
}

async function readJsonOrNull(res) {
  try { return await res.json(); } catch { return null; }
}

/**
 * BRAIN2 P2 hardening (2026-08-25): one retry on a THROWN fetch (network-level
 * TypeError, e.g. a stale kept-alive socket or a service mid-restart) after a
 * short delay. Observed live: ensurePushVault("Conversations") failed with
 * bare "fetch failed" in the same tick where calls seconds either side
 * succeeded. HTTP error responses are NOT retried here — only transport
 * failures. Safe because every caller advances watermarks only on success.
 */
async function fetchWithRetry(fetchImpl, url, opts, signal) {
  // BRAIN2-W5 020: thread the scheduler's AbortSignal into every fetch so a
  // timed-out source actually stops, and never retry once aborted.
  if (signal) opts = { ...opts, signal };
  try {
    if (signal?.aborted) throw new Error('aborted');
    return await fetchImpl(url, opts);
  } catch (firstErr) {
    if (signal?.aborted) throw firstErr;
    await new Promise((r) => setTimeout(r, 750));
    if (signal?.aborted) throw firstErr;
    try {
      return await fetchImpl(url, opts);
    } catch (secondErr) {
      secondErr.message = `${secondErr.message} (after retry; first: ${String(firstErr.cause?.code || firstErr.cause?.message || firstErr.message).slice(0, 120)})`;
      throw secondErr;
    }
  }
}

/**
 * Finds an existing push-vault by name/scope for the given org, creating
 * it (source_type: 'push') if it doesn't exist yet. Best-effort: returns
 * null (never throws) if the brain is unreachable or errors — callers
 * must check for a null vaultId before pushing.
 *
 * @param {string} orgId
 * @param {string} name
 * @param {{scope?: string, userId?: string, fetchImpl?: Function}} [opts]
 * @returns {Promise<string|null>} vault id, or null on failure
 */
async function ensurePushVault(orgId, name, { scope = 'org', userId, fetchImpl = fetch, signal } = {}) {
  try {
    const listRes = await fetchWithRetry(fetchImpl, `${BASE_URL}/vaults`, { headers: headers(orgId, userId) }, signal);
    if (!listRes.ok) {
      const body = await readJsonOrNull(listRes);
      console.error(`[BrainFeedClient] org=${orgId}: GET /vaults failed HTTP ${listRes.status} — ${body?.error || listRes.statusText || ''}`);
      return null;
    }
    const vaults = await readJsonOrNull(listRes);
    const existing = Array.isArray(vaults)
      ? vaults.find((v) => v.name === name && v.source_type === 'push' && (v.scope || 'org') === scope)
      : null;
    if (existing) return existing.id;

    const createRes = await fetchWithRetry(fetchImpl, `${BASE_URL}/vaults`, {
      method: 'POST',
      headers: headers(orgId, userId),
      body: JSON.stringify({ name, source_type: 'push', scope }),
    }, signal);
    if (!createRes.ok) {
      const body = await readJsonOrNull(createRes);
      console.error(`[BrainFeedClient] org=${orgId}: POST /vaults failed HTTP ${createRes.status} — ${body?.error || createRes.statusText || ''}`);
      return null;
    }
    const created = await readJsonOrNull(createRes);
    return created?.id || null;
  } catch (err) {
    console.error(`[BrainFeedClient] org=${orgId}: ensurePushVault("${name}") failed — ${err.message}`);
    return null;
  }
}

/**
 * Pushes documents into a vault, batching at BATCH_SIZE (or MAX_BATCH_BYTES)
 * per call, aggregating {added,updated,skipped,chunks} across batches.
 * Best-effort: a failed batch is logged and skipped, the remaining batches
 * still attempt — never throws to the caller.
 *
 * @param {string} orgId
 * @param {string} vaultId
 * @param {Array<{relPath:string, content:string, title?:string, kind?:string, sourceType?:string, occurredAt?:string}>} documents
 * @param {{userId?: string, fetchImpl?: Function, deleteAbsent?: boolean}} [opts] deleteAbsent: ONLY for a complete snapshot; honoured only when it fits one call
 * @returns {Promise<{added:number, updated:number, skipped:number, chunks:number, error?:string}>}
 */
async function pushDocuments(orgId, vaultId, documents, { userId, fetchImpl = fetch, deleteAbsent = false, signal, dbPath } = {}) {
  const totals = { added: 0, updated: 0, skipped: 0, chunks: 0 };
  if (!vaultId) {
    console.error(`[BrainFeedClient] org=${orgId}: pushDocuments called with no vaultId — skipping`);
    return { ...totals, error: 'no vaultId' };
  }
  if (!Array.isArray(documents) || documents.length === 0) return totals;

  const batches = splitIntoBatches(documents);
  const errors = [];
  const rejectedRelPaths = [];
  const skippedPoison = [];

  // deleteAbsent is evaluated by the server PER CALL against that call's own
  // documents, so it is only safe when the whole snapshot travels in ONE
  // call; with several batches each call would delete every other batch's
  // notes. Never delete on a split (or caller-capped) snapshot.
  let sendDeleteAbsent = false;
  if (deleteAbsent) {
    if (batches.length === 1) sendDeleteAbsent = true;
    else console.error(`[BrainFeedClient] org=${orgId}: deleteAbsent ignored, snapshot split into ${batches.length} calls`);
  }

  for (const batch of batches) {
    try {
      const res = await fetchWithRetry(fetchImpl, `${BASE_URL}/vaults/${vaultId}/documents`, {
        method: 'POST',
        headers: headers(orgId, userId),
        body: JSON.stringify(sendDeleteAbsent ? { documents: batch, deleteAbsent: true } : { documents: batch }),
      }, signal);
      if (!res.ok) {
        const body = await readJsonOrNull(res);
        const message = `HTTP ${res.status} — ${body?.error || res.statusText || ''}`;
        console.error(`[BrainFeedClient] org=${orgId}: POST /vaults/${vaultId}/documents failed ${message}`);
        errors.push(message);
        continue;
      }
      const result = await readJsonOrNull(res);
      // R03: a 2xx with no usable counts is not proof the documents landed.
      if (!result || typeof result !== 'object' || (typeof result.added !== 'number' && typeof result.updated !== 'number')) {
        const message = 'malformed response from brain (missing added/updated counts)';
        console.error(`[BrainFeedClient] org=${orgId}: POST /vaults/${vaultId}/documents ${message}`);
        errors.push(message);
        continue;
      }
      // R02: per-document rejections ride on a 200. Never treat them as success.
      const rejections = Array.isArray(result.rejected) ? result.rejected : [];
      const rejectedIdx = new Set();
      for (const rj of rejections) {
        const relPath = (Number.isInteger(rj?.index) && batch[rj.index]?.relPath) || rj?.relPath || null;
        if (Number.isInteger(rj?.index)) rejectedIdx.add(rj.index);
        if (!relPath) { errors.push(`rejected document (unknown relPath): ${rj?.reason || 'unknown'}`); continue; }
        const reason = rj?.reason || 'unknown';
        const attempts = feedWatermark.bumpRejection(orgId, vaultId, relPath, reason, { dbPath });
        if (attempts >= MAX_DOC_REJECTIONS) {
          const skip = { relPath, reason, attempts };
          skippedPoison.push(skip);
          skipStore.getStore()?.push(skip);
          console.error(`[BrainFeedClient] org=${orgId}: skipping ${relPath} after ${attempts} consecutive rejections (${reason})`);
        } else {
          rejectedRelPaths.push(relPath);
          errors.push(`rejected ${relPath}: ${reason}`);
        }
      }
      const accepted = batch.filter((_, i) => !rejectedIdx.has(i)).map((d) => d.relPath).filter(Boolean);
      feedWatermark.clearRejections(orgId, vaultId, accepted, { dbPath });
      totals.added += result?.added || 0;
      totals.updated += result?.updated || 0;
      totals.skipped += result?.skipped || 0;
      totals.chunks += result?.chunks || 0;
    } catch (err) {
      console.error(`[BrainFeedClient] org=${orgId}: pushDocuments batch failed — ${err.message}`);
      errors.push(err.message);
    }
  }

  const out = errors.length > 0 ? { ...totals, error: errors.join('; ') } : totals;
  if (rejectedRelPaths.length) out.rejected = rejectedRelPaths;
  if (skippedPoison.length) out.skippedPoison = skippedPoison;
  // BRAIN2-W5 025: tell the caller a requested deleteAbsent was NOT applied
  // (split snapshot) so it can reconcile deletions itself (tombstones).
  if (deleteAbsent && !sendDeleteAbsent) out.deleteAbsentApplied = false;
  return out;
}

/**
 * Sends explicit tombstones: rel_paths that disappeared at the source. Only
 * call after a COMPLETE, error-free walk. Chunked at 500 per call. Never throws.
 *
 * @returns {Promise<{deleted:number, error?:string}>}
 */
async function pushDeletions(orgId, vaultId, relPaths, { userId, fetchImpl = fetch, signal } = {}) {
  const totals = { deleted: 0 };
  if (!vaultId) return { ...totals, error: 'no vaultId' };
  if (!Array.isArray(relPaths) || relPaths.length === 0) return totals;
  const errors = [];
  for (let i = 0; i < relPaths.length; i += 500) {
    const chunk = relPaths.slice(i, i + 500);
    try {
      const res = await fetchWithRetry(fetchImpl, `${BASE_URL}/vaults/${vaultId}/documents`, {
        method: 'POST',
        headers: headers(orgId, userId),
        body: JSON.stringify({ documents: [], deletions: chunk }),
      }, signal);
      if (!res.ok) {
        const body = await readJsonOrNull(res);
        errors.push(`HTTP ${res.status} — ${body?.error || res.statusText || ''}`);
        continue;
      }
      const result = await readJsonOrNull(res);
      totals.deleted += result?.deleted || 0;
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) console.error(`[BrainFeedClient] org=${orgId}: pushDeletions failed — ${errors.join('; ')}`);
  return errors.length > 0 ? { ...totals, error: errors.join('; ') } : totals;
}

/**
 * The brain's REAL note total across the org's push vaults (what The Feed
 * fills), read from each vault's note_count. Returns null on any failure so
 * callers can say "unavailable" instead of showing a fabricated 0.
 *
 * @returns {Promise<{notes:number, vaults:Array<{id:string,name:string,note_count:number}>}|null>}
 */
async function getPushVaultNoteTotals(orgId, { userId, fetchImpl = fetch, signal } = {}) {
  try {
    const res = await fetchWithRetry(fetchImpl, `${BASE_URL}/vaults`, { headers: headers(orgId, userId) }, signal);
    if (!res.ok) {
      console.error(`[BrainFeedClient] org=${orgId}: GET /vaults (note totals) failed HTTP ${res.status}`);
      return null;
    }
    const vaults = await readJsonOrNull(res);
    if (!Array.isArray(vaults)) return null;
    const push = vaults.filter((v) => v.source_type === 'push')
      .map((v) => ({ id: v.id, name: v.name, note_count: Number(v.note_count) || 0 }));
    return { notes: push.reduce((n, v) => n + v.note_count, 0), vaults: push };
  } catch (err) {
    console.error(`[BrainFeedClient] org=${orgId}: note totals failed — ${err.message}`);
    return null;
  }
}

/**
 * Every rel_path currently in a push vault (paged GET /vaults/:id/notes), for
 * a feed that reconciles deletions against a complete source listing.
 * Returns null on any failure: a caller must never delete on a partial view.
 */
// Pages until an EMPTY page, advancing by what actually came back: the server
// caps page size (200 today), so a short page is not the end. Stopping on a
// short page once produced a 32-of-412 view that would have tombstoned live
// streams (caught in a dry run before deploy, 2026-10-09).
async function listVaultRelPaths(orgId, vaultId, { userId, fetchImpl = fetch, signal, pageSize = 200, maxNotes = 50000 } = {}) {
  if (!vaultId) return null;
  const out = [];
  try {
    for (let offset = 0; offset < maxNotes;) {
      const res = await fetchWithRetry(fetchImpl, `${BASE_URL}/vaults/${vaultId}/notes?limit=${pageSize}&offset=${offset}`, { headers: headers(orgId, userId) }, signal);
      if (!res.ok) return null;
      const body = await readJsonOrNull(res);
      const notes = Array.isArray(body) ? body : (body?.notes || null);
      if (!Array.isArray(notes)) return null;
      if (notes.length === 0) return out;
      for (const n of notes) { const rp = n?.rel_path || n?.relPath; if (rp) out.push(rp); }
      offset += notes.length;
    }
    return null; // larger than maxNotes: not a complete view
  } catch (err) {
    console.error(`[BrainFeedClient] org=${orgId}: listVaultRelPaths failed, ${err.message}`);
    return null;
  }
}

module.exports = { collectSkips, MAX_DOC_REJECTIONS, ensurePushVault, pushDocuments, pushDeletions, getPushVaultNoteTotals, listVaultRelPaths };

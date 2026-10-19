/**
 * feedRepobrainSource.js, QN Phase 4, Chunk C (docs/STREAM_QUOX_REPOBRAIN_
 * PHASE4_PLAN.md), the Qortex-bridge half of the RepoBrain <-> Qortex
 * integration. The engine half (edge extraction/storage + the bounded
 * `/enumerate` endpoint) lives in services/repobrain, out of scope here.
 *
 * THE ONE FACT THAT DICTATES THE WHOLE FORMAT (from the plan doc): Qortex's
 * ingestDocuments (services/quoxbrain/lib/ingest.js) re-parses `doc.content`
 * for `[[wikilinks]]` and IGNORES any `doc.links` array entirely, that
 * array is collector-side observability only, mirroring feedObsidianSource's
 * `links` field. `resolveTarget` (services/quoxbrain/lib/linkResolver.js)
 * reduces a wikilink to its BASENAME (path tail, extension stripped,
 * lowercased) and matches byBasename first, then byTitle. So every import
 * edge this ingester wants Qortex to durably graph MUST be emitted as a
 * `[[<basename>]]` wikilink inside the importing file's note BODY, nowhere
 * else does anything. Basename collisions (many `index.ts`/`__init__.py`)
 * resolve first-wins server-side, a known lossiness this module MEASURES
 * (edgesFound vs edgesResolved) rather than hides.
 *
 * NEVER uses the browser-facing `/api/v1/nucleus/*` proxy (server.js), that
 * route is for authenticated dashboard callers. This ingester talks to the
 * org's resolved RepoBrain engine directly, the same way that proxy itself
 * does downstream: `resolveRepoBrainBackend(orgId)` for {baseUrl,
 * sharedSecret}, then `X-Org-Id` + conditional `X-RepoBrain-Key` headers
 * straight to `${baseUrl}/api/...` (see server.js's `/api/v1/nucleus/*`
 * handler for the identical header shape this mirrors).
 *
 * CUT 1 SCOPE (deliberately simple, per the plan doc): every tick fully
 * re-enumerates every target the org's backend returns (bounded by
 * opts.maxItems total files across all targets) rather than tracking a
 * true incremental cursor, the engine's `/enumerate` contract has no
 * per-file mtime to filter on yet. Unchanged files are expected to be
 * skipped server-side by Qortex's own content-hash dedup on push-ingest
 * (same as every other push source). The per-target watermark this module
 * writes is bookkeeping (last successful full sync time), not an input
 * filter, a straightforward place to hang real incremental sync later
 * once the engine exposes one.
 *
 * Dark by default like every other Feed source: the scheduler only fires
 * when QUOXFEED_ENABLED='true' and QUOXFEED_ORGS is set, and this ingester
 * additionally no-ops ({skipped:'no targets'}) for an org whose resolved
 * backend has nothing registered.
 */

'use strict';

const path = require('path');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const feedBatchSupport = require('./feedBatchSupport.js');
const { resolveRepoBrainBackend } = require('./repobrainRegistry.js');

const SOURCE_TYPE = 'repobrain';
const VAULT_NAME = 'Codebase (RepoBrain)';
const ENUMERATE_PAGE_SIZE = 500;
// Total files processed per tick, across ALL of the org's targets, the
// bound that keeps a huge monorepo (or many targets) from blowing one
// tick's budget. Mirrors the "bounded so a huge monorepo can't blow memory"
// rationale the plan doc gives the engine's own /enumerate endpoint.
const DEFAULT_MAX_ITEMS = 2000;
const CURSOR_SOURCE_TYPE = 'repobrain:__cursor__';

/**
 * repo-relative path (or raw import string) -> lowercase basename with its
 * code extension KEPT. Qortex's linkResolver.js keys note basenames by the
 * filename minus ONLY a `.md` suffix (linkResolver.js:12), so a code-file note
 * `foo.py` is indexed under `foo.py`. A wikilink target must therefore keep the
 * `.py`/`.ts`/`.go` extension to resolve — stripping it (an earlier assumption)
 * made every code edge unresolvable. We mirror the resolver exactly: strip only
 * `.md`. Returns null for an empty/falsy input (an out-edge with neither
 * to_path nor to_raw, never expected, guarded defensively rather than throwing).
 */
function linkBasename(p) {
  if (!p) return null;
  const base = path.basename(String(p)).replace(/\.md$/i, '');
  return base ? base.toLowerCase() : null;
}

/** Per-target watermark key, scoped further by feedWatermark's own org_id column. */
function watermarkSourceTypeForTarget(targetId) {
  return `${SOURCE_TYPE}:${targetId}`;
}

/**
 * Default targets-list client: GET {baseUrl}/api/targets, the same route
 * server.js's `/api/v1/nucleus/*` proxy forwards `/api/v1/nucleus/targets`
 * to. Returns [] on an unrecognised (non-array) body rather than throwing,
 * an empty org-visible target list is a legitimate, common state.
 */
async function defaultListTargets(backend, orgId, fetchImpl) {
  const res = await fetchImpl(`${backend.baseUrl}/api/targets`, {
    headers: {
      'X-Org-Id': orgId,
      ...(backend.sharedSecret ? { 'X-RepoBrain-Key': backend.sharedSecret } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET /api/targets failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? body : [];
}

/**
 * Default bounded-page client: GET {baseUrl}/api/targets/{id}/enumerate,
 * per the Chunk B contract: { files, total, limit, offset }.
 */
async function defaultEnumeratePage(backend, orgId, targetId, offset, fetchImpl) {
  const url = `${backend.baseUrl}/api/targets/${encodeURIComponent(targetId)}/enumerate?limit=${ENUMERATE_PAGE_SIZE}&offset=${offset}`;
  const res = await fetchImpl(url, {
    headers: {
      'X-Org-Id': orgId,
      ...(backend.sharedSecret ? { 'X-RepoBrain-Key': backend.sharedSecret } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET /api/targets/${targetId}/enumerate failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return {
    files: Array.isArray(body?.files) ? body.files : [],
    total: Number.isFinite(body?.total) ? body.total : 0,
  };
}

/**
 * Renders one enumerated file into a push-ingest document. `content` is
 * markdown carrying a title header, a Symbols section, and the Imports
 * section that is the ONLY thing Qortex turns into a durable graph edge
 * (see module header). `links` is collector-side observability only,
 * mirroring feedObsidianSource's identical caveat.
 *
 * @param {string} targetLabel - the target_id, already validated
 *   lowercase/alnum/hyphen by the engine (portal/routes/targets.py), so
 *   it is path-safe to use directly in relPath.
 * @param {{path:string, language?:string, symbols?:Array, out_edges?:Array}} file
 * @param {string} occurredAt - ISO timestamp, one per run (not per file):
 *   cut 1 has no per-file mtime from the engine to carry instead.
 * @returns {{relPath, title, kind, sourceType, occurredAt, content, links, edgesFound, edgesResolved}}
 */
function renderFileDoc(targetLabel, file, occurredAt) {
  const relPath = `repobrain/${targetLabel}/${file.path}`;
  const title = `${targetLabel}/${file.path}`;

  const lines = [`# ${title}`, ''];

  const symbols = Array.isArray(file.symbols) ? file.symbols : [];
  lines.push('## Symbols');
  if (symbols.length === 0) {
    lines.push('(none)');
  } else {
    for (const sym of symbols) {
      lines.push(`- ${sym.name} (${sym.kind}), line ${sym.start_line}`);
    }
  }

  const outEdges = Array.isArray(file.out_edges) ? file.out_edges : [];
  const seen = new Set();
  const wikilinkBasenames = [];
  const links = [];
  let edgesResolved = 0;

  for (const edge of outEdges) {
    const resolved = !!edge.to_path;
    if (resolved) edgesResolved++;
    links.push({
      targetRaw: edge.to_raw,
      type: 'wikilink',
      targetRelPath: edge.to_path || null,
      resolved,
    });

    const base = linkBasename(edge.to_path || edge.to_raw);
    if (base && !seen.has(base)) {
      seen.add(base);
      wikilinkBasenames.push(base);
    }
  }

  lines.push('', '## Imports');
  if (wikilinkBasenames.length === 0) {
    lines.push('(none)');
  } else {
    for (const base of wikilinkBasenames) {
      lines.push(`- [[${base}]]`);
    }
  }

  return {
    relPath,
    title,
    kind: 'code',
    sourceType: SOURCE_TYPE,
    occurredAt,
    content: lines.join('\n'),
    links,
    edgesFound: outEdges.length,
    edgesResolved,
  };
}

/**
 * Ingests every target visible to the org's resolved RepoBrain backend
 * into the "Codebase (RepoBrain)" push vault: files become notes, symbols
 * become a listed section, out-edges become `[[basename]]` wikilinks in
 * the note body (the only thing Qortex durably graphs). See module header
 * for cut-1 scope (full re-enumerate, server-side content-hash dedup).
 *
 * @param {string} orgId
 * @param {{maxItems?: number, dryRun?: boolean}} [opts]
 * @param {{
 *   fetchImpl?: Function,
 *   ensurePushVaultFn?: Function,
 *   pushDocumentsFn?: Function,
 *   getWatermarkFn?: Function,   // (orgId, targetId) => string|null (tests)
 *   setWatermarkFn?: Function,   // (orgId, targetId, ts) => void (tests)
 *   resolveBackendFn?: Function, // (orgId) => {baseUrl, sharedSecret} (tests)
 *   userId?: string,
 *   dbPath?: string,
 * }} [deps]
 * @returns {Promise<{targetsSeen:number, filesRead:number, docsPushed:number,
 *   edgesFound:number, edgesResolved:number, skipped:string|null, error:string|null}>}
 */
async function ingestRepobrain(orgId, opts = {}, deps = {}) {
  const result = {
    targetsSeen: 0,
    filesRead: 0,
    docsPushed: 0,
    edgesFound: 0,
    edgesResolved: 0,
    skipped: null,
    error: null,
  };

  const {
    fetchImpl = fetch,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    getWatermarkFn,
    setWatermarkFn,
    getCursorFn,
    setCursorFn,
    resolveBackendFn = resolveRepoBrainBackend,
    userId,
    dbPath,
  } = deps;

  const getWM = getWatermarkFn || ((org, targetId) => feedWatermark.getWatermark(org, watermarkSourceTypeForTarget(targetId), { dbPath }));
  const setWM = setWatermarkFn || ((org, targetId, ts) => feedWatermark.setWatermark(org, watermarkSourceTypeForTarget(targetId), ts, { dbPath }));

  // BRAIN2-V3 A4: durable pagination cursor {t: targetId, o: absolute file
  // index}. Without it every tick restarted at target 0 / offset 0 and, once
  // the item cap filled, files past the cap NEVER ingested (starvation).
  const getCur = getCursorFn || ((org) => feedWatermark.getWatermark(org, CURSOR_SOURCE_TYPE, { dbPath }));
  const setCur = setCursorFn || ((org, v) => feedWatermark.setWatermark(org, CURSOR_SOURCE_TYPE, v, { dbPath }));

  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const dryRun = !!opts.dryRun;

  // BRAIN2-FABLE11: durable state for deletion reconciliation. A target's file
  // list is only a complete snapshot once ONE pass has walked it from offset 0
  // to the end with no error; a pass spans ticks (resumable cursor), so the
  // relPaths seen so far live in `<key>:walk` = {seen, valid}.
  const stateStore = feedBatchSupport.resolveStateStore(deps, !!(getWatermarkFn || setWatermarkFn));
  const readWalk = async (targetId) => {
    if (!stateStore) return null;
    try { const raw = await stateStore.get(orgId, `${watermarkSourceTypeForTarget(targetId)}:walk`); return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  // targetId -> {seen:Set, valid:boolean, done:boolean}, applied only after a successful push
  const walks = new Map();

  let backend;
  try {
    backend = await resolveBackendFn(orgId);
  } catch (err) {
    result.error = `backend resolution failed, ${err.message}`;
    console.error(`[FeedRepobrainSource] org=${orgId}: ${result.error}`);
    return result;
  }

  let targets = [];
  try {
    targets = await defaultListTargets(backend, orgId, fetchImpl);
  } catch (err) {
    result.error = `list targets failed, ${err.message}`;
    console.error(`[FeedRepobrainSource] org=${orgId}: ${result.error}`);
    return result;
  }

  if (targets.length === 0) {
    result.skipped = 'no targets';
    return result;
  }

  result.targetsSeen = targets.length;

  const occurredAt = new Date().toISOString();
  const docs = [];
  const syncedTargetIds = [];

  let cursor = null;
  try {
    const raw = await getCur(orgId);
    cursor = raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`[FeedRepobrainSource] org=${orgId}: cursor read failed, starting from the top, ${err.message}`);
  }
  let startIdx = cursor ? targets.findIndex((t) => t?.target_id === cursor.t) : -1;
  if (startIdx < 0) { startIdx = 0; cursor = null; }
  const startOffset = cursor ? Math.max(0, Number(cursor.o) || 0) : 0;

  // null = walked everything (cursor resets so the next tick wraps to the top)
  let nextCursorValue = null;

  for (let ti = startIdx; ti < targets.length; ti++) {
    const target = targets[ti];
    const targetId = target?.target_id;
    if (!targetId) continue;
    if (docs.length >= maxItems) { nextCursorValue = { t: targetId, o: 0 }; break; }

    // Bookkeeping-only read (cut 1 never filters by it, see module header);
    // best-effort, a lookup failure never blocks the sync.
    try {
      await getWM(orgId, targetId);
    } catch (err) {
      console.error(`[FeedRepobrainSource] org=${orgId} target=${targetId}: watermark read failed, ${err.message}`);
    }

    const resumeAt = ti === startIdx ? startOffset : 0;
    // A pass that starts at the top begins a fresh seen-set; a resumed pass
    // continues the persisted one (and is unusable if none was persisted).
    const prevWalk = resumeAt === 0 ? null : await readWalk(targetId);
    const walk = { seen: new Set(prevWalk?.valid ? prevWalk.seen : []), valid: resumeAt === 0 || !!prevWalk?.valid, done: false };
    walks.set(targetId, walk);
    let offset = Math.floor(resumeAt / ENUMERATE_PAGE_SIZE) * ENUMERATE_PAGE_SIZE;
    let total = null;
    let targetOk = true;
    let capped = false;

    while (total === null || offset < total) {
      if (docs.length >= maxItems) { nextCursorValue = { t: targetId, o: offset }; capped = true; break; }

      let page;
      try {
        page = await defaultEnumeratePage(backend, orgId, targetId, offset, fetchImpl);
      } catch (err) {
        targetOk = false;
        walk.valid = false; // an errored listing is never a snapshot
        console.error(`[FeedRepobrainSource] org=${orgId} target=${targetId}: enumerate failed at offset=${offset}, ${err.message}`);
        break;
      }

      total = page.total;
      if (page.files.length === 0) break;

      for (let fi = 0; fi < page.files.length; fi++) {
        const file = page.files[fi];
        if (offset + fi < resumeAt) continue;
        if (docs.length >= maxItems) { nextCursorValue = { t: targetId, o: offset + fi }; capped = true; break; }
        if (!file?.path) continue;
        walk.seen.add(`repobrain/${targetId}/${file.path}`); // exists at source even if render fails below
        try {
          const doc = renderFileDoc(targetId, file, occurredAt);
          result.edgesFound += doc.edgesFound;
          result.edgesResolved += doc.edgesResolved;
          delete doc.edgesFound;
          delete doc.edgesResolved;
          docs.push(doc);
          result.filesRead++;
        } catch (err) {
          console.error(`[FeedRepobrainSource] org=${orgId} target=${targetId}: skipping ${file.path}, ${err.message}`);
        }
      }

      if (capped) break;
      offset += ENUMERATE_PAGE_SIZE;
    }

    if (targetOk && !capped) { syncedTargetIds.push(targetId); walk.done = true; }
    if (capped) break;
  }

  const persistCursor = async () => {
    try {
      await setCur(orgId, nextCursorValue ? JSON.stringify(nextCursorValue) : '');
    } catch (err) {
      console.error(`[FeedRepobrainSource] org=${orgId}: cursor write failed, ${err.message}`);
    }
  };

  if (dryRun) return result; // tallies filesRead/edgesFound/edgesResolved, pushes/advances nothing

  const hasWalkWork = [...walks.values()].some((w) => w.done || w.seen.size > 0 || !w.valid);
  if (docs.length === 0 && !(stateStore && hasWalkWork)) {
    if (cursor) await persistCursor(); // stale cursor (past the end): wrap
    return result;
  }

  const ensureVault = async () => ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });

  try {
    if (docs.length > 0) {
      const vaultId = await ensureVault();
      if (!vaultId) {
        result.error = 'ensurePushVault returned no vaultId';
        console.error(`[FeedRepobrainSource] org=${orgId}: ${result.error}, not advancing watermark`);
        return result;
      }

      const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
      if (pushResult?.error) {
        result.error = pushResult.error;
        console.error(`[FeedRepobrainSource] org=${orgId}: push failed, ${pushResult.error}, not advancing watermark`);
        return result;
      }

      result.docsPushed = docs.length;
    }
    await persistCursor();

    // BRAIN2-FABLE11: files that vanished from a COMPLETE enumeration (one
    // uninterrupted pass over a target, no errors, non-empty) are tombstoned.
    if (stateStore) {
      for (const [targetId, walk] of walks) {
        const key = watermarkSourceTypeForTarget(targetId);
        try {
          if (walk.done && walk.valid && walk.seen.size > 0) {
            const r = await feedBatchSupport.reconcileDeletions({
              store: stateStore, orgId, key, seen: [...walk.seen], complete: true, ensureVault,
              pushDeletionsFn, pushOpts: { userId, fetchImpl },
            });
            if (r.deleted > 0) result.deleted = (result.deleted || 0) + r.deleted;
            if (r.error) { result.error = r.error; console.error(`[FeedRepobrainSource] org=${orgId} target=${targetId}: ${r.error}`); }
            await stateStore.set(orgId, `${key}:walk`, '');
          } else if (walk.done || !walk.valid) {
            await stateStore.set(orgId, `${key}:walk`, ''); // finished empty / broken pass: start over
          } else {
            await stateStore.set(orgId, `${key}:walk`, JSON.stringify({ valid: walk.valid, seen: [...walk.seen] }));
          }
        } catch (err) {
          console.error(`[FeedRepobrainSource] org=${orgId} target=${targetId}: walk state write failed, ${err.message}`);
        }
      }
    }

    for (const targetId of syncedTargetIds) {
      try {
        await setWM(orgId, targetId, occurredAt);
      } catch (err) {
        console.error(`[FeedRepobrainSource] org=${orgId} target=${targetId}: watermark write failed, ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed, ${err.message}`;
    console.error(`[FeedRepobrainSource] org=${orgId}: ${result.error}, not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestRepobrain,
  renderFileDoc,
  linkBasename,
  watermarkSourceTypeForTarget,
  SOURCE_TYPE,
  VAULT_NAME,
  ENUMERATE_PAGE_SIZE,
  DEFAULT_MAX_ITEMS,
};

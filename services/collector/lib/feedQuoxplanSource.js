/**
 * feedQuoxplanSource.js — The Feed's QuoxPlan ingester (catalog sourceType
 * 'quoxplan', connector 'internal', requiresConfig false).
 *
 * Since the 2026-07-25 cutover, QuoxPlan (server on :3107) is the single
 * source of truth for streams, phases, notes and plan documents — the
 * decision record the roadmap-cli/STRATEGIC_ROADMAP.json used to carry.
 * Before this source existed, none of that reached Qortex, so a query like
 * "what did we decide about X" returned nothing even when the decision was
 * sitting in a QuoxPlan note. This closes that gap the same way
 * feedRepobrainSource.js closed it for the codebase: a bounded, read-only,
 * best-effort HTTP pull into a dedicated push vault.
 *
 * READ PATH: direct GET to QUOXPLAN_URL carrying X-Service-Key
 * (INTERNAL_SERVICE_KEY; the server's serviceKeyGate 401s without it) — mirrors
 * quoxplanTools.js's read tools and the standalone `quoxplan` CLI's own
 * client (cli/lib/client.js): "Reads carry no evidence implication and
 * staying direct keeps the CLI usable against a bare server". This module
 * NEVER writes to QuoxPlan, so the governed collector proxy
 * (/api/v1/quoxplan/*, used only for writes) does not apply here.
 *
 * INSTANCE-GLOBAL, NOT PER-TENANT — copied verbatim from
 * feedFleetSource.js's host-org gate: a direct read against QuoxPlan
 * carries no org header (see cli/lib/client.js), so it returns the same
 * roadmap regardless of which org's Feed tick is running. Without a gate,
 * every configured org would get the same roadmap duplicated into its
 * brain. QUOXFEED_QUOXPLAN_ORG designates the single org allowed to ingest
 * QuoxPlan; every other org gets an immediate, network-free, push-free
 * no-op. If unset, a one-time warning is logged and ingestion proceeds
 * anyway (soak convenience, matching feedFleetSource.js's contract).
 *
 * WHAT GETS PUSHED, per stream (bounded by maxStreams): one "stream" note
 * (name/status/tier/summary/phases checklist, always re-pushed — Qortex's
 * push-ingest content-hash dedup skips it server-side when unchanged, same
 * cut-1 reasoning feedRepobrainSource.js documents), one "plan" note (the
 * current plan document body, only if non-empty), and one "note" per
 * QuoxPlan note NEWER than that stream's watermark (notes are append-only
 * in QuoxPlan, so a strictly-after created_at filter is exactly correct,
 * no dedup needed). relPath is the stable per-item id every source in this
 * codebase uses for idempotent re-ingest — `quoxplan/<streamId>/stream.md`,
 * `.../plan.md`, `.../notes/<noteId>.md`.
 *
 * WATERMARK — per-stream (not a single 'quoxplan' cursor), same rationale
 * as feedFleetSource.js's per-host keying: one busy stream's notes must
 * never starve or skip a quieter stream's older-but-still-new notes. Keyed
 * `quoxplan:<streamId>` (streamId is already a short, path-safe slug per
 * QuoxPlan's own isValidSlug validation, so no hashing needed here, unlike
 * feedFolderSource.js's arbitrary host paths).
 */

'use strict';

const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const feedBatchSupport = require('./feedBatchSupport.js');
const configResolver = require('./configResolver.js');

const ROTATION_KEY = 'quoxplan:rotation';
const SOURCE_TYPE = 'quoxplan';
const VAULT_NAME = 'QuoxPlan';
const DEFAULT_ROADMAP_ID = 'quox-strategic';
// CORTEX-BENCH 2026-10-08: was 50, but the roadmap has 400+ streams and the
// list is in priority order, so most streams (including every recently
// created one, e.g. ONE-BRAIN, CONTACTSQ, AQ-9D) never reached Qortex and
// questions about them were unanswerable. All streams are now in rotation;
// the per-tick item budget (maxItems) still bounds each tick.
const DEFAULT_MAX_STREAMS = 2000;
// Total docs (stream + plan + notes, across all streams) pushed per tick —
// the bound that keeps one tick's work bounded regardless of backlog,
// mirroring feedRepobrainSource.js's DEFAULT_MAX_ITEMS.
const DEFAULT_MAX_ITEMS = 200;
const FETCH_TIMEOUT_MS = 10000;

let warnedNoOrg = false;

function getBaseUrl() {
  return process.env.QUOXPLAN_URL || 'http://quoxplan:3107';
}

/**
 * QuoxPlan's /api/v1 sits behind serviceKeyGate (X-Service-Key, armed when
 * QUOXPLAN_SERVICE_KEY is set, which compose maps to INTERNAL_SERVICE_KEY).
 * Reads without it 401. Read at call time so key rotation needs no restart.
 */
function authHeaders() {
  const key = process.env.INTERNAL_SERVICE_KEY;
  return key ? { 'X-Service-Key': key } : {};
}

/** Per-stream watermark key — see module header. */
function watermarkKeyForStream(streamId) {
  return `${SOURCE_TYPE}:${streamId}`;
}

/**
 * Default roadmap-streams client: GET {baseUrl}/api/v1/roadmaps/{roadmapId}/streams?lens=all.
 * Returns [] on an unrecognised (non-array) body rather than throwing.
 */
async function defaultListStreams(baseUrl, roadmapId, fetchImpl, signal) {
  const url = `${baseUrl}/api/v1/roadmaps/${encodeURIComponent(roadmapId)}/streams?lens=all`;
  // STABILITY-AUDITS #2: combine the per-call timeout with the
  // feedScheduler-level abort signal (fired when the whole ingester call
  // overruns its ingestTimeoutMs) so a tick-level timeout stops this fetch
  // immediately rather than waiting out its own FETCH_TIMEOUT_MS budget.
  const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchImpl(url, { headers: authHeaders(), signal: combinedSignal });
  if (!res.ok) throw new Error(`GET /api/v1/roadmaps/${roadmapId}/streams failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.streams) ? body.streams : [];
}

/**
 * Default stream-detail client: GET {baseUrl}/api/v1/streams/{id}, the same
 * route the CLI's `show`/`plan` commands use — { stream, phases, plan, notes }.
 */
async function defaultGetStreamDetail(baseUrl, streamId, fetchImpl, signal) {
  const url = `${baseUrl}/api/v1/streams/${encodeURIComponent(streamId)}`;
  // STABILITY-AUDITS #2: see defaultListStreams above.
  const combinedSignal = signal ? AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), signal]) : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchImpl(url, { headers: authHeaders(), signal: combinedSignal });
  if (!res.ok) throw new Error(`GET /api/v1/streams/${streamId} failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return body || null;
}

/**
 * Renders one stream's header + phase checklist into a push-ingest
 * document. Always rebuilt (cut-1, see module header) — server-side
 * content-hash dedup skips it when nothing changed.
 */
function renderStreamDoc(stream, phases, occurredAt) {
  const list = Array.isArray(phases) ? phases : [];
  const lines = [
    `# ${stream.name || stream.id}`,
    '',
    `Status: ${stream.status || 'unknown'}`,
    `Tier: ${stream.tier ?? 'unset'}`,
  ];
  if (stream.summary) lines.push('', stream.summary);
  lines.push('', '## Phases');
  if (list.length === 0) {
    lines.push('(none)');
  } else {
    for (const phase of list) {
      const box = phase.status === 'DONE' || phase.status === 'COMPLETE' ? '[x]' : '[ ]';
      lines.push(`- ${box} ${phase.title}${phase.done_at ? ` (${phase.done_at})` : ''}`);
    }
  }

  return {
    relPath: `quoxplan/${stream.id}/stream.md`,
    title: stream.name || stream.id,
    kind: 'quoxplan_stream',
    sourceType: SOURCE_TYPE,
    occurredAt,
    content: lines.join('\n'),
  };
}

/** Renders the current plan document body, or null if empty/absent. */
function renderPlanDoc(stream, plan) {
  const body = (plan && plan.body) || '';
  if (!body.trim()) return null;
  return {
    relPath: `quoxplan/${stream.id}/plan.md`,
    title: `${stream.name || stream.id} — Plan`,
    kind: 'quoxplan_plan',
    sourceType: SOURCE_TYPE,
    occurredAt: plan.updated_at || new Date().toISOString(),
    content: body,
  };
}

/** Renders one append-only QuoxPlan note into a push-ingest document. */
function renderNoteDoc(stream, note) {
  const lines = [
    `# ${stream.name || stream.id} — note`,
    '',
    `Author: ${note.author || 'unknown'}`,
    `Date: ${note.created_at}`,
    '',
    note.body || '',
  ];
  return {
    relPath: `quoxplan/${stream.id}/notes/${note.id}.md`,
    title: `${stream.name || stream.id} — note ${note.id}`,
    kind: 'quoxplan_note',
    sourceType: SOURCE_TYPE,
    occurredAt: note.created_at,
    content: lines.join('\n'),
  };
}

/**
 * Ingests every stream on the configured QuoxPlan roadmap (default
 * 'quox-strategic') into the "QuoxPlan" push vault: each stream becomes a
 * header+phases note, its current plan document becomes a plan note, and
 * every note newer than that stream's watermark becomes its own note.
 *
 * ORG GATE: if QUOXFEED_QUOXPLAN_ORG is set and `orgId` doesn't match it,
 * this returns immediately with no QuoxPlan call and no push (see module
 * header). If unset, a one-time warning is logged and ingestion proceeds
 * anyway.
 *
 * @param {string} orgId
 * @param {{config?: {roadmapId?: string, maxStreams?: number}, maxItems?: number, dryRun?: boolean}} [opts]
 * @param {{
 *   listStreamsFn?: Function,      // (baseUrl, roadmapId, fetchImpl) => Array<{id}> (tests)
 *   getStreamDetailFn?: Function,  // (baseUrl, streamId, fetchImpl) => {stream, phases, plan, notes} (tests)
 *   getWatermarkFn?: Function,     // (orgId, streamId) => string|null (tests)
 *   setWatermarkFn?: Function,     // (orgId, streamId, ts) => void (tests)
 *   ensurePushVaultFn?: Function,
 *   pushDocumentsFn?: Function,
 *   fetchImpl?: Function,
 *   userId?: string,
 *   dbPath?: string,
 * }} [deps]
 * @returns {Promise<{streamsSeen:number, notesRead:number, docsPushed:number, skipped:string|null, error:string|null}>}
 */
async function ingestQuoxplan(orgId, opts = {}, deps = {}) {
  const result = {
    streamsSeen: 0,
    notesRead: 0,
    docsPushed: 0,
    skipped: null,
    error: null,
  };

  // BRAIN2-W3 B (011): the roadmap is instance-global; fail CLOSED when no
  // designated org is set.
  const orgGate = process.env.QUOXFEED_QUOXPLAN_ORG;
  if (!orgGate || orgId !== orgGate) {
    result.skipped = orgGate ? 'not quoxplan org' : 'quoxplan org not designated';
    return result;
  }

  const {
    listStreamsFn = defaultListStreams,
    getStreamDetailFn = defaultGetStreamDetail,
    getWatermarkFn = (org, streamId) => feedWatermark.getWatermark(org, watermarkKeyForStream(streamId), { dbPath: deps.dbPath }),
    setWatermarkFn = (org, streamId, ts) => feedWatermark.setWatermark(org, watermarkKeyForStream(streamId), ts, { dbPath: deps.dbPath }),
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    listVaultRelPathsFn = brainFeedClient.listVaultRelPaths,
    pushDeletionsFn = brainFeedClient.pushDeletions,
    fetchImpl = fetch,
    userId,
  } = deps;

  const config = opts.config || null;
  // VAULT-INTEG P17: was a bare process.env read — now resolved via
  // configResolver.getInstanceSetting() (platformCapabilities.js
  // QUOXFEED_QUOXPLAN_ROADMAP_ID), called fresh on every ingest call. A
  // connected source's own config.roadmapId still wins over both, same
  // precedence as before.
  const roadmapId = config?.roadmapId || configResolver.getInstanceSetting('QUOXFEED_QUOXPLAN_ROADMAP_ID').value || DEFAULT_ROADMAP_ID;
  const maxStreams = config?.maxStreams || DEFAULT_MAX_STREAMS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const dryRun = !!opts.dryRun;
  const baseUrl = getBaseUrl();

  let streams = [];
  try {
    streams = await listStreamsFn(baseUrl, roadmapId, fetchImpl, opts.signal);
  } catch (err) {
    result.error = `list streams failed, ${err.message}`;
    console.error(`[FeedQuoxplanSource] org=${orgId}: ${result.error}`);
    return result;
  }

  if (streams.length === 0) {
    result.skipped = 'no streams';
    return result;
  }

  // The COMPLETE live stream set, for tombstoning deleted streams below.
  const liveStreamIds = new Set(streams.map((st) => st?.id).filter(Boolean));

  // Most recently updated first, so active streams reach the brain first.
  streams = [...streams].sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || ''))).slice(0, maxStreams);
  result.streamsSeen = streams.length;

  // BRAIN2-W5 034: rotating start. Each tick used to begin at stream 0 and spend
  // its whole item budget there, so later streams were never visited. The
  // stream the previous tick stopped at is persisted and resumed from.
  const rotationStore = feedBatchSupport.resolveStateStore(deps, !!deps.getWatermarkFn);
  let startId = null;
  try { startId = rotationStore ? (await rotationStore.get(orgId, ROTATION_KEY)) || null : null; } catch { startId = null; }
  const startIdx = Math.max(0, streams.findIndex((st) => st?.id === startId));
  streams = streams.slice(startIdx).concat(streams.slice(0, startIdx));
  // CORTEX-BENCH: streams updated in the last 7 days go FIRST on every tick,
  // ahead of the rotation (which covers the long tail). Otherwise a just-
  // created stream waited for the rotation to wrap through hundreds of stale
  // ones (hours at ~100 streams per 30-min tick) before reaching the brain.
  const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const isRecent = (st) => { const t = Date.parse(st?.updated_at || ''); return Number.isFinite(t) && nowMs - t < RECENT_MS; };
  streams = [...streams.filter(isRecent).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))), ...streams.filter((st) => !isRecent(st))];
  let nextStartId = ''; // '' = all visited, start from the top next time

  const occurredAt = new Date().toISOString();
  const docs = [];
  const watermarkAdvances = []; // { streamId, ts } — applied only after a successful push

  for (const streamSummary of streams) {
    const streamId = streamSummary?.id;
    if (!streamId) continue;
    if (docs.length >= maxItems) { nextStartId = nextStartId || streamId; break; }

    let detail;
    try {
      detail = await getStreamDetailFn(baseUrl, streamId, fetchImpl, opts.signal);
    } catch (err) {
      console.error(`[FeedQuoxplanSource] org=${orgId} stream=${streamId}: fetch failed, skipping, ${err.message}`);
      continue;
    }
    if (!detail || !detail.stream) continue;

    const { stream, phases, plan, notes } = detail;

    docs.push(renderStreamDoc(stream, phases, occurredAt));

    const planDoc = renderPlanDoc(stream, plan);
    if (planDoc) docs.push(planDoc);

    let storedWatermark = null;
    try {
      storedWatermark = await getWatermarkFn(orgId, streamId);
    } catch (err) {
      console.error(`[FeedQuoxplanSource] org=${orgId} stream=${streamId}: watermark read failed, treating as no watermark, ${err.message}`);
    }

    const allNotes = Array.isArray(notes) ? notes : [];
    result.notesRead += allNotes.length;

    // Compound (created_at, id) cursor (BRAIN2-V3 A4). The old code also
    // advanced the watermark to the LAST eligible note even when the item
    // cap had cut earlier-queued notes off, silently dropping them; now only
    // notes actually rendered move the cursor.
    const eligible = allNotes
      .filter((n) => n && n.id != null && n.created_at && feedWatermark.isAfterCursor(storedWatermark, n.created_at, String(n.id)))
      .sort((a, b) => feedWatermark.compareByTsId({ ts: a.created_at, id: String(a.id) }, { ts: b.created_at, id: String(b.id) }));

    const processed = [];
    const remaining = [];
    for (const note of eligible) {
      if (docs.length >= maxItems) { remaining.push({ ts: note.created_at, id: String(note.id) }); continue; }
      docs.push(renderNoteDoc(stream, note));
      processed.push({ ts: note.created_at, id: String(note.id) });
    }

    const advance = feedWatermark.nextCursor(processed, remaining);
    if (advance) watermarkAdvances.push({ streamId, ts: advance });
    if (remaining.length > 0 && !nextStartId) nextStartId = streamId; // notes still owed: resume here
  }

  if (docs.length === 0) return result;

  if (dryRun) return result; // tallies streamsSeen/notesRead, pushes/advances nothing

  try {
    const vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedQuoxplanSource] org=${orgId}: ${result.error}, not advancing watermarks`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedQuoxplanSource] org=${orgId}: push failed, ${pushResult.error}, not advancing watermarks`);
      return result;
    }

    result.docsPushed = docs.length;

    // ONE-BRAIN CX1 (dry-run audit finding 3): a stream deleted in QuoxPlan
    // stayed searchable forever. Tombstone every rel_path of a stream that is
    // no longer listed. Never on a partial view: the vault listing must be
    // complete, and a live list under half the indexed streams is treated as
    // a bad response, not a mass deletion.
    try {
      const known = await listVaultRelPathsFn(orgId, vaultId, { userId, fetchImpl, signal: opts.signal });
      if (Array.isArray(known)) {
        const streamOf = (rp) => { const m = /^quoxplan\/([^/]+)\//.exec(rp); return m ? m[1] : null; };
        const indexed = new Set(known.map(streamOf).filter(Boolean));
        const dead = known.filter((rp) => { const id = streamOf(rp); return id && !liveStreamIds.has(id); });
        if (dead.length && liveStreamIds.size < indexed.size / 2) {
          result.deletionSkipped = `partial stream list (${liveStreamIds.size} live vs ${indexed.size} indexed)`;
          console.error(`[FeedQuoxplanSource] org=${orgId}: ${result.deletionSkipped}, not deleting`);
        } else if (dead.length) {
          const del = await pushDeletionsFn(orgId, vaultId, dead, { userId, fetchImpl, signal: opts.signal });
          if (del?.error) console.error(`[FeedQuoxplanSource] org=${orgId}: deletion push failed, ${del.error}`);
          else result.streamsDeleted = new Set(dead.map(streamOf)).size;
        }
      }
    } catch (err) {
      console.error(`[FeedQuoxplanSource] org=${orgId}: deletion reconcile failed, ${err.message}`);
    }

    if (rotationStore) {
      try { await rotationStore.set(orgId, ROTATION_KEY, nextStartId); } catch (err) {
        console.error(`[FeedQuoxplanSource] org=${orgId}: rotation write failed, ${err.message}`);
      }
    }

    for (const { streamId, ts } of watermarkAdvances) {
      try {
        await setWatermarkFn(orgId, streamId, ts);
      } catch (err) {
        console.error(`[FeedQuoxplanSource] org=${orgId} stream=${streamId}: watermark write failed, ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed, ${err.message}`;
    console.error(`[FeedQuoxplanSource] org=${orgId}: ${result.error}, not advancing watermarks`);
  }

  return result;
}

module.exports = {
  ingestQuoxplan,
  renderStreamDoc,
  renderPlanDoc,
  renderNoteDoc,
  watermarkKeyForStream,
  SOURCE_TYPE,
  VAULT_NAME,
  DEFAULT_ROADMAP_ID,
  DEFAULT_MAX_STREAMS,
  DEFAULT_MAX_ITEMS,
  _resetWarnedNoOrgForTest: () => { warnedNoOrg = false; },
};

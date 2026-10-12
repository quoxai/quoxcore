/**
 * feedMemorySource.js — The Feed's "the loop" ingester (Night-2 Pillar 1 L2,
 * docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md Tier 1 #1: `memory.identity_blobs`
 * + `memory.memories`).
 *
 * QuoxMemory's own distilled knowledge — beliefs/facts/observations
 * (`/api/memory`) and per-user identity blobs (profile, projects,
 * narratives, syntheses, trends — `/api/memory/identity/:namespace`) — is
 * a Tier-1, near-zero-transform, highest-ROI source for Qortex. Both live
 * in the memory service's OWN SQLite db, in the `memory` container — this
 * collector never touches that db directly (unlike feedDbSource.js's
 * db-adapter framework, which is scoped to collector-local db files only,
 * per that module's own header). Every read here goes over the memory
 * service's HTTP API, X-Service-Key + X-Org-Id (+X-User-Id) authenticated
 * — same contract responseEnrichment.js / memoryConsolidationScheduler.js /
 * reflectionMiningScheduler.js already use against this same service.
 *
 * LOOP-SAFETY (critical — read before touching the memory-fetch path):
 * QuoxDream (services/quoxbrain/lib/quoxDream.js) already writes its own
 * distilled beliefs BACK into this same memories table (`tags: ['quoxdream'],
 * agent_id` not set but `tags` always carries the marker) as part of the
 * brain -> memory loop. If this ingester fed those straight back into
 * Qortex it would create a brain -> memory -> brain cycle, amplifying the
 * same content forever. isQuoxDreamMemory() filters any memory carrying
 * `tags: ['quoxdream']` or `agent_id: 'quoxdream'` out of every ingest
 * before it's ever rendered or pushed. NOTE: `provenance: 'model_inference'`
 * is NOT used as a skip signal on its own — it is memoryStore.js's DEFAULT
 * value for every memory write regardless of origin (see createMemory()'s
 * `provenance = 'model_inference'` default parameter), so filtering on it
 * alone would silently drop the majority of legitimate user/agent memories,
 * not just QuoxDream's. Flagged back to the plan owner — see this repo's
 * L2 build report.
 *
 * Identity blobs are NOT loop-filtered: nothing in this codebase writes to
 * `/api/memory/identity/:namespace` from a model-inference path today (only
 * the browser-facing identity sync + ReflectionMining-adjacent consolidation
 * paths write there), so there is no existing brain->identity->brain cycle
 * to guard against.
 *
 * Identity blobs are strictly per (org, user, namespace) — unlike the other
 * Feed sources' org-wide reads, `deps.userId` is REQUIRED for this source to
 * produce any identity docs (and for the memory list, since
 * memoryStore.listMemories() also scopes by org_id AND user_id — there is no
 * org-wide memory list route). Mirrors feedFleetSource.js/
 * feedTranscriptSource.js's `deps.userId` threading, just load-bearing here
 * instead of optional.
 */

'use strict';

const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const feedBatchSupport = require('./feedBatchSupport.js');

const SOURCE_TYPE = 'memory';
const VAULT_NAME = 'QuoxMemory';

// Same MEMORY_HOST/MEMORY_PORT convention as reflectionMiningScheduler.js /
// memoryConsolidationScheduler.js / responseEnrichment.js / memoryImplant.js.
const DEFAULT_MEMORY_URL = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const DEFAULT_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

const DEFAULT_MAX_ITEMS = 50;
// BRAIN2-W5 027: the listing is paged (limit+offset) until exhausted, so the
// per-tick maxItems bounds WORK, not what the feed can SEE. Bounded by pages.
const LIST_PAGE_SIZE = 200;
const MAX_LIST_PAGES = 50;

// Tier-1 high-value distilled identity namespaces
// (docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md "#1 untapped" row) — the
// system's own synthesized-knowledge namespaces, not the raw/mechanical ones
// (working_set, reflection_state, importance_evolution, alerts, style).
const IDENTITY_NAMESPACES = ['syntheses', 'narratives', 'trends', 'projects', 'profile'];

function truncate(text, max) {
  const str = String(text == null ? '' : text);
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n…[truncated]`;
}

function memoryHeaders(orgId, userId, serviceKey) {
  const h = { 'X-Org-Id': orgId };
  if (serviceKey) h['X-Service-Key'] = serviceKey;
  if (userId) h['X-User-Id'] = userId;
  return h;
}

/**
 * True if `memory` was written by QuoxDream's own brain -> memory
 * consolidation path (services/quoxbrain/lib/quoxDream.js) — see module
 * header's LOOP-SAFETY note for why this is checked on tags/agent_id and
 * deliberately NOT on provenance.
 */
function isQuoxDreamMemory(memory) {
  const tags = Array.isArray(memory?.tags) ? memory.tags : [];
  if (tags.includes('quoxdream')) return true;
  if (memory?.agent_id === 'quoxdream') return true;
  return false;
}

/**
 * Renders one memory row into a push-ingest document. Light frontmatter
 * (type/importance/confidence) ahead of the raw content — near-zero
 * transform per the plan ("1:1 note per (user,namespace)" applies equally
 * here: 1:1 note per memory).
 */
function renderMemoryDoc(memory) {
  const occurredAt = memory.updated_at || memory.created_at || new Date().toISOString();
  const frontmatter = [
    `type: ${memory.memory_type || 'unknown'}`,
    `importance: ${memory.importance || 'unknown'}`,
    `confidence: ${memory.confidence != null ? memory.confidence : 'unknown'}`,
  ].join('\n');
  const content = String(memory.content == null ? '' : memory.content);
  const title = truncate(content, 80).replace(/\s+/g, ' ').trim() || memory.id;

  return {
    relPath: `memory/${memory.id}.md`,
    content: `---\n${frontmatter}\n---\n\n${content}`,
    title,
    kind: 'memory',
    sourceType: SOURCE_TYPE,
    occurredAt,
    // ONE-BRAIN A1 (QuoxPlan #493): this doc IS memories row `memory.id` —
    // stamp the canonical origin at write time so Qortex can dedup at
    // recall instead of relying solely on the boot-time rel_path backfill.
    originStore: 'memory',
    originId: memory.id,
  };
}

/**
 * Renders one identity namespace blob into a push-ingest document. These
 * are already-distilled documents (profile/syntheses/narratives/trends/
 * projects) — near-zero transform: strings pass through verbatim, anything
 * else (object/array) is pretty-printed as a fenced JSON block.
 */
function renderIdentityDoc(namespace, blob) {
  const data = blob?.data;
  const body = typeof data === 'string'
    ? data
    : '```json\n' + JSON.stringify(data, null, 2) + '\n```';

  return {
    relPath: `memory/identity/${namespace}.md`,
    content: `# ${namespace}\n\n${body}`,
    title: namespace,
    kind: 'identity_blob',
    sourceType: SOURCE_TYPE,
    occurredAt: blob?.updated_at || new Date().toISOString(),
  };
}

/**
 * Default memory-list client: GET /api/memory (bounded, org+user scoped —
 * see module header). Overridable via deps.fetchMemoriesFn (tests never
 * touch the network).
 */
async function defaultFetchMemories(orgId, { userId, limit, offset = 0, memoryUrl, serviceKey, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${memoryUrl}/api/memory?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`, {
    headers: memoryHeaders(orgId, userId, serviceKey),
  });
  if (!res.ok) throw new Error(`GET /api/memory failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.memories) ? body.memories : [];
}

/**
 * Pages the whole memory listing. `complete` is true only when the listing
 * was read to its end (a short page, or a page with nothing new), so callers
 * may treat it as a full snapshot (deletion reconciliation).
 * @returns {Promise<{memories: Array, complete: boolean}>}
 */
async function fetchAllMemories(fetchMemoriesFn, orgId, ctx) {
  const memories = [];
  const seenIds = new Set();
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const rows = (await fetchMemoriesFn(orgId, { ...ctx, limit: LIST_PAGE_SIZE, offset: page * LIST_PAGE_SIZE })) || [];
    let fresh = 0;
    for (const m of rows) {
      const id = m?.id;
      if (id != null && seenIds.has(id)) continue;
      if (id != null) seenIds.add(id);
      memories.push(m);
      fresh++;
    }
    if (rows.length < LIST_PAGE_SIZE || fresh === 0) return { memories, complete: true };
  }
  console.error(`[FeedMemorySource] org=${orgId}: listing hit the ${MAX_LIST_PAGES}-page cap, snapshot incomplete (no tombstones this tick)`);
  return { memories, complete: false };
}

/**
 * Default identity client: GET /api/memory/identity/:namespace. Overridable
 * via deps.fetchIdentityFn.
 */
async function defaultFetchIdentity(orgId, namespace, { userId, memoryUrl, serviceKey, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${memoryUrl}/api/memory/identity/${encodeURIComponent(namespace)}`, {
    headers: memoryHeaders(orgId, userId, serviceKey),
  });
  if (!res.ok) throw new Error(`GET /api/memory/identity/${namespace} failed HTTP ${res.status}`);
  return res.json().catch(() => null); // { namespace, data, updated_at }
}

/**
 * Ingests QuoxMemory's own distilled knowledge (memories + high-value
 * identity namespaces) into the "QuoxMemory" push vault, incrementally
 * (memories watermarked, identity blobs re-pulled every tick since they're
 * a handful of small already-distilled docs, idempotent via content-hash on
 * the brain's ingest side).
 *
 * @param {string} orgId
 * @param {{config?: {namespaces?: string[], maxItems?: number}, maxItems?: number, dryRun?: boolean}} [opts]
 * @param {{
 *   fetchMemoriesFn?: Function,      // (orgId, {userId,limit,memoryUrl,serviceKey,fetchImpl}) => Array<memory> (tests)
 *   fetchIdentityFn?: Function,      // (orgId, namespace, {userId,memoryUrl,serviceKey,fetchImpl}) => {namespace,data,updated_at}|null (tests)
 *   getWatermarkFn?: Function,       // (orgId) => string|null
 *   setWatermarkFn?: Function,       // (orgId, ts) => void
 *   ensurePushVaultFn?: Function,    // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,      // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,            // forwarded to the brain client + default memory clients (test injection)
 *   memoryUrl?: string,              // overrides DEFAULT_MEMORY_URL (tests)
 *   serviceKey?: string,             // overrides DEFAULT_SERVICE_KEY (tests)
 *   userId?: string,                 // REQUIRED for any identity/memory results — see module header
 *   dbPath?: string,                 // forwarded to feedWatermark (tests)
 * }} [deps]
 * @returns {Promise<{memoriesRead: number, namespacesRead: number, docsPushed: number, error: string|null}>}
 */
async function ingestMemoryTarget(orgId, opts = {}, deps = {}, target = targetFor(deps.userId)) {
  const result = { memoriesRead: 0, namespacesRead: 0, docsPushed: 0, error: null };

  const {
    fetchMemoriesFn = defaultFetchMemories,
    fetchIdentityFn = defaultFetchIdentity,
    getWatermarkFn = (org, key) => feedWatermark.getWatermark(org, key, { dbPath: deps.dbPath }),
    setWatermarkFn = (org, ts, key) => feedWatermark.setWatermark(org, key, ts, { dbPath: deps.dbPath }),
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
    memoryUrl = DEFAULT_MEMORY_URL,
    serviceKey = DEFAULT_SERVICE_KEY,
  } = deps;
  const userId = target.userId;
  const wmKey = target.key;

  const config = opts.config || null;
  const maxItems = config?.maxItems || opts.maxItems || DEFAULT_MAX_ITEMS;
  const namespaces = Array.isArray(config?.namespaces) && config.namespaces.length > 0
    ? config.namespaces
    : IDENTITY_NAMESPACES;
  const dryRun = !!opts.dryRun;

  let storedWatermark = null;
  try {
    storedWatermark = await getWatermarkFn(orgId, wmKey);
  } catch (err) {
    console.error(`[FeedMemorySource] org=${orgId}: watermark read failed, treating as no watermark — ${err.message}`);
  }

  const docs = [];
  let newWatermark = storedWatermark || null;

  // --- Memories: paged listing, compound (ts,id) cursor, loop-safety filter ---
  let snapshot = null; // relPaths currently at the source, only when the listing is complete
  try {
    const { memories, complete } = await fetchAllMemories(fetchMemoriesFn, orgId, { userId, memoryUrl, serviceKey, fetchImpl });
    const live = memories.filter((m) => !isQuoxDreamMemory(m));
    if (complete) snapshot = live.filter((m) => m?.id != null).map((m) => `memory/${m.id}.md`);
    const allEligible = live
      .map((m) => ({ memory: m, ts: m.updated_at || m.created_at, id: String(m.id ?? '') }))
      .filter(({ ts, id }) => ts && feedWatermark.isAfterCursor(storedWatermark, ts, id))
      .sort(feedWatermark.compareByTsId);
    const eligible = allEligible.slice(0, maxItems);
    const remaining = allEligible.slice(maxItems).map(({ ts, id }) => ({ ts, id }));
    const processed = [];

    for (const { memory, ts, id } of eligible) {
      docs.push(renderMemoryDoc(memory));
      result.memoriesRead++;
      processed.push({ ts, id });
    }
    newWatermark = feedWatermark.nextCursor(processed, remaining) || newWatermark;
  } catch (err) {
    result.error = `list memories failed — ${err.message}`;
    console.error(`[FeedMemorySource] org=${orgId}: ${result.error}`);
  }

  // --- Identity namespaces: one blob per namespace, best-effort per namespace ---
  for (const namespace of namespaces) {
    try {
      const blob = await fetchIdentityFn(orgId, namespace, { userId, memoryUrl, serviceKey, fetchImpl });
      if (blob && blob.data !== null && blob.data !== undefined) {
        docs.push(renderIdentityDoc(namespace, blob));
        result.namespacesRead++;
      }
    } catch (err) {
      console.error(`[FeedMemorySource] org=${orgId} namespace=${namespace}: skipping — ${err.message}`);
    }
  }

  if (dryRun) return result; // tallies memoriesRead/namespacesRead, pushes/advances nothing

  const ensureVault = async () => ensurePushVaultFn(orgId, VAULT_NAME, { scope: target.scope, userId, fetchImpl });

  try {
    if (docs.length > 0) {
      const vaultId = await ensureVault();
      if (!vaultId) {
        result.error = 'ensurePushVault returned no vaultId';
        console.error(`[FeedMemorySource] org=${orgId}: ${result.error} — not advancing watermark`);
        return result;
      }

      const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
      if (pushResult?.error) {
        result.error = pushResult.error;
        console.error(`[FeedMemorySource] org=${orgId}: push failed — ${pushResult.error} — not advancing watermark`);
        return result;
      }

      result.docsPushed = docs.length;

      if (newWatermark && newWatermark !== storedWatermark) {
        try {
          await setWatermarkFn(orgId, newWatermark, wmKey);
        } catch (err) {
          console.error(`[FeedMemorySource] org=${orgId}: watermark write failed — ${err.message}`);
        }
      }
    }

    // BRAIN2-W5 024: a complete, error-free listing is a full snapshot, so
    // memories that vanished (deleted / invalidated) get explicit tombstones.
    if (snapshot && !result.error) {
      const store = feedBatchSupport.resolveStateStore(deps, !!deps.getWatermarkFn);
      const r = await feedBatchSupport.reconcileDeletions({
        store, orgId, key: wmKey, seen: snapshot, complete: true, ensureVault,
        pushDeletionsFn: deps.pushDeletionsFn || brainFeedClient.pushDeletions, pushOpts: { userId, fetchImpl },
      });
      if (r.deleted > 0) result.deleted = r.deleted;
      if (r.error) { result.error = r.error; console.error(`[FeedMemorySource] org=${orgId}: ${r.error}`); }
    }
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedMemorySource] org=${orgId}: ${result.error} — not advancing watermark`);
  }

  return result;
}

/**
 * BRAIN2-W5 031: where a memory owner's notes go. The memory service's
 * 'service' user (no X-User-Id) holds the org's own memories -> org-scope
 * vault. Any real user's memories -> a USER-scope vault owned by that user, so
 * private memories are never widened to the org. Cursor/manifest are per target.
 */
function targetFor(userId) {
  if (!userId || userId === 'service') return { userId: undefined, scope: 'org', key: SOURCE_TYPE };
  return { userId, scope: 'user', key: `${SOURCE_TYPE}:u:${userId}` };
}

/** Default org-user enumeration: GET /api/memory/org-users (service key only). */
async function defaultFetchOrgUsers(orgId, { memoryUrl, serviceKey, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${memoryUrl}/api/memory/org-users`, { headers: memoryHeaders(orgId, undefined, serviceKey) });
  if (!res.ok) throw new Error(`GET /api/memory/org-users failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.users) ? body.users : [];
}

/**
 * Entry point. With an explicit deps.userId: that user's memories, user-scoped.
 * Scheduled (no userId): the org (service-user) memories into the org vault
 * PLUS every user that owns memories in the org, each into their own
 * user-scope vault. Enumeration only runs against the real memory service
 * (or an injected deps.fetchUsersFn); if it fails, the org target still runs
 * and the failure is reported.
 */
async function ingestMemory(orgId, opts = {}, deps = {}) {
  if (deps.userId) return ingestMemoryTarget(orgId, opts, deps, targetFor(deps.userId));

  const targets = [targetFor(null)];
  let enumError = null;
  if (deps.fetchUsersFn || !deps.fetchMemoriesFn) {
    try {
      const fetchUsersFn = deps.fetchUsersFn || defaultFetchOrgUsers;
      const users = (await fetchUsersFn(orgId, { memoryUrl: deps.memoryUrl || DEFAULT_MEMORY_URL, serviceKey: deps.serviceKey ?? DEFAULT_SERVICE_KEY, fetchImpl: deps.fetchImpl })) || [];
      for (const u of users) if (u && u !== 'service') targets.push(targetFor(u));
    } catch (err) {
      enumError = `list memory users failed — ${err.message}`;
      console.error(`[FeedMemorySource] org=${orgId}: ${enumError}`);
    }
  }

  const total = { memoriesRead: 0, namespacesRead: 0, docsPushed: 0, error: null };
  for (const t of targets) {
    const r = await ingestMemoryTarget(orgId, opts, deps, t);
    total.memoriesRead += r.memoriesRead;
    total.namespacesRead += r.namespacesRead;
    total.docsPushed += r.docsPushed;
    if (r.deleted) total.deleted = (total.deleted || 0) + r.deleted;
    if (r.error && !total.error) total.error = r.error;
  }
  if (enumError && !total.error) total.error = enumError;
  return total;
}

module.exports = {
  ingestMemory,
  renderMemoryDoc,
  renderIdentityDoc,
  isQuoxDreamMemory,
  truncate,
  SOURCE_TYPE,
  VAULT_NAME,
  IDENTITY_NAMESPACES,
  DEFAULT_MAX_ITEMS,
};

/**
 * ONE-BRAIN Phase A2 (QuoxPlan #493) — the `recall` tool's backend. Runs the
 * three existing recall surfaces (memory_search → memory :3103,
 * quoxbrain_search → brain :3106, execution_intelligence search_wisdom →
 * tasks :3104) concurrently, normalizes each surface's hits into a common
 * shape, and hands them to recallMerge.js to dedup/rank into ONE unified
 * answer set. Best-effort per surface: one surface being down never fails
 * the other two — see `surfaces` on the return value for per-surface honesty
 * (ok/reason), same discipline as quoxbrain_search's unavailable-vs-empty
 * distinction.
 */

'use strict';

const { mergeRecallResults } = require('./recallMerge.js');
const { registerRetrieval, lookupHandles } = require('./brainCitationTrace.js');
const { citeInstruction } = require('./brainCiteInstruction.js');

const MEMORY_URL = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`;
const BRAIN_URL = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const TASKS_URL = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const TIMEOUT_MS = 10000;
// BRAIN2-PRODUCT P3c (toolExecutors/quoxbrain.js): a cold hybrid /brain/search
// (query embed round-trip + first-fill of the dense vector cache) measured
// 7-62s in production. BRAIN_TIMEOUT_MS was 25000, so brain-inclusive recall
// merges timed out roughly 2/3 of the time (ONE-BRAIN A2, QuoxPlan #493).
// 45000 is a stopgap to make brain-inclusive merges reliably provable; the
// real fix is quoxbrain /brain/search perf, tracked separately, out of scope
// here.
const BRAIN_TIMEOUT_MS = 45000;
const DEFAULT_LIMIT = 8;
const GROUNDING_CHARS = 1200;
const WEAK_BRAIN_MERGE_WEIGHT = 0.6;
const FULL_NOTE_MAX_CHARS = 8000; // CORTEX-BENCH: quoxbrain caps whole-note bodies at 8000; covers ~90% of memory notes (6000 still truncated long decision notes)
const FULL_NOTE_TOP_N = 3;
// All abstained-brain candidates are kept (flagged weak): the LLM rerank veto
// is a coin-flip on borderline questions, and the first 3 of the un-reranked
// order often missed the note the reranker would have put first.
const WEAK_BRAIN_CANDIDATES = 24;
const WEAK_BRAIN_WEIGHT = 0.35;
const BRAIN_PASSAGE_CHARS = 1200;
const AGENT_EMBED_TIMEOUT_MS = 4000;
// A rerank still pending after this is stuck behind collector congestion;
// quoxbrain keeps the fused order (CORTEX-BENCH latency tail).
const RECALL_RERANK_BUDGET_MS = 3500;
// Tiered recall in ONE query: human prose (notes, memories) up, every other
// kind (commits, transcripts, code, DB-feed rows named after their table) down
// via quoxbrain's '*' default prior. Swept on dev2+dev3 (60 items): hit@3
// 78% -> 85%, MRR .766 -> .847, faster (a second curated query, pass 29,
// doubled brain load and was reverted).
// ONE-BRAIN CX1 (2026-10-09): softened to 1.2/1.2/1.0. The 0.4 demotion was
// chosen while reranks timed out under event-loop stalls; with reranking
// healthy it bought nothing on the visible sets (brain-level MRR .918 -> .921
// at 1.2/1.2/1.0) and it penalised commits, transcripts and plans by design,
// which the independent blind sets (about 40% non-note kinds) ask about.
// Source code alone is demoted (0.6): RepoBrain owns code questions, Qortex
// owns knowledge. Without it a spec file NAMED after a thing ("hashicorp_nomad")
// grounded "what did we decide about Nomad?" at high confidence (dev u01,
// 2026-10-09). Visible brain-level MRR .921 -> .922.
const RECALL_KIND_PRIORS = Object.freeze({ note: 1.2, memory: 1.2, code: 0.6, '*': 1 });
const MAX_LIMIT = 30;

function normalizeMemoryItem(m) {
  return {
    surface: 'memory',
    id: String(m.id),
    text: m.content || '',
    score: null,
    updatedAt: m.created_at || null,
    origin: null,
    // The memory service's /api/memory/search endpoint returns raw DB rows
    // (column name memory_type), not the memory_search tool's mapped shape
    // (type) — see ONE-BRAIN A2 fix comment on searchMemorySurface below.
    meta: { type: m.memory_type || m.type, importance: m.importance, tags: m.tags, created_at: m.created_at },
  };
}

function normalizeWisdomItem(w) {
  return {
    surface: 'wisdom',
    id: String(w.id),
    text: w.lesson || w.pattern_name || '',
    score: typeof w.confidence === 'number' ? w.confidence : null,
    updatedAt: w.updated_at || w.created_at || null,
    origin: null,
    meta: { pattern_name: w.pattern_name, confidence: w.confidence, occurrence_count: w.occurrence_count },
  };
}

function normalizeBrainItem(r) {
  const origin = r.originStore && r.originId != null ? { store: r.originStore, id: String(r.originId) } : null;
  return {
    surface: 'brain',
    id: String(r.noteId || r.chunkId || ''),
    // CORTEX-BENCH pass 8: carry the matched PASSAGE (bounded), not the
    // 320-char highlight. On an independent question set the right note was
    // often ranked first while the answer sat past the highlight, so Cortex
    // found the note but could not answer without a second read.
    text: (typeof r.text === 'string' && r.text.trim()
      ? r.text.replace(/\s+\n/g, '\n').trim().slice(0, BRAIN_PASSAGE_CHARS)
      : String(r.snippet || r.title || '').replace(/[[\]]/g, '').trim()),
    passage: typeof r.text === 'string' && r.text ? r.text : undefined,
    score: typeof r.score === 'number' ? r.score : null,
    updatedAt: r.updatedAt || r.occurredAt || null,
    origin,
    meta: { title: r.title, headingPath: r.headingPath, noteId: r.noteId, charStart: r.charStart, charEnd: r.charEnd, kind: r.kind, relPath: r.relPath, vaultId: r.vaultId, ...(typeof r.noteBody === 'string' ? { noteBody: r.noteBody, noteBodyPartial: r.noteBodyPartial === true } : {}) },
  };
}

// CORTEX-BENCH pass 1: a surface's own order is its best ranking signal (the
// brain's is set after hybrid fusion + rerank). Stamp 1-based ranks so the
// merge fuses ranks instead of comparing incompatible raw scores.
function withRanks(items) {
  return items.map((it, i) => ({ ...it, rank: i + 1 }));
}

// Vault id -> display name, so a recall hit says WHERE it came from
// ("Agent Memory", "QuoxPlan") instead of an opaque id. Cached per org/user
// for 5 minutes; best-effort (a failed lookup just omits the name).
const VAULT_NAME_TTL_MS = 5 * 60 * 1000;
const vaultNameCache = new Map();
async function vaultNames(ctx) {
  const key = `${ctx?.orgId || 'default'}:${ctx?.userId || ''}`;
  const hit = vaultNameCache.get(key);
  if (hit && Date.now() - hit.at < VAULT_NAME_TTL_MS) return hit.map;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch(`${BRAIN_URL}/vaults`, {
      headers: {
        'X-Service-Key': SERVICE_KEY,
        'X-Org-Id': ctx?.orgId || 'default',
        ...(ctx?.userId ? { 'X-User-Id': ctx.userId } : {}),
      },
      signal: controller.signal,
    });
    if (!resp || !resp.ok) return new Map();
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data.vaults || []);
    const map = new Map(list.map((v) => [String(v.id), v.name]));
    vaultNameCache.set(key, { at: Date.now(), map });
    return map;
  } catch (_) {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

// ONE-BRAIN A2 FIX (QuoxPlan #493): this used to call the in-process
// handleMemoryTool('memory_search', ...) tool handler, whose recall path was
// independently verified to return {results: []} even when the memory
// service had matching org-scoped data (routed through a disabled
// semantic/embedding recall path — "[QuoxChat] embedText: no embedding key
// ... RAG disabled" in logs). That meant recall's core purpose — memory <->
// brain dedup — never fired. Query the memory service's FTS endpoint
// directly over HTTP instead, the same pattern searchWisdomSurface already
// uses for tasks, and the endpoint independently proven (curl) to return
// real org-scoped memories.
async function searchMemorySurface(query, limit, ctx) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': SERVICE_KEY,
    'X-Org-Id': ctx?.orgId || 'default',
    'X-User-Id': ctx?.userId || '',
  };
  const controller = new AbortController();
  // Plain FTS5 query, same short budget as the wisdom leg.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('limit', String(limit));
    const resp = await fetch(`${MEMORY_URL}/api/memory/search?${params}`, { headers, signal: controller.signal });
    if (!resp || !resp.ok) {
      return { ok: false, reason: resp ? `http_${resp.status}` : 'fetch_failed', items: [] };
    }
    const data = await resp.json();
    return { ok: true, items: (data.results || []).map(normalizeMemoryItem) };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return { ok: false, reason: aborted ? 'timeout' : (err?.message || 'fetch_failed'), items: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWisdomSurface(query, limit, ctx) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Org-Id': ctx?.orgId || 'default',
    'X-User-Id': ctx?.userId || '',
    'X-Service-Key': SERVICE_KEY,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('limit', String(limit));
    const resp = await fetch(`${TASKS_URL}/api/wisdom?${params}`, { headers, signal: controller.signal });
    if (!resp || !resp.ok) {
      return { ok: false, reason: resp ? `http_${resp.status}` : 'fetch_failed', items: [] };
    }
    const data = await resp.json();
    return { ok: true, items: (data.wisdom || []).map(normalizeWisdomItem) };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return { ok: false, reason: aborted ? 'timeout' : 'fetch_failed', items: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function searchBrainSurface(query, limit, ctx, controller = new AbortController(), opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': SERVICE_KEY,
    'X-Org-Id': ctx?.orgId || 'default',
    'X-Quox-Source': 'agent',
    ...(ctx?.userId ? { 'X-User-Id': ctx.userId } : {}),
  };
  const timer = setTimeout(() => controller.abort(), BRAIN_TIMEOUT_MS);
  // CORTEX-BENCH: a connection-level failure (no HTTP status: reset socket,
  // stale keep-alive, body cut off) dropped the whole brain leg and left
  // memory observations as the answer. One retry; the reason now carries the
  // underlying error code so the next one explains itself.
  const doFetch = () => fetch(`${BRAIN_URL}/brain/search`, {
      method: 'POST',
      headers,
      // CORTEX-BENCH pass 2: recall answers "what do I know / what did we
      // decide" questions, so curated notes and memories outrank raw session
      // transcripts and commit messages (quoxbrain multiplies the fused score
      // by this per-kind prior; service-key callers only). Swept on the dev
      // set: MRR 0.858 -> 0.890, hit@1 80% -> 88% (held-out set untouched).
      // The interactive 1.5s query-embed bound silently served word-match-only
      // results under box load (16 of ~70 bench queries in one run). Recall is
      // an agent path where an answer beats a fast miss: allow quoxbrain's
      // agent maximum (MAX_QUERY_EMBED_TIMEOUT_MS) so the semantic leg lands.
      body: JSON.stringify({ query, limit, includeText: true, kindPriors: RECALL_KIND_PRIORS, embedTimeoutMs: AGENT_EMBED_TIMEOUT_MS, fullNoteMaxChars: FULL_NOTE_MAX_CHARS, fullNoteTopN: 5, rerankTimeoutMs: RECALL_RERANK_BUDGET_MS, ...(opts.expand ? { expand: true } : {}) }),
      signal: controller.signal,
    });
  const t0 = Date.now();
  let lastErr = null;
  try {
    let resp = null; let data = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      try {
        resp = await doFetch();
        if (!resp || !resp.ok) {
          return { ok: false, reason: resp ? `http_${resp.status}` : 'fetch_failed', items: [] };
        }
        data = await resp.json();
      } catch (err) {
        const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
        if (aborted || controller.signal.aborted || Date.now() - t0 > BRAIN_TIMEOUT_MS / 2) throw err;
        lastErr = err;
      }
    }
    if (!data) throw lastErr || new Error('fetch_failed');
    // BRAIN2-W2 2: quoxbrain abstained (hits irrelevant to the question): the
    // brain leg contributes nothing, so nothing irrelevant is merged or cited.
    if (data.insufficient === true || data.relevance?.insufficient === true) {
      // CORTEX-BENCH pass 9: keep the top few as WEAK candidates (never cited,
      // never raise confidence) so a paraphrased question still shows the
      // closest note instead of a blank, under a low-confidence answer.
      const weakItems = (data.results || []).slice(0, WEAK_BRAIN_CANDIDATES).map(normalizeBrainItem).map((it) => ({ ...it, weak: true, weight: WEAK_BRAIN_WEIGHT }));
      return { ok: true, insufficient: true, items: [], weakItems, dense: data.relevance?.dense ?? null };
    }
    return { ok: true, items: (data.results || []).map(normalizeBrainItem), dense: data.relevance?.dense ?? null };
  } catch (err) {
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    const detail = err?.cause?.code || err?.code || err?.message || '';
    return { ok: false, reason: controller.graceAborted ? 'slower_than_grace' : (aborted ? 'timeout' : `fetch_failed${detail ? `:${String(detail).slice(0, 60)}` : ''}`), items: [] };
  } finally {
    clearTimeout(timer);
  }
}

function brainGraceMs() {
  const n = parseInt(process.env.RECALL_BRAIN_GRACE_MS, 10);
  // CORTEX-BENCH pass 12: 12s dropped real brain answers under load (the
  // brain's own worst case is ~15s: 4s embed + 3.5s weak-sparse extra + 6s
  // rerank + FTS), leaving a lone memory row as the answer. 20s keeps them.
  return Number.isFinite(n) && n >= 0 ? n : 20000;
}

/**
 * BRAIN2-W7 E 111: when memory/wisdom already produced hits, the brain gets only
 * a grace window (RECALL_BRAIN_GRACE_MS, default 12000) before recall answers
 * without it. The brain surface then reports ok:false reason 'slower_than_grace',
 * so the omission is visible, never silent. With no fast hits, recall waits
 * for the brain's full timeout as before.
 */
async function searchBrainWithGrace(query, limit, ctx, fastSettled) {
  const controller = new AbortController();
  const brainP = searchBrainSurface(query, limit, ctx, controller);
  const grace = brainGraceMs();
  const fast = await fastSettled;
  const fastHits = fast.some((r) => r.status === 'fulfilled' && r.value && r.value.ok && r.value.items.length > 0);
  if (!fastHits) return brainP;
  let timer;
  const graceP = new Promise((resolve) => {
    timer = setTimeout(() => { controller.graceAborted = true; controller.abort(); resolve(null); }, grace);
  });
  const winner = await Promise.race([brainP, graceP]);
  clearTimeout(timer);
  return winner || brainP;
}

/**
 * Register the brain-sourced results that survived the merge for citation
 * tracing (same corr key chain as toolExecutors/quoxbrain.js) and stamp each
 * with an [R<n>] handle. Returns the instruction line, or '' when there is no
 * session key / nothing to trace. Best-effort: never throws into recall.
 */
function attachCitationHandles(merged, brainItems, ctx) {
  try {
    const corrKey = ctx?.corr || ctx?.conversationId || ctx?.session_id;
    if (!corrKey || !brainItems.length) return '';
    const byId = new Map();
    for (const b of brainItems) {
      byId.set(`brain:${b.id}`, b);
      if (b.origin) byId.set(`${b.origin.store}:${b.origin.id}`, b);
    }
    const picked = [];
    for (const r of merged) {
      if (!Array.isArray(r.surfaces) || !r.surfaces.includes('brain')) continue;
      const b = byId.get(`${r.canonical.store}:${r.canonical.id}`) || byId.get(`brain:${r.canonical.id}`);
      if (b) picked.push({ r, b });
    }
    if (!picked.length) return '';
    const refs = picked.map(({ b }) => ({
      noteId: b.meta?.noteId || b.id,
      title: b.meta?.title || '',
      relPath: b.meta?.relPath || '',
      snippet: b.text,
      passage: b.passage,
      score: b.score == null ? undefined : b.score,
      // BRAIN2-W5 116: keep the chunk's exact span instead of discarding it.
      charStart: b.meta?.charStart,
      charEnd: b.meta?.charEnd,
    }));
    registerRetrieval(corrKey, {
      orgId: ctx?.orgId, userId: ctx?.userId, agentId: ctx?.agentId,
      status: 'hits', handlePrefix: 'R', refs,
    });
    const handles = lookupHandles(corrKey, refs, { orgId: ctx?.orgId, userId: ctx?.userId });
    let any = false;
    picked.forEach(({ r }, i) => { if (handles[i]) { r.handle = handles[i]; any = true; } });
    return any ? citeInstruction('R') : '';
  } catch (_) {
    return '';
  }
}

function registerBrainLegStatus(brain, ctx) {
  try {
    const corrKey = ctx?.corr || ctx?.conversationId || ctx?.session_id;
    if (!corrKey) return;
    registerRetrieval(corrKey, {
      orgId: ctx?.orgId, userId: ctx?.userId, agentId: ctx?.agentId, refs: [],
      status: brain.ok ? 'empty' : 'unavailable',
      ...(brain.ok ? {} : { reason: brain.reason }),
    });
  } catch (_) { /* tracing never breaks recall */ }
}

/**
 * recallSearch — the unified `recall` tool's backend. Org-scoped via ctx.
 * @param {{query: string, limit?: number}} input
 * @param {{orgId: string, userId?: string, agentId?: string, token?: string|null}} ctx
 */
// CORTEX-BENCH pass 1 (honesty): an absolute confidence on the whole answer.
// The brain leg already abstains (relevance gate: dense cosine + lexical
// coverage). The memory/wisdom FTS legs have no gate and will "find" a row for
// any query, so a question about something that never happened came back as
// a confident list. Confidence:
//   none   nothing returned
//   high   the brain leg returned relevance-gated hits
//   medium memory/wisdom only, and the best hit covers most query terms
//   low    memory/wisdom only, weak term coverage: say plainly nothing solid
const STOP = new Set('a an the and or but of to in on at for by with from as is are was were be been being do does did what which who whom whose when where why how we our us i me my you your it its this that these those there here about into over under than then so if not no yes can could should would will shall may might must have has had any all some ever never just only also very much more most such per via'.split(' '));
function stemTerm(t) {
  for (const suf of ['edly', 'ing', 'ed', 'ly', 'es', 's']) if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, -suf.length);
  return t;
}
function termCoverage(query, text) {
  const terms = [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !STOP.has(w) && w.length > 1).map(stemTerm))];
  if (!terms.length) return 0;
  const hay = new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(stemTerm));
  return terms.filter((t) => hay.has(t)).length / terms.length;
}
// Entity grounding: the specific names a question asks about (capitalised or
// mixed-case words that are not sentence-initial, or words with digits:
// "Salesforce", "MongoDB", "Tokyo", "P8") must appear in what came back. A
// semantically "close" passage that never mentions the thing asked about is
// not an answer to it; that is how a question about a vendor never used
// returned eight confident-looking hits.
// Same rules as quoxbrain lib/entityGrounding.js (2026-10-11): month and day
// names are capitalised by convention, not because they name a thing.
const CALENDAR = /^(mid-)?(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)$/i;
function questionEntities(query) {
  const toks = String(query).match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) || [];
  const out = [];
  toks.forEach((t, i) => {
    const bare = t.replace(/[._-]+$/, '');
    if (bare.length < 2 || STOP.has(bare.toLowerCase()) || CALENDAR.test(bare)) return;
    const capital = /\p{Lu}/u.test(bare) && (i > 0 || /\p{Lu}/u.test(bare.slice(1)));
    if (capital || /\d/.test(bare)) out.push(bare.toLowerCase());
  });
  return [...new Set(out)];
}
// "401s" is grounded by "401", "CVEs" by "CVE" (same as quoxbrain).
function mentioned(entity, hay) {
  if (hay.includes(entity)) return true;
  const singular = entity.replace(/(es|s)$/, '');
  return singular.length >= 2 && singular !== entity && hay.includes(singular);
}
function entityGrounding(query, merged) {
  const ents = questionEntities(query);
  if (!ents.length) return null;
  // Salient text only (title + the opening of each top result): with whole
  // notes returned, a name buried deep in a long list ("hashicorp_nomad" in a
  // connector inventory) grounded questions about things that never happened.
  const hay = merged.slice(0, 3).map((r) => `${r.title || ''} ${String(r.text || '').slice(0, GROUNDING_CHARS)}`).join(' ').toLowerCase();
  const found = ents.filter((e) => mentioned(e, hay)).length;
  return { entities: ents, found, ratio: found / ents.length };
}

// CORTEX-BENCH pass 3: the memory leg is plain FTS over every memory the user
// has, most of them auto-captured chat observations. Once recall searched the
// real user's memories (attach-holder fix) those rows flooded the top of the
// answer (dev hit@3 88% -> 76%). Gate them: a memory row must cover at least
// half the question's content terms, and auto-captured observations rank below
// curated facts/decisions/preferences.
const MEMORY_TYPE_WEIGHT = { observation: 0.45, reflection: 0.5 };
function gateMemoryItems(query, items) {
  // Weak-coverage rows are kept (a paraphrased memory must not vanish) but
  // weighted so low they only surface when nothing better exists.
  return items.map((it) => {
    // Curated memory files reach recall through the brain; the memory service
    // holds mostly short auto-captured rows, so they rank below the brain's
    // top few (0.85 pushed the brain's 4th/5th hit out of the top 8).
    const base = MEMORY_TYPE_WEIGHT[it.meta?.type] ?? 0.6;
    return { ...it, weight: termCoverage(query, it.text) >= 0.5 ? base : base * 0.15 };
  });
}

// CORTEX-BENCH pass 10: the brain returns the best-matching CHUNK of a note,
// and for the right note the answer was often in a different chunk (found
// the incident, missed the cause). For the top results, a short note (most
// memories, decisions, incidents) is returned whole. Best-effort, bounded,
// concurrent; any failure keeps the passage.
async function expandShortNotes(merged, ctx, brainItems = []) {
  // Bodies the brain already returned with the search (no extra round trip).
  // A long note arrives as an excerpt (head + best-matching chunks, gaps
  // marked): it replaces the single passage but is not labelled whole.
  const bodies = new Map(brainItems.filter((b) => b.meta?.noteBody).map((b) => [String(b.meta.noteId || b.id), b.meta]));
  for (const r of merged.slice(0, FULL_NOTE_TOP_N)) {
    const m = r.noteId && bodies.get(String(r.noteId));
    if (m && m.noteBody.trim()) {
      r.text = m.noteBody.trim();
      if (m.noteBodyPartial) r.excerpt = true; else r.fullNote = true;
    }
  }
  const targets = merged.slice(0, FULL_NOTE_TOP_N).filter((r) => r.noteId && !r.fullNote && !bodies.size);
  if (!targets.length) return;
  const headers = {
    'X-Service-Key': SERVICE_KEY,
    'X-Org-Id': ctx?.orgId || 'default',
    'X-Quox-Source': 'agent',
    ...(ctx?.userId ? { 'X-User-Id': ctx.userId } : {}),
  };
  await Promise.all(targets.map(async (r) => {
    try {
      const resp = await fetch(`${BRAIN_URL}/notes/${encodeURIComponent(r.noteId)}?range=0:${FULL_NOTE_MAX_CHARS}`, { headers, signal: AbortSignal.timeout(2500) });
      if (!resp || !resp.ok) return;
      const note = await resp.json();
      if (typeof note.body === 'string' && note.body.trim() && Number.isFinite(note.body_length) && note.body_length <= FULL_NOTE_MAX_CHARS) {
        r.text = note.body.trim();
        r.fullNote = true;
      }
    } catch (_) { /* keep the passage */ }
  }));
}

function answerConfidence(query, merged, brain) {
  if (!merged.length) return { confidence: 'none', coverage: 0 };
  const g = entityGrounding(query, merged);
  if (g && g.found === 0) return { confidence: 'low', coverage: 0, ungrounded: g.entities };
  // A question naming several specific things ("why did we drop PostgreSQL
  // for MongoDB") is not answered by results that mention only half of them.
  if (g && g.entities.length >= 2 && g.ratio <= 0.5) {
    const hay = merged.slice(0, 3).map((r) => `${r.title || ''} ${r.text || ''} ${r.snippet || ''}`).join(' ').toLowerCase();
    return { confidence: 'low', coverage: g.ratio, ungrounded: g.entities.filter((e) => !mentioned(e, hay)) };
  }
  if (brain.items.length && !brain.insufficient) return { confidence: g && g.ratio < 1 ? 'medium' : 'high', coverage: null };
  // Weak brain candidates (the brain abstained) never raise confidence.
  const solid = merged.filter((r) => !r.weak);
  if (!solid.length) return { confidence: 'low', coverage: 0 };
  const cov = Math.max(...solid.slice(0, 3).map((r) => termCoverage(query, `${r.title || ''} ${r.text || ''}`)));
  return { confidence: cov >= 0.6 ? 'medium' : 'low', coverage: Math.round(cov * 100) / 100 };
}

async function recallSearch(input, ctx) {
  const query = input?.query;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { success: false, error: 'query is required and must be a non-empty string' };
  }
  const limit = Math.min(Math.max(parseInt(input?.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  // Widen the per-surface pool beyond `limit` so dedup has room to collapse
  // duplicates without starving the final ranked set.
  const perSurfaceLimit = Math.min(limit * 3, MAX_LIMIT);

  // Per-stage timings (ms) ride along on the response so a slow recall can be
  // localised from the outside (CORTEX-BENCH speed work).
  const t0 = Date.now();
  const timings = {};
  const timed = (name, p) => p.then((v) => { timings[name] = Date.now() - t0; return v; }, (e) => { timings[name] = Date.now() - t0; throw e; });
  const fastSettled = Promise.allSettled([
    timed('memory', searchMemorySurface(query, perSurfaceLimit, ctx)),
    timed('wisdom', searchWisdomSurface(query, perSurfaceLimit, ctx)),
  ]);
  const [[memorySettled, wisdomSettled], brainSettled] = await Promise.all([
    fastSettled,
    Promise.allSettled([timed('brain', searchBrainWithGrace(query, perSurfaceLimit, ctx, fastSettled))]).then((a) => a[0]),
  ]);

  const settle = (r) => (r.status === 'fulfilled' ? r.value : { ok: false, reason: r.reason?.message || 'unknown_error', items: [] });
  const memory = settle(memorySettled);
  const wisdom = settle(wisdomSettled);
  let brain = settle(brainSettled);

  // (CORTEX-BENCH pass 26 tried an adaptive LLM-expansion second pass for weak
  // queries: held-out hit@3 unchanged, dev honesty 10 -> 7.5, slower. Removed.)

  const brainNamed = [...brain.items, ...(brain.weakItems || [])];
  if (brainNamed.length) {
    const names = await vaultNames(ctx);
    for (const b of brainNamed) if (b.meta?.vaultId && names.get(String(b.meta.vaultId))) b.meta.source = names.get(String(b.meta.vaultId));
  }
  // CORTEX-BENCH pass 10: when the brain abstains on a paraphrased question
  // its top hit is very often still the right note (independent set: 5 of 7
  // abstentions had the answer at rank 1-2). Its candidates join the results
  // flagged weak: never cited, never raising confidence, ranked above
  // auto-captured observations and below matching curated memory.
  const brainForMerge = brain.items.length ? brain.items : (brain.weakItems || []).map((it) => ({ ...it, weight: WEAK_BRAIN_MERGE_WEIGHT }));
  const merged = mergeRecallResults([...withRanks(gateMemoryItems(query, memory.items)), ...withRanks(wisdom.items), ...withRanks(brainForMerge)]).slice(0, limit);
  timings.merged = Date.now() - t0;
  await expandShortNotes(merged, ctx, brainForMerge);
  timings.expanded = Date.now() - t0;
  const citationHint = attachCitationHandles(merged, brain.items, ctx);
  // BRAIN2-W7 E 121: a brain leg that returned nothing or failed is still an
  // attempted brain search; register that status so the turn stays in the
  // grounding denominator instead of vanishing.
  if (!brain.items.length) registerBrainLegStatus(brain, ctx);

  // BRAIN2-W7 E 110: every surface failing is an outage, not "nothing
  // remembered". Never report success for it.
  if (!memory.ok && !wisdom.ok && !brain.ok) {
    return {
      success: false,
      error: 'all_surfaces_unavailable: memory, wisdom and brain searches all failed; this is NOT an absence of remembered information',
      query,
      count: 0,
      results: [],
      surfaces: {
        memory: { ok: false, count: 0, reason: memory.reason },
        wisdom: { ok: false, count: 0, reason: wisdom.reason },
        brain: { ok: false, count: 0, reason: brain.reason },
      },
    };
  }

  const conf = answerConfidence(query, merged, brain);
  return {
    success: true,
    query,
    count: merged.length,
    confidence: conf.confidence,
    timings_ms: { ...timings, total: Date.now() - t0 },
    ...(conf.confidence === 'low' ? { confidence_note: conf.ungrounded ? `Weak match: none of the results mention ${conf.ungrounded.join(', ')}. Say plainly that nothing on this was found rather than presenting these as the answer.` : 'Weak match: nothing here clearly answers the question. Say so plainly rather than presenting these as the answer.' } : {}),
    results: merged,
    ...(citationHint ? { citation_hint: citationHint } : {}),
    surfaces: {
      memory: { ok: memory.ok, count: memory.items.length, ...(memory.ok ? {} : { reason: memory.reason }) },
      wisdom: { ok: wisdom.ok, count: wisdom.items.length, ...(wisdom.ok ? {} : { reason: wisdom.reason }) },
      brain: { ok: brain.ok, count: brain.items.length, ...(brain.expanded ? { expanded: true } : {}), ...(brain.insufficient ? { insufficient: true, note: 'Nothing relevant in the knowledge brain for this question' } : {}), ...(brain.ok ? {} : { reason: brain.reason }) },
    },
    // Last key on purpose: models weight the end of a tool result.
    ...(citationHint ? { citation_reminder: citationHint } : {}),
  };
}

module.exports = {
  recallSearch,
  normalizeMemoryItem,
  normalizeWisdomItem,
  normalizeBrainItem,
  _grounding: { questionEntities, entityGrounding },
};

/**
 * Brain citation tracing — BRAIN2-V2 phase V2-1 (retrieval → answer).
 *
 * Closes the audit gap "a tool was called is not a note was used". The
 * quox.brain.search envelope (toolExecutors/quoxbrain.js) proves an agent
 * ASKED the knowledge brain something. It proves nothing about whether the
 * answer the user read actually leaned on what came back. This module
 * measures that:
 *
 *   1. quoxbrain_search registers the refs it retrieved for this turn
 *      (registerRetrieval), keyed by the turn's correlation key.
 *   2. When the dispatcher has the final assistant text, it calls
 *      finalizeAnswer, which checks each retrieved ref against that text and
 *      emits ONE `quox.brain.cited` AEE envelope plus a POST to quoxbrain's
 *      /brain/citations so the citation rate is durable and queryable.
 *
 * WHY IN-MEMORY IS CORRECT HERE: the window between "search returned" and
 * "the answer is written" is a single turn inside a single collector
 * process — the same process that runs both the tool executor and the
 * dispatcher, including the MCP sub-path (claude CLI calls back into
 * /api/v1/tools/execute on this same collector). Nothing durable is being
 * stored here; the durable record is the AEE envelope + the POST. A lost
 * entry (restart mid-turn) costs one measurement, never any data.
 *
 * CORRELATION KEY — proven, not assumed (see the report/commit for the trace):
 * no dispatcher puts `corr` or `conversationId` on the tool ctx. All three
 * put `session_id` there (claudeMessagesDispatcher toolCtx.session_id,
 * openaiInvokeDispatcher toolCtx.session_id, and for the claude-CLI MCP
 * sub-path /api/v1/tools/execute's ctx.session_id, fed from QUOX_SESSION_ID).
 * So the key chain is `ctx.corr || ctx.conversationId || ctx.session_id`:
 * the first two are kept because they are what the existing
 * quox.brain.search envelope uses and may be populated by a future caller;
 * session_id is the one that is actually carried today.
 *
 * normalizeKey() exists for exactly one hop: quoxmcp sanitizes a
 * non-conforming session id (`[^a-zA-Z0-9_-]` → `_`, truncated to 64 chars,
 * quoxmcp/lib/validate.js SAFE_ID) before posting it to the collector, so a
 * Matrix-originated turn registers under the sanitized key while the
 * dispatcher finalizes with the raw one. Applying the identical transform on
 * both sides makes the two ends agree. It is identity for every key that
 * already conforms, and idempotent.
 *
 * Everything here is best-effort and never throws into the chat path.
 */

const { checkRefSupport, sentencesCiting, isDisavowal } = require('./citationSupport.js');
// ONE-BRAIN CX1: opt-in semantic entailment seam (set by server.js; null = lexical only).
let _entailFn = null;
function setEntailFn(fn) { _entailFn = typeof fn === 'function' ? fn : null; }
function getEntailFn() { return _entailFn; }
const BRAIN_URL = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

const TTL_MS = 15 * 60 * 1000; // one turn; generous for a long tool loop
const MAX_ENTRIES = 500;
const POST_TIMEOUT_MS = 5000;

// Minimum lengths before a match counts. A 3-letter title ("Ops") or a
// 2-letter filename would match almost any prose, which would report a
// citation rate of ~100% and make the whole measurement worthless.
const MIN_TITLE_LEN = 6;
const MIN_BASENAME_LEN = 5;

/** @type {Map<string, {orgId:string|undefined,userId:string|undefined,agentId:string|undefined,status:string|undefined,reason:string|undefined,refs:Array,expiresAt:number}>} */
const _entries = new Map();

// ============================================================================
// BRAIN2-CORTEX P1a — finalized-turn status view. Written by finalizeAnswer
// (below) just before it deletes the live _entries row, so a future dock
// surface can fetch, per session_id, the structured citations + honest
// hits/empty/unavailable status a chat turn's quoxbrain_search produced.
// Same TTL/cap discipline as _entries; entirely additive, read-only exports.
/** @type {Map<string, {corr:string,status:string,reason:string|undefined,retrieved:number,cited:number,rate:number,orgId:string|undefined,citations:Array,expiresAt:number}>} */
const _finalized = new Map();

// ============================================================================
// AEE audit envelope — injected by server.js via setAuditFn(), the same DI
// pattern as lib/toolExecutors/quoxbrain.js and lib/actionToolHandlers.js.
// ============================================================================

let _storeAuditEnvelope = () => {};

function setAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

// ============================================================================
// Key + text normalisation
// ============================================================================

// BRAIN2-W3 B (113): both maps are keyed by (org, user, normalizedKey), never
// by the bare correlation key, so two tenants whose keys collide (or
// normalise to the same string) can never merge refs. Unscoped callers
// (no org/user) land in their own "anonymous" scope, which no scoped caller
// can see or merge into.
function scopeId(orgId, userId, key) {
  return `${orgId || ''}\u0000${userId || ''}\u0000${key}`;
}

// All records in `map` for `key`. With `scope` ({orgId,userId}) given, only
// records of exactly that org (and user, when userId is given). Without a
// scope, every record for the key (internal/legacy callers only).
function matchScoped(map, key, scope) {
  const out = [];
  for (const rec of map.values()) {
    if (rec.key !== key) continue;
    if (scope) {
      if (!scope.orgId || rec.orgId !== scope.orgId) continue;
      if (scope.userId && rec.userId !== scope.userId) continue;
    }
    out.push(rec);
  }
  return out;
}

function normalizeKey(key) {
  if (typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Collapse whitespace and case-fold, NFC-normalised so a decomposed accent in
 * a note title still matches the composed form an LLM typically writes back.
 */
function normalizeText(value) {
  if (typeof value !== 'string' || !value) return '';
  let s = value;
  try { s = s.normalize('NFC'); } catch (_) { /* exotic input — use as-is */ }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function basenameWithoutExtension(relPath) {
  if (typeof relPath !== 'string' || !relPath) return '';
  const base = relPath.split(/[\\/]/).pop() || '';
  return base.replace(/\.[^.]+$/, '');
}

// ============================================================================
// Registration
// ============================================================================

function sweepExpired(now) {
  for (const [key, entry] of _entries) {
    if (entry.expiresAt <= now) _entries.delete(key);
  }
}

function sweepFinalizedExpired(now) {
  for (const [key, rec] of _finalized) {
    if (rec.expiresAt <= now) _finalized.delete(key);
  }
}

const PASSAGE_MAX = 2000; // BRAIN2-W4 A: support-check text kept per ref

// BRAIN2-W5 116: dedup identity is noteId PLUS span, so two different passages
// of one note stay two references (each with its own offsets and handle). A ref
// with no offsets keeps the plain noteId key (previous behaviour).
function refKey(r) {
  if (!r) return '';
  const id = typeof r.noteId === 'string' ? r.noteId.trim() : '';
  if (!id) return `~${r.title || ''}|${r.relPath || ''}`;
  return Number.isFinite(r.charStart) && Number.isFinite(r.charEnd) ? `${id}#${r.charStart}-${r.charEnd}` : id;
}

function hasSpan(r) {
  return !!r && Number.isFinite(r.charStart) && Number.isFinite(r.charEnd);
}

// BRAIN2-W13 A 117: chunks overlap (each is seeded with a look-behind tail of
// its predecessor), but charStart/charEnd name only a chunk's OWN span. Spans
// are note-level character offsets, so a span resolves against the OWN span
// first, then against the chunk's retrieved extent: the own span plus the
// look-behind the passage carries beyond it. noteId is always required.
function sameNote(a, b) {
  return !!a.noteId && a.noteId === b.noteId;
}
function ownContains(r, span) {
  return span.charStart >= r.charStart && span.charEnd <= r.charEnd;
}
function extentContains(r, span) {
  const own = r.charEnd - r.charStart;
  const lead = typeof r.passage === 'string' ? Math.max(0, r.passage.length - own) : 0;
  return span.charStart >= r.charStart - lead && span.charEnd <= r.charEnd;
}
function findCoveringRef(refs, span) {
  if (!hasSpan(span)) return null;
  const cands = refs.filter((r) => hasSpan(r) && sameNote(r, span));
  return cands.find((r) => ownContains(r, span)) || cands.find((r) => extentContains(r, span)) || null;
}

function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const noteId = typeof ref.noteId === 'string' ? ref.noteId.trim() : '';
    const title = typeof ref.title === 'string' ? ref.title : '';
    const relPath = typeof ref.relPath === 'string' ? ref.relPath : '';
    if (!noteId && !title && !relPath) continue;
    const out_ref = { noteId, title, relPath };
    // BRAIN2-CORTEX P1a: carried through only when the caller actually
    // provided them (the pre-existing HITS registration and every test that
    // predates this change never did) — never fabricated as '' / 0.
    if (typeof ref.snippet === 'string' && ref.snippet) out_ref.snippet = ref.snippet;
    if (typeof ref.passage === 'string' && ref.passage) out_ref.passage = ref.passage.slice(0, PASSAGE_MAX);
    if (typeof ref.score === 'number' && Number.isFinite(ref.score)) out_ref.score = ref.score;
    // BRAIN2-V3 A3: chunk char offsets so a citation can point at an exact span.
    if (Number.isFinite(ref.charStart) && Number.isFinite(ref.charEnd)) {
      out_ref.charStart = ref.charStart;
      out_ref.charEnd = ref.charEnd;
    }
    out.push(out_ref);
  }
  return out;
}

/**
 * Record what a quoxbrain_search returned for this turn. Repeated calls for
 * the same turn MERGE (an agent often searches two or three times before
 * answering); refs are deduped by noteId, and a ref with no noteId is kept
 * once per (title, relPath) pair.
 *
 * BRAIN2-CORTEX P1a: `status` ('hits'|'empty'|'unavailable') and `reason`
 * (unavailable only) are optional and additive. A call that supplies neither
 * a status nor any refs still records nothing — "an empty search is not a
 * retrieval" stays true for callers that don't opt into status tracking —
 * but a call that supplies a status (even with refs:[]) DOES create/refresh
 * the turn's entry, so a live/finalized status read has something honest to
 * show for an EMPTY or UNAVAILABLE search, not just HITS.
 *
 * @returns {boolean} true if anything was recorded.
 */
function registerRetrieval(corrKey, { orgId, userId, agentId, refs, status, reason, handlePrefix } = {}) {
  try {
    const key = normalizeKey(corrKey);
    if (!key) return false; // no correlation key on this path — no tracing

    const incoming = normalizeRefs(refs);
    const hasStatus = typeof status === 'string' && status.length > 0;
    if (incoming.length === 0 && !hasStatus) return false;

    const now = Date.now();
    sweepExpired(now);

    const sid = scopeId(orgId, userId, key);
    let entry = _entries.get(sid);
    if (!entry) {
      // Oldest-first eviction. Map preserves insertion order, and a merge
      // below does not re-insert, so "first key" is the oldest registration.
      while (_entries.size >= MAX_ENTRIES) {
        const oldest = _entries.keys().next().value;
        if (oldest === undefined) break;
        _entries.delete(oldest);
      }
      entry = { key, orgId, userId, agentId, status: undefined, reason: undefined, refs: [], expiresAt: now + TTL_MS };
      _entries.set(sid, entry);
    } else {
      entry.expiresAt = now + TTL_MS;
      if (!entry.agentId && agentId) entry.agentId = agentId;
    }
    if (hasStatus) {
      entry.status = status;
      entry.reason = reason;
    }

    const seen = new Set(entry.refs.map(refKey));
    for (const ref of incoming) {
      let dedupeKey = refKey(ref);
      // A span-carrying ref for a note already registered WITHOUT a span (a
      // whole-note reference) folds into that reference.
      if (!seen.has(dedupeKey) && ref.noteId && seen.has(ref.noteId)) dedupeKey = ref.noteId;
      // BRAIN2-W13 A 117: a span wholly inside an already registered own span of
      // the same note is the same passage (dedup by noteId + span containment).
      if (!seen.has(dedupeKey) && hasSpan(ref)) {
        const owner = entry.refs.find((r) => hasSpan(r) && sameNote(r, ref) && ownContains(r, ref));
        if (owner) dedupeKey = refKey(owner);
      }
      if (seen.has(dedupeKey)) {
        // BRAIN2-W4 A: a later read/search may bring the passage a first registration lacked.
        if (ref.passage) {
          const prior = entry.refs.find((r) => refKey(r) === dedupeKey);
          if (prior && !prior.passage) prior.passage = ref.passage;
        }
        continue;
      }
      seen.add(dedupeKey);
      // Short citation handle ([K1] implant, [B1] search tool). Numbering
      // continues per prefix within the turn so a second search never reuses
      // a handle the model has already seen.
      if (typeof handlePrefix === 'string' && /^[A-Za-z]$/.test(handlePrefix)) {
        const n = entry.refs.filter((r) => r.handle && r.handle.startsWith(handlePrefix)).length + 1;
        ref.handle = `${handlePrefix}${n}`;
      }
      entry.refs.push(ref);
    }
    return true;
  } catch (_) {
    return false; // tracing must never break a search
  }
}

/**
 * Handles for a list of refs as registered for this turn (deduped refs map to
 * the handle of the first registration). Entries are '' when the turn has no
 * key / the ref was not registered with a handle.
 */
function lookupHandles(corrKey, refs, scope) {
  try {
    const key = normalizeKey(corrKey);
    const entry = scope
      ? _entries.get(scopeId(scope.orgId, scope.userId, key))
      : matchScoped(_entries, key, null)[0];
    if (!entry) return (refs || []).map(() => '');
    const byKey = new Map(entry.refs.map((r) => [refKey(r), r.handle || '']));
    return (refs || []).map((ref) => {
      // Exact span first; a span-less lookup falls back to the plain noteId ref.
      const k = refKey(ref);
      if (byKey.has(k)) return byKey.get(k) || '';
      const plain = ref && typeof ref.noteId === 'string' ? ref.noteId.trim() : '';
      if (!plain) return '';
      if (byKey.has(plain)) return byKey.get(plain) || '';
      // BRAIN2-W13 A 117: a span inside a chunk's overlap/look-behind resolves by
      // note-level offsets to the registered chunk that carried it.
      const cover = findCoveringRef(entry.refs, ref);
      if (cover) return cover.handle || '';
      // A span-less lookup (e.g. a read) resolves to the first registered span of the note.
      if (!(Number.isFinite(ref.charStart) && Number.isFinite(ref.charEnd))) {
        for (const [key, h] of byKey) if (key.startsWith(`${plain}#`)) return h || '';
      }
      return '';
    });
  } catch (_) {
    return (refs || []).map(() => '');
  }
}

// ============================================================================
// Detection
// ============================================================================

/**
 * Did the final answer actually use this note? Checked against what the
 * agent was SHOWN: toolExecutors/quoxbrain.js renders `title`, an optional
 * `title · headingPath`, the snippet, and `(noteId: <id>)` — so a title echo
 * or an explicit noteId is what an answer plausibly carries back. relPath is
 * matched too (an agent may know the path from elsewhere), though the search
 * formatter does not currently render it.
 */
// Every whole token found inside any [...] group of the answer. Models group
// and annotate citations ("[B2, B3, B5]", "[B1: title]"; live 2026-10-05 the
// exact "[B2]" rule credited 2 of 5 real citations), so a handle counts when
// it is a whole token inside brackets: [K1] never matches [K12], [AB2] or [B3x].
// Memoised on the last haystack: finalizeAnswer checks every ref against one text.
let _bracketMemo = { haystack: null, tokens: new Set() };
function bracketTokens(haystack) {
  if (_bracketMemo.haystack === haystack) return _bracketMemo.tokens;
  const tokens = new Set();
  const groups = haystack.match(/\[[^[\]]{1,200}\]/g) || [];
  for (const g of groups) {
    for (const t of g.slice(1, -1).split(/[^a-z0-9]+/)) if (t) tokens.add(t);
  }
  _bracketMemo = { haystack, tokens };
  return tokens;
}

function isRefCited(ref, haystack) {
  // A ref that carries a handle counts as cited ONLY via its bracketed
  // handle (haystack is lowercased). "The title appeared" is not "the answer
  // used it". Title/basename/noteId substring rules are legacy, for refs
  // registered without a handle.
  if (ref.handle) {
    if (!bracketTokens(haystack).has(ref.handle.toLowerCase())) return false;
    // BRAIN2-W7 E 115: "I did not use [B1]" carries the handle but disavows it.
    // Cited only if at least one sentence carrying the handle is not a disavowal.
    const sents = sentencesCiting(haystack, ref.handle);
    return sents.length === 0 || sents.some((s) => !isDisavowal(s));
  }

  const noteId = normalizeText(ref.noteId);
  if (noteId && haystack.includes(noteId)) return true;

  const base = normalizeText(basenameWithoutExtension(ref.relPath));
  if (base.length >= MIN_BASENAME_LEN && haystack.includes(base)) return true;

  const title = normalizeText(ref.title);
  if (title.length >= MIN_TITLE_LEN && haystack.includes(title)) return true;

  return false;
}

// ============================================================================
// Finalisation
// ============================================================================

function emitCitedAudit(auditFn, { key, agentId, orgId, retrieved, cited, rate }) {
  try {
    auditFn({
      type: 'event',
      from: `agent.${agentId || 'quox'}`,
      to: 'service.quoxbrain',
      intent: 'quox.brain.cited',
      corr: key,
      // Counts only. No note titles, no paths, no answer text — the same
      // posture as quox.brain.search, which carries a query LENGTH and never
      // the query.
      payload: { org: orgId, retrieved, cited, rate },
    });
  } catch (_) { /* evidence is best-effort, never fatal */ }
}

async function postCitations(fetchFn, { key, entry, retrieved, cited, supported, citedNoteIds, records }) {
  try {
    if (typeof fetchFn !== 'function') return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${BRAIN_URL}/brain/citations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': SERVICE_KEY,
          'X-Org-Id': entry.orgId || 'default',
          ...(entry.userId ? { 'X-User-Id': entry.userId } : {}),
        },
        body: JSON.stringify({
          corr: key,
          agent_id: entry.agentId || undefined,
          user_id: entry.userId || undefined,
          retrieved_count: retrieved,
          cited_count: cited,
          supported_count: supported,
          cited_note_ids: citedNoteIds,
          ...(Array.isArray(records) && records.length ? { records } : {}),
        }),
        signal: controller.signal,
      });
      // An error body is not data: only a non-2xx is worth a warning, and
      // even then the turn is already finished and unaffected.
      if (res && res.ok === false) {
        console.warn(`[BrainCitation] POST /brain/citations returned ${res.status} (org=${entry.orgId || 'default'})`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn(`[BrainCitation] citation POST failed: ${err && err.message}`);
  }
}

/**
 * Measure which of this turn's retrieved notes the final answer actually
 * cited, emit the evidence, and drop the entry.
 *
 * No-op (resolves null) when this turn never searched the brain — which is
 * the overwhelming majority of turns, so it must stay cheap.
 *
 * @param {string} corrKey     the turn's correlation key
 * @param {string} finalText   the final assistant answer the user will read
 * @param {object} [deps]      { fetchFn, auditFn } — injected in tests
 */
async function finalizeAnswer(corrKey, finalText, deps = {}) {
  const k0 = normalizeKey(corrKey);
  if (!k0) return null;
  // Finalize each tenant's own entry for this key separately (never merged).
  // When the caller supplies deps.orgId/userId only that scope is finalized.
  const scoped = deps.orgId !== undefined || deps.userId !== undefined;
  const targets = scoped
    ? [_entries.get(scopeId(deps.orgId, deps.userId, k0))].filter(Boolean)
    : matchScoped(_entries, k0, null);
  let last = null;
  for (const e of targets) last = await finalizeEntry(e, finalText, deps);
  return last;
}

async function finalizeEntry(entry, finalText, deps = {}) {
  let key = entry.key;
  const sid = scopeId(entry.orgId, entry.userId, key);
  try {

    const haystack = normalizeText(finalText);
    const retrieved = entry.refs.length;
    const citedFlags = [];
    const supportFlags = [];
    const contradictedFlags = [];
    const supportByRef = new Map();
    const citedByRef = new Map();
    const contradictedByRef = new Map();
    let contradicted = 0;
    const citedNoteIds = [];
    let cited = 0;
    let supported = 0;
    const checkByRef = new Map();
    const methodByRef = new Map();
    for (const ref of entry.refs) {
      const isCited = isRefCited(ref, haystack);
      citedFlags.push(isCited);
      // BRAIN2-W2 2: cited != supported. Lexical overlap of the citing
      // sentence(s) with the cited passage; null = not checkable (legacy ref
      // without handle/passage). Never semantic proof.
      let sup = false;
      let contra = false;
      if (isCited) {
        let chk = null;
        try { chk = checkRefSupport(ref, finalText); } catch (_) { chk = null; }
        sup = chk ? chk.supported : null;
        if (chk && chk.contradicted) contra = true;
        if (chk) checkByRef.set(ref, chk);
      }
      supportFlags.push(sup);
      supportByRef.set(ref, sup);
      citedByRef.set(ref, isCited);
      contradictedFlags.push(contra);
      contradictedByRef.set(ref, contra);
      if (contra) contradicted += 1;
      if (sup === true) supported += 1;
      if (!isCited) continue;
      cited += 1;
      if (ref.noteId) citedNoteIds.push(ref.noteId);
    }
    // ONE-BRAIN CX1: opt-in semantic upgrade of the lexical verdict. Any
    // failure, timeout or opt-out leaves the lexical result untouched.
    const entailFn = typeof deps.entailFn === 'function' ? deps.entailFn : _entailFn;
    if (entailFn) {
      try {
        const cand = entry.refs
          .map((ref, i) => ({ ref, i, chk: checkByRef.get(ref) }))
          .filter((c) => c.chk && Array.isArray(c.chk.claims) && c.chk.claims.length && c.chk.passage)
          .slice(0, 5);
        const verdicts = cand.length
          ? await entailFn({ orgId: entry.orgId, items: cand.map((c) => ({ claim: c.chk.claims.join(' '), passage: c.chk.passage })) })
          : null;
        if (Array.isArray(verdicts)) {
          cand.forEach((c, k) => {
            const v = verdicts[k];
            if (!v) return;
            const wasSup = supportFlags[c.i] === true;
            const wasContra = contradictedFlags[c.i] === true;
            const nowSup = v === 'SUPPORTED';
            const nowContra = v === 'CONTRADICTED';
            supportFlags[c.i] = nowSup;
            supportByRef.set(c.ref, nowSup);
            contradictedFlags[c.i] = nowContra;
            contradictedByRef.set(c.ref, nowContra);
            methodByRef.set(c.ref, 'semantic');
            if (wasSup && !nowSup) supported -= 1;
            if (!wasSup && nowSup) supported += 1;
            if (wasContra && !nowContra) contradicted -= 1;
            if (!wasContra && nowContra) contradicted += 1;
          });
        }
      } catch (_) { /* keep lexical */ }
    }
    const rate = retrieved > 0 ? Math.round((cited / retrieved) * 1000) / 1000 : 0;

    // BRAIN2-CORTEX P1a: write the finalized status/citations view BEFORE
    // deleting the live entry, so there is never a window where neither map
    // has this turn (a concurrent getFinalized/getLive read must always find
    // one of the two). Own try/catch — a throw here must never break the
    // pre-existing audit emit / POST / return value below.
    try {
      const now = Date.now();
      let citedOrdinal = 0;
      const citations = entry.refs.map((ref, i) => {
        const isCited = citedFlags[i];
        if (isCited) citedOrdinal += 1;
        return {
          noteId: ref.noteId,
          title: ref.title,
          relPath: ref.relPath,
          snippet: ref.snippet,
          score: ref.score,
          handle: ref.handle,
          charStart: ref.charStart,
          charEnd: ref.charEnd,
          index: isCited ? citedOrdinal : null,
          cited: isCited,
          supported: supportFlags[i],
          contradicted: contradictedFlags[i],
          support_method: isCited && typeof supportFlags[i] === 'boolean' ? (methodByRef.get(ref) || 'lexical') : null,
        };
      });
      sweepFinalizedExpired(now);
      while (_finalized.size >= MAX_ENTRIES) {
        const oldest = _finalized.keys().next().value;
        if (oldest === undefined) break;
        _finalized.delete(oldest);
      }
      _finalized.set(sid, {
        key,
        corr: key,
        status: entry.status || 'hits',
        reason: entry.reason,
        retrieved,
        cited,
        supported,
        contradicted,
        rate,
        orgId: entry.orgId,
        userId: entry.userId,
        citations,
        finalizedAt: now,
        expiresAt: now + TTL_MS,
      });
    } catch (finalizeWriteErr) {
      console.warn(`[BrainCitation] finalized-record write failed: ${finalizeWriteErr && finalizeWriteErr.message}`);
    }

    _entries.delete(sid);

    // Only a turn that genuinely retrieved something gets measured for
    // citation and posted as evidence. An entry created purely to carry an
    // EMPTY/UNAVAILABLE status (registerRetrieval with refs:[]) has nothing
    // to check — firing quox.brain.cited / POST /brain/citations for it would
    // be a NEW emission this change must not introduce (retrieved was always
    // >0 for every entry that could reach this point before P1a).
    // BRAIN2-W7 E 121: an EMPTY/UNAVAILABLE brain search is still an attempted
    // answer-with-brain turn. It is POSTed (retrieved 0, cited 0) so the
    // grounding denominator counts it; no cited-audit envelope is emitted.
    if (retrieved === 0 && (entry.status === 'empty' || entry.status === 'unavailable')) {
      const fetchFn0 = typeof deps.fetchFn === 'function'
        ? deps.fetchFn
        : (typeof fetch === 'function' ? fetch : null);
      await postCitations(fetchFn0, { key, entry, retrieved: 0, cited: 0, supported: 0, citedNoteIds: [] });
    }
    if (retrieved > 0) {
      const auditFn = typeof deps.auditFn === 'function' ? deps.auditFn : _storeAuditEnvelope;
      emitCitedAudit(auditFn, { key, agentId: entry.agentId, orgId: entry.orgId, retrieved, cited, rate });

      const fetchFn = typeof deps.fetchFn === 'function'
        ? deps.fetchFn
        : (typeof fetch === 'function' ? fetch : null);
      // BRAIN2-W13 A 118: durable per-reference records (quoxbrain citation_records).
      const records = entry.refs.filter((r) => r.noteId).map((ref, i) => ({
        handle: ref.handle || undefined,
        note_id: ref.noteId,
        char_start: Number.isFinite(ref.charStart) ? ref.charStart : undefined,
        char_end: Number.isFinite(ref.charEnd) ? ref.charEnd : undefined,
        supported: citedByRef.get(ref) && typeof supportByRef.get(ref) === 'boolean' ? supportByRef.get(ref) : null,
        contradicted: contradictedByRef.get(ref) === true,
      }));
      await postCitations(fetchFn, { key, entry, retrieved, cited, supported, citedNoteIds, records });
    }

    return { corr: key, retrieved, cited, supported, contradicted, rate, citedNoteIds };
  } catch (err) {
    console.warn(`[BrainCitation] finalize failed: ${err && err.message}`);
    _entries.delete(sid);
    return null;
  }
}

/**
 * BRAIN2-CORTEX P1a — read the finalized status/citations record for a turn
 * (written by finalizeAnswer just before it deletes the live entry). Does
 * NOT delete on read: the dock may fetch more than once before TTL expiry.
 */
function getFinalized(corrKey, scope) {
  try {
    const key = normalizeKey(corrKey);
    if (!key) return null;
    sweepFinalizedExpired(Date.now());
    const rec = matchScoped(_finalized, key, scope || null)[0];
    if (!rec) return null;
    const { expiresAt, key: _k, ...rest } = rec;
    return rest;
  } catch (_) {
    return null;
  }
}

/**
 * BRAIN2-CORTEX P1a — read the pre-finalize live entry for a turn (the race
 * fix: a route can serve retrieved refs before finalizeAnswer runs). Shallow
 * view only — never the raw entry object.
 */
function getLive(corrKey, scope) {
  try {
    const key = normalizeKey(corrKey);
    if (!key) return null;
    sweepExpired(Date.now());
    const entry = matchScoped(_entries, key, scope || null)[0];
    if (!entry) return null;
    return { corr: key, status: entry.status || 'hits', reason: entry.reason, orgId: entry.orgId, userId: entry.userId, refs: entry.refs, registeredAt: entry.expiresAt - TTL_MS };
  } catch (_) {
    return null;
  }
}

/**
 * BRAIN2-W5 114: choose between a finalized record and a live entry for the
 * same session key. A live entry only exists for a turn registered AFTER the
 * previous finalize (finalize deletes the live one), so it is the newer turn:
 * the route must not keep serving the previous answer's evidence. Timestamps
 * decide when both carry one; live wins ties.
 * @returns {{kind: 'live'|'finalized', record: object}|null}
 */
function pickCitationRecord(fin, live) {
  if (fin && live) {
    if (Number.isFinite(fin.finalizedAt) && Number.isFinite(live.registeredAt) && fin.finalizedAt > live.registeredAt) {
      return { kind: 'finalized', record: fin };
    }
    return { kind: 'live', record: live };
  }
  if (live) return { kind: 'live', record: live };
  if (fin) return { kind: 'finalized', record: fin };
  return null;
}

/**
 * BRAIN2-W3 B (112): the read scope for the citation route. A user caller is
 * bound to their own org AND user id; a service-key caller must name an org
 * and may read any user in it. Returns null (=> 404) when no org is known or
 * a user caller carries no user id: never fall back to the session id alone.
 */
function callerScope({ user, service, headerOrgId } = {}) {
  const orgId = (user && user.org_id) || (service ? headerOrgId : undefined);
  if (!orgId) return null;
  if (user) {
    const userId = user.id || user.user_id || user.userId;
    if (!userId) return null;
    return { orgId, userId };
  }
  return { orgId, userId: undefined };
}

function _resetForTest() {
  _entries.clear();
  _finalized.clear();
  _storeAuditEnvelope = () => {};
}

module.exports = {
  setEntailFn,
  getEntailFn,
  registerRetrieval,
  finalizeAnswer,
  getFinalized,
  getLive,
  callerScope,
  pickCitationRecord,
  setAuditFn,
  _resetForTest,
  // exported for tests / callers that need the same canonicalisation
  normalizeKey,
  lookupHandles,
};

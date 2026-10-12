/**
 * QuoxBrain Tool Executor — QUOXBRAIN P2a (pull)
 *
 * Native executor for quoxbrain_search. Queries the org's knowledge brain
 * (quoxbrain service, default http://quoxbrain:3106) via the
 * TRUST-GATE-1.12a internal-service auth (X-Service-Key + X-Org-Id, org
 * sourced from the tool execution context — see agentTools.js's
 * `execute: async (input, ctx) => ...` convention) and returns cited,
 * readable snippets. Modeled on toolExecutors/codebase.js.
 *
 * Best-effort: any failure (brain down, timeout, non-2xx, missing query)
 * resolves to a clean "knowledge brain unavailable" string — never throws.
 *
 * BRAIN2-V2-5: the agent-facing string is deliberately the same for every
 * failure, but the EVIDENCE is not. A brain that never answered emits
 * quox.brain.unavailable with a reason (http_<status> | fetch_failed |
 * timeout); a brain that answered 2xx emits quox.brain.search with the real
 * resultCount. Before this, both collapsed into one search envelope, so a
 * down brain was indistinguishable from an empty one.
 */

const { registerRetrieval, lookupHandles, getEntailFn } = require('../brainCitationTrace.js');
const { lexicalSupport } = require('../citationSupport.js');
const { BRAIN_CITE_INSTRUCTION } = require('../brainCiteInstruction.js');

const BRAIN_URL = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
// BRAIN2-PRODUCT P3c (2026-08-26): 10s aborted real agent searches the
// moment hybrid retrieval went live — a cold hybrid /brain/search (query
// embed round-trip + first-fill of the dense vector cache over a 45k-chunk
// org) measured 8-10s+. 25s keeps the call bounded while letting the cold
// path complete; warm-path queries are 1-2s.
const TIMEOUT_MS = 25000;
// BRAIN2-V3 A3: per-hit snippet budget (~80 tokens at ~4 chars/token). The
// brain's FTS snippet is ~64 tokens; dense-only hits carry up to 240 chars.
const SNIPPET_MAX_CHARS = 320;
const READ_DEFAULT_CHARS = 4000;
const READ_MAX_CHARS = 20000;
const NOTHING_RELEVANT_MSG = 'Nothing relevant in the knowledge brain for this question.';
const UNAVAILABLE_MSG = 'Knowledge brain unavailable — proceeding without it.';

// ============================================================================
// AEE Audit Envelope — injected by server.js via setAuditFn(), same DI
// pattern as lib/actionToolHandlers.js (setAuditFn / emitActionAudit).
// Falls back to a no-op so the module works standalone (e.g. under test
// without wiring).
// ============================================================================

let _storeAuditEnvelope = () => {};

/**
 * Wire in the server's storeAuditEnvelope function.
 * Call once at startup: setAuditFn(storeAuditEnvelope)
 */
function setAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

/**
 * Emit one AEE envelope per quoxbrain_search invocation that actually
 * reached the brain service. Never carries the query text itself (it may
 * contain sensitive content) — only its length. Best-effort: a failure here
 * must never fail the search.
 *
 * BRAIN2-V2-5: this fires ONLY on a 2xx, i.e. only when the brain genuinely
 * answered. resultCount 0 therefore means "the brain answered and had
 * nothing" (EMPTY) and never "the brain was down" — that is
 * quox.brain.unavailable below.
 */
function emitBrainSearchAudit(ctx, orgId, queryLength, resultCount) {
  try {
    _storeAuditEnvelope({
      type: 'event',
      from: `agent.${ctx?.agentId || 'quox'}`,
      to: 'service.quoxbrain',
      intent: 'quox.brain.search',
      corr: ctx?.corr || ctx?.conversationId || undefined,
      payload: {
        org: orgId,
        queryLength,
        resultCount,
      },
    });
  } catch (_) { /* non-fatal — evidence must never break a search */ }
}

/**
 * BRAIN2-V2-5 (audit finding M2: "brain failure is invisible") — emit a
 * DISTINCT envelope when the brain could not be reached at all, so a failure
 * is countable instead of collapsing into a zero-result search. Previously
 * every outcome emitted one quox.brain.search, which made "brain down for 30
 * hours" and "brain answered, nothing matched" indistinguishable in the
 * evidence trail.
 *
 * reason is one of: `http_<status>` | `fetch_failed` | `timeout`.
 *
 * Carries ONLY org and reason — never the query text, and not even its
 * length, mirroring emitBrainSearchAudit's privacy discipline. Best-effort:
 * a failure here must never fail the search.
 */
function emitBrainUnavailableAudit(ctx, orgId, reason) {
  try {
    _storeAuditEnvelope({
      type: 'error',
      from: `agent.${ctx?.agentId || 'quox'}`,
      to: 'service.quoxbrain',
      intent: 'quox.brain.unavailable',
      corr: ctx?.corr || ctx?.conversationId || undefined,
      payload: {
        org: orgId,
        reason,
      },
    });
  } catch (_) { /* non-fatal — evidence must never break a search */ }
}

/**
 * quoxbrain_search — search the org's knowledge brain via quoxbrain.
 * Always resolves to a formatted string; never throws.
 */
async function quoxbrainSearch(input, ctx) {
  const query = input?.query;
  const limit = Math.min(parseInt(input?.limit) || 5, 20);
  const orgId = ctx?.orgId || 'default';
  const userId = ctx?.userId;

  if (!query || typeof query !== 'string') {
    return 'Missing required parameter: query';
  }

  // ==========================================================================
  // BRAIN2-V2-5 — Phase 1: reach the brain. Every way this phase can fail
  // (transport error, abort/timeout, non-2xx) is UNAVAILABLE: the brain never
  // answered, so it gets the quox.brain.unavailable envelope with a reason and
  // NOT a quox.brain.search. The returned string stays UNAVAILABLE_MSG
  // verbatim so agent behaviour is unchanged — the new signal is for the
  // evidence trail, not the model.
  // ==========================================================================
  // BRAIN2-CORTEX P1a: optional facet narrowing, forwarded only when the
  // caller (the LLM, per its tool description) actually named one — an
  // absent/empty array must leave the request body IDENTICAL to before this
  // change. Facets narrow both legs; hybrid ranking stays on (dense candidates
  // are facet-filtered too, services/quoxbrain/lib/contextAssembler.js).
  const scopes = Array.isArray(input?.scopes) && input.scopes.length > 0 ? input.scopes : undefined;
  const sources = Array.isArray(input?.sources) && input.sources.length > 0 ? input.sources : undefined;
  const vaultIds = Array.isArray(input?.vaultIds) && input.vaultIds.length > 0 ? input.vaultIds : undefined;
  // Agent path: allow quoxbrain's agent query-embed maximum so a slow embed
  // under load still lands hybrid instead of silently serving word-match only.
  const searchBody = { query, limit, includeText: true, embedTimeoutMs: 4000 };
  if (scopes) searchBody.scopes = scopes;
  if (sources) searchBody.sources = sources;
  if (vaultIds) searchBody.vaultIds = vaultIds;
  // ONE-BRAIN CX2: optional date window, forwarded only when named.
  if (typeof input?.since === 'string' && input.since.trim()) searchBody.since = input.since.trim();
  if (typeof input?.until === 'string' && input.until.trim()) searchBody.until = input.until.trim();

  // BRAIN2-CORTEX P1a: same session-key expression the HITS branch below
  // already uses for registerRetrieval — kept as one const so every branch
  // (hits/empty/unavailable) traces under the identical turn key.
  const corrKey = ctx?.corr || ctx?.conversationId || ctx?.session_id;

  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    res = await fetch(`${BRAIN_URL}/brain/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': SERVICE_KEY,
        'X-Org-Id': orgId,
        // BRAIN2-PRODUCT P3a: identify agent-initiated pull calls to Qortex,
        // distinct from human-driven UI reads and the MCP passthrough path.
        'X-Quox-Source': 'agent',
        // BRAIN2-NIGHT2: thread the real end-user id so quoxbrain resolves
        // user-scoped vaults instead of defaulting to user_id='service'
        ...(userId ? { 'X-User-Id': userId } : {}),
      },
      body: JSON.stringify(searchBody),
      signal: controller.signal,
    });
  } catch (err) {
    // An abort surfaces as AbortError (our AbortController firing at
    // TIMEOUT_MS) or TimeoutError; anything else is a transport failure. The
    // two are separated because they mean different things operationally: a
    // timeout is a slow/overloaded brain, fetch_failed is one that is not
    // listening at all.
    const aborted = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    const reason = aborted ? 'timeout' : 'fetch_failed';
    console.warn(`[QuoxBrain] search failed (org=${orgId}, reason=${reason}): ${err?.message}`);
    emitBrainUnavailableAudit(ctx, orgId, reason);
    registerRetrieval(corrKey, { orgId, userId, agentId: ctx?.agentId, status: 'unavailable', reason, refs: [] });
    clearTimeout(timer);
    return UNAVAILABLE_MSG;
  }
  // Codex cycle 5 F4: the deadline stays armed through the body read below.
  // Clearing it on headers let a brain that sent 200 and then stalled the body
  // hang the agent turn forever. It is cleared in phase 2's finally instead.

  // `!res` cannot happen with a real fetch (it resolves a Response or throws),
  // but this executor's contract is "never throws" — so a missing response is
  // treated as a transport failure rather than crashing on res.status.
  if (!res || !res.ok) {
    const reason = res ? `http_${res.status}` : 'fetch_failed';
    console.warn(`[QuoxBrain] search returned ${res ? res.status : 'no response'} (org=${orgId})`);
    emitBrainUnavailableAudit(ctx, orgId, reason);
    registerRetrieval(corrKey, { orgId, userId, agentId: ctx?.agentId, status: 'unavailable', reason, refs: [] });
    clearTimeout(timer);
    return UNAVAILABLE_MSG;
  }

  // ==========================================================================
  // Phase 2: the brain answered 2xx. From here on the outcome is EMPTY or
  // HITS, never UNAVAILABLE — so exactly one quox.brain.search envelope fires,
  // carrying the honest resultCount (0 meaning "answered, nothing matched").
  // ==========================================================================
  let resultCount = 0;
  try {
    const data = await res.json();
    // BRAIN2-W2 2: honour quoxbrain's abstention. insufficient=true means the
    // hits are not relevant to the question: the model is told so plainly and
    // NO refs/handles are registered, so nothing irrelevant becomes citable.
    const insufficient = data.insufficient === true || data.relevance?.insufficient === true;
    if (insufficient) {
      registerRetrieval(corrKey, { orgId, userId, agentId: ctx?.agentId, status: 'empty', refs: [] });
      return NOTHING_RELEVANT_MSG;
    }
    const results = data.results || [];
    resultCount = results.length;

    if (results.length === 0) {
      // BRAIN2-CORTEX P1a: honest status even when there is nothing to show
      // — a future dock read (getLive/getFinalized) must be able to tell "we
      // searched and found nothing" apart from "this turn never searched".
      // refs:[] with a real status is a no-op for the LLM-facing string.
      registerRetrieval(corrKey, { orgId, userId, agentId: ctx?.agentId, status: 'empty', refs: [] });
      return `No knowledge brain results found for: "${query}"`;
    }

    // BRAIN2-V2-1: record WHAT was retrieved for this turn, while the results
    // are still structured, so the dispatcher can measure at the end of the
    // turn which of these the final answer actually cited (lib/
    // brainCitationTrace.js). Same key expression as emitBrainSearchAudit's
    // corr, extended with session_id — the only one of the three that any
    // dispatcher actually puts on the tool ctx today (see brainCitationTrace's
    // header for the trace). No key on this path means no tracing, never a
    // guessed key. Best-effort: registerRetrieval never throws.
    const shown = results.slice(0, limit); // what the formatter below shows
    const shownRefs = shown.map((r) => ({
      noteId: r.noteId,
      title: r.title,
      relPath: r.relPath,
      snippet: r.snippet,
      passage: typeof r.text === 'string' ? r.text : undefined,
      score: r.score,
      charStart: r.charStart,
      charEnd: r.charEnd,
    }));
    registerRetrieval(corrKey, {
      orgId,
      userId,
      agentId: ctx?.agentId,
      status: 'hits',
      handlePrefix: 'B',
      refs: shownRefs,
    });
    // [B1].. citation handles (continue across calls in one turn). Empty when
    // this path has no correlation key (no tracing, so no handle either).
    const handles = lookupHandles(corrKey, shownRefs, { orgId, userId });

    const lines = [`Found ${results.length} result${results.length !== 1 ? 's' : ''} in the knowledge brain:`];
    // Codex cycle 4: a degraded search must say so to the agent, not only in
    // the API body (partial dense coverage, or a keyword-only fallback).
    const cov = data.denseCoverage;
    if (cov && cov.status === 'partial') {
      const pct = Number.isFinite(cov.fraction) ? `${Math.round(cov.fraction * 100)}%` : 'part';
      lines.push(`Note: semantic search covered only ${pct} of this brain this time; older knowledge may be missing from these results.`);
    } else if (data.retrieval === 'fts' && data.degraded) {
      lines.push('Note: semantic search was unavailable, so these results come from keyword search only; paraphrased matches may be missing.');
    }
    if (handles.some(Boolean)) lines.push(BRAIN_CITE_INSTRUCTION);
    lines.push('');
    for (const [idx, r] of shown.entries()) {
      const title = r.title || 'Untitled';
      const headingPath = r.headingPath && r.headingPath !== title ? r.headingPath : '';
      let snippet = (r.snippet || '').replace(/[[\]]/g, '').trim();
      if (snippet.length > SNIPPET_MAX_CHARS) snippet = `${snippet.slice(0, SNIPPET_MAX_CHARS).trimEnd()}...`;
      const noteId = r.noteId || '';

      const h = handles[idx] ? `[${handles[idx]}] ` : '';
      lines.push(`${h}${headingPath ? `${title} · ${headingPath}` : title}`);
      if (snippet) lines.push(`  ${snippet}`);
      const hasSpan = Number.isFinite(r.charStart) && Number.isFinite(r.charEnd);
      if (noteId) lines.push(`  (noteId: ${noteId}${hasSpan ? `, chars ${r.charStart}-${r.charEnd}` : ''})`);
      lines.push('');
    }

    if (handles.some(Boolean)) lines.push(BRAIN_CITE_INSTRUCTION);
    return lines.join('\n').trim();
  } catch (err) {
    // A 2xx whose body could not be read or formatted. The brain WAS reached,
    // so this stays on the search envelope (resultCount 0) rather than being
    // reported as unavailable — keeping "unavailable" to mean exactly "never
    // got a 2xx". Return string unchanged from previous behaviour.
    console.warn(`[QuoxBrain] reached the brain but could not read its response (org=${orgId}): ${err.message}`);
    // BRAIN2-CORTEX P1a: this branch never emitted quox.brain.unavailable (see
    // comment above — the AEE distinction is deliberately "never got a 2xx"),
    // so there is no pre-existing reason to reuse. 'unreadable_body' is a
    // status-view-only label; it does not touch the AEE envelope above.
    registerRetrieval(corrKey, { orgId, userId, agentId: ctx?.agentId, status: 'unavailable', reason: 'unreadable_body', refs: [] });
    return UNAVAILABLE_MSG;
  } finally {
    clearTimeout(timer);
    // BRAIN2-PRODUCT P3a / BRAIN2-V2-5: one AEE envelope per invocation that
    // GENUINELY REACHED the brain (2xx only). Unavailable invocations emit
    // quox.brain.unavailable in phase 1 instead, so resultCount 0 here is
    // always a real empty result and never a masked failure.
    emitBrainSearchAudit(ctx, orgId, query.length, resultCount);
  }
}

/** Shared GET against the brain with the same scoping headers as search. Resolves { res } or { err }. */
async function brainGet(path, ctx, orgId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BRAIN_URL}${path}`, {
      method: 'GET',
      headers: {
        'X-Service-Key': SERVICE_KEY,
        'X-Org-Id': orgId,
        'X-Quox-Source': 'agent',
        ...(ctx?.userId ? { 'X-User-Id': ctx.userId } : {}),
      },
      signal: controller.signal,
    });
    // BRAIN2-W5 154: the deadline must cover the BODY read too. Read it here,
    // while the timer is still armed (an abort rejects a stalled body), and
    // hand callers a response whose json() replays the already-read body.
    let body;
    let bodyErr = null;
    try { body = await res.json(); } catch (e) { bodyErr = e; }
    return {
      res: {
        ok: res.ok,
        status: res.status,
        json: async () => { if (bodyErr) throw bodyErr; return body; },
      },
    };
  } catch (err) {
    return { err };
  } finally {
    clearTimeout(timer);
  }
}

function clampInt(v, dflt, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/**
 * quoxbrain_read: read a span of one note (BRAIN2-V3 A3). Scoped by the
 * brain's own GET /notes/:id (which also records the note_read usage event).
 * Registers the note as a retrieval so grounding measurement still sees it.
 * Always resolves to a string; never throws.
 */
async function quoxbrainRead(input, ctx) {
  const noteId = typeof input?.noteId === 'string' ? input.noteId.trim() : '';
  if (!noteId) return 'Missing required parameter: noteId';
  const orgId = ctx?.orgId || 'default';
  const corrKey = ctx?.corr || ctx?.conversationId || ctx?.session_id;
  const start = clampInt(input?.start, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = clampInt(input?.maxChars, READ_DEFAULT_CHARS, 1, READ_MAX_CHARS);
  const end = input?.end !== undefined && input?.end !== null
    ? Math.min(clampInt(input.end, start + maxChars, start, Number.MAX_SAFE_INTEGER), start + maxChars)
    : start + maxChars;

  const { res, err } = await brainGet(`/notes/${encodeURIComponent(noteId)}?range=${start}:${end}`, ctx, orgId);
  if (err || !res) {
    console.warn(`[QuoxBrain] read failed (org=${orgId}): ${err?.message}`);
    return UNAVAILABLE_MSG;
  }
  if (res.status === 404) return `Note not found (or not visible to you): ${noteId}`;
  if (!res.ok) {
    console.warn(`[QuoxBrain] read returned ${res.status} (org=${orgId})`);
    return UNAVAILABLE_MSG;
  }
  let note;
  try { note = await res.json(); } catch (e) { return UNAVAILABLE_MSG; }

  // Vault name is provenance, best-effort: a failure here never fails the read.
  let vaultName = '';
  if (note.vault_id) {
    const v = await brainGet(`/vaults/${encodeURIComponent(note.vault_id)}`, ctx, orgId);
    if (v.res && v.res.ok) {
      try { vaultName = (await v.res.json())?.name || ''; } catch (_) { /* provenance only */ }
    }
  }

  const title = note.title || 'Untitled';
  const relPath = note.rel_path || note.relPath || '';
  registerRetrieval(corrKey, {
    orgId, userId: ctx?.userId, agentId: ctx?.agentId, status: 'hits', handlePrefix: 'B',
    refs: [{ noteId: note.id || noteId, title, relPath, passage: typeof note.body === 'string' ? note.body : undefined, charStart: start, charEnd: end }],
  });
  // W10 B: look up by note AND exact span so a second-range read gets its own handle.
  const handle = lookupHandles(corrKey, [{ noteId: note.id || noteId, title, relPath, charStart: start, charEnd: end }], { orgId, userId: ctx?.userId })[0];

  const body = typeof note.body === 'string' ? note.body : '';
  const total = Number.isFinite(note.body_length) ? note.body_length : body.length;
  const lines = [`${handle ? `[${handle}] ` : ''}${title}`];
  if (handle) lines.push(BRAIN_CITE_INSTRUCTION);
  const prov = [];
  if (vaultName) prov.push(`vault: ${vaultName}`);
  if (relPath) prov.push(`path: ${relPath}`);
  if (note.occurredAt || note.occurred_at) prov.push(`occurred: ${note.occurredAt || note.occurred_at}`);
  if (prov.length) lines.push(`  (${prov.join(' | ')})`);
  if (note.revision) lines.push(`  (revision: ${note.revision}; pass this as expectedHash if you edit or delete this note)`);
  lines.push(`  (noteId: ${note.id || noteId}, showing chars ${Math.min(start, total)}-${Math.min(start + body.length, total)} of ${total})`);
  lines.push('');
  lines.push(body || '(no text in this range)');
  if (start + body.length < total) lines.push('', `[more: call quoxbrain_read again with start=${start + body.length}]`);
  if (handle) lines.push('', BRAIN_CITE_INSTRUCTION);
  return lines.join('\n');
}

/** brain_suggestions: the caller's "Ask Qortex" starter questions. Never throws. */
async function brainSuggestions(input, ctx) {
  const orgId = ctx?.orgId || 'default';
  const count = clampInt(input?.count, 8, 1, 20);
  const { res, err } = await brainGet(`/brain/suggestions?count=${count}`, ctx, orgId);
  if (err || !res || !res.ok) {
    console.warn(`[QuoxBrain] suggestions failed (org=${orgId}): ${err?.message || res?.status}`);
    return UNAVAILABLE_MSG;
  }
  try {
    const data = await res.json();
    const list = Array.isArray(data.suggestions) ? data.suggestions : [];
    if (list.length === 0) return data.message || 'No suggestions available yet.';
    const texts = list.map((s) => (typeof s === 'string' ? s : (s?.question || s?.text || s?.title || JSON.stringify(s))));
    return ['Suggested questions from the brain:', ...texts.map((t, i) => `${i + 1}. ${t}`)].join('\n');
  } catch (_) {
    return UNAVAILABLE_MSG;
  }
}

/** brain_brief: what entered the brain recently. Never throws. */
async function brainBrief(input, ctx) {
  const orgId = ctx?.orgId || 'default';
  const since = /^\d+\s*[mhdw]?$/i.test(String(input?.since || '')) ? String(input.since).replace(/\s+/g, '') : '24h';
  const stream = /^[A-Z0-9][A-Z0-9-]{1,40}$/.test(String(input?.stream || '')) ? String(input.stream) : '';
  const { res, err } = await brainGet(`/brain/brief?since=${encodeURIComponent(since)}${stream ? `&stream=${encodeURIComponent(stream)}` : ''}`, ctx, orgId);
  if (err || !res || !res.ok) {
    console.warn(`[QuoxBrain] brief failed (org=${orgId}): ${err?.message || res?.status}`);
    return UNAVAILABLE_MSG;
  }
  try {
    const d = await res.json();
    const lines = [`Brain brief${stream ? ` for stream ${stream}` : ''} (since ${since}): ${d.summary || 'nothing new.'}`];
    if (Array.isArray(d.topNotes) && d.topNotes.length) {
      lines.push('Newest notes:', ...d.topNotes.map((n, i) => `${i + 1}. ${n.title} (${n.source}, noteId ${n.noteId})`));
    }
    if (d.beliefs) lines.push(`Dream consolidation: ${d.beliefs.written} beliefs written in ${d.beliefs.dreamRuns} run(s).`);
    if (Array.isArray(d.openQuestions) && d.openQuestions.length) {
      lines.push('Open questions worth asking:', ...d.openQuestions.map((q) => `- ${q.question}`));
    }
    return lines.join('\n');
  } catch (_) {
    return UNAVAILABLE_MSG;
  }
}

const CONTEXT_PASSAGE_MAX_CHARS = 600;

/**
 * brain_context (ONE-BRAIN CX2): token-budgeted pack of cited passages from
 * quoxbrain POST /brain/context. Read-only. Org/user come from ctx only.
 * Always resolves to { success, output, ... }; never throws. A non-2xx or
 * transport failure is reported as a failure, never as "nothing found".
 */
async function brainContext(input, ctx, { fetchImpl = fetch } = {}) {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (!query) return { success: false, error: 'missing_query', output: 'Missing required parameter: query' };
  if (!ctx?.orgId) return { success: false, error: 'no_org_context', output: 'No organisation context for this call, so the knowledge brain was not queried.' };
  const orgId = ctx.orgId;
  const tokenBudget = clampInt(input?.tokenBudget, 1200, 200, 4000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    let data;
    try {
      res = await fetchImpl(`${BRAIN_URL}/brain/context`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': SERVICE_KEY,
          'X-Org-Id': orgId,
          'X-Quox-Source': 'agent',
          ...(ctx.userId ? { 'X-User-Id': ctx.userId } : {}),
        },
        body: JSON.stringify({ query, tokenBudget }),
        signal: controller.signal,
      });
      if (!res || !res.ok) {
        const reason = res ? `http_${res.status}` : 'fetch_failed';
        emitBrainUnavailableAudit(ctx, orgId, reason);
        return { success: false, error: reason, output: `Knowledge brain context pack failed (${reason}). This is a failure, not an empty result.` };
      }
      data = await res.json();
    } catch (err) {
      const reason = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
      emitBrainUnavailableAudit(ctx, orgId, reason);
      return { success: false, error: reason, output: `Knowledge brain context pack failed (${reason}). This is a failure, not an empty result.` };
    }
    const passages = Array.isArray(data?.passages) ? data.passages : [];
    emitBrainSearchAudit(ctx, orgId, query.length, passages.length);
    if (data?.insufficient === true || passages.length === 0) {
      const ungrounded = data?.relevance?.ungrounded;
      const names = Array.isArray(ungrounded) ? ungrounded.filter(Boolean).join(', ') : (typeof ungrounded === 'string' ? ungrounded : '');
      return {
        success: true,
        insufficient: true,
        passages: [],
        tokensUsed: data?.tokensUsed ?? 0,
        output: `Nothing relevant was found in the knowledge brain for this topic.${names ? ` Not grounded in the brain: ${names}.` : ''}`,
      };
    }
    const lines = [`Context pack: ${passages.length} passage${passages.length !== 1 ? 's' : ''}, ${data.tokensUsed ?? '?'} tokens (budget ${tokenBudget}).`, ''];
    const structured = passages.map((p) => {
      const c = p.citation || {};
      return { noteId: p.noteId || c.noteId, title: c.title, relPath: c.relPath, charStart: c.charStart, charEnd: c.charEnd, text: p.text, score: p.score };
    });
    structured.forEach((p, i) => {
      let text = String(p.text || '').replace(/\s+/g, ' ').trim();
      if (text.length > CONTEXT_PASSAGE_MAX_CHARS) text = `${text.slice(0, CONTEXT_PASSAGE_MAX_CHARS).trimEnd()}...`;
      lines.push(`${i + 1}. ${p.title || 'Untitled'}`);
      lines.push(`   ${text}`);
      const span = Number.isFinite(p.charStart) && Number.isFinite(p.charEnd) ? `, chars ${p.charStart}-${p.charEnd}` : '';
      lines.push(`   (noteId: ${p.noteId || ''}${span})`);
      lines.push('');
    });
    lines.push(`Total: ${data.tokensUsed ?? '?'} tokens.`);
    return {
      success: true,
      insufficient: false,
      passages: structured.map(({ text, score, ...rest }) => rest),
      tokensUsed: data.tokensUsed,
      output: lines.join('\n').trim(),
    };
  } finally {
    clearTimeout(timer);
  }
}

const CHECK_MAX_CLAIM_CHARS = 500;
const CHECK_HEURISTIC_NOTE = 'Lexical support is a word-overlap heuristic, not proof. Read the cited note before relying on it.';

/**
 * brain_check (ONE-BRAIN CX4): check a claim against the knowledge brain
 * before asserting it. Read-only. Searches quoxbrain, then judges each
 * returned passage with the SAME helpers the citation trace uses:
 * lexicalSupport (lib/citationSupport.js) and, when the org opted in
 * (BRAIN_RERANK_ENABLED) and the seam is wired, the semantic entailment
 * checker from lib/citationEntailment.js (its own budget and fallback; any
 * failure keeps the lexical verdict). Verdict: contradicted | supported |
 * unknown. A brain that could not be reached is a failure, never "unknown".
 */
async function brainCheck(input, ctx, { fetchImpl = fetch, entailFn } = {}) {
  const claim = typeof input?.claim === 'string' ? input.claim.trim() : '';
  if (!claim) return { success: false, error: 'missing_claim', output: 'Missing required parameter: claim' };
  if (claim.length > CHECK_MAX_CLAIM_CHARS) {
    return { success: false, error: 'claim_too_long', output: `The claim is ${claim.length} characters; the limit is ${CHECK_MAX_CLAIM_CHARS}. Check one statement at a time.` };
  }
  if (!ctx?.orgId) return { success: false, error: 'no_org_context', output: 'No organisation context for this call, so the knowledge brain was not queried.' };
  const orgId = ctx.orgId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let data;
  try {
    let res;
    try {
      res = await fetchImpl(`${BRAIN_URL}/brain/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': SERVICE_KEY,
          'X-Org-Id': orgId,
          'X-Quox-Source': 'agent',
          ...(ctx.userId ? { 'X-User-Id': ctx.userId } : {}),
        },
        body: JSON.stringify({ query: claim, limit: 5, includeText: true, fullNoteMaxChars: 8000, fullNoteTopN: 3 }),
        signal: controller.signal,
      });
      if (!res || !res.ok) {
        const reason = res ? `http_${res.status}` : 'fetch_failed';
        emitBrainUnavailableAudit(ctx, orgId, reason);
        return { success: false, error: reason, output: `Knowledge brain check failed (${reason}). This is a failure, not an unknown verdict.` };
      }
      data = await res.json();
    } catch (err) {
      const reason = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
      emitBrainUnavailableAudit(ctx, orgId, reason);
      return { success: false, error: reason, output: `Knowledge brain check failed (${reason}). This is a failure, not an unknown verdict.` };
    }
  } finally {
    clearTimeout(timer);
  }

  const results = Array.isArray(data?.results) ? data.results : [];
  emitBrainSearchAudit(ctx, orgId, claim.length, results.length);
  const insufficient = data?.insufficient === true || data?.relevance?.insufficient === true;
  if (insufficient || results.length === 0) {
    return {
      success: true,
      verdict: 'unknown',
      method: 'lexical',
      evidence: [],
      output: 'Verdict: unknown. Nothing in the knowledge brain supports or refutes this claim, so do not state it as settled fact.',
    };
  }

  const items = results.slice(0, 5).map((r) => {
    const body = [r.noteBody, r.text, r.snippet].find((v) => typeof v === 'string' && v.trim()) || '';
    const passage = [r.title, body].filter(Boolean).join(' . ');
    const lex = body ? lexicalSupport(claim, passage) : { supported: false, contradicted: false };
    return { r, passage, body, lex };
  });

  // Optional semantic upgrade, same shape and fallback as brainCitationTrace.
  let method = 'lexical';
  const entail = typeof entailFn === 'function' ? entailFn : getEntailFn();
  const verdictOf = items.map((it) => (it.lex.contradicted ? 'contradicted' : it.lex.supported ? 'supported' : 'no_support'));
  if (entail) {
    try {
      const cand = items.map((it, i) => ({ it, i })).filter((c) => c.it.body);
      const verdicts = cand.length
        ? await entail({ orgId, items: cand.map((c) => ({ claim, passage: c.it.passage })) })
        : null;
      if (Array.isArray(verdicts)) {
        cand.forEach((c, k) => {
          const v = verdicts[k];
          if (!v) return;
          verdictOf[c.i] = v === 'SUPPORTED' ? 'supported' : v === 'CONTRADICTED' ? 'contradicted' : 'no_support';
          method = 'semantic';
        });
      }
    } catch (_) { /* keep lexical */ }
  }

  const evidence = items.map((it, i) => ({
    noteId: it.r.noteId,
    title: it.r.title,
    relPath: it.r.relPath,
    verdict: verdictOf[i],
    ...(it.lex.conditionDropped && verdictOf[i] === 'no_support' ? { conditionDropped: true } : {}),
  }));
  const contradicting = evidence.filter((e) => e.verdict === 'contradicted');
  const supporting = evidence.filter((e) => e.verdict === 'supported');
  const dropped = evidence.filter((e) => e.conditionDropped);
  const verdict = contradicting.length ? 'contradicted' : supporting.length ? 'supported' : 'unknown';
  const names = (list) => list.map((e) => `"${e.title || 'Untitled'}"${e.relPath ? ` (${e.relPath})` : ''}`).join(', ');
  const lines = [];
  if (verdict === 'contradicted') lines.push(`Verdict: contradicted. ${contradicting.length} source${contradicting.length !== 1 ? 's' : ''} in the knowledge brain contradict${contradicting.length === 1 ? 's' : ''} this claim: ${names(contradicting)}.`);
  else if (verdict === 'supported') lines.push(`Verdict: supported by ${names(supporting)}.`);
  else lines.push('Verdict: unknown. Nothing in the knowledge brain clearly supports or refutes this claim, so do not state it as settled fact.');
  if (verdict === 'contradicted' && supporting.length) lines.push(`Also supported by: ${names(supporting)}.`);
  if (dropped.length) lines.push(`Condition dropped: ${names(dropped)} limit${dropped.length === 1 ? 's' : ''} the statement (for example "only", "unless", "except") and the claim leaves that out, so it is not supported as written.`);
  lines.push(method === 'semantic' ? 'Method: semantic entailment (opt-in model check).' : `Method: lexical. ${CHECK_HEURISTIC_NOTE}`);
  return { success: true, verdict, method, evidence, output: lines.join('\n') };
}

// ONE-BRAIN CX6: plain-language reading of /brain/search `explain` for one note.
function explainSentence(data, noteId) {
  const ex = data?.explain;
  const t = ex?.target;
  if (!t) return 'The knowledge brain returned no explanation for this note.';
  if (t.status === 'in_results') {
    const p = (ex.perResult || []).find((x) => x.noteId === noteId) || {};
    const parts = [`rank ${t.rank}`];
    parts.push(p.sparseRank ? `keyword rank ${p.sparseRank}` : 'not in the keyword candidates');
    if (p.denseRank) parts.push(`vector rank ${p.denseRank}${p.denseCosine !== null && p.denseCosine !== undefined ? ` (cosine ${Number(p.denseCosine).toFixed(2)})` : ''}`);
    if (p.fusedScore !== null && p.fusedScore !== undefined) parts.push(`fused ${Number(p.fusedScore).toFixed(4)}`);
    if (p.kindPrior !== undefined) parts.push(`note prior ${p.kindPrior}`);
    let line = parts.join(', ');
    if (p.leggedHeadGuaranteed) line += '; held a reranker seat as a top keyword or vector hit';
    if (p.rerankPosition) line += `; reranker placed it at ${p.rerankPosition}`;
    else if (ex.rerank && ex.rerank !== 'off') line += `; reranker ${ex.rerank}`;
    return line;
  }
  return `not returned (${t.reason}): ${t.detail}${t.fusedRank ? `; fused rank ${t.fusedRank}` : ''}`;
}

// ONE-BRAIN CX6 provenance: "why does this code look like this" for a commit
// sha or a file path. Searches git commits, dev sessions and notes through the
// same /brain/search, then VERIFIES every hit's text contains the sha or path
// (ranking is never trusted).
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'fix', 'add', 'update', 'into', 'when', 'not']);
const hitText = (r) => [r.title, r.relPath, r.noteBody, r.text, r.snippet].filter((v) => typeof v === 'string').join('\n');
const hitDate = (r) => r.occurredAt || r.date || r.updatedAt || r.createdAt || null;

function classifyTarget(target) {
  const t = String(target || '').trim();
  if (SHA_RE.test(t)) return { type: 'sha', value: t.toLowerCase() };
  if (t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t)) return { type: 'path', value: t };
  return null;
}

function excerptAround(text, needle, width = 200) {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return '';
  const start = Math.max(0, i - Math.floor((width - needle.length) / 2));
  return text.slice(start, start + width).replace(/\s+/g, ' ').trim();
}

async function brainProvenance(input, ctx, { fetchImpl = fetch } = {}) {
  const cls = classifyTarget(input?.target);
  if (!cls) return { success: false, error: 'bad_target', output: 'target must be a commit sha (7-40 hex characters) or a file path (contains "/" or a file extension).' };
  if (!ctx?.orgId) return { success: false, error: 'no_org_context', output: 'No organisation context for this call, so the knowledge brain was not queried.' };
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': SERVICE_KEY,
    'X-Org-Id': ctx.orgId,
    'X-Quox-Source': 'agent',
    ...(ctx.userId ? { 'X-User-Id': ctx.userId } : {}),
  };
  const search = async (query, kinds) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${BRAIN_URL}/brain/search`, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ query, limit: 20, kinds, includeText: true, embedTimeoutMs: 4000 }),
      });
      if (!res || !res.ok) throw new Error(res ? `http_${res.status}` : 'fetch_failed');
      const data = await res.json();
      return Array.isArray(data?.results) ? data.results : [];
    } finally { clearTimeout(timer); }
  };
  const { type, value } = cls;
  const base = type === 'path' ? value.split('/').pop() : null;
  try {
    // 1. Commits
    const commitHits = await search(value, ['commit', 'git_commit']);
    const seen = new Set();
    const commits = [];
    for (const r of commitHits) {
      const text = hitText(r).toLowerCase();
      if (!text.includes(value.toLowerCase())) continue;
      if (seen.has(r.noteId)) continue;
      seen.add(r.noteId);
      const m = text.match(/commit:\s*([0-9a-f]{40})/);
      const sha = m ? m[1] : (String(r.title || '').match(/^([0-9a-f]{7,40})\b/i) || [])[1] || null;
      const subject = String(r.title || '').replace(/^[0-9a-f]{7,40}\s+/i, '');
      commits.push({ noteId: r.noteId, sha, shortSha: sha ? sha.slice(0, 7) : null, subject, date: hitDate(r) });
      if (commits.length >= 5) break;
    }
    // 2. Sessions
    const sessNeedles = type === 'sha' ? [value, value.slice(0, 7)] : [value, base];
    const sessionHits = await search(sessNeedles.join(' '), ['transcript_session']);
    const sessions = [];
    for (const r of sessionHits) {
      const text = hitText(r);
      const needle = sessNeedles.find((n) => text.toLowerCase().includes(n.toLowerCase()));
      if (!needle || seen.has(r.noteId)) continue;
      seen.add(r.noteId);
      sessions.push({ noteId: r.noteId, title: r.title || 'Untitled session', date: hitDate(r), excerpt: excerptAround(text, needle) });
      if (sessions.length >= 5) break;
    }
    // 3. Rationale
    const subjectWords = [...new Set(String(commits[0]?.subject || '').toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => w.length > 3 && !STOP.has(w)))];
    const ratQuery = [commits[0]?.subject, type === 'path' ? value : ''].filter(Boolean).join(' ') || value;
    const ratHits = await search(ratQuery, ['note', 'memory', 'quoxplan_note']);
    const decisions = [];
    for (const r of ratHits) {
      if (seen.has(r.noteId)) continue;
      const low = hitText(r).toLowerCase();
      const verbatim = type === 'sha' ? (low.includes(value) || low.includes(value.slice(0, 7))) : low.includes(value.toLowerCase());
      const wordMatch = subjectWords.some((w) => low.includes(w));
      if (!verbatim && !wordMatch) continue;
      seen.add(r.noteId);
      decisions.push({ noteId: r.noteId, title: r.title || 'Untitled', kind: r.kind || null, date: hitDate(r), possiblyRelated: !verbatim });
      if (decisions.length >= 3) break;
    }
    const d = (x) => (x ? String(x).slice(0, 10) : 'undated');
    const lines = [`Commits (${commits.length})`];
    if (!commits.length) lines.push(`  no commit in the brain mentions this ${type === 'sha' ? 'sha' : 'path'} (is the git feed connected?)`);
    for (const c of commits) lines.push(`  ${c.shortSha || '?'} ${c.subject} (${d(c.date)}, note ${c.noteId})`);
    lines.push(`Sessions (${sessions.length})`);
    if (!sessions.length) lines.push(`  no session mentions this ${type === 'sha' ? 'commit' : 'file'}`);
    for (const s of sessions) lines.push(`  ${s.title} (${d(s.date)}, note ${s.noteId})${s.excerpt ? `: ...${s.excerpt}...` : ''}`);
    lines.push(`Decisions and notes (${decisions.length})`);
    if (!decisions.length) lines.push('  no decision or note mentions this change');
    for (const n of decisions) lines.push(`  ${n.possiblyRelated ? '[possibly related] ' : ''}${n.title} (${n.kind || 'note'}, note ${n.noteId})`);
    return { success: true, mode: 'provenance', targetType: type, target: value, commits, sessions, decisions, output: lines.join('\n') };
  } catch (err) {
    const reason = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timeout' : (/^http_/.test(err?.message) ? err.message : 'fetch_failed');
    return { success: false, error: reason, output: `Knowledge brain provenance lookup failed (${reason}).` };
  }
}

async function brainWhy(input, ctx, { fetchImpl = fetch } = {}) {
  if (typeof input?.target === 'string' && input.target.trim() && !input?.query && !input?.noteId) {
    return brainProvenance(input, ctx, { fetchImpl });
  }
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  const noteId = typeof input?.noteId === 'string' ? input.noteId.trim() : '';
  if (!query) return { success: false, error: 'missing_query', output: 'Missing required parameter: query' };
  if (!noteId) return { success: false, error: 'missing_note_id', output: 'Missing required parameter: noteId' };
  if (!ctx?.orgId) return { success: false, error: 'no_org_context', output: 'No organisation context for this call, so the knowledge brain was not queried.' };
  const orgId = ctx.orgId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetchImpl(`${BRAIN_URL}/brain/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': SERVICE_KEY,
          'X-Org-Id': orgId,
          'X-Quox-Source': 'agent',
          ...(ctx.userId ? { 'X-User-Id': ctx.userId } : {}),
        },
        body: JSON.stringify({ query, limit: 10, explain: true, noteId, embedTimeoutMs: 4000 }),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err?.name === 'AbortError' || err?.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
      return { success: false, error: reason, output: `Knowledge brain explain failed (${reason}).` };
    }
    if (!res || !res.ok) {
      const reason = res ? `http_${res.status}` : 'fetch_failed';
      return { success: false, error: reason, output: `Knowledge brain explain failed (${reason}).` };
    }
    const data = await res.json();
    return { success: true, retrieval: data?.retrieval || null, target: data?.explain?.target || null, explain: data?.explain || null, output: explainSentence(data, noteId) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { quoxbrainSearch, quoxbrainRead, brainSuggestions, brainBrief, brainContext, brainCheck, brainWhy, brainProvenance, explainSentence, setAuditFn, UNAVAILABLE_MSG, NOTHING_RELEVANT_MSG };

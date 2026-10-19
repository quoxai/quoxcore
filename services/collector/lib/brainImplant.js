/**
 * Brain Implant Injection — QUOXBRAIN P2a (push)
 *
 * Mirrors services/collector/lib/memoryImplant.js's shape/conventions but
 * targets the quoxbrain service (a per-org knowledge brain: decisions,
 * docs, past conversations, governance, evidence) rather than the memory
 * service.
 *
 * At chat dispatch, best-effort fetch of the top relevant passages for the
 * current message from POST /brain/context (quoxbrain, default
 * http://quoxbrain:3106), via the TRUST-GATE-1.12a internal-service auth
 * (X-Service-Key + X-Org-Id). Formatted into a single, clearly-delimited
 * "[KNOWLEDGE CONTEXT]" block — a SEPARATE prompt slot from the existing
 * "[MEMORY CONTEXT]" (memoryImplant.js) so the two can be independently
 * A/B'd and one failing never affects the other.
 *
 * Feature-flagged, default OFF:
 *   QUOXBRAIN_IMPLANT_ENABLED — global kill-switch, default 'false'.
 *   QUOXBRAIN_IMPLANT_ORGS — comma-separated per-org rollout allowlist.
 *     Empty (or unset) means "all orgs" once the global switch is on.
 *
 * Degrades gracefully: flag off, brain service down/slow (~2.5s timeout),
 * non-2xx, or nothing relevant all resolve to '' — the chat turn proceeds
 * unaffected. Never throws.
 */

const { registerRetrieval, lookupHandles } = require('./brainCitationTrace.js');
const { citeInstruction } = require('./brainCiteInstruction.js');

const BRAIN_URL_DEFAULT = `http://${process.env.QUOXBRAIN_HOST || 'quoxbrain'}:${process.env.QUOXBRAIN_PORT || '3106'}`;
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || '';

const TIMEOUT_MS = 2500;
const DEFAULT_BUDGET = 800; // tokens
const CHARS_PER_TOKEN = 4; // rough approximation, same convention as memoryImplant.js

/**
 * Per-org feature gate. Global switch must be 'true'; when the per-org
 * allowlist is empty, every org is enabled (once the switch is on).
 */
function isImplantEnabled(orgId, env = process.env, resolveSetting = null) {
  // BRAIN2-V3 B4: a STORED org setting (Settings > Qortex) beats the env
  // default. resolveSetting(orgId) returns true/false for a stored override,
  // or null/undefined for "none stored" (env then decides, as before).
  let stored = null;
  if (typeof resolveSetting === 'function') {
    try { stored = resolveSetting(orgId); } catch { stored = null; }
  }
  const on = typeof stored === 'boolean' ? stored : env.QUOXBRAIN_IMPLANT_ENABLED === 'true';
  if (!on) return false;
  const orgsRaw = env.QUOXBRAIN_IMPLANT_ORGS || '';
  const orgs = orgsRaw.split(',').map(s => s.trim()).filter(Boolean);
  if (orgs.length === 0) return true;
  return orgs.includes(orgId);
}

/**
 * Truncate text to a char budget, cutting at the last full line boundary
 * within budget rather than mid-word/mid-line, with a visible marker.
 * (Identical convention to memoryImplant.js's truncateToCharBudget.)
 */
function truncateToCharBudget(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  const clean = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return `${clean}\n[...truncated]`;
}

/**
 * Format fetched brain passages into a single, clearly delimited
 * "[KNOWLEDGE CONTEXT]" block, hard-capped to maxChars. Returns '' when
 * there is nothing to inject.
 */
function formatBrainContextBlock(passages = [], maxChars = DEFAULT_BUDGET * CHARS_PER_TOKEN, handles = null) {
  const usable = (passages || []).filter(p => p && (p.text || '').trim());
  if (usable.length === 0) return '';

  const lines = ['[KNOWLEDGE CONTEXT]'];
  if (Array.isArray(handles) && handles.some(Boolean)) {
    lines.push(citeInstruction('K'));
  }
  for (const [i, p] of usable.entries()) {
    const h = Array.isArray(handles) && handles[i] ? `[${handles[i]}] ` : '';
    const text = p.text.replace(/\s+/g, ' ').trim();
    const title = p.citation?.title || p.title || '';
    lines.push(`- ${h}${text}${title ? `  (${title})` : ''}`);
  }
  const hasHandles = Array.isArray(handles) && handles.some(Boolean);
  // The instruction is repeated at the END (models weight the end), so reserve
  // room for it and the closing tag before truncating the passages.
  const tail = hasHandles ? [citeInstruction('K'), '[/KNOWLEDGE CONTEXT]'] : ['[/KNOWLEDGE CONTEXT]'];
  const tailText = '\n' + tail.join('\n');
  const reserve = tailText.length + '\n[...truncated]'.length;
  return truncateToCharBudget(lines.join('\n'), Math.max(0, maxChars - reserve)) + tailText;
}

/**
 * Fetch the top relevant passages for the current prompt from quoxbrain.
 * Never throws — returns [] on any failure (timeout, non-2xx, network
 * error) and logs the failure loudly.
 */
// quox#1108: outcome counters, so "the implant works" is provable from the
// collector rather than inferred from an absence of failure lines.
const implantStats = { injected: 0, empty: 0, failed: 0, timeouts: 0, lastOkAt: null, lastError: null, lastErrorAt: null };
function getImplantStats() { return { ...implantStats }; }
function _resetImplantStats() {
  Object.assign(implantStats, { injected: 0, empty: 0, failed: 0, timeouts: 0, lastOkAt: null, lastError: null, lastErrorAt: null });
}

// Proof qortex/implant-knowledge-cited: retrieval gets the information need, not the answer-format
// instructions around it ("answer from what you already know, in two sentences", "keep it short"). Those
// words matched a design doc's "open decisions" section and pushed the pricing ruling out of the context
// entirely. Only the search query changes; the model still sees the whole message. Never returns empty.
const DIRECTIVE_SENTENCE = /^(?:please\s+)?(?:answer|reply|respond|keep\s+(?:it|this|your\s+answer)|be\s+(?:brief|concise|short)|cite|use\s+(?:only\s+)?(?:what|your)|do\s*n[o']?t\s+(?:use|look|search)|no\s+tools?|in\s+(?:one|two|three|four|five|a\s+few|\d+)\s+(?:short\s+)?(?:sentences?|lines?|words?|bullets?|paragraphs?))\b[^?]*$/i;
const DIRECTIVE_PHRASES = [
  /\s*,?\s*\b(?:in|using)\s+(?:one|two|three|four|five|a\s+few|\d+)\s+(?:short\s+)?(?:sentences?|lines?|words?|bullet(?:\s+points?)?|paragraphs?)\b/gi,
  /\s*,?\s*\bfrom\s+what\s+you\s+(?:already\s+)?know\b/gi,
];
function retrievalQuery(message) {
  const raw = String(message || '');
  const sentences = raw.split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter(Boolean);
  const kept = sentences.filter((x) => !DIRECTIVE_SENTENCE.test(x));
  let q = kept.join(' ');
  for (const re of DIRECTIVE_PHRASES) q = q.replace(re, '');
  q = q.replace(/\s+([.?!,])/g, '$1').replace(/,([.?!])/g, '$1').trim();
  return q && /[a-z0-9]/i.test(q) ? q : raw;
}

async function fetchBrainContextDetailed({
  orgId,
  userId,
  query,
  budget = DEFAULT_BUDGET,
  brainServiceUrl = BRAIN_URL_DEFAULT,
  serviceKey = SERVICE_KEY_DEFAULT,
  fetchFn,
  timeoutMs = TIMEOUT_MS,
}) {
  const doFetch = fetchFn || globalThis.fetch;
  try {
    const resp = await doFetch(`${brainServiceUrl}/brain/context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': serviceKey,
        'X-Org-Id': orgId || 'default',
        // BRAIN2-NIGHT2: thread the real end-user id so quoxbrain resolves
        // user-scoped vaults instead of defaulting to user_id='service'
        ...(userId ? { 'X-User-Id': userId } : {}),
      },
      body: JSON.stringify({ query: retrievalQuery(query), tokenBudget: budget }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // BRAIN2-W7 E 120: keep failure distinct from empty.
    if (!resp.ok) {
      console.error(`[BrainImplant] context fetch failed (org=${orgId || 'default'}): quoxbrain answered ${resp.status}`);
      return { ok: false, reason: `http_${resp.status}`, passages: [] };
    }
    const data = await resp.json();
    return { ok: true, passages: data.passages || [] };
  } catch (err) {
    console.error(`[BrainImplant] context fetch failed (org=${orgId || 'default'}): ${err.message}`);
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'fetch_failed', passages: [] };
  }
}

async function fetchBrainContext(opts) {
  return (await fetchBrainContextDetailed(opts)).passages;
}

/**
 * BRAIN2-W7 E 119: how many leading passages survive formatBrainContextBlock's
 * budget truncation whole. Assumes the widest handle ("[K99] ") so the answer
 * is conservative: anything counted here is certain to reach the model.
 */
function countPassagesThatFit(passages, maxChars) {
  const usable = (passages || []).filter(p => p && (p.text || '').trim());
  const instr = citeInstruction('K');
  const tailLen = ('\n' + [instr, '[/KNOWLEDGE CONTEXT]'].join('\n')).length;
  const budget = Math.max(0, maxChars - (tailLen + '\n[...truncated]'.length));
  let used = ['[KNOWLEDGE CONTEXT]', instr].join('\n').length;
  let fit = 0;
  for (const p of usable) {
    const text = p.text.replace(/\s+/g, ' ').trim();
    const title = p.citation?.title || p.title || '';
    const line = `- [K99] ${text}${title ? `  (${title})` : ''}`;
    used += 1 + line.length;
    if (used > budget) break;
    fit += 1;
  }
  return fit;
}

/**
 * Build the brain implant for the current chat turn. Never throws — any
 * failure, or the flag being off for this org, degrades to '' (proceed
 * without knowledge context).
 */
async function buildBrainImplant({
  orgId,
  userId,
  query,
  budget = DEFAULT_BUDGET,
  brainServiceUrl = BRAIN_URL_DEFAULT,
  serviceKey = SERVICE_KEY_DEFAULT,
  fetchFn,
  timeoutMs = TIMEOUT_MS,
  corrKey,
  resolveSetting = null,
}) {
  try {
    if (!isImplantEnabled(orgId, process.env, resolveSetting)) return '';
    const started = Date.now();
    const fetched = await fetchBrainContextDetailed({ orgId, userId, query, budget, brainServiceUrl, serviceKey, fetchFn, timeoutMs });
    let passages = fetched.passages;
    // BRAIN2-AUDIT: register what the implant injected so finalizeAnswer
    // measures push turns too (they are the bulk of Qortex traffic). Same
    // key the dispatcher finalizes with; see the key trace in server.js.
    let handles = null;
    const usable = (passages || []).filter(p => p && (p.text || '').trim());
    const maxChars = budget * CHARS_PER_TOKEN;
    if (corrKey && !fetched.ok) {
      // BRAIN2-W7 E 120/121: an outage is not an empty brain.
      registerRetrieval(corrKey, { orgId, userId, status: 'unavailable', reason: fetched.reason, refs: [] });
    } else if (corrKey && usable.length === 0) {
      registerRetrieval(corrKey, { orgId, userId, status: 'empty', refs: [] });
    }
    if (corrKey && usable.length > 0) {
      // BRAIN2-W7 E 119: only passages that survive the budget are traced.
      const fit = countPassagesThatFit(usable, maxChars);
      passages = usable.slice(0, fit);
      if (fit === 0) registerRetrieval(corrKey, { orgId, userId, status: 'empty', refs: [] });
    }
    const traced = passages.filter(p => p && (p.text || '').trim());
    if (corrKey && traced.length > 0) {
      const refs = traced.map((p) => ({
        noteId: p.citation?.noteId || p.noteId,
        title: p.citation?.title || p.title,
        relPath: p.citation?.relPath,
        snippet: typeof p.text === 'string' ? p.text.slice(0, 300) : undefined,
        passage: typeof p.text === 'string' ? p.text : undefined,
        score: p.score,
        // BRAIN2-W5 116: keep the chunk's exact span (as recallSearch does) so
        // two passages of one note stay distinct and the citation points at it.
        charStart: p.citation?.charStart,
        charEnd: p.citation?.charEnd,
      }));
      registerRetrieval(corrKey, { orgId, userId, status: 'hits', handlePrefix: 'K', refs });
      handles = lookupHandles(corrKey, refs, { orgId, userId });
    }
    const block = formatBrainContextBlock(passages, budget * CHARS_PER_TOKEN, handles);
    if (!fetched.ok) {
      implantStats.failed++;
      if (fetched.reason === 'timeout') implantStats.timeouts++;
      implantStats.lastError = fetched.reason;
      implantStats.lastErrorAt = new Date().toISOString();
    } else if (block) {
      implantStats.injected++;
      implantStats.lastOkAt = new Date().toISOString();
      const n = passages.filter(p => p && (p.text || '').trim()).length;
      console.log(`[BrainImplant] injected ${n} passages, ${block.length} chars in ${Date.now() - started}ms org=${orgId || 'default'}`);
    } else {
      implantStats.empty++;
    }
    return block;
  } catch (err) {
    // Belt-and-braces: fetchBrainContext already catches its own errors,
    // but this must never propagate and fail the chat turn.
    console.error(`[BrainImplant] injection failed, proceeding without context: ${err.message}`);
    return '';
  }
}

/**
 * Set sanitizedContext.knowledge_context to the implant block. This is a
 * SEPARATE slot from memory_context — applyMemoryImplant's semantics
 * (supersede) do not apply here; when the implant is empty (flag off,
 * brain down/timeout, nothing relevant), the existing value (there never
 * is one from the frontend today) is left untouched so the chat turn
 * proceeds unaffected.
 */
function applyBrainImplant(sanitizedContext, implantBlock) {
  if (!implantBlock) return sanitizedContext;
  return { ...sanitizedContext, knowledge_context: implantBlock };
}

module.exports = {
  isImplantEnabled,
  retrievalQuery,
  fetchBrainContext,
  fetchBrainContextDetailed,
  truncateToCharBudget,
  formatBrainContextBlock,
  buildBrainImplant,
  applyBrainImplant,
  getImplantStats,
  _resetImplantStats,
  DEFAULT_BUDGET,
};

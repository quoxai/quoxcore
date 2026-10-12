/**
 * feedConversationSource.js — The Feed's F1 ingester (WP1,
 * docs/STREAM_QUOXBRAIN_FEED_PLAN.md).
 *
 * Pulls agent conversations (collector chat / AEE) into the brain's
 * "Conversations" push vault, incrementally: reuses
 * reflectionMiningScheduler.js's own incremental readers
 * (listIdleConversationsFn({orgId,after}) / getConversationEnvelopesFn({orgId,corr}))
 * rather than re-implementing an AEE query — production wiring (WP2's
 * scheduler + boot hook) passes the same reflectionMiningListIdleConversations
 * / reflectionMiningGetConversationEnvelopes functions server.js already
 * wires into runReflectionMining.
 *
 * Watermarked SEPARATELY from reflectionMiningWatermark.js — see
 * feedWatermark.js's header for why: The Feed and ReflectionMining both
 * consume the same conversations independently and must not share (or
 * clobber) each other's cursor.
 *
 * Best-effort throughout, mirroring reflectionMiningScheduler.js's
 * contract: this feeds a future background scheduler and must never
 * throw or abort the whole batch because one conversation's envelopes are
 * malformed — every per-conversation failure is caught, logged loudly,
 * and skipped.
 */

'use strict';

const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');

const SOURCE_TYPE = 'conversation';
const VAULT_NAME = 'Conversations';

// Same AEE intent strings reflectionMiningScheduler.js duplicates (not
// imported — this module has no dependency on frontend-only source).
const CHAT_QUERY_INTENT = 'quox.chat.query';
const JOB_SUBMIT_INTENT = 'quoxagent.job.submit';

// Per-message cap — mirrors transcriptReader.mjs's MAX_TURN_CHARS: a
// single giant chat message can't bloat the note past this many chars.
// BRAIN2-W7 A 044: raised from 4000 so decisions late in a long turn survive.
const MAX_MESSAGE_CHARS = 32000;
// Tool/job-result bulk (raw command output, which can run to megabytes)
// gets a short trimmed gist only — never the raw dump — mirroring how
// transcriptReader.mjs reduces tool_use/tool_result blocks to a one-line
// marker instead of holding onto the payload.
const MAX_TOOL_RESULT_CHARS = 300;

function truncate(text, max) {
  const str = String(text == null ? '' : text);
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n…[truncated]`;
}

/**
 * Reduces a single AEE envelope to a rendered {role, text} turn, or null
 * if the envelope carries no Feed-worthy signal (event/error/heartbeat/
 * approval envelopes — no direct analog in transcriptReader.mjs's
 * user/assistant split, so they're dropped here rather than guessed at).
 *
 * Genuine chat text (task+quox.chat.query / any result carrying
 * payload.text) is kept in full, trimmed to MAX_MESSAGE_CHARS. Job
 * submissions and their tool-result payloads are signal-only: a `[tool: ]`
 * marker for the command, a short trimmed gist for the output — never the
 * raw command/output payload, which is exactly the "bulk" the plan calls
 * out to trim.
 */
function renderEnvelopeAsTurn(env) {
  const payload = env.payload || {};

  if (env.type === 'task' && env.intent === CHAT_QUERY_INTENT && typeof payload.text === 'string' && payload.text.trim()) {
    return { role: 'user', text: truncate(payload.text.trim(), MAX_MESSAGE_CHARS) };
  }

  if (env.type === 'result' && typeof payload.text === 'string' && payload.text.trim()) {
    return { role: 'assistant', text: truncate(payload.text.trim(), MAX_MESSAGE_CHARS) };
  }

  if (env.type === 'task' && env.intent === JOB_SUBMIT_INTENT) {
    const cmd = typeof payload.command === 'string' && payload.command ? truncate(payload.command, 120) : 'job.submit';
    return { role: 'assistant', text: `[tool: ${cmd}]` };
  }

  if (env.type === 'result' && (typeof payload.output === 'string' || typeof payload.stdout === 'string')) {
    const gist = truncate(payload.output || payload.stdout, MAX_TOOL_RESULT_CHARS);
    return { role: 'assistant', text: `_tool result: ${gist}_` };
  }

  return null;
}

function deriveTitle(corr, turns) {
  const firstUser = turns.find((t) => t.role === 'user');
  if (firstUser && firstUser.text) return truncate(firstUser.text, 80).replace(/\s+/g, ' ').trim();
  return corr;
}

/**
 * Renders one conversation's envelopes into a single push-ingest document
 * (relPath conversation/<corr>.md, metadata source_type:'conversation').
 * Pure w.r.t. the brain — never calls the network.
 */
function renderConversation(corr, envelopes = []) {
  const sorted = [...envelopes].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const turns = sorted.map(renderEnvelopeAsTurn).filter(Boolean);
  const title = deriveTitle(corr, turns);
  // Zero signal-bearing turns: render a body-less marker doc (kept for
  // callers/tests that render directly). ingestConversations never pushes
  // it: a placeholder-only note has no recall value (51,100 of them
  // polluted one org's brain, 2026-10-05).
  const hasSignal = turns.length > 0;
  const body = hasSignal
    ? turns.map((t) => `**${t.role === 'user' ? 'You' : 'Assistant'}:** ${t.text}`).join('\n\n')
    : '_(no signal-bearing messages)_';

  return {
    relPath: `conversation/${corr}.md`,
    content: `# ${title}\n\n${body}`,
    title,
    kind: 'conversation',
    sourceType: SOURCE_TYPE,
    occurredAt: sorted.length ? sorted[sorted.length - 1].ts : new Date().toISOString(),
    hasSignal,
  };
}

/**
 * Ingests conversations strictly newer than The Feed's own conversation
 * watermark into the "Conversations" push vault, bounded to
 * `maxConversations` per call.
 *
 * @param {string} orgId
 * @param {{dryRun?: boolean, maxConversations?: number}} [opts]
 * @param {{
 *   listIdleConversationsFn: Function,   // ({orgId, after}) => Array<{corr, lastTs}>
 *   getConversationEnvelopesFn: Function, // ({orgId, corr}) => Array<envelope>
 *   getWatermarkFn?: Function,            // (orgId) => string|null
 *   setWatermarkFn?: Function,            // (orgId, ts) => void
 *   ensurePushVaultFn?: Function,         // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,           // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,                 // forwarded to the brain client (test injection)
 *   userId?: string,
 * }} deps
 * @returns {Promise<{conversationsRead: number, conversationsSkippedEmpty: number, docsPushed: number, error: string|null}>}
 */
async function ingestConversations(orgId, { dryRun = false, maxConversations = 50, scope = 'org', signal } = {}, deps = {}) {
  const {
    listIdleConversationsFn,
    getConversationEnvelopesFn,
    getWatermarkFn = (org) => feedWatermark.getWatermark(org, SOURCE_TYPE),
    setWatermarkFn = (org, ts) => feedWatermark.setWatermark(org, SOURCE_TYPE, ts),
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
    userId,
  } = deps;

  const result = { conversationsRead: 0, conversationsSkippedEmpty: 0, docsPushed: 0, error: null };

  // BRAIN2-W5 016: honour the stored scope. A user-scoped vault needs an owner;
  // a scheduled tick has none, so fail closed rather than widen to org.
  const vaultScope = scope === 'user' ? 'user' : 'org';
  if (vaultScope === 'user' && !userId) {
    result.skipped = 'user scope requires a user';
    return result;
  }

  if (typeof listIdleConversationsFn !== 'function' || typeof getConversationEnvelopesFn !== 'function') {
    result.error = 'missing required conversation reader dependencies';
    console.error(`[FeedConversationSource] org=${orgId}: ${result.error}`);
    return result;
  }

  let storedWatermark = null;
  try {
    storedWatermark = await getWatermarkFn(orgId);
  } catch (err) {
    console.error(`[FeedConversationSource] org=${orgId}: watermark read failed, treating as no watermark — ${err.message}`);
  }

  let conversations = [];
  try {
    conversations = (await listIdleConversationsFn({ orgId, after: feedWatermark.parseCursor(storedWatermark)?.ts || '' })) || [];
  } catch (err) {
    result.error = `list conversations failed — ${err.message}`;
    console.error(`[FeedConversationSource] org=${orgId}: ${result.error}`);
    return result;
  }

  // Strictly-after re-asserted here (defense in depth — the injected
  // reader's own "since" filtering may be inclusive at the boundary).
  // Compound (lastTs, corr) cursor (BRAIN2-V3 A4). The reader is given the
  // bare ts as `after`; a reader that is strictly-after at the boundary would
  // hide tied leftovers, so pass the cursor's ts and let this filter decide.
  const allEligible = conversations
    .filter((c) => feedWatermark.isAfterCursor(storedWatermark, c.lastTs, c.corr))
    .sort((a, b) => feedWatermark.compareByTsId({ ts: a.lastTs, id: a.corr }, { ts: b.lastTs, id: b.corr }));
  const eligible = allEligible.slice(0, maxConversations);
  const remaining = allEligible.slice(maxConversations).map((c) => ({ ts: c.lastTs, id: c.corr }));
  const processed = [];
  let remainingAfterFailure = null;

  if (eligible.length === 0) return result;

  const docs = [];
  let newWatermark = storedWatermark || null;

  for (let i = 0; i < eligible.length; i++) {
    const convo = eligible[i];
    try {
      const envelopes = (await getConversationEnvelopesFn({ orgId, corr: convo.corr })) || [];
      const doc = renderConversation(convo.corr, envelopes);
      result.conversationsRead++;
      if (doc.hasSignal) {
        const { hasSignal, ...pushable } = doc;
        docs.push(pushable);
      } else {
        result.conversationsSkippedEmpty++; // never pushed, but the watermark still moves past it
      }
      if (convo.lastTs) processed.push({ ts: convo.lastTs, id: convo.corr });
    } catch (err) {
      // BRAIN2-W5 026: stop at the first failed read. The cursor must not move
      // past it, or a transient error becomes a permanent hole; it and every
      // later item are retried next tick.
      console.error(`[FeedConversationSource] org=${orgId}: read of ${convo.corr} failed, stopping batch so it is retried — ${err.message}`);
      remainingAfterFailure = eligible.slice(i).map((c) => ({ ts: c.lastTs, id: c.corr }));
      if (processed.length === 0) result.error = `read failed for ${convo.corr} — ${err.message}`;
      break;
    }
  }

  newWatermark = feedWatermark.nextCursor(processed, remainingAfterFailure ? [...remainingAfterFailure, ...remaining] : remaining) || newWatermark;

  if (dryRun) return result; // tallies conversationsRead, pushes/advances nothing

  if (docs.length === 0) {
    // All-empty batch: nothing to push, but advance past them so the same
    // empty conversations are not re-read every tick forever.
    if (newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWatermarkFn(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedConversationSource] org=${orgId}: watermark write failed — ${err.message}`);
      }
    }
    return result;
  }

  try {
    const vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: vaultScope, userId, fetchImpl, signal });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedConversationSource] org=${orgId}: ${result.error} — not advancing watermark`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl, signal });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedConversationSource] org=${orgId}: push failed — ${pushResult.error} — not advancing watermark`);
      return result;
    }

    result.docsPushed = docs.length;

    if (newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWatermarkFn(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedConversationSource] org=${orgId}: watermark write failed — ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedConversationSource] org=${orgId}: ${result.error} — not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestConversations,
  renderConversation,
  renderEnvelopeAsTurn,
  truncate,
  SOURCE_TYPE,
  VAULT_NAME,
};

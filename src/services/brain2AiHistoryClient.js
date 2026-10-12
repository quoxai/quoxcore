/**
 * brain2AiHistoryClient — batches raw AI-chat-history exports (ChatGPT,
 * Claude, Gemini, Perplexity) up to Qortex's push vault via the collector's
 * Feed API (services/collector/lib/feedApiHandlers.js
 * createIngestAiHistoryHandler, mounted at POST /api/feed/ai-history).
 *
 * Mirrors brain2FeedClient.js: same `/collector/api/feed` proxy base, same
 * authFetch-carries-the-JWT pattern (no org_id passed from the frontend —
 * the handler resolves it from req.user.org_id, see feedApiHandlers.js
 * resolveOrgId()).
 *
 * This is the RAW export path: conversations are pushed to Qortex as-is
 * (source_type 'ai_history'), gated on the quox-brain2 plugin license. It
 * is separate from and does not change the Premium distill-to-QuoxMemory
 * path (importShared.js runImportPipeline / extractMemories), which stays
 * exactly as it was. See the "BRAIN2 HOOK" note near the bottom of this
 * file for the one-line call sites that wire the two importers up to this
 * client, once the import UI is ready for them.
 *
 * The server caps each request at 200 conversations per request (413 over
 * that cap) — see MAX_CONVERSATIONS_PER_REQUEST in feedApiHandlers.js.
 * sendConversationsToQortex() chunks the caller's full conversation list
 * into <=200-sized batches and posts them one request at a time,
 * accumulating pushed/skipped/redacted totals across all batches.
 */

import { isPluginLicensed } from './licenseValidator'

const PROXY_BASE = '/collector/api/feed'
const MAX_BATCH_SIZE = 200

/**
 * Whether the signed-in org is entitled to push raw AI-chat exports to
 * Qortex. Callers should check this before offering a "send raw to Qortex"
 * action anywhere in an import UI. The server enforces its own gate too —
 * this is only so the UI can show an honest state without round-tripping
 * a request first.
 * @returns {boolean}
 */
export function canSendToQortex() {
  return isPluginLicensed('quox-brain2')
}

function chunkConversations(conversations, size) {
  const batches = []
  for (let i = 0; i < conversations.length; i += size) {
    batches.push(conversations.slice(i, i + size))
  }
  return batches
}

/**
 * POST one batch to /collector/api/feed/ai-history. Never throws a silent
 * success — a non-2xx response always raises, carrying the server's error
 * message (or a status-based fallback if the body isn't JSON).
 */
async function postBatch(authFetch, batch, source) {
  const resp = await authFetch(`${PROXY_BASE}/ai-history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversations: batch, source }),
  })

  if (!resp.ok) {
    let body = {}
    try {
      body = await resp.json()
    } catch {
      // Non-JSON error body — fall through to the status-based message.
    }
    const excerpt = body?.error ? String(body.error).slice(0, 300) : `HTTP ${resp.status}`

    if (resp.status === 413) {
      throw new Error(`Qortex ai-history push rejected: batch too large (${batch.length} conversations) — ${excerpt}`)
    }
    throw new Error(`Qortex ai-history push failed: ${excerpt}`)
  }

  return resp.json()
}

/**
 * Push a full list of normalized conversations (the shape produced by
 * chatgptImporter.js normalizeConversation() / claudeImporter.js
 * normalizeClaudeConversation() — { title, messages: [{ role, content,
 * timestamp }], metadata }) to Qortex's raw AI-history vault, chunked into
 * <=200-conversation batches.
 *
 * @param {Array<object>} conversations - normalized conversations
 * @param {'chatgpt'|'claude'|'gemini'|'perplexity'} source
 * @param {object} [opts]
 * @param {Function} opts.authFetch - authenticated fetch (from useAuth()),
 *   same contract as every function in brain2FeedClient.js
 * @param {(progress: {done: number, total: number}) => void} [opts.onProgress]
 *   called once per batch with the running batch count
 * @returns {Promise<{pushed: number, skipped: number, redacted: number, batches: number}>}
 */
export async function sendConversationsToQortex(conversations, source, { authFetch, onProgress } = {}) {
  if (!authFetch) {
    throw new Error('sendConversationsToQortex requires an authFetch (see useAuth())')
  }
  if (!Array.isArray(conversations) || conversations.length === 0) {
    return { pushed: 0, skipped: 0, redacted: 0, batches: 0 }
  }

  const batches = chunkConversations(conversations, MAX_BATCH_SIZE)
  const totals = { pushed: 0, skipped: 0, redacted: 0, batches: batches.length }

  for (let i = 0; i < batches.length; i++) {
    const result = await postBatch(authFetch, batches[i], source)
    totals.pushed += result.pushed || 0
    totals.skipped += result.skipped || 0
    totals.redacted += result.redacted || 0

    if (onProgress) {
      onProgress({ done: i + 1, total: batches.length })
    }
  }

  return totals
}

// ============================================================================
// BRAIN2 HOOK: how to wire this into an import flow (owner has not reviewed
// the import-modal UX yet, so this stays a documented call site rather than
// a UI change).
//
// In chatgptImporter.js importConversations(data, options), once `normalized`
// has been built, add:
//
//   if (options.sendRawToQortex && options.authFetch && canSendToQortex()) {
//     results.brain2 = await sendConversationsToQortex(normalized, 'chatgpt', {
//       authFetch: options.authFetch,
//       onProgress: options.onBrain2Progress,
//     })
//   }
//
// In claudeImporter.js importClaudeConversations(file, options), same shape
// with source: 'claude'. Both call sites are additive — off by default,
// require an explicit authFetch AND the quox-brain2 license, and never
// touch the existing extractMemories/runImportPipeline path.
// ============================================================================

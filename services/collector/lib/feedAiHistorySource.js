/**
 * feedAiHistorySource.js — The Feed's AI-history ingester (BRAIN2-NIGHT2).
 * Routes user-uploaded ChatGPT/Claude/Gemini/Perplexity chat exports into
 * Qortex as raw retrievable notes (source_type 'ai_history'). QuoxDream
 * distills this raw layer downstream, later — this module is intentionally
 * a near-zero-transform ingest, mirroring feedMemorySource.js/
 * feedTranscriptSource.js's dependency-injection style so it is fully unit
 * testable without a live collector or brain.
 *
 * INPUT SHAPE: unlike feedTranscriptSource.js (reads host files itself),
 * this ingester takes an already-parsed array of conversations, each
 * matching src/services/chatgptImporter.js's normalizeConversation() shape:
 * `{ id, title, messages: [{ role, content, timestamp }], metadata: { createTime, ... } }`.
 * The browser (or a future collector-side import route) is responsible for
 * parsing the raw export file into this shape before calling ingestAiHistory.
 *
 * SECRET SAFETY: this is external, user-supplied data, not Quox's own
 * generated content — a chat export can contain anything the user pasted
 * into ChatGPT/Claude/Gemini/Perplexity, including live credentials.
 * redactSecrets() runs over every message body before it is ever rendered
 * into a doc, matching feedExcludeRegistry.js's secret vocabulary (secret,
 * credential, api_key, password, token) plus content-shaped patterns
 * (sk-... API keys, Bearer tokens, PEM private key blocks) that a
 * name-based column registry cannot catch because this is free text, not a
 * known db column. A conversation is never dropped wholesale for
 * containing a secret — only the offending substring is masked, so the
 * surrounding legitimate context survives.
 *
 * ONE-SHOT IMPORT, NO WATERMARK: unlike feedMemorySource.js/
 * feedTranscriptSource.js (autopilot loop, ticked repeatedly, watermarked
 * so each tick only pushes what's new), this ingester is user-triggered
 * once per uploaded export file. There is no "next tick" to watermark
 * against. Re-running the same export (the user re-uploads the same file,
 * or uploads an export that overlaps a previous one) is guarded instead by
 * an in-batch dedup key (conversation id, or title+createTime if the
 * source didn't supply a stable id) — see dedupeConversations(). This
 * catches re-imports of the SAME file within a single call; it does not
 * catch a re-import of the same file in a LATER call (no persistent
 * watermark/seen-set is kept). If that guarantee is needed later, add a
 * seen-conversation-id store the way feedWatermark.js does for the other
 * sources — out of scope for this ingest-library slice.
 */

'use strict';

const brainFeedClient = require('./brainFeedClient.js');

const SOURCE_TYPE = 'ai_history';
const VAULT_NAME = 'AI History';
const DEFAULT_MAX_ITEMS = 500;
const VALID_SOURCES = ['chatgpt', 'claude', 'gemini', 'perplexity'];

const REDACTED_PLACEHOLDER = '[REDACTED]';

// Content-shaped secret patterns (the values themselves, not column names —
// feedExcludeRegistry.js's SECRET_WORDS are table/column identifiers and
// don't apply to free-text chat bodies). Each captures the label + value so
// the label can stay visible ("password=" is useful context) while the
// value is masked.
const SECRET_PATTERNS = [
  // OpenAI/Anthropic/generic API keys: sk-..., sk-ant-..., sk-proj-...
  /\bsk-[a-zA-Z0-9_-]{10,}\b/g,
  // Bearer tokens
  /\bBearer\s+[a-zA-Z0-9._-]{10,}\b/gi,
  // password=/secret=/api_key=/apikey= style assignments (keep the label, mask the value)
  /\b(password|secret|api_key|apikey)\s*[:=]\s*["']?[^\s"']{3,}["']?/gi,
  // AWS access key IDs (AKIA long-term, ASIA temporary)
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // GitHub tokens (ghp_ personal, gho_/ghu_/ghs_/ghr_ oauth/app/refresh)
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Slack tokens (xoxb/xoxa/xoxp/xoxr/xoxs)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Masks secret-shaped substrings in `text` with a `[REDACTED]` placeholder,
 * leaving the rest of the text (including any assignment label like
 * "password=") intact. Never throws; a non-string input renders as ''.
 *
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  let str = String(text == null ? '' : text);
  for (const pattern of SECRET_PATTERNS) {
    str = str.replace(pattern, (match) => {
      const labelMatch = match.match(/^(password|secret|api_key|apikey)\s*[:=]\s*/i);
      return labelMatch ? `${labelMatch[0]}${REDACTED_PLACEHOLDER}` : REDACTED_PLACEHOLDER;
    });
  }
  return str;
}

/**
 * True if redacting `text` changed it, i.e. at least one secret pattern
 * fired — used to tally `result.redacted` per conversation.
 */
function containsSecret(text) {
  return redactSecrets(text) !== String(text == null ? '' : text);
}

/**
 * Renders a normalized conversation's messages as readable "role: content"
 * turns, one per line-pair, secrets already redacted per-message so a
 * redaction never bleeds across message boundaries.
 */
function renderMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => `${m.role || 'unknown'}: ${redactSecrets(m.content)}`)
    .join('\n\n');
}

/**
 * Stable identity key for a normalized conversation: prefers `id` (chat
 * exports carry a stable conversation/message id); falls back to
 * title+createTime when `id` is missing so a source without stable ids
 * still identifies reasonably. Used for the push-vault relPath only — see
 * dedupeConversations() for the actual dedup decision, which checks BOTH
 * id and title+createTime independently (a re-export can carry a fresh id
 * for the same conversation, or the same id with a re-titled export).
 */
function conversationKey(conversation) {
  if (conversation?.id) return `id:${conversation.id}`;
  const title = conversation?.title || '';
  const createTime = conversation?.metadata?.createTime || '';
  return `title:${title}|createTime:${createTime}`;
}

function titleTimeKey(conversation) {
  const title = conversation?.title || '';
  const createTime = conversation?.metadata?.createTime || '';
  return `title:${title}|createTime:${createTime}`;
}

/**
 * Drops later duplicates from `conversations`, preserving first-seen
 * order. A conversation is a duplicate of an earlier one if EITHER its
 * `id` matches an earlier conversation's id, OR its title+createTime pair
 * matches an earlier conversation's title+createTime — matching on
 * either is enough, since a re-run of the same export can resurface the
 * same conversation under a regenerated id while keeping the same title
 * and original creation time. See module header's ONE-SHOT IMPORT note for
 * what this in-batch guard does and does not catch.
 */
function dedupeConversations(conversations) {
  const seenIds = new Set();
  const seenTitleTime = new Set();
  const unique = [];
  let skipped = 0;
  for (const conversation of conversations) {
    const id = conversation?.id;
    const ttKey = titleTimeKey(conversation);
    // BRAIN2-W5 046: a conversation with a stable id is identified by that id
    // alone; title+createTime only identifies id-less conversations (distinct
    // chats routinely share a title and an absent createTime).
    const isDuplicate = id ? seenIds.has(id) : seenTitleTime.has(ttKey);
    if (isDuplicate) {
      skipped++;
      continue;
    }
    if (id) seenIds.add(id);
    else seenTitleTime.add(ttKey);
    unique.push(conversation);
  }
  return { unique, skipped };
}

/**
 * Renders one normalized conversation into a push-ingest document. Body is
 * the messages joined as "role: content" turns (redacted); provenance
 * (source, original createTime) is carried in `tags` the way
 * feedMemorySource.js/feedTranscriptSource.js tag their docs via `kind` +
 * `sourceType`, plus a `tags` array here for the extra source/createTime
 * provenance this source needs.
 *
 * @returns {{doc: object, hadSecret: boolean}}
 */
function renderConversationDoc(conversation, source) {
  const body = renderMessages(conversation.messages);
  const rawTitle = conversation.title || conversation.id || 'Untitled conversation';
  // BRAIN2-W5 047: the title lands in note metadata and body, so it is
  // redacted like every message.
  const title = redactSecrets(rawTitle);
  const hadSecret = (conversation.messages || []).some((m) => containsSecret(m.content)) || containsSecret(rawTitle);
  const createTime = conversation?.metadata?.createTime || null;

  const doc = {
    relPath: `ai_history/${source}/${conversation.id || conversationKey(conversation)}.md`,
    content: `# ${title}\n\n${body}`,
    title,
    kind: 'ai_history_conversation',
    sourceType: SOURCE_TYPE,
    occurredAt: createTime || new Date().toISOString(),
    tags: [source, 'ai_history'],
  };

  return { doc, hadSecret };
}

/**
 * Ingests an array of already-normalized AI-chat-export conversations
 * (see module header for the expected shape) into the "AI History" push
 * vault. One-shot, user-triggered (no watermark — see module header),
 * bounded to `maxItems` conversations, deduped within the batch, every
 * message secret-redacted before render.
 *
 * @param {string} orgId
 * @param {{
 *   conversations: Array<{id?:string, title?:string, messages: Array<{role:string, content:string, timestamp?:string|null}>, metadata?: {createTime?:string}}>,
 *   source: 'chatgpt'|'claude'|'gemini'|'perplexity',
 *   userId?: string,
 *   maxItems?: number,
 *   vaultScope?: string,
 * }} opts
 * @param {{
 *   ensurePushVaultFn?: Function,   // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,     // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,           // forwarded to the brain client (test injection)
 * }} [deps]
 * @returns {Promise<{ok: boolean, pushed: number, skipped: number, redacted: number, error: string|null}>}
 */
async function ingestAiHistory(orgId, opts = {}, deps = {}) {
  const result = { ok: false, pushed: 0, skipped: 0, redacted: 0, error: null };

  const {
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
  } = deps;

  const {
    conversations,
    source,
    userId,
    maxItems = DEFAULT_MAX_ITEMS,
    vaultScope = 'user',
  } = opts;

  if (!VALID_SOURCES.includes(source)) {
    result.error = `unsupported source "${source}" (expected one of ${VALID_SOURCES.join(', ')})`;
    console.error(`[FeedAiHistorySource] org=${orgId}: ${result.error}`);
    return result;
  }

  if (!Array.isArray(conversations) || conversations.length === 0) {
    result.ok = true;
    return result;
  }

  if (vaultScope === 'user' && !userId) {
    result.error = 'user scope import requires a userId';
    console.error(`[FeedAiHistorySource] org=${orgId}: ${result.error}`);
    return result;
  }

  try {
    const { unique, skipped: dedupSkipped } = dedupeConversations(conversations);
    const bounded = unique.slice(0, maxItems);
    if (unique.length > bounded.length) result.truncated = `${unique.length - bounded.length} of ${unique.length} conversation(s) not imported (maxItems=${maxItems}), re-send them`;

    const docs = [];
    let redacted = 0;
    for (const conversation of bounded) {
      const { doc, hadSecret } = renderConversationDoc(conversation, source);
      docs.push(doc);
      if (hadSecret) redacted++;
    }

    result.skipped = dedupSkipped;
    result.redacted = redacted;

    if (docs.length === 0) {
      result.ok = true;
      return result;
    }

    const vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: vaultScope, userId, fetchImpl });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedAiHistorySource] org=${orgId}: ${result.error}`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedAiHistorySource] org=${orgId}: push failed — ${pushResult.error}`);
      return result;
    }

    result.pushed = docs.length;
    result.ok = true;
    return result;
  } catch (err) {
    result.error = `ingest failed — ${err.message}`;
    console.error(`[FeedAiHistorySource] org=${orgId}: ${result.error}`);
    return result;
  }
}

module.exports = {
  ingestAiHistory,
  redactSecrets,
  containsSecret,
  renderMessages,
  renderConversationDoc,
  conversationKey,
  dedupeConversations,
  SOURCE_TYPE,
  VAULT_NAME,
  VALID_SOURCES,
  DEFAULT_MAX_ITEMS,
};

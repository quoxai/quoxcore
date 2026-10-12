/**
 * EVD-3: Content Redactor for volt_content persistence.
 *
 * Scrubs sensitive patterns before any plaintext reaches the evidence store.
 * Two modes:
 *   - Default (QUOX_CONTENT_CAPTURE_ENABLED unset): hash-only. buildContentRecord
 *     returns SHA-256 hashes and lengths — no plaintext. Sufficient for an
 *     auditor to verify "this exact prompt was sent" when they have the
 *     original conversation.
 *   - Full (QUOX_CONTENT_CAPTURE_ENABLED=true): includes redacted plaintext,
 *     truncated to MAX_CONTENT_SIZE. Redaction strips api keys, bearer tokens,
 *     password=, and PEM key blocks.
 *
 * The MAX_CONTENT_SIZE cap (10 000 chars) is a safety against a pathological
 * prompt blowing up the DB. Hashes are always computed on the full original
 * text (before truncation) so verification stays correct.
 *
 * MEM-INJECT fix: prompts/system_prompt commonly have context appended at
 * the END (e.g. the `[SELF-KNOWLEDGE]` block, memory context) — a plain
 * head-only truncation silently drops whatever was appended last, which
 * produced a false negative in live-verify (the debug capture "proved"
 * self-knowledge wasn't injected when it actually was — the plaintext just
 * never reached the record). truncateMiddle() below keeps both the head and
 * the tail of the text and drops only the middle, so appended trailing
 * blocks always survive into the debug capture. This only affects the
 * DEBUG plaintext capture (QUOX_CONTENT_CAPTURE_ENABLED=true) — the real
 * prompt sent to the model is never touched.
 */

const crypto = require('crypto');

const MAX_CONTENT_SIZE = 10_000;

// Patterns applied in order. Longer matches first so 'sk-ant-*' is caught
// before the more general 'sk-*' fallback.
const REDACTION_PATTERNS = [
  // PEM private/secret blocks — strip the whole body, keep the bookends
  {
    label: 'pem_key',
    pattern: /-----BEGIN (?:PRIVATE|RSA PRIVATE|EC PRIVATE|OPENSSH PRIVATE|ENCRYPTED PRIVATE) KEY-----[\s\S]*?-----END (?:PRIVATE|RSA PRIVATE|EC PRIVATE|OPENSSH PRIVATE|ENCRYPTED PRIVATE) KEY-----/gi,
    replacement: '[REDACTED:pem_key]',
  },
  // Anthropic API keys (sk-ant-…)
  {
    label: 'apikey',
    pattern: /\bsk-ant-[a-zA-Z0-9_-]{10,}/g,
    replacement: '[REDACTED:apikey]',
  },
  // Generic sk-* API keys (OpenAI, Stripe, etc.)
  {
    label: 'apikey',
    pattern: /\bsk-[a-zA-Z0-9_-]{16,}/g,
    replacement: '[REDACTED:apikey]',
  },
  // Bearer tokens
  {
    label: 'bearer',
    pattern: /\bBearer\s+[a-zA-Z0-9._\-+/=]{10,}/g,
    replacement: 'Bearer [REDACTED:bearer]',
  },
  // password= / passwd= / secret= / api_key= / apikey=
  {
    label: 'password',
    pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key)\s*[:=]\s*["']?[^\s"'&]{6,}["']?/gi,
    replacement: (match, field) => `${field}=[REDACTED:password]`,
  },
];

/**
 * Redact sensitive patterns from free-form text.
 * Safe on null/undefined/non-string input.
 */
function redactSensitive(input) {
  if (input === null || input === undefined) return '';
  let text = typeof input === 'string' ? input : (() => {
    try { return JSON.stringify(input); }
    catch { return String(input); }
  })();

  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Truncate text to a char budget while preserving BOTH the head and the
 * tail — only the middle is dropped. Prevents content appended at the end
 * of a long prompt (e.g. `[SELF-KNOWLEDGE]`, memory context blocks) from
 * being silently cut by a plain head-only truncation.
 *
 * Safe on maxChars too small to fit a marker: falls back to a head-only cut.
 */
function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return text;

  const marker = '\n[...TRUNCATED (middle omitted, head+tail preserved)...]\n';
  const available = maxChars - marker.length;

  if (available <= 0) {
    return text.slice(0, Math.max(0, maxChars)) + '[TRUNCATED]';
  }

  const headSize = Math.ceil(available / 2);
  const tailSize = Math.floor(available / 2);
  const head = text.slice(0, headSize);
  const tail = tailSize > 0 ? text.slice(text.length - tailSize) : '';
  return `${head}${marker}${tail}`;
}

/**
 * SHA-256 of a string, lowercase hex. Null/undefined hash to the empty-string
 * hash for consistency.
 */
function hashContent(input) {
  const text = input === null || input === undefined ? '' : String(input);
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

// Phase 25: set via configureContentRedactor({ voltDb }) at server boot so
// buildContentRecord can resolve an org's QUOX_CONTENT_CAPTURE_ENABLED
// override instead of env alone. Left null degrades to pure env behaviour
// (same as before this flag was settable) — never throws either way.
let _voltDb = null;
function configureContentRedactor({ voltDb } = {}) {
  _voltDb = voltDb || null;
}

/**
 * Build a content record for volt_content. Always includes hashes + lengths.
 * Plaintext included only when QUOX_CONTENT_CAPTURE_ENABLED resolves on
 * (org setting, else env default), always redacted and truncated.
 *
 * @param {object} parts - { system_prompt, user_message, model, round, message_count, org_id, ... }
 *   org_id, when the caller has it, lets this resolve an org-scoped setting
 *   override; it is never written into the returned record. Omitted, this
 *   falls back to the env default exactly as before Phase 25.
 * @returns {object} Content record to JSON-stringify and store in volt_content.content
 */
function buildContentRecord(parts = {}) {
  const { getEffectiveFlag } = require('./platformSettingsStore.js');
  const captureEnabled = getEffectiveFlag(_voltDb, parts.org_id || null, 'QUOX_CONTENT_CAPTURE_ENABLED').on;

  const record = {};

  if ('system_prompt' in parts) {
    const sp = parts.system_prompt || '';
    record.system_prompt_hash = hashContent(sp);
    record.system_prompt_length = sp.length;
    if (captureEnabled) {
      const redacted = redactSensitive(sp);
      record.system_prompt = truncateMiddle(redacted, MAX_CONTENT_SIZE);
    }
  }

  if ('user_message' in parts) {
    const um = parts.user_message || '';
    record.user_message_hash = hashContent(um);
    record.user_message_length = um.length;
    if (captureEnabled) {
      const redacted = redactSensitive(um);
      record.user_message = truncateMiddle(redacted, MAX_CONTENT_SIZE);
    }
  }

  // Pass-through metadata fields (no redaction — these are safe identifiers)
  for (const key of ['model', 'round', 'message_count', 'provider', 'tool_name', 'agent_id']) {
    if (key in parts && parts[key] !== undefined) {
      record[key] = parts[key];
    }
  }

  // Tool I/O hashes
  if ('tool_input' in parts) {
    const input = parts.tool_input;
    const serialized = typeof input === 'string' ? input : JSON.stringify(input || {});
    record.tool_input_hash = hashContent(serialized);
    record.tool_input_keys = input && typeof input === 'object' ? Object.keys(input) : [];
    if (captureEnabled) {
      const redacted = redactSensitive(serialized);
      record.tool_input_preview = redacted.length > 500 ? redacted.slice(0, 500) + '[TRUNCATED]' : redacted;
    }
  }

  if ('tool_output' in parts) {
    const output = parts.tool_output;
    const serialized = typeof output === 'string' ? output : JSON.stringify(output || {});
    record.tool_output_hash = hashContent(serialized);
    record.tool_output_length = serialized.length;
    record.tool_output_success = output?.success !== false;
    if (captureEnabled && serialized.length < 4096) {
      const redacted = redactSensitive(serialized);
      record.tool_output_preview = redacted.length > 500 ? redacted.slice(0, 500) + '[TRUNCATED]' : redacted;
    }
  }

  return record;
}

module.exports = {
  redactSensitive,
  hashContent,
  buildContentRecord,
  configureContentRedactor,
  truncateMiddle,
  MAX_CONTENT_SIZE,
  REDACTION_PATTERNS,
};

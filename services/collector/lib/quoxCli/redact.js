'use strict';
/**
 * QUOXON-ASK lane J: what a quox_cli call returns to the model.
 *
 * Layered, strictest first:
 *  1. Leaves that print credentials are NEVER run (policy.js), so the redactor is the
 *     second line, not the first.
 *  2. The caller's own bearer is removed by exact value (it is the one secret the run
 *     is guaranteed to hold).
 *  3. Every string passes the CLI's own token scrubber (SCRUBS mirrors
 *     cli/lib/quoxon/transcript.js; test/quoxCliTool.test.js pins the two in lockstep).
 *  4. Parsed JSON is walked to any depth and every value under a credential-shaped key
 *     is replaced, so a nested access_token cannot slip through the way a top-level
 *     filter let one through on 2026-08-09.
 * Output is capped before parsing (the runner stops reading at the cap).
 */

// Lockstep copy of cli/lib/quoxon/transcript.js SCRUBS (the CLI is ESM and ships in a
// different image path, so it is mirrored here and drift-pinned by a test).
const SCRUBS = [
  [/eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g, '[redacted-jwt]'],
  [/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted-key]'],
  [/\b(?:ghp|gho|ghs|xox[abp]|qsk|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted-key]'],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|service[_-]?key|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]'],
];

// Key names whose VALUE is a credential, matched on whole word parts at any depth.
const SECRET_KEY_RE = /(^|[_-])(password|passwd|secret|token|tokens|apikey|api_key|api-key|private_key|privatekey|client_secret|authorization|cookie|credential|credentials|session_key|service_key|bearer|jwt|otp|totp|backup_codes|recovery_codes|seed|mnemonic|passphrase)($|[_-])/i;
// Keys that look secret-shaped but are counts or metadata (max_tokens, token_count...).
const SAFE_KEY_RE = /(^|[_-])(count|counts|max|min|limit|in|out|used|total|budget|expires|expiry|expires_at|type|types|id|ids|name|names|kind|hint|prefix|last4|fingerprint|status|ttl|scope|scopes)($|[_-])/i;

const REDACTED = '[redacted]';

function scrubString(s, exactSecrets = []) {
  let out = String(s);
  for (const secret of exactSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted-caller-token]');
  }
  for (const [re, rep] of SCRUBS) out = out.replace(re, rep);
  return out;
}

function isSecretKey(k) {
  const key = String(k);
  return SECRET_KEY_RE.test(key) && !SAFE_KEY_RE.test(key);
}

function redactValue(v, exactSecrets, depth = 0) {
  if (depth > 40) return '[truncated-depth]';
  if (typeof v === 'string') return scrubString(v, exactSecrets);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, exactSecrets, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      o[k] = isSecretKey(k) && x !== null && typeof x !== 'boolean' && typeof x !== 'number' ? REDACTED : redactValue(x, exactSecrets, depth + 1);
    }
    return o;
  }
  return v;
}

/**
 * -> { output: parsed-and-redacted JSON | redacted text, format: 'json'|'text', bytes, truncated }
 */
function redactOutput(stdout, { exactSecrets = [], truncated = false } = {}) {
  const text = String(stdout || '');
  const bytes = Buffer.byteLength(text);
  if (!truncated) {
    const trimmed = text.trim();
    if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        return { output: redactValue(JSON.parse(trimmed), exactSecrets), format: 'json', bytes, truncated: false };
      } catch { /* not JSON: fall through to text */ }
    }
  }
  return { output: scrubString(text, exactSecrets), format: 'text', bytes, truncated };
}

module.exports = { SCRUBS, scrubString, redactValue, redactOutput, isSecretKey };

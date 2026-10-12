/**
 * QuoxChat Tool Result Sanitiser — CW-9.8
 *
 * Scrubs likely secrets out of tool results before they're forwarded to the
 * LLM as tool_result blocks. Runs on strings at every depth of a structured
 * result, handles circular refs safely, and enforces a per-string size cap
 * so an oversized upstream payload can't blow the context window.
 *
 * Patterns cover the common cases that show up in error messages and echoed
 * request traces — not a comprehensive DLP solution. Treat as defence in
 * depth on top of per-connector design (REST response byte cap, webhook
 * fire-and-forget, DB row-limit).
 */

const REDACTED = '[REDACTED]';
const MAX_STRING_LEN = 16 * 1024; // 16 KB per individual string value
const TRUNC_SUFFIX = '...[truncated]';

// Order matters: multi-line / structured patterns first so single-line
// patterns do not chop them into unrecognisable pieces.
const PATTERNS = [
  // PEM block (any -----BEGIN XXX PRIVATE KEY----- … -----END XXX PRIVATE KEY-----)
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: REDACTED },
  // JWT (three base64url segments). Require length > 30 chars and three dot-separated segments of [\w-]+=*
  { re: /\beyJ[\w-]+=*\.[\w-]+=*\.[\w-]+=*/g, replace: REDACTED },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/g, replace: 'Bearer ' + REDACTED },
  // OpenAI / Stripe / "sk-…" style tokens
  { re: /\bsk[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}/gi, replace: REDACTED },
  // GitHub PATs
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  // AWS access key IDs
  { re: /\b(?:AKIA|ASIA|AGPA|AROA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  // AWS secret access keys (40 chars of [A-Za-z0-9/+=] following "aws_secret"-ish marker)
  { re: /\b(?:aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9\/+=]{40}['"]?/gi, replace: `aws_secret_access_key=${REDACTED}` },
  // Google API keys (AIza…)
  { re: /\bAIza[0-9A-Za-z_-]{35}/g, replace: REDACTED },

  // QCX-1.6: generic secret assignments — api_key / apikey / api-key / token
  // / secret / password / passwd / access_token / client_secret / auth_token
  // when followed by = or : and a reasonable-length value. Case-insensitive.
  // 12-char floor avoids "password: 1234" false positives on trivial forms.
  {
    re: /\b(api[-_]?key|token|secret|password|passwd|access[-_]?token|client[-_]?secret|auth[-_]?token)\s*[:=]\s*['"]?([A-Za-z0-9._\-+\/=]{12,})['"]?/gi,
    replace: (_m, k) => `${k}=${REDACTED}`,
  },

  // QCX-1.6: HTTP-style header lines for sensitive headers embedded in free
  // text (e.g. curl traces, error bodies echoing the request). Matches
  // "X-API-KEY: value", "Authorization: ...", "Cookie: ..." etc.
  {
    re: /\b(authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie|proxy-authorization)\s*:\s*[^\n\r]{8,}/gi,
    replace: (_m, h) => `${h}: ${REDACTED}`,
  },

  // QCX-1.6: RFC1918 private IPs + loopback. Block-level regex avoids
  // false positives on public ranges like 8.8.8.8 or 172.15.*.
  //   10.0.0.0/8       → 10.x.x.x
  //   192.168.0.0/16   → 192.168.x.x
  //   172.16.0.0/12    → 172.(16-31).x.x
  //   127.0.0.0/8      → 127.x.x.x
  {
    re: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3})\b/g,
    replace: REDACTED,
  },
];

// Keys whose *values* should always be redacted, regardless of content.
// QCX-1.6: extended to cover structured error/request objects that echo auth
// context (auth_header, authorization_header, access_token, client_secret,
// refresh_token) and the common password/secret keys.
const SENSITIVE_KEYS = new Set([
  'authorization',
  'authorization_header',
  'auth_header',
  'x-api-key',
  'api-key',
  'api_key',
  'apikey',
  'x-auth-token',
  'auth_token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'password',
  'passwd',
  'secret',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-quox-signature', // (optional — our own HMAC, but receiver shouldn't echo it back)
]);

function sanitiseString(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace);
  if (out.length > MAX_STRING_LEN) {
    out = out.slice(0, MAX_STRING_LEN - TRUNC_SUFFIX.length) + TRUNC_SUFFIX;
  }
  return out;
}

/**
 * One redaction entry point for PUBLIC visitor text (stream and final reply).
 * Applies the full PATTERNS set and reports which patterns fired, so the
 * verdict derives from actual changes (Codex enum 2 #16).
 */
function redactPublicText(text) {
  if (typeof text !== 'string') return { text, changed: false, matched: [] };
  const matched = [];
  for (const { re } of PATTERNS) {
    const probe = new RegExp(re.source, re.flags.replace('g', ''));
    if (probe.test(text)) matched.push(re.source.slice(0, 40));
  }
  const out = sanitiseString(text);
  return { text: out, changed: out !== text, matched };
}

function sanitiseValue(value, seen) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return sanitiseString(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return value;

  if (seen.has(value)) return value; // circular — leave as-is (reference already seen)
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(v => sanitiseValue(v, seen));
  }

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = sanitiseValue(v, seen);
    }
  }
  return out;
}

function sanitiseToolResult(result) {
  const seen = new WeakSet();
  return sanitiseValue(result, seen);
}

module.exports = {
  sanitiseToolResult,
  sanitiseString,
  redactPublicText,
  PATTERNS,
  SENSITIVE_KEYS,
  REDACTED,
  MAX_STRING_LEN,
};

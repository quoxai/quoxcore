// Secret redaction at Brain2's own ingest and capture chokepoints
// (ONE-BRAIN CX1, 2026-10-09 audit dry run). Several collector feeds redacted
// before pushing, but direct capture (`quox brain add`, Cortex brain_save),
// folder, Obsidian, docs and git content reached the index verbatim and was
// then sent to the embedding provider. Same patterns as the collector's
// feedAiHistorySource.js redactSecrets (a parity test keeps them in step).
export const REDACTED_PLACEHOLDER = '[REDACTED]'

export const SECRET_PATTERNS = [
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
  // Hardening (BRAIN2-FABLE12): JWTs (header always starts eyJ)
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  // Stripe secret/restricted keys and webhook signing secrets
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bwhsec_[A-Za-z0-9]{10,}\b/g,
  // Twilio account SIDs (AC), API keys (SK) and auth_token assignments (32 hex)
  /\b(?:AC|SK)[0-9a-f]{32}\b/g,
  /auth_?token\s*[:=]\s*["']?[0-9a-f]{32}\b["']?/gi,
  // Credentials embedded in connection URLs: mask only the password, keep scheme/user/host
  /(?<=\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@\/]+:)[^\s@\/]+(?=@)/gi,
  // PGP private key blocks (OpenSSH blocks are already covered by the PEM pattern)
  /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/g,
]

/** Masks secret-shaped substrings; keeps an assignment label visible. Never throws. */
export function redactSecrets(text) {
  let str = String(text == null ? '' : text)
  for (const pattern of SECRET_PATTERNS) {
    str = str.replace(pattern, (match) => {
      const labelMatch = match.match(/^(password|secret|api_key|apikey)\s*[:=]\s*/i)
      return labelMatch ? `${labelMatch[0]}${REDACTED_PLACEHOLDER}` : REDACTED_PLACEHOLDER
    })
  }
  return str
}

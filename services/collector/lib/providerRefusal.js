'use strict';
/**
 * A provider refusal on the Claude CLI path (the subscription hit a limit, or the provider refused the turn) is a
 * FAILED turn with a provider error code, never an answer (WORKER2, 2026-10-16: a weekly limit came back as a
 * completed turn, quox.chat.stream_success). Reads the plain reason lib/cliFailureReason.js builds from the CLI's
 * own output, so the two can never disagree.
 * @returns {null | {code:'provider_limit', kind:string, resets_at:string|null, message:string} | {code:'provider_refused', message:string}}
 */
const LIMIT_RE = /has hit its (weekly|5-hour|usage) limit(?:, which resets (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC)?/i;
const REFUSED_RE = /^The AI provider refused the turn\b/;

function providerRefusalFrom(reason) {
  const text = String(reason || '').trim();
  if (!text) return null;
  const m = LIMIT_RE.exec(text);
  if (m) return { code: 'provider_limit', kind: m[1].toLowerCase(), resets_at: m[2] ? `${m[2]}T${m[3]}:00Z` : null, message: text.slice(0, 400) };
  if (REFUSED_RE.test(text)) return { code: 'provider_refused', message: text.slice(0, 400) };
  return null;
}

/** Fields an error exit adds to its error event and AEE payload (only for a refusal; nothing otherwise). */
function providerErrorFields(err) {
  if (!err || (err.code !== 'provider_limit' && err.code !== 'provider_refused')) return {};
  return { code: err.code, ...(err.resets_at ? { resets_at: err.resets_at } : {}), ...(err.kind ? { limit: err.kind } : {}) };
}

module.exports = { providerRefusalFrom, providerErrorFields };

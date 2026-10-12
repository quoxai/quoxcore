/**
 * AOCL-FULL-6 — L9 assemble.respond.
 *
 * Takes the raw response captured on C5.llmResponse by L7 (or the pre-canned
 * response from aoclCtx.halt for L2 fast-paths) and produces the final
 * user-facing message. Optional redaction, tone adaptation, and voice-summary
 * generation are all injected hooks — the module is pure and testable.
 *
 * Outputs (all on C5):
 *   - finalResponse: string — what the user/API caller sees
 *   - voiceSummary:  string — short form for TTS (optional)
 *
 * Denial handling: if an upstream layer stamped ctx.status='denied', L9
 * produces a denial message instead of shaping the (likely empty) LLM output,
 * so the audit trail and the response stay consistent.
 */

const DEFAULT_VOICE_MAX_CHARS = 200;

/** Build a short TTS-friendly summary from the full response. */
function buildVoiceSummary(text, maxChars = DEFAULT_VOICE_MAX_CHARS) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Prefer first sentence boundary if within budget
  const firstSentenceMatch = trimmed.match(/^[^.!?\n]*[.!?]/);
  if (firstSentenceMatch && firstSentenceMatch[0].length <= maxChars) {
    return firstSentenceMatch[0].trim();
  }
  // Otherwise truncate with ellipsis
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

/** Append a compact tool-usage suffix so the user sees what ran. */
function applyToolSuffix(response, toolsUsed) {
  if (!Array.isArray(toolsUsed) || toolsUsed.length === 0) return response;
  const names = toolsUsed
    .map(t => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean);
  if (names.length === 0) return response;
  return `${response}\n\n_Tools used: ${names.join(', ')}_`;
}

/** Produce a denial message when ctx.status === 'denied'. */
function buildDenialMessage(aoclCtx) {
  const layer = aoclCtx.deniedAtLayer || 'policy';
  const reason = aoclCtx.firstDenialReason || 'policy_violation';
  return `This request was blocked by policy (${layer}: ${reason}).`;
}

/**
 * Run the L9 assembler.
 *
 * @param {object} aoclCtx
 * @param {object} [opts]
 * @param {number} [opts.voiceMaxChars]  cap on voice summary length
 * @param {(response, aoclCtx) => Promise<string>|string} [opts.redact]
 *        optional redactor — receives response text, returns redacted text.
 * @param {(response, aoclCtx) => Promise<string>|string} [opts.toneAdapter]
 *        optional tone/formatting pass over the final response.
 */
async function runL9(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const c5 = aoclCtx.C5 || (aoclCtx.C5 = {});

  let denial = false;
  let base;
  if (aoclCtx.status === 'denied') {
    base = buildDenialMessage(aoclCtx);
    denial = true;
  } else if (aoclCtx.halt && typeof aoclCtx.halt.response === 'string') {
    base = aoclCtx.halt.response;
  } else if (typeof c5.llmResponse === 'string') {
    base = c5.llmResponse;
  } else {
    base = '';
  }

  let response = base;

  // Tool suffix (after dispatch, before redaction)
  response = applyToolSuffix(response, c5.toolsUsed);

  // Redaction hook
  if (typeof opts.redact === 'function') {
    try {
      const redacted = await opts.redact(response, aoclCtx);
      if (typeof redacted === 'string') response = redacted;
    } catch {
      // Redaction errors never fail the layer
    }
  }

  // Tone / formatting hook
  if (typeof opts.toneAdapter === 'function') {
    try {
      const adapted = await opts.toneAdapter(response, aoclCtx);
      if (typeof adapted === 'string') response = adapted;
    } catch {
      // Tone errors never fail the layer
    }
  }

  c5.finalResponse = response;

  const voiceMaxChars = opts.voiceMaxChars ?? DEFAULT_VOICE_MAX_CHARS;
  c5.voiceSummary = buildVoiceSummary(response, voiceMaxChars);

  const toolsUsedCount = Array.isArray(c5.toolsUsed) ? c5.toolsUsed.length : 0;

  return {
    proceed: true,
    extras: {
      response_length: response.length,
      voice_summary_length: (c5.voiceSummary || '').length,
      tools_used_count: toolsUsedCount,
      model: c5.model || null,
      denial,
      duration_ms: Date.now() - startedAt,
    },
  };
}

module.exports = {
  runL9,
  buildVoiceSummary,
  applyToolSuffix,
  DEFAULT_VOICE_MAX_CHARS,
};

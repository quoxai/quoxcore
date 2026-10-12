/**
 * AOCL-FULL-4 — L0 ingress.normalize.
 *
 * First layer of the pipeline. Responsibilities per AOCL spec §L0:
 *   - Normalize the incoming event (source + channel metadata)
 *   - Populate aoclCtx.C0 with canonical fields
 *   - Compute a stable hash of the raw user input (for evidence chain)
 *   - Decide a parsed_intent hint (rough pattern classification) that
 *     downstream layers (L2 smart router) can use
 *
 * Pure module: takes aoclCtx, returns LayerResult, never throws.
 *
 * Source label semantics: the caller (setupPipelinePhase or legacy flow)
 * should already have set aoclCtx.C0.source/channel. L0 re-normalises
 * those values against a whitelist, fills missing fields, and records
 * the input hash.
 */

const crypto = require('crypto');

const KNOWN_SOURCES = [
  'chat',
  'sse',
  'widget',
  'webhook.telegram',
  'webhook.slack',
  'webhook.discord',
  'resolve-plan',
  'cli',
  'unknown',
];

/** Quick intent hint from raw prompt — rules only, no LLM. */
function parseIntentHint(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'empty';
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return 'empty';
  if (/^(help|what can you do|who are you)\b/i.test(trimmed)) return 'meta.help';
  if (/^(status|health|ok\?)\b/i.test(trimmed)) return 'meta.status';
  if (/^(list|show|get|find)\b/i.test(trimmed)) return 'query.list';
  if (/^(create|add|make|new)\b/i.test(trimmed)) return 'action.create';
  if (/^(delete|remove|kill|destroy)\b/i.test(trimmed)) return 'action.delete';
  if (/^(run|exec|execute|start)\b/i.test(trimmed)) return 'action.execute';
  if (/^(why|how|what|explain)\b/i.test(trimmed)) return 'question';
  return 'unstructured';
}

/** L0 run function — conforms to the pipeline LayerResult contract. */
async function runL0(aoclCtx) {
  if (!aoclCtx) return { proceed: true };

  // C0 should exist from buildAoclContext; we re-normalise.
  const c0 = aoclCtx.C0 || (aoclCtx.C0 = {});
  const rawSource = c0.source || 'unknown';
  const source = KNOWN_SOURCES.includes(rawSource) ? rawSource : 'unknown';
  const channel = c0.channel || null;

  const rawPrompt = aoclCtx.C2?.rawUserPrompt || aoclCtx.query || '';
  const rawHash = rawPrompt
    ? crypto.createHash('sha256').update(rawPrompt).digest('hex')
    : null;
  const parsedIntent = parseIntentHint(rawPrompt);

  // Populate C0 canonical fields
  c0.source = source;
  c0.channel = channel;
  c0.rawInputHash = rawHash;
  c0.parsedIntent = parsedIntent;
  c0.promptLength = rawPrompt.length;
  // hasAttachments stays whatever the caller set (default false)

  return {
    proceed: true,
    extras: {
      source,
      channel,
      parsed_intent: parsedIntent,
      raw_input_hash: rawHash,
      prompt_length: rawPrompt.length,
      has_attachments: !!c0.hasAttachments,
    },
  };
}

module.exports = {
  runL0,
  parseIntentHint,
  KNOWN_SOURCES,
};

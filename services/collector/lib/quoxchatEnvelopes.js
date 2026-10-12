/**
 * QCX-2.1 — QuoxChat AEE envelope taxonomy + builder.
 *
 * Previously the widget emitted one intent (`quoxchat.message`) for the whole
 * conversation turn — no sub-events, no causality chain, no visitor
 * correlation across page loads. Activity Centre saw a flat list of terminal
 * events with no trace.
 *
 * This module codifies the canonical widget-event taxonomy + a builder that
 * enforces a consistent shape. Routes in quoxchat.js emit these via the
 * injected storeAuditEnvelope hook; the builder is pure (no side effects)
 * which keeps it trivially testable.
 *
 * Correlation model:
 *   - corr defaults to visitor_id — every event in a visitor's session
 *     threads under the same corr.
 *   - Explicit corr override is supported (e.g. use CONV_* once a
 *     conversation is in flight, when chain granularity should narrow).
 *   - reply_to points to the immediate parent event id (parent-child).
 *     The route emits a SCENARIO_RUN parent, then children like
 *     KNOWLEDGE_RETRIEVED, TOOL_INVOKED, TOOL_COMPLETED, FILTER_*, MESSAGE.
 *
 * No business logic here — this module is a data description + id generator.
 */

const crypto = require('crypto');

const WIDGET_INTENTS = Object.freeze({
  WIDGET_OPENED:           'quoxchat.widget.opened',
  WIDGET_CLOSED:           'quoxchat.widget.closed',
  VISITOR_IDENTIFIED:      'quoxchat.visitor.identified',
  SCENARIO_RUN:            'quoxchat.scenario.run',
  KNOWLEDGE_RETRIEVED:     'quoxchat.knowledge.retrieved',
  TOOL_INVOKED:            'quoxchat.tool.invoked',
  TOOL_COMPLETED:          'quoxchat.tool.completed',
  HANDOFF_REQUESTED:       'quoxchat.handoff.requested',
  FILTER_OUTPUT_SANITISED: 'quoxchat.filter.output_sanitised',
  // CAPTCHA #127 — witnesses the bot-protection verdict for this turn.
  // Only emitted when the widget has bot_protection enabled. Payload
  // records provider/score/ok/reason — never the raw token (hashed).
  HUMAN_VERIFIED:          'quoxchat.human.verified',
  // Back-compat terminal event — current LogsTab + analytics read this intent.
  // Do not remove until those surfaces consume the richer chain.
  MESSAGE:                 'quoxchat.message',
});

const KNOWN_INTENTS = new Set(Object.values(WIDGET_INTENTS));

// Envelope id format matches the collector's existing convention
// (server.js generateEnvelopeId) so the AEE db + Activity Centre handle them
// identically to every other envelope.
function generateId(prefix = 'ENV') {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rnd}`.toUpperCase();
}

/**
 * Builds an AEE envelope ready for storeAuditEnvelope(). Pure — no side
 * effects, no IO.
 *
 * @param {object} opts
 * @param {string} opts.intent         Must be one of WIDGET_INTENTS.
 * @param {string} [opts.visitor_id]   Defaults to 'anon'.
 * @param {string} [opts.widget_id]    Defaults to 'demo'.
 * @param {object} [opts.payload]      Event-specific data; keep it small + redacted.
 * @param {string} [opts.corr]         Explicit correlation id (overrides visitor_id default).
 * @param {string} [opts.reply_to]     Parent envelope id for chain linking.
 * @param {string} [opts.from_override] Override the default `widget.visitor.<id>` actor.
 * @param {string} [opts.to_override]   Override the default `agent.quoxchat.<id>` recipient.
 * @param {string} [opts.type]         Defaults to 'event'.
 */
function buildWidgetEnvelope(opts = {}) {
  const intent = opts.intent;
  if (!intent || !KNOWN_INTENTS.has(intent)) {
    throw new Error(`unknown widget intent: ${intent} (allowed: ${[...KNOWN_INTENTS].join(', ')})`);
  }
  const visitor_id = opts.visitor_id || 'anon';
  const widget_id = opts.widget_id || 'demo';
  return {
    v: '1',
    id: generateId('ENV'),
    ts: new Date().toISOString(),
    type: opts.type || 'event',
    from: opts.from_override || `widget.visitor.${visitor_id}`,
    to: opts.to_override || `agent.quoxchat.${widget_id}`,
    intent,
    corr: opts.corr || visitor_id,
    reply_to: opts.reply_to || null,
    payload: opts.payload || {},
  };
}

/**
 * hashInput — stable fingerprint of a tool input/result payload.
 * Used so envelopes record *that* a tool ran on *these* args without
 * leaking the args themselves. Not a cryptographic binding — 48 bits of
 * entropy is enough to distinguish turns in an audit log.
 *
 * JSON.stringify key-ordering: we sort object keys recursively so a tool
 * called with {b:2,a:1} fingerprints identically to {a:1,b:2}.
 */
function _stableStringify(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _stableStringify(v[k])).join(',') + '}';
}
function hashInput(v) {
  return crypto.createHash('sha256').update(_stableStringify(v)).digest('hex').slice(0, 12);
}

// QCX-2.2: widget-journey AOCL layer catalog. Distinct from the cross-cutting
// AOCL-FULL L0-L10 semantics — QuoxChat lives outside the core pipeline.
// Each checkpoint during /message emits a `quoxchat.aocl.<layer>` envelope
// with verdict + reason + timing so an admin can open the conversation and
// see which layer decided what, layer by layer.
const AOCL_LAYERS = Object.freeze([
  'ingress',       // domain allowlist + rate limit
  'session',       // visitor / conversation lookup
  'perception',    // prompt-injection detector
  'retrieval',     // RAG
  'cognition',     // LLM call
  'control',       // smart-router tier decision
  'verification',  // output credential filter
]);
const AOCL_LAYERS_SET = new Set(AOCL_LAYERS);
const AOCL_VERDICTS = Object.freeze(['ok', 'warn', 'reject']);
const AOCL_VERDICTS_SET = new Set(AOCL_VERDICTS);

function buildAoclLayerEnvelope(opts = {}) {
  const { layer, verdict, reason, visitor_id, widget_id, reply_to, timing_ms, extra } = opts;
  if (!layer || !AOCL_LAYERS_SET.has(layer)) {
    throw new Error(`unknown layer: ${layer} (allowed: ${AOCL_LAYERS.join(', ')})`);
  }
  if (!verdict || !AOCL_VERDICTS_SET.has(verdict)) {
    throw new Error(`unknown verdict: ${verdict} (allowed: ${AOCL_VERDICTS.join(', ')})`);
  }
  const visitor = visitor_id || 'anon';
  const widget = widget_id || 'demo';
  return {
    v: '1',
    id: generateId('ENV'),
    ts: new Date().toISOString(),
    type: 'event',
    from: `widget.visitor.${visitor}`,
    to: `agent.quoxchat.${widget}`,
    intent: `quoxchat.aocl.${layer}`,
    corr: visitor,
    reply_to: reply_to || null,
    payload: {
      aocl_layer: layer,
      verdict,
      reason: reason || '',
      timing_ms: Number.isFinite(timing_ms) ? timing_ms : null,
      ...(extra && typeof extra === 'object' ? extra : {}),
    },
  };
}

module.exports = {
  WIDGET_INTENTS,
  KNOWN_INTENTS,
  buildWidgetEnvelope,
  buildAoclLayerEnvelope,
  AOCL_LAYERS,
  AOCL_VERDICTS,
  hashInput,
  generateId,
};

/**
 * Intent → human label mapping — QOBS-1b
 *
 * Raw AEE intent strings (aocl.policy.evaluated, quox.flow.llm.completed)
 * are internal protocol identifiers, not something a user should have to
 * read to understand what happened in a conversation. This module maps
 * known intents to a short human-readable description, with a graceful
 * fallback for unrecognised or newly-added intents (prettify: strip dots
 * to spaces, capitalize words) so a raw dotted intent string is never
 * rendered in the Activity Centre.
 */

// Tool invocation intents — surface the tool name from payload when present.
const TOOL_INVOKE_INTENTS = new Set([
  'ops.tool.executed',
  'quox.agent.tool_call',
  'quox.agent.tool_result',
])

function toolName(payload) {
  return payload?.tool || payload?.tool_name || payload?.toolName || payload?.name || null
}

// Policy/layer intents — decision-dependent wording.
const POLICY_INTENTS = new Set(['aocl.policy.evaluated'])

function isDenialDecision(payload) {
  const decision = String(payload?.decision || payload?.status || '').toLowerCase()
  return decision === 'deny' || decision === 'denied' || decision === 'reject' || decision === 'rejected'
}

// Known intents with a fixed, non-payload-dependent human label.
const STATIC_LABELS = {
  'quox.chat.query': 'User message',
  'quox.chat.response': 'Assistant reply',
  'quox.chat.success': 'Chat completed',
  'quox.chat.error': 'Chat failed',
  'quox.shell.open': 'Shell session opened',
  'aocl.run.start': 'Run started',
  'aocl.run.complete': 'Run completed',
  'aocl.run.reject': 'Run blocked by policy',
  'ops.approval.request': 'Approval requested',
  'ops.approval.grant': 'Approval granted',
  'ops.approval.deny': 'Approval denied',
  'ops.tool.failed': 'Tool failed',
  // quox#1235: a tool call held for a human (nothing ran yet; the approval decides)
  'aocl.run.held': 'Run held for approval',
  'ops.tool.held': 'Tool held for approval',
  'aocl.tool.execute.held': 'Tool held for approval',
  // a call still running past its wait (e.g. a delegation): no approval involved, the answer lands later
  'aocl.run.pending': 'Run still in progress',
  'ops.tool.pending': 'Tool still running',
  'aocl.tool.execute.pending': 'Tool still running',
  'quox.agent.thinking': 'Agent thinking',
  'quox.agent.message': 'Agent message',
  'quox.agent.delegate': 'Task delegated',
  'quox.agent.handoff': 'Conversation handed off',
  'quox.session.started': 'Session started',
  'quox.agent.session_end': 'Session ended',
  'quoxagent.heartbeat.report': 'Heartbeat',
  // Canonical + legacy LLM invoke/complete/fail (dual-read — see llmIntents.js)
  'quox.flow.llm.invoked': 'LLM call started',
  'quox.flow.llm.completed': 'LLM call completed',
  'quox.flow.llm.failed': 'LLM call failed',
  'quox.flow.agent.invoked': 'LLM call started',
  'quox.flow.agent.completed': 'LLM call completed',
  'quox.flow.agent.failed': 'LLM call failed',
  'ops.assistant.invoked': 'LLM call completed',
  'agentic.think': 'LLM call completed',
}

// Prefix-based builders for intent families not worth enumerating fully.
const PREFIX_LABELS = [
  {
    prefix: 'quox.objective.',
    build: (intent) => `Objective ${intent.slice('quox.objective.'.length).replace(/_/g, ' ')}`,
  },
  {
    prefix: 'quox.browser.objective.',
    build: (intent) => `Browser-Q ${intent.slice('quox.browser.objective.'.length).replace(/_/g, ' ')}`,
  },
  {
    prefix: 'quox.tool.',
    build: () => 'Tool invoked',
  },
]

/** Strip dots to spaces and capitalize each word — last-resort fallback. */
function prettify(intent) {
  return intent
    .split('.')
    .join(' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Map an envelope to a short human-readable description of what it
 * represents. Never returns a raw dotted intent string.
 *
 * @param {{intent?: string, payload?: object}} envelope
 * @returns {string}
 */
export function getIntentLabel(envelope) {
  const intent = typeof envelope?.intent === 'string' ? envelope.intent : ''
  if (!intent) return 'Unknown event'

  const payload = envelope?.payload || {}

  if (TOOL_INVOKE_INTENTS.has(intent) || intent.startsWith('quox.tool.')) {
    const name = toolName(payload)
    return name ? `Tool invoked: ${name}` : 'Tool invoked'
  }

  if (POLICY_INTENTS.has(intent)) {
    return isDenialDecision(payload) ? 'Policy check denied' : 'Policy check passed'
  }

  if (intent.startsWith('aocl.layer.')) {
    const layerMatch = intent.match(/aocl\.layer\.(L\d+)/i)
    const layer = layerMatch ? layerMatch[1] : null
    // L3 is policy evaluation per AOCL spec — reuse the policy wording.
    if (layer === 'L3') {
      return isDenialDecision(payload) ? 'Policy check denied' : 'Policy check passed'
    }
    return layer ? `AOCL layer ${layer} checked` : 'AOCL layer checked'
  }

  if (STATIC_LABELS[intent]) return STATIC_LABELS[intent]

  for (const { prefix, build } of PREFIX_LABELS) {
    if (intent.startsWith(prefix)) return build(intent)
  }

  // Graceful fallback — never render a raw dotted intent string.
  return prettify(intent)
}

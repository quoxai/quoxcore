/**
 * Operator-facing text for a 402 plan_upgrade_required from the widget API
 * (Professional-only features: Simulation Arena, tool and connector framework).
 * Returns null when the response is not a plan gate so callers keep their own
 * error text. Never shown to widget visitors.
 */
export function planGateMessage(status, body) {
  if (status !== 402 || !body || body.error !== 'plan_upgrade_required') return null
  return body.message || 'This is a Professional feature. Upgrade to QuoxChat Professional to use it.'
}

const KEY_SOURCE_LABELS = {
  org: 'Your own provider key (org vault). LLM costs are billed to your provider account.',
  instance_env: 'The instance fallback key (no provider key is set for your org). LLM costs are NOT billed to your own provider account.',
  widget_endpoint: 'This widget\'s own OpenAI-compatible endpoint.',
}

/** Honest one-liner for which key answered the latest message; null until one has. */
export function keySourceLabel(source) {
  if (!source) return null
  return KEY_SOURCE_LABELS[source] || 'Unknown key source.'
}

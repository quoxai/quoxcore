/**
 * conversationPromote — heuristic conversation shape analysis
 *
 * Pure function: no side-effects, no API calls.
 * Returns the recommended promotion type for a conversation.
 *
 * @param {object} input
 * @param {Array}  input.messages              - conversation message array
 * @param {number} input.agentInvocationCount  - number of agent/tool invocations in thread
 * @param {number} input.durationMs            - thread age in milliseconds
 * @returns {{ primary: 'objective'|'workflow'|'crystal', confidence: number, alt: string[] }}
 */
export function analyseConversation({ messages = [], agentInvocationCount = 0, durationMs = 0 } = {}) {
  const ALL = ['objective', 'workflow', 'crystal']

  // Score each candidate
  let workflowScore = 0
  let crystalScore = 0
  let objectiveScore = 0.3 // base — always a safe fallback

  // Workflow signals
  //  - 2+ agent invocations in a structured thread → strong workflow signal
  //  - long thread (>3 messages) with invocations
  if (agentInvocationCount >= 3) {
    workflowScore += 0.6
  } else if (agentInvocationCount === 2) {
    workflowScore += 0.35
  } else if (agentInvocationCount === 1 && messages.length >= 6) {
    workflowScore += 0.2
  }

  if (messages.length >= 6 && agentInvocationCount >= 2) {
    workflowScore += 0.15
  }

  // Crystal signals
  //  - repeating single tool sequence (3+ messages with the same toolId)
  const toolIds = messages.filter(m => m.toolExecuted && m.toolId).map(m => m.toolId)
  if (toolIds.length >= 2) {
    const counts = {}
    for (const tid of toolIds) counts[tid] = (counts[tid] || 0) + 1
    const maxCount = Math.max(...Object.values(counts))
    const uniqueTools = Object.keys(counts).length
    if (maxCount >= 2 && uniqueTools === 1) {
      // Single repeated tool — strong crystal signal
      crystalScore += 0.55 + Math.min(0.2, (maxCount - 2) * 0.05)
    }
  }

  // Objective signals
  //  - short conversations with no agent invocations → likely open-ended discussion
  if (agentInvocationCount === 0) {
    objectiveScore += 0.3
  }
  if (messages.length <= 4 && agentInvocationCount === 0) {
    objectiveScore += 0.2
  }

  // Pick winner
  const scores = { objective: objectiveScore, workflow: workflowScore, crystal: crystalScore }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1])
  const [primary, topScore] = sorted[0]

  // Clamp confidence to [0, 1]
  const confidence = Math.min(1, Math.max(0, topScore))

  // Alt = remaining two in descending order, excluding primary
  const alt = sorted.slice(1).map(([k]) => k)

  return { primary, confidence, alt }
}

/**
 * Analyse messages array directly from a ChatTab conversationHistory array.
 * Convenience wrapper that also counts agent invocations from the history.
 *
 * @param {Array} conversationHistory - ChatTab's conversationHistory state
 * @param {number} [durationMs]
 */
export function analyseFromHistory(conversationHistory, durationMs = 0) {
  const agentInvocationCount = conversationHistory.filter(m => m.toolExecuted).length
  return analyseConversation({ messages: conversationHistory, agentInvocationCount, durationMs })
}

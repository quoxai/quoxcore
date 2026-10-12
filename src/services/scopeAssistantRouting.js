export function getScopeAssistantSource(assistant) {
  return assistant?.ownership?.source
    || assistant?.source
    || assistant?._source
    || (assistant?.created_by ? 'user'
      : assistant?.home_scope_id ? 'scope' : 'core')
}

export function indexScopeAssistantsByScopeId(assistants = []) {
  return assistants.reduce((acc, assistant) => {
    const scopeId = assistant?.ownership?.homeScopeId || assistant?.home_scope_id || null
    if (!scopeId) return acc

    const existing = acc[scopeId]
    const source = getScopeAssistantSource(assistant)
    const existingSource = existing ? getScopeAssistantSource(existing) : null

    if (!existing || (source === 'scope' && existingSource !== 'scope')) {
      acc[scopeId] = assistant
    }

    return acc
  }, {})
}

export function resolveScopeAssistantEntity(assistants = [], scopeId = null) {
  if (!scopeId) return null
  return indexScopeAssistantsByScopeId(assistants)[scopeId] || null
}

export function buildScopeChatNavigationState({ assistantId = null, scopeType, scopeId, scopeName, scopeObjectId = null }) {
  const state = {
    scope: scopeType,
    scopeId,
    scopeName,
  }

  if (scopeObjectId) {
    state.scopeObjectId = scopeObjectId
  }

  if (assistantId) {
    state.assistant = assistantId
  }

  return state
}

export function getScopeObjectIdFromNavigationState(state = {}) {
  const safeState = state || {}
  return safeState.scopeObjectId || safeState.scope_object_id || null
}

const EXPLICIT_EXECUTION_SOURCES = new Set([
  'user_selection',
  'toolbar_selection',
  'vault_credential_selection',
  'personal_preference',
  'assistant_recommendation',
  'specialist_lock',
])

export function shouldSendResolvedLlmSelection(executionPlan) {
  return EXPLICIT_EXECUTION_SOURCES.has(executionPlan?.source)
}

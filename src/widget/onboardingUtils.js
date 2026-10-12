/**
 * Onboarding Wizard Utilities (CW-8.9)
 */

export const WIZARD_STEPS = [
  { id: 'name', label: 'Name your widget', description: 'Give your chat assistant a name and greeting', icon: '💬' },
  { id: 'knowledge', label: 'Add knowledge', description: 'Upload a file, enter a URL, or add Q&A pairs', icon: '📚' },
  { id: 'test', label: 'Test it', description: 'Ask your widget a question and see how it answers', icon: '🧪' },
  { id: 'embed', label: 'Deploy', description: 'Copy the embed code and paste it on your website', icon: '🚀' },
]

export function validateStep(stepId, data = {}) {
  switch (stepId) {
    case 'name':
      return !!(data.name?.trim())
    case 'knowledge':
      return true // Skippable
    case 'test':
      return true // Skippable
    case 'embed':
      return !!data.widgetId
    default:
      return true
  }
}

export function canProceed(stepIndex, data = {}) {
  const step = WIZARD_STEPS[stepIndex]
  if (!step) return false
  return validateStep(step.id, data)
}

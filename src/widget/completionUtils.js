/**
 * Completion + Mode Resolution (CW-8.9.1)
 *
 * Single source of truth for "how done is this widget?" — drives progress bar
 * in both Wizard and Advanced modes, and the default-mode heuristic.
 */

export const COMPLETION_ITEMS = [
  { key: 'name',      label: 'Name & greeting' },
  { key: 'knowledge', label: 'Knowledge added' },
  { key: 'training',  label: 'Training tuned' },
  { key: 'style',     label: 'Style customised' },
  { key: 'tested',    label: 'Tested' },
  { key: 'deployed',  label: 'Embedded on site' },
]

function isDone(key, widget = {}, stats = {}) {
  switch (key) {
    case 'name':
      return !!(widget.name && widget.greeting)
    case 'knowledge':
      return (stats.totalChunks || 0) > 0 || (stats.qaCount || 0) > 0
    case 'training':
      return !!widget.system_prompt_override || (Array.isArray(widget.guardrails) && widget.guardrails.length > 0)
    case 'style':
      return !!widget.theme_customised
    case 'tested':
      return !!widget.tested_at || (stats.messageCount || 0) > 0
    case 'deployed':
      return !!widget.first_seen_at
    default:
      return false
  }
}

export function computeCompletion(widget = {}, stats = {}) {
  const items = COMPLETION_ITEMS.map(i => ({ ...i, done: isDone(i.key, widget, stats) }))
  const completed = items.filter(i => i.done).length
  const total = items.length
  return { items, completed, total, percent: Math.round((completed / total) * 100) }
}

const VALID_MODES = ['wizard', 'advanced']

export function resolveDefaultMode({ widget = {}, completion = { completed: 0 }, urlParam = null, stored = null } = {}) {
  if (VALID_MODES.includes(urlParam)) return urlParam
  if (VALID_MODES.includes(stored)) return stored
  if ((completion.completed || 0) <= 1) return 'wizard'
  return 'advanced'
}

const WIZARD_STEP_TAB_MAP = {
  name: 'settings',
  knowledge: 'knowledge',
  test: 'training',
  embed: 'settings',
}

export function wizardStepToTab(stepId) {
  return WIZARD_STEP_TAB_MAP[stepId] || 'settings'
}

export function firstIncompleteStep(completion, wizardSteps) {
  const idx = wizardSteps.findIndex(s => {
    const match = completion.items.find(i => i.key === s.id || (s.id === 'name' && i.key === 'name') || (s.id === 'knowledge' && i.key === 'knowledge') || (s.id === 'test' && i.key === 'tested') || (s.id === 'embed' && i.key === 'deployed'))
    return match && !match.done
  })
  return idx === -1 ? wizardSteps.length - 1 : idx
}

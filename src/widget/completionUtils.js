import { WIDGET_ROOM_TABS } from '../pages/views/widgetRoomTabs'
/**
 * Completion + Mode Resolution (CW-8.9.1)
 *
 * Single source of truth for "how done is this widget?" — drives progress bar
 * in both Wizard and Advanced modes, and the default-mode heuristic.
 */

export const COMPLETION_ITEMS = [
  { key: 'name',      label: 'Name & greeting', required: true },
  { key: 'knowledge', label: 'Knowledge added', required: true },
  { key: 'training',  label: 'Training tuned', required: false },
  { key: 'style',     label: 'Style customised', required: false },
  { key: 'tested',    label: 'Tested', required: true },
  { key: 'deployed',  label: 'Embedded on site', required: true },
]

// A published widget has by definition passed the publish gate (tested) and
// been switched on for visitors (deployed). Wave 8: do not report "Setup 2 of 6"
// for a live widget that has sources and conversations.
const isPublished = (widget = {}) => widget.status === 'published'

// API-created widgets store the greeting in embed_config (the `greeting`
// column stays empty), so a live widget read "Name & greeting" as not done and
// showed "Setup 3 of 6". Accept either place, object or JSON string.
function hasGreeting(widget = {}) {
  if (widget.greeting) return true
  const ec = widget.embed_config
  if (ec && typeof ec === 'object' && ec.greeting) return true
  const raw = widget.embed_config_json
  if (raw && typeof raw === 'object') return !!raw.greeting
  if (typeof raw === 'string') { try { return !!JSON.parse(raw)?.greeting } catch { return false } }
  return false
}

function isDone(key, widget = {}, stats = {}) {
  switch (key) {
    case 'name':
      return !!(widget.name && hasGreeting(widget))
    case 'knowledge':
      return (stats.totalChunks || 0) > 0 || (stats.qaCount || 0) > 0
    case 'training':
      return !!widget.system_prompt_override || (Array.isArray(widget.guardrails) && widget.guardrails.length > 0)
    case 'style':
      return !!widget.theme_customised
    case 'tested':
      return !!widget.tested_at || (stats.messageCount || 0) > 0 || (stats.conversationCount || 0) > 0 || isPublished(widget)
    case 'deployed':
      return !!widget.first_seen_at || isPublished(widget)
    default:
      return false
  }
}

export function computeCompletion(widget = {}, stats = {}) {
  const items = COMPLETION_ITEMS.map(i => ({ ...i, done: isDone(i.key, widget, stats) }))
  const completed = items.filter(i => i.done).length
  const total = items.length
  const requiredDone = items.filter(i => i.required).every(i => i.done)
  return { items, completed, total, percent: Math.round((completed / total) * 100), published: isPublished(widget), requiredDone }
}

const VALID_MODES = ['wizard', 'advanced']
const WIDGET_ROOM_TAB_IDS = WIDGET_ROOM_TABS.map(t => t.id)

export function resolveDefaultMode({ widget = {}, completion = { completed: 0 }, urlParam = null, stored = null, tabParam = null } = {}) {
  if (VALID_MODES.includes(urlParam)) return urlParam
  // w9: an explicit, valid ?tab= deep link means the admin wants that tab, so a
  // new widget must not be diverted into the wizard (which only shows Knowledge).
  if (tabParam && WIDGET_ROOM_TAB_IDS.includes(tabParam)) return 'advanced'
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

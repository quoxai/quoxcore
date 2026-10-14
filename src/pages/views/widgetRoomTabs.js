/**
 * Widget Room tab helpers (QUOXCHAT-BRUTALOOP wave 8).
 * Tab state lives in the URL (?tab=logs) so a tab is linkable, and the
 * "Full Editor" link needs the backing ASSISTANT id, not the widget id.
 */

export const DEFAULT_TAB = 'knowledge'

export const WIDGET_ROOM_TABS = [
  { id: 'knowledge', label: 'Knowledge', icon: '📚' },
  { id: 'training', label: 'Training', icon: '🏋️' },
  { id: 'style', label: 'Style', icon: '🎨' },
  { id: 'actions', label: 'Actions', icon: '⚡' },
  { id: 'simulation', label: 'Simulation', icon: '🧪' },
  { id: 'availability', label: 'Availability', icon: '🕒' },
  { id: 'logs', label: 'Logs', icon: '📜' },
  { id: 'analytics', label: 'Analytics', icon: '📊' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
  { id: 'compliance', label: 'Compliance', icon: '🛡️' },
]

/** Valid tab id from a ?tab= value, else the default. */
export function resolveTabParam(param) {
  return WIDGET_ROOM_TABS.some(t => t.id === param) ? param : DEFAULT_TAB
}

/** Search string for a tab change, preserving other params; default tab drops the param. */
export function withTabParam(searchParams, tabId) {
  const next = new URLSearchParams(searchParams)
  if (tabId === DEFAULT_TAB) next.delete('tab')
  else next.set('tab', tabId)
  return next
}

/** Router state for the Settings assistant editor: needs assistant_id, never the widget id. */
export function fullEditorState(widget) {
  const assistantId = widget?.assistant_id || null
  return assistantId ? { section: 'assistants', editAgent: assistantId } : { section: 'assistants' }
}

/**
 * True when nobody would be alerted about handoffs and leads: notification
 * settings null/empty, or no enabled event with a delivery channel.
 */
export function alertsUnconfigured(raw) {
  let cfg = raw
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch { cfg = null } }
  if (!cfg || typeof cfg !== 'object') return true
  return !Object.values(cfg).some(e => e && e.enabled === true
    && Array.isArray(e.channels) && e.channels.some(c => c && (c.to || c.recipient || c.url)))
}

/**
 * dashboardTabs — registry driving which /dashboard tabs exist, their
 * order, and their default enabled state.
 *
 * DashboardView keeps each tab's CONTENT as inline conditional blocks;
 * this registry only drives the tab bar + cycler + visibility/order,
 * via computeVisibleTabs() reading the user's `uiSettings.dashboardTabs`
 * config ({ enabled?: string[], order?: string[] }).
 */

// `cyclable`: whether the auto-cycle rotates through this tab. Only the light
// summary tabs cycle; the heavy embed tabs (Qortex, Cognitive Core) and the
// data-panel tabs (Fleet, Memory) are excluded so cycling stays smooth and
// never auto-mounts a heavy lazy view every N seconds (owner: cycle unusable
// once it rotated through the heavy tabs).
export const ALL_DASH_TABS = [
  { id: 'overview', label: 'Overview', defaultEnabled: true, cyclable: true },
  { id: 'operations', label: 'Operations', defaultEnabled: true, cyclable: true },
  { id: 'governance', label: 'Governance', defaultEnabled: true, cyclable: true },
  { id: 'intelligence', label: 'Intelligence', defaultEnabled: true, cyclable: true },
  { id: 'brain', label: 'Brain', defaultEnabled: true, cyclable: false },
  { id: 'fleet', label: 'Fleet', defaultEnabled: true, cyclable: false },
  { id: 'cognitive', label: 'Cognitive Core', defaultEnabled: true, cyclable: false },
  { id: 'memory', label: 'Memory', defaultEnabled: true, cyclable: false },
]

/**
 * @returns {Array<{id:string,label:string,defaultEnabled:boolean}>}
 */
export function getAllDashboardTabs() {
  return ALL_DASH_TABS
}

/**
 * Pure function: given the full tab registry and a user config, return the
 * ordered list of enabled tab objects.
 *
 * @param {Array<{id:string,label:string,defaultEnabled:boolean}>} all
 * @param {{ enabled?: string[]|null, order?: string[]|null }|undefined|null} cfg
 * @returns {Array<{id:string,label:string,defaultEnabled:boolean}>}
 */
export function computeVisibleTabs(all, cfg) {
  const registry = Array.isArray(all) ? all : []
  const allIds = registry.map(t => t.id)
  const byId = new Map(registry.map(t => [t.id, t]))

  const configuredOrder = Array.isArray(cfg?.order) ? cfg.order : []
  const orderedIds = configuredOrder.filter(id => byId.has(id))
  for (const id of allIds) {
    if (!orderedIds.includes(id)) orderedIds.push(id)
  }

  const enabledList = cfg?.enabled
  const isEnabled = (id) => (Array.isArray(enabledList) ? enabledList.includes(id) : true)

  return orderedIds.filter(isEnabled).map(id => byId.get(id))
}

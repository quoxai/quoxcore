/**
 * Breadcrumb leaf override. A detail page (e.g. a Widget Room at
 * /quoxchat/<ULID>) publishes a human label for its own path so the trail shows
 * the widget name instead of the raw id segment. Same event pattern as
 * 'quox-dashboard-tab'.
 */

export const BREADCRUMB_LEAF_EVENT = 'quox-breadcrumb-leaf'

/** Dispatch the label for `path`; pass label null to clear. */
export function publishBreadcrumbLeaf(path, label) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(BREADCRUMB_LEAF_EVENT, { detail: label ? { path, label } : null }))
}

/** Replace the label of the last crumb when it is the published leaf for this path. */
export function applyBreadcrumbLeaf(crumbs, path, leaf) {
  if (!leaf || !leaf.label || leaf.path !== path || crumbs.length === 0) return crumbs
  const last = crumbs[crumbs.length - 1]
  if (last.path !== path) return crumbs
  return [...crumbs.slice(0, -1), { ...last, label: leaf.label }]
}

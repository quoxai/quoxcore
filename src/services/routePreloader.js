const routeImporters = {
  '/mission-control': () => import('../pages/views/MissionControlView'),
  '/objectives': () => import('../pages/views/ObjectivesView'),
  '/workflows': () => import('../pages/views/WorkflowsView'),
  '/workflow-builder': () => import('../pages/views/WorkflowBuilderView'),
}

const preloadCache = new Map()

export function preloadShellRoute(pathname) {
  const normalizedPath = String(pathname || '').split('?')[0].split('#')[0]
  const importer = routeImporters[normalizedPath]
  if (!importer) return Promise.resolve(null)

  if (!preloadCache.has(normalizedPath)) {
    preloadCache.set(normalizedPath, importer().catch((err) => {
      preloadCache.delete(normalizedPath)
      throw err
    }))
  }

  return preloadCache.get(normalizedPath)
}

export function warmCriticalShellRoutes() {
  const criticalRoutes = ['/mission-control', '/objectives', '/workflows']
  return Promise.allSettled(criticalRoutes.map(preloadShellRoute))
}

/**
 * Roadmap Viewer Plugin — Registration
 *
 * Registers the roadmap viewer route and sidebar entry.
 * Called from App.jsx plugin initialization.
 */

import { registerPluginRoute } from '../../config/routeRegistry'
import { registerPluginNavItems } from '../../config/navRegistry'
import RoadmapView from './RoadmapView'

export function register() {
  registerPluginRoute('roadmap-viewer', {
    path: '/plugins/roadmap-viewer',
    component: RoadmapView,
  })

  registerPluginNavItems('roadmap-viewer', [
    { path: '/plugins/roadmap-viewer', label: 'Roadmap', icon: 'target' },
  ], 'platform')
}

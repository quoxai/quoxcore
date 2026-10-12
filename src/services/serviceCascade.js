/**
 * Service Cascade — dependency-aware health inference for the "Shape of
 * Quox" HUD.
 *
 * Pure functions only (no fetching, no React). Consumes the shape produced
 * by HealthContext's `services` map (see src/contexts/HealthContext.jsx) and
 * SERVICE_REGISTRY (see src/config/serviceRegistry.js) and derives, per
 * service:
 *   - `measured`: what the health check itself observed for THIS service.
 *     Never overridden by dependency state.
 *   - `atRisk` / `rootCauses`: an additive inference — "a dependency this
 *     service relies on is down" — layered on top of, never replacing,
 *     `measured`.
 */

import SERVICE_REGISTRY from '../config/serviceRegistry'

/**
 * Determine the measured status of a single service from its HealthContext
 * entry. `measured` always wins over any cascade inference:
 *   - 'healthy'    → svc.healthy === true
 *   - 'degraded'   → svc.responding && !svc.healthy
 *   - 'confirming' → svc._awaitingConfirmation (first, unconfirmed failure)
 *   - 'down'       → entry exists, !svc.responding, !svc._awaitingConfirmation
 *   - 'absent'     → entry exists but svc.installed === false (optional service
 *                    not installed / per-host agent not deployed). healthCheck
 *                    fabricates responding:true,healthy:true for these, so this
 *                    guard MUST come before the healthy check or an unprobed
 *                    service reads as a fake green "healthy".
 *   - 'unmonitored'→ no entry in healthServices for this key
 */
function measureService(svc) {
  if (!svc) return 'unmonitored'
  if (svc.installed === false) return 'absent'
  if (svc.healthy === true) return 'healthy'
  if (svc.responding && !svc.healthy) return 'degraded'
  if (svc._awaitingConfirmation) return 'confirming'
  if (!svc.responding) return 'down'
  return 'unmonitored'
}

/**
 * Walk the transitive dependency graph of `key` and collect the set of
 * ancestor keys whose `measured` status is 'down'. Cycle-safe via a shared
 * `visited` set (each dependency id is only ever traversed once per call),
 * and tolerant of dependency ids that are missing from the registry.
 */
function collectDownAncestors(key, registry, measuredOf, visited) {
  const downAncestors = new Set()
  const svc = registry[key]
  const dependencies = Array.isArray(svc?.dependencies) ? svc.dependencies : []

  for (const dep of dependencies) {
    if (visited.has(dep)) continue
    visited.add(dep)

    if (!registry[dep]) continue // unknown/missing dependency id — skip, don't throw

    if (measuredOf[dep] === 'down') {
      downAncestors.add(dep)
    }

    const nested = collectDownAncestors(dep, registry, measuredOf, visited)
    for (const d of nested) downAncestors.add(d)
  }

  return downAncestors
}

/**
 * Compute per-service cascade state.
 *
 * @param {Object} healthServices - `services` map from useHealth() (HealthContext)
 * @param {Object} registry - service registry (defaults to SERVICE_REGISTRY)
 * @returns {Object<string, { measured: string, atRisk: boolean, rootCauses: string[], monitored: boolean }>}
 */
export function computeCascade(healthServices = {}, registry = SERVICE_REGISTRY) {
  const keys = Object.keys(registry)

  const measuredOf = {}
  for (const key of keys) {
    measuredOf[key] = measureService(healthServices?.[key])
  }

  const result = {}
  for (const key of keys) {
    const rootCauses = Array.from(collectDownAncestors(key, registry, measuredOf, new Set()))
    result[key] = {
      measured: measuredOf[key],
      atRisk: rootCauses.length > 0,
      rootCauses,
      monitored: measuredOf[key] !== 'unmonitored' && measuredOf[key] !== 'absent',
    }
  }
  return result
}

/**
 * Compute topological depth per service: 0 if no (known) dependencies,
 * otherwise 1 + max(dependency depths). Cycle-safe: a dependency id
 * encountered while it is still being resolved is treated as depth 0
 * to break the cycle rather than recursing forever. Missing/unknown
 * dependency ids are skipped.
 *
 * @param {Object} registry - service registry (defaults to SERVICE_REGISTRY)
 * @returns {Object<string, number>}
 */
export function computeDepth(registry = SERVICE_REGISTRY) {
  const depth = {}
  const visiting = new Set()

  function resolve(key) {
    if (depth[key] !== undefined) return depth[key]

    const svc = registry[key]
    const dependencies = Array.isArray(svc?.dependencies) ? svc.dependencies : []

    if (dependencies.length === 0) {
      depth[key] = 0
      return 0
    }

    if (visiting.has(key)) {
      // Cycle detected — break it here rather than recursing forever.
      depth[key] = 0
      return 0
    }

    visiting.add(key)
    let maxDepDepth = -1
    for (const dep of dependencies) {
      if (!registry[dep]) continue // tolerate unknown dependency ids
      maxDepDepth = Math.max(maxDepDepth, resolve(dep))
    }
    visiting.delete(key)

    depth[key] = maxDepDepth === -1 ? 0 : 1 + maxDepDepth
    return depth[key]
  }

  for (const key of Object.keys(registry)) resolve(key)
  return depth
}

export default computeCascade

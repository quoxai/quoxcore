/**
 * Shared Geometry — Module-level geometry instances reused across all zones.
 *
 * V3-VIZ-2: Performance optimization.
 * Creating geometry once and sharing it across components reduces GC pressure.
 * R3F will still create individual draw calls per mesh, but geometry buffers
 * are shared in GPU memory.
 *
 * Usage:
 *   import { SHARED_OCTA, SHARED_SPHERE, SHARED_CIRCLE } from '../lib/sharedGeometry'
 *   <mesh geometry={SHARED_OCTA}> ... </mesh>
 */
import * as THREE from 'three'

// Core shapes — created once, never disposed
export const SHARED_OCTA = new THREE.OctahedronGeometry(1, 0)
export const SHARED_OCTA_DETAIL = new THREE.OctahedronGeometry(1, 1) // more polygons for LOD close-up
export const SHARED_SPHERE = new THREE.SphereGeometry(1, 8, 8)
export const SHARED_CIRCLE = new THREE.CircleGeometry(1, 12)
export const SHARED_TORUS = new THREE.TorusGeometry(1, 0.015, 8, 32)
export const SHARED_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 6)

/**
 * Quality tiers — reduce visual complexity for lower-end hardware.
 */
export const QUALITY_TIERS = {
  ultra:  { particles: 400, maxAgentLabels: 999, maxMemoryCrystals: 30, postProcessing: true },
  high:   { particles: 250, maxAgentLabels: 20,  maxMemoryCrystals: 20, postProcessing: true },
  medium: { particles: 120, maxAgentLabels: 10,  maxMemoryCrystals: 12, postProcessing: true },
  low:    { particles: 50,  maxAgentLabels: 5,   maxMemoryCrystals: 6,  postProcessing: false },
}

/**
 * Auto-detect quality tier from FPS.
 * @param {number} fps — current FPS
 * @param {string} currentTier — current tier
 * @returns {string} — recommended tier
 */
export function autoQualityTier(fps, currentTier = 'high') {
  if (fps < 15 && currentTier !== 'low') return 'low'
  if (fps < 25 && currentTier === 'ultra') return 'high'
  if (fps < 25 && currentTier === 'high') return 'medium'
  if (fps > 50 && currentTier === 'low') return 'medium'
  if (fps > 50 && currentTier === 'medium') return 'high'
  return currentTier
}

/**
 * Scanner Disc Projection Utility
 *
 * Projects 3D world positions onto the 2D scanner disc.
 * Fibonacci layout: rings at r=4, 7, 12, 17, 25, 38, 59, 80, 105, 130.
 */

/**
 * Project a 3D world position onto the 2D scanner disc.
 * @param {number[]} worldPos — [x, y, z] in world space
 * @param {number} discRadius — pixel radius of the disc
 * @param {number} worldRadius — max world distance to map to disc edge
 * @returns {{ x: number, y: number, flagpoleHeight: number }}
 */
export function projectToScanner(worldPos, discRadius, worldRadius = 140) {
  const [wx, wy, wz] = worldPos
  const scale = discRadius / worldRadius
  return {
    x: wx * scale,
    y: wz * scale, // XZ plane maps to disc XY
    flagpoleHeight: wy * scale * 0.5, // Y maps to flagpole, scaled down
  }
}

/**
 * Zone definitions with thresholds.
 * Used by getActiveZone with hysteresis to prevent jitter at boundaries.
 */
const ZONE_DEFS = [
  { zone: 'NUC', label: 'Nucleus',       threshold: 6,   index: 0 },
  { zone: 'SVC', label: 'Services',      threshold: 10,  index: 1 },
  { zone: 'IMP', label: 'Implants',      threshold: 15,  index: 2 },
  { zone: 'AST', label: 'Assistants',    threshold: 21,  index: 3 },
  { zone: 'AGT', label: 'Agents',        threshold: 28,  index: 4 },
  { zone: 'ORG', label: 'Org Structure', threshold: 35,  index: 5 },
  { zone: 'TMC', label: 'Teams (Core)',  threshold: 49,  index: 6 },
  { zone: 'TMX', label: 'Teams (Ext)',   threshold: 70,  index: 7 },
  { zone: 'OBJ', label: 'Obj Execution', threshold: 85,  index: 8 },
  { zone: 'WFX', label: 'WF Execution',  threshold: 95,  index: 9 },
  { zone: 'MEM', label: 'Memory',        threshold: 113, index: 10 },
  { zone: 'VLT', label: 'Vault',         threshold: 125, index: 11 },
  { zone: 'SHL', label: 'Shell',         threshold: 999, index: 12 },
]

const HYSTERESIS = 2 // units of buffer to prevent jitter
let _lastZoneIndex = 0

/**
 * Determine active zone from camera distance to origin.
 * Uses hysteresis: must move ≥2 units past a boundary to trigger zone change.
 * @param {number} r — distance from camera to origin
 * @returns {{ zone: string, label: string, index: number }}
 */
export function getActiveZone(r) {
  // Find raw zone (no hysteresis)
  let rawIndex = ZONE_DEFS.length - 1
  for (let i = 0; i < ZONE_DEFS.length; i++) {
    if (r < ZONE_DEFS[i].threshold) { rawIndex = i; break }
  }

  // Apply hysteresis: only switch if we've moved ≥ HYSTERESIS past the boundary
  if (rawIndex !== _lastZoneIndex) {
    const boundary = rawIndex < _lastZoneIndex
      ? ZONE_DEFS[_lastZoneIndex - 1]?.threshold || 0   // moving inward
      : ZONE_DEFS[_lastZoneIndex]?.threshold || 0        // moving outward
    const distFromBoundary = rawIndex < _lastZoneIndex ? (boundary - r) : (r - boundary)
    if (distFromBoundary < HYSTERESIS) {
      // Not far enough past boundary — keep current zone
      return ZONE_DEFS[_lastZoneIndex]
    }
    _lastZoneIndex = rawIndex
  }

  return ZONE_DEFS[rawIndex]
}

/**
 * Zone definitions for the right bezel markers.
 */
export const ZONE_MARKERS = [
  { code: 'NUC', label: 'Nucleus',      threshold: 6 },
  { code: 'SVC', label: 'Services',     threshold: 10 },
  { code: 'IMP', label: 'Implants',     threshold: 15 },
  { code: 'AST', label: 'Assistants',   threshold: 21 },
  { code: 'AGT', label: 'Agents',       threshold: 28 },
  { code: 'ORG', label: 'Org',          threshold: 35 },
  { code: 'TMC', label: 'Teams',        threshold: 49 },
  { code: 'TMX', label: 'Teams Ext',    threshold: 70 },
  { code: 'OBJ', label: 'Obj Exec',     threshold: 85 },
  { code: 'WFX', label: 'WF Exec',      threshold: 95 },
  { code: 'MEM', label: 'Memory',       threshold: 113 },
  { code: 'VLT', label: 'Vault',        threshold: 125 },
  { code: 'SHL', label: 'Shell',        threshold: 999 },
]

/**
 * Range rings for the scanner disc — Fibonacci radii.
 */
export const SCANNER_RANGE_RINGS = [4, 7, 12, 17, 25, 30, 38, 59, 80, 90, 105, 120, 130]

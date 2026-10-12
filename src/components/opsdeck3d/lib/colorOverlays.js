/**
 * Color Overlay System — Toggle what the scene encodes.
 *
 * V3-VIZ-0: Like Elite's galaxy map overlays.
 * Each mode re-colors all entities by a different data dimension.
 * Non-relevant entities fade to 15% opacity.
 *
 * Modes:
 *   default — original entity colors (no overlay)
 *   health  — green→amber→red gradient based on health/status
 *   state   — colored by current execution state
 *   team    — colored by team membership
 *   age     — colored by recency (bright=recent, dim=old)
 */

export const OVERLAY_MODES = ['default', 'health', 'state', 'team', 'age']

export const OVERLAY_LABELS = {
  default: 'Default',
  health: 'Health',
  state: 'State',
  team: 'Team',
  age: 'Age',
}

export const OVERLAY_COLORS = {
  default: '#8b5cf6',
  health: '#22c55e',
  state: '#6366f1',
  team: '#f59e0b',
  age: '#ec4899',
}

// Health gradient: 100=green, 50=amber, 0=red
const HEALTH_GRADIENT = [
  { threshold: 80, color: '#22c55e' },
  { threshold: 60, color: '#84cc16' },
  { threshold: 40, color: '#f59e0b' },
  { threshold: 20, color: '#ef4444' },
  { threshold: 0,  color: '#7f1d1d' },
]

// State ��� color mapping
const STATE_COLORS = {
  idle: '#555570',
  active: '#818cf8',
  thinking: '#6366f1',
  executing: '#22c55e',
  reading: '#06b6d4',
  writing: '#0891b2',
  blocked: '#ef4444',
  waiting: '#f59e0b',
  done: '#10b981',
  stale: '#92400e',
  healthy: '#22c55e',
  degraded: '#f59e0b',
  down: '#ef4444',
  unknown: '#555570',
}

// Team colors (cycle)
const TEAM_PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#10b981']

/**
 * Resolve entity color based on overlay mode.
 * @param {Object} entity — { color, state, health, teamId, age, type }
 * @param {string} mode — overlay mode
 * @param {Map} teamColorMap — team ID → color mapping
 * @returns {{ color: string, opacity: number }}
 */
export function resolveOverlayColor(entity, mode, teamColorMap = new Map()) {
  if (mode === 'default') {
    return { color: entity.color || '#8b5cf6', opacity: 1 }
  }

  if (mode === 'health') {
    const health = entity.health ?? (entity.state === 'healthy' ? 100 : entity.state === 'degraded' ? 40 : entity.state === 'blocked' ? 10 : entity.state === 'idle' ? 70 : 60)
    const entry = HEALTH_GRADIENT.find(g => health >= g.threshold) || HEALTH_GRADIENT[HEALTH_GRADIENT.length - 1]
    return { color: entry.color, opacity: 0.9 }
  }

  if (mode === 'state') {
    const stateColor = STATE_COLORS[entity.state] || STATE_COLORS.unknown
    const isActive = entity.state && entity.state !== 'idle' && entity.state !== 'unknown'
    return { color: stateColor, opacity: isActive ? 1 : 0.2 }
  }

  if (mode === 'team') {
    if (!entity.teamId) return { color: '#333', opacity: 0.15 }
    if (!teamColorMap.has(entity.teamId)) {
      teamColorMap.set(entity.teamId, TEAM_PALETTE[teamColorMap.size % TEAM_PALETTE.length])
    }
    return { color: teamColorMap.get(entity.teamId), opacity: 0.9 }
  }

  if (mode === 'age') {
    const age = entity.age ?? 0.5
    const brightness = Math.max(0.15, 1.0 - age * 0.85)
    return { color: '#ec4899', opacity: brightness }
  }

  return { color: entity.color || '#8b5cf6', opacity: 1 }
}

/**
 * Build a team color map from agents array.
 */
export function buildTeamColorMap(agents) {
  const map = new Map()
  agents?.forEach(a => {
    if (a.teamId && !map.has(a.teamId)) {
      map.set(a.teamId, TEAM_PALETTE[map.size % TEAM_PALETTE.length])
    }
  })
  return map
}

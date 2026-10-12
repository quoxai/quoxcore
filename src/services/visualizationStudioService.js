import { getStorageOrgId } from './orgScopedStorage'
import { migrateAllLegacyAssignments } from './visualizationMigration'
import { isPluginLicensed } from './visualizationService'
import { getVisualizationStudioRenderer } from '../components/visualizations-v2/registry/renderers'

const STORAGE_KEY = 'quox-viz-studio-config'
const STUDIO_FLAG_KEY = 'quox-viz-v2'

let studioCache = null

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function getEmptyConfig() {
  return {
    version: 2,
    importedAt: null,
    source: 'studio',
    assignments: {}
  }
}

function readStorage() {
  if (studioCache) return studioCache

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      studioCache = JSON.parse(raw)
      return studioCache
    }
  } catch (err) {
    console.warn('[VizStudio] Failed to parse stored config:', err)
  }

  studioCache = getEmptyConfig()
  return studioCache
}

function writeStorage(config) {
  studioCache = config
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

function ensureAssignmentShape(assignment = {}) {
  return {
    rendererId: assignment.rendererId || 'commander-sigil',
    presetId: assignment.presetId || 'legacy-default',
    source: assignment.source || 'studio',
    overrides: {
      global: { ...(assignment.overrides?.global || {}) },
      states: { ...(assignment.overrides?.states || {}) },
      legacyConfig: assignment.overrides?.legacyConfig ? clone(assignment.overrides.legacyConfig) : undefined
    },
    updatedAt: assignment.updatedAt || Date.now()
  }
}

export function isVisualizationStudioEnabled() {
  return true
}

export function setVisualizationStudioEnabled(enabled) {
  localStorage.setItem(STUDIO_FLAG_KEY, enabled ? 'true' : 'false')
}

export function getVisualizationStudioConfig() {
  const config = readStorage()
  return clone(config)
}

export function getVisualizationStudioAssignment(assistantId) {
  const config = ensureVisualizationStudioMigration()
  const assignment = config.assignments?.[assistantId]
  // UI-7 / quox#344: `source: 'legacy-import'` assignments were auto-written
  // by `migrateAllLegacyAssignments` from the OLD per-agent visualizer
  // defaults (HAL for quox/CommanderQ, Sphere for sentinel, etc.) before the
  // 1babccb5 fix flipped runtime defaults to Commander Sigil. Ignoring them
  // outright used to let the new Commander-Sigil free default fall through
  // for stale auto-migrated entries — but it also silently discarded a
  // user's deliberate legacy choice (e.g. 'hal-legacy' is still a real,
  // selectable v2 renderer). Preserve a legacy-import assignment whenever its
  // rendererId still resolves in the v2 registry; only fall through to the
  // default below for rendererIds that no longer exist (retired renderers).
  // User-chosen assignments (source: 'studio' / 'premium-defaults' / 'import')
  // are unaffected — they continue to win.
  if (assignment) {
    const rendererStillResolves = Boolean(assignment.rendererId) &&
      getVisualizationStudioRenderer(assignment.rendererId).id === assignment.rendererId
    if (assignment.source !== 'legacy-import' || rendererStillResolves) {
      return clone(ensureAssignmentShape(assignment))
    }
  }

  // No usable stored assignment — synthesize from premium defaults if plugin
  // is licensed. When plugin is disabled, return null so the host's Commander
  // Sigil fallback applies.
  if (isPluginLicensed() && PREMIUM_DEFAULT_ASSIGNMENTS[assistantId]) {
    const defaults = PREMIUM_DEFAULT_ASSIGNMENTS[assistantId]
    return ensureAssignmentShape({
      rendererId: defaults.rendererId,
      presetId: defaults.presetId,
      source: 'premium-default-auto',
      overrides: { global: {}, states: {} }
    })
  }
  return null
}

export function saveVisualizationStudioAssignment(assistantId, assignment) {
  const config = readStorage()
  config.assignments[assistantId] = ensureAssignmentShape({
    ...assignment,
    updatedAt: Date.now()
  })
  writeStorage(config)
  window.dispatchEvent(new CustomEvent('quox-viz-studio-change', { detail: { assistantId } }))
  return clone(config.assignments[assistantId])
}

export function ensureVisualizationStudioMigration() {
  const config = readStorage()
  if (Object.keys(config.assignments || {}).length > 0) {
    return clone(config)
  }

  const migrated = migrateAllLegacyAssignments()
  writeStorage(migrated)
  return clone(migrated)
}

export function exportVisualizationStudioConfig() {
  return getVisualizationStudioConfig()
}

export function importVisualizationStudioConfig(data) {
  if (!data || typeof data !== 'object' || data.version !== 2 || !data.assignments) {
    return false
  }

  writeStorage({
    version: 2,
    importedAt: Date.now(),
    source: data.source || 'import',
    assignments: Object.fromEntries(
      Object.entries(data.assignments).map(([assistantId, assignment]) => [
        assistantId,
        ensureAssignmentShape(assignment)
      ])
    )
  })
  window.dispatchEvent(new CustomEvent('quox-viz-studio-change', { detail: { imported: true } }))
  return true
}

export function getVisualizationStudioMeta() {
  return {
    enabled: isVisualizationStudioEnabled(),
    orgScoped: Boolean(getStorageOrgId()),
    storageKey: STORAGE_KEY,
    version: 2
  }
}

/**
 * Curated premium defaults: each agent gets the v2 renderer that matches their identity.
 * Used by "Apply premium defaults" button in the Studio editor.
 */
export const PREMIUM_DEFAULT_ASSIGNMENTS = {
  quox:      { rendererId: 'commander-sigil',    presetId: 'sovereign-pulse' },
  sentinel:  { rendererId: 'jarvis-command-hud', presetId: 'sentinel-glass' },
  cipher:    { rendererId: 'cipher-mesh',        presetId: 'mesh-core' },
  nova:      { rendererId: 'signal-bloom',       presetId: 'bloom-core' },
  prism:     { rendererId: 'prism-spectrum',      presetId: 'white-split' },
  atlas:     { rendererId: 'gaia-eye',           presetId: 'blue-marble' },
  metrics:   { rendererId: 'momentum-board',     presetId: 'flow-state' },
  insight:   { rendererId: 'annotation-lens',    presetId: 'pattern-lens' },
  scholar:   { rendererId: 'cathedral-of-minds', presetId: 'quorum-ghost' },
  beacon:    { rendererId: 'signal-bloom',       presetId: 'velvet-alarm' },
  forge:     { rendererId: 'black-sun',          presetId: 'event-horizon' },
  archivist: { rendererId: 'living-ink',         presetId: 'venom-oracle' },
  corey:     { rendererId: 'orbital-cathedral',  presetId: 'boardroom' }
}

/**
 * Apply premium defaults to all agents.
 * Preserves any custom overrides the user has set.
 */
export function applyPremiumDefaults() {
  const config = readStorage()
  if (!config.assignments) config.assignments = {}
  for (const [assistantId, defaults] of Object.entries(PREMIUM_DEFAULT_ASSIGNMENTS)) {
    config.assignments[assistantId] = ensureAssignmentShape({
      rendererId: defaults.rendererId,
      presetId: defaults.presetId,
      source: 'premium-defaults',
      overrides: { global: {}, states: {} }
    })
  }
  writeStorage(config)
  window.dispatchEvent(new CustomEvent('quox-viz-studio-change', { detail: { imported: true } }))
  return clone(config)
}

/**
 * Get the global background opacity setting (0-1, default 1).
 * Stored separately from per-renderer settings so it applies universally.
 */
export function getBackgroundOpacity() {
  const config = readStorage()
  return config.backgroundOpacity ?? 0.35
}

/**
 * Set the global background opacity (0-1).
 */
export function setBackgroundOpacity(opacity) {
  const config = readStorage()
  config.backgroundOpacity = Math.max(0, Math.min(1, opacity))
  writeStorage(config)
  window.dispatchEvent(new CustomEvent('quox-viz-studio-change', { detail: { backgroundOpacity: true } }))
}

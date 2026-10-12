import {
  DEFAULT_ASSIGNMENTS,
  exportSettings as exportLegacySettings,
  VISUALIZER_TYPES
} from './visualizationService'

const LEGACY_TO_V2_RENDERER = {
  [VISUALIZER_TYPES.HAL]: 'hal-legacy',
  [VISUALIZER_TYPES.KITT]: 'kitt-legacy',
  [VISUALIZER_TYPES.RIPPLE]: 'ripple-legacy',
  [VISUALIZER_TYPES.ATOM]: 'atom-legacy',
  [VISUALIZER_TYPES.DNA]: 'dna-legacy',
  [VISUALIZER_TYPES.BRAIN]: 'brain-legacy',
  [VISUALIZER_TYPES.SPHERE]: 'sphere-legacy',
  [VISUALIZER_TYPES.HOLO]: 'holo-legacy',
  [VISUALIZER_TYPES.FLUID]: 'fluid-legacy',
  [VISUALIZER_TYPES.NEXUS]: 'nexus-legacy',
  [VISUALIZER_TYPES.IRIS]: 'iris-legacy',
  [VISUALIZER_TYPES.CODEX]: 'codex-legacy',
  [VISUALIZER_TYPES.CORE]: 'core-legacy',
  [VISUALIZER_TYPES.COMMANDER_SIGIL]: 'commander-sigil',
  particulate: 'nexus-legacy'
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function mapLegacyVisualizerToV2(visualizer) {
  return LEGACY_TO_V2_RENDERER[visualizer] || 'commander-sigil'
}

export function migrateLegacyAssignment(assistantId, legacySettings) {
  const visualizer = legacySettings?.visualizer || DEFAULT_ASSIGNMENTS[assistantId]?.visualizer || VISUALIZER_TYPES.COMMANDER_SIGIL
  const config = clone(legacySettings?.config || DEFAULT_ASSIGNMENTS[assistantId]?.config || {})

  return {
    rendererId: mapLegacyVisualizerToV2(visualizer),
    presetId: 'legacy-default',
    source: 'legacy-import',
    overrides: {
      global: {},
      states: {},
      legacyConfig: config
    },
    updatedAt: Date.now()
  }
}

export function migrateAllLegacyAssignments() {
  const legacy = exportLegacySettings()
  const assignments = {}

  Object.entries(legacy?.settings || {}).forEach(([assistantId, settings]) => {
    assignments[assistantId] = migrateLegacyAssignment(assistantId, settings)
  })

  return {
    version: 2,
    importedAt: Date.now(),
    source: 'legacy-visualizations',
    assignments
  }
}

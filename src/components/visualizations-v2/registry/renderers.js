import LegacyRendererAdapter from '../renderers/LegacyRendererAdapter'
import AnnotationLensVisualizer from '../renderers/AnnotationLensVisualizer'
import BlackSunVisualizer from '../renderers/BlackSunVisualizer'
import BrowserLensVisualizer from '../renderers/BrowserLensVisualizer'
import CathedralOfMindsVisualizer from '../renderers/CathedralOfMindsVisualizer'
import CipherMeshVisualizer from '../renderers/CipherMeshVisualizer'
import CommanderSigilVisualizer from '../renderers/CommanderSigilVisualizer'
import MomentumBoardVisualizer from '../renderers/MomentumBoardVisualizer'
import PrismVisualizer from '../renderers/PrismVisualizer'
import TriageLanesVisualizer from '../renderers/TriageLanesVisualizer'
import PrototypeVisualizer from '../renderers/PrototypeVisualizer'
import QuantumQVisualizer from '../renderers/QuantumQVisualizer'

const legacySchema = {
  legacyConfig: {
    type: 'json',
    label: 'Legacy Config',
    description: 'Stored legacy renderer configuration blob.'
  }
}

export const VISUALIZATION_STUDIO_RENDERERS = {
  'hal-legacy': {
    id: 'hal-legacy',
    family: 'legacy',
    displayName: 'Eye-Q',
    status: 'active',
    component: LegacyRendererAdapter,
    legacyRendererId: 'hal-legacy',
    defaultPresetId: 'legacy-default',
    presets: [{ id: 'legacy-default', name: 'Legacy Default' }],
    settingsSchema: legacySchema
  },
  'atom-legacy': { id: 'atom-legacy', family: 'legacy', displayName: 'Atom', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'atom-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'brain-legacy': { id: 'brain-legacy', family: 'legacy', displayName: 'Brain', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'brain-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'dna-legacy': { id: 'dna-legacy', family: 'legacy', displayName: 'DNA', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'dna-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'sphere-legacy': { id: 'sphere-legacy', family: 'legacy', displayName: 'Sphere', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'sphere-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'fluid-legacy': { id: 'fluid-legacy', family: 'legacy', displayName: 'Neuro Fluid', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'fluid-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'holo-legacy': { id: 'holo-legacy', family: 'legacy', displayName: 'Holo Field', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'holo-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'nexus-legacy': { id: 'nexus-legacy', family: 'legacy', displayName: 'Nexus', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'nexus-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'kitt-legacy': { id: 'kitt-legacy', family: 'legacy', displayName: 'KITT', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'kitt-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'ripple-legacy': { id: 'ripple-legacy', family: 'legacy', displayName: 'Ripple', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'ripple-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'iris-legacy': { id: 'iris-legacy', family: 'legacy', displayName: 'Iris', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'iris-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'codex-legacy': { id: 'codex-legacy', family: 'legacy', displayName: 'Codex', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'codex-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'core-legacy': { id: 'core-legacy', family: 'legacy', displayName: 'Core', status: 'legacy', component: LegacyRendererAdapter, legacyRendererId: 'core-legacy', defaultPresetId: 'legacy-default', presets: [{ id: 'legacy-default', name: 'Legacy Default' }], settingsSchema: legacySchema },
  'black-sun': {
    id: 'black-sun',
    family: 'black-sun',
    displayName: 'Black Sun',
    status: 'active',
    component: BlackSunVisualizer,
    defaultPresetId: 'event-horizon',
    presets: [
      { id: 'event-horizon', name: 'Event Horizon' },
      { id: 'blood-crown', name: 'Blood Crown' },
      { id: 'gaia-lens', name: 'Gaia Lens' },
      { id: 'tropical-iris', name: 'Tropical Iris' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'tropical-iris': {
    id: 'tropical-iris',
    family: 'black-sun',
    displayName: 'Tropical Iris',
    status: 'active',
    component: BlackSunVisualizer,
    defaultPresetId: 'tropical-iris',
    presets: [
      { id: 'tropical-iris', name: 'Tropical Iris' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'cathedral-of-minds': {
    id: 'cathedral-of-minds',
    family: 'cathedral-of-minds',
    displayName: 'Cathedral of Minds',
    status: 'active',
    component: CathedralOfMindsVisualizer,
    defaultPresetId: 'black-sun-synod',
    presets: [
      { id: 'black-sun-synod', name: 'Black Sun Synod' },
      { id: 'quorum-ghost', name: 'Quorum Ghost' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'cipher-mesh': {
    id: 'cipher-mesh',
    family: 'cipher-mesh',
    displayName: 'Cipher Mesh',
    status: 'active',
    component: CipherMeshVisualizer,
    defaultPresetId: 'mesh-core',
    presets: [
      { id: 'mesh-core', name: 'Mesh Core' },
      { id: 'failover-amber', name: 'Failover Amber' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'prism-spectrum': {
    id: 'prism-spectrum',
    family: 'prism-spectrum',
    displayName: 'Prism',
    status: 'active',
    component: PrismVisualizer,
    defaultPresetId: 'white-split',
    presets: [
      { id: 'white-split', name: 'White Split' },
      { id: 'spectral-storm', name: 'Spectral Storm' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'triage-lanes': {
    id: 'triage-lanes',
    family: 'triage-lanes',
    displayName: 'Triage Lanes',
    status: 'active',
    component: TriageLanesVisualizer,
    defaultPresetId: 'priority-router',
    presets: [
      { id: 'priority-router', name: 'Priority Router' },
      { id: 'night-shift', name: 'Night Shift' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'commander-sigil': {
    id: 'commander-sigil',
    family: 'commander-sigil',
    displayName: 'Commander Sigil',
    status: 'active',
    component: CommanderSigilVisualizer,
    defaultPresetId: 'sovereign-pulse',
    presets: [
      { id: 'sovereign-pulse', name: 'Sovereign Pulse' },
      { id: 'crown-scope', name: 'Crown Scope' },
      { id: 'relay-halo', name: 'Relay Halo' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'annotation-lens': {
    id: 'annotation-lens',
    family: 'annotation-lens',
    displayName: 'Annotation Lens',
    status: 'active',
    component: AnnotationLensVisualizer,
    defaultPresetId: 'pattern-lens',
    presets: [
      { id: 'pattern-lens', name: 'Pattern Lens' },
      { id: 'threshold-glass', name: 'Threshold Glass' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'browser-lens': {
    id: 'browser-lens',
    family: 'browser-lens',
    displayName: 'Browser Lens',
    status: 'active',
    component: BrowserLensVisualizer,
    defaultPresetId: 'chrome-scout',
    presets: [
      { id: 'chrome-scout', name: 'Chrome Scout' },
      { id: 'deep-scrape', name: 'Deep Scrape' },
      { id: 'watchtower', name: 'Watchtower' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'momentum-board': {
    id: 'momentum-board',
    family: 'momentum-board',
    displayName: 'Momentum Board',
    status: 'active',
    component: MomentumBoardVisualizer,
    defaultPresetId: 'flow-state',
    presets: [
      { id: 'flow-state', name: 'Flow State' },
      { id: 'sprint-planner', name: 'Sprint Planner' },
      { id: 'relay-deck', name: 'Relay Deck' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'jarvis-command-hud': {
    id: 'jarvis-command-hud',
    family: 'jarvis-command-hud',
    displayName: 'HUD-Q',
    status: 'active',
    component: PrototypeVisualizer,
    defaultPresetId: 'jarvis-prime',
    presets: [
      { id: 'jarvis-prime', name: 'Jarvis Prime' },
      { id: 'sentinel-glass', name: 'Sentinel Glass' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'orbital-cathedral': {
    id: 'orbital-cathedral',
    family: 'orbital-cathedral',
    displayName: 'Orbital Cathedral',
    status: 'active',
    component: PrototypeVisualizer,
    defaultPresetId: 'white-paper',
    presets: [
      { id: 'white-paper', name: 'White Paper' },
      { id: 'boardroom', name: 'Boardroom' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'signal-bloom': {
    id: 'signal-bloom',
    family: 'signal-bloom',
    displayName: 'Signal Bloom',
    status: 'active',
    component: PrototypeVisualizer,
    defaultPresetId: 'bloom-core',
    presets: [
      { id: 'bloom-core', name: 'Bloom Core' },
      { id: 'velvet-alarm', name: 'Velvet Alarm' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'mind-swarm': {
    id: 'mind-swarm',
    family: 'mind-swarm',
    displayName: 'Mind Swarm',
    status: 'active',
    component: PrototypeVisualizer,
    defaultPresetId: 'overmind',
    presets: [
      { id: 'overmind', name: 'Overmind' },
      { id: 'oracle-mesh', name: 'Oracle Mesh' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'living-ink': {
    id: 'living-ink',
    family: 'living-ink',
    displayName: 'Living Ink',
    status: 'active',
    component: PrototypeVisualizer,
    defaultPresetId: 'venom-oracle',
    presets: [
      { id: 'venom-oracle', name: 'Venom Oracle' },
      { id: 'ghost-mouth', name: 'Ghost Mouth' },
      { id: 'chroma-beast', name: 'Chroma Beast' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'quantum-q': {
    id: 'quantum-q',
    family: 'quantum-q',
    displayName: 'Quantum Q',
    status: 'active',
    component: QuantumQVisualizer,
    defaultPresetId: 'calm-orbit',
    presets: [
      { id: 'calm-orbit', name: 'Calm Orbit' },
      { id: 'storm', name: 'Storm' },
      { id: 'singularity', name: 'Singularity' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  },
  'gaia-eye': {
    id: 'gaia-eye',
    family: 'gaia-eye',
    displayName: 'Gaia Eye',
    status: 'active',
    component: PrototypeVisualizer,
    defaultPresetId: 'blue-marble',
    presets: [
      { id: 'blue-marble', name: 'Blue Marble' },
      { id: 'emerald-tide', name: 'Emerald Tide' }
    ],
    settingsSchema: {
      global: { type: 'object', label: 'Global Tone' },
      states: { type: 'object', label: 'State Overrides' }
    }
  }
}

export function getVisualizationStudioRenderers() {
  const renderers = Object.values(VISUALIZATION_STUDIO_RENDERERS)
  const order = new Map(renderers.map((renderer, index) => [renderer.id, index]))

  const getRank = (renderer) => {
    if (renderer.id === 'commander-sigil') return 0
    if (renderer.id === 'hal-legacy') return 1
    if (renderer.family !== 'legacy') return 2
    return 3
  }

  return [...renderers].sort((a, b) => {
    const rankDelta = getRank(a) - getRank(b)
    if (rankDelta !== 0) return rankDelta
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
  })
}

export function getVisualizationStudioRenderer(rendererId) {
  return VISUALIZATION_STUDIO_RENDERERS[rendererId] || VISUALIZATION_STUDIO_RENDERERS['commander-sigil']
}

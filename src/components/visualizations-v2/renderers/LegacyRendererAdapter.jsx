import HALVisualizer from '../../hal/HALVisualizer'
import CommanderSigilVisualizer from './CommanderSigilVisualizer'
import {
  AtomVisualizer,
  BrainVisualizer,
  DnaVisualizer,
  SphereVisualizer,
  FluidVisualizer,
  HoloFieldVisualizer,
  NexusVisualizer,
  KittVisualizer,
  RippleVisualizer,
  IrisVisualizer,
  CodexVisualizer,
  CoreVisualizer
} from '../../visualizations/themes'

const LEGACY_COMPONENTS = {
  'hal-legacy': HALVisualizer,
  'atom-legacy': AtomVisualizer,
  'brain-legacy': BrainVisualizer,
  'dna-legacy': DnaVisualizer,
  'sphere-legacy': SphereVisualizer,
  'fluid-legacy': FluidVisualizer,
  'holo-legacy': HoloFieldVisualizer,
  'nexus-legacy': NexusVisualizer,
  'kitt-legacy': KittVisualizer,
  'ripple-legacy': RippleVisualizer,
  'iris-legacy': IrisVisualizer,
  'codex-legacy': CodexVisualizer,
  'core-legacy': CoreVisualizer
}

export default function LegacyRendererAdapter({
  rendererId,
  state = 'idle',
  audioData = null,
  config = {},
  assignment = null
}) {
  const Component = LEGACY_COMPONENTS[rendererId] || CommanderSigilVisualizer
  const legacyConfig = config?.legacyConfig || config

  return <Component state={state} audioData={audioData} config={legacyConfig} assignment={assignment} />
}

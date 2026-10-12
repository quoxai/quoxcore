// Theme Visualizer Components
// Ported from ai-visualizer project

// Existing visualizers
export { default as AtomVisualizer } from './AtomVisualizer'
export { default as BrainVisualizer } from './BrainVisualizer'
export { default as DnaVisualizer } from './DnaVisualizer'
export { default as SphereVisualizer } from './SphereVisualizer'

// New visualizers (neuro-fluid, holo-field, particulate)
export { default as FluidVisualizer } from './FluidVisualizer'
export { default as HoloFieldVisualizer } from './HoloFieldVisualizer'
export { default as NexusVisualizer } from './NexusVisualizer'

// Phase 1 visualizers (KITT, Ripple)
export { default as KittVisualizer } from './KittVisualizer'
export { default as RippleVisualizer } from './RippleVisualizer'

// Iris visualizer (CSS-only hyper-realistic eye)
export { default as IrisVisualizer } from './IrisVisualizer'

// Codex visualizer (ARCHIVIST-specific scrolling documents)
export { default as CodexVisualizer } from './CodexVisualizer'

// Core visualizer (COREY-specific 5-layer CORE system)
export { default as CoreVisualizer } from './CoreVisualizer'

// Visualizer metadata for theme selection
export const visualizerThemes = {
  hal: {
    name: 'Eye-Q',
    component: 'HALVisualizer',
    description: 'Classic flagship eye visualizer (FREE)',
    features: ['Iris animation', 'State-based colors', 'Audio reactivity'],
    free: true
  },
  atom: {
    name: 'Atom',
    component: 'AtomVisualizer',
    description: 'Orbiting electrons around a glowing nucleus',
    features: ['Orbital paths', 'Audio-reactive speed', 'State-based colors']
  },
  brain: {
    name: 'Brain',
    component: 'BrainVisualizer',
    description: 'Neural network visualization',
    features: ['Synaptic connections', 'Firing neurons', 'Thought waves']
  },
  dna: {
    name: 'DNA',
    component: 'DnaVisualizer',
    description: 'Double helix structure',
    features: ['Rotating helix', 'Base pair connections', 'Audio modulation']
  },
  sphere: {
    name: 'Sphere',
    component: 'SphereVisualizer',
    description: 'Pulsing 3D sphere',
    features: ['Point cloud', 'Audio reactivity', 'State-based deformation']
  },
  fluid: {
    name: 'Neuro Fluid',
    component: 'FluidVisualizer',
    description: 'Flowing particle system with physics-based movement',
    features: ['Flow field noise', 'State-based attraction/repulsion', 'Trail effects']
  },
  holo: {
    name: 'Holo Field',
    component: 'HoloFieldVisualizer',
    description: 'Holographic expanding MFCC audio rings',
    features: ['MFCC visualization', 'Expanding rings with twist', 'Speech detection glow']
  },
  nexus: {
    name: 'Nexus',
    component: 'NexusVisualizer',
    description: 'Connected 3D particle network',
    features: ['3D rotation', 'Mesh connections', 'Mouse interaction', 'Command-surface rings']
  },
  kitt: {
    name: 'KITT',
    component: 'KittVisualizer',
    description: 'Classic Knight Rider scanner bar effect',
    features: ['LED segment bar', 'Scanner sweep', 'Audio reactivity', 'Glow effects']
  },
  ripple: {
    name: 'Ripple',
    component: 'RippleVisualizer',
    description: 'Concentric expanding rings',
    features: ['Wave motion', 'Audio-reactive expansion', 'Rotating dots during thinking']
  },
  iris: {
    name: 'Iris',
    component: 'IrisVisualizer',
    description: 'Hyper-realistic human iris with neural reactivity',
    features: ['Layered iris texture', 'Pupil dilation', 'State-based animations', 'Audio reactivity']
  },
  codex: {
    name: 'Codex',
    component: 'CodexVisualizer',
    description: 'Scrolling manuscript visualization for ARCHIVIST',
    features: ['Cascading text columns', 'Pattern highlighting', 'Archive aesthetic', 'Document connections'],
    requiresPlugins: ['visualizations', 'files']
  },
  core: {
    name: 'Core',
    component: 'CoreVisualizer',
    description: 'CORE system visualization for COREY - 5 layers and 10 cognitive implants',
    features: ['Orbital layer rings', 'Implant nodes', 'Neural connections', 'Data flow animation', 'Audio reactivity']
  }
}

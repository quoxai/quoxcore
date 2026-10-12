/**
 * OpsDeck3D Unified Design System
 *
 * Single source of truth for all visual parameters.
 * Every object in the scene references this — no hardcoded values in components.
 * Tunable via the settings panel at runtime.
 */

// ─── Default tuning values (overridden by settings sliders) ──────

export const DEFAULTS = {
  // Bloom
  bloomIntensity: 0.8,
  bloomThreshold: 0.5,
  bloomSmoothing: 0.9,

  // Global
  ambientIntensity: 0.15,
  fogDensity: 0.004,  // Reduced for Fibonacci layout (larger scene)
  vignetteStrength: 0.7,
  globalScale: 1.0,

  // Nucleus
  nucleusBreathAmp: 0.03,
  nucleusRingOpacity: 0.5,
  nucleusGlow: 0.6,

  // Shell
  shellOpacity: 0.15,
  shellRotationSpeed: 0.0003,

  // Agents
  agentGlow: 0.7,
  agentFloatAmp: 0.1,
  agentRingSpeed: 1.0,
  agentLabelOpacity: 0.8,

  // Execution
  taskOrbitSpeed: 0.5,
  taskGlow: 0.6,

  // Memory
  crystalGlow: 0.5,
  crystalDriftSpeed: 0.05,
  crystalScale: 1.0,

  // Particles
  particleCount: 400,
  particleOpacity: 0.2,
  particleSize: 0.08,

  // Grid
  gridOpacity: 0.2,
  sonarSpeed: 10,

  // Connection lines
  connectionOpacity: 0.08,

  // Delegation arcs
  arcSpeed: 1.5,
  arcInterval: 4,

  // Heartbeat
  heartbeatInterval: 8,
  heartbeatOpacity: 0.06,

  // Node detail
  nodeWireOpacity: 0.3,
  nodeInnerScale: 0.65,
  nodeGroundGlow: 0.12,

  // Zone rings
  zoneRingOpacity: 0.1,
  zoneLabelOpacity: 0.3,
  zoneLabels: 1,

  // Orbit paths
  taskOrbitOpacity: 0.06,
  memoryOrbitOpacity: 0.04,

  // Horus
  horusEyeHue: 0, // 0=red, 30=orange, 60=gold, 120=green, 195=cyan, 270=purple, 330=pink
}

// ─── Colour Palette ──────────────────────────────────────

export const PALETTE = {
  // Brand
  indigo: '#6366f1',
  violet: '#8b5cf6',
  cyan: '#06b6d4',

  // System states
  idle: '#555570',
  thinking: '#6366f1',
  executing: '#22c55e',
  reading: '#06b6d4',
  writing: '#0891b2',
  blocked: '#ef4444',
  waiting: '#f59e0b',
  done: '#10b981',
  stale: '#92400e',
  active: '#818cf8',

  // Zones
  nucleus: '#6366f1',
  shell: '#8b5cf6',
  grid: '#6366f1',
  memory: '#ec4899',

  // Memory types
  entity: '#ec4899',
  fact: '#818cf8',
  decision: '#a78bfa',
  preference: '#22d3ee',
  openLoop: '#f59e0b',

  // Misc
  delegation: '#06b6d4',
  connection: '#ffffff',
  text: '#ffffff',
}

// ─── Agent State → Visual Properties ─────────────────────

export const STATE_VISUALS = {
  idle:               { color: PALETTE.idle,      glow: 0.15, ringSpeed: 0,   animate: 'float' },
  thinking:           { color: PALETTE.thinking,   glow: 0.8,  ringSpeed: 1.0, animate: 'pulse' },
  executing:          { color: PALETTE.executing,  glow: 0.9,  ringSpeed: 1.5, animate: 'pulse' },
  reading:            { color: PALETTE.reading,    glow: 0.6,  ringSpeed: 0.8, animate: 'float' },
  writing:            { color: PALETTE.writing,    glow: 0.7,  ringSpeed: 1.0, animate: 'float' },
  blocked:            { color: PALETTE.blocked,    glow: 1.0,  ringSpeed: 0,   animate: 'shake' },
  waiting_input:      { color: PALETTE.waiting,    glow: 0.7,  ringSpeed: 0.4, animate: 'breathe' },
  waiting_permission: { color: PALETTE.waiting,    glow: 0.8,  ringSpeed: 0.6, animate: 'breathe' },
  handing_off:        { color: PALETTE.delegation, glow: 0.6,  ringSpeed: 2.0, animate: 'shrink' },
  done:               { color: PALETTE.done,       glow: 0.3,  ringSpeed: 0,   animate: 'fade' },
  stale:              { color: PALETTE.stale,      glow: 0.2,  ringSpeed: 0.1, animate: 'flicker' },
  active:             { color: PALETTE.active,     glow: 0.8,  ringSpeed: 1.0, animate: 'pulse' },
}

// ─── Unified Node Shape ──────────────────────────────────
// ALL nodes use octahedron at different scales.
// Role = scale. State = colour + glow. This is the OpsDeck3D signature.

export const NODE_SCALES = {
  orchestrator: 1.4,
  manager: 1.0,
  specialist: 0.7,
  analyst: 0.7,
  plugin: 0.6,
  task: 0.35,
  memory: 0.4,
  objective: 1.6,
}

// ─── Unified Material ────────────────────────────────────
// Single material recipe used everywhere. Only colour/glow/opacity change.

export function nodeMaterial(color, glow, opacity = 0.85) {
  return {
    color,
    emissive: color,
    emissiveIntensity: glow,
    transparent: true,
    opacity,
    roughness: 0.35,
    metalness: 0.05,
  }
}

// ─── Memory Crystal Variants ─────────────────────────────
// Still octahedron, but squished/stretched to suggest type

export const MEMORY_VARIANTS = {
  entity:     { scaleY: 1.0, color: PALETTE.entity },
  fact:       { scaleY: 1.3, color: PALETTE.fact },       // Taller = pillar of knowledge
  decision:   { scaleY: 0.7, color: PALETTE.decision },   // Flatter = settled, grounded
  preference: { scaleY: 1.0, color: PALETTE.preference },
  openLoop:   { scaleY: 1.0, color: PALETTE.openLoop },   // Pulses
  error:      { scaleY: 0.5, color: PALETTE.blocked },
}

// ─── Settings Slider Definitions ─────────────────────────
// Used to build the tuning panel UI

export const SLIDER_DEFS = [
  { group: 'Bloom',      key: 'bloomIntensity',    label: 'Intensity',      min: 0, max: 2,    step: 0.05 },
  { group: 'Bloom',      key: 'bloomThreshold',    label: 'Threshold',      min: 0, max: 1,    step: 0.05 },
  { group: 'Scene',      key: 'ambientIntensity',  label: 'Ambient Light',  min: 0, max: 0.5,  step: 0.01 },
  { group: 'Scene',      key: 'fogDensity',        label: 'Fog Density',    min: 0, max: 0.03, step: 0.001 },
  { group: 'Scene',      key: 'vignetteStrength',  label: 'Vignette',       min: 0, max: 1,    step: 0.05 },
  { group: 'Nucleus',    key: 'nucleusBreathAmp',  label: 'Breath Depth',   min: 0, max: 0.1,  step: 0.005 },
  { group: 'Nucleus',    key: 'nucleusGlow',       label: 'Core Glow',      min: 0, max: 1.5,  step: 0.05 },
  { group: 'Nucleus',    key: 'nucleusRingOpacity',label: 'Ring Opacity',   min: 0, max: 1,    step: 0.05 },
  { group: 'Shell',      key: 'shellOpacity',      label: 'Shell Opacity',  min: 0, max: 0.5,  step: 0.01 },
  { group: 'Shell',      key: 'shellRotationSpeed',label: 'Rotation Speed', min: 0, max: 0.003,step: 0.0001 },
  { group: 'Agents',     key: 'agentGlow',         label: 'Node Glow',      min: 0, max: 1.5,  step: 0.05 },
  { group: 'Agents',     key: 'agentFloatAmp',     label: 'Float Amount',   min: 0, max: 0.4,  step: 0.01 },
  { group: 'Agents',     key: 'agentRingSpeed',    label: 'Ring Speed',     min: 0, max: 3,    step: 0.1 },
  { group: 'Agents',     key: 'agentLabelOpacity', label: 'Label Opacity',  min: 0, max: 1,    step: 0.05 },
  { group: 'Memory',     key: 'crystalGlow',       label: 'Crystal Glow',   min: 0, max: 1.5,  step: 0.05 },
  { group: 'Memory',     key: 'crystalScale',      label: 'Crystal Size',   min: 0.3, max: 2,  step: 0.05 },
  { group: 'Memory',     key: 'crystalDriftSpeed', label: 'Drift Speed',    min: 0, max: 0.2,  step: 0.005 },
  { group: 'Particles',  key: 'particleOpacity',   label: 'Opacity',        min: 0, max: 0.6,  step: 0.02 },
  { group: 'Particles',  key: 'particleSize',      label: 'Size',           min: 0.02, max: 0.3, step: 0.01 },
  { group: 'Grid',       key: 'gridOpacity',       label: 'Grid Brightness',min: 0, max: 0.5,  step: 0.01 },
  { group: 'Grid',       key: 'sonarSpeed',        label: 'Sonar Interval', min: 3, max: 20,   step: 1 },
  { group: 'Lines',      key: 'connectionOpacity', label: 'Thread Opacity', min: 0, max: 0.3,  step: 0.01 },
  { group: 'Arcs',       key: 'arcInterval',       label: 'Arc Frequency',  min: 1, max: 10,   step: 0.5 },
  { group: 'Heartbeat',  key: 'heartbeatInterval', label: 'Pulse Interval', min: 2, max: 20,   step: 0.5 },
  { group: 'Heartbeat',  key: 'heartbeatOpacity',  label: 'Pulse Opacity',  min: 0, max: 0.3,  step: 0.01 },
  { group: 'Node Detail', key: 'nodeWireOpacity',  label: 'Wire Outline',   min: 0, max: 0.8,  step: 0.02 },
  { group: 'Node Detail', key: 'nodeInnerScale',   label: 'Core Size',      min: 0.3, max: 0.9, step: 0.02 },
  { group: 'Node Detail', key: 'nodeGroundGlow',   label: 'Ground Disc',    min: 0, max: 0.4,  step: 0.01 },
  { group: 'Zones',     key: 'zoneRingOpacity',    label: 'Ring Opacity',   min: 0, max: 0.3,  step: 0.01 },
  { group: 'Zones',     key: 'zoneLabelOpacity',   label: 'Label Opacity',  min: 0, max: 0.8,  step: 0.02 },
  { group: 'Orbits',    key: 'taskOrbitOpacity',    label: 'Task Orbits',    min: 0, max: 0.2,  step: 0.005 },
  { group: 'Orbits',    key: 'memoryOrbitOpacity',  label: 'Memory Orbits',  min: 0, max: 0.15, step: 0.005 },
  { group: 'Horus',     key: 'horusEyeHue',        label: 'Eye Colour',     min: 0, max: 360,  step: 5 },
]

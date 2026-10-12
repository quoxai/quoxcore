/**
 * Visual Palettes Configuration
 *
 * Categorical color palettes for the Cognitive Topology visualization.
 * Colors are assigned to IMPLANTS (the chips), and data nodes inherit
 * the color of the implant they belong to.
 *
 * Sources:
 * - Observable 10: https://observablehq.com/blog/crafting-data-colors
 * - Tableau 10: https://www.tableau.com/blog/colors-upgrade-tableau-10-56782
 * - ColorBrewer Set3: https://colorbrewer2.org/#type=qualitative&scheme=Set3
 */

// =============================================================================
// PALETTE DEFINITIONS
// =============================================================================

export const PALETTE_OBSERVABLE = {
  id: 'observable',
  name: 'Observable',
  colors: [
    '#4269D0',  // 0: blue
    '#EFB118',  // 1: orange
    '#FF725C',  // 2: red
    '#6CC5B0',  // 3: teal
    '#3CA951',  // 4: green
    '#FF8AB7',  // 5: pink
    '#A463F2',  // 6: purple
    '#97BBF5',  // 7: light blue
    '#9C6B4E',  // 8: brown
    '#9498A0',  // 9: gray
  ]
}

export const PALETTE_TABLEAU = {
  id: 'tableau',
  name: 'Tableau',
  colors: [
    '#4e79a7',  // 0: steel blue
    '#f28e2c',  // 1: orange
    '#e15759',  // 2: red
    '#76b7b2',  // 3: teal
    '#59a14f',  // 4: green
    '#edc949',  // 5: yellow
    '#af7aa1',  // 6: purple
    '#ff9da7',  // 7: pink
    '#9c755f',  // 8: brown
    '#bab0ab',  // 9: gray
  ]
}

export const PALETTE_COLORBREWER = {
  id: 'colorbrewer',
  name: 'Pastel',
  colors: [
    '#8dd3c7',  // 0: teal
    '#fb8072',  // 1: salmon
    '#80b1d3',  // 2: sky blue
    '#fdb462',  // 3: orange
    '#b3de69',  // 4: lime
    '#fccde5',  // 5: pink
    '#bebada',  // 6: lavender
    '#ffffb3',  // 7: yellow
    '#bc80bd',  // 8: purple
    '#ccebc5',  // 9: mint
  ]
}

export const PALETTE_VIVID = {
  id: 'vivid',
  name: 'Vivid',
  colors: [
    '#1f77b4',  // 0: blue
    '#ff7f0e',  // 1: orange
    '#2ca02c',  // 2: green
    '#d62728',  // 3: red
    '#9467bd',  // 4: purple
    '#8c564b',  // 5: brown
    '#e377c2',  // 6: pink
    '#7f7f7f',  // 7: gray
    '#bcbd22',  // 8: olive
    '#17becf',  // 9: cyan
  ]
}

// =============================================================================
// IMPLANT COLOR ASSIGNMENTS
// Each implant gets a unique palette index
// =============================================================================

const IMPLANT_INDICES = {
  'quox-sense': 2,         // red - perceptual core
  'quox-memory': 6,        // purple
  'quox-temporal': 1,      // orange
  'quox-focus': 0,         // blue
  'quox-value': 3,         // teal
  'quox-guard': 4,         // green
  'quox-insight': 4,       // green
  'quox-executive': 7,     // light blue/pink
  'quox-predict': 9,       // gray
  'quox-reflect': 9,       // gray
  'quox-dream': 8,         // brown
  'quox-learn': 5,         // pink
  'infrastructure': 0,     // blue - hosts/infrastructure
}

// =============================================================================
// NODE TYPE TO IMPLANT MAPPING
// Data nodes inherit color from their parent implant
// =============================================================================

const NODE_TYPE_TO_IMPLANT = {
  // QuoxSense — perceptual core
  core: 'quox-sense',

  // QuoxMemory — all memory types
  memory: 'quox-memory',
  fact: 'quox-memory',
  preference: 'quox-memory',
  decision: 'quox-memory',
  reflection: 'quox-memory',
  conversation: 'quox-memory',

  // QuoxValue — capabilities and tools
  tool: 'quox-value',

  // QuoxInsight — integrations and patterns
  integration: 'quox-insight',
  workflow: 'quox-insight',

  // QuoxExecutive — agent coordination
  agent: 'quox-executive',

  // QuoxLearn — files and knowledge
  file: 'quox-learn',
  entity: 'quox-learn',

  // Infrastructure — hosts from Bastion
  host: 'infrastructure',
  'host-online': 'infrastructure',
  'host-offline': 'infrastructure',
}

// =============================================================================
// GENERATED COLOR MAPS
// =============================================================================

function buildImplantColorMap(palette) {
  const map = {}
  for (const [implantId, idx] of Object.entries(IMPLANT_INDICES)) {
    map[implantId] = palette.colors[idx] || palette.colors[0]
  }
  return map
}

function buildNodeTypeColorMap(palette) {
  const map = {}
  for (const [nodeType, implantId] of Object.entries(NODE_TYPE_TO_IMPLANT)) {
    const idx = IMPLANT_INDICES[implantId] ?? 9
    map[nodeType] = palette.colors[idx] || palette.colors[9]
  }
  return map
}

export const IMPLANT_COLOR_MAP = {
  'observable': buildImplantColorMap(PALETTE_OBSERVABLE),
  'tableau': buildImplantColorMap(PALETTE_TABLEAU),
  'colorbrewer': buildImplantColorMap(PALETTE_COLORBREWER),
  'vivid': buildImplantColorMap(PALETTE_VIVID),
}

export const NODE_TYPE_COLOR_MAP = {
  'observable': buildNodeTypeColorMap(PALETTE_OBSERVABLE),
  'tableau': buildNodeTypeColorMap(PALETTE_TABLEAU),
  'colorbrewer': buildNodeTypeColorMap(PALETTE_COLORBREWER),
  'vivid': buildNodeTypeColorMap(PALETTE_VIVID),
}

// =============================================================================
// LEGEND - Shows implants (matches the chips below)
// =============================================================================

export const LEGEND_ITEMS = [
  { type: 'quox-sense', label: 'Sense', implant: true },
  { type: 'quox-memory', label: 'Memory', implant: true },
  { type: 'quox-executive', label: 'Executive', implant: true },
  { type: 'quox-value', label: 'Value', implant: true },
  { type: 'quox-insight', label: 'Insight', implant: true },
  { type: 'quox-temporal', label: 'Temporal', implant: true },
  { type: 'quox-learn', label: 'Learn', implant: true },
  { type: 'infrastructure', label: 'Hosts', implant: true },
]

// =============================================================================
// IMPLANT TO NODE TYPES (for legend hover highlighting)
// =============================================================================

export const IMPLANT_TO_NODE_TYPES = {
  'quox-sense': ['core'],
  'quox-memory': ['memory', 'fact', 'preference', 'decision', 'reflection', 'conversation'],
  'quox-temporal': ['memory', 'conversation'],
  'quox-focus': ['memory', 'entity'],
  'quox-value': ['tool'],
  'quox-guard': ['integration'],
  'quox-insight': ['integration', 'workflow'],
  'quox-executive': ['agent'],
  'quox-predict': ['integration'],
  'quox-reflect': ['agent'],
  'quox-dream': ['memory', 'entity'],
  'quox-learn': ['file', 'entity'],
  'infrastructure': ['host', 'host-online', 'host-offline'],
}

// =============================================================================
// EXPORTS
// =============================================================================

export const PALETTES = {
  'observable': PALETTE_OBSERVABLE,
  'tableau': PALETTE_TABLEAU,
  'colorbrewer': PALETTE_COLORBREWER,
  'vivid': PALETTE_VIVID,
}

// Helper to get color for a node type (inherits from implant)
export function getNodeTypeColor(type, paletteId = 'observable') {
  return NODE_TYPE_COLOR_MAP[paletteId]?.[type] || NODE_TYPE_COLOR_MAP['observable'][type] || '#9498A0'
}

// Helper to get color for an implant
export function getImplantColor(implantId, paletteId = 'observable') {
  return IMPLANT_COLOR_MAP[paletteId]?.[implantId] || IMPLANT_COLOR_MAP['observable'][implantId] || '#9498A0'
}

// Get raw palette colors array
export function getPaletteColors(paletteId = 'observable') {
  return PALETTES[paletteId]?.colors || PALETTE_OBSERVABLE.colors
}

export default PALETTES

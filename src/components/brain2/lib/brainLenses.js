// ── BRAIN2-V2 lens system (Wave 1) ──────────────────────────────────────────
// Sequential, accessible colour bands for the three new "lenses" that recolour
// the graph by a per-node signal. Warm = fresh / active, cool = old / unused.
// Every ramp entry is a 6-digit hex (never rgba()): paintNode appends a 2-hex
// alpha suffix directly onto whatever nodeColor returns for its glow gradient.
// Missing fields (old graph payloads) degrade to the "cold" end, never undefined.
//
// Extracted verbatim from QuoxbrainView.jsx (Phase 0 refactor, behavior-preserving).
export const RECENCY_RAMP = { day: '#fde68a', week: '#fbbf24', month: '#fb923c', year: '#94a3b8', older: '#475569' }
export const CITATION_RAMP = { none: '#475569', low: '#0ea5e9', mid: '#22d3ee', high: '#a5f3fc' }
export const CONSOLIDATION_RAMP = { consolidated: '#34d399', pending: '#fbbf24' }
export const LENS_FALLBACK = '#94a3b8'
export const MS_PER_DAY = 86400000

// Age of node.updatedAt from now → a recency band. Undefined / unparseable →
// the oldest ('older') band, so a payload missing updatedAt never crashes.
export function recencyColor(updatedAt) {
  if (!updatedAt) return RECENCY_RAMP.older
  const t = Date.parse(updatedAt)
  if (!Number.isFinite(t)) return RECENCY_RAMP.older
  const ageDays = (Date.now() - t) / MS_PER_DAY
  if (ageDays < 1) return RECENCY_RAMP.day
  if (ageDays < 7) return RECENCY_RAMP.week
  if (ageDays < 30) return RECENCY_RAMP.month
  if (ageDays < 365) return RECENCY_RAMP.year
  return RECENCY_RAMP.older
}
// Agent citation count → a usage band. Undefined → treated as 0 (uncited).
export function citationColor(citedCount) {
  const c = Number.isFinite(citedCount) ? citedCount : 0
  if (c <= 0) return CITATION_RAMP.none
  if (c <= 2) return CITATION_RAMP.low
  if (c <= 5) return CITATION_RAMP.mid
  return CITATION_RAMP.high
}
// QuoxDream consolidation coverage → consolidated vs pending. Anything not
// strictly true (undefined included) reads as pending.
export function consolidationColor(consolidated) {
  return consolidated === true ? CONSOLIDATION_RAMP.consolidated : CONSOLIDATION_RAMP.pending
}

// The five lenses offered by the picker. 'scope'/'source' keep the existing
// grouping behaviour; the three new lenses recolour only (no vault clustering).
export const LENS_OPTIONS = [
  { value: 'scope', label: 'Scope' },
  { value: 'source', label: 'Source' },
  { value: 'recency', label: 'Recency' },
  { value: 'citations', label: 'Agent use' },
  { value: 'consolidation', label: 'Consolidation' }
]

// Legend bands per new lens: one labelled dot each, rendered when that lens is
// active. scope/source legends are data-driven from sourcesMeta below instead.
export const LENS_LEGENDS = {
  recency: [
    { color: RECENCY_RAMP.day, label: 'Today' },
    { color: RECENCY_RAMP.week, label: 'This week' },
    { color: RECENCY_RAMP.month, label: 'This month' },
    { color: RECENCY_RAMP.year, label: 'This year' },
    { color: RECENCY_RAMP.older, label: 'Older' }
  ],
  citations: [
    { color: CITATION_RAMP.none, label: 'Uncited' },
    { color: CITATION_RAMP.low, label: '1-2' },
    { color: CITATION_RAMP.mid, label: '3-5' },
    { color: CITATION_RAMP.high, label: '6+' }
  ],
  consolidation: [
    { color: CONSOLIDATION_RAMP.consolidated, label: 'Consolidated' },
    { color: CONSOLIDATION_RAMP.pending, label: 'Pending' }
  ]
}

// Pure resolver mirroring the component's nodeColor switch exactly.
// scopeColors = the SCOPE_COLORS map, sourceColorMap = the per-vault color Map.
export function resolveNodeColor(node, { colorBy, sourceColorMap, scopeColors }) {
  switch (colorBy) {
    case 'source': return sourceColorMap.get(node.vaultId) || LENS_FALLBACK
    case 'recency': return recencyColor(node.updatedAt)
    case 'citations': return citationColor(node.citedCount)
    case 'consolidation': return consolidationColor(node.consolidated)
    case 'scope':
    default: return scopeColors[node.scope] || LENS_FALLBACK
  }
}

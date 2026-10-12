/** P3 pure helpers for the timeline and the relationship graph (no I/O, unit tested). */
import { DIRECTIONS, EDGE_TYPES, OUTCOMES, SURFACES } from './reasonCodes'

const sentence = (code) => String(code || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** One timeline row as display text. Summary is shown only when the server sent one (humans). */
export function describeTouchpoint(t) {
  const surface = SURFACES.find((s) => s.key === t.surface)?.label || sentence(t.surface)
  return {
    surface,
    direction: DIRECTIONS[t.direction] || sentence(t.direction),
    outcome: t.outcome ? (OUTCOMES[t.outcome] || sentence(t.outcome)) : '',
    summary: typeof t.summary === 'string' && t.summary ? t.summary : null,
    ref: t.ref || null,
  }
}

/** "Works at Acme" / "Employs Sarah" plus the optional role and department. */
export function describeEdge(e) {
  const meta = EDGE_TYPES.find((x) => x.key === e.type)
  const verbs = {
    works_at: ['Works at', 'Employs'], reports_to: ['Reports to', 'Manager of'], assistant_of: ['Assistant of', 'Has assistant'],
    introduced_by: ['Introduced by', 'Introduced'], related_to: ['Related to', 'Related to'], supplier_to: ['Supplier to', 'Supplied by'],
    customer_of: ['Customer of', 'Has customer'], is_subsidiary_of: ['Subsidiary of', 'Parent of'],
  }[e.type] || [sentence(e.type), sentence(e.type)]
  const verb = meta ? (e.direction === 'in' ? meta.in : meta.out) : (e.direction === 'in' ? verbs[1] : verbs[0])
  const name = e.other?.display_name || 'Unknown contact'
  const detail = [e.attrs?.role, e.attrs?.dept, e.attrs?.label].filter(Boolean).join(', ')
  return { verb, name, detail, text: `${verb} ${name}${detail ? ` (${detail})` : ''}` }
}

/** Build the POST body from the add-relationship form. Blank attrs are dropped. */
export function buildEdgeBody({ type, toId, role, dept, label }) {
  const attrs = {}
  if (type === 'works_at') { if (role?.trim()) attrs.role = role.trim(); if (dept?.trim()) attrs.dept = dept.trim() }
  if (type === 'related_to' && label?.trim()) attrs.label = label.trim()
  return { type, to_id: toId, ...(Object.keys(attrs).length ? { attrs } : {}) }
}

/** The kinds a picker may offer for a relationship type ('organisation' | 'person' | null for any). */
export function pickerKind(type) {
  return EDGE_TYPES.find((x) => x.key === type)?.needsKind || null
}

const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * What the add-relationship form will link to (owner 2026-10-10: "why can't I just type the organisation").
 * A picked suggestion wins; else a typed name that exactly matches a suggestion (case and punctuation folded) uses it;
 * else the typed name is CREATED as a new contact of the right kind. -> { mode: 'existing', id, name } |
 * { mode: 'create', name, kind } | { mode: 'none' }.
 */
export function resolveTarget({ picked, typed, results = [], kind }) {
  if (picked) return { mode: 'existing', id: picked.id, name: picked.display_name }
  const name = String(typed || '').trim()
  if (!name) return { mode: 'none' }
  const hit = results.find((c) => fold(c.display_name) === fold(name) && (!kind || c.kind === kind))
  if (hit) return { mode: 'existing', id: hit.id, name: hit.display_name }
  return { mode: 'create', name, kind: kind || 'person' }
}

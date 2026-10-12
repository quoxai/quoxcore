/** Pure helpers for the NotesQ Skills folder (skills stay owned by quoxflow; nothing here persists). */
import { chipClass } from './tagHue'

export const skillBody = (s) => (s && (s.bodyMd ?? s.body_md)) || ''
export const skillUpdated = (s) => (s && (s.updatedAt ?? s.updated_at)) || ''

const EDITION_HUE = { experimental: 'amber', stable: 'green', deprecated: 'slate', archived: 'slate' }
export const editionChipClass = (edition) => chipClass(EDITION_HUE[edition || 'experimental'] || 'slate')

/** Client-side filter over name, description and tags. */
export function filterSkills(skills, q) {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return skills
  return skills.filter((s) => `${s.name || ''} ${s.description || ''} ${(s.tags || []).join(' ')}`.toLowerCase().includes(needle))
}

/** `source:notesq:<id>` tag written when a note is proposed as a skill. */
export function sourceNoteId(skill) {
  for (const t of skill?.tags || []) {
    const m = /^source:notesq:(.+)$/.exec(String(t))
    if (m) return m[1]
  }
  return null
}

/** Firewall / rule findings from a failed patch, whatever envelope slot they arrive in. */
export function findingsOf(err) {
  const d = err?.data
  const list = Array.isArray(d) ? d : Array.isArray(d?.findings) ? d.findings : []
  return list.map((f) => ({
    severity: f.severity || f.level || '',
    rule: f.rule_id || f.ruleId || f.rule || f.id || '',
    message: f.message || f.description || f.reason || '',
  }))
}

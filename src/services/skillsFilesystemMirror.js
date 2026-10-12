/**
 * skillsFilesystemMirror — QSKL-1
 *
 * Frontend-callable helper that formats a QuoxSkill record as a YAML-frontmatter
 * Markdown file, mirroring the shape stored under:
 *   src/config/skills/<category>/<name>/SKILL.md
 *
 * The browser cannot write to disk, so this helper is intended for server-side
 * tooling (e.g. a post-save hook in the collector, a CLI sync script, or future
 * Toolsmith automation). For QSKL-1, the helper is exported but has no callsites
 * at runtime — it is exercised via unit tests only.
 *
 * Usage:
 *   import { formatSkillForMirror } from './skillsFilesystemMirror'
 *   const { relativePath, content } = formatSkillForMirror(skill)
 *   // relativePath  → 'src/config/skills/security/network-egress-snapshot/SKILL.md'
 *   // content       → '---\nid: ...\n---\n\n# Skill Name\n...'
 */

/**
 * Serialise a scalar or array value for YAML frontmatter output.
 * Arrays are rendered as inline flow sequences: [a, b, c].
 * Strings with newlines are rendered as block scalars.
 * Everything else is rendered inline.
 *
 * @param {*} value
 * @returns {string}
 */
function yamlValue(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(v => String(v)).join(', ') + ']'
  }
  if (typeof value === 'string' && value.includes('\n')) {
    // Block scalar (literal)
    return '|\n' + value.split('\n').map(l => '  ' + l).join('\n')
  }
  return String(value ?? '')
}

/**
 * Build a YAML frontmatter block from a flat key-value object.
 * Keys with undefined/null values are omitted.
 *
 * @param {Record<string, *>} fields
 * @returns {string} — '---\nkey: value\n...\n---'
 */
function buildFrontmatter(fields) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    lines.push(`${key}: ${yamlValue(value)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

/**
 * Format a QuoxSkillRecord for the filesystem mirror.
 *
 * @param {object} skill — A QuoxSkillRecord (or partial shape) from the backend.
 * @returns {{ relativePath: string, content: string }}
 *   relativePath: path relative to the dashboard repo root where this file lives.
 *   content:      full file content (YAML frontmatter + Markdown body).
 */
export function formatSkillForMirror(skill) {
  if (!skill || typeof skill !== 'object') {
    throw new TypeError('formatSkillForMirror: skill must be an object')
  }

  const name = String(skill.name || 'unknown').toLowerCase().replace(/\s+/g, '-')
  const category = String(skill.category || 'other').toLowerCase()
  const relativePath = `src/config/skills/${category}/${name}/SKILL.md`

  const frontmatter = buildFrontmatter({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    version: skill.version,
    edition: skill.edition,
    author: skill.author,
    authoring_envelope_id: skill.authoringEnvelopeId,
    description: skill.description,
    tags: skill.tags,
    best_for_agents: skill.bestForAgents,
    required_tools: skill.requiredTools,
    policy_satisfies: skill.policySatisfies,
    policy_required: skill.policyRequired,
    kind: skill.kind || 'procedural',
    last_used_at: skill.lastUsedAt,
    last_patched_at: skill.lastPatchedAt,
    decay_state: skill.decayState,
  })

  const title = skill.name || 'Skill'
  const body = skill.bodyMd ? skill.bodyMd.trim() : `# ${title}\n\n_No body yet._`
  const heading = body.startsWith('#') ? '' : `# ${title}\n\n`
  const content = `${frontmatter}\n\n${heading}${body}\n`

  return { relativePath, content }
}

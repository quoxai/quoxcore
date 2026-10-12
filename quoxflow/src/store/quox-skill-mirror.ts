/**
 * quox-skill-mirror — QSKL-1 Gap A
 *
 * Filesystem mirror for QuoxSkill records.
 * Writes <mirrorPath>/<category>/<name>/SKILL.md on create/update.
 *
 * Mirrors the frontmatter key set from quox-dashboard/src/services/skillsFilesystemMirror.js.
 * This is a server-side TypeScript reimplementation — does NOT import that JS file.
 *
 * Behaviour:
 *   - If QUOX_SKILLS_MIRROR_PATH is unset → skip silently.
 *   - mkdir -p the parent dir before write; idempotent overwrite.
 *   - Write failure logs a warning and continues — mirror is not a contract.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { QuoxSkillRecord } from './quox-skills-store.js';

// ─── Slug helper ──────────────────────────────────────────────────────────────

/**
 * Slugify a string: lowercase, spaces→dashes, strip non [a-z0-9._-].
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
}

// ─── YAML helpers ─────────────────────────────────────────────────────────────

function yamlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map(v => String(v)).join(', ') + ']';
  }
  if (typeof value === 'string' && value.includes('\n')) {
    // Block scalar (literal)
    return '|\n' + value.split('\n').map(l => '  ' + l).join('\n');
  }
  return String(value ?? '');
}

function buildFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// ─── Format ──────────────────────────────────────────────────────────────────

/**
 * Format a QuoxSkillRecord as YAML-frontmatter + Markdown content.
 * Returns { filePath, content } where filePath is absolute.
 */
export function formatSkillForMirror(
  skill: QuoxSkillRecord,
  mirrorPath: string
): { filePath: string; content: string } {
  const nameSlug = slugify(skill.name);
  const categorySlug = slugify(skill.category);
  const filePath = path.join(mirrorPath, categorySlug, nameSlug, 'SKILL.md');

  const frontmatter = buildFrontmatter({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    version: skill.version,
    edition: skill.edition,
    author: skill.author,
    authoring_envelope_id: skill.authoringEnvelopeId,
    description: skill.description,
    // SKILLRIGHTS #478: only written when the record has a declaration.
    // buildFrontmatter() skips undefined/null values, so an undeclared
    // licence produces no line at all rather than an empty placeholder.
    license: skill.license,
    tags: skill.tags,
    best_for_agents: skill.bestForAgents,
    required_tools: skill.requiredTools,
    policy_satisfies: skill.policySatisfies,
    policy_required: skill.policyRequired,
    kind: skill.kind ?? 'procedural',
    last_used_at: skill.lastUsedAt,
    last_patched_at: skill.lastPatchedAt,
    decay_state: skill.decayState,
  });

  const body = skill.bodyMd ? skill.bodyMd.trim() : `# ${skill.name}\n\n_No body yet._`;
  const heading = body.startsWith('#') ? '' : `# ${skill.name}\n\n`;
  const content = `${frontmatter}\n\n${heading}${body}\n`;

  return { filePath, content };
}

// ─── Write helper (fire-and-forget safe) ─────────────────────────────────────

/**
 * Write the SKILL.md mirror file for a record.
 * Reads QUOX_SKILLS_MIRROR_PATH from env; no-ops if unset.
 * Never throws — logs and swallows FS errors.
 */
export async function mirrorSkillToDisk(skill: QuoxSkillRecord): Promise<void> {
  const mirrorPath = process.env.QUOX_SKILLS_MIRROR_PATH;
  if (!mirrorPath) return;

  try {
    const { filePath, content } = formatSkillForMirror(skill, mirrorPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  } catch (err) {
    console.warn('[quox-skill-mirror] Failed to write FS mirror:', err);
  }
}

/**
 * skill-seed-loader.ts — QSKL-10.1
 *
 * Filesystem → Postgres skill seed loader.
 *
 * Scans <seedPath>/<category>/<skill-name>/SKILL.md (two-level glob),
 * parses YAML frontmatter, and upserts records into the quox_skills table
 * via QuoxSkillsStore. Idempotent and boot-safe (never throws on soft errors).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { QuoxSkillsStore, createInMemoryQuoxSkillsStore, SEED_CATALOG_ORG_ID } from './quox-skills-store.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SeedSkillsResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

export interface SeedSkillsOptions {
  /** Default: process.env.QUOX_SKILLS_SEED_PATH || '/app/skills-seed' */
  seedPath?: string;
  /** Default: 'quox-core@seed' */
  orgId?: string;
  /** Default: quoxSkillsStore singleton */
  store?: QuoxSkillsStore;
  logger?: (level: 'info' | 'warn' | 'error', msg: string, ctx?: object) => void;
}

export async function seedSkillsFromFs(opts?: SeedSkillsOptions): Promise<SeedSkillsResult> {
  const resolvedSeedPath =
    opts?.seedPath ??
    process.env.QUOX_SKILLS_SEED_PATH ??
    '/app/skills-seed';

  const orgId = opts?.orgId ?? SEED_CATALOG_ORG_ID;
  const store = opts?.store ?? createInMemoryQuoxSkillsStore();
  const log = opts?.logger ?? defaultLogger;

  const result: SeedSkillsResult = { inserted: 0, updated: 0, skipped: 0, errors: [] };

  // Guard: seedPath must exist and be a directory
  try {
    const stat = await fs.stat(resolvedSeedPath);
    if (!stat.isDirectory()) {
      log('warn', 'seedPath is not a directory', { seedPath: resolvedSeedPath });
      return result;
    }
  } catch {
    log('warn', 'seedPath does not exist or is not accessible', { seedPath: resolvedSeedPath });
    return result;
  }

  // Enumerate <seedPath>/<category>/<skillName>/SKILL.md
  let categoryEntries: string[];
  try {
    categoryEntries = await fs.readdir(resolvedSeedPath);
  } catch (err) {
    log('error', 'Failed to readdir seedPath', { seedPath: resolvedSeedPath, err: String(err) });
    return result;
  }

  for (const categoryEntry of categoryEntries) {
    const categoryDir = path.join(resolvedSeedPath, categoryEntry);

    let catStat;
    try {
      catStat = await fs.stat(categoryDir);
    } catch {
      continue;
    }
    if (!catStat.isDirectory()) continue;

    let skillEntries: string[];
    try {
      skillEntries = await fs.readdir(categoryDir);
    } catch {
      continue;
    }

    for (const skillEntry of skillEntries) {
      const skillDir = path.join(categoryDir, skillEntry);

      let skillStat;
      try {
        skillStat = await fs.stat(skillDir);
      } catch {
        continue;
      }
      if (!skillStat.isDirectory()) continue;

      const skillMdPath = path.join(skillDir, 'SKILL.md');

      // Verify SKILL.md exists in this skill directory
      try {
        await fs.access(skillMdPath);
      } catch {
        continue; // No SKILL.md → skip
      }

      try {
        await processSkillFile({ skillMdPath, skillDir, orgId, store, result, log });
      } catch (err) {
        result.errors.push({ path: skillMdPath, error: String(err) });
        log('error', 'Unexpected error processing skill', { path: skillMdPath, err: String(err) });
      }
    }
  }

  log('info', 'Seed complete', {
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    errors: result.errors.length,
  });

  return result;
}

// ─── Internal ────────────────────────────────────────────────────────────────

interface ProcessSkillOpts {
  skillMdPath: string;
  skillDir: string;
  orgId: string;
  store: QuoxSkillsStore;
  result: SeedSkillsResult;
  log: (level: 'info' | 'warn' | 'error', msg: string, ctx?: object) => void;
}

async function processSkillFile(opts: ProcessSkillOpts): Promise<void> {
  const { skillMdPath, skillDir, orgId, store, result, log } = opts;

  const raw = await fs.readFile(skillMdPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);

  // Validate required fields
  const name = String(frontmatter['name'] ?? '').trim();
  const category = String(frontmatter['category'] ?? '').trim();
  const version = String(frontmatter['version'] ?? '').trim();
  const bodyMd = body.trim();

  if (!name) {
    throw new Error(`Missing required frontmatter field: name`);
  }
  if (!category) {
    throw new Error(`Missing required frontmatter field: category`);
  }
  if (!version) {
    throw new Error(`Missing required frontmatter field: version`);
  }
  if (!bodyMd) {
    throw new Error(`bodyMd is empty`);
  }

  // Assemble tests: frontmatter tests array takes priority; else read tests/*.json
  const tests = await assembleTests(frontmatter, skillDir);

  // Map frontmatter to store input fields
  const author = String(frontmatter['author'] ?? 'quox-core').trim();
  // Use frontmatter description when present; otherwise derive from bodyMd.
  // Invariant: bodyMd is guaranteed non-empty at this point (rejected above if empty),
  // so the bodyMd-derived fallback is always reachable and never produces ''.
  const descriptionRaw = String(frontmatter['description'] ?? '').trim();
  const description = descriptionRaw || deriveDescriptionFromBody(bodyMd);
  const tags = extractStringArray(frontmatter['tags']);
  const bestForAgents = extractStringArray(frontmatter['best_for_agents']);
  const relatedSkills = extractArray(frontmatter['related_skills']);
  const requiredTools = extractArray(frontmatter['required_tools']);
  const delegateTargets = extractArray(frontmatter['delegate_targets']);
  const policySatisfies = extractStringArray(frontmatter['policy_satisfies']);
  const policyRequired = extractStringArray(frontmatter['policy_required']);
  const kind = frontmatter['kind'] !== undefined ? String(frontmatter['kind']) : undefined;
  // SKILLRIGHTS #478: `license:` frontmatter (SkillRights standard). Absent = null,
  // never defaulted to a licence. Recorded verbatim, no validation against a known list.
  const licenseRaw = frontmatter['license'] !== undefined ? String(frontmatter['license']).trim() : '';
  const license = licenseRaw || null;
  const authoringEnvelopeId = frontmatter['authoring_envelope_id'] !== undefined
    ? String(frontmatter['authoring_envelope_id'])
    : undefined;

  const llmPreference = frontmatter['llm_preference'] !== undefined &&
    typeof frontmatter['llm_preference'] === 'object' &&
    frontmatter['llm_preference'] !== null
    ? (frontmatter['llm_preference'] as Record<string, unknown>)
    : undefined;

  const modelDirectives = frontmatter['model_directives'] !== undefined &&
    typeof frontmatter['model_directives'] === 'object' &&
    frontmatter['model_directives'] !== null
    ? Object.fromEntries(
        Object.entries(frontmatter['model_directives'] as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)]
        )
      )
    : undefined;

  // Check if this skill already exists
  const existing = await store.findByName({ orgId, name });

  if (!existing) {
    // INSERT
    await store.create({
      orgId,
      scopeId: null, // seed skills are org-wide; scope_id IS NULL in DB (no team/division scope)
      name,
      category,
      description,
      bodyMd,
      author,
      authoringEnvelopeId,
      license,
      tags,
      bestForAgents,
      relatedSkills,
      requiredTools,
      delegateTargets,
      llmPreference,
      modelDirectives,
      policySatisfies,
      policyRequired,
      kind,
      tests,
      version,
      edition: 'stable',
    });
    result.inserted++;
    log('info', 'Inserted skill', { name, version });
  } else {
    // Compare versions: FS > PG → update
    const cmp = compareSemver(version, existing.version);
    if (cmp > 0) {
      // bodyMd change triggers immutable row creation in the store.
      // Pass explicitVersion so the new row uses the FS frontmatter version
      // exactly (e.g. 2.5.0) rather than whatever bumpMinor would produce
      // from the stored version (e.g. 1.1.0). This prevents infinite version
      // drift on every boot for non-minor FS version bumps.
      await store.update(existing.id, {
        bodyMd,
        description: description || existing.description,
        license,
        tags,
        bestForAgents,
        relatedSkills,
        requiredTools,
        delegateTargets,
        llmPreference,
        modelDirectives,
        policySatisfies,
        policyRequired,
        tests,
        explicitVersion: version,
      });
      result.updated++;
      log('info', 'Updated skill', { name, oldVersion: existing.version, newVersion: version });
    } else if ((existing.license ?? null) !== (license ?? null)) {
      // SKILLRIGHTS #478 phase 8: a licence declaration is rights METADATA,
      // not new skill content. When the FS frontmatter's licence differs at
      // an equal version, sync just the licence (metadata-only update path,
      // no bodyMd, so no new immutable row and no fake version bump).
      // Found live 2026-09-11: 49 stamped catalog skills stayed undeclared
      // because this branch did not exist.
      await store.update(existing.id, { license: license ?? null });
      result.updated++;
      log('info', 'Updated skill licence (metadata-only)', { name, license: license ?? null });
    } else {
      result.skipped++;
      log('info', 'Skipped skill (no version change)', { name, version: existing.version });
    }
  }
}

// ─── Description derivation ──────────────────────────────────────────────────

/**
 * Derive a description string from a skill's body markdown when frontmatter
 * provides no description. Extracts the first non-empty paragraph that appears
 * after the leading H1 heading.
 *
 * Rules:
 *  1. Strip leading H1 line(s) (lines starting with `# `).
 *  2. Split remaining text into paragraphs (blank-line delimited).
 *  3. Take the first non-empty paragraph.
 *  4. Collapse internal whitespace runs to single spaces.
 *  5. Cap at 280 characters; trim trailing whitespace.
 *
 * Invariant: bodyMd is always non-empty when this function is called (the
 * loader rejects empty bodyMd earlier), so a usable paragraph is always
 * reachable. The '' fallback below is therefore unreachable in practice.
 */
function deriveDescriptionFromBody(bodyMd: string): string {
  const lines = bodyMd.split('\n');

  // Drop all leading H1 lines
  let startIdx = 0;
  while (startIdx < lines.length && lines[startIdx]!.trimStart().startsWith('# ')) {
    startIdx++;
  }

  const rest = lines.slice(startIdx).join('\n');

  // Split into paragraphs by blank lines
  const paragraphs = rest.split(/\n\s*\n/);

  for (const para of paragraphs) {
    const cleaned = para.trim().replace(/\s+/g, ' ');
    if (!cleaned) continue;
    // Skip markdown headings (##, ###, etc.)
    if (cleaned.startsWith('#')) continue;
    // Cap at 280 chars
    return cleaned.slice(0, 280);
  }

  // Unreachable: bodyMd is non-empty so a usable paragraph always exists
  return '';
}

// ─── YAML frontmatter parser ─────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a string bounded by leading and trailing `---`.
 * Supports the subset of YAML used in SKILL.md files:
 *   - Scalar key: value (string, number, boolean)
 *   - Inline array: key: [a, b, c]
 *   - Block array: key:\n  - item
 *   - Block mapping: key:\n  sub: val
 *   - Multiline strings (description: |  or description: >)
 *   - Nested inline mapping: {key: val, ...}
 *
 * Returns { frontmatter, body } where body is everything after the closing `---`.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = raw.split('\n');

  // Must start with ---
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: raw };
  }

  // Find closing ---
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    return { frontmatter: {}, body: raw };
  }

  const yamlLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n');
  const frontmatter = parseYamlBlock(yamlLines);

  return { frontmatter, body };
}

/**
 * Parse a list of YAML lines into a Record.
 * Handles the SKILL.md subset: scalars, inline arrays, block arrays,
 * block mappings, inline mappings, and multiline (| or >) strings.
 */
function parseYamlBlock(lines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip comment-only and empty lines at root level
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Root-level key: must start at column 0 (no leading spaces)
    const rootKeyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)/);
    if (!rootKeyMatch) {
      i++;
      continue;
    }

    const key = rootKeyMatch[1]!;
    const rest = rootKeyMatch[2]!.trim();

    // Multiline scalar (| or >)
    if (rest === '|' || rest === '>') {
      i++;
      const blockLines: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith('  ') || lines[i]!.trim() === '')) {
        blockLines.push(lines[i]!.replace(/^  /, ''));
        i++;
      }
      result[key] = blockLines.join('\n').trimEnd();
      continue;
    }

    // Inline array: key: [a, b, c]
    if (rest.startsWith('[')) {
      result[key] = parseInlineArray(rest);
      i++;
      continue;
    }

    // Inline mapping: key: {sub: val, ...}
    if (rest.startsWith('{')) {
      result[key] = parseInlineMapping(rest);
      i++;
      continue;
    }

    // Empty value → check if next lines are a block list or mapping
    if (rest === '') {
      i++;
      const children: string[] = [];
      while (i < lines.length && lines[i]!.match(/^  /)) {
        children.push(lines[i]!);
        i++;
      }

      if (children.length === 0) {
        result[key] = null;
        continue;
      }

      // Block list?
      if (children[0]!.trimStart().startsWith('- ')) {
        result[key] = parseBlockList(children);
      } else {
        // Block mapping
        result[key] = parseBlockMapping(children);
      }
      continue;
    }

    // Scalar value
    result[key] = parseScalar(rest);
    i++;
  }

  return result;
}

/** Parse a YAML inline array string like [a, b, c] or [{key: val}, ...] */
function parseInlineArray(s: string): unknown[] {
  // Strip outer brackets
  const inner = s.slice(1, s.lastIndexOf(']')).trim();
  if (!inner) return [];

  const items: unknown[] = [];
  let depth = 0;
  let current = '';

  for (let ci = 0; ci < inner.length; ci++) {
    const ch = inner[ci]!;
    if (ch === '{' || ch === '[') { depth++; current += ch; }
    else if (ch === '}' || ch === ']') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      items.push(parseScalar(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(parseScalar(current.trim()));

  return items;
}

/** Parse a YAML inline mapping string like {key: val, key2: val2} */
function parseInlineMapping(s: string): Record<string, unknown> {
  const inner = s.slice(1, s.lastIndexOf('}')).trim();
  if (!inner) return {};

  const result: Record<string, unknown> = {};
  const pairs = inner.split(',');
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    const v = pair.slice(colonIdx + 1).trim();
    if (k) result[k] = parseScalar(v);
  }
  return result;
}

/** Parse a YAML block list (lines starting with '  - ') */
function parseBlockList(lines: string[]): unknown[] {
  const result: unknown[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const stripped = line.trimStart();

    if (stripped.startsWith('- ')) {
      const value = stripped.slice(2).trim();

      // Check if next lines define a sub-mapping for this item
      const subLines: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.match(/^    /)) {
        subLines.push(lines[i]!.slice(2)); // remove 2 spaces of indent
        i++;
      }

      if (subLines.length > 0) {
        // Parse the inline part as mapping start + sub-mapping
        const item: Record<string, unknown> = {};
        if (value.includes(':')) {
          const colonIdx = value.indexOf(':');
          const k = value.slice(0, colonIdx).trim();
          const v = value.slice(colonIdx + 1).trim();
          if (k) item[k] = parseScalar(v);
        }
        const subObj = parseBlockMapping(subLines);
        Object.assign(item, subObj);
        result.push(item);
      } else {
        // Check if value is an inline mapping
        if (value.startsWith('{')) {
          result.push(parseInlineMapping(value));
        } else {
          result.push(parseScalar(value));
        }
      }
    } else {
      i++;
    }
  }

  return result;
}

/** Parse a YAML block mapping (indented key: val lines) */
function parseBlockMapping(lines: string[]): Record<string, unknown> {
  // Normalize indentation: strip 2 leading spaces if present
  const normalized = lines.map(l => (l.startsWith('  ') ? l.slice(2) : l));
  return parseYamlBlock(normalized);
}

/** Parse a YAML scalar value into the appropriate JS type */
function parseScalar(s: string): unknown {
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }

  // Inline mapping
  if (s.startsWith('{')) return parseInlineMapping(s);
  // Inline array
  if (s.startsWith('[')) return parseInlineArray(s);

  // Number
  const num = Number(s);
  if (!isNaN(num) && s !== '') return num;

  return s;
}

// ─── Tests assembler ─────────────────────────────────────────────────────────

/**
 * Assemble the tests JSONB value.
 * Priority:
 *  1. frontmatter.tests array → convert to {name: {input, expects}} map
 *  2. tests/*.json files → {<filename-without-ext>: content} map
 *  3. Empty object
 */
async function assembleTests(
  frontmatter: Record<string, unknown>,
  skillDir: string
): Promise<Record<string, unknown>> {
  // 1. Inline frontmatter tests
  const fmTests = frontmatter['tests'];
  if (Array.isArray(fmTests) && fmTests.length > 0) {
    const map: Record<string, unknown> = {};
    for (const t of fmTests) {
      if (t && typeof t === 'object' && 'name' in t) {
        const testObj = t as Record<string, unknown>;
        const name = String(testObj['name']);
        map[name] = {
          input: testObj['input'] ?? {},
          expects: testObj['expects'] ?? {},
        };
      }
    }
    return map;
  }

  // 2. tests/*.json files
  const testsDir = path.join(skillDir, 'tests');
  try {
    const stat = await fs.stat(testsDir);
    if (!stat.isDirectory()) return {};

    const files = await fs.readdir(testsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length === 0) return {};

    const map: Record<string, unknown> = {};
    for (const f of jsonFiles) {
      const testName = path.basename(f, '.json');
      try {
        const content = await fs.readFile(path.join(testsDir, f), 'utf8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        map[testName] = {
          input: parsed['input'] ?? {},
          expects: parsed['expects'] ?? {},
        };
      } catch {
        // skip malformed test file
      }
    }
    return map;
  } catch {
    return {};
  }
}

// ─── Semver comparison ───────────────────────────────────────────────────────

/**
 * Compare two semver strings. Returns:
 *   > 0 if a > b
 *   0   if a === b
 *   < 0 if a < b
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map(n => parseInt(n, 10) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map(v => String(v));
}

function extractArray(val: unknown): unknown[] {
  if (!Array.isArray(val)) return [];
  return val;
}

function defaultLogger(level: 'info' | 'warn' | 'error', msg: string, ctx?: object): void {
  // Silent by default in tests; callers can override
  if (process.env.QUOX_SEED_LOG === '1') {
    console[level](`[seed-loader] ${msg}`, ctx ?? '');
  }
}

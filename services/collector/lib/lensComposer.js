/**
 * lensComposer — QUOXLENS P0
 *
 * The prompt-composition seam: loads a Lens (an evaluative stance defined in
 * src/config/lenses/<category>/<id>/LENS.md) and appends its markdown body
 * to a base system prompt. This is the thing every dispatch path routes
 * through instead of hand-rolling its own "## Execution Integrity"-shaped
 * block inline.
 *
 * Deliberately dependency-free: the collector's own package.json does not
 * carry js-yaml, and adding one here would force a Docker rebuild just to
 * parse five flat frontmatter keys. parseFrontmatter below only needs to
 * handle scalars, booleans, and inline arrays — the same shape
 * skillsFilesystemMirror.js already writes for SKILL.md.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Locate src/config/lenses regardless of whether this file is running from
 * a repo checkout (services/collector/lib/, three levels below repo root)
 * or from the built collector image (the Dockerfile COPYs services/collector
 * straight to /app and src/config alongside it, so lib/ is only one level
 * below the image root there). Try both, first existing wins.
 */
function resolveLensRoot() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'src', 'config', 'lenses'), // repo checkout
    path.join(__dirname, '..', 'src', 'config', 'lenses'),             // container image
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const LENS_ROOT = resolveLensRoot();

/**
 * Minimal frontmatter reader: leading "---\n...\n---" block parsed by hand.
 * Supports `key: value`, `key: true|false`, `key: [a, b, c]`, and `# comment`
 * lines. Anything after the closing fence is the markdown body.
 *
 * @param {string} content
 * @returns {{ attrs: Record<string, *>, body: string }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { attrs: {}, body: content };

  const attrs = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      attrs[key] = inner === '' ? [] : inner.split(',').map((v) => v.trim());
    } else if (value === 'true' || value === 'false') {
      attrs[key] = value === 'true';
    } else {
      attrs[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  return { attrs, body: content.slice(match[0].length) };
}

/**
 * Find the directory holding <id>/LENS.md under any category subfolder of
 * src/config/lenses. Category is not part of the caller-facing id, so this
 * scans rather than requiring callers to know the taxonomy.
 *
 * @param {string} id
 * @returns {string|null}
 */
function findLensDir(id) {
  if (!fs.existsSync(LENS_ROOT)) return null;
  let categories;
  try {
    categories = fs.readdirSync(LENS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const category of categories) {
    const candidate = path.join(LENS_ROOT, category.name, id);
    if (fs.existsSync(path.join(candidate, 'LENS.md'))) return candidate;
  }
  return null;
}

/**
 * Load and parse a single Lens by id.
 *
 * @param {string} id
 * @returns {{ id: string, body: string, [key: string]: * }}
 */
function loadLens(id) {
  const dir = findLensDir(id);
  if (!dir) throw new Error(`loadLens: no LENS.md found for lens id "${id}"`);
  const raw = fs.readFileSync(path.join(dir, 'LENS.md'), 'utf8');
  const { attrs, body } = parseFrontmatter(raw);
  return { ...attrs, id: attrs.id || id, body: body.trim() };
}

/**
 * A Lens judges, it does not act. The moment a Lens can execute something
 * (a required tool), it stops being a verdict-only stance and becomes a
 * Crystal wearing a Lens costume — which breaks the guarantee every consumer
 * of docs/LENS_CONTRACT.md depends on (invariant 5: "no implementation
 * exposes tool execution through this endpoint"). Reject at load time rather
 * than trusting every call site to remember the rule.
 *
 * @param {object} lens
 * @returns {true}
 */
function validateLens(lens) {
  if (!lens || typeof lens !== 'object') {
    throw new Error('validateLens: lens is missing or malformed');
  }
  if (lens.kind !== 'evaluative') {
    throw new Error(`validateLens: lens "${lens.id || 'unknown'}" has kind "${lens.kind}", expected "evaluative"`);
  }
  if (Array.isArray(lens.required_tools) && lens.required_tools.length > 0) {
    throw new Error(`validateLens: lens "${lens.id || 'unknown'}" declares required_tools; a Lens must never require tool execution`);
  }
  return true;
}

/**
 * Concatenate already-loaded Lens bodies into one markdown block, in the
 * order given. Empty input composes to '' so callers can no-op cleanly.
 *
 * @param {Array<{body: string}>} lenses
 * @returns {string}
 */
function composeLensSections(lenses) {
  if (!Array.isArray(lenses) || lenses.length === 0) return '';
  return lenses
    .map((lens) => (lens && typeof lens.body === 'string' ? lens.body.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Apply a set of Lenses to a base system prompt. Accepts either lens ids
 * (loaded + validated here) or already-loaded lens objects. An empty list
 * is a true no-op: returns basePrompt unchanged, byte for byte.
 *
 * @param {string} basePrompt
 * @param {Array<string|object>} lensesOrIds
 * @returns {string}
 */
function applyLenses(basePrompt, lensesOrIds) {
  const base = typeof basePrompt === 'string' ? basePrompt : '';
  if (!Array.isArray(lensesOrIds) || lensesOrIds.length === 0) return base;

  const lenses = lensesOrIds.map((entry) => (typeof entry === 'string' ? loadLens(entry) : entry));
  for (const lens of lenses) validateLens(lens);

  const composed = composeLensSections(lenses);
  return composed ? `${base}\n\n${composed}` : base;
}

module.exports = {
  loadLens,
  validateLens,
  composeLensSections,
  applyLenses,
  parseFrontmatter,
};

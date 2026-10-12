/**
 * Persona Reader
 *
 * Reads a persona markdown file from src/config/personas/<agentId>.md.
 * Fresh disk read on every call — no module-level cache (callers manage caching).
 * Strips YAML front-matter if present so the returned content is clean prompt text.
 *
 * Usage:
 *   const { readPersona } = require('./personaReader');
 *   const text = await readPersona('sentinel');  // string or null
 */

const fs = require('fs');
const path = require('path');

function resolvePersonasDir() {
  if (process.env.PERSONAS_DIR) return process.env.PERSONAS_DIR;
  const candidates = [
    path.resolve(__dirname, '../../../src/config/personas'),
    path.resolve(__dirname, '../src/config/personas'),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isDirectory()) return p; } catch {}
  }
  return candidates[0];
}

const PERSONAS_PATH = resolvePersonasDir();

/**
 * Read a persona file for the given agent ID.
 * @param {string} agentId
 * @returns {Promise<string|null>} File content with YAML front-matter stripped, or null if not found.
 */
async function readPersona(agentId) {
  const filePath = path.join(PERSONAS_PATH, `${agentId}.md`);

  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  // Strip YAML front-matter block (--- ... ---)
  const stripped = raw.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return stripped;
}

module.exports = { readPersona };

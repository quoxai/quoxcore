/**
 * Scanner Utilities
 */

const { readdir } = require('fs/promises');
const { join, relative } = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'target', '__pycache__', '.next']);

/**
 * Simple glob implementation. Supports patterns like:
 * - `**\/*.js` — all .js files recursively
 * - `src/**\/*.{jsx,tsx}` — jsx/tsx under src/
 */
async function globFiles(rootPath, pattern) {
  const results = [];
  const parts = pattern.split('/');
  const hasRecursive = parts.includes('**');
  const prefix = [];

  if (!hasRecursive && parts.length > 1) {
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i].includes('*')) prefix.push(parts[i]);
    }
  } else if (hasRecursive) {
    const idx = parts.indexOf('**');
    for (let i = 0; i < idx; i++) {
      if (!parts[i].includes('*')) prefix.push(parts[i]);
    }
  }

  const globPart = parts[parts.length - 1];
  const extMatch = buildExtMatcher(globPart);
  const startDir = prefix.length > 0 ? join(rootPath, ...prefix) : rootPath;

  async function walk(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.') && hasRecursive) {
            await walk(fullPath);
          }
        } else if (entry.isFile() && extMatch(entry.name)) {
          results.push(relative(rootPath, fullPath));
        }
      }
    } catch {
      // skip inaccessible
    }
  }

  await walk(startDir);
  return results;
}

function buildExtMatcher(pattern) {
  // Handle brace expansion: *.{js,ts}
  const braceMatch = pattern.match(/\*\.?\{([^}]+)\}/);
  if (braceMatch) {
    const exts = braceMatch[1].split(',').map((e) => `.${e.trim()}`);
    return (name) => exts.some((ext) => name.endsWith(ext));
  }
  // Handle simple: *.js, *_test.go
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    return (name) => name.endsWith(suffix);
  }
  return (name) => name === pattern;
}

module.exports = { globFiles };

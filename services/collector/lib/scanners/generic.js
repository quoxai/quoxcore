/**
 * Generic / Fallback Scanner
 */

const { readdir } = require('fs/promises');
const { join } = require('path');
const { globFiles } = require('./utils');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', 'target', '__pycache__']);

async function scanGeneric(rootPath) {
  const registries = [];
  const fileCounts = {};

  async function countDir(dir, depth = 0) {
    if (depth > 2) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            await countDir(join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : 'other';
          fileCounts[ext] = (fileCounts[ext] || 0) + 1;
        }
      }
    } catch { /* skip */ }
  }

  await countDir(rootPath);

  const draftFiles = await globFiles(rootPath, '**/*.xml');
  const drafts = draftFiles.filter((f) => f.includes('draft-'));
  if (drafts.length > 0) {
    registries.push({
      name: 'ietf-drafts',
      file: '.',
      entryCount: drafts.length,
      entries: drafts.map((f) => { const name = f.split('/').pop().replace('.xml', ''); return { id: name, name }; }),
    });
  }

  const schemaFiles = await globFiles(rootPath, '**/*.json');
  const schemas = schemaFiles.filter((f) => f.toLowerCase().includes('schema'));
  if (schemas.length > 0) {
    registries.push({
      name: 'schemas',
      file: '.',
      entryCount: schemas.length,
      entries: schemas.map((f) => { const name = f.split('/').pop().replace('.json', ''); return { id: name, name }; }),
    });
  }

  const totalFiles = Object.values(fileCounts).reduce((a, b) => a + b, 0);

  return {
    registries,
    routes: [],
    services: [],
    schemas: [],
    invariantChecks: [],
    metrics: { fileCount: totalFiles, moduleCount: 0, routeCount: 0, serviceCount: 0, testFileCount: 0, registryCount: registries.length },
    extra: { fileCounts },
  };
}

module.exports = { scanGeneric };

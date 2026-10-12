/**
 * Go Project Scanner
 */

const { readFile, readdir } = require('fs/promises');
const { existsSync } = require('fs');
const { join } = require('path');
const { globFiles } = require('./utils');

async function scanGo(rootPath) {
  const registries = [];
  const invariantChecks = [];

  let moduleName = '';
  let goVersion = '';
  const deps = {};
  const goModPath = join(rootPath, 'go.mod');
  if (existsSync(goModPath)) {
    const content = await readFile(goModPath, 'utf8');
    const modMatch = content.match(/^module\s+(.+)/m);
    if (modMatch) moduleName = modMatch[1].trim();
    const verMatch = content.match(/^go\s+(.+)/m);
    if (verMatch) goVersion = verMatch[1].trim();
    const depMatches = content.matchAll(/^\t(\S+)\s+(\S+)/gm);
    for (const m of depMatches) deps[m[1]] = m[2];
  }

  // cmd/ entry points
  const cmdDir = join(rootPath, 'cmd');
  const entryPoints = [];
  if (existsSync(cmdDir)) {
    try {
      const entries = await readdir(cmdDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) entryPoints.push(entry.name);
      }
    } catch { /* skip */ }
  }
  if (entryPoints.length > 0) {
    registries.push({ name: 'entry-points', file: 'cmd/', entryCount: entryPoints.length, entries: entryPoints.map((n) => ({ id: n, name: n })) });
  }

  // Plugins
  const pluginsDir = join(rootPath, 'internal/plugins');
  const plugins = [];
  if (existsSync(pluginsDir)) {
    try {
      const entries = await readdir(pluginsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginGoPath = join(pluginsDir, entry.name, 'plugin.go');
          let capabilities = [];
          if (existsSync(pluginGoPath)) {
            const content = await readFile(pluginGoPath, 'utf8');
            const capMatches = content.matchAll(/Name:\s*"([^"]+)"/g);
            for (const m of capMatches) capabilities.push(m[1]);
          }
          plugins.push({ id: entry.name, name: entry.name, metadata: { capabilities } });
        }
      }
    } catch { /* skip */ }
  }
  if (plugins.length > 0) {
    registries.push({ name: 'plugins', file: 'internal/plugins/', entryCount: plugins.length, entries: plugins });
  }

  // Packages
  const packages = [];
  for (const dir of ['pkg', 'internal']) {
    const fullDir = join(rootPath, dir);
    if (existsSync(fullDir)) {
      try {
        const entries = await readdir(fullDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            packages.push({ id: dir === 'pkg' ? entry.name : `internal/${entry.name}`, name: entry.name });
          }
        }
      } catch { /* skip */ }
    }
  }
  if (packages.length > 0) {
    registries.push({ name: 'packages', file: 'pkg/ + internal/', entryCount: packages.length, entries: packages });
  }

  const testFiles = await globFiles(rootPath, '**/*_test.go');
  const goFiles = await globFiles(rootPath, '**/*.go');

  return {
    registries,
    routes: [],
    services: [],
    schemas: [],
    invariantChecks,
    dependencies: { production: deps, dev: {} },
    metrics: {
      fileCount: goFiles.length,
      moduleCount: packages.length,
      routeCount: 0,
      serviceCount: 0,
      testFileCount: testFiles.length,
      registryCount: registries.length,
    },
    extra: { moduleName, goVersion, entryPoints },
  };
}

module.exports = { scanGo };

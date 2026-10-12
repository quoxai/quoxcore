/**
 * Node.js / TypeScript Project Scanner
 */

const { readFile, readdir } = require('fs/promises');
const { existsSync } = require('fs');
const { join } = require('path');
const { globFiles } = require('./utils');

async function scanNode(rootPath, projectType) {
  const registries = [];
  const routes = [];
  const invariantChecks = [];

  let pkg = {};
  const pkgPath = join(rootPath, 'package.json');
  if (existsSync(pkgPath)) {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  }

  const deps = { production: pkg.dependencies || {}, dev: pkg.devDependencies || {} };

  if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
    registries.push({
      name: 'scripts',
      file: 'package.json',
      entryCount: Object.keys(pkg.scripts).length,
      entries: Object.keys(pkg.scripts).map((k) => ({ id: k, name: k, metadata: { command: pkg.scripts[k] } })),
    });
  }

  // API routes
  const routeDirs = ['src/api/routes', 'src/routes', 'routes', 'api/routes', 'lib/routes'];
  for (const dir of routeDirs) {
    const fullDir = join(rootPath, dir);
    if (existsSync(fullDir)) {
      try {
        const files = await readdir(fullDir);
        const routeFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.ts'));
        for (const file of routeFiles) {
          const content = await readFile(join(fullDir, file), 'utf8');
          const routeMatches = content.matchAll(/\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/g);
          for (const m of routeMatches) {
            routes.push({ path: m[2], file: `${dir}/${file}`, method: m[1].toUpperCase(), protected: false, minRole: null });
          }
        }
        registries.push({
          name: 'api-routes',
          file: dir,
          entryCount: routes.length,
          entries: routes.map((r) => ({ id: `${r.method} ${r.path}`, name: r.path })),
        });
      } catch { /* skip */ }
      break;
    }
  }

  // Source modules
  let sourceFiles = [];
  if (existsSync(join(rootPath, 'src'))) {
    sourceFiles = await globFiles(rootPath, 'src/**/*.{js,ts}');
  } else if (existsSync(join(rootPath, 'lib'))) {
    sourceFiles = await globFiles(rootPath, 'lib/**/*.{js,ts}');
  }

  const testPatterns = projectType === 'typescript' ? '**/*.test.{ts,tsx}' : '**/*.test.{js,jsx}';
  const testFiles = await globFiles(rootPath, testPatterns);

  // Executors (quoxflow)
  const executorsDir = join(rootPath, 'src/executors');
  if (existsSync(executorsDir)) {
    try {
      const files = await readdir(executorsDir);
      const executors = files.filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.includes('.test.')).map((f) => f.replace(/\.(ts|js)$/, ''));
      registries.push({ name: 'node-types', file: 'src/executors/', entryCount: executors.length, entries: executors.map((id) => ({ id, name: id })) });
    } catch { /* skip */ }
  }

  // Pipeline layers (quoxflow)
  const pipelineDir = join(rootPath, 'src/pipeline');
  if (existsSync(pipelineDir)) {
    try {
      const files = await readdir(pipelineDir);
      const layers = files.filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.includes('.test.') && !f.includes('index')).map((f) => f.replace(/\.(ts|js)$/, ''));
      registries.push({ name: 'pipeline-layers', file: 'src/pipeline/', entryCount: layers.length, entries: layers.map((id) => ({ id, name: id })) });
    } catch { /* skip */ }
  }

  // MCP adapters (quoxmcp)
  const toolAdapterPath = join(rootPath, 'lib/tool-adapter.js');
  if (existsSync(toolAdapterPath)) {
    const libFiles = await globFiles(rootPath, 'lib/**/*.js');
    registries.push({
      name: 'mcp-adapters',
      file: 'lib/',
      entryCount: libFiles.length,
      entries: libFiles.map((f) => { const name = f.split('/').pop().replace('.js', ''); return { id: name, name }; }),
    });
  }

  return {
    registries,
    routes,
    services: [],
    schemas: [],
    invariantChecks,
    dependencies: deps,
    metrics: {
      fileCount: sourceFiles.length,
      moduleCount: sourceFiles.length,
      routeCount: routes.length,
      serviceCount: 0,
      testFileCount: testFiles.length,
      registryCount: registries.length,
    },
  };
}

module.exports = { scanNode };

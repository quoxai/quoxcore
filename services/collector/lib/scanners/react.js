/**
 * React/Vite Project Scanner
 */

const { readFile } = require('fs/promises');
const { existsSync } = require('fs');
const { join } = require('path');
const { globFiles } = require('./utils');

async function scanReact(rootPath) {
  const registries = [];
  const routes = [];
  const services = [];
  const schemas = [];
  const invariantChecks = [];

  // --- Plugin registry ---
  const pluginIndexPath = join(rootPath, 'src/config/plugins/index.js');
  if (existsSync(pluginIndexPath)) {
    const content = await readFile(pluginIndexPath, 'utf8');
    const pluginIds = [];
    const matches = content.matchAll(/'([^']+)':\s*\w+/g);
    for (const m of matches) pluginIds.push(m[1]);
    registries.push({
      name: 'plugins',
      file: 'src/config/plugins/index.js',
      entryCount: pluginIds.length,
      entries: pluginIds.map((id) => ({ id, name: id })),
    });

    const missingManifests = [];
    for (const id of pluginIds) {
      if (!existsSync(join(rootPath, `src/config/plugins/${id}.json`))) {
        missingManifests.push(id);
      }
    }
    invariantChecks.push({
      name: 'plugin-manifest-sync',
      status: missingManifests.length === 0 ? 'pass' : 'fail',
      message: missingManifests.length === 0
        ? `All ${pluginIds.length} plugins have JSON manifests`
        : `Missing manifests: ${missingManifests.join(', ')}`,
      details: missingManifests.length > 0 ? { missing: missingManifests } : null,
    });
  }

  // --- Agent registry ---
  const agentRegPath = join(rootPath, 'src/config/agentRegistry.js');
  if (existsSync(agentRegPath)) {
    const content = await readFile(agentRegPath, 'utf8');
    const agentIds = [];
    const idMatches = content.matchAll(/['"](\w+)['"]\s*:\s*\{[^}]*(?:level|tools|capabilities)/g);
    for (const m of idMatches) agentIds.push(m[1]);
    registries.push({
      name: 'agents',
      file: 'src/config/agentRegistry.js',
      entryCount: agentIds.length,
      entries: agentIds.map((id) => ({ id, name: id })),
    });

    const assistantsPath = join(rootPath, 'src/config/assistants.js');
    if (existsSync(assistantsPath)) {
      const assistContent = await readFile(assistantsPath, 'utf8');
      const assistantIds = [];
      const aidMatches = assistContent.matchAll(/id:\s*['"](\w+)['"]/g);
      for (const m of aidMatches) assistantIds.push(m[1]);

      registries.push({
        name: 'assistants',
        file: 'src/config/assistants.js',
        entryCount: assistantIds.length,
        entries: assistantIds.map((id) => ({ id, name: id })),
      });

      const inRegNotAssist = agentIds.filter((id) => !assistantIds.includes(id));
      const inAssistNotReg = assistantIds.filter((id) => !agentIds.includes(id));
      const synced = inRegNotAssist.length === 0 && inAssistNotReg.length === 0;

      invariantChecks.push({
        name: 'agent-registry-sync',
        status: synced ? 'pass' : 'fail',
        message: synced
          ? `All ${agentIds.length} agents synced between registry and assistants`
          : `Mismatch: registry-only=[${inRegNotAssist}], assistants-only=[${inAssistNotReg}]`,
        details: synced ? null : { inRegNotAssist, inAssistNotReg },
      });
    }
  }

  // --- Service registry ---
  const svcRegPath = join(rootPath, 'src/config/serviceRegistry.js');
  if (existsSync(svcRegPath)) {
    const content = await readFile(svcRegPath, 'utf8');
    const svcEntries = [];
    const svcMatches = content.matchAll(/(?:name|id):\s*['"]([^'"]+)['"].*?port:\s*(\d+)/gs);
    for (const m of svcMatches) {
      svcEntries.push({ name: m[1], port: parseInt(m[2], 10) });
    }
    if (svcEntries.length > 0) {
      registries.push({
        name: 'services',
        file: 'src/config/serviceRegistry.js',
        entryCount: svcEntries.length,
        entries: svcEntries.map((s) => ({ id: s.name, name: s.name, metadata: { port: s.port } })),
      });
    }
  }

  // --- Cognitive implants ---
  const implantsPath = join(rootPath, 'src/config/cognitiveImplants.js');
  if (existsSync(implantsPath)) {
    const content = await readFile(implantsPath, 'utf8');
    const implantIds = [];
    const implantMatches = content.matchAll(/'([^']+)':\s*\{[\s\S]*?id:\s*'([^']+)'/g);
    for (const m of implantMatches) implantIds.push(m[2]);
    registries.push({
      name: 'cognitive-implants',
      file: 'src/config/cognitiveImplants.js',
      entryCount: implantIds.length,
      entries: implantIds.map((id) => ({ id, name: id })),
    });
  }

  // --- Routes from App.jsx ---
  const appPath = join(rootPath, 'src/App.jsx');
  if (existsSync(appPath)) {
    const content = await readFile(appPath, 'utf8');
    const routeMatches = content.matchAll(/<Route\s+path=["']([^"']+)["'][^>]*element=\{([^}]+)\}/g);
    for (const m of routeMatches) {
      const path = m[1];
      const element = m[2];
      const protectedMatch = element.match(/ProtectedRoute\s+minRole=["'](\w+)["']/);
      routes.push({
        path,
        file: 'src/App.jsx',
        protected: !!protectedMatch,
        minRole: protectedMatch ? protectedMatch[1] : null,
      });
    }
  }

  // --- Docker services ---
  const dockerData = require('./docker');
  const dockerResult = await dockerData.scanDocker(rootPath);
  if (dockerResult.services.length > 0) {
    services.push(...dockerResult.services);
  }

  // --- Schemas ---
  const schemaPaths = [
    { name: 'auth', file: 'services/auth/db/schema.sql' },
    { name: 'memory', file: 'services/memory/db/schema.sql' },
  ];
  for (const sp of schemaPaths) {
    const fullPath = join(rootPath, sp.file);
    if (existsSync(fullPath)) {
      const content = await readFile(fullPath, 'utf8');
      const tables = [];
      const tableMatches = content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi);
      for (const m of tableMatches) tables.push(m[1]);
      schemas.push({
        name: sp.name,
        file: sp.file,
        tableCount: tables.length,
        tableNames: tables,
      });
    }
  }

  const jsxFiles = await globFiles(rootPath, 'src/**/*.{jsx,tsx}');
  const testFiles = await globFiles(rootPath, 'src/**/*.test.{js,jsx,ts,tsx}');

  return {
    registries,
    routes,
    services,
    schemas,
    invariantChecks,
    metrics: {
      fileCount: jsxFiles.length,
      moduleCount: registries.reduce((sum, r) => sum + r.entryCount, 0),
      routeCount: routes.length,
      serviceCount: services.length,
      testFileCount: testFiles.length,
      registryCount: registries.length,
    },
  };
}

module.exports = { scanReact };

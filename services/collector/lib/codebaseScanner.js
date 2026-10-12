/**
 * Codebase Scanner Engine
 *
 * Core scanning orchestrator. Detects project type, runs the appropriate
 * scanner, aggregates results into a ScanResult.
 */

const { createHash } = require('crypto');
const { normalize, join } = require('path');
const { detectProjectType, getProjectName } = require('./scanners/detect');
const { scanReact } = require('./scanners/react');
const { scanGo } = require('./scanners/go');
const { scanNode } = require('./scanners/node');
const { scanDocker } = require('./scanners/docker');
const { scanGeneric } = require('./scanners/generic');
const { readFile } = require('fs/promises');
const { existsSync } = require('fs');
const { globFiles } = require('./scanners/utils');

function generateProjectId(rootPath) {
  return createHash('sha256').update(normalize(rootPath)).digest('hex').slice(0, 16);
}

/**
 * Scan a project at the given root path.
 * @param {string} rootPath
 * @param {object} [options]
 * @returns {Promise<object>} ScanResult
 */
async function scanProject(rootPath, options = {}) {
  const projectType = options.projectType || detectProjectType(rootPath);
  const projectName = options.projectName || (await getProjectName(rootPath, projectType));
  const projectId = generateProjectId(rootPath);

  let scanData;
  switch (projectType) {
    case 'react':
      scanData = await scanReact(rootPath);
      break;
    case 'go':
      scanData = await scanGo(rootPath);
      break;
    case 'typescript':
    case 'node':
      scanData = await scanNode(rootPath, projectType);
      break;
    case 'tauri': {
      scanData = await scanReact(rootPath);
      const rustInfo = await scanTauriRust(rootPath);
      scanData.registries.push(...rustInfo.registries);
      scanData.metrics.fileCount += rustInfo.fileCount;
      break;
    }
    default:
      scanData = await scanGeneric(rootPath);
  }

  // Docker overlay
  const dockerData = await scanDocker(rootPath);
  if (dockerData.services.length > 0) {
    // Merge without duplicating services already found by react scanner
    const existingNames = new Set((scanData.services || []).map((s) => s.name));
    for (const svc of dockerData.services) {
      if (!existingNames.has(svc.name)) {
        scanData.services = scanData.services || [];
        scanData.services.push(svc);
      }
    }
    scanData.metrics.serviceCount = (scanData.services || []).length;
  }

  if (!scanData.dependencies) {
    scanData.dependencies = await readDependencies(rootPath, projectType);
  }

  return {
    projectId,
    rootPath: normalize(rootPath),
    projectName,
    projectType,
    scannedAt: new Date().toISOString(),
    registries: scanData.registries || [],
    routes: scanData.routes || [],
    services: scanData.services || [],
    schemas: scanData.schemas || [],
    dependencies: scanData.dependencies || { production: {}, dev: {} },
    metrics: scanData.metrics || { fileCount: 0, moduleCount: 0, routeCount: 0, serviceCount: 0, testFileCount: 0, registryCount: 0 },
    invariantChecks: scanData.invariantChecks || [],
    extra: scanData.extra || null,
  };
}

async function scanTauriRust(rootPath) {
  const registries = [];
  let fileCount = 0;

  const cargoPath = join(rootPath, 'src-tauri', 'Cargo.toml');
  if (existsSync(cargoPath)) {
    const content = await readFile(cargoPath, 'utf8');
    const depMatches = content.matchAll(/^(\w[\w-]*)\s*=/gm);
    const deps = [];
    const skip = new Set(['package', 'name', 'version', 'edition', 'build', 'description']);
    for (const m of depMatches) {
      if (!skip.has(m[1])) deps.push(m[1]);
    }
    registries.push({
      name: 'rust-dependencies',
      file: 'src-tauri/Cargo.toml',
      entryCount: deps.length,
      entries: deps.map((d) => ({ id: d, name: d })),
    });
  }

  const srcTauriDir = join(rootPath, 'src-tauri', 'src');
  if (existsSync(srcTauriDir)) {
    const rsFiles = await globFiles(join(rootPath, 'src-tauri'), 'src/**/*.rs');
    fileCount = rsFiles.length;
    registries.push({
      name: 'rust-modules',
      file: 'src-tauri/src/',
      entryCount: rsFiles.length,
      entries: rsFiles.map((f) => { const name = f.split('/').pop().replace('.rs', ''); return { id: name, name }; }),
    });
  }

  return { registries, fileCount };
}

async function readDependencies(rootPath, projectType) {
  if (['react', 'typescript', 'node', 'tauri'].includes(projectType)) {
    const pkgPath = join(rootPath, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      return { production: pkg.dependencies || {}, dev: pkg.devDependencies || {} };
    }
  }
  return { production: {}, dev: {} };
}

/**
 * Generate a compact summary string (~50 tokens).
 */
function generateSummary(scan) {
  const parts = [`${scan.projectName} (${scan.projectType})`];
  const counts = [];
  if (scan.registries) {
    for (const r of scan.registries.slice(0, 3)) {
      counts.push(`${r.entryCount} ${r.name}`);
    }
  }
  if (scan.metrics.routeCount) counts.push(`${scan.metrics.routeCount} routes`);
  if (scan.metrics.serviceCount) counts.push(`${scan.metrics.serviceCount} services`);
  if (scan.metrics.testFileCount) counts.push(`${scan.metrics.testFileCount} tests`);
  parts.push(counts.join(', '));

  const failures = (scan.invariantChecks || []).filter((c) => c.status === 'fail');
  const warnings = (scan.invariantChecks || []).filter((c) => c.status === 'warn');
  if (failures.length > 0) parts.push(`${failures.length} invariant failures`);
  else if (warnings.length > 0) parts.push(`${warnings.length} warnings`);
  else if (scan.invariantChecks && scan.invariantChecks.length > 0) parts.push('invariants: OK');

  return parts.join(' | ');
}

/**
 * Generate multi-project summary for context injection.
 */
function generateMultiSummary(scans) {
  const totalRoutes = scans.reduce((sum, s) => sum + s.metrics.routeCount, 0);
  const totalServices = scans.reduce((sum, s) => sum + s.metrics.serviceCount, 0);
  const totalFailures = scans.reduce((sum, s) => sum + (s.invariantChecks || []).filter((c) => c.status === 'fail').length, 0);
  const gated = scans.reduce((sum, s) => sum + (s.routes || []).filter((r) => r.protected).length, 0);
  return `[Codebase] ${scans.length} projects | ${totalRoutes} routes (${gated} gated) | ${totalServices} services | ${totalFailures === 0 ? 'registry sync: OK' : `${totalFailures} drift alerts`}`;
}

module.exports = { scanProject, generateSummary, generateMultiSummary };

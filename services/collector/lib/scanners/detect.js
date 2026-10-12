/**
 * Project Type Detection
 *
 * Detects project type by marker file presence.
 */

const { existsSync } = require('fs');
const { readFile } = require('fs/promises');
const { join } = require('path');

const MARKERS = [
  {
    type: 'tauri',
    check: (root) => existsSync(join(root, 'src-tauri', 'Cargo.toml')) && existsSync(join(root, 'package.json')),
  },
  {
    type: 'react',
    check: (root) =>
      existsSync(join(root, 'package.json')) &&
      (existsSync(join(root, 'src', 'App.jsx')) ||
        existsSync(join(root, 'src', 'App.tsx')) ||
        existsSync(join(root, 'vite.config.js')) ||
        existsSync(join(root, 'vite.config.ts'))),
  },
  {
    type: 'go',
    check: (root) => existsSync(join(root, 'go.mod')),
  },
  {
    type: 'rust',
    check: (root) => existsSync(join(root, 'Cargo.toml')),
  },
  {
    type: 'typescript',
    check: (root) =>
      existsSync(join(root, 'package.json')) &&
      existsSync(join(root, 'tsconfig.json')) &&
      !existsSync(join(root, 'src', 'App.jsx')) &&
      !existsSync(join(root, 'src', 'App.tsx')),
  },
  {
    type: 'node',
    check: (root) => existsSync(join(root, 'package.json')),
  },
  {
    type: 'python',
    check: (root) => existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py')),
  },
  {
    type: 'spec',
    check: (root) => existsSync(join(root, 'README.md')) && !existsSync(join(root, 'package.json')) && !existsSync(join(root, 'go.mod')),
  },
];

function detectProjectType(rootPath) {
  for (const marker of MARKERS) {
    if (marker.check(rootPath)) {
      return marker.type;
    }
  }
  return 'unknown';
}

async function getProjectName(rootPath, projectType) {
  try {
    if (['react', 'typescript', 'node', 'tauri'].includes(projectType)) {
      const pkg = JSON.parse(await readFile(join(rootPath, 'package.json'), 'utf8'));
      if (pkg.name) return pkg.name;
    }
    if (projectType === 'go') {
      const mod = await readFile(join(rootPath, 'go.mod'), 'utf8');
      const match = mod.match(/^module\s+(.+)/m);
      if (match) return match[1].trim().split('/').pop();
    }
    if (projectType === 'rust') {
      const cargo = await readFile(join(rootPath, 'Cargo.toml'), 'utf8');
      const match = cargo.match(/^name\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
    }
  } catch {
    // fall through to directory name
  }
  return rootPath.split('/').pop();
}

module.exports = { detectProjectType, getProjectName };

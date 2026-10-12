/**
 * Custom Node.js module hook for JSX transformation.
 * Uses esbuild's transform API to convert JSX to plain JS on-the-fly.
 *
 * Registered via Module.register() in index.js before any .jsx imports.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const filePath = fileURLToPath(url);
    const source = await readFile(filePath, 'utf8');

    const { code } = transformSync(source, {
      loader: 'jsx',
      jsx: 'automatic',
      format: 'esm',
      sourcefile: filePath,
    });

    return {
      format: 'module',
      source: code,
      shortCircuit: true,
    };
  }

  return nextLoad(url, context);
}

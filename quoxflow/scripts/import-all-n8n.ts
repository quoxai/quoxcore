/**
 * Import all 24 n8n workflow JSONs and report results.
 * Usage: npx tsx scripts/import-all-n8n.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { convertWorkflow, parseN8nWorkflow } from '../src/n8n/index.js';

const WORKFLOWS_DIR = join(import.meta.dirname, '../../quox-dashboard/n8n-workflows');

const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.json')).sort();

console.log(`Found ${files.length} workflow files\n`);
console.log('=' .repeat(80));

let successCount = 0;
let warningCount = 0;
let errorCount = 0;

for (const file of files) {
  const path = join(WORKFLOWS_DIR, file);
  const json = readFileSync(path, 'utf-8');

  try {
    const n8nWorkflow = parseN8nWorkflow(json);
    const result = convertWorkflow(n8nWorkflow);

    const nodeCount = result.workflow.nodes.length;
    const warnCount = result.warnings.length;
    const errCount = result.errors.length;

    const status = errCount > 0 ? 'ERRORS' : warnCount > 0 ? 'WARNINGS' : 'OK';
    const icon = errCount > 0 ? '❌' : warnCount > 0 ? '⚠️' : '✅';

    console.log(`\n${icon} ${file}`);
    console.log(`   Name: ${result.workflow.name}`);
    console.log(`   Nodes: ${nodeCount} | Warnings: ${warnCount} | Errors: ${errCount}`);

    if (warnCount > 0) {
      for (const w of result.warnings) {
        console.log(`   ⚠️  [${w.nodeId || 'global'}] ${w.message}`);
      }
    }

    if (errCount > 0) {
      for (const e of result.errors) {
        console.log(`   ❌  [${e.nodeId || 'global'}] ${e.message}`);
      }
    }

    if (errCount > 0) errorCount++;
    else if (warnCount > 0) warningCount++;
    else successCount++;

  } catch (err) {
    console.log(`\n❌ ${file}`);
    console.log(`   FATAL: ${err instanceof Error ? err.message : err}`);
    errorCount++;
  }
}

console.log('\n' + '=' .repeat(80));
console.log(`\nSummary: ${files.length} workflows`);
console.log(`  ✅ Clean: ${successCount}`);
console.log(`  ⚠️  Warnings: ${warningCount}`);
console.log(`  ❌ Errors: ${errorCount}`);

/**
 * n8n Import Stress Test
 *
 * Runs all 1,346 AI Agent Vault workflows through QuoxFlow's n8n importer.
 * Reports: success rate, node type coverage, expression conversion, failure modes.
 *
 * Usage:
 *   npx tsx src/n8n/stress-test.ts [vault-path]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { convertWorkflow, parseN8nWorkflow } from './workflow-converter.js';
import { getQuoxflowType } from './types.js';

const VAULT_PATH = process.argv[2] || '/opt/quoxcore/uploads/AI_Agent_Vault_extracted/AI_Agent_Vault-main';

interface TestResult {
  file: string;
  category: string;
  name: string;
  success: boolean;
  nodeCount: number;
  edgeCount: number;
  warnings: number;
  errors: number;
  fatalErrors: number;
  n8nNodeTypes: string[];
  quoxflowNodeTypes: string[];
  expressionsConverted: number;
  credentialsRequired: string[];
  errorMessages: string[];
  parseError?: string;
}

async function findWorkflowFiles(dir: string): Promise<{ file: string; category: string }[]> {
  const results: { file: string; category: string }[] = [];

  async function walk(current: string, category: string) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, category || entry.name);
      } else if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
        results.push({ file: fullPath, category: category || 'root' });
      }
    }
  }

  await walk(dir, '');
  return results;
}

async function testWorkflow(filePath: string, category: string): Promise<TestResult> {
  const result: TestResult = {
    file: path.relative(VAULT_PATH, filePath),
    category,
    name: '',
    success: false,
    nodeCount: 0,
    edgeCount: 0,
    warnings: 0,
    errors: 0,
    fatalErrors: 0,
    n8nNodeTypes: [],
    quoxflowNodeTypes: [],
    expressionsConverted: 0,
    credentialsRequired: [],
    errorMessages: [],
  };

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const n8nWorkflow = parseN8nWorkflow(content);
    result.name = n8nWorkflow.name || path.basename(filePath, '.json');
    result.n8nNodeTypes = [...new Set(n8nWorkflow.nodes.map(n => n.type))];

    const importResult = convertWorkflow(n8nWorkflow);
    result.success = importResult.success;
    result.warnings = importResult.warnings.length;
    result.errors = importResult.errors.length;
    result.fatalErrors = importResult.errors.filter(e => e.fatal).length;
    result.errorMessages = importResult.errors.map(e => e.message);

    if (importResult.workflow) {
      result.nodeCount = importResult.workflow.nodes.length;
      result.edgeCount = importResult.workflow.edges.length;
      result.quoxflowNodeTypes = [...new Set(importResult.workflow.nodes.map(n => n.type))];
    }

    result.expressionsConverted = importResult.nodeMapping.reduce(
      (sum, m) => sum + m.expressionsConverted, 0
    );
    result.credentialsRequired = [
      ...new Set(importResult.nodeMapping.flatMap(m => m.credentialsRequired))
    ];
  } catch (err) {
    result.parseError = err instanceof Error ? err.message : String(err);
  }

  return result;
}

async function main() {
  console.log('QuoxFlow n8n Import Stress Test');
  console.log('================================');
  console.log(`Vault: ${VAULT_PATH}`);
  console.log('');

  // Find all workflows
  const files = await findWorkflowFiles(VAULT_PATH);
  console.log(`Found ${files.length} workflow files\n`);

  // Run all imports
  const results: TestResult[] = [];
  let completed = 0;
  const startTime = Date.now();

  for (const { file, category } of files) {
    const result = await testWorkflow(file, category);
    results.push(result);
    completed++;
    if (completed % 100 === 0) {
      const pct = ((completed / files.length) * 100).toFixed(0);
      process.stdout.write(`  ${completed}/${files.length} (${pct}%)...\r`);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\nCompleted in ${(duration / 1000).toFixed(1)}s\n`);

  // === Analysis ===

  const imported = results.filter(r => r.success && !r.parseError);
  const parseFailures = results.filter(r => r.parseError);
  const conversionFailures = results.filter(r => !r.success && !r.parseError);

  // 1. Summary
  console.log('=== SUMMARY ===');
  console.log(`Total workflows:       ${results.length}`);
  console.log(`Successfully imported: ${imported.length} (${pct(imported.length, results.length)})`);
  console.log(`Parse failures:        ${parseFailures.length} (${pct(parseFailures.length, results.length)})`);
  console.log(`Conversion failures:   ${conversionFailures.length} (${pct(conversionFailures.length, results.length)})`);
  console.log('');

  // 2. By category
  console.log('=== BY CATEGORY ===');
  const categories = new Map<string, { total: number; success: number; parseFail: number }>();
  for (const r of results) {
    const cat = categories.get(r.category) || { total: 0, success: 0, parseFail: 0 };
    cat.total++;
    if (r.success && !r.parseError) cat.success++;
    if (r.parseError) cat.parseFail++;
    categories.set(r.category, cat);
  }
  for (const [cat, stats] of [...categories.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${cat.padEnd(42)} ${stats.success}/${stats.total} (${pct(stats.success, stats.total)})`);
  }
  console.log('');

  // 3. Node type coverage
  console.log('=== N8N NODE TYPES ENCOUNTERED ===');
  const n8nTypes = new Map<string, number>();
  for (const r of results) {
    for (const t of r.n8nNodeTypes) {
      n8nTypes.set(t, (n8nTypes.get(t) || 0) + 1);
    }
  }
  const sortedTypes = [...n8nTypes.entries()].sort((a, b) => b[1] - a[1]);
  const explicitlyMapped = sortedTypes.filter(([t]) => {
    const mapped = getQuoxflowType(t);
    return mapped.category !== 'integration'; // integration = fallback
  });
  const fallbackMapped = sortedTypes.filter(([t]) => {
    const mapped = getQuoxflowType(t);
    return mapped.category === 'integration';
  });

  console.log(`  Explicitly mapped: ${explicitlyMapped.length} types`);
  console.log(`  Fallback to call:  ${fallbackMapped.length} types`);
  console.log('');

  console.log('  Top 30 node types:');
  for (const [type, count] of sortedTypes.slice(0, 30)) {
    const mapping = getQuoxflowType(type);
    const mapped = mapping.category !== 'integration' ? `→ ${mapping.type}` : '→ call (fallback)';
    console.log(`    ${String(count).padStart(4)}x  ${type.padEnd(50)} ${mapped}`);
  }
  console.log('');

  // 4. QuoxFlow type distribution
  console.log('=== QUOXFLOW TYPE DISTRIBUTION ===');
  const qfTypes = new Map<string, number>();
  for (const r of imported) {
    for (const t of r.quoxflowNodeTypes) {
      qfTypes.set(t, (qfTypes.get(t) || 0) + 1);
    }
  }
  for (const [type, count] of [...qfTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}x  ${type}`);
  }
  console.log('');

  // 5. Expression conversion stats
  const totalExpr = results.reduce((sum, r) => sum + r.expressionsConverted, 0);
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings, 0);
  console.log('=== EXPRESSION CONVERSION ===');
  console.log(`  Total expressions converted: ${totalExpr}`);
  console.log(`  Total warnings:              ${totalWarnings}`);
  console.log('');

  // 6. Credential requirements
  console.log('=== CREDENTIALS REQUIRED ===');
  const creds = new Map<string, number>();
  for (const r of results) {
    for (const c of r.credentialsRequired) {
      creds.set(c, (creds.get(c) || 0) + 1);
    }
  }
  for (const [cred, count] of [...creds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(count).padStart(4)}x  ${cred}`);
  }
  console.log('');

  // 7. Size distribution
  const nodeCounts = imported.map(r => r.nodeCount).sort((a, b) => a - b);
  console.log('=== WORKFLOW SIZE ===');
  console.log(`  Smallest:  ${nodeCounts[0]} nodes`);
  console.log(`  Median:    ${nodeCounts[Math.floor(nodeCounts.length / 2)]} nodes`);
  console.log(`  Largest:   ${nodeCounts[nodeCounts.length - 1]} nodes`);
  console.log(`  Mean:      ${(nodeCounts.reduce((a, b) => a + b, 0) / nodeCounts.length).toFixed(1)} nodes`);
  console.log(`  Total:     ${nodeCounts.reduce((a, b) => a + b, 0)} nodes across ${imported.length} workflows`);
  console.log('');

  // 8. Parse failures detail
  if (parseFailures.length > 0) {
    console.log('=== PARSE FAILURES ===');
    const parseErrors = new Map<string, number>();
    for (const r of parseFailures) {
      const msg = r.parseError!.slice(0, 80);
      parseErrors.set(msg, (parseErrors.get(msg) || 0) + 1);
    }
    for (const [msg, count] of [...parseErrors.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)}x  ${msg}`);
    }
    console.log('');
  }

  // 9. Conversion failure detail
  if (conversionFailures.length > 0) {
    console.log('=== CONVERSION FAILURES ===');
    const convErrors = new Map<string, number>();
    for (const r of conversionFailures) {
      for (const msg of r.errorMessages) {
        const key = msg.slice(0, 80);
        convErrors.set(key, (convErrors.get(key) || 0) + 1);
      }
    }
    for (const [msg, count] of [...convErrors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(count).padStart(4)}x  ${msg}`);
    }
    console.log('');
  }

  // 10. Unmapped integration nodes (top opportunity)
  console.log('=== TOP UNMAPPED INTEGRATIONS (opportunity for explicit mapping) ===');
  for (const [type, count] of fallbackMapped.slice(0, 20)) {
    console.log(`  ${String(count).padStart(4)}x  ${type}`);
  }
  console.log('');
}

function pct(num: number, total: number): string {
  return total > 0 ? `${((num / total) * 100).toFixed(1)}%` : '0%';
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

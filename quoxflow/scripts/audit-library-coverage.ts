/**
 * n8n Workflow Library Coverage Audit
 *
 * Runs every n8n-imported entry in quox-dashboard's workflow-library-index.json
 * through the real converter (parseN8nWorkflow + convertWorkflow) and classifies
 * each as clean / needs-polish / blocked, exactly the way promo/docs copy should
 * be sourcing its numbers.
 *
 * Written 2026-08-08 after three separate ad-hoc reconstructions of "the audit
 * script" in one evening produced three different totals (249, 154, 196) against
 * the identical merged code — because nobody had committed a canonical version.
 * COMMIT THIS FILE. Do not let a future session reconstruct this from memory
 * again; re-run it and cite its output instead.
 *
 * Classification:
 *   - blocked: at least one node's config carries the stable "Configure actual
 *     endpoint" marker workflow-converter.ts's buildCallConfig() fallback emits
 *     for a genuinely unmapped integration node. A workflow is only as usable as
 *     its least-covered node.
 *   - needs-polish: converts with zero placeholder nodes but at least one
 *     warning (typically "requires credentials: X" — normal, not a bug).
 *   - clean: converts with zero placeholders and zero warnings.
 *
 * Usage: npx tsx scripts/audit-library-coverage.ts
 * Requires: quox-dashboard checked out as a sibling repo (for the index file)
 * and VAULT_PATH pointing at the raw n8n export corpus (defaults to the path
 * used throughout the 2026-08-08 session).
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseN8nWorkflow, convertWorkflow, getQuoxflowType } from '../src/n8n/index.js';

/**
 * quoxflowType values that N8N_NODE_MAPPING can produce but
 * buildNodeConfig()'s switch in workflow-converter.ts has no case for
 * (falls to the generic passthrough default: { _originalType, expression:
 * 'input' } — silently non-functional, no _note marker). Checked by hand
 * against the switch on 2026-08-08; re-verify this list if the switch
 * gains cases.
 */
const UNHANDLED_QUOXFLOW_TYPES = new Set([
  'flow:loop',
  'flow:merge',
  'error:catch',
  'util:subworkflow',
  'trigger:event',
]);

const VAULT = process.env.VAULT_PATH || '/opt/quoxcore/uploads/AI_Agent_Vault_extracted/AI_Agent_Vault-main';
const INDEX_PATH = process.env.LIBRARY_INDEX_PATH || '/opt/quoxcore/src/config/workflow-library-index.json';

if (!fs.existsSync(VAULT)) {
  console.error(`Vault not found at ${VAULT}. Set VAULT_PATH to the raw n8n export corpus.`);
  process.exit(1);
}
if (!fs.existsSync(INDEX_PATH)) {
  console.error(`Library index not found at ${INDEX_PATH}. Set LIBRARY_INDEX_PATH.`);
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
const arr = Array.isArray(raw) ? raw : (raw.workflows || raw.templates || Object.values(raw)[0]);
const n8nImported = arr.filter((w: any) => w.source === 'n8n-imported');

console.log(`Total n8n-imported entries: ${n8nImported.length}`);

let clean = 0, needsPolish = 0, blocked = 0, missing = 0, hardError = 0;
const blockedTypeCounts: Record<string, number> = {};

for (const entry of n8nImported) {
  const filePath = path.join(VAULT, entry.workflowFile);
  if (!fs.existsSync(filePath)) {
    missing++;
    continue;
  }

  let workflow;
  try {
    workflow = parseN8nWorkflow(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    hardError++;
    blockedTypeCounts['(parse error)'] = (blockedTypeCounts['(parse error)'] || 0) + 1;
    continue;
  }

  const result = convertWorkflow(workflow);
  if (!result.success) {
    hardError++;
    blockedTypeCounts['(convert error)'] = (blockedTypeCounts['(convert error)'] || 0) + 1;
    continue;
  }

  const nodes = (result.workflow?.nodes || []) as any[];
  const placeholderTypes = new Set<string>();
  for (const node of nodes) {
    const note = node?.config?._note;
    if (typeof note === 'string' && note.includes('Configure actual endpoint')) {
      const match = note.match(/^Converted from n8n (.+)\. Configure actual endpoint\.$/);
      placeholderTypes.add(match ? match[1] : 'unknown');
    }
  }

  // Second failure mode: node types the top-level switch has no case for
  // at all, silently falling to a no-op passthrough with no _note marker,
  // so the check above alone would miss these entirely.
  for (const n8nNode of workflow.nodes) {
    const { type: quoxflowType } = getQuoxflowType(n8nNode.type);
    if (UNHANDLED_QUOXFLOW_TYPES.has(quoxflowType)) {
      placeholderTypes.add(`${n8nNode.type} (unhandled quoxflowType: ${quoxflowType})`);
    }
  }

  if (placeholderTypes.size > 0) {
    blocked++;
    for (const t of placeholderTypes) blockedTypeCounts[t] = (blockedTypeCounts[t] || 0) + 1;
  } else if ((result.warnings || []).length > 0) {
    needsPolish++;
  } else {
    clean++;
  }
}

console.log('--- RESULTS ---');
console.log(`clean: ${clean}`);
console.log(`needs-polish: ${needsPolish}`);
console.log(`blocked: ${blocked}`);
console.log(`hard error: ${hardError}`);
console.log(`missing file: ${missing}`);
console.log(`TOTAL ready to run (clean + needs-polish): ${clean + needsPolish} of ${n8nImported.length}`);
console.log('--- blocked-by node type (workflow counts, a workflow may count under >1 type) ---');
Object.entries(blockedTypeCounts)
  .sort((a, b) => (b[1] as number) - (a[1] as number))
  .slice(0, 20)
  .forEach(([type, count]) => console.log(`${count}\t${type}`));

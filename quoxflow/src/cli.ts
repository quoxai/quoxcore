#!/usr/bin/env node
/**
 * Quoxflow CLI
 *
 * Usage:
 *   quoxflow run <workflow.json> [--input <data.json>]
 *   quoxflow query --corr <correlation-id>
 *   quoxflow validate <workflow.json>
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Workflow, WorkflowSchema } from './core/workflow.js';
import { Envelope } from './core/envelope.js';
import { ControlPipeline } from './pipeline/control-pipeline.js';
import { createInMemoryStore, createPostgresStore, EnvelopeStore } from './store/envelope-store.js';
import { ExecutorRegistry, executorRegistry } from './executors/executor.interface.js';
import { callExecutor } from './executors/call.executor.js';
import { transformExecutor } from './executors/transform.executor.js';
import { webhookExecutor } from './executors/webhook.executor.js';
import { conditionExecutor } from './executors/condition.executor.js';
import { switchExecutor } from './executors/switch.executor.js';
import { loopExecutor } from './executors/loop.executor.js';
import { tryExecutor, catchExecutor, throwExecutor } from './executors/error.executor.js';
import { waitExecutor, logExecutor, subworkflowExecutor, SubworkflowExecutor } from './executors/utility.executor.js';
import { parallelExecutor, mergeExecutor } from './executors/parallel.executor.js';
import { endExecutor } from './executors/end.executor.js';
import { aggregateExecutor } from './executors/aggregate.executor.js';
import { agentInvokeExecutor } from './executors/agent-invoke.executor.js';
import { createWorkflowStore, createInMemoryWorkflowStore, WorkflowStore } from './api/stores/workflow-store.js';
import { SYSTEM_SCOPE } from './api/middleware/org-scope.js';

// Register default executors
executorRegistry.register(callExecutor);
executorRegistry.register(transformExecutor);
executorRegistry.register(webhookExecutor);
executorRegistry.register(conditionExecutor);
executorRegistry.register(switchExecutor);
executorRegistry.register(loopExecutor);
executorRegistry.register(tryExecutor);
executorRegistry.register(catchExecutor);
executorRegistry.register(throwExecutor);
executorRegistry.register(waitExecutor);
executorRegistry.register(logExecutor);
executorRegistry.register(subworkflowExecutor);
executorRegistry.register(parallelExecutor);
executorRegistry.register(mergeExecutor);
executorRegistry.register(endExecutor);
executorRegistry.register(aggregateExecutor);
executorRegistry.register(agentInvokeExecutor);

interface CLIOptions {
  command: string;
  args: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): CLIOptions {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 2; // Skip node and script path
  while (i < argv.length) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];

      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      flags[key] = true;
      i++;
    } else {
      args.push(arg);
      i++;
    }
  }

  return {
    command: args[0] ?? 'help',
    args: args.slice(1),
    flags,
  };
}

function printHelp(): void {
  console.log(`
Quoxflow - Auditable Workflow Engine
=====================================

Usage:
  quoxflow <command> [options]

Commands:
  run <workflow.json>       Run a workflow
    --input <file>          JSON file with trigger data
    --data <json>           Inline JSON trigger data
    --db <connection>       PostgreSQL connection string

  import <n8n-workflow.json>  Import n8n workflow
    --output <file>           Output file (default: stdout)
    --pretty                  Pretty print JSON output

  query                     Query envelope store
    --corr <id>             Filter by correlation ID
    --intent <pattern>      Filter by intent (supports %)
    --db <connection>       PostgreSQL connection string

  validate <workflow.json>  Validate workflow definition

  help                      Show this help message

Examples:
  quoxflow run workflow.json --data '{"amount": 100}'
  quoxflow run workflow.json --input trigger-data.json
  quoxflow import n8n-export.json --output converted.json
  quoxflow query --corr wf-order-abc123
  quoxflow validate my-workflow.json
`);
}

async function runWorkflow(options: CLIOptions): Promise<void> {
  const workflowPath = options.args[0];

  if (!workflowPath) {
    console.error('Error: Workflow file path required');
    console.error('Usage: quoxflow run <workflow.json>');
    process.exit(1);
  }

  // Load workflow
  let workflow: Workflow;
  try {
    const content = readFileSync(resolve(workflowPath), 'utf-8');
    const parsed = JSON.parse(content);
    workflow = WorkflowSchema.parse(parsed) as Workflow;
  } catch (error) {
    console.error(`Error loading workflow: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  // Load trigger data
  let triggerData: unknown = {};
  if (options.flags.input) {
    try {
      const content = readFileSync(resolve(options.flags.input as string), 'utf-8');
      triggerData = JSON.parse(content);
    } catch (error) {
      console.error(`Error loading input data: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  } else if (options.flags.data) {
    try {
      triggerData = JSON.parse(options.flags.data as string);
    } catch (error) {
      console.error(`Error parsing input data: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  } else if (options.args[1]) {
    // Support inline JSON as positional argument
    try {
      triggerData = JSON.parse(options.args[1]);
    } catch (error) {
      console.error(`Error parsing inline JSON: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  // Create store
  let store: EnvelopeStore;
  if (options.flags.db) {
    store = createPostgresStore({ connectionString: options.flags.db as string });
    await store.init();
  } else {
    store = createInMemoryStore();
  }

  // Wire a real subworkflow executor (mirrors server.ts:464-470). When --db is
  // supplied, sub-workflows referenced by util:subworkflow nodes are resolved
  // from the same Postgres database the caller already pointed us at (the
  // usual case: workflows were created via the API and persisted there). With
  // no --db, there is no external workflow store to resolve arbitrary
  // workflowId references against, so we seed an in-memory store with just
  // the top-level workflow being run — this supports self-referencing
  // sub-workflows and keeps failures honest: an unknown workflowId now
  // returns SUBWORKFLOW_NOT_FOUND instead of the old placeholder's silent
  // pass-through "success".
  let workflowStore: WorkflowStore;
  if (options.flags.db) {
    workflowStore = createWorkflowStore({ connectionString: options.flags.db as string });
    await workflowStore.init();
  } else {
    workflowStore = createInMemoryWorkflowStore();
    await workflowStore.init();
    // QF-MT WP3: local CLI run, no auth/tenant context — trusted system scope.
    await workflowStore.save(workflow, { orgId: SYSTEM_SCOPE });
  }
  const fullSubworkflowExecutor = new SubworkflowExecutor({
    workflowStore,
    executors: executorRegistry,
    envelopeStore: store,
  });
  executorRegistry.register(fullSubworkflowExecutor);

  // Create pipeline
  const pipeline = new ControlPipeline({
    store,
    executors: executorRegistry,
  });

  console.log(`Running workflow: ${workflow.name} (${workflow.id})`);
  console.log('---');

  // Execute
  const result = await pipeline.execute(workflow, triggerData);

  // Output results
  console.log();
  console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  console.log(`Execution ID: ${result.executionId}`);
  console.log(`Correlation ID: ${result.correlationId}`);
  console.log(`Duration: ${result.duration}ms`);
  console.log();

  if (result.error) {
    console.log(`Error: [${result.error.code}] ${result.error.message}`);
    console.log();
  }

  console.log('Output:');
  console.log(JSON.stringify(result.output, null, 2));
  console.log();

  console.log('Envelope Chain:');
  console.log('---');
  for (const env of result.envelopes) {
    console.log(`${env.id.slice(-8)} | ${env.intent.padEnd(35)} | ${env.type}`);
  }
  console.log();

  await store.close();
  await workflowStore.close();

  if (!result.success) {
    process.exit(1);
  }
}

async function queryEnvelopes(options: CLIOptions): Promise<void> {
  if (!options.flags.db) {
    console.error('Error: --db connection string required for query');
    process.exit(1);
  }

  const store = createPostgresStore({ connectionString: options.flags.db as string });

  let envelopes: Envelope[];

  if (options.flags.corr) {
    envelopes = await store.getByCorrelation(options.flags.corr as string, SYSTEM_SCOPE);
  } else if (options.flags.intent) {
    envelopes = await store.query({ intent: options.flags.intent as string }, SYSTEM_SCOPE);
  } else {
    envelopes = await store.query({ limit: 100 }, SYSTEM_SCOPE);
  }

  if (envelopes.length === 0) {
    console.log('No envelopes found');
  } else {
    console.log(`Found ${envelopes.length} envelope(s):`);
    console.log();

    for (const env of envelopes) {
      console.log(`ID:       ${env.id}`);
      console.log(`Intent:   ${env.intent}`);
      console.log(`Type:     ${env.type}`);
      console.log(`From:     ${env.from}`);
      console.log(`To:       ${env.to}`);
      console.log(`Corr:     ${env.corr}`);
      console.log(`Reply To: ${env.reply_to ?? '-'}`);
      console.log(`Time:     ${env.ts}`);
      console.log(`Payload:  ${JSON.stringify(env.payload)}`);
      console.log('---');
    }
  }

  await store.close();
}

function validateWorkflow(options: CLIOptions): void {
  const workflowPath = options.args[0];

  if (!workflowPath) {
    console.error('Error: Workflow file path required');
    process.exit(1);
  }

  try {
    const content = readFileSync(resolve(workflowPath), 'utf-8');
    const parsed = JSON.parse(content);
    const workflow = WorkflowSchema.parse(parsed);

    console.log(`Workflow "${workflow.name}" is valid`);
    console.log(`  ID: ${workflow.id}`);
    console.log(`  Nodes: ${workflow.nodes.length}`);
    console.log(`  Edges: ${workflow.edges.length}`);

    // Check for registered executors
    const unknownTypes: string[] = [];
    for (const node of workflow.nodes) {
      if (!executorRegistry.has(node.type)) {
        unknownTypes.push(node.type);
      }
    }

    if (unknownTypes.length > 0) {
      console.log(`  Warning: Unknown node types: ${unknownTypes.join(', ')}`);
    }
  } catch (error) {
    if (error instanceof Error && 'errors' in error) {
      console.error('Validation errors:');
      console.error(JSON.stringify((error as { errors: unknown }).errors, null, 2));
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
    }
    process.exit(1);
  }
}

async function importN8nWorkflow(options: CLIOptions): Promise<void> {
  const { convertWorkflow, parseN8nWorkflow } = await import('./n8n/index.js');

  const inputPath = options.args[0];

  if (!inputPath) {
    console.error('Error: n8n workflow file path required');
    console.error('Usage: quoxflow import <n8n-workflow.json> [--output <file>]');
    process.exit(1);
  }

  // Read n8n workflow
  let n8nWorkflow;
  try {
    const content = readFileSync(resolve(inputPath), 'utf-8');
    n8nWorkflow = parseN8nWorkflow(content);
  } catch (error) {
    console.error(`Error reading n8n workflow: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  console.log(`Importing n8n workflow: ${n8nWorkflow.name}`);
  console.log(`  Nodes: ${n8nWorkflow.nodes.length}`);
  console.log('');

  // Convert workflow
  const result = convertWorkflow(n8nWorkflow, {
    addAuditAnnotations: true,
  });

  // Report results
  if (result.errors.length > 0) {
    console.log('Errors:');
    for (const error of result.errors) {
      console.log(`  [${error.fatal ? 'FATAL' : 'ERROR'}] ${error.nodeName || 'workflow'}: ${error.message}`);
    }
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of result.warnings) {
      console.log(`  [WARN] ${warning.nodeName}: ${warning.message}`);
      if (warning.suggestion) {
        console.log(`         Suggestion: ${warning.suggestion}`);
      }
    }
    console.log('');
  }

  console.log('Node Mapping:');
  console.log('  n8n Node                          → Quoxflow Type');
  console.log('  ' + '-'.repeat(60));
  for (const mapping of result.nodeMapping) {
    const n8nInfo = `${mapping.n8nName} (${mapping.n8nType.replace('n8n-nodes-base.', '')})`;
    console.log(`  ${n8nInfo.padEnd(35)} → ${mapping.quoxflowType}`);
    if (mapping.expressionsConverted > 0) {
      console.log(`    ${mapping.expressionsConverted} expression(s) converted`);
    }
    if (mapping.credentialsRequired.length > 0) {
      console.log(`    Credentials: ${mapping.credentialsRequired.join(', ')}`);
    }
  }
  console.log('');

  if (!result.success) {
    console.error('Import failed due to fatal errors');
    process.exit(1);
  }

  // Output the converted workflow
  const outputJson = options.flags.pretty
    ? JSON.stringify(result.workflow, null, 2)
    : JSON.stringify(result.workflow);

  if (options.flags.output) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(options.flags.output as string), outputJson);
    console.log(`Converted workflow saved to: ${options.flags.output}`);
  } else {
    console.log('Converted Workflow:');
    console.log('---');
    console.log(JSON.stringify(result.workflow, null, 2));
  }

  console.log('');
  console.log(`Import complete: ${result.nodeMapping.length} nodes converted`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv);

  switch (options.command) {
    case 'run':
      await runWorkflow(options);
      break;

    case 'import':
      await importN8nWorkflow(options);
      break;

    case 'query':
      await queryEnvelopes(options);
      break;

    case 'validate':
      validateWorkflow(options);
      break;

    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp();
      break;
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

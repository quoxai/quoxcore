/**
 * Quoxflow - Auditable Workflow Engine
 *
 * "Every decision traced. Every action proven. Every workflow auditable."
 */

// Core types
export * from './core/envelope.js';
export * from './core/workflow.js';
export * from './core/execution.js';

// Store
export * from './store/envelope-store.js';

// Expression engine
export * from './expression/engine.js';

// Executors
export * from './executors/executor.interface.js';
export { callExecutor } from './executors/call.executor.js';
export { transformExecutor } from './executors/transform.executor.js';
export { webhookExecutor } from './executors/webhook.executor.js';
export { conditionExecutor } from './executors/condition.executor.js';
export { switchExecutor } from './executors/switch.executor.js';
export { loopExecutor } from './executors/loop.executor.js';
export { tryExecutor, catchExecutor, throwExecutor } from './executors/error.executor.js';
export { waitExecutor, logExecutor, subworkflowExecutor } from './executors/utility.executor.js';
export { parallelExecutor, mergeExecutor } from './executors/parallel.executor.js';
export { aggregateExecutor } from './executors/aggregate.executor.js';

// Pipeline
export * from './pipeline/control-pipeline.js';
export * from './pipeline/lifecycle-hooks.js';
export * from './pipeline/observation-registry.js';
export * from './pipeline/crystalliser.js';
export * from './pipeline/layers/index.js';

// Credential resolution
export * from './core/credential-resolver.js';

// AEE Bridge (QuoxCORE ↔ QuoxFlow envelope conversion)
export * from './bridge/aee-bridge.js';

// n8n Import
export * from './n8n/index.js';

// API
export * from './api/index.js';

// Version
export const VERSION = '0.1.0';

/**
 * Quoxflow API Module
 *
 * REST API for workflow management, execution, and audit queries.
 */

export { createApp, type AppConfig } from './app.js';

// Stores
export {
  type WorkflowStore,
  type StoredWorkflow,
  createWorkflowStore,
  createInMemoryWorkflowStore,
} from './stores/workflow-store.js';

export {
  type ExecutionStore,
  type StoredExecution,
  type ExecutionStatus as ApiExecutionStatus,
  createExecutionStore,
  createInMemoryExecutionStore,
} from './stores/execution-store.js';

// Policy Store (re-export from store module)
export {
  InMemoryPolicyStore,
  PostgresPolicyStore,
  createInMemoryPolicyStore,
  createPostgresPolicyStore,
} from '../store/policy-store.js';

export {
  type PolicyStore,
  type PolicyDefinition,
  type PolicyRule,
  type PolicyAction,
  type PolicyScope,
} from '../policy/types.js';

// Approval (re-export from approval module)
export {
  type ApprovalStore,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalStatus,
  InMemoryApprovalStore,
  PostgresApprovalStore,
  createInMemoryApprovalStore,
  createPostgresApprovalStore,
  ApprovalEngine,
  createApprovalEngine,
} from '../approval/index.js';

// Evidence (re-export from evidence module)
export {
  type EvidenceStore,
  type EvidenceRecord,
  type EvidenceType,
  type EvidenceStorageBackend,
  InMemoryEvidenceStore,
  PostgresEvidenceStore,
  createInMemoryEvidenceStore,
  createPostgresEvidenceStore,
  MemoryStorageBackend,
  FileStorageBackend,
  createMemoryStorageBackend,
  createFileStorageBackend,
} from '../evidence/index.js';

// Services
export { WorkflowService, type ValidationResult } from './services/workflow-service.js';
export { ExecutionService, type ExecutionOptions, type ExecutionResult } from './services/execution-service.js';

// Middleware
export { correlationMiddleware, CORRELATION_HEADER } from './middleware/correlation.js';
export { handleError, ErrorCodes, ApiError, NotFoundError, ValidationError } from './middleware/error-handler.js';
export { validateBody, validateQuery, validateParams } from './middleware/validation.js';

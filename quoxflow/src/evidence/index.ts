/**
 * Evidence Module
 *
 * Exports all evidence-related types, classes, and utilities.
 */

// Types
export {
  type EvidenceType,
  type StorageBackend,
  type EvidenceRecord,
  type CreateEvidenceRequest,
  type EvidenceListOptions,
  type EvidenceStorageBackend,
  type EvidenceStore,
  EvidenceRecordSchema,
} from './types.js';

// Storage Backends
export {
  FileStorageBackend,
  createFileStorageBackend,
  type FileBackendConfig,
} from './backends/file-backend.js';

export {
  MemoryStorageBackend,
  createMemoryStorageBackend,
} from './backends/memory-backend.js';

// Evidence Store
export {
  InMemoryEvidenceStore,
  PostgresEvidenceStore,
  createInMemoryEvidenceStore,
  createPostgresEvidenceStore,
  computeEvidenceChainHash,
  verifyEvidenceChain,
  type EvidenceChainVerification,
} from './evidence-store.js';

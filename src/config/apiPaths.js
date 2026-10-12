/**
 * Centralized API Path Builder — Phase 15
 *
 * All vault API paths in one place. Future namespace changes only touch this file.
 * Backend serves both /vault/* and /integrations/* (aliases).
 */

// Vault credential CRUD
export const VAULT_LIST = (orgId) => `/api/orgs/${orgId}/vault`
export const VAULT_CREATE = (orgId) => `/api/orgs/${orgId}/vault`
export const VAULT_GET = (orgId, id) => `/api/orgs/${orgId}/vault/${id}`
export const VAULT_UPDATE = (orgId, id) => `/api/orgs/${orgId}/vault/${id}`
export const VAULT_DELETE = (orgId, id) => `/api/orgs/${orgId}/vault/${id}`

// Vault operations
export const VAULT_TEST = (orgId, id) => `/api/orgs/${orgId}/vault/${id}/test`
export const VAULT_DEFAULT = (orgId, id) => `/api/orgs/${orgId}/vault/${id}/default`
export const VAULT_ROTATE = (orgId, id) => `/api/orgs/${orgId}/vault/${id}/rotate`
export const VAULT_TEST_CREDENTIALS = (orgId) => `/api/orgs/${orgId}/vault/test-credentials`

// Vault metadata
export const VAULT_TYPES = (orgId) => `/api/orgs/${orgId}/vault/types`
export const VAULT_STATS = (orgId) => `/api/orgs/${orgId}/vault/vault-stats`
export const VAULT_ACTIVITY = (orgId) => `/api/orgs/${orgId}/vault/activity`
export const VAULT_EXPIRING = (orgId) => `/api/orgs/${orgId}/vault/expiring`
export const VAULT_HEALTH_SCAN = (orgId) => `/api/orgs/${orgId}/vault/health-scan`

// Leases
export const VAULT_LEASES = (orgId) => `/api/orgs/${orgId}/vault/leases`
export const VAULT_LEASE_APPROVE = (orgId, id) => `/api/orgs/${orgId}/vault/leases/${id}/approve`
export const VAULT_LEASE_DENY = (orgId, id) => `/api/orgs/${orgId}/vault/leases/${id}/deny`
export const VAULT_LEASE_REVOKE = (orgId, id) => `/api/orgs/${orgId}/vault/leases/${id}/revoke`

// Folders
export const VAULT_FOLDERS = (orgId) => `/api/orgs/${orgId}/vault/folders`
export const VAULT_FOLDER = (orgId, id) => `/api/orgs/${orgId}/vault/folders/${id}`

// Migration
export const VAULT_MIGRATE_LOCAL = (orgId) => `/api/orgs/${orgId}/vault/migrate-local`

// Internal (collector → auth)
export const VAULT_DECRYPT = (id) => `/api/internal/vault/${id}/decrypt`

// Agent credential assignments (Phase 14 routes)
export const AGENT_ASSIGNMENTS = (orgId) => `/api/orgs/${orgId}/agent-credential-assignments`
export const AGENT_ASSIGNMENT = (orgId, id) => `/api/orgs/${orgId}/agent-credential-assignments/${id}`

// Cross-org credential availability (TAILMESH-FIX): used by connector
// onboarding screens to surface "you have a credential in another org"
// instead of looking like data loss when the user is in the wrong scope.
export const CROSS_ORG_CREDENTIALS = (type) => `/api/me/cross-org-credentials?type=${encodeURIComponent(type)}`
export const VAULT_COPY_FROM = (targetOrgId, sourceCredentialId) => `/api/orgs/${targetOrgId}/vault/copy-from/${sourceCredentialId}`

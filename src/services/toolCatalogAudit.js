/**
 * Tool Catalog AEE Audit Service
 * Fire-and-forget envelope logging for tool library and agent management.
 * Covers tool install/uninstall, agent CRUD, and tool assignments.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const CATALOG_INTENTS = {
  TOOL_INSTALLED: 'quox.catalog.tool_installed',
  TOOL_UPDATED: 'quox.catalog.tool_updated',
  TOOL_UNINSTALLED: 'quox.catalog.tool_uninstalled',
  AGENT_CREATED: 'quox.catalog.agent_created',
  AGENT_UPDATED: 'quox.catalog.agent_updated',
  AGENT_DELETED: 'quox.catalog.agent_deleted',
  TOOL_ASSIGNED: 'quox.catalog.tool_assigned',
  ASSIGNMENT_UPDATED: 'quox.catalog.assignment_updated',
  TOOL_REVOKED: 'quox.catalog.tool_revoked',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function catalogCorrelation() {
  return prefixedUlid('CAT')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[ToolCatalogAudit]', err.message)) }
  catch (err) { console.warn('[ToolCatalogAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logToolInstalled(orgId, result) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.TOOL_INSTALLED, {
      orgId,
      installationId: result?.id,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logToolUpdated(orgId, installationId) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.TOOL_UPDATED, {
      orgId,
      installationId,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logToolUninstalled(orgId, installationId) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.TOOL_UNINSTALLED, {
      orgId,
      installationId,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logAgentCreated(orgId, result) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.AGENT_CREATED, {
      orgId,
      agentId: result?.id,
      name: (result?.name || '').slice(0, 100),
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logAgentUpdated(orgId, agentDbId) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.AGENT_UPDATED, {
      orgId,
      agentId: agentDbId,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logAgentDeleted(orgId, agentDbId) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.AGENT_DELETED, {
      orgId,
      agentId: agentDbId,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logToolAssigned(orgId, agentDbId, result) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.TOOL_ASSIGNED, {
      orgId,
      agentId: agentDbId,
      assignmentId: result?.id,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logAssignmentUpdated(orgId, agentDbId, assignmentId) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.ASSIGNMENT_UPDATED, {
      orgId,
      agentId: agentDbId,
      assignmentId,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

export function logToolRevoked(orgId, agentDbId, assignmentId) {
  fireAndForget(async () => {
    const event = createEvent('system.catalog', CATALOG_INTENTS.TOOL_REVOKED, {
      orgId,
      agentId: agentDbId,
      assignmentId,
      timestamp: Date.now(),
    }, catalogCorrelation())
    await storeEnvelope(event)
  })
}

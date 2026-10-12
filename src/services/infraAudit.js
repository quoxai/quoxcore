/**
 * Infrastructure AEE Audit Service
 * Fire-and-forget envelope logging for bastion/infrastructure operations.
 * Covers host CRUD, command execution, registry import, SSH key management, tool runs.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const INFRA_INTENTS = {
  HOST_ADDED: 'quox.infra.host_added',
  HOST_UPDATED: 'quox.infra.host_updated',
  HOST_REMOVED: 'quox.infra.host_removed',
  COMMAND_EXECUTED: 'quox.infra.command_executed',
  REGISTRY_IMPORTED: 'quox.infra.registry_imported',
  KEY_GENERATED: 'quox.infra.key_generated',
  KEY_DEPLOYED: 'quox.infra.key_deployed',
  KEY_REVOKED: 'quox.infra.key_revoked',
  SUDO_SETUP: 'quox.infra.sudo_setup',
  TOOL_RUN: 'quox.infra.tool_run',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function infraCorrelation() {
  return prefixedUlid('INFRA')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[InfraAudit]', err.message)) }
  catch (err) { console.warn('[InfraAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logHostAdded(host) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.HOST_ADDED, {
      hostId: host?.id || host?.host_id,
      alias: (host?.alias || '').slice(0, 100),
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logHostUpdated(hostId, updates) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.HOST_UPDATED, {
      hostId,
      fields: Object.keys(updates || {}),
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logHostRemoved(hostId) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.HOST_REMOVED, {
      hostId,
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logCommandExecuted(targets, command) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.COMMAND_EXECUTED, {
      targetCount: Array.isArray(targets) ? targets.length : 1,
      commandPrefix: (command || '').slice(0, 50),
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logRegistryImported(mode) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.REGISTRY_IMPORTED, {
      mode: mode || 'merge',
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logKeyGenerated(params) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.KEY_GENERATED, {
      keyName: (params?.name || '').slice(0, 100),
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logKeyDeployed(params) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.KEY_DEPLOYED, {
      keyId: params?.key_id,
      targetCount: params?.hosts?.length || (params?.group ? 1 : 0),
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logKeyRevoked(keyId) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.KEY_REVOKED, {
      keyId,
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logSudoSetup(params) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.SUDO_SETUP, {
      targetCount: params?.hosts?.length || (params?.group ? 1 : 0),
      user: (params?.user || '').slice(0, 50),
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

export function logToolRun(params) {
  fireAndForget(async () => {
    const event = createEvent('system.bastion', INFRA_INTENTS.TOOL_RUN, {
      toolId: params?.tool_id,
      dryRun: !!params?.dry_run,
      timestamp: Date.now(),
    }, infraCorrelation())
    await storeEnvelope(event)
  })
}

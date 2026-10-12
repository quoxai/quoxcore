/**
 * Integrations Vault AEE Audit Service
 * Fire-and-forget envelope logging for vault credential operations.
 * Covers credential CRUD and default assignment.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const VAULT_INTENTS = {
  CREATED: 'quox.vault.credential_created',
  UPDATED: 'quox.vault.credential_updated',
  DELETED: 'quox.vault.credential_deleted',
  DEFAULT_SET: 'quox.vault.default_set',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function vaultCorrelation() {
  return prefixedUlid('VAULT')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[IntegrationsAudit]', err.message)) }
  catch (err) { console.warn('[IntegrationsAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logCredentialCreated(result) {
  fireAndForget(async () => {
    const event = createEvent('system.vault', VAULT_INTENTS.CREATED, {
      credentialId: result?.id,
      integrationType: (result?.integration_type || '').slice(0, 50),
      timestamp: Date.now(),
    }, vaultCorrelation())
    await storeEnvelope(event)
  })
}

export function logCredentialUpdated(id) {
  fireAndForget(async () => {
    const event = createEvent('system.vault', VAULT_INTENTS.UPDATED, {
      credentialId: id,
      timestamp: Date.now(),
    }, vaultCorrelation())
    await storeEnvelope(event)
  })
}

export function logCredentialDeleted(id) {
  fireAndForget(async () => {
    const event = createEvent('system.vault', VAULT_INTENTS.DELETED, {
      credentialId: id,
      timestamp: Date.now(),
    }, vaultCorrelation())
    await storeEnvelope(event)
  })
}

export function logDefaultSet(id) {
  fireAndForget(async () => {
    const event = createEvent('system.vault', VAULT_INTENTS.DEFAULT_SET, {
      credentialId: id,
      timestamp: Date.now(),
    }, vaultCorrelation())
    await storeEnvelope(event)
  })
}

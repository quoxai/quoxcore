/**
 * Team AEE Audit Service
 * Fire-and-forget envelope logging for agentic team operations.
 * Covers team CRUD, schedule CRUD, context updates, and pack installs.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const TEAM_INTENTS = {
  CREATED: 'quox.team.created',
  UPDATED: 'quox.team.updated',
  INSTALLED: 'quox.team.installed',
  UNINSTALLED: 'quox.team.uninstalled',
  PACK_INSTALLED: 'quox.team.pack_installed',
  CONTEXT_UPDATED: 'quox.team.context_updated',
  SCHEDULE_CREATED: 'quox.team.schedule_created',
  SCHEDULE_UPDATED: 'quox.team.schedule_updated',
  SCHEDULE_DELETED: 'quox.team.schedule_deleted',
  SCHEDULE_TOGGLED: 'quox.team.schedule_toggled',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function teamCorrelation() {
  return prefixedUlid('TEAM')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[TeamAudit]', err.message)) }
  catch (err) { console.warn('[TeamAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logTeamCreated(result) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.CREATED, {
      teamId: result?.id || result?.team_id,
      name: (result?.name || '').slice(0, 200),
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logTeamUpdated(teamId, updates) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.UPDATED, {
      teamId,
      fields: Object.keys(updates || {}),
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logTeamInstalled(result) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.INSTALLED, {
      teamId: result?.id || result?.team_id,
      name: (result?.name || '').slice(0, 200),
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logTeamUninstalled(teamId) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.UNINSTALLED, {
      teamId,
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logPackInstalled(packName, teamCount) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.PACK_INSTALLED, {
      packName: (packName || '').slice(0, 200),
      teamCount,
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logTeamContextUpdated(teamId, key) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.CONTEXT_UPDATED, {
      teamId,
      key: (key || '').slice(0, 100),
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logScheduleCreated(teamId, result) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.SCHEDULE_CREATED, {
      teamId,
      scheduleId: result?.id,
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logScheduleUpdated(teamId, scheduleId) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.SCHEDULE_UPDATED, {
      teamId,
      scheduleId,
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logScheduleDeleted(teamId, scheduleId) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.SCHEDULE_DELETED, {
      teamId,
      scheduleId,
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

export function logScheduleToggled(teamId, scheduleId, enabled) {
  fireAndForget(async () => {
    const event = createEvent('system.teams', TEAM_INTENTS.SCHEDULE_TOGGLED, {
      teamId,
      scheduleId,
      enabled,
      timestamp: Date.now(),
    }, teamCorrelation())
    await storeEnvelope(event)
  })
}

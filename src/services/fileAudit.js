/**
 * File AEE Audit Service
 * Fire-and-forget envelope logging for file and folder operations.
 * Follows the actionAuditService.js pattern.
 */

import { createEvent, storeEnvelope, prefixedUlid } from '../lib/aee/index.js'

// ─── Intents ─────────────────────────────────────────────────────────

export const FILE_INTENTS = {
  UPLOADED:       'quox.file.uploaded',
  DELETED:        'quox.file.deleted',
  FOLDER_CREATED: 'quox.folder.created',
  FOLDER_DELETED: 'quox.folder.deleted',
  FOLDER_UPDATED: 'quox.folder.updated',
}

// ─── Helpers ─────────────────────────────────────────────────────────

function fileCorrelation(parentCorr) {
  return parentCorr || prefixedUlid('FILE')
}

function fireAndForget(fn) {
  try { fn().catch(err => console.warn('[FileAudit]', err.message)) }
  catch (err) { console.warn('[FileAudit]', err.message) }
}

// ─── Logging Functions ───────────────────────────────────────────────

export function logFileUploaded(fileMeta, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.files',
      FILE_INTENTS.UPLOADED,
      {
        fileId: fileMeta.id,
        name: fileMeta.name,
        size: fileMeta.size,
        category: fileMeta.category,
        folderPath: fileMeta.folderPath,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      fileCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logFileDeleted(fileId, fileName, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.files',
      FILE_INTENTS.DELETED,
      {
        fileId,
        name: fileName,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      fileCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logFolderCreated(folder, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.files',
      FILE_INTENTS.FOLDER_CREATED,
      {
        path: folder.path,
        name: folder.name,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      fileCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logFolderDeleted(path, filesDeleted, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.files',
      FILE_INTENTS.FOLDER_DELETED,
      {
        path,
        filesDeleted: filesDeleted || 0,
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      fileCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

export function logFolderUpdated(path, updatedFields, parentCorr) {
  fireAndForget(async () => {
    const event = createEvent(
      'system.files',
      FILE_INTENTS.FOLDER_UPDATED,
      {
        path,
        fields: Object.keys(updatedFields || {}),
        parentCorr: parentCorr || undefined,
        timestamp: Date.now(),
      },
      fileCorrelation(parentCorr)
    )
    await storeEnvelope(event)
  })
}

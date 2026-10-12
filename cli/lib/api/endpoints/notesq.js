/**
 * 'notesq.*' endpoints — NotesQ (governed markdown notebook, Qortex layer),
 * proxied through the collector (services/collector/lib/notesq/api.js:
 * /api/v1/notesq/* -> quoxbrain /notesq/*, org + user resolved server-side).
 * No org segment in the URL — same shape as `inboxq.*`.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

const B = '/api/v1/notesq';

export const notesq = {
  'notesq.notes.list': { method: 'GET', service: 'collector', path: () => `${B}/notes`, tags: ['live-safe'] },
  'notesq.notes.get': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/notes/${id}`, tags: ['live-safe'] },
  'notesq.notes.create': { method: 'POST', service: 'collector', path: () => `${B}/notes`, tags: ['live-write'] },
  'notesq.notes.update': { method: 'PUT', service: 'collector', path: ({ id }) => `${B}/notes/${id}`, tags: ['live-write'] },
  'notesq.notes.delete': { method: 'DELETE', service: 'collector', path: ({ id }) => `${B}/notes/${id}`, tags: ['live-write'] },
  'notesq.facets': { method: 'GET', service: 'collector', path: () => `${B}/facets`, tags: ['live-safe'] },
  'notesq.notes.revisions': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/notes/${id}/revisions`, tags: ['live-safe'] },
  'notesq.notes.revision': { method: 'GET', service: 'collector', path: ({ id, rev }) => `${B}/notes/${id}/revisions/${rev}`, tags: ['live-safe'] },
  'notesq.notes.restore': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/notes/${id}/restore`, tags: ['live-write'] },
  'notesq.import': { method: 'POST', service: 'collector', path: () => `${B}/import`, tags: ['live-write'] },
  // AQ-9D P4: Action-Q item create (auth, org-scoped), used by `quox notes actions`.
  'notesq.actionq.create': { method: 'POST', service: 'auth', path: ({ orgId }) => `/api/orgs/${orgId}/actions`, tags: ['live-write'] },
  'notesq.templates.list': { method: 'GET', service: 'collector', path: () => `${B}/templates`, tags: ['live-safe'] },
  'notesq.notes.fromTemplate': { method: 'POST', service: 'collector', path: () => `${B}/notes/from-template`, tags: ['live-write'] },
  'notesq.schedules.list': { method: 'GET', service: 'collector', path: () => `${B}/schedules`, tags: ['live-safe'] },
  'notesq.schedules.create': { method: 'POST', service: 'collector', path: () => `${B}/schedules`, tags: ['live-write'] },
  'notesq.schedules.update': { method: 'PATCH', service: 'collector', path: ({ id }) => `${B}/schedules/${id}`, tags: ['live-write'] },
  'notesq.schedules.delete': { method: 'DELETE', service: 'collector', path: ({ id }) => `${B}/schedules/${id}`, tags: ['live-write'] },
  'notesq.batch.undo': { method: 'POST', service: 'collector', path: ({ batchId }) => `${B}/batches/${batchId}/undo`, tags: ['live-write'] },
  // AQ-9D P5: propose a note as a pending-review skill (dry_run in the body previews).
  'notesq.notes.proposeSkill': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/notes/${id}/propose-skill`, tags: ['live-write'] },
  'notesq.import.status': { method: 'GET', service: 'collector', path: ({ jobId }) => `${B}/import/${jobId}`, tags: ['live-safe'] },
  'notesq.notes.related': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/notes/${id}/related`, tags: ['live-safe'] },
  'notesq.notes.suggestions': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/notes/${id}/suggestions`, tags: ['live-safe'] },
  'notesq.health': { method: 'GET', service: 'collector', path: () => `${B}/health`, tags: ['live-safe'] },
  // Attachments live in the AUTH service org file store (namespace 'notesq'),
  // not behind the collector: notes only hold same-origin links to them.
  'notesq.files.upload': { method: 'POST', service: 'auth', path: ({ orgId }) => `/api/orgs/${orgId}/files/upload`, tags: ['live-write'] },
  'notesq.files.meta': { method: 'GET', service: 'auth', path: ({ orgId, fileId }) => `/api/orgs/${orgId}/files/${fileId}/meta`, tags: ['live-safe'] },
  'notesq.files.get': { method: 'GET', service: 'auth', path: ({ orgId, fileId }) => `/api/orgs/${orgId}/files/${fileId}`, tags: ['live-safe'] },
};

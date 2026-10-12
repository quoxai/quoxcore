/**
 * 'contactsq.*' endpoints — ContactsQ (governed contacts for people and agents),
 * served by the collector at /api/v1/contactsq/*. Org is resolved server-side
 * from auth; no org segment in the URL (same shape as `notesq.*`).
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

const B = '/api/v1/contactsq';

export const contactsq = {
  'contactsq.contacts.create': { method: 'POST', service: 'collector', path: () => `${B}/contacts`, tags: ['live-write'] },
  'contactsq.contacts.list': { method: 'GET', service: 'collector', path: () => `${B}/contacts`, tags: ['live-safe'] },
  'contactsq.contacts.get': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/contacts/${id}`, tags: ['live-safe'] },
  'contactsq.contacts.update': { method: 'PUT', service: 'collector', path: ({ id }) => `${B}/contacts/${id}`, tags: ['live-write'] },
  'contactsq.contacts.archive': { method: 'DELETE', service: 'collector', path: ({ id }) => `${B}/contacts/${id}`, tags: ['live-write'] },
  'contactsq.identifiers.add': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/identifiers`, tags: ['live-write'] },
  'contactsq.resolve': { method: 'POST', service: 'collector', path: () => `${B}/resolve`, tags: ['live-safe'] },
  'contactsq.suppressions.create': { method: 'POST', service: 'collector', path: () => `${B}/suppressions`, tags: ['live-write'] },
  'contactsq.suppressions.check': { method: 'POST', service: 'collector', path: () => `${B}/suppressions/check`, tags: ['live-safe'] },
  'contactsq.search': { method: 'GET', service: 'collector', path: () => `${B}/search`, tags: ['live-safe'] },
  'contactsq.focus.get': { method: 'GET', service: 'collector', path: () => `${B}/focus`, tags: ['live-safe'] },
  'contactsq.leases.create': { method: 'POST', service: 'collector', path: () => `${B}/leases`, tags: ['live-write'] },
  'contactsq.leases.list': { method: 'GET', service: 'collector', path: () => `${B}/leases`, tags: ['live-safe'] },
  'contactsq.leases.revoke': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/leases/${id}/revoke`, tags: ['live-write'] },
  'contactsq.grants.list': { method: 'GET', service: 'collector', path: () => `${B}/grants`, tags: ['live-safe'] },
  'contactsq.grants.create': { method: 'POST', service: 'collector', path: () => `${B}/grants`, tags: ['live-write'] },
  'contactsq.grants.revoke': { method: 'DELETE', service: 'collector', path: ({ id }) => `${B}/grants/${id}`, tags: ['live-write'] },
  'contactsq.settings.get': { method: 'GET', service: 'collector', path: () => `${B}/settings`, tags: ['live-safe'] },
  'contactsq.contacts.erase': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/erase`, tags: ['live-write'] },
  'contactsq.contacts.dsar': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/dsar`, tags: ['live-safe'] },
  'contactsq.contacts.noticeSent': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/notice-sent`, tags: ['live-write'] },
  'contactsq.erasures.certificate': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/erasures/${id}/certificate`, tags: ['live-safe'] },
  'contactsq.retention.status': { method: 'GET', service: 'collector', path: () => `${B}/retention/status`, tags: ['live-safe'] },
  'contactsq.retention.run': { method: 'POST', service: 'collector', path: () => `${B}/retention/run`, tags: ['live-write'] },
  'contactsq.compliance': { method: 'GET', service: 'collector', path: () => `${B}/compliance`, tags: ['live-safe'] },
  'contactsq.processingRecord': { method: 'GET', service: 'collector', path: () => `${B}/processing-record`, tags: ['live-safe'] },
  'contactsq.admin.rewrap': { method: 'POST', service: 'collector', path: () => `${B}/admin/rewrap`, tags: ['live-write'] },
  'contactsq.admin.reindex': { method: 'POST', service: 'collector', path: () => `${B}/admin/reindex`, tags: ['live-write'] },
  'contactsq.admin.strictNamesApply': { method: 'POST', service: 'collector', path: () => `${B}/admin/strict-names/apply`, tags: ['live-write'] },
  'contactsq.suppressions.tombstoneLift': { method: 'POST', service: 'collector', path: () => `${B}/suppressions/tombstones/lift`, tags: ['live-write'] },
  // P5: import (multipart), merge / unmerge, duplicates, facts.
  'contactsq.import': { method: 'POST', service: 'collector', path: () => `${B}/import`, tags: ['live-write'] },
  'contactsq.imports.list': { method: 'GET', service: 'collector', path: () => `${B}/imports`, tags: ['live-safe'] },
  'contactsq.duplicates': { method: 'GET', service: 'collector', path: () => `${B}/duplicates`, tags: ['live-safe'] },
  'contactsq.contacts.merge': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/merge`, tags: ['live-write'] },
  'contactsq.merges.list': { method: 'GET', service: 'collector', path: () => `${B}/merges`, tags: ['live-safe'] },
  'contactsq.merges.undo': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/merges/${id}/undo`, tags: ['live-write'] },
  'contactsq.facts.list': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/facts`, tags: ['live-safe'] },
  'contactsq.facts.add': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/facts`, tags: ['live-write'] },
  'contactsq.facts.update': { method: 'PUT', service: 'collector', path: ({ id, factId }) => `${B}/contacts/${id}/facts/${factId}`, tags: ['live-write'] },
  // P7: CardDAV pull sync (one way, org admin, human only).
  'contactsq.sync.list': { method: 'GET', service: 'collector', path: () => `${B}/sync/sources`, tags: ['live-safe'] },
  'contactsq.sync.add': { method: 'POST', service: 'collector', path: () => `${B}/sync/sources`, tags: ['live-write'] },
  'contactsq.sync.update': { method: 'PATCH', service: 'collector', path: ({ id }) => `${B}/sync/sources/${id}`, tags: ['live-write'] },
  'contactsq.sync.run': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/sync/sources/${id}/run`, tags: ['live-write'] },
  'contactsq.sync.remove': { method: 'DELETE', service: 'collector', path: ({ id }) => `${B}/sync/sources/${id}`, tags: ['live-write'] },
  // P8a: morning brief, timeline / touchpoints / policy (selftest), handoff notes.
  'contactsq.brief': { method: 'GET', service: 'collector', path: () => `${B}/brief`, tags: ['live-safe'] },
  'contactsq.timeline': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/timeline`, tags: ['live-safe'] },
  'contactsq.touchpoints.add': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/touchpoints`, tags: ['live-write'] },
  'contactsq.policy': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/policy`, tags: ['live-safe'] },
  'contactsq.handoffs.add': { method: 'POST', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/handoffs` },
  'contactsq.handoffs': { method: 'GET', service: 'collector', path: ({ id }) => `${B}/contacts/${id}/handoffs`, tags: ['live-safe'] },
  'contactsq.settings.update': { method: 'PUT', service: 'collector', path: () => `${B}/settings`, tags: ['live-write'] },
};

/**
 * 'telephony.*' endpoints: per-number org binding for QuoxVoice (quox#695).
 * Collector routes: GET/PUT/DELETE /api/v1/telephony/numbers[/:number],
 * org-scoped (org_id query), PUT/DELETE are org-admin only.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const telephony = {
  'telephony.numbers.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/telephony/numbers`,
    tags: ['live-safe'],
  },
  'telephony.numbers.set': {
    method: 'PUT',
    service: 'collector',
    path: ({ number }) => `/api/v1/telephony/numbers/${encodeURIComponent(number)}`,
    tags: ['live-write'],
  },
  'telephony.numbers.remove': {
    method: 'DELETE',
    service: 'collector',
    path: ({ number }) => `/api/v1/telephony/numbers/${encodeURIComponent(number)}`,
    tags: ['live-write'],
  },
  'telephony.identities.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/telephony/identities`,
    tags: ['live-safe'],
  },
  'telephony.identities.set': {
    method: 'PUT',
    service: 'collector',
    path: ({ number }) => `/api/v1/telephony/identities/${encodeURIComponent(number)}`,
    tags: ['live-write'],
  },
  'telephony.identities.remove': {
    method: 'DELETE',
    service: 'collector',
    path: ({ number }) => `/api/v1/telephony/identities/${encodeURIComponent(number)}`,
    tags: ['live-write'],
  },
};

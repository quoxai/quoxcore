/**
 * 'router.*' endpoints: RouterOS identity (quoxai/quox#1236).
 * Collector route: GET /api/v1/mikrotik/tls-fingerprint (requireServiceOrUserAuth).
 * Handshake only: the collector reads the certificate the configured router
 * endpoint presents and sends NO credentials. Nothing is stored or pinned.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const router = {
  'router.tlsFingerprint': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/mikrotik/tls-fingerprint`,
    tags: ['live-safe'],
  },
};

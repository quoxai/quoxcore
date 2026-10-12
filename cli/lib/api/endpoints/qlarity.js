/**
 * 'qlarity.*' endpoints — Qlarity, governed browser inspection for dev servers
 * (DEVSUITE-CLARIFY). Proxied through the collector
 * (services/collector/server.js: app.all('/api/v1/qlarity/*', ...) rewrites to
 * QLARITY_URL/api/v1/*, port 3109).
 *
 * Unlike the quoxplan proxy, this one is org-resolved and licence-gated from
 * its first commit, so every call here can return 403 for an unlicensed org.
 * That is the gate working, not a fault, and the command layer says so.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const qlarity = {
  'qlarity.health': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/qlarity/health`,
    tags: ['live-safe'],
  },
  'qlarity.inspectors.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/qlarity/inspectors`,
    tags: ['live-safe'],
  },
  // NO-ENV-ONLY-CONFIG: the per-ORG allowlist a customer can actually manage.
  // Distinct from 'qlarity.allowlist' above, which reports the install-wide
  // env-var list the operator set. These are collector-owned routes, not
  // proxied to the QLarity service, hence the different path prefix.
  'qlarity.orgAllowlist.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/qlarity-allowlist`,
    tags: ['live-safe'],
  },
  'qlarity.orgAllowlist.add': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/qlarity-allowlist`,
  },
  'qlarity.orgAllowlist.remove': {
    method: 'DELETE',
    service: 'collector',
    path: ({ origin }) => `/api/v1/qlarity-allowlist?origin=${encodeURIComponent(origin)}`,
  },
  'qlarity.allowlist': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/qlarity/allowlist`,
    tags: ['live-safe'],
  },
  'qlarity.sessions.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/qlarity/sessions`,
    tags: ['live-safe'],
  },
  'qlarity.session.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/qlarity/sessions`,
  },
  'qlarity.session.close': {
    method: 'DELETE',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}`,
  },
  'qlarity.session.open': {
    method: 'POST',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/open`,
  },
  'qlarity.session.inspect': {
    method: 'POST',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/inspect`,
  },
  'qlarity.session.blocked': {
    method: 'GET',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/blocked`,
    tags: ['live-safe'],
  },
  'qlarity.session.console': {
    method: 'GET',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/console`,
    tags: ['live-safe'],
  },
  'qlarity.session.network': {
    method: 'GET',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/network`,
    tags: ['live-safe'],
  },
  'qlarity.session.screenshot': {
    method: 'POST',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/screenshot`,
  },
  /** Always files an approval; never executes inline. */
  'qlarity.session.eval': {
    method: 'POST',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/eval`,
  },
  /**
   * Governed authed-session bootstrap (issue #15). Body carries
   * `credential_id` (a stored `browser_login` vault credential), never a raw
   * password — the collector resolves it server-side and forwards the
   * resolved fields to qlarity on the internal network only. See
   * server.js's resolveQlarityLoginCredential.
   */
  'qlarity.session.login': {
    method: 'POST',
    service: 'collector',
    path: (p) => `/api/v1/qlarity/sessions/${p.sessionId}/login`,
  },
};

export default qlarity;

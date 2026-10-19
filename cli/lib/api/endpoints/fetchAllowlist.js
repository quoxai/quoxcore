/**
 * 'fetchAllowlist.*' endpoints: the per-org URL-prefix allowlist behind the governed
 * agent fetch tool (web_fetch_allowlisted, quox#1171). Collector-owned routes
 * (services/collector/lib/agentFetchAllowlistRoutes.js). Writes are human org
 * admin only on the server.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const fetchAllowlist = {
  'fetchAllowlist.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/fetch-allowlist`,
    tags: ['live-safe'],
  },
  'fetchAllowlist.add': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/fetch-allowlist`,
  },
  'fetchAllowlist.remove': {
    method: 'DELETE',
    service: 'collector',
    path: ({ prefix }) => `/api/v1/fetch-allowlist?url_prefix=${encodeURIComponent(prefix)}`,
  },
};

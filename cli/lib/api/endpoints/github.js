/**
 * 'github.*' endpoints — the collector's governed GitHub proxy
 * (services/collector/server.js mounts routes/github-proxy.js at /github,
 * user-authed + github plugin entitlement; credentials resolve from the
 * org vault server-side, never client-side).
 *
 * First fragment added for quox#478 (gripe --yes deterministic fallback).
 * The full `quox github` command group is tracked separately (quox#566).
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const github = {
  'github.issue.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/github/issues`,
  },
};

export default github;

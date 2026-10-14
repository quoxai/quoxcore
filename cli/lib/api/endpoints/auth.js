/**
 * 'auth.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const auth = {
  'auth.me.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/auth/me`,
    tags: ['live-safe'],
  },
  // QuoxSound: the CLI writes the same server-side `soundProfile` preference
  // the dashboard does (PATCH merges top-level preference namespaces).
  'auth.me.update': {
    method: 'PATCH',
    service: 'auth',
    path: () => `/api/auth/me`,
    tags: ['live-write'],
  },
  // fleet #390: PATCH /me/password already existed and worked, but nothing
  // in the CLI exposed it, so rotating your own password meant hand-rolling
  // a curl with a bearer token.
  'auth.me.password': {
    method: 'PATCH',
    service: 'auth',
    path: () => `/api/auth/me/password`,
    tags: ['live-write'],
  },
  'auth.signup': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/auth/signup`,
    tags: ['live-write'],
  },
  // QUOXON-C2c: one-time dashboard sign-in link (10 min, single-use, user+org bound).
  'auth.login-link': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/auth/login-link`,
    tags: ['live-write'],
  },
  'auth.switch-org': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/auth/switch-org`,
    tags: ['live-write'],
  },
};

/**
 * 'users.*' endpoints — extracted from the former monolithic
 * cli/lib/api/endpoints.js as part of the per-domain fragment split.
 * See cli/lib/api/endpoints/index.js for aggregation + the fragment convention.
 */

export const users = {
  'users.me.notification-channels.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/users/me/notification-channels`,
    tags: ['live-safe'],
  },
  'users.me.notification-channels.update': {
    method: 'PUT',
    service: 'auth',
    path: ({ type }) => `/api/users/me/notification-channels/${type}`,
    tags: ['live-write'],
  },
};

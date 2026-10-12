/**
 * 'invites.*' endpoints (GRIPE-712): caller-scoped invitations.
 */

export const invites = {
  // GRIPE-712: caller-scoped invitations, matched server-side on verified email.
  'invites.mine.list': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/invites/mine`,
    tags: ['live-safe'],
  },
  'invites.mine.accept': {
    method: 'POST',
    service: 'auth',
    path: ({ inviteId }) => `/api/invites/mine/${encodeURIComponent(inviteId)}/accept`,
    tags: ['live-write'],
  },
};

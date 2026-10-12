/**
 * 'quoxchat.*' endpoints — QuoxChat website-widget management (auth service,
 * services/auth/routes/widgets.js, mounted at plain `/api`, requireOrgMembership).
 *
 * Covers the QuoxChat Pro operator availability surface: `operator_online` and
 * `office_hours_json` live on the widget row and are toggled via the widget
 * PATCH route (plan-gated fields return 402 `plan_upgrade_required`).
 *
 * Live-support desk parity (QuoxChat Pro /live-support view): conversations
 * list/transcript come from services/auth/routes/widgets.js; operator-reply
 * comes from the separate org-authed router in
 * services/auth/routes/internal-widget-matrix.js (widgetConversationOrgRouter,
 * mounted at plain `/api` in server.js), which derives sender identity
 * server-side and 409s when the conversation isn't `handed_off`.
 */

export const quoxchat = {
  'quoxchat.widgets.get': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, widgetId }) => `/api/orgs/${orgId}/widgets/${widgetId}`,
    tags: ['live-safe'],
  },
  'quoxchat.widgets.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId }) => `/api/orgs/${orgId}/widgets`,
    tags: ['live-safe'],
  },
  'quoxchat.widgets.update': {
    method: 'PATCH',
    service: 'auth',
    path: ({ orgId, widgetId }) => `/api/orgs/${orgId}/widgets/${widgetId}`,
    tags: ['live-write'],
  },
  'quoxchat.conversations.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, widgetId }) => `/api/orgs/${orgId}/widgets/${widgetId}/conversations`,
    tags: ['live-safe'],
  },
  'quoxchat.conversations.messages.list': {
    method: 'GET',
    service: 'auth',
    path: ({ orgId, widgetId, conversationId }) => `/api/orgs/${orgId}/widgets/${widgetId}/conversations/${conversationId}/messages`,
    tags: ['live-safe'],
  },
  'quoxchat.conversations.reply.create': {
    method: 'POST',
    service: 'auth',
    path: ({ orgId, widgetId, conversationId }) => `/api/orgs/${orgId}/widgets/${widgetId}/conversations/${conversationId}/operator-reply`,
    tags: ['live-write'],
  },
};

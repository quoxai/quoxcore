/**
 * 'tg.*' endpoints — Telegram Pro (QTG-PRO P0), collector-direct
 * (services/collector/server.js), no org segment in the URL — same shape
 * as `quoxbox.*`/`quoxplan.*`/`traces.*`/`aee.*`/`mon.*`. Every route below
 * is `requireServiceOrUserAuth()` server-side (X-Service-Key /
 * INTERNAL_SERVICE_KEY or a user JWT), not org-scoped.
 *
 * - tg.status: GET /telegram-pro/onboarding/status (server.js, thin wrapper
 *   around services/collector/lib/telegramPro/onboardingService.js
 *   getOnboardingStatus()). Optional ?bot_id= query param.
 * - tg.bindOwner: POST /telegram-pro/onboarding/bind-owner (onboardingService
 *   bindOwner()) — 409 when a primary owner binding already exists for the
 *   bot/chat, body carries the existing binding.
 * - tg.leases.list: GET /session-leases (sessionLeaseStore.list()) — terminal
 *   identity leases for parallel Claude Code sessions on this dev box.
 * - tg.webhook.info: GET /webhook/telegram/info — bot_id is NOT yet honored
 *   server-side (single-bot lookup only); passed through here so the CLI is
 *   forward-compatible once the backend adds per-bot support.
 * - tg.webhook.setup: POST /webhook/telegram/setup — registers the webhook
 *   with Telegram and persists config via the auth service.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const tg = {
  'tg.status': {
    method: 'GET',
    service: 'collector',
    path: () => `/telegram-pro/onboarding/status`,
    tags: ['live-safe'],
  },
  'tg.bindOwner': {
    method: 'POST',
    service: 'collector',
    path: () => `/telegram-pro/onboarding/bind-owner`,
    tags: ['live-write'],
  },
  'tg.leases.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/session-leases`,
    tags: ['live-safe'],
  },
  'tg.webhook.info': {
    method: 'GET',
    service: 'collector',
    path: () => `/webhook/telegram/info`,
    tags: ['live-safe'],
  },
  'tg.webhook.setup': {
    method: 'POST',
    service: 'collector',
    path: () => `/webhook/telegram/setup`,
    tags: ['live-write'],
  },
};

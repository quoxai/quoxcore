/**
 * 'stepup.*' endpoints: QUOXON-STEPUP human step-up PIN (auth service routes/stepUp.js).
 * There is deliberately NO endpoint here that sets or changes the PIN: that is a dashboard-only act
 * (browser session plus fresh password). The CLI can read status and verify, nothing else.
 */

export const stepup = {
  'stepup.status': {
    method: 'GET',
    service: 'auth',
    path: () => `/api/auth/me/step-up-pin`,
    tags: ['live-safe'],
  },
  'stepup.verify': {
    method: 'POST',
    service: 'auth',
    path: () => `/api/auth/me/step-up`,
    tags: ['live-write'],
  },
};

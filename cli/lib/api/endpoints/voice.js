/**
 * 'voice.*' endpoints: QuoxVoice Console call history + aggregate insights
 * (org-scoped reads). Split out of telephony.js so every key matches its
 * fragment's domain.
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const voice = {
  'voice.calls.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/voice/calls`,
    tags: ['live-safe'],
  },
  'voice.insights.get': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/voice/insights`,
    tags: ['live-safe'],
  },
};

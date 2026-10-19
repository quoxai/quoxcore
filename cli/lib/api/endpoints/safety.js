/**
 * 'safety.*' endpoints — kill switch / DEFCON (quox#503/#505/#506/#507).
 * Collector routes/safetyGate.js, mounted at /api/v1/safety behind
 * requireServiceOrUserAuth(); mutations additionally require a HUMAN admin
 * server-side (requireHumanAdmin rejects agent/resident/service tokens BY
 * DESIGN — an agent must never flip its own kill switch).
 */

export const safety = {
  'safety.status': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/safety/status`,
    tags: ['live-safe'],
  },
  'safety.gate': {
    method: 'GET',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/safety/gate?agent_id=${encodeURIComponent(agentId)}`,
    tags: ['live-safe'],
  },
  'safety.estop': {
    method: 'POST',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/safety/kill-switch/${encodeURIComponent(agentId)}`,
    tags: ['live-write'],
  },
  'safety.release': {
    method: 'DELETE',
    service: 'collector',
    path: ({ agentId }) => `/api/v1/safety/kill-switch/${encodeURIComponent(agentId)}`,
    tags: ['live-write'],
  },
  'safety.defcon': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/safety/defcon`,
    tags: ['live-write'],
  },
  'safety.history': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/safety/history`,
    tags: ['live-safe'],
  },
  // QUOXON-STEPUP: a human with a live step-up token overrides ONE blocked action (collector routes/overrides.js).
  'safety.override': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/overrides`,
    tags: ['live-write'],
  },
};

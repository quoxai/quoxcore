/**
 * 'agent-schedules.*' endpoints (tasks service, services/tasks/server.js "agent-schedules" routes).
 * A cron-driven task for an agent: the scheduler creates an objective and runs the prompt each tick,
 * escalating to the owner's approvals inbox per the escalation policy. /watch (quoxon) stands on this.
 */

export const agentSchedules = {
  'agent-schedules.create': {
    method: 'POST',
    service: 'tasks',
    path: () => `/api/agent-schedules`,
    tags: ['live-write'],
  },
  'agent-schedules.list': {
    method: 'GET',
    service: 'tasks',
    path: () => `/api/agent-schedules`,
    tags: ['live-safe'],
  },
  'agent-schedules.delete': {
    method: 'DELETE',
    service: 'tasks',
    path: ({ id }) => `/api/agent-schedules/${encodeURIComponent(id)}`,
    tags: ['live-write'],
  },
};

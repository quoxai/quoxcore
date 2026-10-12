/**
 * 'quoxplan.*' endpoints — QuoxPlan (the productised planning suite,
 * STREAM_QUOXPLAN_PLAN.md), proxied through the collector
 * (services/collector/server.js: app.all('/api/v1/quoxplan/*', ...) rewrites
 * to QUOXPLAN_URL/api/v1/*, port 3107). Collector-direct, no org segment in
 * the URL — same shape as `quoxbox.*`/`traces.*`/`aee.*`/`mon.*`: the proxy
 * applies requireServiceOrUserAuth() server-side, no per-org scoping yet
 * (QuoxPlan is dummy-data-only until the P5 multi-tenant phase).
 *
 * See cli/lib/api/endpoints/index.js for the fragment convention.
 */

export const quoxplan = {
  'quoxplan.roadmaps.list': {
    method: 'GET',
    service: 'collector',
    path: () => `/api/v1/quoxplan/roadmaps`,
    tags: ['live-safe'],
  },
  // Roadmap-create primitive (ONBOARD step 0): there was no `roadmap create`
  // verb, only list. The wizard needs a governed way to give a fresh tenant
  // its own roadmap. Collector proxies POST /api/v1/quoxplan/roadmaps to the
  // QuoxPlan server, same governed path as every other quoxplan.* entry.
  'quoxplan.roadmaps.create': {
    method: 'POST',
    service: 'collector',
    path: () => `/api/v1/quoxplan/roadmaps`,
    tags: ['live-write'],
  },
  'quoxplan.roadmap.streams.list': {
    method: 'GET',
    service: 'collector',
    path: ({ roadmapId }) => `/api/v1/quoxplan/roadmaps/${roadmapId}/streams`,
    tags: ['live-safe'],
  },
  'quoxplan.roadmap.timeline.get': {
    method: 'GET',
    service: 'collector',
    path: ({ roadmapId }) => `/api/v1/quoxplan/roadmaps/${roadmapId}/timeline`,
    tags: ['live-safe'],
  },
  'quoxplan.roadmap.reprioritise': {
    method: 'POST',
    service: 'collector',
    path: ({ roadmapId }) => `/api/v1/quoxplan/roadmaps/${roadmapId}/reprioritise`,
    tags: ['live-write'],
  },
  'quoxplan.roadmap.streams.create': {
    method: 'POST',
    service: 'collector',
    path: ({ roadmapId }) => `/api/v1/quoxplan/roadmaps/${roadmapId}/streams`,
    tags: ['live-write'],
  },
  'quoxplan.roadmap.export.get': {
    method: 'GET',
    service: 'collector',
    path: ({ roadmapId }) => `/api/v1/quoxplan/roadmaps/${roadmapId}/export`,
    tags: ['live-safe'],
  },
  'quoxplan.stream.get': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/quoxplan/streams/${id}`,
    tags: ['live-safe'],
  },
  'quoxplan.stream.update': {
    method: 'PATCH',
    service: 'collector',
    path: ({ id }) => `/api/v1/quoxplan/streams/${id}`,
    tags: ['live-write'],
  },
  'quoxplan.stream.rename': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/quoxplan/streams/${id}/rename`,
    tags: ['live-write'],
  },
  'quoxplan.stream.notes.create': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/quoxplan/streams/${id}/notes`,
    tags: ['live-write'],
  },
  'quoxplan.stream.phases.create': {
    method: 'POST',
    service: 'collector',
    path: ({ id }) => `/api/v1/quoxplan/streams/${id}/phases`,
    tags: ['live-write'],
  },
  'quoxplan.phase.update': {
    method: 'PATCH',
    service: 'collector',
    path: ({ phaseId }) => `/api/v1/quoxplan/phases/${phaseId}`,
    tags: ['live-write'],
  },
  'quoxplan.phase.delete': {
    method: 'DELETE',
    service: 'collector',
    path: ({ phaseId }) => `/api/v1/quoxplan/phases/${phaseId}`,
    tags: ['live-write'],
  },
  'quoxplan.stream.plan.put': {
    method: 'PUT',
    service: 'collector',
    path: ({ id }) => `/api/v1/quoxplan/streams/${id}/plan`,
    tags: ['live-write'],
  },
  'quoxplan.stream.plan.versions.list': {
    method: 'GET',
    service: 'collector',
    path: ({ id }) => `/api/v1/quoxplan/streams/${id}/plan/versions`,
    tags: ['live-safe'],
  },
};

/**
 * 'engine.*' endpoints: tasks-service implant stats (QuoxReflect / QuoxLearn / QuoxInsight).
 * Read-only, org-scoped from the caller's auth (tasks server.js /api/engine/<implant>/stats).
 * Used by QUOXON /observers for what Quox already records about its own learning.
 */

export const engine = {
  'engine.reflect.stats': { method: 'GET', service: 'tasks', path: () => `/api/engine/reflect/stats`, tags: ['live-safe'] },
  'engine.learn.stats': { method: 'GET', service: 'tasks', path: () => `/api/engine/learn/stats`, tags: ['live-safe'] },
  'engine.insight.stats': { method: 'GET', service: 'tasks', path: () => `/api/engine/insight/stats`, tags: ['live-safe'] },
};

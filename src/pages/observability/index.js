/**
 * Observability Pages — SET-IA Phase 2.
 *
 * Instance-wide telemetry surface peered with /admin and /settings.
 * Pages migrated from /admin/* in this phase:
 *   AdminOverview     → Overview      (instance stats)
 *   AdminServices     → Health        (service health)
 *   AdminLogs         → Logs          (system logs)
 *   AdminErrorReports → ErrorReports  (frontend + API errors)
 *   AdminFeedback     → Feedback      (user feedback)
 *
 * Audit Trail page is new — placeholder for Phase 5+ work that
 * consolidates org + instance audit views.
 */

export { default as ObservabilityLayout } from './ObservabilityLayout'
export { default as Overview } from './Overview'
export { default as Health } from './Health'
export { default as Logs } from './Logs'
export { default as ErrorReports } from './ErrorReports'
export { default as Feedback } from './Feedback'
export { default as AuditTrail } from './AuditTrail'

/**
 * Smart Router Components
 * Visibility and control components for the Smart Router system
 */

// Dashboard and insights
export { RouterInsights, RouterHealthCard } from './RouterInsights'

// Decision explanation
export { RouterDecisionExplainer, RouterBadge } from './RouterDecisionExplainer'

// Configuration
export { RouterSettings } from './RouterSettings'

// Pattern testing
export { PatternTester } from './PatternTester'

// User feedback
export { RouterFeedback, RouterFeedbackInline, recordFeedback, getFeedbackStats, resetFeedback } from './RouterFeedback'

// Audit logging
export { RouterAuditLog, logRouterDecision, clearAuditLog, exportAuditLogCSV } from './RouterAuditLog'

// Education and onboarding
export {
  RouterTooltip,
  RouterFirstTimeGuide,
  RouterFeatureHighlight,
  RouterHelpPanel,
  markTipViewed,
  isFirstVisit,
  dismissEducation,
  resetEducation
} from './RouterEducation'

// Transparency reporting
export { TransparencyReport, TransparencyReportCard, recordDailySnapshot } from './TransparencyReport'

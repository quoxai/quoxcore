/**
 * Orchestration UI Components
 *
 * Stream AT Phase AT-5: Visual components for QuoxEngine orchestration,
 * team topology, agent performance, and execution monitoring.
 *
 * Adapted from quox-remotion reference components. All Remotion deps removed.
 * Uses dashboard CSS variables and design system.
 */

// Must-have (Batch 1)
export { default as TopologyBadge } from './TopologyBadge'
export { default as SuccessRateRing } from './SuccessRateRing'
export { default as RouterDecisionChip } from './RouterDecisionChip'
export { default as FallbackBanner } from './FallbackBanner'
export { default as CircuitBreakerAlert } from './CircuitBreakerAlert'
export { default as TeamCompositionStrip } from './TeamCompositionStrip'

// High-value (Batch 2)
export { default as AgentActivityPulse } from './AgentActivityPulse'
export { default as AgentLeaderboard } from './AgentLeaderboard'
export { default as PipelineStageIndicator } from './PipelineStageIndicator'
export { default as TaskWaterfallChart } from './TaskWaterfallChart'

// Nice-to-have (Batch 3)
export { default as LiveTokenBurnGauge } from './LiveTokenBurnGauge'
export { default as HeartbeatRibbon } from './HeartbeatRibbon'
export { default as CostBreakdownBar } from './CostBreakdownBar'
export { default as PerformanceTrendLine } from './PerformanceTrendLine'
export { default as DelegationFlowDiagram } from './DelegationFlowDiagram'

// Live execution feedback (Batch A)
export { default as CommandStream } from './CommandStream'
export { default as NotificationToast, ToastContainer } from './NotificationToast'

// Library adapts (EX-4)
export { default as TopologyMiniMap } from './TopologyMiniMap'
export { default as EmptyState } from './EmptyState'

// Gauge cluster (adapted from quox-remotion)
export { default as GaugeCluster } from './GaugeCluster'

// Swimlane diagram (adapted from quox-remotion)
export { default as SwimlaneDiagram } from './SwimlaneDiagram'

// HITL + execution audit trail (adapted from quox-remotion)
export { default as AuditTrail } from './AuditTrail'

// EX-4 Batch 2: Adapted from quox-remotion library
export { default as ExecutionTimeline } from './ExecutionTimeline'
export { default as StepIndicator } from './StepIndicator'
export { default as InboxFeed } from './InboxFeed'
export { default as SLACountdown } from './SLACountdown'

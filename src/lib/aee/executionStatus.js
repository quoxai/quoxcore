/**
 * Shared execution status config.
 *
 * Single source of truth for status labels + badge colors used across:
 * - ExecutionDetailView (status badge in the metadata card)
 * - WorkflowsView running-now panel (per-row status indicator)
 * - Any future surface that renders an execution status
 *
 * AEE-FULL Gap 4 adds 'cancelled' with amber color, visually distinct from
 * red 'failed' (different terminal state — cancellation is operator-driven,
 * failure is runtime error).
 */

export const EXECUTION_STATUS_CONFIG = {
  running: {
    label: 'Running',
    color: 'var(--accent-yellow)',
    bgClass: 'execution-detail__status-badge--running',
  },
  completed: {
    label: 'Completed',
    color: 'var(--accent-green)',
    bgClass: 'execution-detail__status-badge--completed',
  },
  failed: {
    label: 'Failed',
    color: 'var(--color-primary)',
    bgClass: 'execution-detail__status-badge--failed',
  },
  waiting_approval: {
    label: 'Waiting Approval',
    color: 'var(--accent-purple)',
    bgClass: 'execution-detail__status-badge--waiting',
  },
  // AEE-FULL Gap 4: cancelled is amber (--color-warning, #f59e0b),
  // distinct from red 'failed'. Terminal state set by operator action,
  // not runtime error.
  cancelled: {
    label: 'Cancelled',
    color: 'var(--color-warning, #f59e0b)',
    bgClass: 'execution-detail__status-badge--cancelled',
  },
}

/**
 * @param {string} status
 * @returns {{ label: string, color: string, bgClass: string }}
 */
export function getExecutionStatusConfig(status) {
  return EXECUTION_STATUS_CONFIG[status] || {
    label: status || 'Unknown',
    color: 'var(--text-secondary)',
    bgClass: 'execution-detail__status-badge--unknown',
  }
}

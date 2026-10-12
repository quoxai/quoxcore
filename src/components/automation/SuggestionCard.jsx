/**
 * SuggestionCard — P10.I-3 Quox Brain
 *
 * Renders a single proactive suggestion card.
 * Uses qx-card / qx-pill / qx-btn glass design tokens exclusively.
 * No per-component CSS.
 *
 * Props:
 *   suggestion   { id, score, payload }
 *   onDismiss    (suggestionId: string) => void
 *   onAction     optional override for action handler (used in tests)
 */

import { useNavigate } from 'react-router-dom'

// ── Rule config ────────────────────────────────────────────────────────────

function buildConfig(suggestion) {
  const { id, payload = {} } = suggestion

  switch (id) {
    case 'usage-frequency-crystallise':
      return {
        category: 'Optimise',
        categoryVariant: 'qx-pill--info',
        body: (
          <>
            You ran <em>{payload.name}</em>{' '}
            <strong>{payload.count} times</strong> this week — crystallise it{' '}
            (<strong>{payload.costSaved}</strong>/run saved)
          </>
        ),
        actionLabel: 'Crystallise',
        // Opens crystal promote — navigate to crystals library with promote action
        getActionRoute: () => `/crystals/library?id=&workflow=${payload.workflowId}&action=promote`,
      }

    case 'unused-agent':
      return {
        category: 'Cleanup',
        categoryVariant: 'qx-pill--degraded',
        body: (
          <>
            Agent <strong>{payload.agentName}</strong> unused for 30 days — archive?
          </>
        ),
        actionLabel: 'Archive',
        getActionRoute: () => `/agents/${payload.agentId}?action=archive`,
      }

    case 'failing-workflow':
      return {
        category: 'Fix',
        categoryVariant: 'qx-pill--critical',
        body: (
          <>
            Workflow <em>{payload.name}</em> failed{' '}
            <strong>{payload.failCount}</strong> of last 5 — review the catch branch
          </>
        ),
        actionLabel: 'Review',
        getActionRoute: () => `/executions?workflow=${payload.workflowId}&filter=failed`,
      }

    case 'objective-stuck':
      return {
        category: 'Momentum',
        categoryVariant: 'qx-pill--degraded',
        body: (
          <>
            Objective <em>{payload.title}</em> hasn't moved in{' '}
            <strong>{payload.days}</strong> days — pin it or close it?
          </>
        ),
        actionLabel: 'View',
        getActionRoute: () => `/objectives/${payload.objectiveId}`,
      }

    case 'tool-cost-spike':
      return {
        category: 'Cost',
        categoryVariant: 'qx-pill--critical',
        body: (
          <>
            <em>{payload.toolName}</em> cost is{' '}
            <strong>{payload.multiple}×</strong> normal today — investigate?
          </>
        ),
        actionLabel: 'Investigate',
        getActionRoute: () => `/triggers?tab=costs&workflow=${payload.workflowId}`,
      }

    case 'crystal-promotion-ready':
      return {
        category: 'Crystal',
        categoryVariant: 'qx-pill--online',
        body: (
          <>
            <em>{payload.name}</em> Crystal is{' '}
            <strong>1 successful run from canonical</strong> — schedule a final check?
          </>
        ),
        actionLabel: 'Schedule',
        getActionRoute: () => `/crystals/library?id=${payload.crystalId}&action=promote`,
      }

    default:
      return {
        category: 'Suggestion',
        categoryVariant: 'qx-pill--info',
        body: <span>A new suggestion is available.</span>,
        actionLabel: 'View',
        getActionRoute: () => '/',
      }
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export default function SuggestionCard({ suggestion, onDismiss, onAction }) {
  const navigate = useNavigate()
  const config = buildConfig(suggestion)

  function handleAction() {
    if (onAction) {
      onAction(suggestion)
      return
    }
    navigate(config.getActionRoute())
  }

  function handleDismiss() {
    if (onDismiss) onDismiss(suggestion.id)
  }

  return (
    <div
      className="qx-card qx-card--compact"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
      }}
    >
      {/* Header row: category pill + dismiss */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className={`qx-pill qx-pill--sm ${config.categoryVariant}`}>
          {config.category}
        </span>
        <button
          className="qx-btn qx-btn--ghost"
          aria-label="Dismiss"
          onClick={handleDismiss}
          style={{ padding: '2px 8px', fontSize: 12 }}
        >
          Dismiss
        </button>
      </div>

      {/* Body text */}
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        {config.body}
      </p>

      {/* Action button */}
      <button
        className="qx-btn qx-btn--primary"
        onClick={handleAction}
        style={{ alignSelf: 'flex-start', fontSize: 13 }}
      >
        {config.actionLabel}
      </button>
    </div>
  )
}

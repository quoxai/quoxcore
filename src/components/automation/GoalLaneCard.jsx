/**
 * GoalLaneCard — P10.I-1 Goal Lane on Home (v2 — 2-row layout)
 *
 * Two-line card with semantic information:
 *   Top row: stage pill | display name + elapsed time | status dot+label
 *   Bottom row: actual current action (from latest envelope payload)
 *
 * Height is line-driven (~52px); no minHeight/maxHeight on the card so
 * vertical clipping is geometrically impossible. The bottom-line text
 * uses 2-line clamp (rare) or single-line ellipsis (typical).
 *
 * Glass design system: qx-card / qx-pill tokens. No bespoke CSS.
 */

import { useNavigate } from 'react-router-dom'
import EvolutionStagePill from './EvolutionStagePill'
import { formatElapsed } from '../../services/goalLaneFeed'

// Status → semantic colour + label. The colored dot does the visual work
// so the WORD doesn't need to be redundant with anything else on the card.
const STATUS_CONFIG = {
  'running': {
    color: 'var(--qx-cyan, #06b6d4)',
    label: 'Running',
  },
  'awaiting-approval': {
    color: 'var(--qx-amber, #f59e0b)',
    label: 'Approval',
  },
  'failed': {
    color: 'var(--qx-red, #ef4444)',
    label: 'Failed',
  },
  'ready': {
    color: 'var(--qx-green, #10b981)',
    label: 'Ready',
  },
}

// Run-kind tag → short label + accent. Only set for loop / DAG / flow run
// cards (owner: "we have loops and dag right?"); plain chat/objective threads
// carry no kind and render no tag.
const KIND_CONFIG = {
  loop: { label: 'LOOP', color: 'var(--qx-violet, #8b5cf6)' },
  dag: { label: 'DAG', color: 'var(--qx-cyan, #06b6d4)' },
  flow: { label: 'FLOW', color: 'var(--qx-blue, #3b82f6)' },
}

/**
 * @param {{ thread: import('../../services/goalLaneFeed').ThreadCard }} props
 */
export default function GoalLaneCard({ thread }) {
  const navigate = useNavigate()
  const { stage, status, nextAction, targetRoute, displayName, latestTs, corr, kind } = thread

  const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG['running']
  const kindCfg = kind && KIND_CONFIG[kind]
  const elapsed = formatElapsed(latestTs)
  const name = displayName || corr?.slice(0, 16) || 'Thread'

  return (
    <button
      role="button"
      data-testid="goal-lane-card"
      className="qx-card qx-card--lift goal-lane-card"
      onClick={() => navigate(targetRoute)}
      title={`${name} — ${nextAction}`}
      style={{
        cursor: 'pointer',
        border: 'none',
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 14px',
        minWidth: 280,
        maxWidth: 380,
        flexShrink: 0,
      }}
    >
      {/* Top row: stage pill | name+elapsed | status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ flexShrink: 0 }}>
          <EvolutionStagePill currentStage={stage} compact />
        </span>

        {kindCfg && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.06em',
              padding: '1px 5px',
              borderRadius: 4,
              color: kindCfg.color,
              background: `color-mix(in srgb, ${kindCfg.color} 16%, transparent)`,
              border: `1px solid color-mix(in srgb, ${kindCfg.color} 40%, transparent)`,
            }}
          >
            {kindCfg.label}
          </span>
        )}

        <span style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        }}>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {name}
          </span>
          {elapsed && (
            <span style={{
              fontSize: 10,
              fontWeight: 500,
              color: 'var(--text-tertiary)',
              opacity: 0.65,
              flexShrink: 0,
            }}>
              · {elapsed}
            </span>
          )}
        </span>

        {/* Status: colored dot + label, NOT a fight with the action text */}
        <span
          data-status={status}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--text-secondary)',
            flexShrink: 0,
            letterSpacing: '0.02em',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statusCfg.color,
              boxShadow: status === 'running' ? `0 0 4px ${statusCfg.color}` : 'none',
              flexShrink: 0,
            }}
          />
          {statusCfg.label}
        </span>
      </div>

      {/* Bottom row: concrete action — always non-redundant with status */}
      <span
        style={{
          fontSize: 11,
          lineHeight: 1.4,
          color: 'var(--text-secondary)',
          opacity: 0.85,
          // 2-line clamp so a longer action stays visible without breaking layout
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          wordBreak: 'break-word',
        }}
      >
        {nextAction}
      </span>
    </button>
  )
}

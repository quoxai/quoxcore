/**
 * ProposedPatchChip — Inline chip rendered in an assistant message body when
 * a proposedPatch is present.
 *
 * Shows: small card with "Proposed: N edits to <files>", collapsible rationale,
 * and Show / Apply / Discard actions.
 *
 * When alreadyApplied=true, buttons are replaced by a single "Applied" pill.
 * The chip always stays visible for audit-trail purposes.
 *
 * Props:
 *   proposedPatch    { patches: [{ path, oldText, newText }], rationale }
 *   agentColor       CSS color string (default '#f97316')
 *   onShow           () => void
 *   onApply          () => void
 *   onDiscard        () => void
 *   alreadyApplied   boolean — replaces action buttons with "Applied" pill
 */

import { useState } from 'react'

const AGENT_COLOR = '#f97316'

function truncateFileList(patches) {
  const paths = patches.map(p => p.path)
  const n = paths.length
  const editWord = n === 1 ? 'edit' : 'edits'
  if (n <= 3) {
    return `${n} ${editWord} to ${paths.join(', ')}`
  }
  const visible = paths.slice(0, 3).join(', ')
  const hidden = n - 3
  return `${n} ${editWord} to ${visible} … and ${hidden} more`
}

export function ProposedPatchChip({
  proposedPatch,
  agentColor = AGENT_COLOR,
  onShow,
  onApply,
  onDiscard,
  alreadyApplied = false,
}) {
  const [rationaleExpanded, setRationaleExpanded] = useState(false)

  if (!proposedPatch || !Array.isArray(proposedPatch.patches) || proposedPatch.patches.length === 0) {
    return null
  }

  const { patches, rationale } = proposedPatch
  const fileLabel = truncateFileList(patches)

  return (
    <div
      data-testid="proposed-patch-chip"
      style={{
        marginTop: 8,
        borderRadius: 6,
        border: `1px solid ${agentColor}40`,
        background: `${agentColor}0a`,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {/* Header row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        {/* Code-file icon */}
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke={agentColor}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: agentColor,
          fontFamily: "'Inter',system-ui,sans-serif",
        }}>
          Proposed: {fileLabel}
        </span>
      </div>

      {/* Rationale — collapsible */}
      {rationale && (
        <div>
          <button
            onClick={() => setRationaleExpanded(e => !e)}
            data-testid="rationale-toggle"
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: 'rgba(255,255,255,0.45)',
              fontSize: 10,
              fontFamily: "'Inter',system-ui,sans-serif",
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: rationaleExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s ease',
                flexShrink: 0,
              }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Rationale
          </button>
          {rationaleExpanded && (
            <div
              data-testid="rationale-body"
              style={{
                marginTop: 4,
                fontSize: 11,
                color: 'rgba(255,255,255,0.6)',
                lineHeight: 1.5,
                fontFamily: "'Inter',system-ui,sans-serif",
              }}
            >
              {rationale}
            </div>
          )}
        </div>
      )}

      {/* Action row */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {alreadyApplied ? (
          <span
            data-testid="applied-pill"
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.35)',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4,
              padding: '2px 8px',
              fontFamily: "'Inter',system-ui,sans-serif",
            }}
          >
            Applied
          </span>
        ) : (
          <>
            <button
              data-testid="chip-show-btn"
              onClick={onShow}
              style={chipBtn({ color: agentColor, variant: 'ghost' })}
            >
              Show
            </button>
            <button
              data-testid="chip-apply-btn"
              onClick={onApply}
              style={chipBtn({ color: agentColor, variant: 'primary' })}
            >
              Apply
            </button>
            <button
              data-testid="chip-discard-btn"
              onClick={onDiscard}
              style={chipBtn({ color: 'rgba(255,255,255,0.4)', variant: 'ghost' })}
            >
              Discard
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function chipBtn({ color, variant }) {
  const isPrimary = variant === 'primary'
  // Ghost variant uses a subtle white fill so the button is visible against
  // the tinted chip background (was 'transparent' — disappeared on orange tint).
  const background = isPrimary ? `${color}24` : 'rgba(255,255,255,0.06)'
  return {
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 4,
    border: `1px solid ${color}80`,
    background,
    color,
    cursor: 'pointer',
    fontFamily: "'Inter',system-ui,sans-serif",
    transition: 'background 0.12s ease',
  }
}

export default ProposedPatchChip

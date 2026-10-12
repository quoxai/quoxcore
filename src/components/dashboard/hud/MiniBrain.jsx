/**
 * MiniBrain — "Shape of Quox" HUD widget.
 *
 * Left: a small constellation of the 14 cognitive implants, positioned by
 * their real gridPosition (src/config/cognitiveImplants.js) mapped onto a
 * slightly organic ellipse (deterministic per-row jitter, not random), with
 * edges drawn from getConnectorPaths(). Right: a stat rail summarising
 * implants reporting, locked count, and memory lattice health.
 *
 * Data: useCognitiveSummary() — { core, implants, locked, memory, loading }.
 *
 * Props:
 *   onNavigate?: (target: string) => void — called with 'intelligence' when
 *     the footer button is clicked.
 */
import { useMemo } from 'react'
import { useCognitiveSummary, isImplantReporting } from '../../../hooks/useCognitiveSummary'
import { COGNITIVE_IMPLANTS, getConnectorPaths } from '../../../config/cognitiveImplants'
import './hud-widgets.css'

const VIEW_W = 200
const VIEW_H = 220

// Fixed grid anchor points (viewBox units). Interpolated for fractional
// row/col centers so multi-row/col spans (e.g. quox-sense) land at their
// visual midpoint rather than snapping to the top-left cell.
const COL_X = [42, 100, 158] // col 1, 2, 3
const ROW_Y = [26, 72, 118, 164, 208] // row 1..5

// Deterministic per-row jitter for an organic (non-grid) look. Fixed values,
// not Math.random() — same layout on every render/reload.
const ROW_JITTER = [-6, 5, -4, 6, -5]

function interpolate(arr, pos1Indexed) {
  const idx = pos1Indexed - 1
  const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(idx)))
  const i1 = Math.max(0, Math.min(arr.length - 1, Math.ceil(idx)))
  const t = idx - i0
  return arr[i0] + (arr[i1] - arr[i0]) * t
}

function positionFor(gridPosition) {
  const { row, col, rowSpan = 1, colSpan = 1 } = gridPosition
  const centerRow = row + (rowSpan - 1) / 2
  const centerCol = col + (colSpan - 1) / 2
  const x = interpolate(COL_X, centerCol)
  const y = interpolate(ROW_Y, centerRow) + interpolate(ROW_JITTER, centerRow)
  return { x, y }
}

function LockIcon({ x, y }) {
  return (
    <g transform={`translate(${x}, ${y - 12})`} className="hud-node__lock">
      <rect x="-3" y="0" width="6" height="4.5" rx="1" />
      <path d="M -1.8 0 v -1.6 a 1.8 1.8 0 0 1 3.6 0 v 1.6" />
    </g>
  )
}

export default function MiniBrain({ onNavigate } = {}) {
  const { implants, locked, memory, loading } = useCognitiveSummary()

  const nodePositions = useMemo(() => {
    const positions = {}
    Object.values(COGNITIVE_IMPLANTS).forEach((implant) => {
      positions[implant.id] = positionFor(implant.gridPosition)
    })
    return positions
  }, [])

  const edges = useMemo(() => getConnectorPaths(), [])

  const lockedSet = useMemo(() => new Set(locked || []), [locked])

  const reportingCount = useMemo(() => {
    if (!implants) return 0
    return Object.keys(COGNITIVE_IMPLANTS).filter((id) =>
      isImplantReporting(implants[id])
    ).length
  }, [implants])

  const totalImplants = Object.keys(COGNITIVE_IMPLANTS).length
  const lockedCount = (locked || []).length

  return (
    <div className="qx-card hud-widget hud-mini-brain-card">
      <div className="hud-mini-brain">
        <div className="hud-mini-brain__constellation">
          <svg
            className="hud-mini-brain__svg"
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            role="img"
            aria-label="Cognitive implant constellation"
          >
            {edges.map((edge, i) => {
              const from = nodePositions[edge.from]
              const to = nodePositions[edge.to]
              if (!from || !to) return null
              const mx = (from.x + to.x) / 2
              const my = (from.y + to.y) / 2 + (i % 2 === 0 ? 8 : -8)
              return (
                <path
                  key={`${edge.from}-${edge.to}`}
                  className="hud-edge"
                  d={`M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`}
                />
              )
            })}
            {Object.values(COGNITIVE_IMPLANTS).map((implant) => {
              const pos = nodePositions[implant.id]
              if (!pos) return null
              const isCore = implant.type === 'core'
              const baseRadius = isCore ? 9.8 : 7
              const isLocked = lockedSet.has(implant.id)
              const reporting = !loading && implants && isImplantReporting(implants[implant.id])

              if (isLocked) {
                return (
                  <g key={implant.id}>
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={baseRadius}
                      className="hud-node--locked"
                    />
                    <LockIcon x={pos.x} y={pos.y} />
                  </g>
                )
              }

              if (reporting) {
                return (
                  <circle
                    key={implant.id}
                    cx={pos.x}
                    cy={pos.y}
                    r={baseRadius}
                    className="hud-node--pulse"
                    style={{ fill: implant.color }}
                  />
                )
              }

              return (
                <circle
                  key={implant.id}
                  cx={pos.x}
                  cy={pos.y}
                  r={baseRadius}
                  className="hud-node--dim"
                  style={{ stroke: implant.color }}
                />
              )
            })}
          </svg>
        </div>

        <div className="hud-mini-brain__rail">
          {loading ? (
            <div className="hud-widget__loading">Warming up</div>
          ) : (
            <div className="hud-mini-brain__rail-tiles">
              <div className="qx-stat">
                <div className="qx-stat__head">Implants Reporting</div>
                <div className="qx-stat__value">{reportingCount}/{totalImplants}</div>
              </div>

              {lockedCount > 0 && (
                <div className="qx-stat-row">
                  <span className="qx-stat-row__label">Locked</span>
                  <span className="qx-stat-row__value">{lockedCount}</span>
                </div>
              )}

              <div className="qx-stat-row">
                <span className="qx-stat-row__label">Memories</span>
                <span className="qx-stat-row__value">{memory?.totalMemories ?? '—'}</span>
              </div>
              <div className="qx-stat-row">
                <span className="qx-stat-row__label">Entities</span>
                <span className="qx-stat-row__value">{memory?.entities ?? '—'}</span>
              </div>

              <div className="hud-mini-brain__subline">
                {memory?.episodic ?? '—'} episodic &middot; {memory?.semantic ?? '—'} semantic
              </div>

              <div className="qx-stat-row">
                <span className="qx-stat-row__label">Memory Health</span>
                <span className="qx-stat-row__value">
                  {memory?.healthScore == null ? 'Collecting' : `${memory.healthScore}%`}
                </span>
              </div>
            </div>
          )}

          <div className="hud-mini-brain__footer">
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--primary"
              onClick={() => onNavigate?.('intelligence')}
            >
              Intelligence &rarr;
            </button>
            <a href="/topology" className="hud-mini-brain__link">
              Full topology &rarr;
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

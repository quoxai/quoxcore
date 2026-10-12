/**
 * TimingComparison - Layer timing comparison view
 *
 * Shows side-by-side timing bars for each layer across traces.
 * Part of AOCL Compliance Suite.
 */

import { AOCL_LAYER_ORDER } from '../../lib/aee/envelope'
import './comparison.css'

export default function TimingComparison({ data, traces }) {
  if (!data) return null

  const { layers, summary, totalDurations } = data

  // Get max duration for scaling
  const maxLayerDuration = Math.max(
    ...Object.values(layers).flatMap(l =>
      l.traces.map(t => t.duration_ms)
    ),
    1
  )

  const maxTotalDuration = Math.max(...totalDurations.map(t => t.duration_ms), 1)

  // Ordered layers (bottom to top in stack)
  const orderedLayers = [...AOCL_LAYER_ORDER].reverse().filter(id => layers[id])

  return (
    <div className="timing-comparison">
      {/* Total Duration Comparison */}
      <div className="timing-totals">
        <h4>Total Duration</h4>
        <div className="timing-total-bars">
          {totalDurations.map((t, idx) => (
            <div key={t.corr} className="timing-total-row">
              <span className="timing-total-label">Trace {idx + 1}</span>
              <div className="timing-total-bar-container">
                <div
                  className="timing-total-bar"
                  style={{
                    width: `${(t.duration_ms / maxTotalDuration) * 100}%`,
                    background: idx === 0 ? '#3b82f6' : '#8b5cf6'
                  }}
                />
                <span className="timing-total-value">{t.duration_ms}ms</span>
              </div>
            </div>
          ))}
        </div>
        <div className="timing-total-summary">
          <span>Spread: {summary.spread}ms ({summary.spreadPercent}%)</span>
          <span>Average: {summary.avg.toFixed(0)}ms</span>
        </div>
      </div>

      {/* Layer-by-Layer Comparison */}
      <div className="timing-layers">
        <h4>Layer Breakdown</h4>
        <div className="timing-layer-list">
          {orderedLayers.map(layerId => {
            const layer = layers[layerId]
            if (!layer) return null

            return (
              <div key={layerId} className="timing-layer-row">
                <div className="timing-layer-header">
                  <span
                    className="timing-layer-dot"
                    style={{ background: layer.color }}
                  />
                  <span className="timing-layer-id">{layerId}</span>
                  <span className="timing-layer-name">{layer.label}</span>
                </div>
                <div className="timing-layer-bars">
                  {layer.traces.map((t, idx) => (
                    <div key={t.corr} className="timing-layer-bar-row">
                      <span className="timing-layer-trace-num">{idx + 1}</span>
                      <div className="timing-layer-bar-track">
                        <div
                          className="timing-layer-bar"
                          style={{
                            width: `${(t.duration_ms / maxLayerDuration) * 100}%`,
                            background: idx === 0 ? '#3b82f6' : '#8b5cf6',
                            opacity: t.status === 'missing' ? 0.3 : 1
                          }}
                        />
                      </div>
                      <span className="timing-layer-value">
                        {t.status === 'missing' ? '-' : `${t.duration_ms}ms`}
                      </span>
                    </div>
                  ))}
                </div>
                {/* Delta indicator */}
                {layer.traces.length >= 2 && (
                  <div className="timing-layer-delta">
                    {calculateDelta(layer.traces[0].duration_ms, layer.traces[1].duration_ms)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="timing-legend">
        {traces.map((trace, idx) => (
          <div key={trace.corr} className="timing-legend-item">
            <span
              className="timing-legend-color"
              style={{ background: idx === 0 ? '#3b82f6' : '#8b5cf6' }}
            />
            <span>Trace {idx + 1}: {trace.corr.slice(0, 12)}...</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function calculateDelta(a, b) {
  if (a === 0 && b === 0) return null
  const diff = b - a
  const percent = a > 0 ? ((diff / a) * 100).toFixed(0) : 0

  if (diff === 0) return <span className="delta neutral">Same</span>
  if (diff > 0) return <span className="delta slower">+{diff}ms ({percent}%)</span>
  return <span className="delta faster">{diff}ms ({percent}%)</span>
}

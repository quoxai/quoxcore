/**
 * TRV-3: TraceWaterfall — primary AOCL trace visualisation
 *
 * Horizontal waterfall showing AOCL layers as timed bars with
 * decision badges, VOLT integrity indicators, and expandable detail panel.
 *
 * Keyboard navigation: ArrowUp/Down to select layers, Enter to open detail,
 * Escape to close, C to toggle compliance/engineer mode.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { GlassPanel, M, COLORS, PROTOCOL_COLORS } from '../compliance/glass-primitives'
import TraceHeader from './TraceHeader'
import LayerSpanRow from './LayerSpanRow'
import SpanDetailPanel from './SpanDetailPanel'
import IntegrityBanner from './IntegrityBanner'

export default function TraceWaterfall({
  trace,
  selectedLayerId: controlledLayerId,
  onSelectLayer: controlledOnSelect,
  mode: controlledMode,
  highlightStep = null,
  className = '',
}) {
  // Auto-open the most interesting layer if no controlled selection
  const autoOpenLayer = trace?.most_interesting_layer || null
  const [internalSelectedId, setInternalSelectedId] = useState(autoOpenLayer)
  const [internalMode, setInternalMode] = useState('compliance')
  const containerRef = useRef(null)

  // Allow controlled or uncontrolled usage
  const selectedLayerId = controlledLayerId !== undefined ? controlledLayerId : internalSelectedId
  const mode = controlledMode || internalMode

  const selectLayer = useCallback((layerId) => {
    if (controlledOnSelect) controlledOnSelect(layerId)
    else setInternalSelectedId(prev => prev === layerId ? null : layerId)
  }, [controlledOnSelect])

  const selectedLayer = trace?.layers?.find(l => l.layer_id === selectedLayerId)

  // Keyboard navigation
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handler = (e) => {
      if (!trace?.layers?.length) return

      const layerIds = trace.layers.map(l => l.layer_id)
      const currentIdx = layerIds.indexOf(selectedLayerId)

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          if (currentIdx < layerIds.length - 1) selectLayer(layerIds[currentIdx + 1])
          else if (currentIdx === -1) selectLayer(layerIds[0])
          break
        case 'ArrowUp':
          e.preventDefault()
          if (currentIdx > 0) selectLayer(layerIds[currentIdx - 1])
          break
        case 'Enter':
          e.preventDefault()
          // Already selected = toggle detail panel (no-op, it's always shown when selected)
          if (currentIdx === -1 && layerIds.length > 0) selectLayer(layerIds[0])
          break
        case 'Escape':
          e.preventDefault()
          selectLayer(null)
          if (controlledOnSelect) controlledOnSelect(null)
          else setInternalSelectedId(null)
          break
        case 'c':
        case 'C':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            setInternalMode(m => m === 'compliance' ? 'engineer' : 'compliance')
          }
          break
      }
    }

    el.addEventListener('keydown', handler)
    return () => el.removeEventListener('keydown', handler)
  }, [trace, selectedLayerId, selectLayer, controlledOnSelect])

  if (!trace) return null

  return (
    <div
      className={className}
      style={{ display: 'flex', gap: 0, minHeight: 0 }}
    >
      {/* Main waterfall */}
      <GlassPanel
        highlight={PROTOCOL_COLORS.AOCL}
        style={{ flex: 1, minWidth: 0, padding: 16 }}
      >
        <div
          ref={containerRef}
          tabIndex={0}
          style={{ outline: 'none' }}
          role="grid"
          aria-label="AOCL Trace Waterfall"
        >
          <TraceHeader
            trace={trace}
            mode={mode}
            onModeToggle={() => setInternalMode(m => m === 'compliance' ? 'engineer' : 'compliance')}
          />

          {/* Time axis header */}
          <TimeAxis duration={trace.duration_ms} />

          {/* Layer rows */}
          <div role="rowgroup">
            {trace.layers.map(layer => (
              <LayerSpanRow
                key={layer.layer_id}
                layer={layer}
                traceDuration={trace.duration_ms}
                selected={selectedLayerId === layer.layer_id}
                onClick={() => selectLayer(layer.layer_id)}
                mode={mode}
                dimmed={highlightStep !== null && layer.layer_number > highlightStep}
              />
            ))}
          </div>

          {/* Empty state */}
          {trace.layers.length === 0 && (
            <div style={{
              padding: '24px 0', textAlign: 'center',
              fontFamily: M, fontSize: 11, color: COLORS.subtleText,
            }}>
              No AOCL layer events recorded for this trace
            </div>
          )}

          <IntegrityBanner trace={trace} />
        </div>
      </GlassPanel>

      {/* Detail panel (slides in when layer selected) */}
      {selectedLayer && (
        <SpanDetailPanel
          layer={selectedLayer}
          trace={trace}
          mode={mode}
          onClose={() => {
            if (controlledOnSelect) controlledOnSelect(null)
            else setInternalSelectedId(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * TimeAxis — grid reference lines above the waterfall
 */
function TimeAxis({ duration }) {
  if (!duration) return null

  const markers = [0, 25, 50, 75, 100]

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '32px 80px minmax(80px, 180px) 1fr 55px 20px',
      gap: 6,
      padding: '2px 8px',
      marginBottom: 4,
    }}>
      <div />
      <div />
      <div />
      <div style={{ position: 'relative', height: 16 }}>
        {markers.map(pct => (
          <span
            key={pct}
            style={{
              position: 'absolute',
              left: `${pct}%`,
              transform: 'translateX(-50%)',
              fontFamily: M,
              fontSize: 8,
              color: 'rgba(255,255,255,0.25)',
            }}
          >
            {pct === 0 ? '0' : formatDuration(duration * pct / 100)}
          </span>
        ))}
      </div>
      <div />
      <div />
    </div>
  )
}

function formatDuration(ms) {
  if (!ms && ms !== 0) return '0'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

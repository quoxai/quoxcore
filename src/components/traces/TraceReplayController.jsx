/**
 * TRV-5: TraceReplayController — step-through debugger transport controls
 *
 * VCR-style controls: |<< < ▶/⏸ > >>| speed selector, step indicator.
 * Integrates with TraceWaterfall via highlightStep prop.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { GlassPill, M, F, COLORS } from '../compliance/glass-primitives'

const SPEEDS = [0.5, 1, 2]

export default function TraceReplayController({
  trace,
  currentStep,
  onStepChange,
  playing,
  onPlayPause,
  playbackSpeed = 1,
  onSpeedChange,
}) {
  const timerRef = useRef(null)
  const layerCount = trace?.layers?.length || 0
  const currentLayer = trace?.layers?.[currentStep]

  // Auto-play logic
  useEffect(() => {
    if (!playing || !trace?.layers?.length) {
      clearInterval(timerRef.current)
      return
    }

    const interval = Math.max(
      500,
      (currentLayer?.duration_ms || 1000) / playbackSpeed
    )

    timerRef.current = setInterval(() => {
      onStepChange(prev => {
        const next = typeof prev === 'number' ? prev + 1 : 0
        if (next >= layerCount) {
          onPlayPause() // Stop at end
          return prev
        }
        return next
      })
    }, interval)

    return () => clearInterval(timerRef.current)
  }, [playing, playbackSpeed, currentStep, layerCount, onStepChange, onPlayPause, currentLayer])

  if (!trace || layerCount === 0) return null

  const atStart = currentStep <= 0
  const atEnd = currentStep >= layerCount - 1

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 16px',
      borderRadius: 10,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      {/* First */}
      <TransportBtn
        onClick={() => onStepChange(0)}
        disabled={atStart}
        title="First layer"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="5" y1="4" x2="5" y2="20" />
          <polyline points="13 4 7 12 13 20" />
          <polyline points="21 4 15 12 21 20" />
        </svg>
      </TransportBtn>

      {/* Previous */}
      <TransportBtn
        onClick={() => onStepChange(Math.max(0, currentStep - 1))}
        disabled={atStart}
        title="Previous layer"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="15 4 9 12 15 20" />
        </svg>
      </TransportBtn>

      {/* Play/Pause */}
      <TransportBtn
        onClick={onPlayPause}
        highlight
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 4 20 12 6 20" />
          </svg>
        )}
      </TransportBtn>

      {/* Next */}
      <TransportBtn
        onClick={() => onStepChange(Math.min(layerCount - 1, currentStep + 1))}
        disabled={atEnd}
        title="Next layer"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="9 4 15 12 9 20" />
        </svg>
      </TransportBtn>

      {/* Last */}
      <TransportBtn
        onClick={() => onStepChange(layerCount - 1)}
        disabled={atEnd}
        title="Last layer"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 4 9 12 3 20" />
          <polyline points="11 4 17 12 11 20" />
          <line x1="19" y1="4" x2="19" y2="20" />
        </svg>
      </TransportBtn>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)', margin: '0 4px' }} />

      {/* Speed selector */}
      <div style={{ display: 'flex', gap: 2 }}>
        {SPEEDS.map(s => (
          <button
            key={s}
            onClick={() => onSpeedChange(s)}
            style={{
              background: playbackSpeed === s ? 'rgba(168,85,247,0.15)' : 'transparent',
              border: `1px solid ${playbackSpeed === s ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 4, padding: '2px 8px',
              fontFamily: M, fontSize: 9, fontWeight: 600,
              color: playbackSpeed === s ? COLORS.purple : COLORS.subtleText,
              cursor: 'pointer',
            }}
          >
            {s}x
          </button>
        ))}
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)', margin: '0 4px' }} />

      {/* Step indicator */}
      <span style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>
        Step {currentStep + 1} / {layerCount}
      </span>
      {currentLayer && (
        <GlassPill color={COLORS.purple} style={{ fontSize: 9 }}>
          {currentLayer.layer_id}: {currentLayer.layer_label}
        </GlassPill>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Playing indicator */}
      {playing && (
        <span style={{
          fontFamily: M, fontSize: 9, color: COLORS.green,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: COLORS.green,
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
          PLAYING
        </span>
      )}
    </div>
  )
}

function TransportBtn({ children, onClick, disabled = false, highlight = false, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: highlight ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${highlight ? 'rgba(168,85,247,0.3)' : 'rgba(255,255,255,0.08)'}`,
        borderRadius: 6,
        width: 32, height: 32,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: disabled ? 'rgba(255,255,255,0.15)' : highlight ? COLORS.purple : COLORS.white,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.15s ease',
        padding: 0,
      }}
    >
      {children}
    </button>
  )
}

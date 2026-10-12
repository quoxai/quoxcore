/**
 * LiveSessionViewer — BQ Phase 2: Real-time Browser Viewer
 *
 * Shows live CDP screencast during browser objective execution.
 * Two SSE connections:
 *   1. Objective events (step_started, step_completed, hitl_required, etc.)
 *   2. CDP screencast frames (~2-5 FPS JPEG stream from headless browser)
 *
 * Layout:
 *   - Large live browser panel (real-time screencast or step screenshots)
 *   - Status bar with LIVE indicator, step label, elapsed time
 *   - URL bar showing current page
 *   - Thumbnail strip at bottom (one per completed step, clickable)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { createObjectiveStream } from '../../services/browserQService'
import AgenticReasoningLog from './AgenticReasoningLog'

// ─── Thumbnail Strip ──────────────────────────────────────────────────

function ThumbnailStrip({ thumbnails, selectedIndex, onSelect }) {
  const stripRef = useRef(null)

  useEffect(() => {
    if (stripRef.current) {
      stripRef.current.scrollLeft = stripRef.current.scrollWidth
    }
  }, [thumbnails.length])

  if (!thumbnails || thumbnails.length === 0) return null

  return (
    <div className="lsv-thumbs" ref={stripRef}>
      {thumbnails.map((t, i) => (
        <button
          key={t.stepIndex ?? i}
          className={`lsv-thumb ${selectedIndex === i ? 'lsv-thumb--active' : ''}`}
          onClick={() => onSelect(i)}
          title={t.description || `Step ${(t.stepIndex ?? i) + 1}`}
        >
          {(t.base64 || t.url) ? (
            <img
              src={t.base64 ? `data:image/jpeg;base64,${t.base64}` : t.url}
              alt={`Step ${(t.stepIndex ?? i) + 1}`}
              className="lsv-thumb__img"
            />
          ) : (
            <div className="lsv-thumb__placeholder">
              <span style={{ opacity: 0.6 }}>{'\u{1F4F7}'}</span>
            </div>
          )}
          <span className="lsv-thumb__label">{(t.stepIndex ?? i) + 1}</span>
        </button>
      ))}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────

export default function LiveSessionViewer({ objectiveId, sessionId, steps, tasksObjectiveId, actionLog, orgId }) {
  const [currentScreenshot, setCurrentScreenshot] = useState(null)
  const [currentUrl, setCurrentUrl] = useState('')
  const [currentStepLabel, setCurrentStepLabel] = useState('')
  const [currentStepIndex, setCurrentStepIndex] = useState(-1)
  const [thumbnails, setThumbnails] = useState([])
  const [selectedThumbIndex, setSelectedThumbIndex] = useState(-1)
  const [elapsed, setElapsed] = useState(0)
  const [sseConnected, setSseConnected] = useState(false)
  const [screencastConnected, setScreencastConnected] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [frameCount, setFrameCount] = useState(0)

  const startTimeRef = useRef(Date.now())
  const eventSourceRef = useRef(null)
  const screencastSourceRef = useRef(null)

  // Elapsed timer
  useEffect(() => {
    if (completed) return
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [completed])

  // Agentic runs: poll gallery for new screenshots (no CDP screencast available)
  useEffect(() => {
    if (!tasksObjectiveId) return
    let cancelled = false
    const pollGallery = async () => {
      try {
        // Get org_id from the workspace context if available
        const orgParam = orgId || 'default'
        const res = await fetch(`/screencap/api/browser-q/gallery?org_id=${encodeURIComponent(orgParam)}&limit=3`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        const ss = data.screenshots || []
        if (ss.length > 0 && ss[0].id) {
          // Show the latest screenshot
          const imgRes = await fetch(`/screencap/api/browser-q/gallery/${ss[0].id}/image?org_id=${encodeURIComponent(orgParam)}&type=full`)
          if (imgRes.ok && !cancelled) {
            const blob = await imgRes.blob()
            const url = URL.createObjectURL(blob)
            setCurrentScreenshot(prev => { if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev); return url })
            setCurrentUrl(ss[0].url || ss[0].title || '')
          }
          // Build thumbnails from gallery
          setThumbnails(ss.map((s, i) => ({
            stepIndex: i,
            url: `/screencap/api/browser-q/gallery/${s.id}/image?org_id=${encodeURIComponent(orgParam)}&type=thumb`,
            description: s.title || `Screenshot ${i + 1}`,
          })))
        }
      } catch { /* gallery poll is best-effort */ }
    }
    pollGallery()
    const interval = setInterval(pollGallery, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [tasksObjectiveId])

  // Objective SSE connection (step events, HITL, completion)
  useEffect(() => {
    if (!objectiveId) return

    let es = null
    try {
      es = createObjectiveStream(objectiveId)
      eventSourceRef.current = es

      es.addEventListener('connected', () => setSseConnected(true))

      es.addEventListener('step_started', (e) => {
        try {
          const data = JSON.parse(e.data)
          setCurrentStepIndex(data.step_index ?? -1)
          setCurrentStepLabel(data.description || data.action || '')
          setSelectedThumbIndex(-1)
        } catch { /* ignore */ }
      })

      es.addEventListener('step_completed', (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.screenshot_base64) {
            // Step screenshots go to thumbnails (screencast provides the live view)
            if (!screencastConnected) {
              setCurrentScreenshot(data.screenshot_base64)
            }
            setThumbnails(prev => [
              ...prev,
              {
                stepIndex: data.step_index,
                base64: data.screenshot_base64,
                description: steps?.[data.step_index]?.description || `Step ${data.step_index + 1}`,
                url: data.url || ''
              }
            ])
          }
          if (data.url) setCurrentUrl(data.url)
        } catch { /* ignore */ }
      })

      es.addEventListener('screenshot', (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.base64_thumbnail && !screencastConnected) {
            setCurrentScreenshot(data.base64_thumbnail)
            if (data.url) setCurrentUrl(data.url)
          }
        } catch { /* ignore */ }
      })

      es.addEventListener('step_failed', (e) => {
        try {
          const data = JSON.parse(e.data)
          setCurrentStepLabel(`Failed: ${data.error || 'Unknown error'}`)
        } catch { /* ignore */ }
      })

      es.addEventListener('hitl_required', (e) => {
        try {
          const data = JSON.parse(e.data)
          setCurrentStepLabel(`Waiting for approval: ${data.description || data.reason || ''}`)
        } catch { /* ignore */ }
      })

      es.addEventListener('objective_completed', () => setCompleted(true))

      es.onerror = () => setSseConnected(false)
    } catch {
      setSseConnected(false)
    }

    return () => {
      if (es) {
        es.close()
        eventSourceRef.current = null
      }
    }
  }, [objectiveId, steps])

  // CDP Screencast SSE connection (real-time browser frames)
  useEffect(() => {
    const screencastSessionId = sessionId || objectiveId
    if (!screencastSessionId || completed) return

    // Small delay to let the session start before connecting
    const connectTimeout = setTimeout(() => {
      let es = null
      try {
        es = new EventSource(`/screencap/api/browser-q/screencast/${screencastSessionId}`)
        screencastSourceRef.current = es

        es.addEventListener('connected', () => {
          setScreencastConnected(true)
        })

        es.addEventListener('frame', (e) => {
          try {
            const data = JSON.parse(e.data)
            if (data.data) {
              setCurrentScreenshot(data.data)
              setFrameCount(prev => prev + 1)
            }
          } catch { /* ignore */ }
        })

        es.addEventListener('ended', () => {
          setScreencastConnected(false)
        })

        es.addEventListener('error', () => {
          // Don't set screencastConnected false on transient errors —
          // EventSource auto-reconnects. Only flag on permanent failure.
        })

        es.onerror = () => {
          // After 3 failed reconnects, give up on screencast
          // (step screenshots will still work via objective SSE)
        }
      } catch {
        // Screencast not available — fall back to step screenshots
      }
    }, 1500)

    return () => {
      clearTimeout(connectTimeout)
      if (screencastSourceRef.current) {
        screencastSourceRef.current.close()
        screencastSourceRef.current = null
        setScreencastConnected(false)
      }
    }
  }, [sessionId, objectiveId, completed])

  // Display logic
  const displayScreenshot = selectedThumbIndex >= 0 && thumbnails[selectedThumbIndex]
    ? thumbnails[selectedThumbIndex].base64
    : currentScreenshot

  const displayUrl = selectedThumbIndex >= 0 && thumbnails[selectedThumbIndex]
    ? thumbnails[selectedThumbIndex].url
    : currentUrl

  const handleThumbSelect = useCallback((idx) => {
    setSelectedThumbIndex(prev => prev === idx ? -1 : idx)
  }, [])

  const isLive = !completed && (screencastConnected || sseConnected) && selectedThumbIndex < 0

  const hasReasoningPanel = !!(tasksObjectiveId || actionLog)

  return (
    <div className="lsv" style={hasReasoningPanel ? { display: 'flex', gap: 0 } : undefined}>
      {/* Browser panel (left side when reasoning panel is active) */}
      <div style={hasReasoningPanel ? { flex: '1 1 60%', minWidth: 0, display: 'flex', flexDirection: 'column' } : { display: 'contents' }}>
      {/* Status bar */}
      <div className="lsv-status">
        <div className="lsv-status__left">
          <span className={`lsv-status__dot ${isLive ? 'lsv-status__dot--live' : ''} ${screencastConnected ? 'lsv-status__dot--streaming' : ''}`} />
          <span className="lsv-status__label">
            {completed ? 'Complete' : screencastConnected ? 'LIVE' : sseConnected ? 'Connected' : 'Connecting...'}
          </span>
          {screencastConnected && !completed && (
            <span className="lsv-status__fps" title={`${frameCount} frames received`}>
              {'\u{1F4F9}'} Streaming
            </span>
          )}
        </div>
        {currentStepLabel && (
          <span className="lsv-status__step">
            {currentStepIndex >= 0 ? `Step ${currentStepIndex + 1}: ` : ''}
            {currentStepLabel}
          </span>
        )}
        <span className="lsv-status__elapsed">{elapsed}s</span>
      </div>

      {/* URL bar */}
      {displayUrl && (
        <div className="lsv-url">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ stroke: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" />
          </svg>
          <span className="lsv-url__text">{displayUrl}</span>
        </div>
      )}

      {/* Screenshot/screencast panel */}
      <div className="lsv-screen">
        {displayScreenshot ? (
          <img
            src={displayScreenshot.startsWith('blob:') || displayScreenshot.startsWith('http') || displayScreenshot.startsWith('/')
              ? displayScreenshot
              : `data:image/jpeg;base64,${displayScreenshot}`}
            alt="Live browser view"
            className="lsv-screen__img"
          />
        ) : (
          <div className="lsv-screen__empty">
            <div className="lsv-screen__empty-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" strokeWidth="1" style={{ stroke: 'rgba(255,255,255,0.6)' }}>
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <span className="lsv-screen__empty-text">
              {completed ? 'No screenshots captured' : screencastConnected ? 'Waiting for browser activity...' : 'Waiting for first screenshot...'}
            </span>
          </div>
        )}

        {/* Live indicator overlay */}
        {isLive && currentScreenshot && (
          <div className={`lsv-screen__live-badge ${screencastConnected ? 'lsv-screen__live-badge--streaming' : ''}`}>
            {screencastConnected ? 'LIVE' : 'LIVE (steps)'}
          </div>
        )}

        {/* Viewing historic indicator */}
        {selectedThumbIndex >= 0 && (
          <div className="lsv-screen__historic-badge">
            Step {(thumbnails[selectedThumbIndex]?.stepIndex ?? selectedThumbIndex) + 1}
            <button
              className="lsv-screen__back-live"
              onClick={() => setSelectedThumbIndex(-1)}
            >
              {'\u25C0'} Back to live
            </button>
          </div>
        )}
      </div>

      {/* Thumbnail strip */}
      <ThumbnailStrip
        thumbnails={thumbnails}
        selectedIndex={selectedThumbIndex}
        onSelect={handleThumbSelect}
      />
    </div>

    {/* Reasoning panel (right side) — BQ Phase 5 */}
    {hasReasoningPanel && (
      <div style={{
        flex: '0 0 320px', minWidth: 280, maxWidth: 380,
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column',
        background: 'rgba(6,7,12,0.5)',
      }}>
        <AgenticReasoningLog
          objectiveId={tasksObjectiveId}
          actionLog={actionLog}
          compact
        />
      </div>
    )}
    </div>
  )
}

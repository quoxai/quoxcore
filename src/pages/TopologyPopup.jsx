import { useState, useEffect, useCallback, useRef } from 'react'
import TopologyVisualizer from '../components/cognitive/TopologyVisualizer'
import './topology-popup.css'

/**
 * TopologyPopup - Fullscreen detachable topology visualizer
 *
 * Opens as a separate window for the brain galaxy visualization.
 * Features:
 * - Full-screen API support (F11 or button)
 * - Dark background optimized for displays
 * - Auto-hides controls after inactivity
 * - Syncs highlighted types via BroadcastChannel
 */
export default function TopologyPopup() {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [highlightedTypes, setHighlightedTypes] = useState(null)
  const containerRef = useRef(null)
  const hideTimeoutRef = useRef(null)
  const channelRef = useRef(null)

  // Setup BroadcastChannel for highlight sync
  useEffect(() => {
    channelRef.current = new BroadcastChannel('quox-topology-sync')

    channelRef.current.onmessage = (event) => {
      const { type, payload } = event.data
      if (type === 'highlight') {
        setHighlightedTypes(payload.types)
      }
    }

    // Request initial state
    channelRef.current.postMessage({ type: 'request-state' })

    return () => {
      channelRef.current?.close()
    }
  }, [])

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Auto-hide controls
  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    clearTimeout(hideTimeoutRef.current)
    hideTimeoutRef.current = setTimeout(() => {
      if (isFullscreen) {
        setShowControls(false)
      }
    }, 3000)
  }, [isFullscreen])

  useEffect(() => {
    const handleMouseMove = () => resetHideTimer()
    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [resetHideTimer])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'f' || e.key === 'F' || e.key === 'F11') {
        e.preventDefault()
        toggleFullscreen()
      } else if (e.key === 'Escape' && !document.fullscreenElement) {
        window.close()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await containerRef.current?.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch (err) {
      console.error('Fullscreen error:', err)
    }
  }

  return (
    <div
      ref={containerRef}
      className={`topology-popup ${isFullscreen ? 'fullscreen' : ''}`}
      onMouseMove={resetHideTimer}
    >
      {/* Main visualizer */}
      <div className="topology-popup-visualizer">
        <TopologyVisualizer
          height="100%"
          highlightedTypes={highlightedTypes}
        />
      </div>

      {/* Controls overlay */}
      <div className={`topology-popup-controls ${showControls ? 'visible' : ''}`}>
        <div className="topology-popup-actions">
          <button
            className="topology-popup-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen (F)' : 'Enter fullscreen (F)'}
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="4 14 10 14 10 20"/>
                <polyline points="20 10 14 10 14 4"/>
                <line x1="14" y1="10" x2="21" y2="3"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9"/>
                <polyline points="9 21 3 21 3 15"/>
                <line x1="21" y1="3" x2="14" y2="10"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            )}
          </button>
          <button
            className="topology-popup-btn close"
            onClick={() => window.close()}
            title="Close window"
          >
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Fullscreen hint */}
      {!isFullscreen && showControls && (
        <div className="topology-popup-hint">
          Press <kbd>F</kbd> for fullscreen
        </div>
      )}
    </div>
  )
}

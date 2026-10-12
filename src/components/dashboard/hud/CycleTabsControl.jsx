/**
 * CycleTabsControl — "Shape of Quox" HUD widget.
 *
 * A compact chip-styled control that auto-advances the dashboard's active
 * tab via useTabCycler. Persists { enabled, intervalSec } through
 * uiSettings under the 'dashboardCycle' key. Pauses on pointer hover (in
 * addition to the hook's own document.hidden / prefers-reduced-motion
 * pauses).
 *
 * Props:
 *   tabs: Array<{ id: string, label: string }>
 *   activeTab: string
 *   setActiveTab: (id: string) => void
 */
import { useState, useEffect, useMemo } from 'react'
import { useTabCycler } from '../../../hooks/useTabCycler'
import { getUISetting, setUISetting } from '../../../services/uiSettings'
import './hud-widgets.css'

const SETTING_KEY = 'dashboardCycle'
const DEFAULT_CYCLE_SETTING = { enabled: false, intervalSec: 30 }
const INTERVAL_OPTIONS = [15, 30, 60]

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export default function CycleTabsControl({ tabs, activeTab, setActiveTab }) {
  const [cycleSetting, setCycleSetting] = useState(() => ({
    ...DEFAULT_CYCLE_SETTING,
    ...(getUISetting(SETTING_KEY) || {}),
  }))
  const [hovered, setHovered] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReducedMotion(mq.matches)
    if (mq.addEventListener) mq.addEventListener('change', onChange)
    else if (mq.addListener) mq.addListener(onChange)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange)
      else if (mq.removeListener) mq.removeListener(onChange)
    }
  }, [])

  const tabIds = useMemo(() => (tabs || []).map((t) => t.id), [tabs])

  const { secondsLeft, nextTabId } = useTabCycler(tabIds, activeTab, setActiveTab, {
    enabled: cycleSetting.enabled && !reducedMotion,
    intervalSec: cycleSetting.intervalSec,
    paused: hovered,
  })

  const persist = (updates) => {
    setCycleSetting((prev) => {
      const next = { ...prev, ...updates }
      setUISetting(SETTING_KEY, next)
      return next
    })
  }

  const toggleEnabled = () => {
    if (reducedMotion) return
    persist({ enabled: !cycleSetting.enabled })
  }

  const nextLabel = (tabs || []).find((t) => t.id === nextTabId)?.label || ''

  return (
    <div
      className="hud-cycle-control"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={`qx-btn qx-btn--sm hud-cycle-control__toggle ${
          cycleSetting.enabled ? 'hud-cycle-control__toggle--active' : ''
        }`}
        onClick={toggleEnabled}
        disabled={reducedMotion}
        title={reducedMotion ? 'Disabled: reduced motion preferred' : undefined}
        aria-pressed={cycleSetting.enabled}
      >
        {cycleSetting.enabled ? (
          <span>&#10074;&#10074; Next: {nextLabel} &middot; {secondsLeft}s</span>
        ) : (
          <span>&#9654; Cycle</span>
        )}
      </button>

      <div className="hud-cycle-control__intervals">
        {INTERVAL_OPTIONS.map((sec) => (
          <button
            key={sec}
            type="button"
            className={`qx-chip hud-cycle-control__interval ${
              cycleSetting.intervalSec === sec ? 'qx-chip--active' : ''
            }`}
            onClick={() => persist({ intervalSec: sec })}
            aria-pressed={cycleSetting.intervalSec === sec}
          >
            {sec}s
          </button>
        ))}
      </div>
    </div>
  )
}

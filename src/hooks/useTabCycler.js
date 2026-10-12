/**
 * useTabCycler — advances a dashboard tab id on a timer.
 *
 * Used by the "Shape of Quox" HUD's CycleTabsControl to auto-rotate through
 * dashboard tabs. Single interval, pauses on document.hidden, on
 * prefers-reduced-motion, or when the caller sets `paused`. If the active
 * tab changes from somewhere other than the cycler itself (a manual click),
 * the countdown resets rather than fighting the user's choice.
 *
 * @param {string[]} tabIds - ordered list of tab ids to cycle through
 * @param {string} activeTab - the currently active tab id
 * @param {(id: string) => void} setActiveTab - setter for the active tab
 * @param {{ enabled?: boolean, intervalSec?: number, paused?: boolean }} [options]
 * @returns {{ secondsLeft: number, nextTabId: string|null, paused: boolean }}
 */
import { useState, useEffect, useRef } from 'react'

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function useTabCycler(tabIds, activeTab, setActiveTab, options = {}) {
  const { enabled = false, intervalSec = 30, paused: externalPaused = false } = options

  const [secondsLeft, setSecondsLeft] = useState(intervalSec)
  const [documentHidden, setDocumentHidden] = useState(
    typeof document !== 'undefined' ? document.hidden : false
  )
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion)

  const setActiveTabRef = useRef(setActiveTab)
  setActiveTabRef.current = setActiveTab

  const cyclerMovedRef = useRef(false) // true while the cycler itself is the one setting activeTab
  const lastTabRef = useRef(activeTab)

  const effectivePaused = externalPaused || !enabled || documentHidden || reducedMotion

  // Track document visibility.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = () => setDocumentHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Track prefers-reduced-motion.
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

  // Reset the countdown if activeTab changed from outside the cycler (a manual click).
  useEffect(() => {
    if (activeTab !== lastTabRef.current) {
      lastTabRef.current = activeTab
      if (!cyclerMovedRef.current) {
        setSecondsLeft(intervalSec)
      }
      cyclerMovedRef.current = false
    }
  }, [activeTab, intervalSec])

  // Reset the countdown whenever the interval length changes or cycling (re)starts.
  useEffect(() => {
    setSecondsLeft(intervalSec)
  }, [intervalSec, enabled])

  // The single ticking interval.
  useEffect(() => {
    if (effectivePaused) return undefined
    if (!Array.isArray(tabIds) || tabIds.length < 2) return undefined

    const tick = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          const currentIndex = tabIds.indexOf(lastTabRef.current)
          const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tabIds.length
          const nextId = tabIds[nextIndex]
          cyclerMovedRef.current = true
          lastTabRef.current = nextId
          setActiveTabRef.current(nextId)
          return intervalSec
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(tick)
  }, [effectivePaused, tabIds, intervalSec])

  const currentIndex = Array.isArray(tabIds) ? tabIds.indexOf(activeTab) : -1
  const nextTabId =
    Array.isArray(tabIds) && tabIds.length > 1
      ? tabIds[(currentIndex === -1 ? 0 : currentIndex + 1) % tabIds.length]
      : null

  return { secondsLeft, nextTabId, paused: effectivePaused }
}

export default useTabCycler

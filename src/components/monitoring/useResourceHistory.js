/**
 * useResourceHistory — Ring buffer hook for resource metric history.
 *
 * Samples CPU and memory values from allItems every 30s into a ring buffer
 * of 30 data points per VM/CT. Components can call getHistory(key) to get
 * the array for sparkline rendering.
 */

import { useRef, useCallback, useEffect } from 'react'

const BUFFER_SIZE = 30
const SAMPLE_INTERVAL = 30000 // 30 seconds

/**
 * Create a ring buffer that maintains the last N values
 */
function pushToRing(arr, value) {
  const next = [...arr, value]
  if (next.length > BUFFER_SIZE) next.shift()
  return next
}

function itemKey(item) {
  return `${item.node}-${item.vmid}`
}

export function useResourceHistory(allItems) {
  const historyRef = useRef(new Map())
  const intervalRef = useRef(null)

  // Sample current values into the ring buffer
  const sample = useCallback(() => {
    if (!allItems || allItems.length === 0) return
    const map = historyRef.current

    for (const item of allItems) {
      const key = itemKey(item)
      const existing = map.get(key) || { cpu: [], mem: [] }

      const cpuVal = item.status === 'running' && item.cpu != null ? item.cpu : null
      const memVal = item.status === 'running' && item.mem && item.maxmem
        ? item.mem / item.maxmem : null

      if (cpuVal !== null) {
        existing.cpu = pushToRing(existing.cpu, cpuVal)
      }
      if (memVal !== null) {
        existing.mem = pushToRing(existing.mem, memVal)
      }

      map.set(key, existing)
    }
  }, [allItems])

  // Initial sample on mount and when items change
  useEffect(() => {
    sample()
  }, [sample])

  // Sample on interval
  useEffect(() => {
    intervalRef.current = setInterval(sample, SAMPLE_INTERVAL)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [sample])

  // Stable getter for sparkline data
  const getHistory = useCallback((key) => {
    return historyRef.current.get(key) || { cpu: [], mem: [] }
  }, [])

  return { getHistory, itemKey }
}

export default useResourceHistory

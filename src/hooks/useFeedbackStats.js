/**
 * useFeedbackStats - Polls unread counts for feedback and error reports
 * Used by admin sidebar for badge display
 */

import { useState, useEffect, useCallback } from 'react'
import { getFeedbackUnreadCount, getErrorReportsUnreadCount } from '../services/feedbackClient'

export function useFeedbackStats(pollInterval = 30000) {
  const [feedbackCount, setFeedbackCount] = useState(0)
  const [errorReportCount, setErrorReportCount] = useState(0)

  const fetchCounts = useCallback(async () => {
    try {
      const [fb, er] = await Promise.all([
        getFeedbackUnreadCount().catch(() => ({ count: 0 })),
        getErrorReportsUnreadCount().catch(() => ({ count: 0 }))
      ])
      setFeedbackCount(fb.count || 0)
      setErrorReportCount(er.count || 0)
    } catch {
      // Silently fail — badges just won't update
    }
  }, [])

  useEffect(() => {
    fetchCounts()
    const interval = setInterval(fetchCounts, pollInterval)
    return () => clearInterval(interval)
  }, [fetchCounts, pollInterval])

  return {
    feedbackCount,
    errorReportCount,
    totalUnread: feedbackCount + errorReportCount,
    refetch: fetchCounts
  }
}

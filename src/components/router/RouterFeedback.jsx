/**
 * RouterFeedback - User feedback widget for routed responses
 *
 * Provides thumbs up/down feedback on routed responses.
 * Tracks feedback per pattern for quality improvement.
 *
 * Part of the Smart Router visibility enhancement initiative.
 */

import { useState, useCallback } from 'react'
import { logEscalation } from '../../services/quoxRouter'
import { queueSync } from '../../services/serverSyncQueue'
import './router.css'

// Feedback storage key
const FEEDBACK_STORAGE_KEY = 'quox-router-feedback'

/**
 * Get stored feedback data
 */
function getFeedbackData() {
  try {
    const data = localStorage.getItem(FEEDBACK_STORAGE_KEY)
    return data ? JSON.parse(data) : { patterns: {}, total: { positive: 0, negative: 0 } }
  } catch {
    return { patterns: {}, total: { positive: 0, negative: 0 } }
  }
}

/**
 * Store feedback data
 */
function storeFeedbackData(data) {
  try {
    localStorage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(data))
    queueSync('routerFeedback', data)
  } catch (err) {
    console.warn('[RouterFeedback] Failed to store feedback:', err)
  }
}

/**
 * Record feedback for a pattern
 */
export function recordFeedback(pattern, positive, query = '') {
  const data = getFeedbackData()

  // Initialize pattern if needed
  if (!data.patterns[pattern]) {
    data.patterns[pattern] = { positive: 0, negative: 0, history: [] }
  }

  // Update counts
  if (positive) {
    data.patterns[pattern].positive++
    data.total.positive++
  } else {
    data.patterns[pattern].negative++
    data.total.negative++

    // Log negative feedback as a form of escalation
    logEscalation(query, pattern)
  }

  // Add to history (keep last 20 per pattern)
  data.patterns[pattern].history.push({
    ts: Date.now(),
    positive,
    query: query.slice(0, 100)
  })
  if (data.patterns[pattern].history.length > 20) {
    data.patterns[pattern].history.shift()
  }

  storeFeedbackData(data)

  console.log(`[RouterFeedback] ${positive ? 'Positive' : 'Negative'} feedback for pattern: ${pattern}`)

  return data
}

/**
 * Get feedback statistics
 */
export function getFeedbackStats() {
  const data = getFeedbackData()

  const stats = {
    total: data.total,
    patterns: {},
    problemPatterns: []
  }

  // Calculate per-pattern stats
  for (const [pattern, patternData] of Object.entries(data.patterns)) {
    const total = patternData.positive + patternData.negative
    const negativeRate = total > 0 ? (patternData.negative / total) * 100 : 0

    stats.patterns[pattern] = {
      positive: patternData.positive,
      negative: patternData.negative,
      total,
      negativeRate: Math.round(negativeRate),
      recentNegative: patternData.history.filter(h => !h.positive && Date.now() - h.ts < 86400000).length
    }

    // Flag patterns with >30% negative feedback (minimum 5 responses)
    if (total >= 5 && negativeRate > 30) {
      stats.problemPatterns.push({
        pattern,
        negativeRate: Math.round(negativeRate),
        total
      })
    }
  }

  return stats
}

/**
 * Reset feedback data (for testing)
 */
export function resetFeedback() {
  localStorage.removeItem(FEEDBACK_STORAGE_KEY)
}

/**
 * RouterFeedback Component
 *
 * @param {Object} props
 * @param {string} props.pattern - The pattern that matched
 * @param {string} props.query - The original query
 * @param {Function} props.onFeedback - Callback after feedback is given
 * @param {boolean} props.compact - Compact mode
 */
export function RouterFeedback({
  pattern,
  query,
  onFeedback,
  compact = false
}) {
  const [feedback, setFeedback] = useState(null)
  const [showThanks, setShowThanks] = useState(false)

  const handleFeedback = useCallback((positive) => {
    setFeedback(positive)
    recordFeedback(pattern, positive, query)

    // Show thanks message briefly
    setShowThanks(true)
    setTimeout(() => setShowThanks(false), 2000)

    onFeedback?.(positive, pattern)
  }, [pattern, query, onFeedback])

  if (showThanks) {
    return (
      <div className={`router-feedback router-feedback--thanks ${compact ? 'router-feedback--compact' : ''}`}>
        <span className="router-feedback-thanks">Thanks for your feedback!</span>
      </div>
    )
  }

  if (feedback !== null) {
    return (
      <div className={`router-feedback router-feedback--submitted ${compact ? 'router-feedback--compact' : ''}`}>
        <span className={`router-feedback-icon ${feedback ? 'router-feedback-icon--positive' : 'router-feedback-icon--negative'}`}>
          {feedback ? '\u{1F44D}' : '\u{1F44E}'}
        </span>
      </div>
    )
  }

  return (
    <div className={`router-feedback ${compact ? 'router-feedback--compact' : ''}`}>
      <span className="router-feedback-label">Was this helpful?</span>
      <div className="router-feedback-buttons">
        <button
          className="router-feedback-btn router-feedback-btn--positive"
          onClick={() => handleFeedback(true)}
          title="Yes, this was helpful"
          aria-label="Thumbs up"
        >
          <span className="router-feedback-emoji">{'\u{1F44D}'}</span>
        </button>
        <button
          className="router-feedback-btn router-feedback-btn--negative"
          onClick={() => handleFeedback(false)}
          title="No, this wasn't helpful"
          aria-label="Thumbs down"
        >
          <span className="router-feedback-emoji">{'\u{1F44E}'}</span>
        </button>
      </div>
    </div>
  )
}

/**
 * Inline feedback badge (minimal)
 */
export function RouterFeedbackInline({ pattern, query, onFeedback }) {
  const [feedback, setFeedback] = useState(null)

  const handleFeedback = useCallback((positive) => {
    setFeedback(positive)
    recordFeedback(pattern, positive, query)
    onFeedback?.(positive, pattern)
  }, [pattern, query, onFeedback])

  if (feedback !== null) {
    return (
      <span className="router-feedback-inline router-feedback-inline--done">
        {feedback ? '\u2713' : '\u2717'}
      </span>
    )
  }

  return (
    <span className="router-feedback-inline">
      <button onClick={() => handleFeedback(true)} title="Helpful">{'\u{1F44D}'}</button>
      <button onClick={() => handleFeedback(false)} title="Not helpful">{'\u{1F44E}'}</button>
    </span>
  )
}

export default RouterFeedback

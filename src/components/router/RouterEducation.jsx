/**
 * RouterEducation - In-App Education for Smart Router
 *
 * Provides tooltips, first-time guides, and contextual help
 * for understanding Smart Router functionality.
 *
 * Part of the Smart Router visibility enhancement initiative.
 */

import { useState, useEffect, useCallback } from 'react'
import { queueSync } from '../../services/serverSyncQueue'
import './router.css'

// Storage key for tracking viewed education
const EDUCATION_STORAGE_KEY = 'quox-router-education'

/**
 * Get education state from storage
 */
function getEducationState() {
  try {
    const data = localStorage.getItem(EDUCATION_STORAGE_KEY)
    return data ? JSON.parse(data) : { viewedTips: [], dismissed: false, firstVisit: true }
  } catch {
    return { viewedTips: [], dismissed: false, firstVisit: true }
  }
}

/**
 * Save education state to storage
 */
function saveEducationState(state) {
  try {
    localStorage.setItem(EDUCATION_STORAGE_KEY, JSON.stringify(state))
    queueSync('routerEducation', state)
  } catch (err) {
    console.warn('[RouterEducation] Failed to save state:', err)
  }
}

/**
 * Mark a tip as viewed
 */
export function markTipViewed(tipId) {
  const state = getEducationState()
  if (!state.viewedTips.includes(tipId)) {
    state.viewedTips.push(tipId)
    state.firstVisit = false
    saveEducationState(state)
  }
}

/**
 * Check if first time visiting router features
 */
export function isFirstVisit() {
  return getEducationState().firstVisit
}

/**
 * Dismiss all education permanently
 */
export function dismissEducation() {
  const state = getEducationState()
  state.dismissed = true
  saveEducationState(state)
}

/**
 * Reset education state (for testing)
 */
export function resetEducation() {
  localStorage.removeItem(EDUCATION_STORAGE_KEY)
}

// Education content definitions
const TIPS = {
  router_intro: {
    title: 'Smart Router',
    content: 'The Smart Router handles common queries instantly without calling Claude, saving tokens and reducing latency by 10-100x.',
    learnMore: 'It uses pattern matching to identify queries like "check host status" or "list agents" and responds immediately.'
  },
  confidence: {
    title: 'Confidence Scores',
    content: 'Every routing decision includes a confidence score (0-100%). Higher scores mean the router is more certain about the match.',
    learnMore: 'Queries below your minimum threshold are automatically sent to Claude instead.'
  },
  patterns: {
    title: 'Routing Patterns',
    content: 'The router recognizes 28+ patterns like fleet_status, health_check, and memory_summary.',
    learnMore: 'You can enable/disable patterns and adjust their individual thresholds in Settings.'
  },
  escalation: {
    title: 'Escalation',
    content: 'If the router gives an unhelpful answer, just say "ask Claude" or "that\'s not what I asked" to escalate.',
    learnMore: 'The router learns from escalations to improve future routing decisions.'
  },
  feedback: {
    title: 'Feedback',
    content: 'Use 👍 or 👎 after routed responses to help improve the router.',
    learnMore: 'Patterns with too much negative feedback are flagged for review.'
  },
  blocklist: {
    title: 'Blocklist',
    content: 'Add phrases to the blocklist to prevent specific queries from being routed.',
    learnMore: 'Useful when a phrase consistently triggers the wrong pattern.'
  },
  modes: {
    title: 'Operating Modes',
    content: 'Choose Standard, Conservative, Aggressive, or Off to control routing behavior.',
    learnMore: 'Conservative routes fewer queries but with higher accuracy. Aggressive routes more but may increase false positives.'
  }
}

/**
 * RouterTooltip - Contextual tooltip for router features
 */
export function RouterTooltip({ tipId, children, position = 'top' }) {
  const [visible, setVisible] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const tip = TIPS[tipId]

  if (!tip) return children

  const state = getEducationState()
  const isNew = !state.viewedTips.includes(tipId) && !state.dismissed

  const handleMouseEnter = () => {
    setVisible(true)
    markTipViewed(tipId)
  }

  const handleMouseLeave = () => {
    setVisible(false)
    setExpanded(false)
  }

  return (
    <span
      className={`router-tooltip-wrapper ${isNew ? 'router-tooltip-wrapper--new' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isNew && <span className="router-tooltip-badge">NEW</span>}
      {visible && (
        <div className={`router-tooltip router-tooltip--${position}`}>
          <div className="router-tooltip-title">{tip.title}</div>
          <div className="router-tooltip-content">{tip.content}</div>
          {tip.learnMore && (
            <>
              {expanded ? (
                <div className="router-tooltip-more">{tip.learnMore}</div>
              ) : (
                <button
                  className="router-tooltip-expand"
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpanded(true)
                  }}
                >
                  Learn more
                </button>
              )}
            </>
          )}
        </div>
      )}
    </span>
  )
}

/**
 * RouterFirstTimeGuide - Welcome modal for first-time users
 */
export function RouterFirstTimeGuide({ onDismiss }) {
  const [step, setStep] = useState(0)
  const state = getEducationState()

  // Don't show if dismissed or not first visit
  if (state.dismissed || !state.firstVisit) {
    return null
  }

  const steps = [
    {
      title: 'Welcome to Smart Router',
      content: 'The Smart Router handles common queries instantly, saving tokens and reducing response time by 10-100x.',
      icon: '⚡'
    },
    {
      title: 'See Every Decision',
      content: 'Routed responses show exactly which pattern matched and why. Click the badge for full details.',
      icon: '🔍'
    },
    {
      title: 'Full Control',
      content: 'Configure thresholds, enable/disable patterns, and manage blocklists in Settings → Smart Router.',
      icon: '⚙️'
    },
    {
      title: 'Easy Escalation',
      content: 'If you get an unhelpful answer, just say "ask Claude" or click "Ask Claude" on the response.',
      icon: '🔄'
    }
  ]

  const currentStep = steps[step]

  const handleNext = () => {
    if (step < steps.length - 1) {
      setStep(step + 1)
    } else {
      handleDismiss()
    }
  }

  const handleDismiss = () => {
    const newState = getEducationState()
    newState.firstVisit = false
    saveEducationState(newState)
    onDismiss?.()
  }

  const handleDismissForever = () => {
    dismissEducation()
    onDismiss?.()
  }

  return (
    <div className="router-guide-overlay">
      <div className="router-guide-modal">
        <button className="router-guide-close" onClick={handleDismiss}>×</button>

        <div className="router-guide-icon">{currentStep.icon}</div>
        <h2 className="router-guide-title">{currentStep.title}</h2>
        <p className="router-guide-content">{currentStep.content}</p>

        <div className="router-guide-dots">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`router-guide-dot ${i === step ? 'router-guide-dot--active' : ''}`}
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <div className="router-guide-actions">
          <button className="router-guide-btn router-guide-btn--secondary" onClick={handleDismissForever}>
            Don't show again
          </button>
          <button className="router-guide-btn router-guide-btn--primary" onClick={handleNext}>
            {step < steps.length - 1 ? 'Next' : 'Get Started'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * RouterFeatureHighlight - Highlight a specific feature
 */
export function RouterFeatureHighlight({ feature, children, onDismiss }) {
  const [visible, setVisible] = useState(true)
  const state = getEducationState()

  // Don't show if already viewed or dismissed
  if (state.viewedTips.includes(feature) || state.dismissed || !visible) {
    return children
  }

  const handleDismiss = () => {
    markTipViewed(feature)
    setVisible(false)
    onDismiss?.()
  }

  const tip = TIPS[feature]
  if (!tip) return children

  return (
    <div className="router-highlight-wrapper">
      {children}
      <div className="router-highlight-callout">
        <div className="router-highlight-arrow" />
        <div className="router-highlight-content">
          <strong>{tip.title}</strong>
          <p>{tip.content}</p>
          <button className="router-highlight-dismiss" onClick={handleDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * RouterHelpPanel - Expandable help panel for settings page
 */
export function RouterHelpPanel({ topic }) {
  const [expanded, setExpanded] = useState(false)

  const helpContent = {
    modes: {
      title: 'Understanding Operating Modes',
      sections: [
        {
          subtitle: 'Standard Mode',
          text: 'Balanced routing with default thresholds. Routes queries when confidence exceeds 65%. Recommended for most users.'
        },
        {
          subtitle: 'Conservative Mode',
          text: 'Higher thresholds (75%+) mean fewer queries are routed. More queries go to Claude but with higher accuracy on routed responses.'
        },
        {
          subtitle: 'Aggressive Mode',
          text: 'Lower thresholds (55%+) route more queries. Faster responses but may increase false positives.'
        },
        {
          subtitle: 'Off',
          text: 'Disables routing entirely. All queries go directly to Claude.'
        }
      ]
    },
    thresholds: {
      title: 'Understanding Thresholds',
      sections: [
        {
          subtitle: 'Minimum Confidence',
          text: 'Queries below this score always go to Claude. Raise this if you\'re getting too many wrong answers.'
        },
        {
          subtitle: 'High Confidence',
          text: 'Queries above this score route immediately without additional checks. Lower this for faster routing.'
        },
        {
          subtitle: 'Ambiguity Threshold',
          text: 'If the top two patterns are within this gap, the router asks for clarification instead of guessing.'
        }
      ]
    },
    patterns: {
      title: 'Working with Patterns',
      sections: [
        {
          subtitle: 'Enable/Disable',
          text: 'Turn off patterns for categories you don\'t use or that consistently give wrong answers.'
        },
        {
          subtitle: 'Custom Thresholds',
          text: 'Override the global threshold for specific patterns. Useful for patterns that need higher or lower confidence.'
        },
        {
          subtitle: 'Pattern Stats',
          text: 'View match count and escalation rate to identify patterns that may need adjustment.'
        }
      ]
    },
    lists: {
      title: 'Blocklist & Allowlist',
      sections: [
        {
          subtitle: 'Blocklist',
          text: 'Queries containing blocklist phrases are NEVER routed. Use for phrases that consistently trigger wrong patterns.'
        },
        {
          subtitle: 'Allowlist',
          text: 'Queries containing allowlist phrases are ALWAYS routed (if a pattern matches). Use for trusted query types.'
        },
        {
          subtitle: 'Tips',
          text: 'Start with blocklist for problem phrases. Only use allowlist when you\'re confident about specific query types.'
        }
      ]
    }
  }

  const content = helpContent[topic]
  if (!content) return null

  return (
    <div className={`router-help-panel ${expanded ? 'router-help-panel--expanded' : ''}`}>
      <button
        className="router-help-panel-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="router-help-panel-icon">?</span>
        <span>{content.title}</span>
        <span className="router-help-panel-chevron">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="router-help-panel-content">
          {content.sections.map((section, i) => (
            <div key={i} className="router-help-panel-section">
              <h4>{section.subtitle}</h4>
              <p>{section.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default {
  RouterTooltip,
  RouterFirstTimeGuide,
  RouterFeatureHighlight,
  RouterHelpPanel,
  markTipViewed,
  isFirstVisit,
  dismissEducation,
  resetEducation
}

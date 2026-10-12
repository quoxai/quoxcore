/**
 * QuoxCORE Style Engine Panel
 *
 * UI for visualizing and managing user communication style preferences.
 * Shows learned style profile, behavior patterns, and allows manual overrides.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getStyleProfile,
  getBehaviorPatterns,
  createPersonalizationProfile,
  inferPreferencesFromBehavior,
  getFormattingRecommendations,
  exportPersonalizationProfile,
  STYLE_DIMENSIONS
} from '../../services/styleEngine'
import './memory.css'

// Style dimension descriptions
const DIMENSION_DESCRIPTIONS = {
  formality: { low: 'Casual', high: 'Formal', icon: 'F' },
  verbosity: { low: 'Concise', high: 'Detailed', icon: 'V' },
  technicality: { low: 'Simple', high: 'Technical', icon: 'T' },
  emotionality: { low: 'Neutral', high: 'Expressive', icon: 'E' },
  directness: { low: 'Contextual', high: 'Direct', icon: 'D' },
  questionStyle: { low: 'Broad', high: 'Specific', icon: 'Q' }
}

/**
 * Style Engine Panel
 */
export function StyleEnginePanel({ onClose }) {
  const [profile, setProfile] = useState(null)
  const [behavior, setBehavior] = useState(null)
  const [inferred, setInferred] = useState(null)
  const [recommendations, setRecommendations] = useState(null)
  const [activeTab, setActiveTab] = useState('profile')
  const [loading, setLoading] = useState(true)

  // Load data
  useEffect(() => {
    loadData()
  }, [])

  const loadData = useCallback(() => {
    try {
      const styleProfile = getStyleProfile()
      const behaviorPatterns = getBehaviorPatterns()
      const inferredPrefs = inferPreferencesFromBehavior()
      const formatRecs = getFormattingRecommendations()

      setProfile(styleProfile)
      setBehavior(behaviorPatterns)
      setInferred(inferredPrefs)
      setRecommendations(formatRecs)
      setLoading(false)
    } catch (err) {
      console.error('Failed to load style data:', err)
      setLoading(false)
    }
  }, [])

  // Export profile
  const handleExport = () => {
    const data = exportPersonalizationProfile()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `quox-style-profile-${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="style-panel">
        <div className="style-loading">Loading style profile...</div>
      </div>
    )
  }

  return (
    <div className="style-panel">
      {/* Header */}
      <div className="style-header">
        <div className="style-title">
          <span className="style-icon">~</span>
          <h2>Style Engine</h2>
        </div>
        <div className="style-header-actions">
          <button className="style-btn" onClick={handleExport}>Export</button>
          {onClose && (
            <button className="style-close-btn" onClick={onClose}>X</button>
          )}
        </div>
      </div>

      <p className="panel-intro">Learns your communication style from conversations. These dimensions shape every response: formal vs casual, concise vs detailed, technical vs simple. More observations mean higher confidence.</p>

      {/* Confidence Banner */}
      <div className="style-confidence-banner">
        <div className="confidence-info">
          <span className="confidence-label">Profile Confidence</span>
          <div className="confidence-bar">
            <div
              className="confidence-fill"
              style={{ width: `${(profile?.confidenceScore || 0) * 100}%` }}
            />
          </div>
          <span className="confidence-value">
            {Math.round((profile?.confidenceScore || 0) * 100)}%
          </span>
        </div>
        <div className="observation-count">
          Based on {profile?.observationCount || 0} observations
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="style-tabs">
        <button
          className={activeTab === 'profile' ? 'active' : ''}
          onClick={() => setActiveTab('profile')}
        >
          Style Profile
        </button>
        <button
          className={activeTab === 'behavior' ? 'active' : ''}
          onClick={() => setActiveTab('behavior')}
        >
          Behavior Patterns
        </button>
        <button
          className={activeTab === 'recommendations' ? 'active' : ''}
          onClick={() => setActiveTab('recommendations')}
        >
          Recommendations
        </button>
      </div>

      {/* Content */}
      <div className="style-content">
        {activeTab === 'profile' && (
          <StyleProfileView profile={profile} />
        )}

        {activeTab === 'behavior' && (
          <BehaviorPatternsView behavior={behavior} inferred={inferred} />
        )}

        {activeTab === 'recommendations' && (
          <RecommendationsView recommendations={recommendations} />
        )}
      </div>
    </div>
  )
}

/**
 * Style Profile View - Dimension sliders
 */
function StyleProfileView({ profile }) {
  return (
    <div className="style-profile-view">
      <div className="style-section">
        <h3>Communication Style Dimensions</h3>
        <div className="style-dimensions">
          {Object.entries(STYLE_DIMENSIONS).map(([dim, config]) => {
            const value = profile?.style?.[dim] ?? config.default
            const desc = DIMENSION_DESCRIPTIONS[dim]

            return (
              <div key={dim} className="style-dimension">
                <div className="dimension-header">
                  <span className="dimension-icon">{desc.icon}</span>
                  <span className="dimension-name">{dim}</span>
                  <span className="dimension-value">{Math.round(value * 100)}%</span>
                </div>
                <div className="dimension-slider-container">
                  <span className="dimension-label-low">{desc.low}</span>
                  <div className="dimension-slider">
                    <div
                      className="dimension-fill"
                      style={{ width: `${value * 100}%` }}
                    />
                    <div
                      className="dimension-marker"
                      style={{ left: `${value * 100}%` }}
                    />
                  </div>
                  <span className="dimension-label-high">{desc.high}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Style Summary */}
      <div className="style-section">
        <h3>Style Summary</h3>
        <div className="style-summary">
          {getStyleSummary(profile?.style)}
        </div>
      </div>

      {/* Recent Observations */}
      {profile?.recentObservations?.length > 0 && (
        <div className="style-section">
          <h3>Recent Style Observations</h3>
          <div className="style-observations">
            {profile.recentObservations.slice(-5).reverse().map((obs, idx) => (
              <div key={idx} className="style-observation">
                <span className="obs-time">
                  {new Date(obs.timestamp).toLocaleTimeString()}
                </span>
                <div className="obs-signals">
                  {Object.entries(obs.signals || {}).map(([key, val]) => (
                    <span
                      key={key}
                      className="obs-signal"
                      style={{
                        opacity: 0.3 + (val * 0.7),
                        backgroundColor: val > 0.6 ? '#38bdf8' : val < 0.4 ? '#4a9eff' : '#888'
                      }}
                    >
                      {DIMENSION_DESCRIPTIONS[key]?.icon || key[0]}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Behavior Patterns View
 */
function BehaviorPatternsView({ behavior, inferred }) {
  return (
    <div className="behavior-patterns-view">
      {/* Activity Hours */}
      <div className="style-section">
        <h3>Activity Hours</h3>
        <div className="activity-hours">
          {Array.from({ length: 24 }, (_, hour) => {
            const count = behavior?.timing?.activeHours?.[hour] || 0
            const maxCount = Math.max(...Object.values(behavior?.timing?.activeHours || { 0: 1 }))
            const intensity = maxCount > 0 ? count / maxCount : 0

            return (
              <div
                key={hour}
                className="hour-bar"
                title={`${hour}:00 - ${count} interactions`}
              >
                <div
                  className="hour-fill"
                  style={{ height: `${intensity * 100}%` }}
                />
                <span className="hour-label">{hour}</span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Inferred Preferences */}
      <div className="style-section">
        <h3>Inferred Preferences</h3>
        <div className="inferred-prefs">
          <div className="inferred-item">
            <span className="inferred-label">Response Length</span>
            <span className="inferred-value">{inferred?.preferredResponseLength || 'medium'}</span>
          </div>
          <div className="inferred-item">
            <span className="inferred-label">Code Style</span>
            <span className="inferred-value">{inferred?.codeStyle || 'commented'}</span>
          </div>
          <div className="inferred-item">
            <span className="inferred-label">Explanation Depth</span>
            <span className="inferred-value">{inferred?.explanationDepth || 'detailed'}</span>
          </div>
          <div className="inferred-item">
            <span className="inferred-label">Examples Preferred</span>
            <span className="inferred-value">{inferred?.examplesPreferred ? 'Yes' : 'No'}</span>
          </div>
          <div className="inferred-item">
            <span className="inferred-label">Structured Output</span>
            <span className="inferred-value">{inferred?.structuredOutputPreferred ? 'Yes' : 'No'}</span>
          </div>
          {inferred?.peakActivityHour !== null && (
            <div className="inferred-item">
              <span className="inferred-label">Peak Activity</span>
              <span className="inferred-value">{inferred.peakActivityHour}:00</span>
            </div>
          )}
        </div>
      </div>

      {/* Interaction Stats */}
      <div className="style-section">
        <h3>Interaction Statistics</h3>
        <div className="interaction-stats">
          <div className="stat-card">
            <span className="stat-value">
              {behavior?.interaction?.followUpRate
                ? Math.round(behavior.interaction.followUpRate * 100)
                : 0}%
            </span>
            <span className="stat-label">Follow-up Rate</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">
              {behavior?.interaction?.queryLengths?.length > 0
                ? Math.round(
                    behavior.interaction.queryLengths.reduce((a, b) => a + b, 0) /
                    behavior.interaction.queryLengths.length
                  )
                : 0}
            </span>
            <span className="stat-label">Avg Query Words</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">
              {behavior?.timing?.sessionDurations?.length || 0}
            </span>
            <span className="stat-label">Sessions</span>
          </div>
        </div>
      </div>

      {/* Top Features */}
      {inferred?.topFeatures?.length > 0 && (
        <div className="style-section">
          <h3>Most Used Features</h3>
          <div className="top-features">
            {inferred.topFeatures.map((feature, idx) => (
              <span key={idx} className="feature-tag">{feature}</span>
            ))}
          </div>
        </div>
      )}

      {/* Frequent Entities */}
      {inferred?.frequentEntities?.length > 0 && (
        <div className="style-section">
          <h3>Frequent Entities</h3>
          <div className="frequent-entities">
            {inferred.frequentEntities.map((entity, idx) => (
              <span key={idx} className="entity-tag">{entity}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Recommendations View
 */
function RecommendationsView({ recommendations }) {
  return (
    <div className="recommendations-view">
      <div className="style-section">
        <h3>Response Formatting Recommendations</h3>

        {/* Quick Hints */}
        <div className="recommendation-hints">
          {recommendations?.lengthHint && (
            <div className="hint-item">
              <span className="hint-icon">L</span>
              <span className="hint-text">{recommendations.lengthHint}</span>
            </div>
          )}
          {recommendations?.toneHint && (
            <div className="hint-item">
              <span className="hint-icon">T</span>
              <span className="hint-text">{recommendations.toneHint}</span>
            </div>
          )}
          {recommendations?.contentHint && (
            <div className="hint-item">
              <span className="hint-icon">C</span>
              <span className="hint-text">{recommendations.contentHint}</span>
            </div>
          )}
          {recommendations?.structureHint && (
            <div className="hint-item">
              <span className="hint-icon">S</span>
              <span className="hint-text">{recommendations.structureHint}</span>
            </div>
          )}
        </div>
      </div>

      {/* Full Instructions */}
      {recommendations?.instructions?.length > 0 && (
        <div className="style-section">
          <h3>LLM Instructions</h3>
          <div className="llm-instructions">
            {recommendations.instructions.map((instruction, idx) => (
              <div key={idx} className="instruction-item">
                <span className="instruction-number">{idx + 1}</span>
                <span className="instruction-text">{instruction}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Context Preview */}
      <div className="style-section">
        <h3>Context Injection Preview</h3>
        <div className="context-preview">
          <pre>{generateContextPreview(recommendations)}</pre>
        </div>
      </div>
    </div>
  )
}

/**
 * Generate style summary text
 */
function getStyleSummary(style) {
  if (!style) return 'Not enough data to generate summary.'

  const traits = []

  if (style.formality > 0.6) traits.push('formal')
  else if (style.formality < 0.4) traits.push('casual')

  if (style.verbosity > 0.6) traits.push('detailed')
  else if (style.verbosity < 0.4) traits.push('concise')

  if (style.technicality > 0.6) traits.push('technical')
  else if (style.technicality < 0.4) traits.push('non-technical')

  if (style.directness > 0.6) traits.push('direct')
  else if (style.directness < 0.4) traits.push('contextual')

  if (style.emotionality > 0.6) traits.push('expressive')

  if (traits.length === 0) {
    return 'Communication style is balanced across all dimensions.'
  }

  return `User tends to communicate in a ${traits.join(', ')} manner.`
}

/**
 * Generate context preview
 */
function generateContextPreview(recommendations) {
  if (!recommendations?.instructions?.length) {
    return '// No style instructions generated yet\n// More observations needed'
  }

  return `### Response Style Guidelines

${recommendations.instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')}

(Generated from user communication patterns)`
}

export default StyleEnginePanel

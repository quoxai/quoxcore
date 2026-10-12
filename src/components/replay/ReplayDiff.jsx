/**
 * ReplayDiff - Comparison View for Replay Results
 *
 * Shows side-by-side comparison of original trace vs replay results,
 * including timing differences, layer status changes, and response diffs.
 *
 * Part of AOCL Compliance Suite (Enterprise plugin).
 */

import { useState } from 'react'
import { AOCL_LAYERS, AOCL_LAYER_ORDER } from '../../lib/aee/envelope'
import './replay.css'

export default function ReplayDiff({ session }) {
  const [activeTab, setActiveTab] = useState('overview')

  if (!session || !session.comparison) {
    return (
      <div className="replay-diff-empty">
        No comparison data available
      </div>
    )
  }

  const { comparison, original, replay } = session

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'timing', label: 'Timing' },
    { id: 'layers', label: 'Layers' },
    { id: 'response', label: 'Response' }
  ]

  return (
    <div className="replay-diff">
      {/* Tab Navigation */}
      <div className="replay-diff-tabs">
        {tabs.map(tab => (
          <button
            key={tab.id}
            className={`replay-diff-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="replay-diff-content">
        {activeTab === 'overview' && (
          <OverviewTab comparison={comparison} session={session} />
        )}
        {activeTab === 'timing' && (
          <TimingTab comparison={comparison} />
        )}
        {activeTab === 'layers' && (
          <LayersTab comparison={comparison} original={original} replay={replay} />
        )}
        {activeTab === 'response' && (
          <ResponseTab comparison={comparison} original={original} replay={replay} />
        )}
      </div>
    </div>
  )
}

/**
 * Overview Tab - High-level summary
 */
function OverviewTab({ comparison, session }) {
  const { timing, summary, response } = comparison

  return (
    <div className="replay-diff-overview">
      {/* Summary Cards */}
      <div className="replay-summary-cards">
        <div className="replay-summary-card">
          <span className="replay-summary-value">{summary.layersExecuted}</span>
          <span className="replay-summary-label">Layers Executed</span>
        </div>
        <div className="replay-summary-card">
          <span className="replay-summary-value">{summary.layersBypassed}</span>
          <span className="replay-summary-label">Layers Bypassed</span>
        </div>
        <div className="replay-summary-card">
          <span className="replay-summary-value">{summary.layersMocked}</span>
          <span className="replay-summary-label">Layers Mocked</span>
        </div>
      </div>

      {/* Timing Summary */}
      <div className="replay-timing-summary">
        <h4>Timing Comparison</h4>
        <div className="replay-timing-bars">
          <div className="replay-timing-row">
            <span className="replay-timing-label">Original</span>
            <div className="replay-timing-bar-container">
              <div
                className="replay-timing-bar original"
                style={{ width: `${Math.min(100, (timing.originalDuration_ms / Math.max(timing.originalDuration_ms, timing.replayDuration_ms)) * 100)}%` }}
              />
              <span className="replay-timing-value">{timing.originalDuration_ms}ms</span>
            </div>
          </div>
          <div className="replay-timing-row">
            <span className="replay-timing-label">Replay</span>
            <div className="replay-timing-bar-container">
              <div
                className="replay-timing-bar replay"
                style={{ width: `${Math.min(100, (timing.replayDuration_ms / Math.max(timing.originalDuration_ms, timing.replayDuration_ms)) * 100)}%` }}
              />
              <span className="replay-timing-value">{timing.replayDuration_ms}ms</span>
            </div>
          </div>
        </div>
        <div className="replay-timing-delta">
          <span className={`replay-delta ${timing.difference_ms > 0 ? 'slower' : 'faster'}`}>
            {timing.difference_ms > 0 ? '+' : ''}{timing.difference_ms}ms ({timing.percentChange}%)
          </span>
        </div>
      </div>

      {/* Response Summary */}
      <div className="replay-response-summary">
        <h4>Response</h4>
        {response.changed ? (
          <div className="replay-response-changed">
            <span className="replay-badge warning">Changed</span>
            <span>{response.contentDiff.totalChanges} line(s) different</span>
          </div>
        ) : (
          <div className="replay-response-unchanged">
            <span className="replay-badge success">Unchanged</span>
            <span>Response matches original</span>
          </div>
        )}
      </div>

      {/* Session Info */}
      <div className="replay-session-info">
        <h4>Session Details</h4>
        <div className="replay-info-grid">
          <div className="replay-info-row">
            <span>Session ID:</span>
            <code>{session.id}</code>
          </div>
          <div className="replay-info-row">
            <span>Original Run:</span>
            <code>{session.originalRunId}</code>
          </div>
          <div className="replay-info-row">
            <span>Created:</span>
            <span>{new Date(session.createdAt).toLocaleString()}</span>
          </div>
          <div className="replay-info-row">
            <span>Completed:</span>
            <span>{session.completedAt ? new Date(session.completedAt).toLocaleString() : '-'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Timing Tab - Detailed timing comparison
 */
function TimingTab({ comparison }) {
  const { layers } = comparison
  const layerIds = [...AOCL_LAYER_ORDER].reverse()

  // Find max duration for scaling
  const maxDuration = Math.max(
    ...Object.values(layers).map(l => Math.max(l.originalDuration_ms || 0, l.replayDuration_ms || 0)),
    1
  )

  return (
    <div className="replay-diff-timing">
      <div className="replay-timing-chart">
        {layerIds.map(layerId => {
          const layer = AOCL_LAYERS[layerId]
          const layerData = layers[layerId]

          if (!layerData) return null

          const origWidth = (layerData.originalDuration_ms / maxDuration) * 100
          const replayWidth = (layerData.replayDuration_ms / maxDuration) * 100

          return (
            <div key={layerId} className="replay-timing-layer">
              <div className="replay-timing-layer-header">
                <span
                  className="replay-layer-dot"
                  style={{ background: layer?.color }}
                />
                <span className="replay-timing-layer-id">{layerId}</span>
                <span className="replay-timing-layer-name">{layer?.label}</span>
                {layerData.mocked && <span className="replay-badge mocked">Mocked</span>}
                {layerData.bypassed && <span className="replay-badge bypassed">Bypassed</span>}
              </div>
              <div className="replay-timing-layer-bars">
                <div className="replay-timing-layer-row">
                  <span className="replay-timing-label-small">Orig</span>
                  <div className="replay-timing-bar-track">
                    <div
                      className="replay-timing-bar original"
                      style={{ width: `${origWidth}%` }}
                    />
                  </div>
                  <span className="replay-timing-value-small">{layerData.originalDuration_ms}ms</span>
                </div>
                <div className="replay-timing-layer-row">
                  <span className="replay-timing-label-small">Replay</span>
                  <div className="replay-timing-bar-track">
                    <div
                      className="replay-timing-bar replay"
                      style={{ width: `${replayWidth}%` }}
                    />
                  </div>
                  <span className="replay-timing-value-small">{layerData.replayDuration_ms}ms</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Layers Tab - Layer status comparison
 */
function LayersTab({ comparison, original, replay }) {
  const { layers } = comparison
  const layerIds = [...AOCL_LAYER_ORDER].reverse()

  return (
    <div className="replay-diff-layers">
      <div className="replay-layers-table">
        <div className="replay-layers-header">
          <span>Layer</span>
          <span>Original Status</span>
          <span>Replay Status</span>
          <span>Delta</span>
        </div>
        {layerIds.map(layerId => {
          const layer = AOCL_LAYERS[layerId]
          const layerData = layers[layerId]

          if (!layerData) return null

          const statusChanged = layerData.originalStatus !== layerData.replayStatus

          return (
            <div
              key={layerId}
              className={`replay-layers-row ${statusChanged ? 'changed' : ''}`}
            >
              <div className="replay-layers-cell layer-name">
                <span
                  className="replay-layer-dot"
                  style={{ background: layer?.color }}
                />
                <span>{layerId} - {layer?.label}</span>
              </div>
              <div className="replay-layers-cell">
                <span className={`replay-status ${layerData.originalStatus}`}>
                  {layerData.originalStatus}
                </span>
              </div>
              <div className="replay-layers-cell">
                <span className={`replay-status ${layerData.replayStatus}`}>
                  {layerData.replayStatus}
                </span>
                {layerData.mocked && <span className="replay-badge mocked">Mocked</span>}
              </div>
              <div className="replay-layers-cell delta">
                {layerData.difference_ms !== 0 && (
                  <span className={layerData.difference_ms > 0 ? 'slower' : 'faster'}>
                    {layerData.difference_ms > 0 ? '+' : ''}{layerData.difference_ms}ms
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Response Tab - Response text diff
 */
function ResponseTab({ comparison, original, replay }) {
  const { response } = comparison
  const [view, setView] = useState('side-by-side')

  return (
    <div className="replay-diff-response">
      <div className="replay-response-controls">
        <button
          className={`replay-btn-small ${view === 'side-by-side' ? 'active' : ''}`}
          onClick={() => setView('side-by-side')}
        >
          Side by Side
        </button>
        <button
          className={`replay-btn-small ${view === 'unified' ? 'active' : ''}`}
          onClick={() => setView('unified')}
        >
          Unified
        </button>
      </div>

      {view === 'side-by-side' && (
        <div className="replay-response-side-by-side">
          <div className="replay-response-panel">
            <h4>Original Response</h4>
            <pre className="replay-response-text">{original.response}</pre>
          </div>
          <div className="replay-response-panel">
            <h4>Replay Response</h4>
            <pre className="replay-response-text">{replay.response}</pre>
          </div>
        </div>
      )}

      {view === 'unified' && (
        <div className="replay-response-unified">
          <div className="replay-diff-stats">
            <span className="replay-diff-added">+{response.contentDiff.added} added</span>
            <span className="replay-diff-removed">-{response.contentDiff.removed} removed</span>
            <span className="replay-diff-unchanged">{response.contentDiff.unchanged} unchanged</span>
          </div>
          <div className="replay-diff-lines">
            {response.contentDiff.changes.map((change, idx) => (
              <div
                key={idx}
                className={`replay-diff-line ${change.type}`}
              >
                <span className="replay-diff-line-num">{change.line}</span>
                {change.type === 'added' && (
                  <span className="replay-diff-line-content added">+ {change.content}</span>
                )}
                {change.type === 'removed' && (
                  <span className="replay-diff-line-content removed">- {change.content}</span>
                )}
                {change.type === 'changed' && (
                  <>
                    <span className="replay-diff-line-content removed">- {change.original}</span>
                    <span className="replay-diff-line-content added">+ {change.replay}</span>
                  </>
                )}
              </div>
            ))}
            {response.contentDiff.changes.length === 0 && (
              <div className="replay-diff-no-changes">
                No differences detected
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

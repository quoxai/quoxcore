/**
 * ContentDiff - Response content comparison
 *
 * Shows text differences between trace responses.
 * Part of AOCL Compliance Suite.
 */

import { useState } from 'react'
import './comparison.css'

export default function ContentDiff({ data, traces }) {
  const [view, setView] = useState('side-by-side')
  const [showQueries, setShowQueries] = useState(false)

  if (!data) return null

  const { queries, responses, diff, similarity, queriesIdentical, responsesIdentical } = data

  return (
    <div className="content-diff">
      {/* Status Banner */}
      <div className={`content-diff-status ${responsesIdentical ? 'identical' : 'different'}`}>
        {responsesIdentical ? (
          <>
            <span className="content-diff-icon">✓</span>
            <span>Responses are identical</span>
          </>
        ) : (
          <>
            <span className="content-diff-icon">≠</span>
            <span>{similarity}% similar • {diff?.totalChanges || 0} line differences</span>
          </>
        )}
      </div>

      {/* View Controls */}
      <div className="content-diff-controls">
        <div className="content-diff-view-toggle">
          <button
            className={view === 'side-by-side' ? 'active' : ''}
            onClick={() => setView('side-by-side')}
          >
            Side by Side
          </button>
          <button
            className={view === 'unified' ? 'active' : ''}
            onClick={() => setView('unified')}
          >
            Unified Diff
          </button>
        </div>
        <label className="content-diff-toggle">
          <input
            type="checkbox"
            checked={showQueries}
            onChange={e => setShowQueries(e.target.checked)}
          />
          Show Queries
        </label>
      </div>

      {/* Query Comparison */}
      {showQueries && (
        <div className="content-diff-section">
          <h4>Queries {queriesIdentical && <span className="badge identical">Identical</span>}</h4>
          <div className="content-diff-side-by-side">
            {queries.map((q, idx) => (
              <div key={q.corr} className="content-diff-panel">
                <div className="content-diff-panel-header">
                  <span>Trace {idx + 1}</span>
                  <span className="content-diff-length">{q.length} chars</span>
                </div>
                <pre className="content-diff-text">{q.text}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Response Comparison */}
      <div className="content-diff-section">
        <h4>Responses</h4>

        {view === 'side-by-side' && (
          <div className="content-diff-side-by-side">
            {responses.map((r, idx) => (
              <div key={r.corr} className="content-diff-panel">
                <div className="content-diff-panel-header">
                  <span>Trace {idx + 1}</span>
                  <span className="content-diff-length">{r.length} chars</span>
                </div>
                <pre className="content-diff-text">{r.text}</pre>
              </div>
            ))}
          </div>
        )}

        {view === 'unified' && diff && (
          <div className="content-diff-unified">
            <div className="content-diff-stats">
              <span className="diff-added">+{diff.added} added</span>
              <span className="diff-removed">-{diff.removed} removed</span>
              <span className="diff-unchanged">{diff.unchanged} unchanged</span>
            </div>

            {diff.changes.length === 0 ? (
              <div className="content-diff-no-changes">
                No differences detected
              </div>
            ) : (
              <div className="content-diff-lines">
                {diff.changes.map((change, idx) => (
                  <div key={idx} className={`content-diff-line ${change.type}`}>
                    <span className="content-diff-line-num">{change.line}</span>
                    {change.type === 'added' && (
                      <span className="content-diff-line-content added">+ {change.content}</span>
                    )}
                    {change.type === 'removed' && (
                      <span className="content-diff-line-content removed">- {change.content}</span>
                    )}
                    {change.type === 'changed' && (
                      <div className="content-diff-line-changed">
                        <span className="content-diff-line-content removed">- {change.from}</span>
                        <span className="content-diff-line-content added">+ {change.to}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Statistics */}
      <div className="content-diff-stats-section">
        <h4>Content Statistics</h4>
        <div className="content-diff-stats-grid">
          {responses.map((r, idx) => (
            <div key={r.corr} className="content-diff-stat-card">
              <span className="content-diff-stat-label">Trace {idx + 1}</span>
              <div className="content-diff-stat-row">
                <span>Characters:</span>
                <span>{r.length}</span>
              </div>
              <div className="content-diff-stat-row">
                <span>Words:</span>
                <span>{r.text.split(/\s+/).filter(w => w).length}</span>
              </div>
              <div className="content-diff-stat-row">
                <span>Lines:</span>
                <span>{r.text.split('\n').length}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

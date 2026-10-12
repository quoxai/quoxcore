/**
 * TestLabView - Test Lab Page
 *
 * Interactive testing interface for QuoxCORE system components.
 * Shows test health dashboard, category drill-down, and AOCL flow coverage.
 *
 * Phase 1: Core system testing visibility
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTestResults } from '../../hooks/useTestResults'
import {
  getStatusIcon,
  getStatusColor,
  formatDuration,
  TestStatus,
  TEST_INTENTS
} from '../../services/testRunner'
import './TestLabView.css'

export default function TestLabView() {
  const {
    results,
    loading,
    running,
    error,
    selectedCategory,
    selectedSuite,
    categories,
    aoclLayers,
    summary,
    overallStatus,
    liveOutput,
    liveProgress,
    runAll,
    runCategory,
    runSuite,
    stopTests,
    selectCategory,
    selectSuite,
    clearSelection,
    getCategoryResults,
    isItemRunning,
    clearLiveOutput
  } = useTestResults()

  // Console panel visibility
  const [showConsole, setShowConsole] = useState(true)

  // Render loading state
  if (loading) {
    return (
      <div className="test-lab-view">
        <div className="test-lab-loading">
          <div className="test-lab-spinner" />
          <p>Loading test data...</p>
        </div>
      </div>
    )
  }

  // Get current view content
  const currentCategory = selectedCategory ? categories.find(c => c.id === selectedCategory) : null
  const categoryResults = selectedCategory ? getCategoryResults(selectedCategory) : null

  return (
    <div className="test-lab-view">
      {/* Header */}
      <header className="test-lab-header">
        <div className="test-lab-header-content">
          <div className="test-lab-title-area">
            {selectedCategory ? (
              <>
                <button className="test-lab-back-btn" onClick={clearSelection}>
                  ← Back
                </button>
                <h1>
                  <span className="test-lab-cat-icon">{currentCategory?.icon}</span>
                  {currentCategory?.name} Tests
                </h1>
              </>
            ) : (
              <>
                <h1>Test Lab</h1>
                <p className="test-lab-subtitle">System component testing and validation</p>
              </>
            )}
          </div>

          <div className="test-lab-header-actions">
            {/* Status Badge */}
            <div className={`test-lab-status-badge test-lab-status-${overallStatus}`}>
              <span className="status-icon">{getStatusIcon(overallStatus)}</span>
              <span className="status-text">
                {running ? 'Running...' :
                 summary.total === 0 ? 'No Results' :
                 summary.failed > 0 ? `${summary.failed} Failed` : 'All Passing'}
              </span>
            </div>

            {/* Run/Stop Button */}
            {running ? (
              <button
                className="test-lab-stop-btn"
                onClick={stopTests}
                title="Stop running tests"
              >
                <span className="stop-icon">■</span>
                Stop Tests
              </button>
            ) : (
              <button
                className="test-lab-run-btn"
                onClick={selectedCategory ? () => runCategory(selectedCategory) : runAll}
              >
                <span className="run-icon">▶</span>
                {selectedCategory ? 'Run Category' : 'Run All Tests'}
              </button>
            )}

            {/* Reset Button - shows when stuck (no progress for 60s) */}
            {running && liveProgress.elapsed > 60000 && (
              <button
                className="test-lab-reset-btn"
                onClick={async () => {
                  try {
                    await fetch('/api/tests/reset', { method: 'POST' })
                    window.location.reload()
                  } catch (e) {
                    console.error('Failed to reset:', e)
                  }
                }}
                title="Force reset stuck test run"
              >
                Force Reset
              </button>
            )}
          </div>
        </div>

        {/* Summary Stats */}
        {!selectedCategory && summary.total > 0 && (
          <div className="test-lab-summary">
            <div className="summary-stat">
              <span className="stat-value">{summary.total}</span>
              <span className="stat-label">Total</span>
            </div>
            <div className="summary-stat summary-passed">
              <span className="stat-value">{summary.passed}</span>
              <span className="stat-label">Passed</span>
            </div>
            <div className="summary-stat summary-failed">
              <span className="stat-value">{summary.failed}</span>
              <span className="stat-label">Failed</span>
            </div>
            <div className="summary-stat">
              <span className="stat-value">{formatDuration(summary.duration)}</span>
              <span className="stat-label">Duration</span>
            </div>
            {results?.lastRun && (
              <div className="summary-stat summary-time">
                <span className="stat-value">{formatLastRun(results.lastRun)}</span>
                <span className="stat-label">Last Run</span>
              </div>
            )}
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div className="test-lab-error">
            <span className="error-icon">⚠</span>
            <span className="error-text">{error}</span>
          </div>
        )}

        {/* Live Console Panel - shows when running or has output */}
        {(running || liveOutput.length > 0) && (
          <TestConsolePanel
            output={liveOutput}
            progress={liveProgress}
            running={running}
            isOpen={showConsole}
            onToggle={() => setShowConsole(!showConsole)}
            onClear={clearLiveOutput}
          />
        )}
      </header>

      {/* Main Content */}
      <main className="test-lab-main">
        {selectedCategory ? (
          // Category Drill-Down View
          <CategoryDetailView
            category={currentCategory}
            results={categoryResults}
            selectedSuite={selectedSuite}
            onSelectSuite={selectSuite}
            onRunSuite={runSuite}
            isItemRunning={isItemRunning}
            running={running}
          />
        ) : (
          // Dashboard View
          <>
            {/* Component Health Grid */}
            <section className="test-lab-section">
              <h2 className="section-title">Component Health</h2>
              <div className="test-lab-grid">
                {categories.map(cat => {
                  const catResults = getCategoryResults(cat.id)
                  return (
                    <ComponentCard
                      key={cat.id}
                      category={cat}
                      results={catResults}
                      onClick={() => selectCategory(cat.id)}
                      onRun={() => runCategory(cat.id)}
                      isRunning={isItemRunning('category', cat.id)}
                      disabled={running}
                    />
                  )
                })}
              </div>
            </section>

            {/* AOCL Flow Visualizer */}
            <section className="test-lab-section">
              <h2 className="section-title">System Flow (AOCL Layers)</h2>
              <p className="section-desc">Test coverage mapped to the 9-layer orchestration flow</p>
              <div className="aocl-flow">
                {aoclLayers.map((layer, index) => (
                  <AOCLLayerCard key={layer.id} layer={layer} isLast={index === aoclLayers.length - 1} />
                ))}
              </div>
            </section>

            {/* Enterprise Compliance Promotional Section */}
            <EnterpriseComplianceSection />

            {/* Witnessed runs — read-only, server-side, WARD-witnessed (P4) */}
            <WitnessedRunHistory />
          </>
        )}
      </main>
    </div>
  )
}

/**
 * Component Card - Shows test status for a category
 */
function ComponentCard({ category, results, onClick, onRun, isRunning, disabled }) {
  const total = results?.total || 0
  const passed = results?.passed || 0
  const failed = results?.failed || 0
  const status = failed > 0 ? TestStatus.FAILED : total > 0 ? TestStatus.PASSED : TestStatus.IDLE

  return (
    <div
      className={`component-card component-card-${status}`}
      style={{ '--card-color': category.color }}
      onClick={onClick}
    >
      <button
        className={`card-run-btn ${isRunning ? 'running' : ''}`}
        onClick={(e) => { e.stopPropagation(); onRun(); }}
        disabled={disabled}
      >
        {isRunning ? '◌' : '▶'}
      </button>

      <div className="card-header">
        <span className="card-icon">{category.icon}</span>
        <span className="card-name">{category.name}</span>
      </div>

      <div className="card-body">
        {total > 0 ? (
          <div className="card-results">
            <div className={`card-status-badge status-${status}`}>
              <span className="status-icon">{getStatusIcon(status)}</span>
              <span className="status-text">
                {failed > 0 ? `${failed} failed` : `${passed} passed`}
              </span>
            </div>
            <div className="card-total">{total} tests</div>
          </div>
        ) : (
          <div className="card-empty">No results yet</div>
        )}
      </div>

      <p className="card-desc">{category.description}</p>
    </div>
  )
}

/**
 * AOCL Layer Card - Shows a layer in the flow visualizer
 */
function AOCLLayerCard({ layer, isLast }) {
  const hasTests = layer.tests > 0
  const allPassed = layer.failed === 0 && layer.passed > 0
  const status = !hasTests ? 'idle' : allPassed ? 'passed' : 'failed'

  return (
    <div className="aocl-layer-wrapper">
      <div
        className={`aocl-layer aocl-layer-${status}`}
        style={{ '--layer-color': layer.color }}
      >
        <div className="layer-number">Layer {layer.id}</div>
        <div className="layer-name">{layer.name}</div>
        <div className="layer-desc">{layer.description}</div>
        {hasTests && (
          <div className="layer-stats">
            <span className="layer-stat">
              {getStatusIcon(status === 'passed' ? TestStatus.PASSED : TestStatus.FAILED)}
              {' '}{layer.tests} tests
            </span>
            {layer.failed > 0 && (
              <span className="layer-failed">{layer.failed} failed</span>
            )}
          </div>
        )}
      </div>
      {!isLast && <div className="aocl-connector">↓</div>}
    </div>
  )
}

/**
 * Category Detail View - Shows test suites and individual tests
 */
function CategoryDetailView({ category, results, selectedSuite, onSelectSuite, onRunSuite, isItemRunning, running }) {
  if (!results) {
    return (
      <div className="category-empty">
        <p>No test results for this category yet.</p>
        <p>Run tests to see results.</p>
      </div>
    )
  }

  // Get the selected suite data
  const suiteData = selectedSuite
    ? results.suites.find(s => s.name === selectedSuite)
    : null

  if (suiteData) {
    // Show individual test details
    return (
      <div className="suite-detail">
        <div className="suite-header">
          <button className="test-lab-back-btn" onClick={() => onSelectSuite(null)}>
            ← Back to suites
          </button>
          <h3 className="suite-name">
            <span className={`suite-status suite-status-${suiteData.status}`}>
              {getStatusIcon(suiteData.status)}
            </span>
            {suiteData.name}
          </h3>
          <span className="suite-meta">
            {suiteData.tests.length} tests · {formatDuration(suiteData.duration)}
          </span>
        </div>

        <div className="test-list">
          {suiteData.tests.map((test, idx) => (
            <div
              key={idx}
              className={`test-item test-item-${test.status}`}
            >
              <span className="test-status">{getStatusIcon(test.status)}</span>
              <div className="test-info">
                <span className="test-name">{test.name}</span>
                {test.ancestorTitles?.length > 0 && (
                  <span className="test-path">{test.ancestorTitles.join(' > ')}</span>
                )}
                {test.failureMessages?.length > 0 && (
                  <pre className="test-failure">{test.failureMessages[0]}</pre>
                )}
              </div>
              <span className="test-duration">{formatDuration(test.duration)}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Show suite list
  return (
    <div className="suite-list">
      <div className="suite-list-header">
        <h3>Test Suites</h3>
        <span className="suite-list-count">{results.suites.length} files</span>
      </div>

      {results.suites.map((suite, idx) => {
        const isRunning = isItemRunning('suite', suite.name)
        const testCount = suite.tests?.length || 0
        const passedCount = suite.tests?.filter(t => t.status === TestStatus.PASSED).length || 0
        const failedCount = suite.tests?.filter(t => t.status === TestStatus.FAILED).length || 0

        return (
          <div
            key={idx}
            className={`suite-item suite-item-${suite.status}`}
            onClick={() => onSelectSuite(suite.name)}
          >
            <div className="suite-item-status">
              {getStatusIcon(suite.status)}
            </div>
            <div className="suite-item-info">
              <span className="suite-item-name">{suite.name}</span>
              <span className="suite-item-stats">
                {failedCount > 0 ? (
                  <span className="stats-failed">{failedCount} failed</span>
                ) : null}
                {passedCount > 0 ? (
                  <span className="stats-passed">{passedCount} passed</span>
                ) : null}
                <span className="stats-total">{testCount} tests</span>
              </span>
            </div>
            <span className="suite-item-duration">{formatDuration(suite.duration)}</span>
            <button
              className={`suite-run-btn ${isRunning ? 'running' : ''}`}
              onClick={(e) => { e.stopPropagation(); onRunSuite(suite.name); }}
              disabled={running}
            >
              {isRunning ? '◌' : '▶'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Format last run time relative to now
 */
function formatLastRun(isoString) {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now - date
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  return date.toLocaleDateString()
}

/**
 * Live Console Panel - Shows real-time test output
 */
function TestConsolePanel({ output, progress, running, isOpen, onToggle, onClear }) {
  const consoleRef = useRef(null)

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (consoleRef.current && isOpen) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight
    }
  }, [output, isOpen])

  const formatElapsed = (ms) => {
    const secs = Math.floor(ms / 1000)
    const mins = Math.floor(secs / 60)
    if (mins > 0) {
      return `${mins}m ${secs % 60}s`
    }
    return `${secs}s`
  }

  return (
    <div className={`test-console ${isOpen ? 'test-console--open' : 'test-console--collapsed'}`}>
      <div className="test-console__header" onClick={onToggle}>
        <div className="test-console__title">
          <span className="console-icon">{running ? '⚡' : '📋'}</span>
          <span>Console Output</span>
          {running && progress.currentFile && (
            <span className="console-current-file">
              → {progress.currentFile}
            </span>
          )}
        </div>
        <div className="test-console__status">
          {running && (
            <>
              <span className="console-elapsed">{formatElapsed(progress.elapsed)}</span>
              {progress.completed > 0 && (
                <span className="console-progress">{progress.completed} tests</span>
              )}
              <span className="console-spinner">◌</span>
            </>
          )}
          <button
            className="console-clear-btn"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            title="Clear console"
          >
            ✕
          </button>
          <span className="console-toggle">{isOpen ? '▼' : '▲'}</span>
        </div>
      </div>

      {isOpen && (
        <div className="test-console__body" ref={consoleRef}>
          {output.length === 0 ? (
            <div className="console-empty">
              {running ? 'Waiting for test output...' : 'No output yet. Run tests to see results.'}
            </div>
          ) : (
            output.map((entry, idx) => (
              <div key={idx} className={`console-entry console-entry--${entry.type}`}>
                <span className="console-time">
                  {new Date(entry.time).toLocaleTimeString()}
                </span>
                <span className="console-type">
                  {entry.type === 'pass' && '✓'}
                  {entry.type === 'fail' && '✗'}
                  {entry.type === 'error' && '⚠'}
                  {entry.type === 'file' && '📄'}
                  {entry.type === 'info' && 'ℹ'}
                  {entry.type === 'summary' && '📊'}
                </span>
                <span className="console-message">{entry.message}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Test Log Section - Shows recent test runs from AEE audit trail
 */
// TRUST-PROOF P4 (owner ruling: Test Lab -> read-only real history). This
// section shows the instance's REAL, server-side, WARD-witnessed VOLT runs
// (GET /volt/runs, org-scoped) — not browser-cached test events. It never
// executes anything and never fabricates: with no runs it says so.
function WitnessedRunHistory() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch('/collector/volt/runs?limit=50')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const list = Array.isArray(data?.runs) ? data.runs : []
      list.sort((a, b) => (b.started_at || 0) - (a.started_at || 0))
      setRuns(list)
      setError(null)
    } catch (e) {
      console.warn('[WitnessedRuns] Failed to fetch:', e)
      setRuns([])
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchRuns()
    const interval = setInterval(fetchRuns, 30000)
    return () => clearInterval(interval)
  }, [fetchRuns])

  return (
    <section className="test-lab-section">
      <div className="test-log-header">
        <h2 className="section-title">Witnessed runs on this instance</h2>
      </div>
      <p className="test-log-caption">
        Real governed runs from this instance, recorded server-side and witnessed on the WARD chain. Read-only: this is history, not a trigger. Nothing here is generated or sampled.
      </p>

      {loading ? (
        <div className="test-log-loading">Loading witnessed runs…</div>
      ) : error ? (
        <div className="test-log-empty test-log-error">
          <p>Unable to load witnessed runs</p>
          <p className="test-log-hint">The evidence service (VOLT) did not respond. No history is shown rather than a guess.</p>
        </div>
      ) : runs.length === 0 ? (
        <div className="test-log-empty">
          <p>No witnessed runs recorded on this instance yet.</p>
          <p className="test-log-hint">Governed runs (workflows and verified executions) appear here once they happen, each with its WARD chain reference.</p>
        </div>
      ) : (
        <div className="test-log-container">
          <div className="test-log-list">
            {runs.slice(0, 25).map(run => (
              <WitnessedRunItem key={run.run_id} run={run} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * One witnessed VOLT run, read-only, with its WARD chain reference.
 */
function WitnessedRunItem({ run }) {
  const status = String(run.status || 'unknown').toLowerCase()
  const icon = status === 'completed' ? '✅' : status === 'active' ? '▶️' : status === 'failed' ? '❌' : '•'
  const when = run.started_at ? new Date(run.started_at).toLocaleString() : '—'
  const head = run.head_hash ? String(run.head_hash).slice(0, 16) : null
  return (
    <div className={`test-log-item log-${status}`}>
      <span className="test-log-icon">{icon}</span>
      <div className="test-log-body">
        <div className="test-log-message">{run.corr || run.run_id}</div>
        <div className="test-log-meta">
          <span>{status}</span>
          <span>{when}</span>
          {typeof run.seq === 'number' && <span>seq {run.seq}</span>}
          {head && <span className="test-log-hash" title={run.head_hash}>head {head}…</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * Individual test log entry (LEGACY — browser test-event renderer, retained
 * only for the dev console flow; the customer-facing history is
 * WitnessedRunHistory above).
 */
function TestLogItem({ log }) {
  const { intent, payload, ts } = log
  const [expanded, setExpanded] = useState(false)

  // Determine icon and color based on intent/status
  let icon = '📋'
  let statusClass = ''
  let subtitle = null
  let hasDetails = false

  switch (intent) {
    case TEST_INTENTS.RUN_STARTED:
      icon = '▶️'
      statusClass = 'log-started'
      break
    case TEST_INTENTS.RUN_COMPLETED:
      icon = payload?.status === 'passed' ? '✅' : '❌'
      statusClass = payload?.status === 'passed' ? 'log-passed' : 'log-failed'
      hasDetails = payload?.failures?.length > 0
      break
    case TEST_INTENTS.RUN_FAILED:
      icon = '⚠️'
      statusClass = 'log-error'
      break
    case TEST_INTENTS.ANALYSIS_REQUESTED:
      icon = '🔍'
      statusClass = 'log-analysis'
      break
    default:
      icon = '📝'
  }

  // Format the main message
  let message = ''
  switch (intent) {
    case TEST_INTENTS.RUN_STARTED:
      message = 'Test run started'
      if (payload?.pattern && payload.pattern !== 'all') {
        subtitle = `Pattern: ${payload.pattern}`
      }
      if (payload?.categories?.length) {
        subtitle = payload.categories.join(', ')
      }
      break
    case TEST_INTENTS.RUN_COMPLETED:
      if (payload?.total > 0) {
        const passRate = Math.round((payload.passed / payload.total) * 100)
        message = `${payload.passed}/${payload.total} passed (${passRate}%)`
        if (payload?.failed > 0) {
          message = `${payload.failed} failed, ${payload.passed} passed`
        }
      } else {
        message = 'Test run completed'
      }
      subtitle = formatDuration(payload?.duration || 0)
      break
    case TEST_INTENTS.RUN_FAILED:
      message = 'Test run error'
      subtitle = payload?.error?.substring(0, 50) || 'Unknown error'
      break
    case TEST_INTENTS.ANALYSIS_REQUESTED:
      message = `Analyzed query`
      subtitle = payload?.query?.substring(0, 40)
      break
    default:
      message = intent?.split('.').pop() || 'Event'
  }

  return (
    <div className={`test-log-item ${statusClass} ${expanded ? 'expanded' : ''}`}>
      <span className="log-icon">{icon}</span>
      <div className="log-content">
        <div className="log-main">
          <span className="log-message">{message}</span>
          <span className="log-time">{formatLastRun(ts)}</span>
        </div>
        {subtitle && <span className="log-subtitle">{subtitle}</span>}

        {/* Failure details for completed runs */}
        {hasDetails && (
          <button
            className="log-expand-btn"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '▼' : '▶'} {payload.failureCount} failure{payload.failureCount !== 1 ? 's' : ''}
          </button>
        )}

        {expanded && payload?.failures && (
          <div className="log-failures">
            {payload.failures.map((f, idx) => (
              <div key={idx} className="log-failure-item">
                <span className="failure-suite">{f.suite}</span>
                <span className="failure-test">{f.test}</span>
                {f.message && <span className="failure-message">{f.message}</span>}
              </div>
            ))}
            {payload.failureCount > payload.failures.length && (
              <div className="log-failure-more">
                +{payload.failureCount - payload.failures.length} more failures
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Last Run Summary Card - Shows the most recent completed run
 */
function LastRunSummary({ logs }) {
  // Find most recent completed run
  const completedRun = logs.find(l => l.intent === TEST_INTENTS.RUN_COMPLETED)

  if (!completedRun) return null

  const { payload, ts } = completedRun
  const passed = payload?.passed || 0
  const failed = payload?.failed || 0
  const total = payload?.total || 0
  const duration = payload?.duration || 0
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0

  return (
    <div className={`last-run-summary ${failed > 0 ? 'has-failures' : 'all-passed'}`}>
      <div className="last-run-header">
        <span className="last-run-title">Last Run</span>
        <span className="last-run-time">{formatLastRun(ts)}</span>
      </div>
      <div className="last-run-stats">
        <div className="last-run-stat">
          <span className="stat-value">{total}</span>
          <span className="stat-label">Total</span>
        </div>
        <div className="last-run-stat passed">
          <span className="stat-value">{passed}</span>
          <span className="stat-label">Passed</span>
        </div>
        {failed > 0 && (
          <div className="last-run-stat failed">
            <span className="stat-value">{failed}</span>
            <span className="stat-label">Failed</span>
          </div>
        )}
        <div className="last-run-stat">
          <span className="stat-value">{passRate}%</span>
          <span className="stat-label">Pass Rate</span>
        </div>
        <div className="last-run-stat">
          <span className="stat-value">{formatDuration(duration)}</span>
          <span className="stat-label">Duration</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Enterprise Compliance Section - Promotional card for compliance testing features
 */
function EnterpriseComplianceSection() {
  const [expanded, setExpanded] = useState(false)

  // TRUST-PROOF P4 (FND_01M2Y1G0BM): these are the frameworks this suite's
  // evidence MAPS TOWARD, not certifications Quox holds — no ✓ that implies a
  // passed audit. Test counts were previously hardcoded (38/34/30/24 → "126+")
  // and derived from nothing; a trust surface must not invent coverage
  // numbers, so the categories are described without fabricated counts.
  const complianceStandards = [
    { id: 'soc2', name: 'SOC 2', desc: 'Service Organization Controls - Trust Services Criteria', icon: '🔒' },
    { id: 'hipaa', name: 'HIPAA', desc: 'Health Insurance Portability and Accountability Act', icon: '🏥' },
    { id: 'gdpr', name: 'GDPR', desc: 'General Data Protection Regulation', icon: '🇪🇺' },
    { id: 'fedramp', name: 'FedRAMP', desc: 'Federal Risk and Authorization Management Program', icon: '🏛️' },
  ]

  const testCoverage = [
    { category: 'Audit Logging', desc: 'Complete audit trails for all operations' },
    { category: 'AOCL Layers', desc: '11-layer orchestration system validation' },
    { category: 'Working Set Memory', desc: 'Context tracking and data handling' },
    { category: 'Capability Index', desc: 'Tool routing and permission validation' },
  ]

  return (
    <section className="test-lab-section enterprise-compliance-section">
      <div className="enterprise-compliance-header">
        <div className="compliance-header-content">
          <h2 className="section-title">
            <span className="compliance-badge">Enterprise</span>
            Compliance Testing Suite
          </h2>
          <p className="section-desc">
            Test categories whose evidence maps to common regulatory frameworks. Mapping, not certification.
          </p>
        </div>
        <button
          className="compliance-expand-btn"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show Less' : 'Learn More'}
        </button>
      </div>

      <div className="compliance-standards-grid">
        {complianceStandards.map(std => (
          <div key={std.id} className="compliance-standard-card">
            <span className="standard-icon">{std.icon}</span>
            <div className="standard-info">
              <span className="standard-name">{std.name}</span>
              <span className="standard-desc">{std.desc}</span>
            </div>
          </div>
        ))}
      </div>

      {expanded && (
        <div className="compliance-details">
          <div className="compliance-coverage">
            <h3>Test Coverage</h3>
            <p className="coverage-subtitle">
              The categories whose evidence maps to regulatory requirements. Run them to see real counts.
            </p>
            <div className="coverage-grid">
              {testCoverage.map(cat => (
                <div key={cat.category} className="coverage-item">
                  <div className="coverage-header">
                    <span className="coverage-name">{cat.category}</span>
                  </div>
                  <p className="coverage-desc">{cat.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="compliance-features">
            <h3>Enterprise Features</h3>
            <ul className="features-list">
              <li>
                <span className="feature-icon">📋</span>
                <span className="feature-text">
                  <strong>Audit Trail Validation</strong> - Every operation timestamped, actors identified, outcomes tracked
                </span>
              </li>
              <li>
                <span className="feature-icon">🏢</span>
                <span className="feature-text">
                  <strong>Organization Testing</strong> - Division/Team/User permission boundaries validated
                </span>
              </li>
              <li>
                <span className="feature-icon">👤</span>
                <span className="feature-text">
                  <strong>HITL Compliance</strong> - Human-in-the-loop approval workflows tested
                </span>
              </li>
              <li>
                <span className="feature-icon">🔐</span>
                <span className="feature-text">
                  <strong>Access Control</strong> - Blocked operations logged, elevated privileges tracked
                </span>
              </li>
              <li>
                <span className="feature-icon">📊</span>
                <span className="feature-text">
                  <strong>Data Subject Rights</strong> - Query by operator for GDPR data access requests
                </span>
              </li>
              <li>
                <span className="feature-icon">🕐</span>
                <span className="feature-text">
                  <strong>Immutable Records</strong> - Audit entries preserved with original timestamps
                </span>
              </li>
            </ul>
          </div>

          <div className="compliance-cta">
            <p>
              Run the <strong>Compliance</strong> and <strong>AOCL</strong> test categories to validate your deployment meets enterprise requirements.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

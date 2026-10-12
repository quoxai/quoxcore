/**
 * LayerTestCases - Pre-built and custom test scenarios
 *
 * Provides quick-load test cases for each AOCL layer.
 * Part of AOCL Developer Kit (Free)
 */

import { useState, useEffect } from 'react'
import {
  getTestCasesForLayer,
  saveCustomTestCase,
  deleteCustomTestCase
} from '../../services/playground'

export default function LayerTestCases({
  layerId,
  onLoadTestCase,
  onExecuteTestCase
}) {
  const [testCases, setTestCases] = useState([])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newTestCase, setNewTestCase] = useState({
    name: '',
    description: '',
    input: '{}',
    context: '{}',
    config: '{}',
    expectedStatus: 'complete'
  })
  const [createError, setCreateError] = useState(null)

  useEffect(() => {
    loadTestCases()
  }, [layerId])

  const loadTestCases = () => {
    const cases = getTestCasesForLayer(layerId)
    setTestCases(cases)
  }

  const handleCreateTestCase = () => {
    setCreateError(null)

    try {
      // Parse JSON fields
      const input = JSON.parse(newTestCase.input)
      const context = JSON.parse(newTestCase.context)
      const config = JSON.parse(newTestCase.config)

      const tc = {
        layerId,
        name: newTestCase.name || 'Custom Test',
        description: newTestCase.description || '',
        input,
        context,
        config,
        expectedStatus: newTestCase.expectedStatus
      }

      saveCustomTestCase(tc)
      loadTestCases()
      setShowCreateForm(false)
      setNewTestCase({
        name: '',
        description: '',
        input: '{}',
        context: '{}',
        config: '{}',
        expectedStatus: 'complete'
      })
    } catch (err) {
      setCreateError(`Invalid JSON: ${err.message}`)
    }
  }

  const handleDeleteTestCase = (testCaseId) => {
    if (window.confirm('Delete this test case?')) {
      deleteCustomTestCase(testCaseId)
      loadTestCases()
    }
  }

  const builtInCases = testCases.filter(tc => !tc.custom)
  const customCases = testCases.filter(tc => tc.custom)

  return (
    <div className="layer-test-cases">
      <div className="test-cases-header">
        <h4>Test Cases for {layerId}</h4>
        <button
          className="create-test-btn"
          onClick={() => setShowCreateForm(!showCreateForm)}
        >
          {showCreateForm ? 'Cancel' : '+ New Test Case'}
        </button>
      </div>

      {/* Create Form */}
      {showCreateForm && (
        <div className="create-test-form">
          <div className="form-row">
            <label>Name</label>
            <input
              type="text"
              value={newTestCase.name}
              onChange={(e) => setNewTestCase({ ...newTestCase, name: e.target.value })}
              placeholder="Test case name"
            />
          </div>
          <div className="form-row">
            <label>Description</label>
            <input
              type="text"
              value={newTestCase.description}
              onChange={(e) => setNewTestCase({ ...newTestCase, description: e.target.value })}
              placeholder="What this test verifies"
            />
          </div>
          <div className="form-row">
            <label>Input (JSON)</label>
            <textarea
              value={newTestCase.input}
              onChange={(e) => setNewTestCase({ ...newTestCase, input: e.target.value })}
              rows={3}
              placeholder='{"query": "test input"}'
            />
          </div>
          <div className="form-row">
            <label>Context (JSON)</label>
            <textarea
              value={newTestCase.context}
              onChange={(e) => setNewTestCase({ ...newTestCase, context: e.target.value })}
              rows={2}
              placeholder='{}'
            />
          </div>
          <div className="form-row">
            <label>Config (JSON)</label>
            <textarea
              value={newTestCase.config}
              onChange={(e) => setNewTestCase({ ...newTestCase, config: e.target.value })}
              rows={2}
              placeholder='{}'
            />
          </div>
          <div className="form-row">
            <label>Expected Status</label>
            <select
              value={newTestCase.expectedStatus}
              onChange={(e) => setNewTestCase({ ...newTestCase, expectedStatus: e.target.value })}
            >
              <option value="complete">Complete</option>
              <option value="bypass">Bypass</option>
              <option value="reject">Reject</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
          </div>
          {createError && (
            <div className="create-error">{createError}</div>
          )}
          <div className="form-actions">
            <button className="save-btn" onClick={handleCreateTestCase}>
              Save Test Case
            </button>
          </div>
        </div>
      )}

      {/* Built-in Test Cases */}
      {builtInCases.length > 0 && (
        <div className="test-cases-section">
          <h5>Built-in Tests</h5>
          <div className="test-cases-list">
            {builtInCases.map(tc => (
              <TestCaseCard
                key={tc.id}
                testCase={tc}
                onLoad={() => onLoadTestCase(tc)}
                onExecute={() => onExecuteTestCase(tc)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Custom Test Cases */}
      {customCases.length > 0 && (
        <div className="test-cases-section">
          <h5>Custom Tests</h5>
          <div className="test-cases-list">
            {customCases.map(tc => (
              <TestCaseCard
                key={tc.id}
                testCase={tc}
                onLoad={() => onLoadTestCase(tc)}
                onExecute={() => onExecuteTestCase(tc)}
                onDelete={() => handleDeleteTestCase(tc.id)}
                showDelete
              />
            ))}
          </div>
        </div>
      )}

      {testCases.length === 0 && !showCreateForm && (
        <div className="no-test-cases">
          <p>No test cases for this layer yet</p>
          <p className="hint">Click "+ New Test Case" to create one</p>
        </div>
      )}
    </div>
  )
}

function TestCaseCard({ testCase, onLoad, onExecute, onDelete, showDelete }) {
  const [expanded, setExpanded] = useState(false)

  const getStatusColor = (status) => {
    switch (status) {
      case 'complete': return '#22c55e'
      case 'bypass': return '#f59e0b'
      case 'reject': return '#ef4444'
      case 'warning': return '#f97316'
      case 'error': return '#dc2626'
      default: return '#6b7280'
    }
  }

  return (
    <div className="test-case-card">
      <div className="test-case-header" onClick={() => setExpanded(!expanded)}>
        <div className="test-case-info">
          <span className="test-case-name">{testCase.name}</span>
          <span
            className="expected-status"
            style={{ color: getStatusColor(testCase.expectedStatus) }}
          >
            {testCase.expectedStatus}
          </span>
        </div>
        <span className="expand-indicator">{expanded ? 'v' : '>'}</span>
      </div>

      {expanded && (
        <div className="test-case-details">
          {testCase.description && (
            <p className="test-case-description">{testCase.description}</p>
          )}

          <div className="test-case-preview">
            <div className="preview-section">
              <span className="preview-label">Input</span>
              <code>{JSON.stringify(testCase.input, null, 2)}</code>
            </div>
            {Object.keys(testCase.config || {}).length > 0 && (
              <div className="preview-section">
                <span className="preview-label">Config</span>
                <code>{JSON.stringify(testCase.config, null, 2)}</code>
              </div>
            )}
          </div>

          <div className="test-case-actions">
            <button className="load-btn" onClick={onLoad}>
              Load
            </button>
            <button className="run-btn" onClick={onExecute}>
              Run
            </button>
            {showDelete && (
              <button className="delete-btn" onClick={onDelete}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

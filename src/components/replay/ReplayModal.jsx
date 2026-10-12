/**
 * ReplayModal - Trace Replay Interface
 *
 * Allows users to replay historical traces with modifications for
 * debugging and what-if analysis.
 *
 * Part of AOCL Compliance Suite (Enterprise plugin).
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  createReplaySession,
  executeReplay,
  MOCK_PRESETS
} from '../../services/replay'
import { AOCL_LAYERS, AOCL_LAYER_ORDER } from '../../lib/aee/envelope'
import { useComplianceSuiteStatus } from '../../services/aoclPluginService'
import ReplayDiff from './ReplayDiff'
import './replay.css'

export default function ReplayModal({ isOpen, onClose, trace }) {
  const { licensed, loading: licenseLoading } = useComplianceSuiteStatus()
  const [step, setStep] = useState('configure') // configure, running, results
  const [session, setSession] = useState(null)
  const [error, setError] = useState(null)

  // Configuration state
  const [modifiedQuery, setModifiedQuery] = useState('')
  const [layerConfig, setLayerConfig] = useState({})
  const [mockResponses, setMockResponses] = useState({})
  const [selectedMockLayer, setSelectedMockLayer] = useState(null)
  const [mockInput, setMockInput] = useState('')

  // Initialize from trace
  useEffect(() => {
    if (trace) {
      setModifiedQuery(trace.query || '')
      setLayerConfig({})
      setMockResponses({})
      setStep('configure')
      setSession(null)
      setError(null)
    }
  }, [trace])

  if (!isOpen) return null

  const handleLayerToggle = (layerId) => {
    setLayerConfig(prev => ({
      ...prev,
      [layerId]: {
        ...prev[layerId],
        enabled: prev[layerId]?.enabled === false ? true : false
      }
    }))
  }

  const handleAddMock = (layerId, preset) => {
    if (preset) {
      setMockResponses(prev => ({
        ...prev,
        [layerId]: MOCK_PRESETS[preset]
      }))
    } else if (mockInput) {
      try {
        const parsed = JSON.parse(mockInput)
        setMockResponses(prev => ({
          ...prev,
          [layerId]: parsed
        }))
      } catch {
        setMockResponses(prev => ({
          ...prev,
          [layerId]: { response: mockInput }
        }))
      }
      setMockInput('')
    }
    setSelectedMockLayer(null)
  }

  const handleRemoveMock = (layerId) => {
    setMockResponses(prev => {
      const next = { ...prev }
      delete next[layerId]
      return next
    })
  }

  const handleExecute = async () => {
    setError(null)
    setStep('running')

    try {
      // Create session
      const newSession = await createReplaySession(trace.corr || trace.runId, {
        query: modifiedQuery,
        layerConfig,
        mockResponses
      })

      // Execute replay
      const completedSession = await executeReplay(newSession.id)
      setSession(completedSession)
      setStep('results')
    } catch (err) {
      setError(err.message)
      setStep('configure')
    }
  }

  const handleReset = () => {
    setStep('configure')
    setSession(null)
    setError(null)
  }

  const getLayersForConfig = () => {
    // Show layers in processing order (bottom to top visually)
    return [...AOCL_LAYER_ORDER].reverse()
  }

  return (
    <div className="replay-modal-overlay" onClick={onClose}>
      <div className="replay-modal" onClick={e => e.stopPropagation()}>
        <div className="replay-modal-header">
          <h2>
            {step === 'configure' && 'Configure Replay'}
            {step === 'running' && 'Executing Replay...'}
            {step === 'results' && 'Replay Results'}
          </h2>
          <button className="replay-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="replay-modal-body">
          {/* License Warning */}
          {!licenseLoading && !licensed && (
            <div className="replay-warning">
              <strong>License Required</strong>
              <p>
                Trace Replay requires AOCL Compliance Suite.
                <Link to="/settings#plugins" className="replay-upgrade-link">Upgrade Now</Link>
              </p>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="replay-error">
              {error}
            </div>
          )}

          {/* Configure Step */}
          {step === 'configure' && (
            <>
              {/* Original Trace Info */}
              <div className="replay-section">
                <h3>Original Trace</h3>
                <div className="replay-trace-info">
                  <div className="replay-trace-row">
                    <span className="replay-label">Run ID:</span>
                    <code>{trace?.runId || trace?.corr || 'Unknown'}</code>
                  </div>
                  <div className="replay-trace-row">
                    <span className="replay-label">Duration:</span>
                    <span>{trace?.duration_ms || 0}ms</span>
                  </div>
                </div>
              </div>

              {/* Query Modification */}
              <div className="replay-section">
                <h3>Query</h3>
                <textarea
                  className="replay-query-input"
                  value={modifiedQuery}
                  onChange={e => setModifiedQuery(e.target.value)}
                  placeholder="Enter query text..."
                  rows={3}
                />
                {modifiedQuery !== (trace?.query || '') && (
                  <div className="replay-modified-badge">Modified</div>
                )}
              </div>

              {/* Layer Configuration */}
              <div className="replay-section">
                <h3>Layer Configuration</h3>
                <div className="replay-layer-grid">
                  {getLayersForConfig().map(layerId => {
                    const layer = AOCL_LAYERS[layerId]
                    const isEnabled = layerConfig[layerId]?.enabled !== false
                    const hasMock = !!mockResponses[layerId]

                    return (
                      <div
                        key={layerId}
                        className={`replay-layer-item ${!isEnabled ? 'disabled' : ''} ${hasMock ? 'mocked' : ''}`}
                      >
                        <div className="replay-layer-header">
                          <label className="replay-layer-toggle">
                            <input
                              type="checkbox"
                              checked={isEnabled}
                              onChange={() => handleLayerToggle(layerId)}
                            />
                            <span
                              className="replay-layer-dot"
                              style={{ background: layer?.color }}
                            />
                            <span className="replay-layer-id">{layerId}</span>
                            <span className="replay-layer-name">{layer?.label}</span>
                          </label>
                          <div className="replay-layer-actions">
                            {hasMock ? (
                              <button
                                className="replay-btn-small danger"
                                onClick={() => handleRemoveMock(layerId)}
                              >
                                Remove Mock
                              </button>
                            ) : (
                              <button
                                className="replay-btn-small"
                                onClick={() => setSelectedMockLayer(layerId)}
                              >
                                + Mock
                              </button>
                            )}
                          </div>
                        </div>
                        {hasMock && (
                          <div className="replay-mock-preview">
                            <code>{JSON.stringify(mockResponses[layerId]).slice(0, 60)}...</code>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Mock Configuration Modal */}
              {selectedMockLayer && (
                <div className="replay-mock-config">
                  <h4>Configure Mock for {selectedMockLayer}</h4>

                  <div className="replay-mock-presets">
                    <span>Presets:</span>
                    {Object.keys(MOCK_PRESETS)
                      .filter(p => p.startsWith(selectedMockLayer))
                      .map(preset => (
                        <button
                          key={preset}
                          className="replay-btn-small"
                          onClick={() => handleAddMock(selectedMockLayer, preset)}
                        >
                          {preset.replace(`${selectedMockLayer}_`, '')}
                        </button>
                      ))}
                  </div>

                  <div className="replay-mock-custom">
                    <textarea
                      placeholder="Custom JSON response or text..."
                      value={mockInput}
                      onChange={e => setMockInput(e.target.value)}
                      rows={3}
                    />
                    <div className="replay-mock-actions">
                      <button
                        className="replay-btn-secondary"
                        onClick={() => setSelectedMockLayer(null)}
                      >
                        Cancel
                      </button>
                      <button
                        className="replay-btn-primary"
                        onClick={() => handleAddMock(selectedMockLayer)}
                        disabled={!mockInput}
                      >
                        Apply Mock
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Running Step */}
          {step === 'running' && (
            <div className="replay-running">
              <div className="replay-spinner" />
              <p>Executing replay with {Object.keys(mockResponses).length} mocks...</p>
              <p className="replay-running-detail">
                {Object.keys(layerConfig).filter(k => layerConfig[k]?.enabled === false).length} layers disabled
              </p>
            </div>
          )}

          {/* Results Step */}
          {step === 'results' && session && (
            <ReplayDiff session={session} />
          )}
        </div>

        <div className="replay-modal-footer">
          {step === 'configure' && (
            <>
              <button className="replay-btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="replay-btn-primary"
                onClick={handleExecute}
                disabled={!licensed}
              >
                Execute Replay
              </button>
            </>
          )}

          {step === 'running' && (
            <button className="replay-btn-secondary" disabled>
              Please wait...
            </button>
          )}

          {step === 'results' && (
            <>
              <button className="replay-btn-secondary" onClick={handleReset}>
                New Replay
              </button>
              <button className="replay-btn-primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

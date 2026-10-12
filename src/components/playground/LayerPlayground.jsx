/**
 * LayerPlayground - Interactive AOCL Layer Testing Sandbox
 *
 * Test individual AOCL layers in isolation with custom inputs.
 * Part of AOCL Developer Kit (Free)
 */

import { useState, useCallback } from 'react'
import {
  executeLayerInIsolation,
  getLayerMetadata,
  getTestCasesForLayer
} from '../../services/playground'
import { AOCL_LAYERS } from '../../lib/aee'
import PlaygroundInputPanel from './PlaygroundInputPanel'
import PlaygroundOutputPanel from './PlaygroundOutputPanel'
import LayerTestCases from './LayerTestCases'
import './playground.css'

export default function LayerPlayground() {
  const [selectedLayer, setSelectedLayer] = useState('L0')
  const [input, setInput] = useState({ query: '' })
  const [context, setContext] = useState({})
  const [config, setConfig] = useState({})
  const [result, setResult] = useState(null)
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionHistory, setExecutionHistory] = useState([])
  const [activeTab, setActiveTab] = useState('input')

  const layers = getLayerMetadata()

  const handleExecute = useCallback(async () => {
    setIsExecuting(true)
    setResult(null)

    try {
      const execResult = await executeLayerInIsolation(
        selectedLayer,
        input,
        context,
        config
      )

      setResult(execResult)

      // Add to history
      setExecutionHistory(prev => [{
        id: Date.now(),
        layerId: selectedLayer,
        timestamp: new Date().toISOString(),
        success: execResult.success,
        duration: execResult.timing?.duration_ms || 0,
        input: { ...input },
        result: execResult
      }, ...prev.slice(0, 19)]) // Keep last 20

      setActiveTab('output')
    } catch (err) {
      setResult({
        success: false,
        error: err.message
      })
    } finally {
      setIsExecuting(false)
    }
  }, [selectedLayer, input, context, config])

  const handleLoadTestCase = useCallback((testCase) => {
    setInput(testCase.input || {})
    setContext(testCase.context || {})
    setConfig(testCase.config || {})
    setActiveTab('input')
  }, [])

  const handleClearAll = useCallback(() => {
    setInput({ query: '' })
    setContext({})
    setConfig({})
    setResult(null)
  }, [])

  const handleReplayFromHistory = useCallback((historyItem) => {
    setSelectedLayer(historyItem.layerId)
    setInput(historyItem.input)
    setResult(historyItem.result)
    setActiveTab('output')
  }, [])

  const selectedLayerDef = AOCL_LAYERS[selectedLayer]

  return (
    <div className="layer-playground">
      {/* Header */}
      <div className="playground-header">
        <div className="playground-title">
          <h2>Layer Playground</h2>
          <span className="playground-subtitle">AOCL Developer Kit</span>
        </div>
        <div className="playground-actions">
          <button
            className="clear-btn"
            onClick={handleClearAll}
            disabled={isExecuting}
          >
            Clear All
          </button>
          <button
            className="execute-btn"
            onClick={handleExecute}
            disabled={isExecuting}
          >
            {isExecuting ? 'Executing...' : 'Execute Layer'}
          </button>
        </div>
      </div>

      {/* Layer Selector */}
      <div className="layer-selector">
        <div className="layer-tabs">
          {layers.map(layer => (
            <button
              key={layer.id}
              className={`layer-tab ${selectedLayer === layer.id ? 'active' : ''}`}
              onClick={() => setSelectedLayer(layer.id)}
              style={{ '--layer-color': layer.color }}
            >
              <span className="layer-id">{layer.id}</span>
              <span className="layer-name">{layer.label}</span>
            </button>
          ))}
        </div>

        {/* Selected Layer Info */}
        {selectedLayerDef && (
          <div className="selected-layer-info">
            <div
              className="layer-color-bar"
              style={{ backgroundColor: selectedLayerDef.color }}
            />
            <div className="layer-details">
              <span className="layer-full-name">{selectedLayerDef.name}</span>
              <span className="layer-description">
                {getLayerDescription(selectedLayer)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="playground-content">
        {/* Tab Navigation */}
        <div className="content-tabs">
          <button
            className={`content-tab ${activeTab === 'input' ? 'active' : ''}`}
            onClick={() => setActiveTab('input')}
          >
            Input
          </button>
          <button
            className={`content-tab ${activeTab === 'output' ? 'active' : ''}`}
            onClick={() => setActiveTab('output')}
          >
            Output
            {result && (
              <span className={`result-indicator ${result.success ? 'success' : 'error'}`} />
            )}
          </button>
          <button
            className={`content-tab ${activeTab === 'tests' ? 'active' : ''}`}
            onClick={() => setActiveTab('tests')}
          >
            Test Cases
          </button>
          <button
            className={`content-tab ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            History ({executionHistory.length})
          </button>
        </div>

        {/* Tab Content */}
        <div className="tab-content">
          {activeTab === 'input' && (
            <PlaygroundInputPanel
              layerId={selectedLayer}
              input={input}
              context={context}
              config={config}
              onInputChange={setInput}
              onContextChange={setContext}
              onConfigChange={setConfig}
            />
          )}

          {activeTab === 'output' && (
            <PlaygroundOutputPanel
              result={result}
              isExecuting={isExecuting}
            />
          )}

          {activeTab === 'tests' && (
            <LayerTestCases
              layerId={selectedLayer}
              onLoadTestCase={handleLoadTestCase}
              onExecuteTestCase={async (tc) => {
                handleLoadTestCase(tc)
                // Small delay to let state update
                setTimeout(() => handleExecute(), 100)
              }}
            />
          )}

          {activeTab === 'history' && (
            <div className="execution-history">
              {executionHistory.length === 0 ? (
                <div className="history-empty">
                  <p>No execution history yet</p>
                  <p className="hint">Execute a layer to see results here</p>
                </div>
              ) : (
                <div className="history-list">
                  {executionHistory.map(item => (
                    <div
                      key={item.id}
                      className={`history-item ${item.success ? 'success' : 'error'}`}
                      onClick={() => handleReplayFromHistory(item)}
                    >
                      <div className="history-item-header">
                        <span className="history-layer">{item.layerId}</span>
                        <span className={`history-status ${item.success ? 'success' : 'error'}`}>
                          {item.success ? 'OK' : 'ERR'}
                        </span>
                        <span className="history-duration">{item.duration}ms</span>
                      </div>
                      <div className="history-item-time">
                        {new Date(item.timestamp).toLocaleTimeString()}
                      </div>
                      <div className="history-item-input">
                        {JSON.stringify(item.input).slice(0, 50)}...
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Helper to get layer descriptions
function getLayerDescription(layerId) {
  const descriptions = {
    L0: 'Normalizes and sanitizes incoming queries',
    L2: 'Routes queries to appropriate handlers based on patterns',
    L3: 'Enforces security policies and rate limits',
    L5: 'Retrieves relevant context from memory and RAG',
    L7: 'Delegates execution to LLM or external services',
    L8: 'Verifies response quality and safety',
    L9: 'Assembles and formats the final response',
    L10: 'Records audit trail and metrics'
  }
  return descriptions[layerId] || 'AOCL processing layer'
}

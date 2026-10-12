/**
 * PlaygroundInputPanel - Input configuration for layer execution
 *
 * Provides query, context, and config editors for the playground.
 * Part of AOCL Developer Kit (Free)
 */

import { useState, useEffect } from 'react'

// Layer-specific config schemas
const LAYER_CONFIG_SCHEMAS = {
  L0: [],
  L2: [
    { key: 'minConfidence', type: 'number', label: 'Min Confidence', default: 0.7, min: 0, max: 1, step: 0.1 }
  ],
  L3: [
    { key: 'simulateRateLimit', type: 'boolean', label: 'Simulate Rate Limit', default: false },
    { key: 'simulateOutOfScope', type: 'boolean', label: 'Simulate Out of Scope', default: false },
    { key: 'maxQueryLength', type: 'number', label: 'Max Query Length', default: 10000, min: 100, max: 100000 }
  ],
  L5: [
    { key: 'disableEpisodic', type: 'boolean', label: 'Disable Episodic Memory', default: false },
    { key: 'disableSemantic', type: 'boolean', label: 'Disable Semantic Memory', default: false },
    { key: 'disableEntity', type: 'boolean', label: 'Disable Entity Memory', default: false },
    { key: 'disableRAG', type: 'boolean', label: 'Disable RAG', default: false }
  ],
  L7: [
    { key: 'provider', type: 'select', label: 'Provider', default: 'claude', options: ['claude', 'openai', 'local'] },
    { key: 'model', type: 'text', label: 'Model', default: 'claude-3-opus' },
    { key: 'mockResponse', type: 'textarea', label: 'Mock Response', default: '' },
    { key: 'simulateError', type: 'boolean', label: 'Simulate Error', default: false },
    { key: 'simulateTimeout', type: 'boolean', label: 'Simulate Timeout', default: false }
  ],
  L8: [
    { key: 'minLength', type: 'number', label: 'Min Response Length', default: 10, min: 0 },
    { key: 'maxLength', type: 'number', label: 'Max Response Length', default: 50000, min: 100 }
  ],
  L9: [
    { key: 'format', type: 'select', label: 'Output Format', default: 'markdown', options: ['markdown', 'text', 'html', 'json'] },
    { key: 'addStyling', type: 'boolean', label: 'Add Styling', default: false }
  ],
  L10: [
    { key: 'destination', type: 'select', label: 'Audit Destination', default: 'local', options: ['local', 'remote', 'both'] }
  ]
}

// Layer-specific input field requirements
const LAYER_INPUT_FIELDS = {
  L0: ['query'],
  L2: ['query', 'normalizedQuery'],
  L3: ['query', 'normalizedQuery'],
  L5: ['query', 'normalizedQuery'],
  L7: ['query'],
  L8: ['response'],
  L9: ['response', 'contextItems'],
  L10: ['layersExecuted', 'totalDuration', 'status']
}

export default function PlaygroundInputPanel({
  layerId,
  input,
  context,
  config,
  onInputChange,
  onContextChange,
  onConfigChange
}) {
  const [jsonMode, setJsonMode] = useState(false)
  const [inputJson, setInputJson] = useState('')
  const [contextJson, setContextJson] = useState('')
  const [jsonError, setJsonError] = useState(null)

  const configSchema = LAYER_CONFIG_SCHEMAS[layerId] || []
  const inputFields = LAYER_INPUT_FIELDS[layerId] || ['query']

  // Sync JSON mode
  useEffect(() => {
    if (jsonMode) {
      setInputJson(JSON.stringify(input, null, 2))
      setContextJson(JSON.stringify(context, null, 2))
    }
  }, [jsonMode, input, context])

  const handleInputFieldChange = (field, value) => {
    onInputChange({ ...input, [field]: value })
  }

  const handleConfigChange = (key, value) => {
    onConfigChange({ ...config, [key]: value })
  }

  const handleJsonApply = () => {
    try {
      const parsedInput = JSON.parse(inputJson)
      const parsedContext = JSON.parse(contextJson)
      onInputChange(parsedInput)
      onContextChange(parsedContext)
      setJsonError(null)
    } catch (err) {
      setJsonError(err.message)
    }
  }

  return (
    <div className="playground-input-panel">
      {/* Mode Toggle */}
      <div className="panel-header">
        <span className="panel-title">Input Configuration</span>
        <div className="mode-toggle">
          <button
            className={`mode-btn ${!jsonMode ? 'active' : ''}`}
            onClick={() => setJsonMode(false)}
          >
            Form
          </button>
          <button
            className={`mode-btn ${jsonMode ? 'active' : ''}`}
            onClick={() => setJsonMode(true)}
          >
            JSON
          </button>
        </div>
      </div>

      {jsonMode ? (
        /* JSON Mode */
        <div className="json-editors">
          <div className="json-section">
            <label>Input JSON</label>
            <textarea
              className="json-editor"
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="json-section">
            <label>Context JSON</label>
            <textarea
              className="json-editor"
              value={contextJson}
              onChange={(e) => setContextJson(e.target.value)}
              spellCheck={false}
            />
          </div>
          {jsonError && (
            <div className="json-error">JSON Error: {jsonError}</div>
          )}
          <button className="apply-json-btn" onClick={handleJsonApply}>
            Apply JSON
          </button>
        </div>
      ) : (
        /* Form Mode */
        <div className="form-editors">
          {/* Input Fields */}
          <div className="form-section">
            <h4>Input</h4>
            {inputFields.map(field => (
              <div key={field} className="form-field">
                <label>{formatFieldName(field)}</label>
                {field === 'contextItems' || field === 'layersExecuted' ? (
                  <textarea
                    value={typeof input[field] === 'object' ? JSON.stringify(input[field], null, 2) : input[field] || ''}
                    onChange={(e) => {
                      try {
                        const val = JSON.parse(e.target.value)
                        handleInputFieldChange(field, val)
                      } catch {
                        handleInputFieldChange(field, e.target.value)
                      }
                    }}
                    rows={3}
                    placeholder={`Enter ${field} (JSON array or value)`}
                  />
                ) : field === 'totalDuration' ? (
                  <input
                    type="number"
                    value={input[field] || ''}
                    onChange={(e) => handleInputFieldChange(field, parseInt(e.target.value) || 0)}
                    placeholder="Duration in ms"
                  />
                ) : field === 'status' ? (
                  <select
                    value={input[field] || 'complete'}
                    onChange={(e) => handleInputFieldChange(field, e.target.value)}
                  >
                    <option value="complete">Complete</option>
                    <option value="error">Error</option>
                    <option value="partial">Partial</option>
                  </select>
                ) : (
                  <textarea
                    value={input[field] || ''}
                    onChange={(e) => handleInputFieldChange(field, e.target.value)}
                    rows={field === 'query' || field === 'response' ? 4 : 2}
                    placeholder={`Enter ${field}...`}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Context Fields */}
          <div className="form-section">
            <h4>Context</h4>
            <div className="form-field">
              <label>Run ID</label>
              <input
                type="text"
                value={context.runId || ''}
                onChange={(e) => onContextChange({ ...context, runId: e.target.value })}
                placeholder="e.g., RUN_001"
              />
            </div>
            <div className="form-field">
              <label>User</label>
              <input
                type="text"
                value={context.user || ''}
                onChange={(e) => onContextChange({ ...context, user: e.target.value })}
                placeholder="e.g., test_user"
              />
            </div>
            <div className="form-field">
              <label>Agent</label>
              <input
                type="text"
                value={context.agent || ''}
                onChange={(e) => onContextChange({ ...context, agent: e.target.value })}
                placeholder="e.g., quox"
              />
            </div>
          </div>

          {/* Config Fields */}
          {configSchema.length > 0 && (
            <div className="form-section">
              <h4>Layer Config</h4>
              {configSchema.map(field => (
                <div key={field.key} className="form-field">
                  <label>{field.label}</label>
                  {field.type === 'boolean' ? (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={config[field.key] ?? field.default}
                        onChange={(e) => handleConfigChange(field.key, e.target.checked)}
                      />
                      <span className="checkbox-text">
                        {config[field.key] ?? field.default ? 'Enabled' : 'Disabled'}
                      </span>
                    </label>
                  ) : field.type === 'number' ? (
                    <input
                      type="number"
                      value={config[field.key] ?? field.default}
                      onChange={(e) => handleConfigChange(field.key, parseFloat(e.target.value))}
                      min={field.min}
                      max={field.max}
                      step={field.step || 1}
                    />
                  ) : field.type === 'select' ? (
                    <select
                      value={config[field.key] ?? field.default}
                      onChange={(e) => handleConfigChange(field.key, e.target.value)}
                    >
                      {field.options.map(opt => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : field.type === 'textarea' ? (
                    <textarea
                      value={config[field.key] ?? field.default}
                      onChange={(e) => handleConfigChange(field.key, e.target.value)}
                      rows={3}
                      placeholder={`Enter ${field.label.toLowerCase()}...`}
                    />
                  ) : (
                    <input
                      type="text"
                      value={config[field.key] ?? field.default}
                      onChange={(e) => handleConfigChange(field.key, e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatFieldName(field) {
  return field
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/^./, str => str.toUpperCase())
    .trim()
}

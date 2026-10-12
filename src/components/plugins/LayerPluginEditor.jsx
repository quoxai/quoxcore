/**
 * LayerPluginEditor - Create and Edit AOCL Layer Plugins
 *
 * Code editor for plugin development with validation and testing.
 * Part of AOCL Developer Kit (Free)
 */

import { useState, useEffect, useCallback } from 'react'
import {
  createPluginTemplate,
  validatePlugin,
  getValidationSummary,
  registerLayerPlugin,
  updatePlugin,
  downloadPlugin,
  VALID_LAYER_POSITIONS,
  VALID_POSITION_MODES,
  REFERENCE_LAYERS
} from '../../services/layers'
import { executeLayerInIsolation } from '../../services/playground'

export default function LayerPluginEditor({ editingPlugin, onSave, onCancel }) {
  const [manifest, setManifest] = useState({
    id: '',
    name: '',
    version: '1.0.0',
    author: '',
    description: '',
    layer: {
      position: 'L4',
      positionMode: 'after',
      referenceLayer: 'L3'
    },
    configSchema: {}
  })
  const [code, setCode] = useState('')
  const [validation, setValidation] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const [testInput, setTestInput] = useState('{ "query": "test input" }')
  const [testConfig, setTestConfig] = useState('{}')
  const [activeTab, setActiveTab] = useState('manifest')
  const [isTesting, setIsTesting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // Load editing plugin or template
  useEffect(() => {
    if (editingPlugin) {
      setManifest({
        id: editingPlugin.id,
        name: editingPlugin.name,
        version: editingPlugin.version,
        author: editingPlugin.author,
        description: editingPlugin.description,
        layer: editingPlugin.layer || {},
        configSchema: editingPlugin.configSchema || {}
      })
      setCode(editingPlugin.executeCode || editingPlugin.execute || '')
    } else {
      // Load basic template
      const template = createPluginTemplate('basic')
      setManifest({
        id: template.id,
        name: template.name,
        version: template.version,
        author: template.author,
        description: template.description,
        layer: template.layer,
        configSchema: template.configSchema
      })
      setCode(template.execute)
    }
  }, [editingPlugin])

  // Validate on changes
  useEffect(() => {
    const timer = setTimeout(() => {
      const result = validatePlugin({
        ...manifest,
        execute: code
      })
      setValidation(getValidationSummary(result))
    }, 500)

    return () => clearTimeout(timer)
  }, [manifest, code])

  const handleManifestChange = (field, value) => {
    setManifest(prev => ({ ...prev, [field]: value }))
  }

  const handleLayerChange = (field, value) => {
    setManifest(prev => ({
      ...prev,
      layer: { ...prev.layer, [field]: value }
    }))
  }

  const handleLoadTemplate = (type) => {
    const template = createPluginTemplate(type)
    setManifest({
      id: template.id,
      name: template.name,
      version: template.version,
      author: template.author,
      description: template.description,
      layer: template.layer,
      configSchema: template.configSchema
    })
    setCode(template.execute)
  }

  const handleTest = async () => {
    setIsTesting(true)
    setTestResult(null)

    try {
      // Parse test inputs
      const input = JSON.parse(testInput)
      const config = JSON.parse(testConfig)

      // Create a temporary executor
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
      const executor = new AsyncFunction('ctx', `
        const { utils, context, input, config } = ctx;
        const { delay, log, warn, error, now, uuid } = utils;
        const pluginFn = ${code};
        return await pluginFn(ctx);
      `)

      const ctx = {
        utils: {
          delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
          log: console.log,
          warn: console.warn,
          error: console.error,
          now: () => Date.now(),
          uuid: () => `TEST_${Date.now()}`
        },
        context: { environment: 'test' },
        input,
        config
      }

      const startTime = Date.now()
      const result = await executor(ctx)
      const duration = Date.now() - startTime

      setTestResult({
        success: true,
        result,
        duration
      })
    } catch (err) {
      setTestResult({
        success: false,
        error: err.message
      })
    } finally {
      setIsTesting(false)
    }
  }

  const handleSave = async () => {
    setIsSaving(true)

    try {
      const plugin = {
        ...manifest,
        execute: code
      }

      let result
      if (editingPlugin) {
        result = updatePlugin(editingPlugin.id, {
          ...manifest,
          executeCode: code
        })
      } else {
        result = registerLayerPlugin(plugin)
      }

      if (result.success) {
        onSave?.()
      } else {
        alert(`Failed to save: ${result.error}`)
      }
    } catch (err) {
      alert(`Error: ${err.message}`)
    } finally {
      setIsSaving(false)
    }
  }

  const handleExport = (format) => {
    downloadPlugin({
      ...manifest,
      execute: code
    }, format)
  }

  return (
    <div className="layer-plugin-editor">
      {/* Toolbar */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <span className="editor-title">
            {editingPlugin ? `Editing: ${editingPlugin.name}` : 'New Plugin'}
          </span>
        </div>

        <div className="toolbar-center">
          {!editingPlugin && (
            <div className="template-selector">
              <label>Template:</label>
              <select onChange={(e) => handleLoadTemplate(e.target.value)}>
                <option value="basic">Basic</option>
                <option value="filter">Content Filter</option>
                <option value="validator">Response Validator</option>
                <option value="transformer">Response Transformer</option>
              </select>
            </div>
          )}
        </div>

        <div className="toolbar-right">
          {validation && (
            <span className={`validation-badge ${validation.status}`}>
              {validation.status === 'success' ? '[v]' : validation.status === 'warning' ? '[!]' : '[x]'}
            </span>
          )}
          <button className="toolbar-btn" onClick={() => handleExport('json')}>
            Export JSON
          </button>
          <button
            className="toolbar-btn primary"
            onClick={handleSave}
            disabled={isSaving || validation?.status === 'error'}
          >
            {isSaving ? 'Saving...' : 'Save Plugin'}
          </button>
          {onCancel && (
            <button className="toolbar-btn" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Validation Messages */}
      {validation && validation.details.length > 0 && (
        <div className={`validation-messages ${validation.status}`}>
          {validation.details.map((msg, i) => (
            <div key={i} className="validation-message">{msg}</div>
          ))}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="editor-tabs">
        <button
          className={`editor-tab ${activeTab === 'manifest' ? 'active' : ''}`}
          onClick={() => setActiveTab('manifest')}
        >
          Manifest
        </button>
        <button
          className={`editor-tab ${activeTab === 'code' ? 'active' : ''}`}
          onClick={() => setActiveTab('code')}
        >
          Code
        </button>
        <button
          className={`editor-tab ${activeTab === 'config' ? 'active' : ''}`}
          onClick={() => setActiveTab('config')}
        >
          Config Schema
        </button>
        <button
          className={`editor-tab ${activeTab === 'test' ? 'active' : ''}`}
          onClick={() => setActiveTab('test')}
        >
          Test
        </button>
      </div>

      {/* Tab Content */}
      <div className="editor-content">
        {/* Manifest Tab */}
        {activeTab === 'manifest' && (
          <div className="manifest-form">
            <div className="form-row">
              <label>Plugin ID</label>
              <input
                type="text"
                value={manifest.id}
                onChange={(e) => handleManifestChange('id', e.target.value)}
                placeholder="my-plugin-id"
                disabled={!!editingPlugin}
              />
              <span className="field-hint">Lowercase letters, numbers, hyphens only</span>
            </div>

            <div className="form-row">
              <label>Name</label>
              <input
                type="text"
                value={manifest.name}
                onChange={(e) => handleManifestChange('name', e.target.value)}
                placeholder="My Plugin Name"
              />
            </div>

            <div className="form-row-group">
              <div className="form-row">
                <label>Version</label>
                <input
                  type="text"
                  value={manifest.version}
                  onChange={(e) => handleManifestChange('version', e.target.value)}
                  placeholder="1.0.0"
                />
              </div>

              <div className="form-row">
                <label>Author</label>
                <input
                  type="text"
                  value={manifest.author}
                  onChange={(e) => handleManifestChange('author', e.target.value)}
                  placeholder="Your Name"
                />
              </div>
            </div>

            <div className="form-row">
              <label>Description</label>
              <textarea
                value={manifest.description}
                onChange={(e) => handleManifestChange('description', e.target.value)}
                placeholder="What does this plugin do?"
                rows={3}
              />
            </div>

            <div className="form-section">
              <h4>Layer Configuration</h4>

              <div className="form-row-group">
                <div className="form-row">
                  <label>Position</label>
                  <select
                    value={manifest.layer?.position || 'L4'}
                    onChange={(e) => handleLayerChange('position', e.target.value)}
                  >
                    {VALID_LAYER_POSITIONS.map(pos => (
                      <option key={pos} value={pos}>{pos}</option>
                    ))}
                  </select>
                </div>

                <div className="form-row">
                  <label>Mode</label>
                  <select
                    value={manifest.layer?.positionMode || 'after'}
                    onChange={(e) => handleLayerChange('positionMode', e.target.value)}
                  >
                    {VALID_POSITION_MODES.map(mode => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                </div>

                <div className="form-row">
                  <label>Reference Layer</label>
                  <select
                    value={manifest.layer?.referenceLayer || 'L3'}
                    onChange={(e) => handleLayerChange('referenceLayer', e.target.value)}
                  >
                    {REFERENCE_LAYERS.map(ref => (
                      <option key={ref} value={ref}>{ref}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Code Tab */}
        {activeTab === 'code' && (
          <div className="code-editor-wrapper">
            <div className="code-header">
              <span className="code-hint">
                Write an async function that receives ctx (utils, context, input, config)
              </span>
            </div>
            <textarea
              className="code-editor"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              spellCheck={false}
              placeholder={`async (ctx) => {
  const { input, config, utils } = ctx;

  // Your plugin logic here

  return {
    status: 'complete',
    result: {}
  };
}`}
            />
          </div>
        )}

        {/* Config Schema Tab */}
        {activeTab === 'config' && (
          <div className="config-schema-editor">
            <div className="schema-header">
              <span>Define configuration options for your plugin</span>
            </div>
            <textarea
              className="schema-json-editor"
              value={JSON.stringify(manifest.configSchema, null, 2)}
              onChange={(e) => {
                try {
                  const schema = JSON.parse(e.target.value)
                  handleManifestChange('configSchema', schema)
                } catch {}
              }}
              spellCheck={false}
              placeholder={`{
  "optionName": {
    "type": "string",
    "default": "value",
    "description": "Option description"
  }
}`}
            />
          </div>
        )}

        {/* Test Tab */}
        {activeTab === 'test' && (
          <div className="test-panel">
            <div className="test-inputs">
              <div className="test-input-section">
                <label>Test Input (JSON)</label>
                <textarea
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  rows={4}
                  placeholder='{ "query": "test" }'
                />
              </div>

              <div className="test-input-section">
                <label>Test Config (JSON)</label>
                <textarea
                  value={testConfig}
                  onChange={(e) => setTestConfig(e.target.value)}
                  rows={3}
                  placeholder='{}'
                />
              </div>

              <button
                className="test-run-btn"
                onClick={handleTest}
                disabled={isTesting}
              >
                {isTesting ? 'Running...' : 'Run Test'}
              </button>
            </div>

            {testResult && (
              <div className={`test-result ${testResult.success ? 'success' : 'error'}`}>
                <div className="test-result-header">
                  <span className="test-status">
                    {testResult.success ? 'Test Passed' : 'Test Failed'}
                  </span>
                  {testResult.duration && (
                    <span className="test-duration">{testResult.duration}ms</span>
                  )}
                </div>
                <pre className="test-result-content">
                  {testResult.success
                    ? JSON.stringify(testResult.result, null, 2)
                    : testResult.error}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

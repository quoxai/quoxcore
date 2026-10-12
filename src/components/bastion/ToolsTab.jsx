/**
 * ToolsTab - Browse and run bastion tools
 */

import { useState, useEffect, useCallback } from 'react'
import * as bastionClient from '../../services/bastionClient'

const WrenchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>
)

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
)

const CATEGORY_COLORS = {
  setup: '#fbbf24',
  install: '#22c55e',
  security: '#ef4444',
  monitoring: '#38bdf8',
  utility: '#c084fc'
}

export default function ToolsTab({ hosts = [], groups = [], showNotification }) {
  const [tools, setTools] = useState([])
  const [selectedTool, setSelectedTool] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [targetType, setTargetType] = useState('all')
  const [targetValue, setTargetValue] = useState('')
  const [params, setParams] = useState({})

  useEffect(() => {
    loadTools()
  }, [])

  const loadTools = useCallback(async () => {
    try {
      setLoading(true)
      const data = await bastionClient.listTools()
      setTools(data)
      if (data.length > 0 && !selectedTool) {
        setSelectedTool(data[0])
      }
    } catch (err) {
      console.error('[ToolsTab] Failed to load tools:', err)
    } finally {
      setLoading(false)
    }
  }, [selectedTool])

  const handleSelectTool = useCallback((tool) => {
    setSelectedTool(tool)
    setResult(null)
    setParams({})
    // Set defaults from form fields
    const defaults = {}
    if (tool.form_fields) {
      tool.form_fields.forEach(f => {
        if (f.default) defaults[f.key] = f.default
      })
    }
    setParams(defaults)
  }, [])

  const handleRunTool = useCallback(async () => {
    if (!selectedTool) return
    setRunning(true)
    setResult(null)
    try {
      const runParams = {
        tool_id: selectedTool.id,
        params
      }
      if (targetType === 'all') {
        runParams.all = true
      } else if (targetType === 'group') {
        runParams.group = targetValue
      } else if (targetType === 'host') {
        runParams.hosts = [targetValue]
      }

      const res = await bastionClient.runTool(runParams)
      setResult(res)
      showNotification?.(`Tool "${selectedTool.name}" completed`, 'success')
    } catch (err) {
      setResult({ error: err.message })
      showNotification?.(`Tool failed: ${err.message}`, 'error')
    } finally {
      setRunning(false)
    }
  }, [selectedTool, targetType, targetValue, params, showNotification])

  // Group tools by category
  const toolsByCategory = tools.reduce((acc, tool) => {
    const cat = tool.category || 'utility'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(tool)
    return acc
  }, {})

  if (loading) {
    return <div className="bastion-tools-loading">Loading tools registry...</div>
  }

  return (
    <div className="bastion-tools-tab">
      <div className="bastion-tools-layout">
        {/* Left: Tool list */}
        <div className="bastion-tools-list">
          <div className="bastion-tools-list-header">
            <WrenchIcon />
            <span>Tools Registry ({tools.length})</span>
          </div>
          {Object.entries(toolsByCategory).map(([category, catTools]) => (
            <div key={category} className="bastion-tools-category">
              <div className="bastion-tools-category-header" style={{ color: CATEGORY_COLORS[category] || '#71717a' }}>
                {category}
              </div>
              {catTools.map(tool => (
                <button
                  key={tool.id}
                  className={`bastion-tools-item ${selectedTool?.id === tool.id ? 'bastion-tools-item-active' : ''}`}
                  onClick={() => handleSelectTool(tool)}
                >
                  <span className="bastion-tools-item-name">{tool.name}</span>
                  <span className="bastion-tools-item-source">{tool.source}</span>
                </button>
              ))}
            </div>
          ))}
          {tools.length === 0 && (
            <div className="bastion-tools-empty">No tools registered</div>
          )}
        </div>

        {/* Right: Tool detail + run */}
        <div className="bastion-tools-detail">
          {selectedTool ? (
            <>
              <div className="bastion-tools-detail-header">
                <h3>{selectedTool.name}</h3>
                <span
                  className="bastion-tools-category-badge"
                  style={{ color: CATEGORY_COLORS[selectedTool.category] || '#71717a', borderColor: CATEGORY_COLORS[selectedTool.category] || '#71717a' }}
                >
                  {selectedTool.category}
                </span>
              </div>

              <p className="bastion-tools-description">{selectedTool.description}</p>

              <div className="bastion-tools-meta">
                <div className="bastion-tools-meta-item">
                  <span className="bastion-tools-meta-label">Source:</span>
                  <span>{selectedTool.source}</span>
                </div>
                <div className="bastion-tools-meta-item">
                  <span className="bastion-tools-meta-label">Scopes:</span>
                  <span>{(selectedTool.scopes || []).join(', ')}</span>
                </div>
                {selectedTool.dry_runnable && (
                  <div className="bastion-tools-meta-item">
                    <span className="bastion-tools-meta-label">Dry run:</span>
                    <span style={{ color: '#22c55e' }}>supported</span>
                  </div>
                )}
              </div>

              {/* Parameters */}
              {selectedTool.form_fields && selectedTool.form_fields.length > 0 && (
                <div className="bastion-tools-params">
                  <h4>Parameters</h4>
                  {selectedTool.form_fields.map(field => (
                    <div key={field.key} className="bastion-tools-param-field">
                      <label>
                        {field.label || field.key}
                        {field.required && <span className="bastion-tools-required">*</span>}
                      </label>
                      {field.type === 'select' ? (
                        <select
                          value={params[field.key] || ''}
                          onChange={e => setParams(p => ({ ...p, [field.key]: e.target.value }))}
                        >
                          <option value="">Select...</option>
                          {(field.options || []).map(opt => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type={field.type === 'password' ? 'password' : 'text'}
                          value={params[field.key] || ''}
                          onChange={e => setParams(p => ({ ...p, [field.key]: e.target.value }))}
                          placeholder={field.default || ''}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Target selector */}
              <div className="bastion-tools-target">
                <h4>Target</h4>
                <div className="bastion-tools-target-row">
                  <select value={targetType} onChange={e => setTargetType(e.target.value)}>
                    <option value="all">All Hosts</option>
                    <option value="group">Group</option>
                    <option value="host">Single Host</option>
                  </select>
                  {targetType === 'group' && (
                    <select value={targetValue} onChange={e => setTargetValue(e.target.value)}>
                      <option value="">Select group...</option>
                      {groups.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  )}
                  {targetType === 'host' && (
                    <select value={targetValue} onChange={e => setTargetValue(e.target.value)}>
                      <option value="">Select host...</option>
                      {hosts.map(h => <option key={h.id} value={h.id}>{h.id} ({h.ip})</option>)}
                    </select>
                  )}
                </div>
              </div>

              {/* Run button */}
              <button
                className="bastion-tools-run-btn"
                onClick={handleRunTool}
                disabled={running}
              >
                <PlayIcon /> {running ? 'Running...' : `Run ${selectedTool.name}`}
              </button>

              {/* Results */}
              {result && (
                <div className={`bastion-tools-result ${result.error ? 'bastion-tools-result-error' : ''}`}>
                  <h4>{result.error ? 'Error' : 'Results'}</h4>
                  <pre>{JSON.stringify(result, null, 2)}</pre>
                </div>
              )}
            </>
          ) : (
            <div className="bastion-tools-empty">Select a tool from the list</div>
          )}
        </div>
      </div>

      <style>{`
        .bastion-tools-tab {
          padding: 0;
        }
        .bastion-tools-loading {
          color: rgba(255,255,255,0.8);
          padding: 40px;
          text-align: center;
        }
        .bastion-tools-layout {
          display: grid;
          grid-template-columns: 260px 1fr;
          gap: 0;
          min-height: 400px;
        }
        .bastion-tools-list {
          border-right: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
          overflow-y: auto;
          max-height: calc(100vh - 260px);
        }
        .bastion-tools-list-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          font-weight: 600;
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
          border-bottom: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
        }
        .bastion-tools-category {
          padding: 4px 0;
        }
        .bastion-tools-category-header {
          padding: 8px 16px 4px;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .bastion-tools-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          width: 100%;
          padding: 8px 16px;
          background: none;
          border: none;
          color: rgba(255,255,255,0.8);
          font-size: 13px;
          cursor: pointer;
          text-align: left;
        }
        .bastion-tools-item:hover {
          background: rgba(255,255,255,0.03);
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-tools-item-active {
          background: rgba(59, 130, 246, 0.1);
          color: #3b82f6;
          border-left: 2px solid #3b82f6;
        }
        .bastion-tools-item-name {
          font-weight: 500;
        }
        .bastion-tools-item-source {
          font-size: 10px;
          opacity: 0.5;
        }
        .bastion-tools-detail {
          padding: 20px 24px;
          overflow-y: auto;
          max-height: calc(100vh - 260px);
        }
        .bastion-tools-detail-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }
        .bastion-tools-detail-header h3 {
          margin: 0;
          font-size: 18px;
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-tools-category-badge {
          font-size: 11px;
          font-weight: 600;
          padding: 2px 8px;
          border: 1px solid;
          border-radius: 4px;
          text-transform: uppercase;
        }
        .bastion-tools-description {
          color: rgba(255,255,255,0.8);
          font-size: 14px;
          margin: 0 0 16px;
          line-height: 1.5;
        }
        .bastion-tools-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 16px;
          margin-bottom: 20px;
          padding: 12px;
          background: rgba(255,255,255,0.02);
          border-radius: 6px;
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.06));
        }
        .bastion-tools-meta-item {
          font-size: 12px;
          color: rgba(255,255,255,0.8);
        }
        .bastion-tools-meta-label {
          color: rgba(255,255,255,0.7);
          margin-right: 4px;
        }
        .bastion-tools-params {
          margin-bottom: 16px;
        }
        .bastion-tools-params h4,
        .bastion-tools-target h4 {
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
          margin: 0 0 8px;
          font-weight: 600;
        }
        .bastion-tools-param-field {
          margin-bottom: 8px;
        }
        .bastion-tools-param-field label {
          display: block;
          font-size: 12px;
          color: rgba(255,255,255,0.8);
          margin-bottom: 4px;
        }
        .bastion-tools-required {
          color: #ef4444;
          margin-left: 2px;
        }
        .bastion-tools-param-field input,
        .bastion-tools-param-field select,
        .bastion-tools-target select {
          width: 100%;
          padding: 6px 10px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--m-border-default, rgba(255,255,255,0.1));
          border-radius: 4px;
          color: var(--m-text-primary, #f4f4f5);
          font-size: 13px;
        }
        .bastion-tools-target {
          margin-bottom: 16px;
        }
        .bastion-tools-target-row {
          display: flex;
          gap: 8px;
        }
        .bastion-tools-target-row select {
          flex: 1;
        }
        .bastion-tools-run-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 20px;
          background: #3b82f6;
          color: white;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }
        .bastion-tools-run-btn:hover:not(:disabled) {
          background: #2563eb;
        }
        .bastion-tools-run-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .bastion-tools-result {
          margin-top: 16px;
          padding: 12px;
          background: rgba(34, 197, 94, 0.05);
          border: 1px solid rgba(34, 197, 94, 0.2);
          border-radius: 6px;
        }
        .bastion-tools-result-error {
          background: rgba(239, 68, 68, 0.05);
          border-color: rgba(239, 68, 68, 0.2);
        }
        .bastion-tools-result h4 {
          margin: 0 0 8px;
          font-size: 13px;
          color: var(--m-text-primary, #f4f4f5);
        }
        .bastion-tools-result pre {
          margin: 0;
          font-size: 12px;
          color: rgba(255,255,255,0.8);
          overflow-x: auto;
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 300px;
          overflow-y: auto;
        }
        .bastion-tools-empty {
          color: rgba(255,255,255,0.7);
          padding: 40px;
          text-align: center;
          font-size: 13px;
        }

        /* ═══ Glass polish (Janus V2 — tab parity) ═══ */
        .bastion-tools-list {
          border-right: 1px solid rgba(255,255,255,0.12) !important;
          background: rgba(255,255,255,0.015);
        }
        .bastion-tools-list-header {
          position: sticky;
          top: 0;
          z-index: 2;
          backdrop-filter: blur(20px) saturate(1.4);
          -webkit-backdrop-filter: blur(20px) saturate(1.4);
          background:
            linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)),
            rgba(255,255,255,0.06) !important;
          border-bottom: 1px solid rgba(255,255,255,0.18) !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
          padding: 12px 16px !important;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-size: 11px !important;
          color: #fff !important;
        }
        .bastion-tools-category-header {
          padding: 10px 16px 4px !important;
          font-size: 10px !important;
          letter-spacing: 0.08em !important;
          opacity: 0.9;
        }
        .bastion-tools-item {
          border: none !important;
          border-left: 2px solid transparent !important;
          background: none !important;
          color: rgba(255,255,255,0.85) !important;
          padding: 10px 16px !important;
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .bastion-tools-item:hover {
          background: rgba(255,255,255,0.04) !important;
        }
        .bastion-tools-item-active {
          background: linear-gradient(90deg, rgba(168,85,247,0.14), rgba(56,189,248,0.04)) !important;
          border-left: 2px solid #a855f7 !important;
          box-shadow: inset 2px 0 0 #a855f7;
          color: #fff !important;
        }
        .bastion-tools-item-source {
          font-size: 10px;
          color: rgba(255,255,255,0.55);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .bastion-tools-detail {
          padding: 20px 24px !important;
          background: rgba(255,255,255,0.01);
          overflow-y: auto;
          max-height: calc(100vh - 260px);
        }
        .bastion-tools-detail-header h3 {
          margin: 0;
          font-size: 18px;
          color: #fff;
          font-weight: 600;
        }
        .bastion-tools-category-badge {
          font-size: 10px;
          font-weight: 700;
          padding: 3px 8px;
          border: 1px solid;
          border-radius: 4px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .bastion-tools-description {
          color: rgba(255,255,255,0.8);
          font-size: 13px;
          line-height: 1.5;
          margin: 12px 0 16px;
        }
        .bastion-tools-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 12px 18px;
          padding: 12px 14px;
          margin-bottom: 16px;
          backdrop-filter: blur(16px) saturate(1.3);
          -webkit-backdrop-filter: blur(16px) saturate(1.3);
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 10px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);
        }
        .bastion-tools-meta-item {
          display: flex;
          gap: 6px;
          font-size: 12px;
          color: #fff;
        }
        .bastion-tools-meta-label {
          color: rgba(255,255,255,0.6);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-size: 10px;
          align-self: center;
        }
        .bastion-tools-params,
        .bastion-tools-target {
          margin-bottom: 16px;
          padding: 14px 16px;
          backdrop-filter: blur(16px) saturate(1.3);
          -webkit-backdrop-filter: blur(16px) saturate(1.3);
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 10px;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.08);
        }
        .bastion-tools-params h4,
        .bastion-tools-target h4 {
          margin: 0 0 10px;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: rgba(255,255,255,0.7);
          font-weight: 700;
        }
        .bastion-tools-param-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 10px;
        }
        .bastion-tools-param-field label {
          font-size: 11px;
          color: rgba(255,255,255,0.75);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .bastion-tools-required {
          color: #ef4444;
          margin-left: 4px;
        }
        .bastion-tools-param-field input,
        .bastion-tools-param-field select,
        .bastion-tools-target select {
          padding: 8px 12px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 6px;
          color: #fff;
          font-size: 13px;
          font-family: inherit;
          transition: border-color 0.15s ease, background 0.15s ease;
        }
        .bastion-tools-param-field input:focus,
        .bastion-tools-param-field select:focus,
        .bastion-tools-target select:focus {
          outline: none;
          border-color: rgba(168,85,247,0.5);
          background: rgba(255,255,255,0.08);
          box-shadow: 0 0 0 3px rgba(168,85,247,0.08);
        }
        .bastion-tools-target-row {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .bastion-tools-target-row select {
          flex: 1;
          min-width: 140px;
        }
        .bastion-tools-run-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 18px;
          backdrop-filter: blur(20px) saturate(1.4);
          -webkit-backdrop-filter: blur(20px) saturate(1.4);
          background: linear-gradient(145deg, rgba(168,85,247,0.22) 0%, rgba(56,189,248,0.14) 100%);
          border: 1px solid rgba(168,85,247,0.5);
          border-top-color: rgba(168,85,247,0.65);
          border-left-color: rgba(56,189,248,0.4);
          border-radius: 10px;
          color: #fff;
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          cursor: pointer;
          box-shadow: 0 4px 18px rgba(168,85,247,0.18), inset 0 1px 0 rgba(255,255,255,0.18);
          transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
        }
        .bastion-tools-run-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 6px 24px rgba(168,85,247,0.28), inset 0 1px 0 rgba(255,255,255,0.22);
          border-top-color: rgba(255,255,255,0.5);
        }
        .bastion-tools-run-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .bastion-tools-result {
          padding: 14px 16px !important;
          backdrop-filter: blur(16px) saturate(1.3);
          -webkit-backdrop-filter: blur(16px) saturate(1.3);
          background: rgba(34,197,94,0.06) !important;
          border: 1px solid rgba(34,197,94,0.28) !important;
          border-radius: 10px !important;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.1);
        }
        .bastion-tools-result-error {
          background: rgba(239,68,68,0.06) !important;
          border-color: rgba(239,68,68,0.28) !important;
        }
        .bastion-tools-result pre {
          padding: 10px 12px;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 6px;
          margin-top: 6px !important;
        }
      `}</style>
    </div>
  )
}

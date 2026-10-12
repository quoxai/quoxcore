/**
 * ToolBuilderTab — Tool browser + assignment + inline create/edit
 * AUX-5: Replaces readonly ToolsTab with interactive tool management.
 * Backward compatible — reads from registryEntry.tools, custom tools via toolRegistry.
 */

import { useState, useEffect } from 'react'
import { TOOL_CATEGORIES, ACCESS_LEVELS, DEFCON_LEVELS, PARAM_TYPES, validateToolDefinition, generateToolSchema } from '../toolUtils'
import { createCustomTool, loadOrgTools } from '../toolApiUtils'

// Inline tool editor panel
function ToolEditor({ tool, onChange, onSave, onCancel, errors }) {
  const updateParam = (i, field, value) => {
    const params = [...(tool.parameters || [])]
    params[i] = { ...params[i], [field]: value }
    onChange({ ...tool, parameters: params })
  }

  const addParam = () => {
    onChange({ ...tool, parameters: [...(tool.parameters || []), { name: '', type: 'string', required: false, description: '', sensitive: false }] })
  }

  const removeParam = (i) => {
    onChange({ ...tool, parameters: (tool.parameters || []).filter((_, idx) => idx !== i) })
  }

  return (
    <div style={{
      padding: 16, background: 'rgba(0,0,0,0.2)',
      border: '1px solid rgba(168,85,247,0.2)', borderRadius: 10,
      marginTop: 12,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 12 }}>
        {tool.id ? 'Edit Tool' : 'Create Tool'}
      </div>

      {errors.length > 0 && (
        <div style={{ marginBottom: 12, padding: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6 }}>
          {errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: '#ef4444' }}>{e}</div>)}
        </div>
      )}

      <div className="form-row">
        <div className="form-group" style={{ flex: 1 }}>
          <label>Tool ID</label>
          <input type="text" value={tool.id || ''} onChange={e => onChange({ ...tool, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_') })} placeholder="check_order_status" />
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Name</label>
          <input type="text" value={tool.name || ''} onChange={e => onChange({ ...tool, name: e.target.value })} placeholder="Check Order Status" maxLength={50} />
        </div>
      </div>

      <div className="form-group">
        <label>Description</label>
        <textarea rows={2} value={tool.description || ''} onChange={e => onChange({ ...tool, description: e.target.value })} placeholder="What this tool does..." maxLength={500} />
      </div>

      <div className="form-row">
        <div className="form-group" style={{ flex: 1 }}>
          <label>Category</label>
          <select value={tool.category || 'data'} onChange={e => onChange({ ...tool, category: e.target.value })}>
            {TOOL_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>Access Level</label>
          <select value={tool.accessLevel || 'specialists+'} onChange={e => onChange({ ...tool, accessLevel: e.target.value })}>
            {ACCESS_LEVELS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ flex: 1 }}>
          <label>DEFCON</label>
          <select value={tool.defconLevel || 'GREEN'} onChange={e => onChange({ ...tool, defconLevel: e.target.value })}>
            {DEFCON_LEVELS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </div>
      </div>

      {/* Parameters */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label>Parameters</label>
          <button onClick={addParam} style={{
            padding: '3px 10px', fontSize: 10, fontWeight: 600,
            background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)',
            borderRadius: 5, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit',
          }}>
            + Add Parameter
          </button>
        </div>

        {(tool.parameters || []).map((p, i) => (
          <div key={i} style={{
            display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', marginBottom: 4,
            background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: 6,
          }}>
            <input type="text" value={p.name} onChange={e => updateParam(i, 'name', e.target.value)} placeholder="name" style={{ flex: 1, fontSize: 11, padding: '4px 8px' }} />
            <select value={p.type} onChange={e => updateParam(i, 'type', e.target.value)} style={{ width: 90, fontSize: 11, padding: '4px 6px' }}>
              {PARAM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              <input type="checkbox" checked={p.required || false} onChange={e => updateParam(i, 'required', e.target.checked)} style={{ accentColor: '#f59e0b' }} />
              Req
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
              <input type="checkbox" checked={p.sensitive || false} onChange={e => updateParam(i, 'sensitive', e.target.checked)} style={{ accentColor: '#ef4444' }} />
              Sensitive
            </label>
            <button onClick={() => removeParam(i)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
          </div>
        ))}
      </div>

      {/* Schema preview */}
      {tool.id && (
        <div style={{
          marginTop: 12, padding: 10, background: 'rgba(0,0,0,0.2)',
          border: '1px solid rgba(255,255,255,0.04)', borderRadius: 8,
        }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace" }}>
            Schema Preview
          </div>
          <pre style={{ margin: 0, fontSize: 10, color: '#38bdf8', whiteSpace: 'pre-wrap', fontFamily: "'JetBrains Mono', monospace" }}>
            {JSON.stringify(generateToolSchema(tool), null, 2)}
          </pre>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onSave} disabled={saving} style={{
          padding: '6px 16px', fontSize: 11, fontWeight: 700, background: saving ? 'rgba(48,255,144,0.5)' : '#30ff90',
          border: 'none', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer', color: '#000',
        }}>
          {saving ? 'Saving...' : 'Save Tool'}
        </button>
        <button onClick={onCancel} style={{
          padding: '6px 16px', fontSize: 11, fontWeight: 500,
          background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 6, cursor: 'pointer', color: 'rgba(255,255,255,0.7)', fontFamily: 'inherit',
        }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function NoToolsNotice({ isApiSource }) {
  if (!isApiSource) return null
  return (
    <div style={{
      padding: 12, marginBottom: 12, background: 'rgba(245,158,11,0.06)',
      border: '1px solid rgba(245,158,11,0.15)', borderRadius: 8,
    }}>
      <div style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600, marginBottom: 4 }}>
        Custom assistant — tool display limited
      </div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', lineHeight: 1.5 }}>
        User-created assistants don't show core tool assignments here yet.
        Tools are assigned at the collector level. Configure tools for core agents in Settings &gt; Assistants.
      </div>
    </div>
  )
}

export default function ToolBuilderTab({ draft, updateField, registryEntry, assistantId, authFetch, orgId }) {
  const [showEditor, setShowEditor] = useState(false)
  const [editingTool, setEditingTool] = useState(null)
  const [editorErrors, setEditorErrors] = useState([])
  const [filter, setFilter] = useState('')
  const [customTools, setCustomTools] = useState([])
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState(null) // { success, message }

  const registryTools = registryEntry?.tools || []
  const workflows = registryEntry?.workflows || []
  const capabilities = registryEntry?.capabilities || []

  // Load org's custom tools from auth DB
  useEffect(() => {
    if (authFetch && orgId) {
      loadOrgTools(authFetch, orgId).then(tools => setCustomTools(tools))
    }
  }, [authFetch, orgId])

  const DEFCON_COLORS = { GREEN: '#30ff90', BLUE: '#38bdf8', AMBER: '#f59e0b', ORANGE: '#f97316', RED: '#ef4444' }

  const handleCreate = () => {
    setEditingTool({ id: '', name: '', description: '', category: 'data', parameters: [], accessLevel: 'specialists+', defconLevel: 'GREEN' })
    setEditorErrors([])
    setShowEditor(true)
  }

  const handleSave = async () => {
    const errors = validateToolDefinition(editingTool)
    if (errors.length > 0) { setEditorErrors(errors); return }

    if (!authFetch || !orgId) {
      setEditorErrors(['Authentication not available. Please refresh and try again.'])
      return
    }

    setSaving(true)
    setSaveResult(null)

    const result = await createCustomTool(authFetch, orgId, editingTool)

    if (result.success) {
      // Reload custom tools from server
      const updated = await loadOrgTools(authFetch, orgId)
      setCustomTools(updated)
      setShowEditor(false)
      setEditingTool(null)
      setEditorErrors([])
      setSaveResult({ success: true, message: `Tool "${editingTool.name}" created successfully` })
      setTimeout(() => setSaveResult(null), 3000)
    } else {
      setEditorErrors([result.error || 'Failed to save tool'])
    }

    setSaving(false)
  }

  const filteredTools = registryTools.filter(t => !filter || t.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="editor-section">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <label style={{ display: 'block', marginBottom: 2 }}>Tools & Workflows</label>
          <span className="form-hint" style={{ display: 'block' }}>
            Tools this agent can invoke. Assign existing tools or create new ones.
          </span>
        </div>
        <button onClick={handleCreate} style={{
          padding: '5px 12px', fontSize: 11, fontWeight: 600,
          background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)',
          borderRadius: 6, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit',
        }}>
          + Create Tool
        </button>
      </div>

      <NoToolsNotice isApiSource={registryTools.length === 0 && draft?._source === 'api'} />

      {/* Search */}
      {registryTools.length > 5 && (
        <div className="form-group" style={{ marginBottom: 12 }}>
          <input type="text" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter tools..." style={{ fontSize: 12 }} />
        </div>
      )}

      {/* Tool list */}
      <div className="tools-section">
        <h3 className="section-label">Assigned Tools ({filteredTools.length})</h3>
        {filteredTools.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filteredTools.map(tool => (
              <div key={tool} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.04)',
                borderRadius: 6, borderLeft: '2px solid rgba(56,189,248,0.3)',
              }}>
                <span style={{ fontSize: 12 }}>⚙</span>
                <span style={{ flex: 1, fontSize: 12, color: '#fff', fontFamily: "'JetBrains Mono', monospace" }}>
                  {tool.replace(/_/g, ' ')}
                </span>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {tool}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: 16, textAlign: 'center', color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
            {filter ? 'No tools match filter' : 'No tools assigned'}
          </div>
        )}
      </div>

      {/* Workflows */}
      {workflows.length > 0 && (
        <div className="tools-section" style={{ marginTop: 16 }}>
          <h3 className="section-label">Workflows ({workflows.length})</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {workflows.map(wf => (
              <span key={wf} style={{
                padding: '4px 10px', fontSize: 10, fontWeight: 600,
                background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)',
                borderRadius: 5, color: '#a855f7',
              }}>
                ▶ {wf}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Capabilities */}
      {capabilities.length > 0 && (
        <div className="tools-section" style={{ marginTop: 16 }}>
          <h3 className="section-label">Capabilities ({capabilities.length})</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {capabilities.map(cap => (
              <span key={cap} style={{
                padding: '4px 10px', fontSize: 10,
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 5, color: 'rgba(255,255,255,0.7)',
              }}>
                {cap}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Custom tools from org DB */}
      {customTools.length > 0 && (
        <div className="tools-section" style={{ marginTop: 16 }}>
          <h3 className="section-label">Custom Tools ({customTools.length})</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {customTools.map(tool => (
              <div key={tool.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                background: 'rgba(168,85,247,0.04)', border: '1px solid rgba(168,85,247,0.12)',
                borderRadius: 6, borderLeft: '2px solid rgba(168,85,247,0.3)',
              }}>
                <span style={{ fontSize: 12 }}>🔧</span>
                <span style={{ flex: 1, fontSize: 12, color: '#fff' }}>{tool.name}</span>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {tool.slug || tool.tool_id || 'custom'}
                </span>
                <span style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 4,
                  background: 'rgba(168,85,247,0.1)', color: '#a855f7', fontWeight: 600,
                }}>
                  custom
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Save result banner */}
      {saveResult && (
        <div style={{
          padding: 10, marginTop: 12, borderRadius: 8, fontSize: 12, fontWeight: 600,
          background: saveResult.success ? 'rgba(48,255,144,0.06)' : 'rgba(239,68,68,0.06)',
          border: `1px solid ${saveResult.success ? 'rgba(48,255,144,0.2)' : 'rgba(239,68,68,0.2)'}`,
          color: saveResult.success ? '#30ff90' : '#ef4444',
        }}>
          {saveResult.message}
        </div>
      )}

      {/* Inline tool editor */}
      {showEditor && editingTool && (
        <ToolEditor
          tool={editingTool}
          onChange={setEditingTool}
          onSave={handleSave}
          onCancel={() => { setShowEditor(false); setEditingTool(null) }}
          errors={editorErrors}
        />
      )}
    </div>
  )
}

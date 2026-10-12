/**
 * TestToolModal, QCX-1.4
 *
 * Admins POST {input} to /api/orgs/:o/widgets/:w/tools/:toolId/test-run.
 * Displays ok/fail badge, duration_ms, and the raw (sanitised) result
 * payload as pretty JSON. Renders a form from the tool's parameter schema
 * (parameters or input_schema, a JSONSchema-lite object with
 * type/properties/required, matching what ToolBuilderModal and the builtin
 * presets produce) so admins fill in named fields instead of hand-writing
 * JSON. An "Edit as JSON" toggle keeps the raw textarea available for
 * experts. Tools with no discoverable schema fall back to the JSON
 * textarea, same as before.
 */

import { useMemo, useState } from 'react'

const MODAL_STYLE = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
}
const PANEL_STYLE = {
  width: 620, maxHeight: '92vh', overflowY: 'auto',
  background: '#0d0d12', border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12, padding: 20,
}
const TEXTAREA_STYLE = {
  width: '100%', minHeight: 120, padding: '8px 10px',
  background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 6, color: '#fff', fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
  boxSizing: 'border-box', resize: 'vertical',
}
const LABEL_STYLE = { display: 'block', fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.65)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }
const FIELD_ROW_STYLE = { marginBottom: 12 }
const FORM_INPUT_STYLE = {
  width: '100%', padding: '8px 10px', background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6,
  color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box',
}
const HELP_TEXT_STYLE = { fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 3 }
const REQUIRED_MARK_STYLE = { color: '#f59e0b', marginLeft: 4 }
const TOGGLE_BUTTON_STYLE = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700,
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6,
  color: 'rgba(255,255,255,0.75)', cursor: 'pointer', fontFamily: 'inherit',
  textTransform: 'uppercase', letterSpacing: 0.4,
}

function ToggleIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

// Reads the JSONSchema-lite object that ToolBuilderModal and the builtin
// presets both write: { type: 'object', properties: {...}, required: [...] }.
// Returns null when there is nothing usable to build a form from.
function schemaFromTool(tool) {
  const schema = tool?.parameters || tool?.input_schema
  if (!schema || typeof schema !== 'object') return null
  if (!schema.properties || typeof schema.properties !== 'object') return null
  if (Object.keys(schema.properties).length === 0) return null
  return schema
}

function sampleInputFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return {}
  const props = schema.properties || {}
  const out = {}
  for (const [k, v] of Object.entries(props)) {
    if (!v || typeof v !== 'object') { out[k] = null; continue }
    if (v.type === 'string') out[k] = v.example || ''
    else if (v.type === 'number' || v.type === 'integer') out[k] = typeof v.example === 'number' ? v.example : 0
    else if (v.type === 'boolean') out[k] = !!v.example
    else if (v.type === 'array') out[k] = []
    else if (v.type === 'object') out[k] = {}
    else out[k] = null
  }
  return out
}

// Field-level rendering hint. Only "boolean", "number", "enum" (has an enum
// list) and "array"/"object" ("json") have a distinct shape; everything else
// is a string rendered as email, textarea or plain text depending on the
// declared format or the field name.
function fieldKind(key, spec) {
  if (!spec || typeof spec !== 'object') return 'text'
  if (spec.type === 'boolean') return 'boolean'
  if (spec.type === 'number' || spec.type === 'integer') return 'number'
  if (Array.isArray(spec.enum) && spec.enum.length > 0) return 'enum'
  if (spec.type === 'array' || spec.type === 'object') return 'json'
  if (spec.format === 'email' || /email/i.test(key)) return 'email'
  if (spec.format === 'textarea' || /desc|note|message|reason|content|body|comment|context/i.test(key)) return 'textarea'
  return 'text'
}

function initialFieldValues(schema) {
  const props = schema?.properties || {}
  const sample = sampleInputFromSchema(schema)
  const out = {}
  for (const [key, spec] of Object.entries(props)) {
    const kind = fieldKind(key, spec)
    const raw = sample[key]
    if (kind === 'boolean') out[key] = !!raw
    else if (kind === 'json') out[key] = JSON.stringify(raw ?? (spec?.type === 'array' ? [] : {}), null, 2)
    else out[key] = raw === null || raw === undefined ? '' : String(raw)
  }
  return out
}

function buildObjectFromFields(schema, fieldValues) {
  const props = schema?.properties || {}
  const out = {}
  for (const [key, spec] of Object.entries(props)) {
    const kind = fieldKind(key, spec)
    const value = fieldValues[key]
    if (kind === 'boolean') out[key] = !!value
    else if (kind === 'number') {
      if (value === '' || value === undefined) { out[key] = value }
      else { const n = Number(value); out[key] = Number.isFinite(n) ? n : value }
    } else if (kind === 'json') {
      try { out[key] = JSON.parse(value) } catch { out[key] = value }
    } else {
      out[key] = value
    }
  }
  return out
}

export default function TestToolModal({ tool, widget, orgId, authFetch, onClose }) {
  const schema = useMemo(() => schemaFromTool(tool), [tool])
  const hasSchema = !!schema
  const sampleJson = useMemo(() => JSON.stringify(sampleInputFromSchema(schema), null, 2), [schema])

  const [mode, setMode] = useState(hasSchema ? 'form' : 'json')
  const [fieldValues, setFieldValues] = useState(() => (hasSchema ? initialFieldValues(schema) : {}))
  const [inputJson, setInputJson] = useState(sampleJson || '{}')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)

  function setField(key, value) {
    setFieldValues(v => ({ ...v, [key]: value }))
  }

  function switchToJson() {
    setErr(null)
    if (hasSchema) setInputJson(JSON.stringify(buildObjectFromFields(schema, fieldValues), null, 2))
    setMode('json')
  }

  function switchToForm() {
    if (!hasSchema) return
    let parsed
    try { parsed = JSON.parse(inputJson || '{}') }
    catch (e) { setErr('Could not parse JSON, fix it before switching back to the form'); return }
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      setErr('JSON must be an object to switch back to the form'); return
    }
    const props = schema.properties || {}
    const next = {}
    for (const [key, spec] of Object.entries(props)) {
      const kind = fieldKind(key, spec)
      const has = Object.prototype.hasOwnProperty.call(parsed, key)
      const raw = has ? parsed[key] : undefined
      if (kind === 'boolean') next[key] = !!raw
      else if (kind === 'json') next[key] = JSON.stringify(has ? raw : (spec?.type === 'array' ? [] : {}), null, 2)
      else next[key] = raw === null || raw === undefined ? (fieldValues[key] ?? '') : String(raw)
    }
    setFieldValues(next)
    setErr(null)
    setMode('form')
  }

  function resetAll() {
    setErr(null)
    setResult(null)
    if (hasSchema) setFieldValues(initialFieldValues(schema))
    setInputJson(sampleJson || '{}')
  }

  async function run() {
    setErr(null)
    setResult(null)
    let parsed
    if (mode === 'form' && hasSchema) {
      parsed = buildObjectFromFields(schema, fieldValues)
      const missing = (schema.required || []).filter(key => {
        const kind = fieldKind(key, schema.properties?.[key])
        if (kind === 'boolean' || kind === 'json') return false
        const v = parsed[key]
        return v === undefined || v === null || v === ''
      })
      if (missing.length > 0) { setErr(`Required: ${missing.join(', ')}`); return }
    } else {
      try { parsed = JSON.parse(inputJson || '{}') }
      catch (e) { setErr('Input must be valid JSON'); return }
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      setErr('Input must be a JSON object'); return
    }
    setRunning(true)
    try {
      const resp = await authFetch(
        `/api/orgs/${orgId}/widgets/${widget.id}/tools/${tool.id}/test-run`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: parsed }) }
      )
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) setErr(data.error || `Request failed (${resp.status})`)
      else setResult(data)
    } catch (e) {
      setErr(e?.message || 'Request failed')
    } finally {
      setRunning(false)
    }
  }

  const resultColor = result?.ok ? '#30ff90' : '#ef4444'
  const resultLabel = result?.ok ? 'OK' : 'FAIL'

  return (
    <div style={MODAL_STYLE} role="dialog" aria-label="Test tool" onClick={e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div style={PANEL_STYLE}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>
            Test tool: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#a855f7' }}>{tool?.name}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 18, cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <label style={{ ...LABEL_STYLE, marginBottom: 0 }}>{mode === 'form' && hasSchema ? 'Input' : 'Input (JSON)'}</label>
            {hasSchema && (
              <button
                type="button"
                onClick={() => (mode === 'form' ? switchToJson() : switchToForm())}
                style={TOGGLE_BUTTON_STYLE}
              >
                <ToggleIcon />
                {mode === 'form' ? 'Edit as JSON' : 'Edit as form'}
              </button>
            )}
          </div>

          {mode === 'form' && hasSchema ? (
            Object.entries(schema.properties).map(([key, spec]) => {
              const kind = fieldKind(key, spec)
              const isRequired = (schema.required || []).includes(key)
              const description = spec?.description
              return (
                <div key={key} style={FIELD_ROW_STYLE}>
                  <label style={LABEL_STYLE}>
                    {key}
                    {isRequired && <span style={REQUIRED_MARK_STYLE}>*</span>}
                  </label>
                  {kind === 'boolean' && (
                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
                      <input type="checkbox" checked={!!fieldValues[key]} onChange={e => setField(key, e.target.checked)} />
                      Enabled
                    </label>
                  )}
                  {kind === 'number' && (
                    <input style={FORM_INPUT_STYLE} type="number" value={fieldValues[key] ?? ''} onChange={e => setField(key, e.target.value)} />
                  )}
                  {kind === 'email' && (
                    <input style={FORM_INPUT_STYLE} type="email" value={fieldValues[key] ?? ''} onChange={e => setField(key, e.target.value)} placeholder="name@example.com" />
                  )}
                  {kind === 'enum' && (
                    <select style={FORM_INPUT_STYLE} value={fieldValues[key] ?? ''} onChange={e => setField(key, e.target.value)}>
                      <option value="">Select…</option>
                      {spec.enum.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  )}
                  {kind === 'textarea' && (
                    <textarea style={{ ...FORM_INPUT_STYLE, minHeight: 70, resize: 'vertical' }} value={fieldValues[key] ?? ''} onChange={e => setField(key, e.target.value)} />
                  )}
                  {kind === 'json' && (
                    <textarea style={{ ...FORM_INPUT_STYLE, minHeight: 70, fontFamily: "'JetBrains Mono', monospace", resize: 'vertical' }} value={fieldValues[key] ?? ''} onChange={e => setField(key, e.target.value)} spellCheck={false} />
                  )}
                  {kind === 'text' && (
                    <input style={FORM_INPUT_STYLE} type="text" value={fieldValues[key] ?? ''} onChange={e => setField(key, e.target.value)} />
                  )}
                  {description && <div style={HELP_TEXT_STYLE}>{description}</div>}
                </div>
              )
            })
          ) : (
            <>
              <textarea style={TEXTAREA_STYLE} value={inputJson} onChange={e => setInputJson(e.target.value)} spellCheck={false} />
              {!hasSchema && (
                <div style={HELP_TEXT_STYLE}>This tool has no parameter schema.</div>
              )}
            </>
          )}

          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', marginTop: 8 }}>
            Runs the tool in isolation: no conversation, no widget round trip. Real executor, real network, real credentials.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            type="button"
            onClick={run}
            disabled={running}
            style={{
              padding: '7px 14px', fontSize: 12, fontWeight: 700,
              background: running ? 'rgba(168,85,247,0.3)' : '#a855f7',
              border: 'none', borderRadius: 6, color: '#fff',
              cursor: running ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            }}
          >
            {running ? 'Running…' : 'Run'}
          </button>
          <button
            type="button"
            onClick={resetAll}
            style={{ padding: '7px 12px', fontSize: 11, background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}
          >
            Reset
          </button>
        </div>

        {err && (
          <div style={{ padding: 10, borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 11, marginBottom: 12 }}>
            {err}
          </div>
        )}

        {result && (
          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 12, background: 'rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: resultColor, padding: '2px 8px', border: `1px solid ${resultColor}`, borderRadius: 4 }}>
                {resultLabel}
              </span>
              {Number.isFinite(result.duration_ms) && (
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontFamily: "'JetBrains Mono', monospace" }}>
                  {result.duration_ms} ms
                </span>
              )}
              {result.error && (
                <span style={{ fontSize: 10, color: '#ef4444', fontFamily: "'JetBrains Mono', monospace" }}>
                  {result.error}
                </span>
              )}
            </div>
            <pre style={{ margin: 0, fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.8)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>
              {JSON.stringify(result.ok ? result.result : { error: result.error, message: result.message }, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

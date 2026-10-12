/**
 * QuickActionsTab — Drag-reorderable suggestion chip editor
 * AUX-4: Replaces the plain textarea for suggestions with a visual editor.
 * Saves to draft.ui.suggestions (same field).
 */

import { useState, useRef } from 'react'

export default function QuickActionsTab({ draft, updateField, registryEntry }) {
  const suggestions = draft?.ui?.suggestions || []
  const [dragIdx, setDragIdx] = useState(null)
  const [editIdx, setEditIdx] = useState(null)
  const editRef = useRef(null)

  const setSuggestions = (next) => updateField('ui.suggestions', next)

  const add = () => {
    const next = [...suggestions, 'New suggestion...']
    setSuggestions(next)
    setEditIdx(next.length - 1)
  }

  const remove = (i) => {
    setSuggestions(suggestions.filter((_, idx) => idx !== i))
    if (editIdx === i) setEditIdx(null)
  }

  const update = (i, value) => {
    const next = [...suggestions]
    next[i] = value
    setSuggestions(next)
  }

  const handleDragStart = (i) => setDragIdx(i)

  const handleDrop = (targetIdx) => {
    if (dragIdx === null || dragIdx === targetIdx) return
    const next = [...suggestions]
    const [moved] = next.splice(dragIdx, 1)
    next.splice(targetIdx, 0, moved)
    setSuggestions(next)
    setDragIdx(null)
  }

  // Auto-suggest from agent capabilities/tools
  const autoSuggest = () => {
    const tools = registryEntry?.tools || []
    const capabilities = registryEntry?.capabilities || []
    const generated = []

    // Generate from tools
    tools.slice(0, 3).forEach(tool => {
      const name = tool.replace(/_/g, ' ')
      generated.push(`Run ${name}`)
    })

    // Generate from capabilities
    capabilities.slice(0, 2).forEach(cap => {
      generated.push(`Help me with ${cap}`)
    })

    if (generated.length > 0) {
      setSuggestions([...suggestions, ...generated.filter(g => !suggestions.includes(g))])
    }
  }

  return (
    <div className="editor-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <label style={{ display: 'block', marginBottom: 2 }}>Quick Actions</label>
          <span className="form-hint" style={{ display: 'block' }}>
            Suggestion chips shown to users in the chat sidebar. Drag to reorder.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {registryEntry?.tools?.length > 0 && (
            <button
              onClick={autoSuggest}
              style={{
                padding: '5px 10px', fontSize: 10, fontWeight: 600,
                background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.2)',
                borderRadius: 6, cursor: 'pointer', color: '#a855f7', fontFamily: 'inherit',
              }}
            >
              Auto-suggest from tools
            </button>
          )}
          <button
            onClick={add}
            style={{
              padding: '5px 12px', fontSize: 11, fontWeight: 600,
              background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)',
              borderRadius: 6, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit',
            }}
          >
            + Add
          </button>
        </div>
      </div>

      {/* Suggestion list */}
      {suggestions.length === 0 ? (
        <div style={{
          padding: 24, textAlign: 'center', background: 'rgba(0,0,0,0.15)',
          border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10,
        }}>
          <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.5 }}>⚡</div>
          <div style={{ fontSize: 13, color: '#fff', marginBottom: 4 }}>No quick actions yet</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
            Add suggestions to help users start conversations quickly.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {suggestions.map((item, i) => (
            <div
              key={i}
              draggable
              onDragStart={() => handleDragStart(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px',
                background: dragIdx === i ? 'rgba(168,85,247,0.08)' : 'rgba(0,0,0,0.15)',
                border: dragIdx === i ? '1px solid rgba(168,85,247,0.2)' : '1px solid rgba(255,255,255,0.06)',
                borderRadius: 8, transition: 'all 0.15s',
                opacity: dragIdx === i ? 0.5 : 1,
              }}
            >
              {/* Drag handle */}
              <span style={{ cursor: 'grab', color: 'rgba(255,255,255,0.6)', fontSize: 14, flexShrink: 0, userSelect: 'none' }}>≡</span>

              {/* Index badge */}
              <span style={{
                fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.6)',
                fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums',
                width: 16, textAlign: 'center', flexShrink: 0,
              }}>
                {i + 1}
              </span>

              {/* Editable text */}
              <input
                ref={editIdx === i ? editRef : null}
                value={item}
                onChange={(e) => update(i, e.target.value)}
                onFocus={() => setEditIdx(i)}
                onBlur={() => { if (editIdx === i) setEditIdx(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                style={{
                  flex: 1, background: 'transparent', border: 'none',
                  color: '#fff', fontSize: 12, fontFamily: 'inherit', outline: 'none',
                  padding: '2px 0',
                }}
                placeholder="Type a suggestion..."
              />

              {/* Remove */}
              <button
                onClick={() => remove(i)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'rgba(255,255,255,0.6)', fontSize: 14, padding: '0 2px',
                  flexShrink: 0, lineHeight: 1,
                }}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Preview */}
      {suggestions.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            Chat Preview
          </div>
          <div style={{
            padding: 10, background: 'rgba(0,0,0,0.2)',
            border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10,
            display: 'flex', gap: 6, flexWrap: 'wrap',
          }}>
            {suggestions.map((item, i) => (
              <span key={i} style={{
                padding: '5px 12px', fontSize: 11, color: '#fff', borderRadius: 20,
                background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)',
                whiteSpace: 'nowrap',
              }}>
                {item}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

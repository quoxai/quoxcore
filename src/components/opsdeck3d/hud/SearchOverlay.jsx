/**
 * SearchOverlay — Command-palette style search modal for CC3D entities.
 *
 * Extracted from CognitiveCore3DView.jsx (Phase CC-10 refactor).
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"

export default function SearchOverlay({ open, onClose, entities, onSelect, onResultsChange }) {
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIdx(0)
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  const results = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return entities.filter(e => e.name.toLowerCase().includes(q)).slice(0, 8)
  }, [query, entities])

  useEffect(() => { setSelectedIdx(0) }, [results.length])

  // Report live results + active index to parent (for search beacons)
  useEffect(() => {
    onResultsChange?.(results, selectedIdx)
  }, [results, selectedIdx, onResultsChange])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIdx]) {
      onSelect(results[selectedIdx])
      onClose()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }, [results, selectedIdx, onSelect, onClose])

  // Clear beacons when overlay closes
  useEffect(() => {
    if (!open) onResultsChange?.([], -1)
  }, [open, onResultsChange])

  if (!open) return null

  const typeBadgeColors = { agent: '#6366f1', objective: '#22c55e', memory: '#ec4899' }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 120, background: 'rgba(0,0,0,0.4)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, maxHeight: 420, borderRadius: 8, overflow: 'hidden',
          background: 'rgba(5, 5, 16, 0.95)', backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(139, 92, 246, 0.25)',
          fontFamily: FONT_STACK, boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search agents, objectives, memories..."
          style={{
            width: '100%', padding: '12px 16px', border: 'none',
            background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.9)',
            fontFamily: FONT_STACK, fontSize: 13, letterSpacing: '0.02em',
            outline: 'none', borderBottom: '1px solid rgba(139, 92, 246, 0.15)',
            boxSizing: 'border-box',
          }}
        />
        {results.length > 0 && (
          <div style={{ padding: '4px 0' }}>
            {results.map((r, i) => (
              <div
                key={r.id}
                onClick={() => { onSelect(r); onClose() }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 16px', cursor: 'pointer',
                  background: i === selectedIdx ? 'rgba(139, 92, 246, 0.15)' : 'transparent',
                  transition: 'background 0.15s ease',
                }}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: r.color,
                }} />
                <span style={{
                  flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.8)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{r.name}</span>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, fontSize: 8, fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                  background: `${typeBadgeColors[r.type] || '#555'}20`,
                  color: typeBadgeColors[r.type] || '#555',
                  border: `1px solid ${typeBadgeColors[r.type] || '#555'}30`,
                }}>{r.type}</span>
              </div>
            ))}
          </div>
        )}
        {query.trim() && results.length === 0 && (
          <div style={{
            padding: '16px', textAlign: 'center',
            color: 'rgba(255,255,255,0.35)', fontSize: 11,
          }}>No results</div>
        )}
      </div>
    </div>
  )
}

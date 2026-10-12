/**
 * VoltJsonViewer — Formatted JSON viewer with syntax highlighting
 *
 * Constructs full run + events object, renders with regex-based
 * syntax highlighting. Copy + Download buttons.
 */

import { useMemo, useCallback } from 'react'
import DOMPurify from 'dompurify'

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

function highlightJson(jsonStr) {
  return jsonStr
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // strings (keys + values)
    .replace(/"([^"\\]*(\\.[^"\\]*)*)"/g, (match, content) => {
      // Check if it's a key (followed by colon)
      return `<span class="volt-json__string">${match}</span>`
    })
    // numbers
    .replace(/\b(-?\d+\.?\d*([eE][+-]?\d+)?)\b/g, '<span class="volt-json__number">$1</span>')
    // booleans
    .replace(/\b(true|false)\b/g, '<span class="volt-json__boolean">$1</span>')
    // null
    .replace(/\bnull\b/g, '<span class="volt-json__null">null</span>')
}

export default function VoltJsonViewer({ run, events = [] }) {
  const data = useMemo(() => {
    if (!run) return null
    return {
      run_id: run.run_id,
      corr: run.corr,
      status: run.status,
      seq: run.seq,
      head_hash: run.head_hash,
      started_at: run.started_at,
      completed_at: run.completed_at,
      events: events.map(e => ({
        event_id: e.event_id,
        seq: e.seq,
        ts: e.ts,
        event_type: e.event_type,
        actor: e.actor,
        hash: e.hash,
        prev_hash: e.prev_hash,
        payload: e.payload,
        context: e.context,
      })),
    }
  }, [run, events])

  const jsonStr = useMemo(() => {
    if (!data) return ''
    return JSON.stringify(data, null, 2)
  }, [data])

  const highlighted = useMemo(() => highlightJson(jsonStr), [jsonStr])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(jsonStr).catch(() => {
      // Fallback: select text
      const el = document.querySelector('.volt-json-viewer__pre')
      if (el) {
        const range = document.createRange()
        range.selectNodeContents(el)
        window.getSelection().removeAllRanges()
        window.getSelection().addRange(range)
      }
    })
  }, [jsonStr])

  const handleDownload = useCallback(() => {
    const blob = new Blob([jsonStr], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `volt-run-${run?.run_id || 'unknown'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [jsonStr, run])

  if (!run) return null

  return (
    <div className="volt-json-viewer">
      <div className="volt-json-viewer__actions">
        <button className="volt-btn" onClick={handleCopy} title="Copy JSON to clipboard">
          <CopyIcon />
          Copy JSON
        </button>
        <button className="volt-btn" onClick={handleDownload} title="Download as JSON file">
          <DownloadIcon />
          Download JSON
        </button>
      </div>
      <pre
        className="volt-json-viewer__pre"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlighted) }}
      />
    </div>
  )
}

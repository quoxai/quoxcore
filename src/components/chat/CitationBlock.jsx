/**
 * CitationBlock Component
 *
 * Displays citations for file-grounded AI responses:
 * - Inline citation markers [1], [2], [3]
 * - Expandable citation footer with file links
 * - Click to open file preview
 */

import { useState } from 'react'
import { formatFileSize } from '../../services/fileStorage'
import './citations.css'

/**
 * File type icon component
 */
function FileIcon({ type, size = 16 }) {
  const getIconPath = () => {
    if (type?.startsWith('image/')) {
      return 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'
    }
    if (type === 'application/pdf') {
      return 'M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z'
    }
    if (type === 'application/json') {
      return 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z'
    }
    // Default document
    return 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z'
  }

  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  )
}

/**
 * Single citation item
 */
function CitationItem({ citation, onClick }) {
  return (
    <button
      className="citation-item"
      onClick={() => onClick?.(citation)}
      title={`Open ${citation.name}`}
    >
      <span className="citation-index">[{citation.index}]</span>
      <FileIcon type={citation.type} size={14} />
      <span className="citation-name">{citation.name}</span>
      <span className="citation-meta">{formatFileSize(citation.size)}</span>
    </button>
  )
}

/**
 * Parse text and highlight citation markers
 */
function parseTextWithCitations(text, citations) {
  if (!text || citations.length === 0) {
    return [{ type: 'text', content: text }]
  }

  const parts = []
  const citationPattern = /\[(\d+)\]/g
  let lastIndex = 0
  let match

  while ((match = citationPattern.exec(text)) !== null) {
    // Add text before citation
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: text.substring(lastIndex, match.index)
      })
    }

    // Add citation marker
    const index = parseInt(match[1], 10)
    const citation = citations.find(c => c.index === index)
    parts.push({
      type: 'citation',
      index,
      citation,
      raw: match[0]
    })

    lastIndex = match.index + match[0].length
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      content: text.substring(lastIndex)
    })
  }

  return parts
}

/**
 * CitationBlock Component
 *
 * @param {Object} props
 * @param {string} props.text - Response text with citation markers
 * @param {Array} props.citations - Array of citation objects
 * @param {Function} props.onCitationClick - Callback when citation is clicked
 */
export function CitationBlock({ text, citations = [], onCitationClick }) {
  const [expanded, setExpanded] = useState(false)

  if (!citations || citations.length === 0) {
    return <div className="citation-block no-citations">{text}</div>
  }

  const parts = parseTextWithCitations(text, citations)

  return (
    <div className="citation-block">
      <div className="citation-content">
        {parts.map((part, i) =>
          part.type === 'text' ? (
            <span key={i}>{part.content}</span>
          ) : (
            <button
              key={i}
              className={`citation-marker ${part.citation ? 'valid' : 'invalid'}`}
              onClick={() => part.citation && onCitationClick?.(part.citation)}
              title={part.citation?.name || 'Unknown source'}
            >
              {part.raw}
            </button>
          )
        )}
      </div>

      <div className="citation-footer">
        <button
          className="citation-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            className={expanded ? 'expanded' : ''}
            style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          <span>{citations.length} source{citations.length !== 1 ? 's' : ''}</span>
        </button>

        {expanded && (
          <div className="citation-list">
            {citations.map(citation => (
              <CitationItem
                key={citation.id || citation.index}
                citation={citation}
                onClick={onCitationClick}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Inline citation marker component (for use in other contexts)
 */
export function CitationMarker({ index, citation, onClick }) {
  return (
    <button
      className={`citation-marker inline ${citation ? 'valid' : 'invalid'}`}
      onClick={() => citation && onClick?.(citation)}
      title={citation?.name || 'Unknown source'}
    >
      [{index}]
    </button>
  )
}

/**
 * Citation sources list (standalone)
 */
export function CitationSources({ citations, onCitationClick }) {
  if (!citations || citations.length === 0) {
    return null
  }

  return (
    <div className="citation-sources">
      <div className="citation-sources-header">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
        </svg>
        <span>Sources</span>
      </div>
      <div className="citation-sources-list">
        {citations.map(citation => (
          <CitationItem
            key={citation.id || citation.index}
            citation={citation}
            onClick={onCitationClick}
          />
        ))}
      </div>
    </div>
  )
}

export default CitationBlock

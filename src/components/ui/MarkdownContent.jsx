/**
 * MarkdownContent — Universal markdown renderer for QuoxCORE
 *
 * Replaces all ad-hoc markdown rendering and raw <pre> blocks across the app.
 * Uses ReactMarkdown + remarkGfm with the standard mdComponents config.
 *
 * Usage:
 *   <MarkdownContent>{someMarkdownString}</MarkdownContent>
 *   <MarkdownContent compact className="my-class">{text}</MarkdownContent>
 */

import { useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Copy-to-clipboard button for code blocks
 */
function CopyCodeButton({ code }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [code])

  return (
    <button
      data-testid="copy-code-btn"
      onClick={handleCopy}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        padding: '4px 10px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        background: copied
          ? 'rgba(48,255,144,0.18)'
          : 'rgba(255, 255, 255, 0.07)',
        border: `1px solid ${copied ? 'rgba(48,255,144,0.45)' : 'rgba(255,255,255,0.22)'}`,
        borderRadius: 6,
        color: copied ? '#30ff90' : '#fff',
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 2px 6px rgba(0,0,0,0.35)',
      }}
      onMouseEnter={(e) => {
        if (!copied) {
          e.currentTarget.style.background = 'rgba(32, 36, 52, 0.94)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.35)';
        }
      }}
      onMouseLeave={(e) => {
        if (!copied) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.07)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)';
        }
      }}
      title={copied ? 'Copied!' : 'Copy code'}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

/**
 * Custom pre block wrapper — adds copy button and relative positioning
 */
function CodeBlock({ children }) {
  // Extract the raw text from the code element inside <pre>
  const codeText = extractText(children)

  return (
    <div style={{ position: 'relative' }}>
      <CopyCodeButton code={codeText} />
      <pre className="code-block">{children}</pre>
    </div>
  )
}

/**
 * Recursively extract text content from React children
 */
function extractText(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node?.props?.children) return extractText(node.props.children)
  return ''
}

/**
 * Standard markdown component overrides — shared across the entire app.
 * Matches CSS classes defined in views.css under .message-text scope.
 */
const mdComponents = {
  p: ({ children }) => <p className="md-p">{children}</p>,
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  code: ({ children }) => <code className="inline-code">{children}</code>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  h1: ({ children }) => <strong style={{ fontSize: '1.1em' }}>{children}</strong>,
  h2: ({ children }) => <strong style={{ fontSize: '1.05em' }}>{children}</strong>,
  h3: ({ children }) => <strong>{children}</strong>,
  ul: ({ children }) => <ul className="md-list">{children}</ul>,
  ol: ({ children }) => <ol className="md-list md-list-ordered">{children}</ol>,
  li: ({ children }) => <li className="md-li">{children}</li>,
  a: ({ href, children }) => {
    const isInternal = typeof href === 'string' && (href.startsWith('/') || href.startsWith('#'))
    if (isInternal) {
      return <a href={href}>{children}</a>
    }
    return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  },
  table: ({ children }) => <table className="chat-table">{children}</table>,
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
}

/**
 * MarkdownContent — drop-in markdown renderer
 *
 * @param {string} children — markdown string to render
 * @param {boolean} compact — if true, applies md-compact class for tighter spacing
 * @param {string} className — additional CSS class(es) to apply to wrapper
 */
export default function MarkdownContent({ children, compact = false, className = '' }) {
  const classes = ['message-text', compact && 'md-compact', className].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {children || ''}
      </ReactMarkdown>
    </div>
  )
}

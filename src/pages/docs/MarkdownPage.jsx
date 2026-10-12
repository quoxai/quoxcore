import { useMemo, useCallback, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Helper to generate slug from text
const generateSlug = (text) => {
  if (typeof text !== 'string') {
    // Handle React children (could be array of strings/elements)
    if (Array.isArray(text)) {
      text = text.map(child =>
        typeof child === 'string' ? child : (child?.props?.children || '')
      ).join('')
    } else if (text?.props?.children) {
      text = text.props.children
    } else {
      text = String(text || '')
    }
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

// Helper to extract text from children
const extractText = (children) => {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) {
    return children.map(extractText).join('')
  }
  if (children?.props?.children) {
    return extractText(children.props.children)
  }
  return String(children || '')
}

// Custom components for rendering markdown with HAL styling
const markdownComponents = {
  h1: ({ children }) => <h1 className="docs-md-h1">{children}</h1>,
  h2: ({ children }) => {
    const text = extractText(children)
    const id = generateSlug(text)
    return <h2 id={id} className="docs-md-h2">{children}</h2>
  },
  h3: ({ children }) => {
    const text = extractText(children)
    const id = generateSlug(text)
    return <h3 id={id} className="docs-md-h3">{children}</h3>
  },
  h4: ({ children }) => <h4 className="docs-md-h4">{children}</h4>,
  p: ({ children }) => <p className="docs-md-p">{children}</p>,
  ul: ({ children }) => <ul className="docs-md-ul">{children}</ul>,
  ol: ({ children }) => <ol className="docs-md-ol">{children}</ol>,
  li: ({ children }) => <li className="docs-md-li">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} className="docs-md-link" target={href?.startsWith('http') ? '_blank' : undefined} rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}>
      {children}
    </a>
  ),
  code: ({ inline, className, children }) => {
    if (inline) {
      return <code className="docs-md-code-inline">{children}</code>
    }
    return (
      <div className="docs-code">
        {className && <div className="docs-code-header">{className.replace('language-', '')}</div>}
        <pre><code>{children}</code></pre>
      </div>
    )
  },
  pre: ({ children }) => <>{children}</>,
  table: ({ children }) => (
    <div className="docs-table-wrapper">
      <table className="docs-table">{children}</table>
    </div>
  ),
  blockquote: ({ children }) => (
    <div className="docs-callout">
      <div className="docs-callout-icon">i</div>
      <div className="docs-callout-content">{children}</div>
    </div>
  ),
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
}

/**
 * Hook to extract headings from markdown content
 * Returns array of { level, text, id }
 */
export function useExtractHeadings(content) {
  return useMemo(() => {
    if (!content) return []

    const headings = []
    // Match markdown headings (## and ###)
    const regex = /^(#{2,3})\s+(.+)$/gm
    let match

    while ((match = regex.exec(content)) !== null) {
      const level = match[1].length // 2 for h2, 3 for h3
      const text = match[2].trim()
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')

      headings.push({ level, text, id })
    }

    return headings
  }, [content])
}

// Reusable markdown renderer component
// Pass the markdown content directly (imported with ?raw)
export default function MarkdownPage({ content, title, lead }) {
  // Get setHeadings from outlet context (provided by DocsLayout)
  const context = useOutletContext()
  const setHeadings = context?.setHeadings

  // Skip the first H1 if title is provided (to avoid duplication)
  const processedContent = useMemo(() => {
    if (title && content) {
      // Remove the first # heading line if it exists
      return content.replace(/^#\s+.+\n+/, '')
    }
    return content
  }, [content, title])

  // Extract headings from content
  const headings = useExtractHeadings(processedContent)

  // Update parent with headings when they change
  useEffect(() => {
    if (setHeadings) {
      setHeadings(headings)
    }

    // Cleanup: clear headings when unmounting
    return () => {
      if (setHeadings) {
        setHeadings([])
      }
    }
  }, [headings, setHeadings])

  return (
    <section className="docs-section docs-markdown-content">
      {title && <h1>{title}</h1>}
      {lead && <p className="docs-lead">{lead}</p>}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {processedContent || ''}
      </ReactMarkdown>
    </section>
  )
}

// Export headings extraction for use in other components
export { generateSlug, extractText }

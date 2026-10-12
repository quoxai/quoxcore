import { useState, useEffect, useCallback, useMemo } from 'react'
import './docs-toc.css'

/**
 * DocsTOC - Right sidebar table of contents with scroll spy
 *
 * Features:
 * - Extracts headings from content (h2, h3)
 * - Smooth scroll on click
 * - Active section highlighting (scroll spy)
 * - Sticky positioning
 * - Collapsible on mobile
 */
export default function DocsTOC({ headings = [], isOpen, onToggle }) {
  const [activeId, setActiveId] = useState('')

  // Generate slug from heading text
  const getSlug = useCallback((text) => {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
  }, [])

  // Process headings with slugs
  const processedHeadings = useMemo(() => {
    return headings.map(h => ({
      ...h,
      id: h.id || getSlug(h.text)
    }))
  }, [headings, getSlug])

  // Scroll spy - track which section is currently visible
  useEffect(() => {
    if (processedHeadings.length === 0) return

    const handleScroll = () => {
      const scrollY = window.scrollY
      const offset = 120 // Account for fixed header

      // Find the heading closest to the top of the viewport
      let currentId = ''

      for (const heading of processedHeadings) {
        const element = document.getElementById(heading.id)
        if (element) {
          const rect = element.getBoundingClientRect()
          const elementTop = rect.top + scrollY

          if (elementTop <= scrollY + offset + 50) {
            currentId = heading.id
          }
        }
      }

      // If no heading is found, use the first one if we're at the top
      if (!currentId && scrollY < 200 && processedHeadings.length > 0) {
        currentId = processedHeadings[0].id
      }

      setActiveId(currentId)
    }

    // Initial check
    handleScroll()

    // Throttled scroll handler
    let ticking = false
    const scrollHandler = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          handleScroll()
          ticking = false
        })
        ticking = true
      }
    }

    window.addEventListener('scroll', scrollHandler, { passive: true })
    return () => window.removeEventListener('scroll', scrollHandler)
  }, [processedHeadings])

  // Handle link click - smooth scroll
  const handleClick = useCallback((e, id) => {
    e.preventDefault()

    const element = document.getElementById(id)
    if (element) {
      const headerOffset = 100
      const elementPosition = element.getBoundingClientRect().top
      const offsetPosition = elementPosition + window.scrollY - headerOffset

      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      })

      // Update URL hash without jumping
      window.history.pushState(null, '', `#${id}`)
      setActiveId(id)

      // Close mobile TOC after click
      if (window.innerWidth < 1200 && onToggle) {
        onToggle()
      }
    }
  }, [onToggle])

  // Don't render if no headings
  if (processedHeadings.length === 0) {
    return null
  }

  return (
    <>
      {/* Mobile toggle button */}
      <button
        className="docs-toc-toggle"
        onClick={onToggle}
        aria-label="Toggle table of contents"
        aria-expanded={isOpen}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="15" y2="12" />
          <line x1="3" y1="18" x2="18" y2="18" />
        </svg>
        <span>On this page</span>
      </button>

      {/* Backdrop for mobile */}
      {isOpen && (
        <div className="docs-toc-backdrop" onClick={onToggle} />
      )}

      {/* TOC sidebar */}
      <aside className={`docs-toc ${isOpen ? 'open' : ''}`}>
        <div className="docs-toc-content">
          <div className="docs-toc-header">
            <span className="docs-toc-title">On this page</span>
            <button
              className="docs-toc-close"
              onClick={onToggle}
              aria-label="Close table of contents"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <nav className="docs-toc-nav" aria-label="Table of contents">
            <ul className="docs-toc-list">
              {processedHeadings.map((heading) => (
                <li
                  key={heading.id}
                  className={`docs-toc-item docs-toc-level-${heading.level}`}
                >
                  <a
                    href={`#${heading.id}`}
                    className={`docs-toc-link ${activeId === heading.id ? 'active' : ''}`}
                    onClick={(e) => handleClick(e, heading.id)}
                  >
                    {heading.text}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Progress indicator */}
          <div className="docs-toc-progress">
            <div
              className="docs-toc-progress-bar"
              style={{
                height: `${Math.max(5, (processedHeadings.findIndex(h => h.id === activeId) + 1) / processedHeadings.length * 100)}%`
              }}
            />
          </div>
        </div>
      </aside>
    </>
  )
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

/**
 * Hook to extract headings from DOM
 * Use this for non-markdown pages
 */
export function useDOMHeadings(containerRef) {
  const [headings, setHeadings] = useState([])

  useEffect(() => {
    if (!containerRef?.current) return

    const elements = containerRef.current.querySelectorAll('h2, h3')
    const extractedHeadings = []

    elements.forEach((el) => {
      const level = parseInt(el.tagName.charAt(1))
      const text = el.textContent

      // Generate ID if not present
      let id = el.id
      if (!id) {
        id = text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
        el.id = id
      }

      extractedHeadings.push({ level, text, id })
    })

    setHeadings(extractedHeadings)
  }, [containerRef])

  return headings
}

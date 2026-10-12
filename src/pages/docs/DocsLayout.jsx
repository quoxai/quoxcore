import { useState, useEffect, createContext, useContext, useMemo } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import DocsTOC from '../../components/docs/DocsTOC'
import '../../styles/docs.css'

// Context to share headings between pages and layout
export const TOCContext = createContext({
  headings: [],
  setHeadings: () => {}
})

// Documentation navigation structure
// NOTE: Plan-only docs (RAG Strategy, Docker Containment, Safety Guardrails) removed
// These are in /docs/*.md but not exposed in UI until implemented
const DOC_NAV = [
  {
    title: 'Getting Started',
    items: [
      { path: '/docs', label: 'Overview', icon: 'O', exact: true, keywords: ['intro', 'start', 'home'] },
      { path: '/docs/integrations', label: 'Integrations', icon: '🔌', keywords: ['integration', 'connector', 'api', 'service', 'vault', 'credentials'] },
      { path: '/docs/features', label: 'A-Z Features', icon: 'F', keywords: ['features', 'list', 'reference', 'all', 'alphabetical'] },
      { path: '/docs/architecture', label: 'Architecture', icon: 'A', keywords: ['system', 'design', 'stack'] },
      { path: '/docs/setup', label: 'Setup Guide', icon: '>', keywords: ['install', 'config', 'start'] },
    ]
  },
  {
    title: 'Core Systems',
    items: [
      { path: '/docs/memory', label: 'Memory System', icon: 'M', keywords: ['wsm', 'episodic', 'semantic', 'qdrant'] },
      { path: '/docs/agents', label: 'AI Agents', icon: 'G', keywords: ['claude', 'assistant', 'aee'] },
      { path: '/docs/smart-router', label: 'Smart Router', icon: 'R', keywords: ['router', 'confidence', 'classification', 'intent', 'bypass', 'llm'] },
      { path: '/docs/aocl', label: 'AOCL Layers', icon: 'L', keywords: ['aocl', 'layer', 'audit', 'compliance', 'osi', 'trace', 'transparency'] },
      { path: '/docs/quoxagent', label: 'QuoxAgent Agent', icon: 'H', keywords: ['fleet', 'host', 'deploy', 'collector'] },
    ]
  },
  {
    title: 'Enterprise Workspace',
    items: [
      { path: '/docs/auth-service', label: 'Auth Service', icon: 'L', keywords: ['login', 'jwt', 'mfa', 'password', 'session'] },
      { path: '/docs/orgs', label: 'Organizations', icon: 'B', keywords: ['org', 'team', 'division', 'department', 'member'] },
      { path: '/docs/teams', label: 'Teams', icon: 'T', keywords: ['team', 'member', 'role', 'scope'] },
      { path: '/docs/inbox', label: 'HITL & Inbox', icon: 'I', keywords: ['hitl', 'approval', 'human', 'routing', 'notification'] },
    ]
  },
  {
    title: 'Workflows',
    items: [
      { path: '/docs/workflows', label: 'Workflows Overview', icon: 'W', keywords: ['workflow', 'n8n', 'automation', 'template'] },
    ]
  },
  {
    title: 'Reference',
    items: [
      { path: '/docs/api', label: 'API Reference', icon: '/', keywords: ['endpoint', 'rest', 'webhook'] },
      { path: '/docs/development', label: 'Development', icon: 'D', keywords: ['dev', 'test', 'build', 'npm'] },
    ]
  }
]

// Custom hook to use TOC context
export function useTOC() {
  return useContext(TOCContext)
}

export default function DocsLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const [headings, setHeadings] = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const location = useLocation()

  // Filter navigation based on search query
  const filteredNav = useMemo(() => {
    if (!searchQuery.trim()) return DOC_NAV

    const query = searchQuery.toLowerCase()
    return DOC_NAV.map(section => ({
      ...section,
      items: section.items.filter(item =>
        item.label.toLowerCase().includes(query) ||
        section.title.toLowerCase().includes(query) ||
        (item.keywords && item.keywords.some(k => k.includes(query)))
      )
    })).filter(section => section.items.length > 0)
  }, [searchQuery])

  // Add class to html element for browsers without :has() support
  // This enables scrolling on the docs pages
  useEffect(() => {
    document.documentElement.classList.add('docs-page-active')

    // Cleanup when leaving docs pages
    return () => {
      document.documentElement.classList.remove('docs-page-active')
    }
  }, [])

  // Handle hash navigation on page load and route changes
  useEffect(() => {
    if (location.hash) {
      // Small delay to ensure DOM is ready after route change
      const timeoutId = setTimeout(() => {
        const elementId = location.hash.slice(1) // Remove the # prefix
        const element = document.getElementById(elementId)
        if (element) {
          const headerOffset = 100
          const elementPosition = element.getBoundingClientRect().top
          const offsetPosition = elementPosition + window.scrollY - headerOffset

          window.scrollTo({
            top: offsetPosition,
            behavior: 'smooth'
          })
        }
      }, 100)

      return () => clearTimeout(timeoutId)
    }
  }, [location.hash, location.pathname])

  const toggleSidebar = () => setSidebarOpen(!sidebarOpen)
  const closeSidebar = () => setSidebarOpen(false)
  const toggleTOC = () => setTocOpen(!tocOpen)

  return (
    <TOCContext.Provider value={{ headings, setHeadings }}>
      <div className="docs-page">
        {/* Header */}
        <header className="docs-header">
          <Link to="/" className="docs-logo">
            <img src="/logo-quox.png?v=3" alt="Quox" className="docs-logo-img" />
            <span className="docs-logo-text">DOCUMENTATION</span>
          </Link>
          <nav className="docs-header-nav">
            <NavLink to="/landing">Overview</NavLink>
            <NavLink to="/docs" end>Docs</NavLink>
            <NavLink to="/docs/workflows">Workflows</NavLink>
            <Link to="/" className="docs-launch-btn">Launch App</Link>
          </nav>
          <button
            className="docs-mobile-menu"
            onClick={toggleSidebar}
            aria-label="Toggle navigation"
          >
            <span /><span /><span />
          </button>
        </header>

        {/* Main Layout */}
        <div className="docs-layout">
          {/* Left Sidebar - Navigation */}
          <aside className={`docs-sidebar ${sidebarOpen ? 'open' : ''}`}>
            <div className="docs-sidebar-content">
              <div className="docs-sidebar-title">Documentation</div>

              {/* Search Box */}
              <div className="docs-search">
                <svg className="docs-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  className="docs-search-input"
                  placeholder="Search docs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search documentation"
                />
                {searchQuery && (
                  <button
                    className="docs-search-clear"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>

              <nav className="docs-nav">
                {filteredNav.length === 0 ? (
                  <div className="docs-search-empty">
                    No docs matching "{searchQuery}"
                  </div>
                ) : filteredNav.map((section) => (
                  <div key={section.title} className="docs-nav-section">
                    <div className="docs-nav-section-title">{section.title}</div>
                    {section.items.map((item) => (
                      <NavLink
                        key={item.path}
                        to={item.path}
                        end={item.exact}
                        className={({ isActive }) => isActive ? 'active' : ''}
                        onClick={() => { closeSidebar(); setSearchQuery(''); }}
                      >
                        <span className="docs-nav-icon">{item.icon}</span>
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                ))
                }
              </nav>
            </div>
          </aside>

          {/* Content - rendered by nested routes */}
          <main className="docs-main">
            <Outlet context={{ setHeadings }} />
          </main>

          {/* Right Sidebar - Table of Contents */}
          <DocsTOC
            headings={headings}
            isOpen={tocOpen}
            onToggle={toggleTOC}
          />
        </div>

        {/* Footer */}
        <footer className="docs-footer">
          <div className="docs-footer-inner">
            <div className="docs-footer-brand">
              <img src="/logo-quox.png?v=3" alt="Quox" className="docs-logo-img small" />
              <span className="docs-logo-text small">DOCS</span>
            </div>
            <div className="docs-footer-links">
              <Link to="/">Dashboard</Link>
              <a href="https://github.com/YOUR_USERNAME/quox-dashboard" target="_blank" rel="noopener noreferrer">GitHub</a>
            </div>
            <div className="docs-footer-meta">
              QuoxCORE Documentation
            </div>
          </div>
        </footer>
      </div>
    </TOCContext.Provider>
  )
}

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import '../styles/docs.css'

// ============================================================================
// CONFIGURATION DATA
// ============================================================================

const DOC_SECTIONS = [
  { id: 'overview', label: 'Overview', icon: 'O', group: 'Getting Started' },
  { id: 'quick-start', label: 'Quick Start', icon: '>', group: 'Getting Started' },
  { id: 'architecture', label: 'Architecture', icon: 'A', group: 'Core Concepts' },
  { id: 'quoxagent', label: 'QuoxAgent Agent', icon: 'H', group: 'Core Concepts' },
  { id: 'self-awareness', label: 'Self-Awareness', icon: 'S', group: 'Core Concepts' },
  { id: 'memory', label: 'Memory System', icon: 'M', group: 'Features' },
  { id: 'agents', label: 'AI Agents', icon: 'G', group: 'Features' },
  { id: 'voice', label: 'Voice Control', icon: 'V', group: 'Features' },
  { id: 'safety', label: 'Safety System', icon: '!', group: 'Features' },
  { id: 'views', label: 'Views', icon: '#', group: 'Interface' },
  { id: 'api', label: 'API Reference', icon: '/', group: 'Reference' },
  { id: 'setup', label: 'Setup Guide', icon: '>', group: 'Reference' },
]

const AGENTS = [
  { id: 'quox', name: 'QuoxCORE', color: '#38bdf8', specialty: 'Orchestrator', desc: 'Master coordinator that analyzes queries and delegates to specialist agents', tools: ['All agent tools', 'Delegation logic', 'Context synthesis'] },
  { id: 'sentinel', name: 'WARDEN', color: '#3090ff', specialty: 'Security', desc: 'Security specialist for threat detection, vulnerability scanning, and compliance audits', tools: ['fail2ban', 'lynis', 'rkhunter', 'ossec'] },
  { id: 'cipher', name: 'CIPHER', color: '#9d4edd', specialty: 'Network', desc: 'Network specialist for connectivity diagnostics, traffic analysis, and firewall management', tools: ['iptables', 'tcpdump', 'nmap', 'netstat'] },
  { id: 'nova', name: 'DAEDALUS', color: '#30ff90', specialty: 'DevOps', desc: 'DevOps specialist for CI/CD pipelines, deployments, and automation workflows', tools: ['git', 'gitlab-ci', 'ansible', 'terraform'] },
  { id: 'atlas', name: 'HYPERION', color: '#00d4ff', specialty: 'Proxmox', desc: 'Proxmox specialist for VM/container lifecycle, cluster operations, and resource allocation', tools: ['qm', 'pct', 'pvesh', 'pveam'] },
  { id: 'metrics', name: 'METRICS', color: '#ffd93d', specialty: 'Monitoring', desc: 'Monitoring specialist for Prometheus queries, Grafana dashboards, and alerting', tools: ['promql', 'grafana-api', 'alertmanager'] },
  { id: 'beacon', name: 'VIGIL', color: '#ff6b35', specialty: 'Uptime', desc: 'Uptime specialist for service availability monitoring, health checks, and status pages', tools: ['uptime-kuma', 'healthchecks', 'curl'] },
  { id: 'forge', name: 'VULCAN', color: '#ff4081', specialty: 'Containers', desc: 'Container specialist for Docker operations, image management, and registry maintenance', tools: ['docker', 'docker-compose', 'containerd'] },
  { id: 'vault', name: 'VAULT', color: '#00e676', specialty: 'Storage', desc: 'Storage specialist for secrets management, backup operations, and NAS administration', tools: ['restic', 'borgbackup', 'rclone', 'smbclient'] },
  { id: 'nexus', name: 'NEXUS', color: '#7c4dff', specialty: 'DNS', desc: 'DNS specialist for record management, service discovery, and internal DNS resolution', tools: ['dig', 'nslookup', 'pihole-api', 'bind'] },
  { id: 'insight', name: 'INSIGHT', color: '#18ffff', specialty: 'Analysis', desc: 'Analysis specialist for log parsing, trend identification, and generating operational reports', tools: ['loki', 'elasticsearch', 'awk', 'jq'] },
]

const MEMORY_TYPES = [
  { type: 'Episodic', color: '#3090ff', desc: 'Full conversation logs with timestamps, context windows, and session metadata', icon: 'E', details: 'Every conversation is stored with full context including timestamps, session IDs, and associated entities. This enables conversation replay, context restoration, and learning from past interactions.' },
  { type: 'Semantic', color: '#30ff90', desc: 'Learned facts, preferences, decisions, constraints, and error patterns', icon: 'S', details: 'High-salience information extracted from conversations is categorized and stored for quick retrieval. Includes user preferences, technical facts, project decisions, operational constraints, and patterns from past errors.' },
  { type: 'Entity', color: '#ffd93d', desc: 'Infrastructure entities: hosts, services, IPs, containers, and their relationships', icon: 'N', details: 'A knowledge graph of your infrastructure including hosts, services, IP addresses, containers, and the relationships between them. Powers intelligent suggestions and cross-referencing.' },
  { type: 'Procedural', color: '#ff4081', desc: 'Learned workflows, runbooks, command patterns, and operational sequences', icon: 'P', details: 'Captures operational knowledge including multi-step procedures, command sequences that work well together, and runbooks for common scenarios. Enables workflow automation and suggestion.' },
]

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

// Copy to clipboard button for code blocks
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <button
      className="docs-copy-btn"
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
    </button>
  )
}

// Code block with copy button
function CodeBlock({ title, children, language = '' }) {
  const codeText = typeof children === 'string' ? children : children?.toString() || ''

  return (
    <div className="docs-code">
      {title && <div className="docs-code-header">{title}</div>}
      <div className="docs-code-body">
        <CopyButton text={codeText.trim()} />
        <pre><code className={language ? `language-${language}` : ''}>{codeText}</code></pre>
      </div>
    </div>
  )
}

// TL;DR summary box with icon
function TldrBox({ children }) {
  return (
    <div className="docs-tldr">
      <div className="docs-tldr-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        TL;DR
      </div>
      <div className="docs-tldr-content">{children}</div>
    </div>
  )
}

// Section intro with friendly tone
function SectionIntro({ children }) {
  return (
    <div className="docs-section-intro">
      {children}
    </div>
  )
}

// On This Page navigation (Table of Contents)
function OnThisPage({ headings, activeHeading }) {
  if (!headings || headings.length === 0) return null

  return (
    <aside className="docs-toc">
      <div className="docs-toc-title">On This Page</div>
      <nav className="docs-toc-nav">
        {headings.map((heading, index) => (
          <a
            key={index}
            href={`#${heading.id}`}
            className={`docs-toc-link docs-toc-level-${heading.level} ${activeHeading === heading.id ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault()
              document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth' })
            }}
          >
            {heading.text}
          </a>
        ))}
      </nav>
    </aside>
  )
}

// Reading progress bar
function ReadingProgress() {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const updateProgress = () => {
      const scrollTop = window.scrollY
      const docHeight = document.documentElement.scrollHeight - window.innerHeight
      const scrollProgress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0
      setProgress(scrollProgress)
    }

    window.addEventListener('scroll', updateProgress)
    return () => window.removeEventListener('scroll', updateProgress)
  }, [])

  return (
    <div className="docs-progress-bar">
      <div className="docs-progress-fill" style={{ width: `${progress}%` }} />
    </div>
  )
}

// Back to top button
function BackToTopButton() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const toggleVisibility = () => {
      setVisible(window.scrollY > 500)
    }

    window.addEventListener('scroll', toggleVisibility)
    return () => window.removeEventListener('scroll', toggleVisibility)
  }, [])

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (!visible) return null

  return (
    <button
      className="docs-back-to-top"
      onClick={scrollToTop}
      title="Back to top"
      aria-label="Scroll back to top"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 15l-6-6-6 6" />
      </svg>
    </button>
  )
}

// Search component
function DocsSearch({ sections, onNavigate }) {
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const inputRef = useRef(null)

  const filteredSections = useMemo(() => {
    if (!query.trim()) return []
    const lowerQuery = query.toLowerCase()
    return sections.filter(s =>
      s.label.toLowerCase().includes(lowerQuery) ||
      s.id.toLowerCase().includes(lowerQuery)
    )
  }, [query, sections])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(true)
        setTimeout(() => inputRef.current?.focus(), 100)
      }
      if (e.key === 'Escape') {
        setIsOpen(false)
        setQuery('')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleSelect = (sectionId) => {
    onNavigate(sectionId)
    setIsOpen(false)
    setQuery('')
  }

  return (
    <>
      <button className="docs-search-trigger" onClick={() => setIsOpen(true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span>Search docs...</span>
        <kbd>Ctrl K</kbd>
      </button>

      {isOpen && (
        <div className="docs-search-modal" onClick={() => setIsOpen(false)}>
          <div className="docs-search-dialog" onClick={e => e.stopPropagation()}>
            <div className="docs-search-input-wrap">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                placeholder="Search documentation..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="docs-search-input"
              />
              <kbd>ESC</kbd>
            </div>
            {filteredSections.length > 0 && (
              <div className="docs-search-results">
                {filteredSections.map(section => (
                  <button
                    key={section.id}
                    className="docs-search-result"
                    onClick={() => handleSelect(section.id)}
                  >
                    <span className="docs-search-result-icon">{section.icon}</span>
                    <span className="docs-search-result-label">{section.label}</span>
                    <span className="docs-search-result-group">{section.group}</span>
                  </button>
                ))}
              </div>
            )}
            {query && filteredSections.length === 0 && (
              <div className="docs-search-empty">No results found for "{query}"</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

function DocsPage() {
  const [activeSection, setActiveSection] = useState('overview')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [tocHeadings, setTocHeadings] = useState([])
  const [activeHeading, setActiveHeading] = useState('')

  // Track scroll position for active section
  useEffect(() => {
    const handleScroll = () => {
      const sections = DOC_SECTIONS.map(s => document.getElementById(s.id))
      const scrollPos = window.scrollY + 120

      for (let i = sections.length - 1; i >= 0; i--) {
        if (sections[i] && sections[i].offsetTop <= scrollPos) {
          setActiveSection(DOC_SECTIONS[i].id)
          break
        }
      }

      // Update active heading for TOC
      const headings = document.querySelectorAll('.docs-section h2[id], .docs-section h3[id]')
      let currentHeading = ''
      headings.forEach(heading => {
        if (heading.offsetTop <= scrollPos + 20) {
          currentHeading = heading.id
        }
      })
      setActiveHeading(currentHeading)
    }

    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Extract headings for TOC when section changes
  useEffect(() => {
    const section = document.getElementById(activeSection)
    if (!section) return

    const headings = []
    section.querySelectorAll('h2, h3').forEach(h => {
      const id = h.id || h.textContent.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
      if (!h.id) h.id = id
      headings.push({
        id,
        text: h.textContent,
        level: h.tagName === 'H2' ? 2 : 3
      })
    })
    setTocHeadings(headings)
  }, [activeSection])

  const scrollTo = useCallback((id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
    setSidebarOpen(false)
  }, [])

  // Group sections by category
  const groupedSections = useMemo(() => {
    const groups = {}
    DOC_SECTIONS.forEach(section => {
      if (!groups[section.group]) groups[section.group] = []
      groups[section.group].push(section)
    })
    return groups
  }, [])

  return (
    <div className="docs-page">
      <ReadingProgress />

      {/* Header */}
      <header className="docs-header">
        <Link to="/" className="docs-logo">
          <div className="docs-logo-eye" />
          <span>QuoxCORE</span>
        </Link>

        <DocsSearch sections={DOC_SECTIONS} onNavigate={scrollTo} />

        <nav className="docs-header-nav">
          <a href="#overview" onClick={(e) => { e.preventDefault(); scrollTo('overview') }}>Docs</a>
          <a href="#memory" onClick={(e) => { e.preventDefault(); scrollTo('memory') }}>Memory</a>
          <a href="#api" onClick={(e) => { e.preventDefault(); scrollTo('api') }}>API</a>
          <Link to="/" className="docs-launch-btn">Launch App</Link>
        </nav>

        <button
          className="docs-mobile-menu"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-label="Toggle navigation"
        >
          <span /><span /><span />
        </button>
      </header>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="docs-sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Main Layout */}
      <div className="docs-layout">
        {/* Sidebar */}
        <aside className={`docs-sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="docs-sidebar-content">
            <div className="docs-sidebar-header">
              <div className="docs-sidebar-title">Documentation</div>
              <button
                className="docs-sidebar-close"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close navigation"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
            <nav className="docs-nav">
              {Object.entries(groupedSections).map(([group, sections]) => (
                <div key={group} className="docs-nav-section">
                  <div className="docs-nav-section-title">{group}</div>
                  {sections.map(section => (
                    <a
                      key={section.id}
                      href={`#${section.id}`}
                      className={activeSection === section.id ? 'active' : ''}
                      onClick={(e) => { e.preventDefault(); scrollTo(section.id) }}
                    >
                      <span className="docs-nav-icon">{section.icon}</span>
                      {section.label}
                    </a>
                  ))}
                </div>
              ))}
            </nav>
          </div>
        </aside>

        {/* Content */}
        <main className="docs-main">
          {/* ================================================================
              OVERVIEW SECTION
              ================================================================ */}
          <section id="overview" className="docs-section">
            <h1>QuoxCORE Documentation</h1>
            <p className="docs-lead">
              Multi-Agent Executive System for Tactical Resource Orchestration -
              an AI-powered infrastructure command center with persistent memory,
              voice control, and comprehensive safety guardrails.
            </p>

            <SectionIntro>
              <p>
                Welcome! If you've ever wished you could just <em>talk</em> to your infrastructure instead of memorizing dozens of CLI commands across different systems, you're in the right place. QuoxCORE is your conversational interface to infrastructure management - it understands what you want, remembers your preferences, and executes operations safely.
              </p>
            </SectionIntro>

            <div className="docs-callout">
              <div className="docs-callout-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
              </div>
              <div className="docs-callout-content">
                <strong>What is QuoxCORE?</strong>
                <p>QuoxCORE is a conversational AI interface for infrastructure management. Instead of memorizing CLI commands, SSH sessions, and API endpoints, you can simply describe what you want in natural language. QuoxCORE understands your infrastructure, remembers your preferences, and executes operations safely.</p>
              </div>
            </div>

            <TldrBox>
              QuoxCORE lets you manage infrastructure through natural conversation. It has 11 specialized AI agents, persistent memory that learns from every interaction, voice control for hands-free operation, and built-in safety guardrails to prevent accidents.
            </TldrBox>

            <div className="docs-quick-links">
              <a href="#quick-start" onClick={(e) => { e.preventDefault(); scrollTo('quick-start') }} className="docs-quick-link">
                <span className="docs-quick-link-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                </span>
                <span className="docs-quick-link-text">
                  <strong>Quick Start</strong>
                  <span>Get running in 5 minutes</span>
                </span>
              </a>
              <a href="#memory" onClick={(e) => { e.preventDefault(); scrollTo('memory') }} className="docs-quick-link">
                <span className="docs-quick-link-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" />
                    <path d="M12 8v8" />
                    <path d="M8 12h8" />
                  </svg>
                </span>
                <span className="docs-quick-link-text">
                  <strong>Memory System</strong>
                  <span>How QuoxCORE remembers</span>
                </span>
              </a>
              <a href="#agents" onClick={(e) => { e.preventDefault(); scrollTo('agents') }} className="docs-quick-link">
                <span className="docs-quick-link-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </span>
                <span className="docs-quick-link-text">
                  <strong>AI Agents</strong>
                  <span>Meet the specialists</span>
                </span>
              </a>
              <a href="#api" onClick={(e) => { e.preventDefault(); scrollTo('api') }} className="docs-quick-link">
                <span className="docs-quick-link-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="16 18 22 12 16 6" />
                    <polyline points="8 6 2 12 8 18" />
                  </svg>
                </span>
                <span className="docs-quick-link-text">
                  <strong>API Reference</strong>
                  <span>For developers</span>
                </span>
              </a>
            </div>

            <div className="docs-stats">
              <div className="docs-stat">
                <span className="docs-stat-value">11</span>
                <span className="docs-stat-label">AI Agents</span>
              </div>
              <div className="docs-stat">
                <span className="docs-stat-value">10</span>
                <span className="docs-stat-label">Memory Phases</span>
              </div>
              <div className="docs-stat">
                <span className="docs-stat-value">437</span>
                <span className="docs-stat-label">Tests Passing</span>
              </div>
              <div className="docs-stat">
                <span className="docs-stat-value">50+</span>
                <span className="docs-stat-label">Hosts Managed</span>
              </div>
            </div>

            <h2 id="design-philosophy">Design Philosophy</h2>
            <p>
              QuoxCORE is built on three core principles that guide every design decision:
            </p>

            <div className="docs-grid docs-grid-3">
              <div className="docs-card">
                <div className="docs-card-icon" style={{ background: 'rgba(255, 48, 48, 0.15)', color: '#38bdf8' }}>1</div>
                <h3>Conversational First</h3>
                <p>Infrastructure management should feel like talking to a knowledgeable colleague. No memorizing commands - describe what you need in natural language. QuoxCORE translates intent into action, explains what it's doing, and learns from every interaction.</p>
              </div>
              <div className="docs-card">
                <div className="docs-card-icon" style={{ background: 'rgba(48, 144, 255, 0.15)', color: '#3090ff' }}>2</div>
                <h3>Memory as Foundation</h3>
                <p>Every AI assistant forgets you the moment you close the tab. QuoxCORE remembers your preferences, your infrastructure, your past decisions, and the context of previous conversations. It builds a personalized understanding that improves over time.</p>
              </div>
              <div className="docs-card">
                <div className="docs-card-icon" style={{ background: 'rgba(48, 255, 144, 0.15)', color: '#30ff90' }}>3</div>
                <h3>Safety by Default</h3>
                <p>Power without control is dangerous. QuoxCORE implements defense-in-depth with DEFCON levels, command denylists, confirmation requirements, and a kill switch. Destructive operations require explicit authorization. Safety isn't an afterthought - it's architectural.</p>
              </div>
            </div>

            <h2 id="why-quox">Why Quox Exists</h2>
            <SectionIntro>
              <p>
                Let's be honest: managing modern infrastructure is a cognitive burden. You're constantly context-switching between Proxmox, Docker, network devices, monitoring systems, and more. Each has its own CLI, API, and quirks. QuoxCORE exists to give you that cognitive space back.
              </p>
            </SectionIntro>
            <p>
              Managing modern infrastructure is complex. A typical homelab or small enterprise might have dozens of hosts across Proxmox clusters, Docker swarms, network appliances, and storage systems. Each has its own CLI, API, and quirks. Operators spend cognitive energy context-switching between systems rather than solving problems.
            </p>
            <p>
              QuoxCORE consolidates this complexity behind a unified conversational interface. It understands that "check if backups ran last night" means querying the backup server logs, that "the wiki is slow" might involve checking container resources on docker02, and that "prepare for maintenance" requires a specific sequence of operations you've done before.
            </p>
            <p>
              More importantly, QuoxCORE learns. It remembers that you prefer detailed output, that your Proxmox cluster uses specific naming conventions, that certain hosts are more critical than others, and that you've had issues with a particular service before. This institutional knowledge - the kind that usually lives only in senior operators' heads - becomes persistent, searchable, and actionable.
            </p>

            <h2 id="core-capabilities">Core Capabilities</h2>
            <div className="docs-feature-list">
              <div className="docs-feature">
                <div className="docs-feature-header">
                  <span className="docs-feature-icon" style={{ color: '#38bdf8' }}>M</span>
                  <h3>Persistent Memory System</h3>
                </div>
                <p>
                  QuoxCORE's memory system is its most distinctive feature. Unlike typical AI assistants that start fresh each conversation, QuoxCORE maintains four types of memory: episodic (conversation history), semantic (learned facts and preferences), entity (infrastructure knowledge graph), and procedural (operational patterns). These memories persist across sessions and are intelligently retrieved based on context.
                </p>
                <p>
                  The memory system uses hybrid retrieval combining vector similarity search (via Qdrant) with traditional keyword matching (BM25), fused using Reciprocal Rank Fusion. This means QuoxCORE can find relevant memories whether you use the exact same words or just similar concepts.
                </p>
              </div>

              <div className="docs-feature">
                <div className="docs-feature-header">
                  <span className="docs-feature-icon" style={{ color: '#3090ff' }}>A</span>
                  <h3>Multi-Agent Architecture</h3>
                </div>
                <p>
                  Rather than one AI trying to be an expert in everything, QuoxCORE uses 11 specialized agents. WARDEN handles security, HYPERION manages Proxmox, VULCAN works with containers, and so on. The orchestrator (QuoxCORE itself) analyzes each query, identifies the relevant domain, and delegates to the appropriate specialist.
                </p>
                <p>
                  Each agent has domain-specific prompting, access to relevant tools, and can maintain its own memory silo for specialized knowledge. When a query spans multiple domains - like "check security on Docker hosts" - agents can collaborate, with QuoxCORE coordinating the interaction.
                </p>
              </div>

              <div className="docs-feature">
                <div className="docs-feature-header">
                  <span className="docs-feature-icon" style={{ color: '#30ff90' }}>V</span>
                  <h3>Voice Interface</h3>
                </div>
                <p>
                  QuoxCORE supports push-to-talk voice input using OpenAI's Whisper for transcription. Responses can be spoken using ElevenLabs text-to-speech with multiple voice personalities. This enables hands-free operation - useful when you're physically at a server rack or monitoring dashboards.
                </p>
                <p>
                  The voice system includes instant acknowledgments (pre-recorded clips that play immediately while the AI processes) to provide responsive feedback. Voice summaries are automatically generated for long responses to keep spoken output concise.
                </p>
              </div>

              <div className="docs-feature">
                <div className="docs-feature-header">
                  <span className="docs-feature-icon" style={{ color: '#ffd93d' }}>S</span>
                  <h3>Safety Guardrails</h3>
                </div>
                <p>
                  Infrastructure automation is powerful but dangerous. QuoxCORE implements multiple safety layers: a command denylist that blocks dangerous operations entirely, DEFCON levels that require escalating confirmation for risky operations, and a kill switch that immediately halts all activity.
                </p>
                <p>
                  The most destructive operations (like VM deletion or recursive file removal) require typing a randomly-generated confirmation code. This isn't security theater - it's a deliberate friction layer that ensures you're consciously authorizing dangerous actions.
                </p>
              </div>
            </div>
          </section>

          {/* ================================================================
              QUICK START SECTION
              ================================================================ */}
          <section id="quick-start" className="docs-section">
            <h1>Quick Start</h1>
            <p className="docs-lead">
              Get up and running with QuoxCORE in under 5 minutes.
            </p>

            <SectionIntro>
              <p>
                This quick start guide will have you chatting with your infrastructure in no time. We'll skip the deep dives and focus on just getting things working. Ready? Let's go!
              </p>
            </SectionIntro>

            <TldrBox>
              Clone the repo, set three API keys, run docker compose up, and open the dashboard. That's it!
            </TldrBox>

            <div className="docs-quick-steps">
              <div className="docs-quick-step">
                <div className="docs-quick-step-num">1</div>
                <div className="docs-quick-step-content">
                  <h3>Clone and Install</h3>
                  <CodeBlock>{`git clone https://github.com/YOUR_USERNAME/quox-dashboard.git
cd quox-dashboard
npm install`}</CodeBlock>
                </div>
              </div>

              <div className="docs-quick-step">
                <div className="docs-quick-step-num">2</div>
                <div className="docs-quick-step-content">
                  <h3>Configure API Keys</h3>
                  <p>Create <code>services/collector/.env</code> with your keys:</p>
                  <CodeBlock>{`ANTHROPIC_API_KEY=sk-ant-...   # Required - Claude AI
OPENAI_API_KEY=sk-...          # For voice transcription
ELEVENLABS_API_KEY=...         # For voice responses`}</CodeBlock>
                </div>
              </div>

              <div className="docs-quick-step">
                <div className="docs-quick-step-num">3</div>
                <div className="docs-quick-step-content">
                  <h3>Start Services</h3>
                  <CodeBlock>{`cd quox-dashboard
docker compose up -d   # Starts collector, auth, memory, dashboard`}</CodeBlock>
                </div>
              </div>

              <div className="docs-quick-step">
                <div className="docs-quick-step-num">4</div>
                <div className="docs-quick-step-content">
                  <h3>Build and Launch</h3>
                  <CodeBlock>{`cd quox-dashboard
npm run build
# Open https://localhost:3443 in your browser`}</CodeBlock>
                </div>
              </div>
            </div>

            <h2 id="first-commands">Your First Commands</h2>
            <p>Once you're in, try these to get a feel for QuoxCORE:</p>

            <div className="docs-example-commands">
              <div className="docs-example-command">
                <div className="docs-example-prompt">"What can you do?"</div>
                <div className="docs-example-desc">QuoxCORE will explain its capabilities and available agents</div>
              </div>
              <div className="docs-example-command">
                <div className="docs-example-prompt">"Check the status of my Docker hosts"</div>
                <div className="docs-example-desc">VULCAN agent will SSH to your Docker hosts and report status</div>
              </div>
              <div className="docs-example-command">
                <div className="docs-example-prompt">"Remember that I prefer verbose output"</div>
                <div className="docs-example-desc">Stores a preference that persists across sessions</div>
              </div>
            </div>

            <h2 id="keyboard-shortcuts">Essential Keyboard Shortcuts</h2>
            <div className="docs-shortcuts-grid">
              <div className="docs-shortcut">
                <kbd>SPACE</kbd>
                <span>Hold to record voice (push-to-talk)</span>
              </div>
              <div className="docs-shortcut">
                <kbd>1</kbd>-<kbd>6</kbd>
                <span>Switch between views</span>
              </div>
              <div className="docs-shortcut">
                <kbd>Ctrl</kbd>+<kbd>K</kbd>
                <span>Search documentation</span>
              </div>
              <div className="docs-shortcut">
                <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>
                <span>Emergency kill switch</span>
              </div>
            </div>

            <div className="docs-callout docs-callout-important">
              <div className="docs-callout-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <div className="docs-callout-content">
                <strong>Need More Detail?</strong>
                <p>This quick start just scratches the surface. Check out the <a href="#setup" onClick={(e) => { e.preventDefault(); scrollTo('setup') }}>Setup Guide</a> for full configuration options, or explore the <a href="#memory" onClick={(e) => { e.preventDefault(); scrollTo('memory') }}>Memory System</a> to understand how QuoxCORE learns and remembers.</p>
              </div>
            </div>
          </section>

          {/* ================================================================
              ARCHITECTURE SECTION
              ================================================================ */}
          <section id="architecture" className="docs-section">
            <h1>System Architecture</h1>
            <p className="docs-lead">
              QuoxCORE uses a layered architecture with React frontend, a native collector service for backend orchestration with QuoxFlow workflows, and SSH-based infrastructure access through a bastion host.
            </p>

            <SectionIntro>
              <p>
                Don't worry if architecture diagrams usually make your eyes glaze over. We'll walk through this layer by layer, explaining what each piece does and why it matters. By the end, you'll understand how a simple question like "check disk space" turns into actual commands running on your servers.
              </p>
            </SectionIntro>

            <TldrBox>
              Browser sends requests to the collector service, which calls Claude AI for intelligence, then executes SSH commands through a bastion host. Results flow back up the chain with memory context added at each step.
            </TldrBox>

            <h2 id="high-level-architecture">High-Level Architecture</h2>
            <div className="docs-diagram-box">
              <pre>{`
+-----------------------------------------------------------------------------+
|                              USER INTERFACE LAYER                            |
+-----------------------------------------------------------------------------+
|                                                                              |
|   +------------------+  +------------------+  +------------------+           |
|   |   React + Vite   |  |   Voice System   |  |   HAL Interface  |           |
|   |   Dashboard      |  |   Whisper + TTS  |  |   Visual State   |           |
|   +--------+---------+  +--------+---------+  +--------+---------+           |
|            |                     |                     |                     |
|            +---------------------+---------------------+                     |
|                                  |                                           |
+----------------------------------+-------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------------+
|                           ORCHESTRATION LAYER                                |
+-----------------------------------------------------------------------------+
|                                                                              |
|   +----------------------------------------------------------+              |
|   |              Collector + QuoxFlow Workflows                |              |
|   |  +------------+  +------------+  +------------+           |              |
|   |  | /chat      |  | /speak     |  | /transcribe|           |              |
|   |  | Claude API |  | ElevenLabs |  | Whisper    |           |              |
|   |  +------------+  +------------+  +------------+           |              |
|   +----------------------------------------------------------+              |
|                                                                              |
|   +------------------+  +------------------+                                 |
|   |   Memory System  |  |   Safety System  |                                 |
|   |   localStorage + |  |   DEFCON levels  |                                 |
|   |   Qdrant vectors |  |   Kill switch    |                                 |
|   +------------------+  +------------------+                                 |
|                                                                              |
+----------------------------------+-------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------------+
|                          INFRASTRUCTURE LAYER                                |
+-----------------------------------------------------------------------------+
|                                                                              |
|   +--------------------------------------------------------------------+    |
|   |                        SSH Bastion (gw-01)                          |    |
|   |                         198.51.100.247                              |    |
|   +--------------------------------+-----------------------------------+     |
|                                    |                                         |
|      +-----------------------------+-----------------------------+           |
|      |                             |                             |           |
|      v                             v                             v           |
|   +----------+              +----------+              +----------+           |
|   | Proxmox  |              |  Docker  |              | Network  |           |
|   | Cluster  |              |  Hosts   |              | Devices  |           |
|   | hyp-01-03|              | edge-01  |              | pfsense  |           |
|   +----------+              | edge-02  |              | pihole   |           |
|                             | edge-03  |              +----------+           |
|                             +----------+                                     |
|                                                                              |
+-----------------------------------------------------------------------------+
`}</pre>
            </div>

            <h2 id="technology-stack">Technology Stack</h2>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h3>Frontend</h3>
                <ul>
                  <li><strong>React 19</strong> - UI framework with hooks and functional components</li>
                  <li><strong>Vite</strong> - Fast build tool and dev server</li>
                  <li><strong>React Router</strong> - Client-side routing</li>
                  <li><strong>CSS</strong> - Custom styling (hal.css, design-system.css)</li>
                  <li><strong>Vitest</strong> - Test framework with 437 passing tests</li>
                </ul>
              </div>
              <div className="docs-card">
                <h3>Backend</h3>
                <ul>
                  <li><strong>Collector</strong> - Native Express service (port 9848) for chat, voice, and fleet APIs</li>
                  <li><strong>QuoxFlow</strong> - TypeScript workflow engine</li>
                  <li><strong>Claude API</strong> - Anthropic's AI for reasoning</li>
                  <li><strong>Whisper</strong> - OpenAI's speech-to-text</li>
                  <li><strong>ElevenLabs</strong> - High-quality text-to-speech</li>
                  <li><strong>Qdrant</strong> - Vector database for semantic search</li>
                </ul>
              </div>
              <div className="docs-card">
                <h3>Storage</h3>
                <ul>
                  <li><strong>localStorage</strong> - Client-side memory persistence</li>
                  <li><strong>Qdrant</strong> - Vector embeddings for semantic search</li>
                  <li><strong>File System</strong> - ./data/memory/</li>
                </ul>
              </div>
              <div className="docs-card">
                <h3>Infrastructure</h3>
                <ul>
                  <li><strong>SSH</strong> - Secure shell through bastion host</li>
                  <li><strong>Proxmox VE</strong> - Virtualization platform</li>
                  <li><strong>Docker</strong> - Container runtime</li>
                  <li><strong>nginx</strong> - Web server for dashboard</li>
                </ul>
              </div>
            </div>

            <h2 id="request-flow">Request Flow</h2>
            <SectionIntro>
              <p>
                Let's follow a real request through the system. Understanding this flow helps you debug issues and appreciate how the pieces fit together.
              </p>
            </SectionIntro>
            <p>
              When you send a message to QuoxCORE, it flows through several processing stages:
            </p>
            <div className="docs-diagram-box">
              <pre>{`
User Input: "Check disk space on docker hosts"
         |
         v
+---------------------------------------------------------------------+
| 1. FRONTEND PROCESSING                                               |
|    - Safety check (is kill switch active?)                           |
|    - Command denylist check                                          |
|    - Memory context assembly (relevant memories for this query)      |
|    - Build request payload with session_id and context               |
+---------------------------------------------------------------------+
         |
         v
+---------------------------------------------------------------------+
| 2. COLLECTOR (/collector/chat)                                       |
|    - Receive request                                                 |
|    - Inject system prompt with infrastructure inventory              |
|    - Call Claude API with assembled prompt                           |
|    - Parse Claude response for actions                               |
+---------------------------------------------------------------------+
         |
         v
+---------------------------------------------------------------------+
| 3. CLAUDE PROCESSING                                                 |
|    - Analyze query intent                                            |
|    - Select appropriate agent (VAULT for storage questions)          |
|    - Generate SSH commands for disk space check                      |
|    - Format results with analysis                                    |
+---------------------------------------------------------------------+
         |
         v
+---------------------------------------------------------------------+
| 4. COMMAND EXECUTION                                                 |
|    - Route through bastion host (gw-01)                           |
|    - Execute: ssh docker01 "df -h"                                   |
|    - Execute: ssh docker02 "df -h"                                   |
|    - Execute: ssh docker03 "df -h"                                   |
|    - Collect and aggregate results                                   |
+---------------------------------------------------------------------+
         |
         v
+---------------------------------------------------------------------+
| 5. RESPONSE PROCESSING                                               |
|    - Format response with tables/formatting                          |
|    - Generate voice summary (if voice mode)                          |
|    - Extract and store new memories                                  |
|    - Update conversation history                                     |
|    - Return to frontend                                              |
+---------------------------------------------------------------------+
         |
         v
    Response: "Docker hosts disk usage:
               docker01: 45% used (234GB free)
               docker02: 67% used (156GB free)
               docker03: 23% used (412GB free)

               Note: docker02 is above 60% - consider cleanup."
`}</pre>
            </div>

            <h2 id="file-structure">File Structure</h2>
            <CodeBlock title="Project Layout">{`quox-dashboard/
+-- src/
|   +-- App.jsx                    # Router setup and main app component
|   +-- main.jsx                   # Entry point, React DOM render
|   |
|   +-- pages/
|   |   +-- views/                 # Main application views
|   |   |   +-- HomeView.jsx       # HAL interface with chat
|   |   |   +-- DashboardView.jsx  # System overview dashboard
|   |   +-- DocsPage.jsx           # Documentation page
|   |
|   +-- components/
|   |   +-- layout/                # AppShell and layout components
|   |   +-- hal/                   # HAL eye visualization components
|   |   |   +-- HALEye.jsx         # Animated eye with state colors
|   |   |   +-- AudioVisualizer.jsx # Voice waveform display
|   |   |
|   |   +-- monitoring/            # Infrastructure monitoring panels
|   |       +-- ProxmoxPanel.jsx   # Proxmox cluster/VM/container view
|   |       +-- MetricsPanel.jsx   # Prometheus metrics display
|   |       +-- UptimePanel.jsx    # Service availability status
|   |
|   +-- services/
|   |   +-- memoryManager.js       # Complete memory system (4000+ lines)
|   |   +-- vectorMemory.js        # Qdrant vector store integration
|   |   +-- proxmoxClient.js       # Proxmox API client
|   |
|   +-- test/
|   |   +-- memoryManager.test.js  # Comprehensive memory tests
|   |
|   +-- styles/
|       +-- hal.css                # HAL interface styling
|       +-- design-system.css      # Design system variables
|       +-- docs.css               # Documentation page styling
|
+-- docs/                          # Additional documentation files
+-- dist/                          # Built files (served by nginx)
+-- package.json                   # Dependencies and scripts
+-- vite.config.js                 # Vite configuration

data/memory/                       # Persistent memory storage (file-based)
+-- profile/                       # User profile data
+-- episodic/                      # Conversation logs by date
+-- semantic/                      # Learned facts and preferences
+-- projects/                      # Project-specific memory

services/collector/                  # Collector service (chat, voice, fleet)
+-- server.js                      # Main Express server
+-- .env                           # API keys (ANTHROPIC, OPENAI, ELEVENLABS, etc.)`}</CodeBlock>
          </section>

          {/* ================================================================
              QuoxAgent AGENT SECTION
              ================================================================ */}
          <section id="quoxagent" className="docs-section">
            <h1>QuoxAgent - Quox Helper Agent</h1>
            <p className="docs-lead">
              QuoxAgent is a lightweight Go daemon that runs on each managed host, enabling direct command execution, metrics collection, and real-time health reporting back to QuoxCORE.
            </p>

            <SectionIntro>
              <p>
                Think of QuoxAgent as QuoxCORE's eyes and hands on each server. While QuoxCORE can work through SSH alone, QuoxAgent provides a direct API that's faster, more reliable, and enables real-time monitoring. It's optional but highly recommended for any host you manage frequently.
              </p>
            </SectionIntro>

            <TldrBox>
              QuoxAgent is a small agent you install on each host. It provides a local API for QuoxCORE to execute commands directly, collect metrics, and monitor health. Install with one command: <code>curl ... | sudo bash</code>
            </TldrBox>

            <div className="docs-callout docs-callout-important">
              <div className="docs-callout-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <div className="docs-callout-content">
                <strong>Why QuoxAgent?</strong>
                <p>Without QuoxAgent, QuoxCORE relies on SSH through a bastion host for all operations. QuoxAgent provides a direct, secure API on each host, enabling faster execution, real-time metrics, and Claude session monitoring.</p>
              </div>
            </div>

            <h2 id="quoxagent-architecture">Architecture</h2>
            <div className="docs-diagram-box">
              <pre>{`
+----------------------------------------------------------------------+
|                        QuoxAgent ARCHITECTURE                               |
+----------------------------------------------------------------------+

+-------------+     +-------------+     +-------------+
|   Host A    |     |   Host B    |     |   Host C    |
|  QuoxAgent:9847   |     |  QuoxAgent:9847   |     |  QuoxAgent:9847   |
+------+------+     +------+------+     +------+------+
       |                   |                   |
       |   Heartbeat (every 30s)               |
       v                   v                   v
+----------------------------------------------------------------------+
|                    COLLECTOR (quox:9848)                             |
|  - Receives heartbeats                                               |
|  - Stores fleet status                                               |
|  - Provides API for dashboard                                        |
|  - Serves install script                                             |
+----------------------------------------------------------------------+
       ^
       | HTTP/WebSocket
       v
+----------------------------------------------------------------------+
|                    DASHBOARD (quox:3443)                             |
|  - Fleet panel in INFRA view                                         |
|  - Auto-detects hosts without QuoxAgent                                    |
|  - Triggers remote job execution                                     |
+----------------------------------------------------------------------+`}</pre>
            </div>

            <h2 id="quoxagent-installation">Installation</h2>
            <p>QuoxAgent can be installed on any host with a single command:</p>

            <h3 id="method-1-oneliner">Method 1: One-liner (on target host)</h3>
            <CodeBlock>{`curl -sSL http://10.0.0.126:9848/install | sudo bash -s -- --host-id $(hostname)`}</CodeBlock>

            <h3 id="method-2-remote">Method 2: Remote Deploy (from quox)</h3>
            <CodeBlock>{`# Check status on a host
quoxagent-deploy --check kuma01

# Install on specific hosts
quoxagent-deploy kuma01 gw-01

# Install on all known hosts
quoxagent-deploy all

# Uninstall
quoxagent-deploy --uninstall kuma01`}</CodeBlock>

            <h2 id="quoxagent-api">API Endpoints</h2>

            <h3 id="collector-api">Collector API (port 9848)</h3>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr><th>Endpoint</th><th>Method</th><th>Description</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>/api/v1/heartbeat</code></td><td>POST</td><td>Receive agent heartbeat</td></tr>
                  <tr><td><code>/api/v1/agents</code></td><td>GET</td><td>List all connected agents</td></tr>
                  <tr><td><code>/api/v1/agents/:id</code></td><td>GET</td><td>Get single agent details</td></tr>
                  <tr><td><code>/api/v1/fleet/summary</code></td><td>GET</td><td>Fleet summary statistics</td></tr>
                  <tr><td><code>/api/v1/check/:hostId</code></td><td>GET</td><td>Check if host has QuoxAgent</td></tr>
                  <tr><td><code>/install</code></td><td>GET</td><td>Serve installation script</td></tr>
                  <tr><td><code>/download/quoxagent-linux-amd64</code></td><td>GET</td><td>Download QuoxAgent binary</td></tr>
                  <tr><td><code>/health</code></td><td>GET</td><td>Collector health check</td></tr>
                  <tr><td><code>/ws</code></td><td>WS</td><td>Real-time fleet updates</td></tr>
                </tbody>
              </table>
            </div>

            <h3 id="agent-api">Agent API (port 9847)</h3>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr><th>Endpoint</th><th>Method</th><th>Description</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>/health</code></td><td>GET</td><td>Agent health check</td></tr>
                  <tr><td><code>/api/v1/jobs</code></td><td>GET/POST</td><td>List/submit jobs</td></tr>
                  <tr><td><code>/api/v1/sessions</code></td><td>GET</td><td>Active Claude sessions</td></tr>
                  <tr><td><code>/metrics</code></td><td>GET</td><td>Prometheus metrics</td></tr>
                </tbody>
              </table>
            </div>

            <h2 id="quoxagent-configuration">Configuration</h2>
            <CodeBlock title="/etc/quoxagent/quoxagent.yaml">{`agent:
  host_id: "docker01"
  log_level: info
  data_dir: /var/lib/quoxagent
  tools_dir: /opt/quoxagent/tools

heartbeat:
  interval: 30s
  collector_url: "http://10.0.0.126:9848"
  mode: push
  timeout: 10s

api:
  listen: "0.0.0.0:9847"
  enable_metrics: true

audit:
  enabled: true
  path: /var/lib/quoxagent/audit/audit.log`}</CodeBlock>

            <h2 id="quoxagent-project-structure">Project Structure</h2>
            <CodeBlock title="QuoxAgent Source Layout">{`quoxagent/   # QuoxAgent Helper Agent project
+-- cmd/quoxagent/main.go              # Daemon entry point
+-- internal/
|   +-- agent/                   # Lifecycle management
|   +-- heartbeat/               # Heartbeat + metrics collection
|   +-- metrics/                 # Prometheus endpoint
|   +-- runner/                  # Job execution (sandboxed)
|   +-- api/                     # HTTP API server
+-- configs/
|   +-- quoxagent-push.yaml           # Default configuration
+-- deploy/
|   +-- install.sh              # Installation script
|   +-- deploy-to-host.sh       # Remote deployment script
+-- bin/quoxagent                      # Compiled binary`}</CodeBlock>
          </section>

          {/* ================================================================
              SELF-AWARENESS SECTION
              ================================================================ */}
          <section id="self-awareness" className="docs-section">
            <h1>Self-Awareness System</h1>
            <p className="docs-lead">
              QuoxCORE includes a hardwired self-knowledge system that ensures all AI agents know what QuoxCORE is, what they can do, and how to help users with infrastructure operations.
            </p>

            <SectionIntro>
              <p>
                Here's a funny thing about AI assistants: they don't automatically know what product they're part of. Without explicit self-knowledge, Claude would have no idea it's running inside QuoxCORE, what QuoxAgent is, or how your infrastructure is set up. The self-awareness system solves this by injecting context into every request.
              </p>
            </SectionIntro>

            <TldrBox>
              Every AI request includes injected context about QuoxCORE's identity, capabilities, fleet status, and available tools. This lets Claude answer questions like "what can you do?" and "install QuoxAgent on docker01" intelligently.
            </TldrBox>

            <div className="docs-callout docs-callout-important">
              <div className="docs-callout-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
              </div>
              <div className="docs-callout-content">
                <strong>Why Self-Awareness?</strong>
                <p>Without hardwired self-knowledge, AI agents have no idea they're part of QuoxCORE. They don't know about QuoxAgent, can't install it, and can't describe their own capabilities. The self-awareness system injects this knowledge into every LLM request.</p>
              </div>
            </div>

            <h2 id="what-gets-injected">What Gets Injected</h2>
            <p>Every request to the AI backend includes:</p>
            <ul>
              <li><strong>QuoxCORE Identity</strong> - What QuoxCORE is and its purpose</li>
              <li><strong>Agent Hierarchy</strong> - QuoxCORE Managers Specialists</li>
              <li><strong>QuoxAgent Documentation</strong> - What QuoxAgent is, installation commands</li>
              <li><strong>Fleet Status</strong> - Connected agents, hosts without QuoxAgent</li>
              <li><strong>Available Tools</strong> - What each agent can do</li>
            </ul>

            <h2 id="self-awareness-architecture">Architecture</h2>
            <div className="docs-diagram-box">
              <pre>{`
+----------------------------------------------------------------------+
|                     USER QUERY                                        |
|                "Install QuoxAgent on kuma01"                                |
+----------------------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------------------+
|               SELF-AWARENESS INJECTION                                |
|  +----------------------------------------------------------------+  |
|  |  quoxContext.js                                              |  |
|  |  - QuoxCORE_IDENTITY (who we are)                               |  |
|  |  - QuoxAgent_DOCUMENTATION (how to install)                          |  |
|  |  - getFleetStatus() (dynamic fleet state)                      |  |
|  |  - Host registry (all known hosts + aliases)                   |  |
|  +----------------------------------------------------------------+  |
+----------------------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------------------+
|                    COLLECTOR                                          |
|          Receives: prompt + quox_context                           |
+----------------------------------------------------------------------+
                           |
                           v
+----------------------------------------------------------------------+
|                    CLAUDE / LLM                                       |
|     Now knows: "I'm QuoxCORE, QuoxAgent installs via quoxagent-deploy..."         |
+----------------------------------------------------------------------+`}</pre>
            </div>

            <h2 id="host-detection">Host Detection</h2>
            <p>The system includes intelligent host detection with aliases:</p>
            <CodeBlock title="Host Registry Example">{`// Centralized host registry (src/config/hosts.js)
hostRegistry = {
  proxmox: ['proxmox01', 'proxmox02', 'proxmox03'],
  docker: ['docker01', 'docker02', 'docker03', 'docker04'],
  monitoring: ['grafana01', 'prometheus01', 'kuma01', 'wazuh01'],
  network: ['pfsense01', 'pihole01', 'pihole02'],
  storage: ['nas01', 'truenas01'],
  access: ['gw-01']
}

// Aliases - "kuma" resolves to "kuma01"
aliases: {
  'kuma': 'kuma01',
  'grafana': 'grafana01',
  'prom': 'prometheus01',
  'pve': 'proxmox01'
}`}</CodeBlock>

            <h2 id="self-awareness-files">Key Files</h2>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr><th>File</th><th>Purpose</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>src/services/quoxContext.js</code></td><td>Self-knowledge generator</td></tr>
                  <tr><td><code>src/config/hosts.js</code></td><td>Centralized host registry</td></tr>
                  <tr><td><code>src/config/agentRegistry.js</code></td><td>Agent capabilities</td></tr>
                  <tr><td><code>src/config/assistants.js</code></td><td>Agent personalities</td></tr>
                </tbody>
              </table>
            </div>

            <h2 id="self-awareness-usage">Usage in Code</h2>
            <CodeBlock title="JavaScript API">{`import { formatContextForSystemPrompt, isQuoxQuery } from '../services/quoxContext'
import { getAllHostnames, extractHostsFromQuery } from '../config/hosts'

// Generate full context for LLM injection
const quoxContext = await formatContextForSystemPrompt()

// Check if query is about QuoxCORE/QuoxAgent
if (isQuoxQuery("What can you do?")) {
  // Handle specially or enrich context
}

// Detect hosts in user query
const hosts = extractHostsFromQuery("Check disk on kuma and prom")
// Returns: ['kuma01', 'prometheus01']`}</CodeBlock>
          </section>

          {/* ================================================================
              MEMORY SYSTEM SECTION
              ================================================================ */}
          <section id="memory" className="docs-section">
            <h1>Memory System</h1>
            <p className="docs-lead">
              QuoxCORE's memory system is what sets it apart from typical AI assistants. Rather than starting fresh each conversation, QuoxCORE builds a persistent understanding of you, your infrastructure, and your operational patterns.
            </p>

            <SectionIntro>
              <p>
                Have you ever been frustrated by AI assistants that forget everything the moment you close the tab? QuoxCORE's memory system solves this comprehensively. It's not just storing chat history - it's learning facts, tracking your infrastructure entities, understanding your preferences, and building operational knowledge over time. This is probably the most sophisticated part of QuoxCORE, so let's break it down.
              </p>
            </SectionIntro>

            <TldrBox>
              Four memory types (episodic, semantic, entity, procedural) store everything from raw conversations to learned facts to infrastructure maps. Hybrid search (vector + keyword) finds relevant context for every query. 10-phase implementation covers extraction, search, maintenance, privacy, and natural language commands.
            </TldrBox>

            <div className="docs-callout docs-callout-important">
              <div className="docs-callout-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <div className="docs-callout-content">
                <strong>Why Memory Matters</strong>
                <p>Without memory, every conversation with an AI assistant is like meeting a stranger. You repeat your preferences, re-explain your infrastructure, and lose all context from previous sessions. QuoxCORE's memory system solves this by maintaining persistent, searchable, and intelligent memory that improves with every interaction.</p>
              </div>
            </div>

            <h2 id="memory-architecture">Memory Architecture</h2>
            <p>
              The memory system is built on four fundamental memory types, each serving a distinct purpose. These memory types work together to provide comprehensive context for every interaction.
            </p>
            <div className="docs-diagram-box">
              <pre>{`
+-----------------------------------------------------------------------------+
|                         MEMORY SYSTEM ARCHITECTURE                           |
+-----------------------------------------------------------------------------+
|                                                                              |
|   +-------------------+    +-------------------+    +-------------------+    |
|   |     EPISODIC      |    |     SEMANTIC      |    |      ENTITY       |    |
|   |     Memory        |    |     Memory        |    |      Memory       |    |
|   |                   |    |                   |    |                   |    |
|   |  * Conversations  |    |  * Facts          |    |  * Hosts          |    |
|   |  * Timestamps     |    |  * Preferences    |    |  * Services       |    |
|   |  * Session IDs    |    |  * Decisions      |    |  * IPs            |    |
|   |  * Full context   |    |  * Constraints    |    |  * Containers     |    |
|   |                   |    |  * Error patterns |    |  * Relationships  |    |
|   +---------+---------+    +---------+---------+    +---------+---------+    |
|             |                        |                        |              |
|             |         +--------------+--------------+         |              |
|             |         |      PROCEDURAL Memory      |         |              |
|             |         |  * Workflows & runbooks     |         |              |
|             |         |  * Command sequences        |         |              |
|             |         |  * Operational patterns     |         |              |
|             |         +--------------+--------------+         |              |
|             |                        |                        |              |
|             +------------------------+------------------------+              |
|                                      v                                       |
|              +-----------------------------------------------+               |
|              |            HYBRID RETRIEVAL                   |               |
|              |  +-------------+    +-------------+           |               |
|              |  |   Vector    |    |   Keyword   |           |               |
|              |  |   Search    | +  |   Search    |           |               |
|              |  |  (Qdrant)   |    |   (BM25)    |           |               |
|              |  +------+------+    +------+------+           |               |
|              |         +------+----------+                   |               |
|              |                v                              |               |
|              |         +-------------+                       |               |
|              |         |  RRF Fusion |                       |               |
|              |         +------+------+                       |               |
|              +----------------+------------------------------+               |
|                               v                                              |
|                    +--------------------+                                    |
|                    |  CONTEXT INJECTION |                                    |
|                    |  Into Claude Prompt |                                   |
|                    +--------------------+                                    |
|                                                                              |
+-----------------------------------------------------------------------------+
`}</pre>
            </div>

            <h2 id="four-memory-types">The Four Memory Types</h2>
            <p>
              Understanding the different memory types helps you understand how QuoxCORE processes and recalls information:
            </p>

            <div className="docs-memory-types">
              {MEMORY_TYPES.map(mem => (
                <div key={mem.type} className="docs-memory-type-card" style={{ '--mem-color': mem.color }}>
                  <div className="docs-memory-type-header">
                    <div className="docs-memory-type-icon">{mem.icon}</div>
                    <h3>{mem.type} Memory</h3>
                  </div>
                  <p className="docs-memory-type-desc">{mem.desc}</p>
                  <p className="docs-memory-type-details">{mem.details}</p>
                </div>
              ))}
            </div>

            <h2 id="ten-phases">10-Phase Implementation</h2>
            <SectionIntro>
              <p>
                The memory system wasn't built in a day. It evolved through 10 distinct phases, each adding critical capabilities. Here's what each phase contributed:
              </p>
            </SectionIntro>

            <div className="docs-phases-detailed">
              {[
                { num: 1, title: 'Core Memory Operations', desc: 'The foundation layer that handles basic memory storage and retrieval. This phase implemented episodic logging (storing every conversation with timestamps), semantic extraction (identifying important information in conversations), and salience scoring (determining what\'s worth remembering long-term).', caps: 'Store conversations, extract semantic content, score importance (0.0-1.0), threshold-based persistence decisions.' },
                { num: 2, title: 'Project & Entity Memory', desc: 'Adds the ability to track projects and infrastructure entities as first-class objects. Entities include hosts, services, IP addresses, containers, and their relationships. This creates a knowledge graph of your infrastructure that QuoxCORE can query and reason about.', caps: 'Entity storage with typed schema, relationship mapping (host runs service, container depends on volume), project tracking with associated memories.' },
                { num: 3, title: 'Agent-Specific Memory', desc: 'Enables each AI agent to maintain its own specialized memory silo. WARDEN remembers security findings, HYPERION remembers Proxmox configurations, VULCAN remembers container patterns. This specialization improves retrieval relevance and allows agents to build domain expertise.', caps: 'Per-agent memory partitions, agent-scoped queries, cross-agent memory sharing with permissions, delegation context preservation.' },
                { num: 4, title: 'Search & Retrieval', desc: 'Implements unified search across all memory types. Before this phase, you could only query specific memory categories. Now a single search query finds relevant episodic conversations, semantic facts, entities, and procedural knowledge, ranked by relevance.', caps: 'Cross-memory-type search, keyword matching, relevance scoring, result deduplication, configurable result limits.' },
                { num: 5, title: 'Maintenance & Health', desc: 'Adds memory maintenance capabilities to keep the system healthy over time. Includes memory decay (reducing salience of old, unreferenced memories), consolidation (merging near-duplicate memories), and pruning (removing low-value memories to prevent bloat).', caps: 'Automatic decay scheduling, duplicate detection via Jaccard similarity, configurable pruning thresholds, memory health statistics.' },
                { num: 6, title: 'User Preferences', desc: 'Implements a structured preference system with categories and smart defaults. Rather than storing preferences as unstructured text, they\'re organized into categories (communication, technical, workflow, time) with specific keys and values.', caps: 'Categorized preferences, inheritance from defaults, preference conflict resolution, preference extraction from natural language.' },
                { num: 7, title: 'Advanced Retrieval (Hybrid Search)', desc: 'Upgrades the search system with vector-based semantic search via Qdrant, combined with traditional BM25 keyword search. The results are fused using Reciprocal Rank Fusion (RRF), which combines the strengths of both approaches.', caps: 'Vector embeddings for all memories, Qdrant integration, BM25 keyword scoring, RRF fusion with configurable weights, result reranking.' },
                { num: 8, title: 'Intelligent Personalization', desc: 'Adds behavioral analysis to understand user patterns beyond explicit preferences. Includes behavioral clustering (grouping similar interaction patterns), style fingerprinting (identifying communication style), and adaptive response generation.', caps: 'Interaction pattern analysis, communication style detection, response adaptation, time-of-day preference learning, expertise level inference.' },
                { num: 9, title: 'Intelligence & Synthesis', desc: 'Enables the memory system to generate insights, not just store and retrieve. Includes knowledge synthesis (combining related memories into higher-level understanding), trend detection (identifying patterns over time), and predictive memory loading.', caps: 'Automatic insight generation, trend analysis across memories, predictive context loading, narrative arc detection, reflection cycles.' },
                { num: 10, title: 'Experience Layer', desc: 'The user-facing memory experience. Includes natural language memory commands ("remember that I prefer verbose output"), memory visualization data for UI components, privacy controls with sensitivity levels, and export/import/backup capabilities.', caps: 'Natural language memory CRUD, visualization APIs, 5-tier privacy levels with auto-expiration, encrypted export, scheduled backups, health scoring.' },
              ].map(phase => (
                <div key={phase.num} className="docs-phase-detailed">
                  <div className="docs-phase-header">
                    <span className="docs-phase-num">{phase.num}</span>
                    <h3>{phase.title}</h3>
                  </div>
                  <div className="docs-phase-body">
                    <p>{phase.desc}</p>
                    <p><strong>Key capabilities:</strong> {phase.caps}</p>
                  </div>
                </div>
              ))}
            </div>

            <h2 id="memory-commands">Natural Language Memory Commands</h2>
            <SectionIntro>
              <p>
                One of the coolest features is that you don't need to learn an API - just tell QuoxCORE what you want to remember, recall, or forget in plain English.
              </p>
            </SectionIntro>

            <CodeBlock title="Remember Commands">{`// Store new memories
"Remember that I prefer verbose output for debugging"
  -> Stores as preference: communication.verbosity = "verbose"

"Note that docker01 runs the main Postgres database on port 5432"
  -> Stores as fact + creates entity relationship

"Save that backups run at 3am via the restic-backup container"
  -> Stores as fact + links to procedural workflow

"Keep in mind that we had issues with docker02's disk last month"
  -> Stores with temporal context for future relevance`}</CodeBlock>

            <CodeBlock title="Query Commands">{`// Retrieve memories
"What do you know about proxmox?"
  -> Searches all memory types for proxmox-related content

"Recall my Docker preferences"
  -> Filters to preference memories + entity memories about Docker

"Search memories for network configuration"
  -> Full hybrid search across episodic, semantic, entity memories

"What have we discussed about backup strategies?"
  -> Searches episodic memories for backup-related conversations`}</CodeBlock>

            <CodeBlock title="Update and Delete Commands">{`// Modify memories
"Forget about the old API key for docker-registry"
  -> Deletes matching sensitive memories

"Update my timezone preference to EST"
  -> Modifies existing preference with new value

"Correct that - the server is actually running Ubuntu 24, not 22"
  -> Updates fact with contradiction detection

"Delete all memories about the decomissioned nas02 server"
  -> Removes entity and all related memories`}</CodeBlock>

            <h2 id="hybrid-search">Hybrid Search: Vector + Keyword</h2>
            <p>
              QuoxCORE uses a sophisticated hybrid search that combines two complementary approaches:
            </p>

            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h3>Vector Search (Semantic)</h3>
                <p>
                  Memories are converted to vector embeddings and stored in Qdrant. When you search, your query is also embedded, and we find memories with similar vector representations. This finds conceptually similar content even when the words are different.
                </p>
                <p>
                  <strong>Example:</strong> Searching "disk space issues" finds memories about "storage running low" and "filesystem full" even though they use different words.
                </p>
              </div>
              <div className="docs-card">
                <h3>Keyword Search (BM25)</h3>
                <p>
                  Traditional keyword matching using the BM25 algorithm. This excels at finding exact matches for specific terms, names, and identifiers that vector search might miss.
                </p>
                <p>
                  <strong>Example:</strong> Searching "docker02" finds all memories mentioning that specific hostname, even if the semantic meaning varies.
                </p>
              </div>
            </div>

            <p>
              Results from both approaches are combined using <strong>Reciprocal Rank Fusion (RRF)</strong>, which weighs results based on their rank in each search. A memory that ranks highly in both searches will score higher than one that only appears in one. This gives you the best of both worlds: semantic understanding and keyword precision.
            </p>

            <h2 id="privacy-security">Privacy & Security</h2>
            <p>
              Memory systems inherently store sensitive information. QuoxCORE implements multiple layers of privacy protection:
            </p>

            <h3 id="sensitivity-levels">Sensitivity Levels</h3>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr><th>Level</th><th>Description</th><th>Auto-Expiration</th><th>Restrictions</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td><span className="docs-sensitivity docs-sensitivity-public">Public</span></td>
                    <td>General information with no restrictions</td>
                    <td>Never</td>
                    <td>None</td>
                  </tr>
                  <tr>
                    <td><span className="docs-sensitivity docs-sensitivity-normal">Normal</span></td>
                    <td>Default level for most memories</td>
                    <td>Never</td>
                    <td>Standard handling</td>
                  </tr>
                  <tr>
                    <td><span className="docs-sensitivity docs-sensitivity-private">Private</span></td>
                    <td>Personal information, internal details</td>
                    <td>90 days</td>
                    <td>Excluded from exports by default</td>
                  </tr>
                  <tr>
                    <td><span className="docs-sensitivity docs-sensitivity-sensitive">Sensitive</span></td>
                    <td>Passwords, internal IPs, personal data</td>
                    <td>30 days</td>
                    <td>Anonymized in logs, encrypted at rest</td>
                  </tr>
                  <tr>
                    <td><span className="docs-sensitivity docs-sensitivity-confidential">Confidential</span></td>
                    <td>API keys, credentials, secrets</td>
                    <td>7 days</td>
                    <td>Masked display, never exported, auto-delete</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h3 id="automatic-detection">Automatic Detection</h3>
            <p>
              QuoxCORE automatically detects sensitive content and applies appropriate privacy levels:
            </p>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h4>Detected as Confidential</h4>
                <ul>
                  <li>Social Security Numbers (XXX-XX-XXXX pattern)</li>
                  <li>Credit card numbers (16-digit patterns)</li>
                  <li>API keys (sk-*, Bearer tokens)</li>
                  <li>Passwords in connection strings</li>
                  <li>Private keys (BEGIN PRIVATE KEY)</li>
                </ul>
              </div>
              <div className="docs-card">
                <h4>Detected as Private</h4>
                <ul>
                  <li>Email addresses</li>
                  <li>Phone numbers</li>
                  <li>Internal IP addresses (192.168.*, 10.*)</li>
                  <li>File paths containing "password" or "secret"</li>
                  <li>Database connection strings</li>
                </ul>
              </div>
            </div>

            <h2 id="memory-api">Memory API Reference</h2>
            <p>
              For developers integrating with the memory system, here's the complete API:
            </p>
            <CodeBlock title="JavaScript API - Full Reference">{`import { getMemoryManager } from './services/memoryManager'
const mm = getMemoryManager()

// ===============================================================================
// PROFILE & PREFERENCES
// ===============================================================================

mm.getProfile()                                    // Get complete user profile
mm.updateProfile({ name, timezone, ... })          // Update profile fields

mm.setPreference('communication', 'verbosity', 'detailed')  // Set preference
mm.getPreference('communication', 'verbosity')              // Get single pref
mm.getAllPreferences()                             // All prefs with defaults
mm.getPreferencesByCategory('technical')           // Category-filtered prefs

// ===============================================================================
// LEARNING & STORAGE
// ===============================================================================

// Types: 'fact', 'preference', 'decision', 'constraint', 'error', 'workflow'
mm.addLearnedItem('fact', {
  content: 'Docker runs on port 2376',
  source: 'user_stated',
  confidence: 0.9
})

mm.getLearnedMemories(query)                       // Query-filtered retrieval
mm.getLearnedMemoriesByType('decision')            // Type-filtered retrieval
mm.updateLearnedItem(id, { content: 'updated...' })
mm.deleteLearnedItem(id)

// ===============================================================================
// ENTITY MEMORY (Knowledge Graph)
// ===============================================================================

mm.storeEntity({
  type: 'host',                 // host, service, container, network, storage
  name: 'docker01',
  ip: '10.0.0.101',
  metadata: { os: 'Ubuntu 24.04', role: 'container-host' }
})

mm.getEntity('docker01')                           // Get by name
mm.getEntitiesByType('host')                       // Get all hosts
mm.getAllEntities()                                // Get everything
mm.addEntityRelationship('docker01', 'runs', 'wiki-container')
mm.getEntityRelationships('docker01')              // All relationships
mm.deleteEntity('old-server')

// ===============================================================================
// SEARCH & RETRIEVAL
// ===============================================================================

mm.hybridSearch(query, {                           // Vector + keyword with RRF
  limit: 10,
  memoryTypes: ['semantic', 'entity'],             // Filter by type
  minScore: 0.3,                                   // Minimum relevance
  timeRange: { start: Date, end: Date }            // Time filter
})

mm.searchAll(query)                                // Search all memory types
mm.searchEpisodic(query, { sessionId })            // Search conversations
mm.searchSemantic(query, { type: 'fact' })         // Search learned items

// ===============================================================================
// MAINTENANCE & HEALTH
// ===============================================================================

mm.runMaintenance()                                // Full maintenance cycle
mm.consolidateMemories(0.6)                        // Merge duplicates (threshold)
mm.detectContradictions()                          // Find conflicting memories
mm.findDuplicateMemories(0.6)                      // Find near-duplicates
mm.pruneMemories({ maxAge: 90, minSalience: 0.2 }) // Remove old/low-value
mm.applyDecay()                                    // Reduce old memory salience

mm.getMemoryStats()                                // Basic statistics
mm.getMemoryHealthScore()                          // Health score 0-100
mm.getDashboardMetrics()                           // Full dashboard data
mm.getQuickOverview()                              // Quick status summary

// ===============================================================================
// EXPORT, IMPORT & BACKUP
// ===============================================================================

mm.exportAllMemories({                             // Full export
  includePrivate: false,                           // Exclude private+ levels
  format: 'json'                                   // json or encrypted
})

mm.importMemories(data, {                          // Import from export
  merge: true,                                     // Merge vs replace
  onConflict: 'keep_newer'                         // Conflict resolution
})

mm.createBackup()                                  // Create timestamped backup
mm.listBackups()                                   // List available backups
mm.restoreFromBackup(backupId)                     // Restore from backup

mm.clearMemory()                                   // Warning: Clear all memory`}</CodeBlock>
          </section>

          {/* ================================================================
              AGENTS SECTION
              ================================================================ */}
          <section id="agents" className="docs-section">
            <h1>AI Agents</h1>
            <p className="docs-lead">
              QuoxCORE uses a multi-agent architecture with 11 specialized agents. Rather than one AI trying to be an expert in everything, each agent has deep expertise in a specific domain.
            </p>

            <SectionIntro>
              <p>
                Think of QuoxCORE's agents like a team of specialists. When you ask about security, WARDEN handles it. Container questions go to VULCAN. Proxmox operations route to HYPERION. The orchestrator (QuoxCORE itself) is like a smart receptionist that understands your request and routes it to the right expert.
              </p>
            </SectionIntro>

            <TldrBox>
              11 specialized agents (WARDEN for security, VULCAN for containers, HYPERION for Proxmox, etc.) each have domain expertise, dedicated tools, and their own memory silos. The QuoxCORE orchestrator analyzes queries and delegates to the right specialist.
            </TldrBox>

            <h2 id="why-multi-agent">Why Multi-Agent?</h2>
            <p>
              A single AI trying to handle security, networking, containers, monitoring, and storage will inevitably have knowledge gaps and inconsistent performance across domains. By specializing agents, we get:
            </p>
            <ul>
              <li><strong>Deeper expertise</strong> - Each agent has domain-specific prompting and tool access</li>
              <li><strong>Better accuracy</strong> - Agents can focus on what they know best</li>
              <li><strong>Clearer reasoning</strong> - Domain boundaries make it clear which agent should handle what</li>
              <li><strong>Specialized memory</strong> - Agents maintain domain-specific knowledge bases</li>
              <li><strong>Parallel operation</strong> - Multiple agents can work on different aspects simultaneously</li>
            </ul>

            <h2 id="agent-roster">Agent Roster</h2>
            <div className="docs-agents-detailed">
              {AGENTS.map(agent => (
                <div key={agent.id} className="docs-agent-detailed" style={{ '--agent-color': agent.color }}>
                  <div className="docs-agent-header">
                    <div className="docs-agent-dot-large" />
                    <div className="docs-agent-title">
                      <span className="docs-agent-name-large">{agent.name}</span>
                      <span className="docs-agent-specialty-badge">{agent.specialty}</span>
                    </div>
                  </div>
                  <p className="docs-agent-desc-large">{agent.desc}</p>
                  <div className="docs-agent-tools">
                    <span className="docs-agent-tools-label">Tools:</span>
                    {agent.tools.map((tool, i) => (
                      <span key={i} className="docs-agent-tool">{tool}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <h2 id="delegation-flow">Delegation Flow</h2>
            <p>
              When you send a query to QuoxCORE, it goes through an intelligent delegation process:
            </p>
            <div className="docs-diagram-box">
              <pre>{`
User Query: "Check if there are any security vulnerabilities on docker01"
                                          |
                                          v
+------------------------------------------------------------------------------+
|  QuoxCORE (Orchestrator)                                                       |
|                                                                               |
|  Query Analysis:                                                              |
|  * Domain keywords: "security", "vulnerabilities" -> Security domain          |
|  * Target entity: "docker01" -> Specific host                                 |
|  * Action type: "check" -> Read operation (safe)                              |
|  * Confidence: 0.95 -> High confidence in WARDEN                              |
|                                                                               |
|  Decision: Delegate to WARDEN with docker01 context                           |
+------------------------------------------------------------------------------+
                                          |
                                          v
+------------------------------------------------------------------------------+
|  WARDEN (Security Specialist)                                                 |
|                                                                               |
|  Received context:                                                            |
|  * Target: docker01 (10.0.0.101)                                          |
|  * Task: Vulnerability assessment                                             |
|  * Memory: Previous scans, known issues, host configuration                   |
|                                                                               |
|  Execution plan:                                                              |
|  1. SSH to docker01 via bastion                                               |
|  2. Run lynis audit system                                                    |
|  3. Check fail2ban status                                                     |
|  4. Review recent auth logs                                                   |
|  5. Compare with previous scan results                                        |
+------------------------------------------------------------------------------+
                                          |
                                          v
+------------------------------------------------------------------------------+
|  Response Assembly                                                            |
|                                                                               |
|  WARDEN compiles results:                                                     |
|  * Lynis score: 78/100 (Good, up from 72 last month)                          |
|  * fail2ban: Active, 3 IPs currently banned                                   |
|  * Auth logs: 47 failed SSH attempts (normal for public-facing host)          |
|  * Recommendations: Update 2 packages, consider hardening SSH config          |
+------------------------------------------------------------------------------+
`}</pre>
            </div>

            <h2 id="cross-agent">Cross-Agent Collaboration</h2>
            <p>
              Some queries span multiple domains. In these cases, agents collaborate:
            </p>
            <CodeBlock title="Multi-Agent Query Example">{`User: "Why is the wiki slow? It's been getting complaints all week."

QuoxCORE Analysis:
* Performance issue ("slow") -> Could be multiple causes
* Service mentioned ("wiki") -> Container on docker02
* Timeframe ("all week") -> Trend analysis needed

Delegation:
1. VULCAN -> Check wiki container resource usage, logs, health
2. METRICS -> Pull Prometheus metrics for wiki over past week
3. INSIGHT -> Analyze trends and correlate events

Parallel Execution:
+-------------+  +-------------+  +-------------+
|   VULCAN    |  |   METRICS   |  |   INSIGHT   |
|             |  |             |  |             |
| docker stats|  | promql for  |  | log pattern |
| container   |  | wiki_*      |  | analysis    |
| logs        |  | metrics     |  |             |
+------+------+  +------+------+  +------+------+
       |                |                |
       +----------------+----------------+
                        v
              QuoxCORE Synthesis:
              "The wiki container is CPU-throttled because the
              docker02 host is overloaded. Metrics show CPU
              saturation started Tuesday when the backup job
              was rescheduled to run during business hours.
              Recommendation: Move backup job back to 3am."`}</CodeBlock>

            <h2 id="agent-memory">Agent Memory Silos</h2>
            <p>
              Each agent maintains its own specialized memory, which improves retrieval relevance:
            </p>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h4>WARDEN's Memory</h4>
                <ul>
                  <li>Previous vulnerability scan results</li>
                  <li>Known CVEs affecting this infrastructure</li>
                  <li>Security incidents and their resolution</li>
                  <li>Compliance requirements and audit history</li>
                </ul>
              </div>
              <div className="docs-card">
                <h4>HYPERION's Memory</h4>
                <ul>
                  <li>VM configurations and templates</li>
                  <li>Cluster maintenance history</li>
                  <li>Resource allocation patterns</li>
                  <li>Migration and backup schedules</li>
                </ul>
              </div>
            </div>
          </section>

          {/* ================================================================
              VOICE CONTROL SECTION
              ================================================================ */}
          <section id="voice" className="docs-section">
            <h1>Voice Control</h1>
            <p className="docs-lead">
              QuoxCORE supports full voice interaction through push-to-talk input, instant acknowledgments, and natural speech responses.
            </p>

            <SectionIntro>
              <p>
                Sometimes you can't type - maybe you're racking a server, or your hands are full of cables, or you're just monitoring dashboards across the room. Voice control lets you interact with QuoxCORE naturally, and the instant acknowledgments ("Got it", "Working on that") make the experience feel responsive even while the AI is processing.
              </p>
            </SectionIntro>

            <TldrBox>
              Hold SPACE to record, release to send. Whisper transcribes your speech, Claude processes it, ElevenLabs speaks the response. Multiple voice personalities available. Instant acknowledgments play while AI processes.
            </TldrBox>

            <h2 id="voice-pipeline">Voice Pipeline</h2>
            <div className="docs-diagram-box">
              <pre>{`
+------------------------------------------------------------------------------+
|  VOICE INPUT PIPELINE                                                         |
+------------------------------------------------------------------------------+
|                                                                               |
|  User holds SPACE key                                                         |
|         |                                                                     |
|         v                                                                     |
|  +------------------+                                                         |
|  | Audio Recording  |  Browser MediaRecorder API                              |
|  | (while held)     |  Sample rate: 16kHz mono                                |
|  +--------+---------+                                                         |
|           |                                                                   |
|           v  User releases SPACE                                              |
|  +------------------+                                                         |
|  | Instant          |  Play random acknowledgment from 165 pre-recorded       |
|  | Acknowledgment   |  clips ("Got it", "Working on that", "Let me check")   |
|  +--------+---------+                                                         |
|           |                                                                   |
|           v                                                                   |
|  +------------------+                                                         |
|  | POST /transcribe |  Send audio to collector endpoint                        |
|  | (Whisper API)    |  Returns: transcribed text                              |
|  +--------+---------+                                                         |
|           |                                                                   |
|           v                                                                   |
|  +------------------+                                                         |
|  | POST /chat       |  Send text to Claude with memory context                |
|  | (Claude API)     |  Returns: response text + voice_summary                 |
|  +--------+---------+                                                         |
|           |                                                                   |
|           v                                                                   |
|  +------------------+                                                         |
|  | POST /speak      |  Send voice_summary to ElevenLabs                       |
|  | (ElevenLabs TTS) |  Returns: audio stream                                  |
|  +--------+---------+                                                         |
|           |                                                                   |
|           v                                                                   |
|  +------------------+                                                         |
|  | Audio Playback   |  Stream audio to speakers                               |
|  | (Web Audio API)  |  HAL eye shows SPEAKING state (green)                   |
|  +------------------+                                                         |
|                                                                               |
+------------------------------------------------------------------------------+
`}</pre>
            </div>

            <h2 id="voice-shortcuts">Keyboard Controls</h2>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h3>Voice Input</h3>
                <table className="docs-table-compact">
                  <tbody>
                    <tr><td><kbd>SPACE</kbd></td><td>Hold to record (push-to-talk)</td></tr>
                    <tr><td><kbd>ESC</kbd></td><td>Cancel current recording</td></tr>
                    <tr><td><kbd>V</kbd></td><td>Toggle voice mode on/off</td></tr>
                  </tbody>
                </table>
              </div>
              <div className="docs-card">
                <h3>Audio Output</h3>
                <table className="docs-table-compact">
                  <tbody>
                    <tr><td><kbd>M</kbd></td><td>Toggle mute</td></tr>
                    <tr><td><kbd>+</kbd> / <kbd>-</kbd></td><td>Adjust volume</td></tr>
                    <tr><td><kbd>.</kbd></td><td>Stop current speech</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <h2 id="voice-personalities">Voice Personalities</h2>
            <p>
              QuoxCORE supports multiple voice personalities, each with distinct characteristics:
            </p>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr><th>Mode</th><th>ElevenLabs Voice</th><th>Personality</th><th>Best For</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td><span className="docs-voice-badge docs-voice-jarvis">JARVIS</span></td>
                    <td>Rachel (21m00Tcm4TlvDq8ikWAM)</td>
                    <td>Warm, helpful, conversational</td>
                    <td>General use, friendly interaction</td>
                  </tr>
                  <tr>
                    <td><span className="docs-voice-badge docs-voice-cyberpunk">Cyberpunk</span></td>
                    <td>Arnold (VR6AewLTigWG4xSOukaG)</td>
                    <td>Deep, commanding, direct</td>
                    <td>NOC/SOC environments, urgency</td>
                  </tr>
                  <tr>
                    <td><span className="docs-voice-badge docs-voice-hal">HAL</span></td>
                    <td>Adam (pNInz6obpgDQGcFmaJgB)</td>
                    <td>Measured, precise, calm</td>
                    <td>Technical precision, data center</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h2 id="hal-eye-states">HAL Eye States</h2>
            <p>
              The HAL eye visualization provides clear visual feedback about the system state:
            </p>
            <div className="docs-state-machine">
              <div className="docs-state" style={{ '--state-color': '#38bdf8' }}>
                <div className="docs-state-dot" />
                <div className="docs-state-info">
                  <strong>IDLE</strong>
                  <span>Red glow, waiting for input</span>
                </div>
              </div>
              <div className="docs-state-arrow">{'->'}</div>
              <div className="docs-state" style={{ '--state-color': '#3090ff' }}>
                <div className="docs-state-dot" />
                <div className="docs-state-info">
                  <strong>LISTENING</strong>
                  <span>Blue pulse, recording audio</span>
                </div>
              </div>
              <div className="docs-state-arrow">{'->'}</div>
              <div className="docs-state" style={{ '--state-color': '#ffa500' }}>
                <div className="docs-state-dot" />
                <div className="docs-state-info">
                  <strong>THINKING</strong>
                  <span>Orange spin, processing query</span>
                </div>
              </div>
              <div className="docs-state-arrow">{'->'}</div>
              <div className="docs-state" style={{ '--state-color': '#30ff90' }}>
                <div className="docs-state-dot" />
                <div className="docs-state-info">
                  <strong>SPEAKING</strong>
                  <span>Green pulse, audio playing</span>
                </div>
              </div>
            </div>

            <h2 id="voice-summaries">Voice Summaries</h2>
            <p>
              Long text responses would be tedious to listen to. QuoxCORE automatically generates concise voice summaries:
            </p>
            <CodeBlock title="Example Voice Summary">{`Full Response (shown in chat):
"I've checked disk usage across all Docker hosts. Here are the results:
- docker01: 45% used (234GB free) - Healthy
- docker02: 67% used (156GB free) - Warning: Above 60%
- docker03: 23% used (412GB free) - Healthy
- docker04: 89% used (52GB free) - Critical: Needs immediate attention

docker04 is critically low on space. The largest consumers are:
1. /var/lib/docker/overlay2 (312GB) - Old container layers
2. /var/log (45GB) - Accumulated logs

Recommendation: Run 'docker system prune' on docker04 and configure
log rotation to prevent recurrence."

Voice Summary (spoken aloud):
"Three Docker hosts are healthy, but docker04 is critically low at 89%
usage. You should run docker system prune there soon."`}</CodeBlock>
          </section>

          {/* ================================================================
              SAFETY SYSTEM SECTION
              ================================================================ */}
          <section id="safety" className="docs-section">
            <h1>Safety System</h1>
            <p className="docs-lead">
              Infrastructure automation is powerful but dangerous. A single mistyped command can take down production systems. QuoxCORE implements defense-in-depth with multiple safety layers.
            </p>

            <SectionIntro>
              <p>
                We designed the safety system with one philosophy: friction is a feature, not a bug. When you're about to delete a VM or wipe a filesystem, you <em>should</em> have to stop and think. The safety system isn't about distrusting you - it's about protecting everyone (including tired-you at 2am) from accidents.
              </p>
            </SectionIntro>

            <TldrBox>
              5 DEFCON levels from auto-execute to typed-code-required. Command denylist blocks the most dangerous operations entirely. Kill switch (Ctrl+Shift+K) immediately halts everything. All operations are audit logged.
            </TldrBox>

            <div className="docs-callout docs-callout-warning">
              <div className="docs-callout-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <div className="docs-callout-content">
                <strong>Safety Philosophy</strong>
                <p>QuoxCORE's safety system is designed around the principle that <em>friction is a feature</em>. Dangerous operations should require deliberate, conscious authorization. This isn't about distrusting users - it's about protecting against mistakes, misunderstandings, and automation errors.</p>
              </div>
            </div>

            <h2 id="defcon-levels">DEFCON Levels</h2>
            <p>
              Operations are classified into five severity levels, each with escalating confirmation requirements:
            </p>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr><th>Level</th><th>Behavior</th><th>Examples</th><th>Confirmation</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td><span className="docs-defcon docs-defcon-green">GREEN</span></td>
                    <td>Auto-execute</td>
                    <td>Status checks, listings, reads</td>
                    <td>None required</td>
                  </tr>
                  <tr>
                    <td><span className="docs-defcon docs-defcon-blue">BLUE</span></td>
                    <td>Log and execute</td>
                    <td>Service restarts, config reads</td>
                    <td>Logged, no prompt</td>
                  </tr>
                  <tr>
                    <td><span className="docs-defcon docs-defcon-amber">AMBER</span></td>
                    <td>Confirmation modal</td>
                    <td>Bulk operations, package installs</td>
                    <td>Click to confirm</td>
                  </tr>
                  <tr>
                    <td><span className="docs-defcon docs-defcon-orange">ORANGE</span></td>
                    <td>Two-step confirmation</td>
                    <td>Shutdown, reboot, major changes</td>
                    <td>Confirm + wait 3s + confirm</td>
                  </tr>
                  <tr>
                    <td><span className="docs-defcon docs-defcon-red">RED</span></td>
                    <td>Typed auth code</td>
                    <td>Deletion, rm -rf, destroy commands</td>
                    <td>Type random 6-char code</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h2 id="command-denylist">Command Denylist</h2>
            <p>
              Certain commands are blocked entirely or require RED-level confirmation, regardless of context:
            </p>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h3>Always Blocked (No Override)</h3>
                <CodeBlock>{`rm -rf /              # Root deletion
rm -rf /*             # Root contents deletion
dd if=/dev/zero       # Disk zeroing
mkfs on mounted       # Format mounted filesystem
iptables -F           # Flush all firewall rules
chmod -R 777 /        # Recursive world-writable`}</CodeBlock>
              </div>
              <div className="docs-card">
                <h3>RED Level (Typed Code Required)</h3>
                <CodeBlock>{`qm destroy            # Proxmox VM deletion
pct destroy           # Proxmox container deletion
rm -rf (any path)     # Recursive deletion
DROP DATABASE         # Database deletion
docker system prune -a # Remove all Docker data
shutdown              # System shutdown`}</CodeBlock>
              </div>
            </div>

            <h2 id="kill-switch">Kill Switch</h2>
            <p>
              The kill switch is a last-resort safety mechanism that immediately halts ALL QuoxCORE operations:
            </p>
            <div className="docs-card" style={{ borderColor: '#38bdf8' }}>
              <h3 style={{ color: '#38bdf8' }}>Emergency Kill Switch</h3>
              <p>
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> activates the kill switch immediately.
              </p>
              <p>
                When activated:
              </p>
              <ul>
                <li>All pending operations are cancelled</li>
                <li>No new operations can be initiated</li>
                <li>Voice and chat inputs are ignored</li>
                <li>A prominent red banner indicates kill switch status</li>
                <li>Deactivation requires typing a randomly-generated 8-character code</li>
              </ul>
              <p>
                <strong>When to use:</strong> If you see QuoxCORE executing something unexpected, or if you realize you've given a dangerous instruction, hit the kill switch immediately. It's better to stop everything than to let a potentially destructive operation complete.
              </p>
            </div>

            <h2 id="audit-logging">Audit Logging</h2>
            <p>
              Every operation is logged with full context for later review:
            </p>
            <CodeBlock title="Audit Log Entry">{`{
  "timestamp": "2025-01-15T14:32:18.445Z",
  "session_id": "sess_abc123",
  "operation": "ssh_command",
  "target": "docker01",
  "command": "docker restart wiki",
  "defcon_level": "BLUE",
  "agent": "VULCAN",
  "user_confirmed": false,
  "result": "success",
  "duration_ms": 1245,
  "memory_ids": ["mem_xyz789"]  // Related memories
}`}</CodeBlock>

            <h2 id="safety-best-practices">Safety Best Practices</h2>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h3>Do</h3>
                <ul>
                  <li>Read confirmation prompts carefully before confirming</li>
                  <li>Use specific target names rather than wildcards</li>
                  <li>Test commands on non-production systems first</li>
                  <li>Review the audit log periodically</li>
                  <li>Keep the kill switch shortcut memorized</li>
                </ul>
              </div>
              <div className="docs-card">
                <h3>Don't</h3>
                <ul>
                  <li>Bypass confirmation prompts habitually</li>
                  <li>Run destructive commands without understanding scope</li>
                  <li>Disable safety features in production</li>
                  <li>Share typed auth codes or save them anywhere</li>
                  <li>Ignore warnings about dangerous operations</li>
                </ul>
              </div>
            </div>
          </section>

          {/* ================================================================
              VIEWS SECTION
              ================================================================ */}
          <section id="views" className="docs-section">
            <h1>Views</h1>
            <p className="docs-lead">
              QuoxCORE provides six specialized views optimized for different operational contexts. Switch between them using number keys for quick access.
            </p>

            <SectionIntro>
              <p>
                Each view is designed for a specific workflow. COMMAND is your daily driver for chatting with QuoxCORE. INFRA shows cluster health. SOC focuses on security. NOC handles network operations. ACTIVITY lets you review history. SETTINGS is where you configure everything. Press 1-6 to switch instantly.
              </p>
            </SectionIntro>

            <TldrBox>
              6 views: COMMAND (chat), INFRA (Proxmox/Docker status), SOC (security), NOC (network/uptime), ACTIVITY (history/audit), SETTINGS (configuration). Press number keys 1-6 to switch.
            </TldrBox>

            <div className="docs-views-grid">
              {[
                { key: '1', name: 'COMMAND', desc: 'Primary interface for natural language interaction with QuoxCORE. Features the chat interface with memory context, agent indicators, and response formatting. This is where most day-to-day interaction happens.', features: ['Natural language chat', 'Agent delegation display', 'Memory context indicators', 'Voice mode toggle'] },
                { key: '2', name: 'INFRA', desc: 'Infrastructure overview with side-by-side Proxmox cluster status and Prometheus metrics. See VM/container health, resource utilization, and key metrics at a glance.', features: ['Proxmox cluster overview', 'VM/Container status', 'Resource utilization graphs', 'Prometheus metric panels'] },
                { key: '3', name: 'SOC', desc: 'Security Operations Center view focused on security posture. Displays active alerts, recent security events, fail2ban status, and vulnerability summaries.', features: ['Security alerts', 'Failed login tracking', 'Vulnerability dashboard', 'Compliance status'] },
                { key: '4', name: 'NOC', desc: 'Network Operations Center view for connectivity and network health. Shows service uptime, network topology, latency metrics, and connectivity issues.', features: ['Service uptime status', 'Network topology', 'Latency monitoring', 'Connectivity alerts'] },
                { key: '5', name: 'ACTIVITY', desc: 'Operation history and audit trail. Review past commands, their results, token usage, and costs. Useful for understanding what QuoxCORE has done and debugging issues.', features: ['Command history', 'Token/cost tracking', 'Agent activity log', 'Session timeline'] },
                { key: '6', name: 'SETTINGS', desc: 'Configuration and administration. Manage safety settings, API keys, voice preferences, memory configuration, and view the full audit log.', features: ['Safety configuration', 'API key management', 'Voice settings', 'Memory preferences'] },
              ].map(view => (
                <div key={view.key} className="docs-view-card">
                  <div className="docs-view-header-large">
                    <span className="docs-view-key-large">{view.key}</span>
                    <span className="docs-view-name-large">{view.name}</span>
                  </div>
                  <p>{view.desc}</p>
                  <ul>
                    {view.features.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          {/* ================================================================
              API REFERENCE SECTION
              ================================================================ */}
          <section id="api" className="docs-section">
            <h1>API Reference</h1>
            <p className="docs-lead">
              QuoxCORE uses native collector endpoints for backend communication. The frontend makes HTTP requests to these endpoints, which handle AI processing, voice conversion, and infrastructure operations.
            </p>

            <SectionIntro>
              <p>
                If you're building integrations or just want to understand how the pieces fit together, this section documents all the API endpoints. Most users won't need this - the dashboard handles everything - but it's here for developers and power users.
              </p>
            </SectionIntro>

            <TldrBox>
              Three main endpoints: <code>/collector/chat</code> for chat, <code>/collector/webhook/speak</code> for TTS, <code>/collector/webhook/transcribe</code> for STT. Additional endpoints for Proxmox, Prometheus, and uptime data.
            </TldrBox>

            <h2 id="post-chat">POST /collector/chat</h2>
            <p>
              The primary endpoint for sending messages through QuoxCORE. Handles context injection, agent delegation, and response processing.
            </p>
            <CodeBlock title="Request">{`POST /collector/chat
Content-Type: application/json

{
  "prompt": "Check disk usage on docker hosts",
  "session_id": "uuid-v4-session-identifier",
  "voice_mode": "jarvis",
  "memory_context": {
    "relevant_memories": [...],    // Pre-retrieved by frontend
    "user_preferences": {...}
  },
  "infrastructure": {
    "jumpHost": {
      "enabled": true,
      "ip": "198.51.100.247",
      "user": "control"
    },
    "proxmoxHosts": ["hyp-01", "hyp-02", "hyp-03"],
    "dockerHosts": ["edge-01", "edge-02", "edge-03", "edge-04"]
  },
  "safety": {
    "defcon_override": null,       // null = use automatic levels
    "kill_switch_active": false
  }
}`}</CodeBlock>

            <CodeBlock title="Response">{`{
  "success": true,
  "result": "Here's the disk usage across your Docker hosts:\\n\\n| Host | Used | Free | Status |...",
  "voice_summary": "All Docker hosts have adequate storage except docker02 which is at 67 percent.",
  "agent": "vault",
  "agent_reasoning": "Query involves storage/disk analysis, delegating to VAULT specialist",
  "commands_executed": [
    { "host": "docker01", "command": "df -h", "exit_code": 0 },
    { "host": "docker02", "command": "df -h", "exit_code": 0 }
  ],
  "tokens": {
    "input": 1245,
    "output": 892
  },
  "cost_usd": 0.0023,
  "duration_ms": 4520,
  "memory_updates": [
    { "type": "fact", "content": "docker02 at 67% disk usage as of 2025-01-15" }
  ]
}`}</CodeBlock>

            <h2 id="post-speak">POST /collector/webhook/speak</h2>
            <p>
              Convert text to speech using ElevenLabs. Returns an audio stream.
            </p>
            <CodeBlock title="Request">{`POST /collector/webhook/speak
Content-Type: application/json

{
  "text": "All systems are operating normally.",
  "voice_id": "21m00Tcm4TlvDq8ikWAM",  // Rachel (JARVIS)
  "model_id": "eleven_monolingual_v1",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75
  }
}`}</CodeBlock>

            <CodeBlock title="Response">{`Content-Type: audio/mpeg
Content-Length: 45678

[Binary audio data - MP3 stream]`}</CodeBlock>

            <h2 id="post-transcribe">POST /collector/webhook/transcribe</h2>
            <p>
              Convert speech to text using OpenAI Whisper.
            </p>
            <CodeBlock title="Request">{`POST /collector/webhook/transcribe
Content-Type: multipart/form-data

file: [audio blob - webm/wav]
model: whisper-1
language: en  // optional`}</CodeBlock>

            <CodeBlock title="Response">{`{
  "success": true,
  "text": "Check the status of all Docker containers",
  "confidence": 0.95,
  "duration_seconds": 2.3
}`}</CodeBlock>

            <h2 id="other-endpoints">Other Endpoints</h2>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr><th>Endpoint</th><th>Method</th><th>Purpose</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>/webhook/proxmox/cluster</code></td><td>GET</td><td>Cluster status overview</td></tr>
                  <tr><td><code>/webhook/proxmox/vms</code></td><td>GET</td><td>List all VMs with status</td></tr>
                  <tr><td><code>/webhook/proxmox/containers</code></td><td>GET</td><td>List all LXC containers</td></tr>
                  <tr><td><code>/webhook/prometheus/query</code></td><td>POST</td><td>Execute PromQL query</td></tr>
                  <tr><td><code>/webhook/prometheus/alerts</code></td><td>GET</td><td>Active Alertmanager alerts</td></tr>
                  <tr><td><code>/webhook/uptime/status</code></td><td>GET</td><td>Service availability status</td></tr>
                  <tr><td><code>/webhook/quick-action</code></td><td>POST</td><td>Execute predefined infrastructure actions</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ================================================================
              SETUP GUIDE SECTION
              ================================================================ */}
          <section id="setup" className="docs-section">
            <h1>Setup Guide</h1>
            <p className="docs-lead">
              This guide walks you through setting up QuoxCORE from scratch. The system requires Docker, Node.js, and API keys for AI and voice services.
            </p>

            <SectionIntro>
              <p>
                Ready to set up your own QuoxCORE instance? This guide covers everything from prerequisites to troubleshooting. If you just want the quickest path to running, check out the <a href="#quick-start" onClick={(e) => { e.preventDefault(); scrollTo('quick-start') }}>Quick Start</a> section first.
              </p>
            </SectionIntro>

            <h2 id="prerequisites">Prerequisites</h2>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h3>Required</h3>
                <ul>
                  <li><strong>Docker & Docker Compose</strong> - For collector and services</li>
                  <li><strong>Node.js 18+</strong> - For building the dashboard</li>
                  <li><strong>HTTPS</strong> - Required for microphone access</li>
                  <li><strong>Git</strong> - For cloning the repository</li>
                </ul>
              </div>
              <div className="docs-card">
                <h3>API Keys Needed</h3>
                <ul>
                  <li><strong>Anthropic API</strong> - For Claude AI</li>
                  <li><strong>OpenAI API</strong> - For Whisper transcription</li>
                  <li><strong>ElevenLabs API</strong> - For text-to-speech</li>
                  <li><strong>Qdrant</strong> - For vector search (optional, can self-host)</li>
                </ul>
              </div>
            </div>

            <h2 id="step-1-clone">Step 1: Clone and Install</h2>
            <CodeBlock>{`# Clone the repository
git clone https://github.com/YOUR_USERNAME/quox-dashboard.git
cd quox-dashboard

# Install dependencies
npm install

# Verify installation
npm run build`}</CodeBlock>

            <h2 id="step-2-env">Step 2: Configure Environment</h2>
            <CodeBlock>{`# Copy environment template
cp services/collector/.env.example services/collector/.env

# Edit with your API keys
nano services/collector/.env`}</CodeBlock>

            <CodeBlock title="services/collector/.env">{`# AI
ANTHROPIC_API_KEY=sk-ant-...

# Voice
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...

# Vector Database (optional - can use local Qdrant)
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=...

# Infrastructure
SSH_BASTION_HOST=198.51.100.247
SSH_BASTION_USER=control

# Optional
PROXMOX_API_TOKEN=...
PROMETHEUS_URL=http://prometheus01:9090`}</CodeBlock>

            <h2 id="step-3-services">Step 3: Start Services</h2>
            <CodeBlock>{`# Start all services
cd quox-dashboard
docker compose up -d

# Verify services are running
docker ps

# Check collector logs
docker logs collector -f`}</CodeBlock>

            <h2 id="step-4-build">Step 4: Build and Deploy Dashboard</h2>
            <CodeBlock>{`# Build production bundle
cd quox-dashboard
npm run build

# The built files are in dist/
# nginx serves them from this directory

# For development with hot reload
npm run dev`}</CodeBlock>

            <h2 id="step-5-access">Step 5: Access QuoxCORE</h2>
            <p>
              Open your browser to the configured URL (default: https://quox.local:3443). You'll need to accept the self-signed certificate if using local HTTPS.
            </p>

            <h2 id="troubleshooting">Troubleshooting</h2>
            <div className="docs-grid docs-grid-2">
              <div className="docs-card">
                <h3>Voice not working</h3>
                <p>
                  Browser microphone access requires HTTPS. Make sure you're accessing via https:// and have accepted the certificate. Check browser permissions for microphone access.
                </p>
              </div>
              <div className="docs-card">
                <h3>No audio playback</h3>
                <p>
                  Browsers block autoplay. Click anywhere on the page first, then try voice interaction. Check mute status (M key). Verify ElevenLabs API key is valid.
                </p>
              </div>
              <div className="docs-card">
                <h3>SSH failures</h3>
                <p>
                  Verify bastion host is reachable. Check SSH key permissions (chmod 600). Ensure the control user has key-based access to target hosts. Test manually: ssh -J gw-01 docker01
                </p>
              </div>
              <div className="docs-card">
                <h3>Collector endpoint errors</h3>
                <p>
                  Check collector is running: docker ps | grep collector. View logs: docker logs collector. Verify endpoint URLs match your configuration. Check for CORS issues in browser console.
                </p>
              </div>
              <div className="docs-card">
                <h3>Memory not persisting</h3>
                <p>
                  Memory uses localStorage by default. Check browser developer tools Application Local Storage. For cross-device sync, configure Qdrant vector storage.
                </p>
              </div>
              <div className="docs-card">
                <h3>Kill switch stuck</h3>
                <p>
                  Type the displayed deactivation code exactly. If you can't see the code, refresh the page to clear session state. The kill switch is session-specific.
                </p>
              </div>
            </div>

            <h2 id="dev-commands">Development Commands</h2>
            <CodeBlock>{`# Start development server with hot reload
npm run dev

# Run tests
npx vitest run

# Run tests in watch mode
npx vitest

# Build for production
npm run build

# Preview production build locally
npm run preview

# Lint code
npm run lint`}</CodeBlock>
          </section>
        </main>

        {/* Table of Contents (Right Sidebar) */}
        <OnThisPage headings={tocHeadings} activeHeading={activeHeading} />
      </div>

      {/* Footer */}
      <footer className="docs-footer">
        <div className="docs-footer-inner">
          <div className="docs-footer-brand">
            <div className="docs-logo-eye small" />
            <span>QuoxCORE</span>
          </div>
          <div className="docs-footer-links">
            <Link to="/">Launch App</Link>
            <a href="https://github.com/YOUR_USERNAME/quox-dashboard" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="#overview" onClick={(e) => { e.preventDefault(); scrollTo('overview') }}>Back to Top</a>
          </div>
          <div className="docs-footer-meta">
            Documentation for QuoxCORE v1.0 | 437 tests passing | Built with React + Vite
          </div>
        </div>
      </footer>

      {/* Back to top button - shows when scrolled down */}
      <BackToTopButton />
    </div>
  )
}

export default DocsPage

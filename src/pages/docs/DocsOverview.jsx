import { useEffect } from 'react'
import { Link, useOutletContext } from 'react-router-dom'

// SVG Icons as components for better visual appeal
const Icons = {
  Rocket: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
    </svg>
  ),
  Brain: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.54"/>
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.54"/>
    </svg>
  ),
  Users: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  Shield: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="m9 12 2 2 4-4"/>
    </svg>
  ),
  Mic: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" x2="12" y1="19" y2="22"/>
    </svg>
  ),
  Workflow: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1"/>
      <rect x="15" y="3" width="6" height="6" rx="1"/>
      <rect x="9" y="15" width="6" height="6" rx="1"/>
      <path d="M6 9v3a1 1 0 0 0 1 1h4"/>
      <path d="M18 9v3a1 1 0 0 1-1 1h-4"/>
    </svg>
  ),
  Memory: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 19v-3"/>
      <path d="M10 19v-3"/>
      <path d="M14 19v-3"/>
      <path d="M18 19v-3"/>
      <path d="M8 11V9"/>
      <path d="M16 11V9"/>
      <path d="M12 11V9"/>
      <path d="M2 15h20"/>
      <path d="M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v1.1a2 2 0 0 0 0 3.837V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5.1a2 2 0 0 0 0-3.837Z"/>
    </svg>
  ),
  Inbox: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
    </svg>
  ),
  Building: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2" ry="2"/>
      <path d="M9 22v-4h6v4"/>
      <path d="M8 6h.01"/>
      <path d="M16 6h.01"/>
      <path d="M12 6h.01"/>
      <path d="M12 10h.01"/>
      <path d="M12 14h.01"/>
      <path d="M16 10h.01"/>
      <path d="M16 14h.01"/>
      <path d="M8 10h.01"/>
      <path d="M8 14h.01"/>
    </svg>
  ),
  Book: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>
    </svg>
  ),
  Cog: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  ),
  Compass: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
    </svg>
  ),
  Zap: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  ArrowRight: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12"/>
      <polyline points="12 5 19 12 12 19"/>
    </svg>
  ),
  CheckCircle: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  ),
  Star: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
}

// "Where to Start" paths based on user role
const START_PATHS = [
  {
    role: 'New to QuoxCORE?',
    desc: 'Start here to understand what QuoxCORE can do and how it works',
    path: '/landing',
    label: 'Product Overview',
    icon: Icons.Compass,
    color: '#3090ff',
  },
  {
    role: 'Ready to set up?',
    desc: 'Installation guide, configuration, and first steps',
    path: '/docs/setup',
    label: 'Setup Guide',
    icon: Icons.Cog,
    color: '#30ff90',
  },
  {
    role: 'Want to dive deep?',
    desc: 'Technical architecture, components, and design decisions',
    path: '/docs/architecture',
    label: 'Architecture',
    icon: Icons.Building,
    color: '#ffd93d',
  },
]

// Essential documentation sections
const ESSENTIAL_DOCS = [
  {
    path: '/docs/memory',
    label: 'Memory System',
    icon: Icons.Memory,
    desc: 'How QuoxCORE remembers and learns',
    color: '#38bdf8',
  },
  {
    path: '/docs/agents',
    label: 'AI Agents',
    icon: Icons.Users,
    desc: '11 specialized agents working together',
    color: '#3090ff',
  },
  {
    path: '/docs/workflows',
    label: 'Workflows',
    icon: Icons.Workflow,
    desc: 'Automation templates and builder',
    color: '#30ff90',
  },
  {
    path: '/docs/safety',
    label: 'Safety & DEFCON',
    icon: Icons.Shield,
    desc: 'Guardrails and approval flows',
    color: '#ffd93d',
  },
]

// Additional documentation links
const MORE_DOCS = [
  { path: '/docs/orgs', label: 'Organizations', desc: 'Teams, divisions, and access control', icon: Icons.Building },
  { path: '/docs/inbox', label: 'HITL & Inbox', desc: 'Approvals and notifications', icon: Icons.Inbox },
  { path: '/docs/voice', label: 'Voice Interface', desc: 'Speech input and TTS output', icon: Icons.Mic },
  { path: '/docs/api', label: 'API Reference', desc: 'Webhooks and integrations', icon: Icons.Zap },
]

// Core capabilities with better descriptions
const CAPABILITIES = [
  {
    icon: Icons.Brain,
    color: '#38bdf8',
    title: 'Persistent Memory',
    desc: 'QuoxCORE builds a relationship with you over time. It remembers your preferences, past conversations, infrastructure details, and decisions you have made. No more repeating yourself.',
  },
  {
    icon: Icons.Users,
    color: '#3090ff',
    title: 'Specialized Agents',
    desc: 'Eleven AI agents handle different domains - security, containers, storage, networking. Ask anything and QuoxCORE routes to the right specialist automatically.',
  },
  {
    icon: Icons.Mic,
    color: '#30ff90',
    title: 'Voice Control',
    desc: 'Hands-free operation when you need it. Push-to-talk voice input with natural speech recognition, and responses can be spoken aloud.',
  },
  {
    icon: Icons.Shield,
    color: '#ffd93d',
    title: 'Built-in Safety',
    desc: 'Defense-in-depth protects your infrastructure. DEFCON levels, command restrictions, and confirmation codes for destructive operations.',
  },
]

// Static headings for the overview page
const OVERVIEW_HEADINGS = [
  { level: 2, text: 'Where to Start', id: 'where-to-start' },
  { level: 2, text: 'Essential Documentation', id: 'essential-docs' },
  { level: 2, text: 'What Can QuoxCORE Do?', id: 'capabilities' },
  { level: 2, text: 'More Documentation', id: 'more-docs' },
]

export default function DocsOverview() {
  // Get setHeadings from outlet context (provided by DocsLayout)
  const context = useOutletContext()
  const setHeadings = context?.setHeadings

  // Update parent with headings
  useEffect(() => {
    if (setHeadings) {
      setHeadings(OVERVIEW_HEADINGS)
    }

    // Cleanup: clear headings when unmounting
    return () => {
      if (setHeadings) {
        setHeadings([])
      }
    }
  }, [setHeadings])

  return (
    <section className="docs-section">
      {/* Hero Section */}
      <div className="docs-hero">
        <h1>Welcome to QuoxCORE</h1>
        <p className="docs-lead">
          QuoxCORE is your AI-powered infrastructure assistant. Instead of juggling
          SSH sessions, remembering commands, and context-switching between tools,
          you can simply describe what you need in plain English.
        </p>
        <p className="docs-intro-detail">
          Think of QuoxCORE as a knowledgeable colleague who knows your entire infrastructure,
          remembers every conversation, and can safely execute operations on your behalf.
          It learns your preferences over time, speaks multiple "languages" (Proxmox, Docker,
          networking, security), and always asks for confirmation before doing anything risky.
        </p>
      </div>

      {/* Quick Stats Bar */}
      <div className="docs-stats-bar">
        <div className="docs-stats-bar-item">
          <span className="docs-stats-bar-value">11</span>
          <span className="docs-stats-bar-label">AI Agents</span>
        </div>
        <div className="docs-stats-bar-divider" />
        <div className="docs-stats-bar-item">
          <span className="docs-stats-bar-value">4</span>
          <span className="docs-stats-bar-label">Memory Types</span>
        </div>
        <div className="docs-stats-bar-divider" />
        <div className="docs-stats-bar-item">
          <span className="docs-stats-bar-value">50+</span>
          <span className="docs-stats-bar-label">Hosts Managed</span>
        </div>
        <div className="docs-stats-bar-divider" />
        <div className="docs-stats-bar-item">
          <span className="docs-stats-bar-value">1340+</span>
          <span className="docs-stats-bar-label">Workflow Templates</span>
        </div>
      </div>

      {/* Where to Start Section */}
      <h2 id="where-to-start">Where to Start</h2>
      <p className="docs-section-intro">
        Choose your path based on what you want to accomplish:
      </p>
      <div className="docs-start-paths">
        {START_PATHS.map((item) => (
          <Link key={item.path} to={item.path} className="docs-start-path">
            <div className="docs-start-path-icon" style={{ background: `${item.color}20`, color: item.color }}>
              <item.icon />
            </div>
            <div className="docs-start-path-content">
              <span className="docs-start-path-role">{item.role}</span>
              <h3>{item.label}</h3>
              <p>{item.desc}</p>
            </div>
            <div className="docs-start-path-arrow" style={{ color: item.color }}>
              <Icons.ArrowRight />
            </div>
          </Link>
        ))}
      </div>

      {/* Essential Documentation */}
      <h2 id="essential-docs">Essential Documentation</h2>
      <p className="docs-section-intro">
        Core concepts you will want to understand:
      </p>
      <div className="docs-grid docs-grid-2">
        {ESSENTIAL_DOCS.map((doc) => (
          <Link key={doc.path} to={doc.path} className="docs-essential-card">
            <div className="docs-essential-icon" style={{ background: `${doc.color}15`, color: doc.color }}>
              <doc.icon />
            </div>
            <div className="docs-essential-content">
              <h3>{doc.label}</h3>
              <p>{doc.desc}</p>
            </div>
            <div className="docs-essential-arrow">
              <Icons.ArrowRight />
            </div>
          </Link>
        ))}
      </div>

      {/* Capabilities Section */}
      <h2 id="capabilities">What Can QuoxCORE Do?</h2>
      <div className="docs-capabilities">
        {CAPABILITIES.map((cap) => (
          <div key={cap.title} className="docs-capability">
            <div className="docs-capability-icon" style={{ color: cap.color }}>
              <cap.icon />
            </div>
            <div className="docs-capability-content">
              <h3>{cap.title}</h3>
              <p>{cap.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Examples */}
      <div className="docs-examples-box">
        <h3>Examples of what you can ask:</h3>
        <ul className="docs-examples-list">
          <li>
            <Icons.CheckCircle />
            <span>"Show me all containers running on docker01"</span>
          </li>
          <li>
            <Icons.CheckCircle />
            <span>"What's using the most CPU right now?"</span>
          </li>
          <li>
            <Icons.CheckCircle />
            <span>"Create a backup of the production database"</span>
          </li>
          <li>
            <Icons.CheckCircle />
            <span>"Who has access to the vault secrets?"</span>
          </li>
        </ul>
      </div>

      {/* More Documentation */}
      <h2 id="more-docs">More Documentation</h2>
      <div className="docs-more-grid">
        {MORE_DOCS.map((doc) => (
          <Link key={doc.path} to={doc.path} className="docs-more-link">
            <div className="docs-more-icon">
              <doc.icon />
            </div>
            <div className="docs-more-content">
              <h4>{doc.label}</h4>
              <p>{doc.desc}</p>
            </div>
          </Link>
        ))}
      </div>

      {/* Getting Help */}
      <div className="docs-help-box">
        <div className="docs-help-icon">
          <Icons.Star />
        </div>
        <div className="docs-help-content">
          <h3>Need Help?</h3>
          <p>
            QuoxCORE is designed to be self-documenting. Just ask it questions like
            "What can you do?" or "How does memory work?" and it will explain.
            The <Link to="/command-center">Command Center</Link> is where you interact
            with QuoxCORE directly.
          </p>
        </div>
      </div>
    </section>
  )
}

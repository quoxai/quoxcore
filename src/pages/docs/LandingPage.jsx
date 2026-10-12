import { Link } from 'react-router-dom'
import { INTEGRATION_TYPES, INTEGRATION_CATEGORIES } from '../../config/integrationTypes'
import './landing.css'

/**
 * QuoxCORE Documentation Landing Page
 *
 * A welcoming, human-centered docs homepage that guides users
 * based on their experience level and goals.
 */

// Integration stats
const TOTAL_INTEGRATIONS = Object.keys(INTEGRATION_TYPES).length
const TOTAL_CATEGORIES = Object.keys(INTEGRATION_CATEGORIES).length

// Featured integration logos (most recognizable)
const FEATURED_INTEGRATIONS = [
  { id: 'openai', name: 'OpenAI', color: '#00A67E' },
  { id: 'anthropic', name: 'Anthropic', color: '#D4A574' },
  { id: 'slack', name: 'Slack', color: '#4A154B' },
  { id: 'github', name: 'GitHub', color: '#181717' },
  { id: 'salesforce', name: 'Salesforce', color: '#00A1E0' },
  { id: 'snowflake', name: 'Snowflake', color: '#29B5E8' },
  { id: 'datadog', name: 'Datadog', color: '#632CA6' },
  { id: 'okta', name: 'Okta', color: '#007DC1' },
  { id: 'crowdstrike', name: 'CrowdStrike', color: '#FF0000' },
  { id: 'servicenow', name: 'ServiceNow', color: '#81B5A1' },
  { id: 'splunk', name: 'Splunk', color: '#65A637' },
  { id: 'aws', name: 'AWS', color: '#FF9900' },
]

// Learning paths for different user types
const LEARNING_PATHS = [
  {
    id: 'beginner',
    title: 'New to QuoxCORE?',
    subtitle: 'Start here',
    icon: '🚀',
    description: 'Learn the basics and get up and running in minutes.',
    color: '#10b981',
    links: [
      { to: '/docs/architecture', label: 'What is QuoxCORE?', time: '5 min read' },
      { to: '/docs/setup', label: 'Quick Start Guide', time: '10 min' },
      { to: '/docs/workflows', label: 'Your First Workflow', time: '15 min' },
    ]
  },
  {
    id: 'builder',
    title: 'Ready to Build?',
    subtitle: 'Create automations',
    icon: '🛠️',
    description: 'Build workflows, connect tools, and automate your world.',
    color: '#6366f1',
    links: [
      { to: '/workflow-library', label: 'Browse 1,340+ Templates' },
      { to: '/docs/agents', label: 'Meet the AI Agents' },
      { to: '/docs/memory', label: 'Memory System Deep Dive' },
    ]
  },
  {
    id: 'team',
    title: 'Setting Up Your Team?',
    subtitle: 'Organization & access',
    icon: '👥',
    description: 'Configure organizations, teams, roles, and permissions.',
    color: '#f59e0b',
    links: [
      { to: '/docs/orgs', label: 'Organizations Guide' },
      { to: '/docs/teams', label: 'Teams & Permissions' },
      { to: '/docs/inbox', label: 'Approvals & Inbox' },
    ]
  },
]

// Quick reference cards
const QUICK_REFERENCE = [
  {
    icon: '🪞',
    title: 'Mirror Self-Awareness',
    description: 'The world\'s first verifiable AI self-awareness system. See your AI understand itself in real-time.',
    to: '/topology',
    color: '#00ff88',
    featured: true,
  },
  {
    icon: '🔌',
    title: 'Integrations',
    description: `${TOTAL_INTEGRATIONS}+ connectors for AI, security, compliance, and enterprise tools.`,
    to: '/docs/integrations',
    color: '#6366f1',
  },
  {
    icon: '🤖',
    title: 'AI Agents',
    description: '13 specialized agents with intelligent delegation - security, network, DevOps, and more.',
    to: '/docs/agents',
    color: '#a78bfa',
  },
  {
    icon: '🧠',
    title: 'Memory System',
    description: 'How QuoxCORE remembers your preferences, context, and learned facts.',
    to: '/docs/memory',
    color: '#8b5cf6',
  },
  {
    icon: '⚡',
    title: 'Workflows',
    description: 'Automate anything with visual workflows. No code required.',
    to: '/docs/workflows',
    color: '#10b981',
  },
  {
    icon: '🔐',
    title: 'Safety & Guardrails',
    description: 'DEFCON levels, approval workflows, and human-in-the-loop controls.',
    to: '/docs/safety',
    color: '#f59e0b',
  },
  {
    icon: '🏢',
    title: 'Organizations',
    description: 'Multi-tenant workspaces for teams, clients, and enterprises.',
    to: '/docs/orgs',
    color: '#ec4899',
  },
]

// Popular topics / frequently visited
const POPULAR_TOPICS = [
  { label: 'API Reference', to: '/docs/api', icon: '📚' },
  { label: 'QuoxAgent Fleet Management', to: '/docs/quoxagent', icon: '🖥️' },
  { label: 'Docker Setup', to: '/docs/docker', icon: '🐳' },
  { label: 'Authentication', to: '/docs/auth-service', icon: '🔑' },
  { label: 'Development Guide', to: '/docs/development', icon: '💻' },
  { label: 'Architecture Options', to: '/docs/architecture-options', icon: '🏗️' },
]

export default function LandingPage() {
  return (
    <div className="docs-landing">
      {/* Welcome Hero */}
      <section className="docs-landing-hero">
        <div className="docs-landing-hero-content">
          <div className="docs-landing-wave">👋</div>
          <h1>Welcome to QuoxCORE Docs</h1>
          <p className="docs-landing-lead">
            Everything you need to orchestrate AI agents, build automations, and manage your
            intelligent workspace. Whether you are just getting started or looking for
            specific technical details, we have got you covered.
          </p>

          <div className="docs-landing-search-hint">
            <span className="docs-landing-search-icon">🔍</span>
            <span>Tip: Use <kbd>Cmd</kbd> + <kbd>K</kbd> to search docs anytime</span>
          </div>
        </div>
      </section>

      {/* Learning Paths - "Choose your adventure" */}
      <section className="docs-landing-section">
        <div className="docs-landing-container">
          <h2 className="docs-landing-section-title">Where would you like to start?</h2>
          <p className="docs-landing-section-subtitle">
            Pick a path based on what you are trying to accomplish today.
          </p>

          <div className="docs-landing-paths">
            {LEARNING_PATHS.map((path) => (
              <div
                key={path.id}
                className="docs-landing-path"
                style={{ '--path-color': path.color }}
              >
                <div className="docs-landing-path-header">
                  <span className="docs-landing-path-icon">{path.icon}</span>
                  <div>
                    <h3>{path.title}</h3>
                    <span className="docs-landing-path-subtitle">{path.subtitle}</span>
                  </div>
                </div>
                <p className="docs-landing-path-desc">{path.description}</p>
                <ul className="docs-landing-path-links">
                  {path.links.map((link, i) => (
                    <li key={i}>
                      <Link to={link.to}>
                        {link.label}
                        {link.time && <span className="docs-landing-time">{link.time}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations Showcase - NEW */}
      <section className="docs-landing-section docs-landing-integrations">
        <div className="docs-landing-container">
          <div className="docs-landing-integrations-header">
            <div className="docs-landing-integrations-badge">
              <span>🔌</span> Integrations Vault
            </div>
            <h2 className="docs-landing-section-title">
              Connect to <span className="docs-landing-highlight">{TOTAL_INTEGRATIONS}+</span> Services
            </h2>
            <p className="docs-landing-section-subtitle">
              From AI models to enterprise compliance tools, QuoxCORE connects to everything your workflows need.
            </p>
          </div>

          <div className="docs-landing-integrations-logos">
            {FEATURED_INTEGRATIONS.map((int) => (
              <div
                key={int.id}
                className="docs-landing-integration-logo"
                style={{ '--logo-color': int.color }}
              >
                <span className="docs-landing-integration-icon">{int.name.charAt(0)}</span>
                <span className="docs-landing-integration-name">{int.name}</span>
              </div>
            ))}
          </div>

          <div className="docs-landing-integrations-stats">
            <div className="docs-landing-integrations-stat">
              <span className="docs-landing-integrations-stat-value">{TOTAL_INTEGRATIONS}+</span>
              <span className="docs-landing-integrations-stat-label">Integrations</span>
            </div>
            <div className="docs-landing-integrations-stat">
              <span className="docs-landing-integrations-stat-value">{TOTAL_CATEGORIES}</span>
              <span className="docs-landing-integrations-stat-label">Categories</span>
            </div>
            <div className="docs-landing-integrations-stat">
              <span className="docs-landing-integrations-stat-value">0</span>
              <span className="docs-landing-integrations-stat-label">Min Setup</span>
            </div>
            <div className="docs-landing-integrations-stat">
              <span className="docs-landing-integrations-stat-value">AES-256</span>
              <span className="docs-landing-integrations-stat-label">Encryption</span>
            </div>
          </div>

          <div className="docs-landing-integrations-categories">
            <span className="docs-landing-category-tag">AI & ML</span>
            <span className="docs-landing-category-tag">GRC & Compliance</span>
            <span className="docs-landing-category-tag">Security Operations</span>
            <span className="docs-landing-category-tag">DevOps</span>
            <span className="docs-landing-category-tag">CRM & Sales</span>
            <span className="docs-landing-category-tag">Finance & ERP</span>
            <span className="docs-landing-category-tag">Data & Analytics</span>
            <span className="docs-landing-category-tag">+{TOTAL_CATEGORIES - 7} more</span>
          </div>

          <Link to="/docs/integrations" className="docs-landing-btn docs-landing-btn-primary docs-landing-btn-lg">
            Browse All Integrations →
          </Link>
        </div>
      </section>

      {/* Quick Reference Grid */}
      <section className="docs-landing-section docs-landing-section-alt">
        <div className="docs-landing-container">
          <h2 className="docs-landing-section-title">Quick Reference</h2>
          <p className="docs-landing-section-subtitle">
            Jump straight to the topic you need.
          </p>

          <div className="docs-landing-reference-grid">
            {QUICK_REFERENCE.map((item) => (
              <Link
                key={item.title}
                to={item.to}
                className="docs-landing-reference-card"
                style={{ '--card-color': item.color }}
              >
                <span className="docs-landing-reference-icon">{item.icon}</span>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
                <span className="docs-landing-reference-arrow">Read more</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Popular Topics */}
      <section className="docs-landing-section">
        <div className="docs-landing-container">
          <h2 className="docs-landing-section-title">Popular Topics</h2>
          <p className="docs-landing-section-subtitle">
            Frequently visited documentation pages.
          </p>

          <div className="docs-landing-popular">
            {POPULAR_TOPICS.map((topic) => (
              <Link key={topic.label} to={topic.to} className="docs-landing-popular-link">
                <span className="docs-landing-popular-icon">{topic.icon}</span>
                <span>{topic.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Help Box */}
      <section className="docs-landing-section">
        <div className="docs-landing-container">
          <div className="docs-landing-help-box">
            <div className="docs-landing-help-content">
              <h3>Need help finding something?</h3>
              <p>
                Can not find what you are looking for? Try asking QuoxCORE directly in the
                <Link to="/"> Dashboard</Link> - it knows these docs inside and out.
                Or browse the <Link to="/docs">full documentation index</Link>.
              </p>
            </div>
            <div className="docs-landing-help-actions">
              <Link to="/" className="docs-landing-btn docs-landing-btn-primary">
                Open Dashboard
              </Link>
              <Link to="/docs" className="docs-landing-btn docs-landing-btn-secondary">
                Browse All Docs
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* What is QuoxCORE? Quick Overview */}
      <section className="docs-landing-section docs-landing-section-alt">
        <div className="docs-landing-container">
          <div className="docs-landing-overview">
            <div className="docs-landing-overview-header">
              <span className="docs-landing-overview-badge">The Basics</span>
              <h2>What is QuoxCORE?</h2>
            </div>

            <div className="docs-landing-overview-content">
              <p className="docs-landing-overview-intro">
                <strong>QuoxCORE</strong> (Multi-Agent Executive System for Tactical Resource Orchestration)
                is an AI-powered platform that brings all your AI models, APIs, and automations into
                one intelligent workspace.
              </p>

              <div className="docs-landing-overview-features">
                <div className="docs-landing-overview-feature">
                  <span className="docs-landing-feature-check" style={{ color: '#00ff88' }}>★</span>
                  <div>
                    <strong>Mirror Self-Awareness</strong>
                    <p>The first AI that genuinely knows what it can do. Real introspection, not hallucination.</p>
                  </div>
                </div>
                <div className="docs-landing-overview-feature">
                  <span className="docs-landing-feature-check">✓</span>
                  <div>
                    <strong>One Interface, All AIs</strong>
                    <p>Use Claude, GPT-4, Gemini, and more from a single chat interface.</p>
                  </div>
                </div>
                <div className="docs-landing-overview-feature">
                  <span className="docs-landing-feature-check">✓</span>
                  <div>
                    <strong>Memory That Persists</strong>
                    <p>QuoxCORE remembers your preferences, context, and learns over time.</p>
                  </div>
                </div>
                <div className="docs-landing-overview-feature">
                  <span className="docs-landing-feature-check">✓</span>
                  <div>
                    <strong>Workflow Automation</strong>
                    <p>Chain AI agents with APIs, databases, and human approvals.</p>
                  </div>
                </div>
                <div className="docs-landing-overview-feature">
                  <span className="docs-landing-feature-check">✓</span>
                  <div>
                    <strong>Human-in-the-Loop</strong>
                    <p>Safety guardrails and approval workflows keep you in control.</p>
                  </div>
                </div>
              </div>

              <Link to="/docs/architecture" className="docs-landing-learn-more">
                Learn more about how it works
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="docs-landing-section docs-landing-footer-cta">
        <div className="docs-landing-container">
          <div className="docs-landing-cta-content">
            <h2>Ready to get started?</h2>
            <p>
              Jump into the dashboard and start chatting with QuoxCORE.
              It will guide you through everything.
            </p>
            <Link to="/" className="docs-landing-btn docs-landing-btn-primary docs-landing-btn-lg">
              Launch Dashboard
            </Link>
          </div>
        </div>
      </section>
    </div>
  )
}

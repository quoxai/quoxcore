import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { INTEGRATION_TYPES, INTEGRATION_CATEGORIES } from '../../config/integrationTypes'
import './integrations-page.css'

/**
 * IntegrationsPage - Showcase of 400+ integrations
 *
 * A beautiful, filterable gallery of all supported integrations
 * with stats, category breakdowns, and visual logos
 */

// Get all integrations as array
const ALL_INTEGRATIONS = Object.values(INTEGRATION_TYPES)

// Calculate stats
const TOTAL_COUNT = ALL_INTEGRATIONS.length
const CATEGORY_COUNTS = ALL_INTEGRATIONS.reduce((acc, int) => {
  const cat = int.category || 'custom'
  acc[cat] = (acc[cat] || 0) + 1
  return acc
}, {})

// Featured integrations (most recognizable brands)
const FEATURED_IDS = [
  'openai', 'anthropic', 'gemini', 'slack', 'github', 'gitlab', 'jira',
  'salesforce', 'hubspot', 'stripe', 'aws', 'azure', 'gcp', 'snowflake',
  'datadog', 'splunk', 'okta', 'crowdstrike', 'servicenow', 'notion',
  'figma', 'shopify', 'twilio', 'sendgrid', 'mongodb', 'postgresql'
]

// Category display order and icons
const CATEGORY_ORDER = [
  { id: 'ai', icon: '🤖', label: 'AI & ML' },
  { id: 'grc', icon: '📋', label: 'GRC & Compliance' },
  { id: 'privacy', icon: '🔏', label: 'Privacy Ops' },
  { id: 'tprm', icon: '🏢', label: 'Vendor Risk' },
  { id: 'iam', icon: '🔐', label: 'IAM & SSO' },
  { id: 'pam', icon: '🗝️', label: 'Privileged Access' },
  { id: 'siem', icon: '📊', label: 'SIEM' },
  { id: 'soar', icon: '⚡', label: 'SOAR' },
  { id: 'edr', icon: '🛡️', label: 'EDR / XDR' },
  { id: 'cspm', icon: '☁️', label: 'Cloud Security' },
  { id: 'vulnmgmt', icon: '🔍', label: 'Vulnerability Mgmt' },
  { id: 'dlp', icon: '🚫', label: 'DLP' },
  { id: 'emailsec', icon: '📧', label: 'Email Security' },
  { id: 'ediscovery', icon: '⚖️', label: 'eDiscovery' },
  { id: 'dataclass', icon: '🏷️', label: 'Data Classification' },
  { id: 'backup', icon: '💾', label: 'Backup & DR' },
  { id: 'containersec', icon: '📦', label: 'Container Security' },
  { id: 'network', icon: '🌐', label: 'Network Security' },
  { id: 'oncall', icon: '📟', label: 'On-Call' },
  { id: 'cloudsecurity', icon: '🔒', label: 'Cloud Security' },
  { id: 'zerotrust', icon: '🎯', label: 'Zero Trust' },
  { id: 'kubernetes', icon: '☸️', label: 'Kubernetes' },
  { id: 'datamovement', icon: '🔄', label: 'Data Movement' },
  { id: 'datacatalog', icon: '📚', label: 'Data Catalogs' },
  { id: 'documentai', icon: '📄', label: 'Document AI' },
  { id: 'browser', icon: '🌍', label: 'Browser Automation' },
  { id: 'finance', icon: '💰', label: 'Finance & ERP' },
  { id: 'compliance', icon: '✅', label: 'Compliance' },
  { id: 'developer', icon: '💻', label: 'Developer Tools' },
  { id: 'devops', icon: '🔧', label: 'DevOps' },
  { id: 'cloud', icon: '☁️', label: 'Cloud Platforms' },
  { id: 'automation', icon: '🤖', label: 'Automation' },
  { id: 'messaging', icon: '💬', label: 'Messaging' },
  { id: 'communication', icon: '📞', label: 'Communication' },
  { id: 'social', icon: '📱', label: 'Social Media' },
  { id: 'crm', icon: '🤝', label: 'CRM & Sales' },
  { id: 'ecommerce', icon: '🛒', label: 'E-Commerce' },
  { id: 'data', icon: '📈', label: 'Data & Analytics' },
  { id: 'security', icon: '🔐', label: 'Security' },
  { id: 'hr', icon: '👥', label: 'HR & Recruiting' },
  { id: 'projectmgmt', icon: '📋', label: 'Project Management' },
  { id: 'productivity', icon: '⚡', label: 'Productivity' },
  { id: 'ticketing', icon: '🎫', label: 'Ticketing' },
  { id: 'creative', icon: '🎨', label: 'Creative' },
  { id: 'documents', icon: '📝', label: 'Documents' },
  { id: 'analytics', icon: '📊', label: 'Analytics' },
  { id: 'utilities', icon: '🔧', label: 'Utilities' },
  { id: 'custom', icon: '⚙️', label: 'Custom' },
]

// Stats for the hero section
const STATS = [
  { value: TOTAL_COUNT, label: 'Integrations', suffix: '+' },
  { value: Object.keys(CATEGORY_COUNTS).length, label: 'Categories', suffix: '' },
  { value: '0', label: 'Setup Time', suffix: 'min' },
  { value: '100', label: 'Secure', suffix: '%' },
]

// Integration card component
function IntegrationCard({ integration }) {
  return (
    <div
      className="int-card"
      style={{ '--int-color': integration.color || '#6366f1' }}
    >
      <div className="int-card-icon">
        {integration.name.charAt(0)}
      </div>
      <div className="int-card-content">
        <h4 className="int-card-name">{integration.name}</h4>
        <p className="int-card-desc">{integration.description}</p>
      </div>
      <div className="int-card-category">
        {INTEGRATION_CATEGORIES[integration.category]?.name || integration.category}
      </div>
    </div>
  )
}

// Category section component
function CategorySection({ category, integrations }) {
  const catInfo = CATEGORY_ORDER.find(c => c.id === category) || { icon: '⚙️', label: category }
  const catMeta = INTEGRATION_CATEGORIES[category]

  return (
    <div className="int-category-section" id={`cat-${category}`}>
      <div className="int-category-header">
        <span className="int-category-icon">{catInfo.icon}</span>
        <div>
          <h3 className="int-category-title">{catMeta?.name || catInfo.label}</h3>
          <p className="int-category-desc">{catMeta?.description}</p>
        </div>
        <span className="int-category-count">{integrations.length}</span>
      </div>
      <div className="int-category-grid">
        {integrations.map(int => (
          <IntegrationCard key={int.id} integration={int} />
        ))}
      </div>
    </div>
  )
}

export default function IntegrationsPage() {
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('all')

  // Filter integrations
  const filteredIntegrations = useMemo(() => {
    let results = ALL_INTEGRATIONS

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      results = results.filter(int =>
        int.name.toLowerCase().includes(query) ||
        int.description?.toLowerCase().includes(query) ||
        int.id.toLowerCase().includes(query)
      )
    }

    if (selectedCategory !== 'all') {
      results = results.filter(int => int.category === selectedCategory)
    }

    return results
  }, [searchQuery, selectedCategory])

  // Group by category
  const groupedIntegrations = useMemo(() => {
    const grouped = {}
    filteredIntegrations.forEach(int => {
      const cat = int.category || 'custom'
      if (!grouped[cat]) grouped[cat] = []
      grouped[cat].push(int)
    })
    return grouped
  }, [filteredIntegrations])

  // Get featured integrations
  const featuredIntegrations = useMemo(() => {
    return FEATURED_IDS
      .map(id => INTEGRATION_TYPES[id])
      .filter(Boolean)
  }, [])

  // Categories with counts
  const categoriesWithCounts = useMemo(() => {
    return CATEGORY_ORDER
      .filter(cat => CATEGORY_COUNTS[cat.id])
      .map(cat => ({
        ...cat,
        count: CATEGORY_COUNTS[cat.id] || 0
      }))
  }, [])

  return (
    <div className="int-page">
      {/* Hero Section */}
      <section className="int-hero">
        <div className="int-hero-bg">
          <div className="int-hero-gradient" />
          <div className="int-hero-grid" />
        </div>

        <div className="int-hero-content">
          <div className="int-hero-badge">
            <span className="int-hero-badge-icon">🔌</span>
            <span>Integrations Vault</span>
          </div>

          <h1 className="int-hero-title">
            Connect to <span className="int-hero-highlight">{TOTAL_COUNT}+</span> Services
          </h1>

          <p className="int-hero-subtitle">
            From AI models to enterprise compliance tools, QuoxCORE connects to everything
            your workflows need. Securely store credentials once, use everywhere.
          </p>

          {/* Stats Row */}
          <div className="int-hero-stats">
            {STATS.map((stat, i) => (
              <div key={i} className="int-hero-stat">
                <div className="int-hero-stat-value">
                  {stat.value}<span className="int-hero-stat-suffix">{stat.suffix}</span>
                </div>
                <div className="int-hero-stat-label">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Integrations Marquee */}
      <section className="int-featured">
        <div className="int-featured-label">Featured Integrations</div>
        <div className="int-featured-marquee">
          <div className="int-featured-track">
            {[...featuredIntegrations, ...featuredIntegrations].map((int, i) => (
              <div
                key={`${int.id}-${i}`}
                className="int-featured-item"
                style={{ '--int-color': int.color }}
              >
                <span className="int-featured-icon">{int.name.charAt(0)}</span>
                <span className="int-featured-name">{int.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Search and Filter */}
      <section className="int-controls">
        <div className="int-controls-inner">
          <div className="int-search">
            <svg className="int-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              className="int-search-input"
              placeholder="Search integrations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="int-search-clear"
                onClick={() => setSearchQuery('')}
              >
                ×
              </button>
            )}
          </div>

          <div className="int-filter">
            <select
              className="int-filter-select"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="all">All Categories ({TOTAL_COUNT})</option>
              {categoriesWithCounts.map(cat => (
                <option key={cat.id} value={cat.id}>
                  {cat.icon} {cat.label} ({cat.count})
                </option>
              ))}
            </select>
          </div>

          <div className="int-results-count">
            Showing {filteredIntegrations.length} of {TOTAL_COUNT} integrations
          </div>
        </div>
      </section>

      {/* Category Quick Nav */}
      <section className="int-category-nav">
        <div className="int-category-nav-inner">
          {categoriesWithCounts.slice(0, 15).map(cat => (
            <a
              key={cat.id}
              href={`#cat-${cat.id}`}
              className={`int-category-chip ${selectedCategory === cat.id ? 'active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                setSelectedCategory(cat.id)
              }}
            >
              <span className="int-category-chip-icon">{cat.icon}</span>
              <span className="int-category-chip-label">{cat.label}</span>
              <span className="int-category-chip-count">{cat.count}</span>
            </a>
          ))}
          <button
            className="int-category-chip int-category-chip-more"
            onClick={() => setSelectedCategory('all')}
          >
            View All →
          </button>
        </div>
      </section>

      {/* Integration Grid by Category */}
      <section className="int-grid-section">
        {selectedCategory === 'all' ? (
          // Show all categories
          CATEGORY_ORDER
            .filter(cat => groupedIntegrations[cat.id]?.length > 0)
            .map(cat => (
              <CategorySection
                key={cat.id}
                category={cat.id}
                integrations={groupedIntegrations[cat.id]}
              />
            ))
        ) : (
          // Show single category
          groupedIntegrations[selectedCategory] && (
            <CategorySection
              category={selectedCategory}
              integrations={groupedIntegrations[selectedCategory]}
            />
          )
        )}

        {filteredIntegrations.length === 0 && (
          <div className="int-empty">
            <div className="int-empty-icon">🔍</div>
            <h3>No integrations found</h3>
            <p>Try adjusting your search or filter criteria</p>
            <button
              className="int-empty-reset"
              onClick={() => {
                setSearchQuery('')
                setSelectedCategory('all')
              }}
            >
              Reset Filters
            </button>
          </div>
        )}
      </section>

      {/* CTA Section */}
      <section className="int-cta">
        <div className="int-cta-content">
          <h2>Need a custom integration?</h2>
          <p>
            QuoxCORE supports custom integrations with any REST API, GraphQL endpoint,
            or webhook. Build your own connector in minutes.
          </p>
          <div className="int-cta-buttons">
            <Link to="/vault" className="int-cta-btn int-cta-btn-primary">
              Configure Integrations
            </Link>
            <Link to="/docs/api" className="int-cta-btn int-cta-btn-secondary">
              API Documentation
            </Link>
          </div>
        </div>
      </section>

      {/* Security Note */}
      <section className="int-security">
        <div className="int-security-content">
          <div className="int-security-icon">🔐</div>
          <div>
            <h3>Enterprise-Grade Security</h3>
            <p>
              All credentials are encrypted at rest with AES-256-GCM. Keys are never exposed
              in the UI after initial entry. Role-based access controls determine who can
              use each integration. Full audit logging tracks every access.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}

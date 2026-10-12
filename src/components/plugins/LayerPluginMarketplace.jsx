/**
 * LayerPluginMarketplace - Browse Community AOCL Plugins
 *
 * Discover and install plugins from the community marketplace.
 * Part of AOCL Developer Kit (Free)
 */

import { useState, useEffect } from 'react'
import { registerLayerPlugin, getRegisteredPlugins } from '../../services/layers'

// Mock marketplace data (in production, this would come from an API)
const MARKETPLACE_PLUGINS = [
  {
    id: 'sentiment-filter',
    name: 'Sentiment Filter',
    version: '1.2.0',
    author: 'AOCL Team',
    description: 'Analyzes query sentiment and filters negative content before processing',
    layer: { position: 'L4', positionMode: 'after', referenceLayer: 'L3' },
    category: 'filter',
    downloads: 1250,
    rating: 4.8,
    featured: true,
    code: `async (ctx) => {
  const { input, utils } = ctx;
  const query = input.query || '';

  // Simple sentiment keywords
  const negative = ['hate', 'angry', 'terrible', 'awful', 'worst'];
  const hasNegative = negative.some(w => query.toLowerCase().includes(w));

  if (hasNegative) {
    return {
      status: 'warning',
      sentiment: 'negative',
      message: 'Query contains negative sentiment'
    };
  }

  return {
    status: 'complete',
    sentiment: 'neutral',
    passed: true
  };
}`
  },
  {
    id: 'rate-limiter',
    name: 'Advanced Rate Limiter',
    version: '2.0.1',
    author: 'Security Labs',
    description: 'Token bucket rate limiting with burst capacity and user tracking',
    layer: { position: 'L1', positionMode: 'before', referenceLayer: 'L2' },
    category: 'security',
    downloads: 890,
    rating: 4.5,
    featured: false,
    code: `async (ctx) => {
  const { input, config, utils } = ctx;
  const userId = input.userId || 'anonymous';
  const limit = config.limit || 10;

  // Mock rate check
  const currentCount = Math.floor(Math.random() * 15);

  if (currentCount > limit) {
    return {
      status: 'reject',
      reason: 'Rate limit exceeded',
      remaining: 0,
      resetIn: 60
    };
  }

  return {
    status: 'complete',
    allowed: true,
    remaining: limit - currentCount
  };
}`
  },
  {
    id: 'response-formatter',
    name: 'Smart Response Formatter',
    version: '1.0.0',
    author: 'Format Pro',
    description: 'Automatically formats responses with markdown, code blocks, and lists',
    layer: { position: 'L6', positionMode: 'after', referenceLayer: 'L7' },
    category: 'transformer',
    downloads: 650,
    rating: 4.2,
    featured: false,
    code: `async (ctx) => {
  const { input, config } = ctx;
  let response = input.response || '';

  // Format code blocks
  response = response.replace(/\`\`\`(\\w+)?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
    return \`\n\\\`\\\`\\\`\${lang || ''}\n\${code.trim()}\n\\\`\\\`\\\`\n\`;
  });

  return {
    status: 'complete',
    formatted: true,
    response,
    changes: ['code_blocks']
  };
}`
  },
  {
    id: 'pii-detector',
    name: 'PII Detector',
    version: '1.5.0',
    author: 'Privacy First',
    description: 'Detects and masks personally identifiable information in queries and responses',
    layer: { position: 'L4', positionMode: 'after', referenceLayer: 'L3' },
    category: 'security',
    downloads: 2100,
    rating: 4.9,
    featured: true,
    code: `async (ctx) => {
  const { input } = ctx;
  const text = input.query || input.response || '';

  // Simple PII patterns
  const patterns = [
    { name: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g },
    { name: 'phone', regex: /\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b/g },
    { name: 'ssn', regex: /\\b\\d{3}-\\d{2}-\\d{4}\\b/g }
  ];

  const detected = [];
  for (const p of patterns) {
    if (p.regex.test(text)) {
      detected.push(p.name);
    }
  }

  return {
    status: detected.length > 0 ? 'warning' : 'complete',
    piiDetected: detected.length > 0,
    types: detected,
    recommendation: detected.length > 0 ? 'Consider masking sensitive data' : null
  };
}`
  },
  {
    id: 'context-enricher',
    name: 'Context Enricher',
    version: '1.1.0',
    author: 'Context Labs',
    description: 'Enriches queries with additional context from external sources',
    layer: { position: 'L4', positionMode: 'before', referenceLayer: 'L5' },
    category: 'enhancement',
    downloads: 420,
    rating: 4.0,
    featured: false,
    code: `async (ctx) => {
  const { input, utils } = ctx;
  const query = input.query || '';

  // Mock enrichment
  const enrichment = {
    timestamp: utils.now(),
    wordCount: query.split(/\\s+/).length,
    hasQuestion: query.includes('?'),
    language: 'en'
  };

  return {
    status: 'complete',
    enriched: true,
    enrichment,
    originalQuery: query
  };
}`
  },
  {
    id: 'response-validator',
    name: 'Response Quality Validator',
    version: '2.1.0',
    author: 'Quality Check',
    description: 'Validates response quality, checks for hallucinations, and ensures consistency',
    layer: { position: 'L6', positionMode: 'before', referenceLayer: 'L8' },
    category: 'validator',
    downloads: 780,
    rating: 4.6,
    featured: true,
    code: `async (ctx) => {
  const { input, config } = ctx;
  const response = input.response || '';
  const checks = [];

  // Length check
  const minLen = config.minLength || 20;
  const maxLen = config.maxLength || 5000;
  checks.push({
    name: 'length',
    passed: response.length >= minLen && response.length <= maxLen,
    value: response.length
  });

  // Repetition check
  const words = response.toLowerCase().split(/\\s+/);
  const uniqueRatio = new Set(words).size / words.length;
  checks.push({
    name: 'uniqueness',
    passed: uniqueRatio > 0.5,
    value: uniqueRatio.toFixed(2)
  });

  const allPassed = checks.every(c => c.passed);

  return {
    status: allPassed ? 'complete' : 'warning',
    valid: allPassed,
    checks,
    score: checks.filter(c => c.passed).length / checks.length
  };
}`
  }
]

export default function LayerPluginMarketplace() {
  const [plugins, setPlugins] = useState(MARKETPLACE_PLUGINS)
  const [installedIds, setInstalledIds] = useState(new Set())
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sortBy, setSortBy] = useState('downloads')
  const [installing, setInstalling] = useState(null)

  useEffect(() => {
    // Get installed plugin IDs
    const installed = getRegisteredPlugins()
    setInstalledIds(new Set(installed.map(p => p.id)))
  }, [])

  const handleInstall = async (plugin) => {
    setInstalling(plugin.id)

    try {
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 1000))

      const result = registerLayerPlugin({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        author: plugin.author,
        description: plugin.description,
        layer: plugin.layer,
        configSchema: {},
        execute: plugin.code
      })

      if (result.success) {
        setInstalledIds(prev => new Set([...prev, plugin.id]))
      } else {
        alert(`Failed to install: ${result.error}`)
      }
    } catch (err) {
      alert(`Error: ${err.message}`)
    } finally {
      setInstalling(null)
    }
  }

  // Filter and sort plugins
  const filteredPlugins = plugins
    .filter(p => {
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        return p.name.toLowerCase().includes(q) ||
               p.description.toLowerCase().includes(q) ||
               p.author.toLowerCase().includes(q)
      }
      return true
    })
    .filter(p => categoryFilter === 'all' || p.category === categoryFilter)
    .sort((a, b) => {
      if (sortBy === 'downloads') return b.downloads - a.downloads
      if (sortBy === 'rating') return b.rating - a.rating
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      return 0
    })

  const categories = [...new Set(plugins.map(p => p.category))]
  const featuredPlugins = plugins.filter(p => p.featured)

  return (
    <div className="layer-plugin-marketplace">
      {/* Honesty disclosure: these listings are sample data, not a live community
          feed. Download counts and ratings are illustrative. Matches the house
          pattern of visibly labelling non-live data (e.g. NOCView's DEMO badge). */}
      <div className="qx-banner qx-banner--warning" style={{ marginBottom: 16 }}>
        Preview: sample marketplace listings. Download counts and ratings are
        illustrative, and community publishing is not live yet. Installing
        registers the plugin into this browser's local layer registry only.
      </div>
      {/* Search and Filter Bar */}
      <div className="marketplace-controls">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search plugins..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-controls">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="all">All Categories</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="downloads">Most Downloads</option>
            <option value="rating">Highest Rated</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      {/* Featured Section */}
      {!searchQuery && categoryFilter === 'all' && (
        <div className="featured-section">
          <h3>Featured Plugins</h3>
          <div className="featured-grid">
            {featuredPlugins.map(plugin => (
              <MarketplaceCard
                key={plugin.id}
                plugin={plugin}
                isInstalled={installedIds.has(plugin.id)}
                isInstalling={installing === plugin.id}
                onInstall={() => handleInstall(plugin)}
                featured
              />
            ))}
          </div>
        </div>
      )}

      {/* All Plugins */}
      <div className="plugins-section">
        <h3>
          {searchQuery || categoryFilter !== 'all'
            ? `${filteredPlugins.length} plugins found`
            : 'All Plugins'}
        </h3>

        {filteredPlugins.length === 0 ? (
          <div className="no-results">
            <p>No plugins match your search</p>
          </div>
        ) : (
          <div className="plugins-grid">
            {filteredPlugins.map(plugin => (
              <MarketplaceCard
                key={plugin.id}
                plugin={plugin}
                isInstalled={installedIds.has(plugin.id)}
                isInstalling={installing === plugin.id}
                onInstall={() => handleInstall(plugin)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MarketplaceCard({ plugin, isInstalled, isInstalling, onInstall, featured }) {
  const getCategoryColor = (category) => {
    const colors = {
      filter: '#8b5cf6',
      security: '#ef4444',
      transformer: '#22c55e',
      validator: '#f59e0b',
      enhancement: '#3b82f6'
    }
    return colors[category] || '#6b7280'
  }

  const renderStars = (rating) => {
    const full = Math.floor(rating)
    const half = rating % 1 >= 0.5
    const stars = []

    for (let i = 0; i < 5; i++) {
      if (i < full) {
        stars.push(<span key={i} className="star full">*</span>)
      } else if (i === full && half) {
        stars.push(<span key={i} className="star half">*</span>)
      } else {
        stars.push(<span key={i} className="star empty">*</span>)
      }
    }

    return stars
  }

  return (
    <div className={`marketplace-card ${featured ? 'featured' : ''}`}>
      <div className="card-header">
        <div className="card-title">
          <span className="plugin-name">{plugin.name}</span>
          <span
            className="plugin-category"
            style={{ backgroundColor: getCategoryColor(plugin.category) }}
          >
            {plugin.category}
          </span>
        </div>
        <span className="plugin-version">v{plugin.version}</span>
      </div>

      <p className="card-description">{plugin.description}</p>

      <div className="card-meta">
        <span className="author">by {plugin.author}</span>
        <span className="layer-badge">{plugin.layer.position}</span>
      </div>

      <div className="card-stats">
        <span className="downloads">{plugin.downloads.toLocaleString()} downloads</span>
        <span className="rating">
          {renderStars(plugin.rating)}
          <span className="rating-value">{plugin.rating}</span>
        </span>
      </div>

      <div className="card-actions">
        {isInstalled ? (
          <span className="installed-badge">Installed</span>
        ) : (
          <button
            className="install-btn"
            onClick={onInstall}
            disabled={isInstalling}
          >
            {isInstalling ? 'Installing...' : 'Install'}
          </button>
        )}
      </div>
    </div>
  )
}

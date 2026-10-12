/**
 * QuoxCORE Memory Search Panel
 *
 * Unified search interface across all memory systems:
 * - Episodic memory (conversations)
 * - Semantic memory (learned facts)
 * - Entity memory (hosts, services, etc.)
 * - Belief memory (knowledge/beliefs)
 * - Failure memory (past mistakes)
 * - Working set memory (current context)
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import DOMPurify from 'dompurify'
import MarkdownContent from '../ui/MarkdownContent'
import { getMemoryManager } from '../../services/memoryManager'
import { getMemoryClient } from '../../services/memoryClient'
import { findRelevantBeliefs, BELIEF_STATUS } from '../../services/beliefMemory'
import { findRelevantFailures, FAILURE_TYPES } from '../../services/failureMemory'
import { searchColdStorage, STORAGE_TIER } from '../../services/memoryPromotion'
import { getRecentEntities, getOpenLoops } from '../../services/workingSetMemory'

// Memory type colors and labels (icons rendered via <TypeIcon>)
const MEMORY_TYPES = {
  episodic: { color: '#38bdf8', label: 'Episodic' },
  semantic: { color: '#3498db', label: 'Semantic' },
  entity: { color: '#27ae60', label: 'Entity' },
  belief: { color: '#1abc9c', label: 'Belief' },
  failure: { color: '#e74c3c', label: 'Failure' },
  fact: { color: '#4a9eff', label: 'Fact' },
  preference: { color: '#f39c12', label: 'Preference' },
  constraint: { color: '#67e8f9', label: 'Constraint' },
  decision: { color: '#0ea5e9', label: 'Decision' },
  cold: { color: '#94a3b8', label: 'Cold Storage' }
}

// Source labels
const SOURCE_LABELS = {
  tool_output: 'Tool Output',
  explicit_command: 'User Command',
  user_stated: 'User Stated',
  model_inference: 'AI Inference',
  chatgpt: 'ChatGPT Import',
  manual: 'Manual Entry'
}

const BELIEF_STATUS_PILL = {
  fact: 'qx-pill--online',
  belief: 'qx-pill--info',
  assumption: 'qx-pill--medium',
  hypothesis: 'qx-pill--purple',
  uncertain: 'qx-pill--medium',
  disproven: 'qx-pill--danger'
}

/** Inline SVG icon per memory type — 14-16px, matches the rest of the dashboard. */
function TypeIcon({ type, size = 14 }) {
  const p = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': true
  }
  switch (type) {
    case 'episodic':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></svg>
    case 'semantic':
      return <svg {...p}><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
    case 'entity':
      return <svg {...p}><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></svg>
    case 'belief':
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
    case 'failure':
      return <svg {...p}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
    case 'preference':
      return <svg {...p}><line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2" fill="currentColor" /><line x1="4" y1="12" x2="20" y2="12" /><circle cx="16" cy="12" r="2" fill="currentColor" /><line x1="4" y1="18" x2="20" y2="18" /><circle cx="11" cy="18" r="2" fill="currentColor" /></svg>
    case 'constraint':
      return <svg {...p}><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
    case 'decision':
      return <svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" /><path d="M6 8.5v7M8.2 7l7.6 3.6M8.2 17l7.6-3.6" /></svg>
    case 'cold':
      return <svg {...p}><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" /><line x1="10" y1="13" x2="14" y2="13" /></svg>
    case 'fact':
    default:
      return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></svg>
  }
}

function SearchIcon({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
}
function CloseIcon({ size = 14 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
}

/**
 * Memory Search Panel
 */
export function MemorySearchPanel({ onClose, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  // A FAILED SEARCH IS NOT AN EMPTY MEMORY. Without this the catch below set
  // results to [] and logged to the console, so a search that errored rendered
  // as "No memories found for X" — the panel asserting the memory holds
  // nothing matching, when in truth it never got an answer.
  const [searchError, setSearchError] = useState(null)
  // True when the server search failed and these results came from the local
  // cache only. Disclosed, not hidden: see the catch that sets it.
  const [degradedToLocal, setDegradedToLocal] = useState(false)
  const [selectedResult, setSelectedResult] = useState(null)

  // Filters
  const [filters, setFilters] = useState({
    types: [], // Empty = all types
    sources: [],
    dateRange: 'all', // all | day | week | month | year
    minConfidence: 0,
    sortBy: 'relevance' // relevance | date | confidence
  })

  // Stats
  const [stats, setStats] = useState(null)

  // Search debounce
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  // Perform search when query or filters change
  useEffect(() => {
    if (debouncedQuery.trim()) {
      performSearch(debouncedQuery)
    } else {
      setResults([])
      setStats(null)
    }
  }, [debouncedQuery, filters])

  // Search function
  const performSearch = useCallback(async (searchQuery) => {
    setLoading(true)
    // Clear both honesty signals at the START of every search. Resetting only
    // on success leaves a stale banner claiming a degradation that has since
    // recovered, which is its own small lie.
    setSearchError(null)
    setDegradedToLocal(false)
    const allResults = []
    const searchStats = { byType: {}, total: 0, sources: {} }

    try {
      const mm = getMemoryManager()

      // Calculate date cutoff
      let dateCutoff = null
      if (filters.dateRange !== 'all') {
        const now = new Date()
        switch (filters.dateRange) {
          case 'day':
            dateCutoff = new Date(now - 24 * 60 * 60 * 1000)
            break
          case 'week':
            dateCutoff = new Date(now - 7 * 24 * 60 * 60 * 1000)
            break
          case 'month':
            dateCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000)
            break
          case 'year':
            dateCutoff = new Date(now - 365 * 24 * 60 * 60 * 1000)
            break
        }
      }

      // Search learned memories — server first (FTS5), localStorage fallback
      if (shouldSearchType(['fact', 'preference', 'constraint', 'decision'])) {
        let learned = []
        try {
          const client = getMemoryClient()
          const serverResults = await client.searchMemories({ query: searchQuery, limit: 50 })
          if (serverResults && serverResults.length > 0) {
            learned = serverResults.map(m => ({
              ...m,
              type: m.memory_type || m.type || 'fact',
              provenance: m.provenance ? (typeof m.provenance === 'string' ? { source: m.provenance } : m.provenance) : { source: 'server' }
            }))
          }
        } catch {
          // Server unavailable: fall through to localStorage, and REMEMBER
          // that we did.
          //
          // Falling back is right; doing it silently is not. The server holds
          // the durable memory and localStorage is a cache, so a fallback
          // result can be materially thinner than the real answer while
          // looking identical on screen. A user who searches, sees three
          // results and concludes that is what they have is being misled by
          // an outage they were never told about.
          setDegradedToLocal(true)
        }

        if (learned.length === 0) {
          learned = await mm.getLearnedMemories(searchQuery, 20)
        }

        for (const item of learned) {
          if (!passesFilters(item, dateCutoff)) continue

          allResults.push({
            ...item,
            category: 'learned',
            displayType: item.type || item.memory_type || 'fact'
          })
          const itemType = item.type || item.memory_type || 'fact'
          searchStats.byType[itemType] = (searchStats.byType[itemType] || 0) + 1
          const source = item.provenance?.source || item.provenance || 'unknown'
          searchStats.sources[source] = (searchStats.sources[source] || 0) + 1
        }
      }

      // Search entity memory
      if (shouldSearchType(['entity'])) {
        const entities = mm.searchEntities(searchQuery, 20)
        for (const entity of entities) {
          if (!passesFilters(entity, dateCutoff)) continue

          allResults.push({
            id: `entity-${entity.id}`,
            content: `${entity.name} (${entity.type})`,
            type: 'entity',
            category: 'entity',
            displayType: 'entity',
            entity,
            provenance: {
              createdAt: entity.firstSeen || entity.lastSeen,
              source: 'entity_registry'
            }
          })
          searchStats.byType.entity = (searchStats.byType.entity || 0) + 1
        }
      }

      // Search beliefs
      if (shouldSearchType(['belief'])) {
        const beliefs = findRelevantBeliefs(searchQuery, { limit: 20 })
        for (const belief of beliefs) {
          if (!passesFilters(belief, dateCutoff)) continue

          allResults.push({
            id: belief.id,
            content: belief.content,
            type: 'belief',
            category: 'belief',
            displayType: 'belief',
            belief,
            confidence: { score: belief.confidence },
            provenance: {
              createdAt: belief.createdAt,
              source: belief.provenance?.source
            }
          })
          searchStats.byType.belief = (searchStats.byType.belief || 0) + 1
        }
      }

      // Search failures
      if (shouldSearchType(['failure'])) {
        const failures = findRelevantFailures(searchQuery, { limit: 20 })
        for (const failure of failures) {
          if (!passesFilters(failure, dateCutoff)) continue

          allResults.push({
            id: failure.id,
            content: failure.whatFailed || failure.description,
            type: 'failure',
            category: 'failure',
            displayType: 'failure',
            failure,
            provenance: {
              createdAt: failure.firstOccurrence,
              source: 'failure_memory'
            }
          })
          searchStats.byType.failure = (searchStats.byType.failure || 0) + 1
        }
      }

      // Search cold storage
      if (shouldSearchType(['cold'])) {
        const coldItems = searchColdStorage(searchQuery, { limit: 20 })
        for (const item of coldItems) {
          if (!passesFilters(item, dateCutoff)) continue

          allResults.push({
            id: item.id,
            content: item.content,
            type: 'cold',
            category: 'cold',
            displayType: 'cold',
            cold: item,
            confidence: { score: item.confidence },
            provenance: {
              createdAt: item.importedAt,
              source: item.source
            }
          })
          searchStats.byType.cold = (searchStats.byType.cold || 0) + 1
        }
      }

      // Sort results
      setSearchError(null)
      const sortedResults = sortResults(allResults, filters.sortBy)

      searchStats.total = sortedResults.length
      setResults(sortedResults)
      setStats(searchStats)
    } catch (err) {
      console.error('Search failed:', err)
      setResults([])
      setSearchError(err?.message || 'the search could not be completed')
    }

    setLoading(false)
  }, [filters])

  // Helper: check if we should search a type
  const shouldSearchType = (types) => {
    if (filters.types.length === 0) return true
    return types.some(t => filters.types.includes(t))
  }

  // Helper: check if item passes filters
  const passesFilters = (item, dateCutoff) => {
    // Date filter
    if (dateCutoff) {
      const itemDate = new Date(
        item.provenance?.createdAt ||
        item.createdAt ||
        item.firstOccurrence ||
        item.importedAt ||
        0
      )
      if (itemDate < dateCutoff) return false
    }

    // Confidence filter
    if (filters.minConfidence > 0) {
      const conf = item.confidence?.score || item.confidence || 0
      if (conf < filters.minConfidence) return false
    }

    // Source filter
    if (filters.sources.length > 0) {
      const source = item.provenance?.source || item.source
      if (!filters.sources.includes(source)) return false
    }

    return true
  }

  // Sort results
  const sortResults = (items, sortBy) => {
    return [...items].sort((a, b) => {
      switch (sortBy) {
        case 'date':
          const dateA = new Date(a.provenance?.createdAt || 0)
          const dateB = new Date(b.provenance?.createdAt || 0)
          return dateB - dateA
        case 'confidence':
          const confA = a.confidence?.score || 0
          const confB = b.confidence?.score || 0
          return confB - confA
        default: // relevance - keep original order (from search)
          return 0
      }
    })
  }

  // Toggle type filter
  const toggleTypeFilter = (type) => {
    setFilters(prev => ({
      ...prev,
      types: prev.types.includes(type)
        ? prev.types.filter(t => t !== type)
        : [...prev.types, type]
    }))
  }

  // Clear all filters
  const clearFilters = () => {
    setFilters({
      types: [],
      sources: [],
      dateRange: 'all',
      minConfidence: 0,
      sortBy: 'relevance'
    })
  }

  const hasActiveFilters = filters.types.length > 0 || filters.minConfidence > 0 || filters.dateRange !== 'all'

  return (
    <div className="qx-stack">
      {/* Header (only shown when used as a standalone closeable panel) */}
      {onClose && (
        <div className="qx-row qx-row--apart">
          <div className="qx-row qx-row--tight">
            <span style={{ color: '#38bdf8', display: 'inline-flex' }}><SearchIcon size={18} /></span>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#fff' }}>Memory Search</h2>
          </div>
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close search">
            <CloseIcon />
          </button>
        </div>
      )}

      {/* Search Input */}
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.6)', display: 'inline-flex', pointerEvents: 'none' }}>
          <SearchIcon size={15} />
        </span>
        <input
          type="text"
          className="qx-input"
          placeholder="Search across all memories..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ paddingLeft: 36, paddingRight: query ? 36 : 14 }}
          autoFocus
        />
        {query && (
          <button
            className="qx-row-action"
            style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
            onClick={() => setQuery('')}
            aria-label="Clear search"
          >
            <CloseIcon size={13} />
          </button>
        )}
      </div>

      {/* Type filters */}
      <div className="qx-row qx-row--wrap qx-row--tight">
        {Object.entries(MEMORY_TYPES).map(([type, config]) => {
          const active = filters.types.includes(type)
          return (
            <button
              key={type}
              className={`qx-chip ${active ? 'qx-chip--active' : ''}`}
              onClick={() => toggleTypeFilter(type)}
            >
              <span style={{ color: config.color, display: 'inline-flex' }}><TypeIcon type={type} size={13} /></span>
              {config.label}
            </button>
          )
        })}
      </div>

      {/* Other filters */}
      <div className="qx-row qx-row--apart qx-row--wrap qx-row--tight">
        <div className="qx-row qx-row--tight qx-row--wrap">
          <select
            className="qx-select"
            style={{ width: 'auto' }}
            value={filters.dateRange}
            onChange={(e) => setFilters({ ...filters, dateRange: e.target.value })}
          >
            <option value="all">All Time</option>
            <option value="day">Last 24h</option>
            <option value="week">Last Week</option>
            <option value="month">Last Month</option>
            <option value="year">Last Year</option>
          </select>

          <select
            className="qx-select"
            style={{ width: 'auto' }}
            value={filters.sortBy}
            onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
          >
            <option value="relevance">By Relevance</option>
            <option value="date">By Date</option>
            <option value="confidence">By Confidence</option>
          </select>

          <div className="qx-row qx-row--tight" style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
            <label htmlFor="ms-min-conf">Min Conf:</label>
            <input
              id="ms-min-conf"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={filters.minConfidence}
              onChange={(e) => setFilters({ ...filters, minConfidence: parseFloat(e.target.value) })}
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>{Math.round(filters.minConfidence * 100)}%</span>
          </div>
        </div>

        {hasActiveFilters && (
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={clearFilters}>
            <CloseIcon size={12} />
            Clear Filters
          </button>
        )}
      </div>

      {/* Results Stats */}
      {stats && (
        <div className="qx-row qx-row--apart qx-row--wrap" style={{ fontSize: 12 }}>
          <span style={{ color: '#fff', fontWeight: 600 }}>{stats.total} results</span>
          <div className="qx-row qx-row--tight qx-row--wrap">
            {Object.entries(stats.byType).map(([type, count]) => (
              <span
                key={type}
                className="qx-row qx-row--tight"
                style={{ color: MEMORY_TYPES[type]?.color || '#fff', gap: 4 }}
              >
                <TypeIcon type={type} size={12} />
                {MEMORY_TYPES[type]?.label || type}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Results List */}
      <div>
        {/* Disclosed above every outcome, because a degraded search that
          returns NOTHING is exactly when a user most needs telling: an empty
          cache and an empty memory look identical otherwise. */}
      {degradedToLocal && !loading && (
        <div className="qx-banner qx-banner--warn" data-testid="memory-search-degraded">
          The memory service did not answer, so these results come from this
          browser&rsquo;s cache only. Your saved memory may hold more than is
          shown here.
        </div>
      )}
      {loading ? (
          <div className="qx-stack qx-stack--tight">
            {[0, 1, 2].map(i => (
              <div key={i} className="qx-skeleton qx-skeleton--block" />
            ))}
          </div>
        ) : results.length > 0 ? (
          <div className="qx-stack qx-stack--tight">
            {results.map((result) => (
              <SearchResultCard
                key={result.id}
                result={result}
                query={query}
                onSelect={() => setSelectedResult(result)}
              />
            ))}
          </div>
        ) : searchError ? (
          <div className="qx-empty" data-testid="memory-search-error">
            <div className="qx-empty__icon"><SearchIcon size={24} /></div>
            <div className="qx-empty__title">The search did not complete</div>
            <div className="qx-empty__body">
              {searchError}. This is not a statement about what your memory
              contains: nothing was searched.
            </div>
          </div>
        ) : query ? (
          <div className="qx-empty" data-testid="memory-search-empty">
            <div className="qx-empty__icon"><SearchIcon size={24} /></div>
            <div className="qx-empty__title">No memories found for &ldquo;{query}&rdquo;</div>
            <div className="qx-empty__body">Try different keywords or clear filters.</div>
          </div>
        ) : (
          <div className="qx-empty">
            <div className="qx-empty__icon"><SearchIcon size={24} /></div>
            <div className="qx-empty__title">Enter a search query to find memories</div>
            <div className="qx-empty__body" style={{ maxWidth: 380, textAlign: 'left' }}>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                <li>Search by keywords: &ldquo;docker configuration&rdquo;</li>
                <li>Search by entity: &ldquo;docker01&rdquo;, &ldquo;@adam&rdquo;</li>
                <li>Search by type: filter with the chips above</li>
                <li>Search by date: use the date range filter</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {selectedResult && (
        <SearchResultDetail
          result={selectedResult}
          onClose={() => setSelectedResult(null)}
        />
      )}
    </div>
  )
}

/**
 * Search Result Card
 */
function SearchResultCard({ result, query, onSelect }) {
  const typeConfig = MEMORY_TYPES[result.displayType] || { color: 'rgba(255,255,255,0.7)', label: 'Unknown' }

  // Highlight matching text
  const highlightedContent = useMemo(() => {
    if (!query) return result.content
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    return result.content?.replace(regex, '<mark>$1</mark>') || ''
  }, [result.content, query])

  return (
    <div className="qx-result" onClick={onSelect}>
      <div className="qx-result__score">
        <span style={{ color: typeConfig.color, display: 'inline-flex' }}><TypeIcon type={result.displayType} size={20} /></span>
        {result.confidence?.score != null && (
          <span className="qx-result__score-val" style={{ fontSize: 13 }}>{Math.round(result.confidence.score * 100)}%</span>
        )}
      </div>

      <div className="qx-result__body">
        <span className="qx-result__title" style={{ color: typeConfig.color }}>{typeConfig.label}</span>
        <div
          className="qx-result__snippet"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(highlightedContent) }}
        />
        <div className="qx-result__meta">
          {result.provenance?.source && (
            <span>{SOURCE_LABELS[result.provenance.source] || result.provenance.source}</span>
          )}
          {result.entity && <span className="qx-pill qx-pill--xs qx-pill--ghost">{result.entity.type}</span>}
          {result.failure && (
            <span className={`qx-severity qx-severity--${result.failure.severity}`}>{result.failure.severity}</span>
          )}
          {result.belief && (
            <span className={`qx-pill qx-pill--xs ${BELIEF_STATUS_PILL[result.belief.status] || 'qx-pill--ghost'}`}>{result.belief.status}</span>
          )}
        </div>
      </div>

      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)', whiteSpace: 'nowrap' }}>
        {result.provenance?.createdAt
          ? new Date(result.provenance.createdAt).toLocaleDateString()
          : 'Unknown date'}
      </span>
    </div>
  )
}

/**
 * Search Result Detail Panel
 */
function SearchResultDetail({ result, onClose }) {
  const typeConfig = MEMORY_TYPES[result.displayType] || { color: 'rgba(255,255,255,0.7)', label: 'Unknown' }

  return (
    <div className="qx-modal-overlay" onClick={onClose}>
      <div className="qx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="qx-modal__header">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: typeConfig.color, display: 'inline-flex' }}><TypeIcon type={result.displayType} size={16} /></span>
            {typeConfig.label}
          </h3>
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} aria-label="Close detail">
            <CloseIcon />
          </button>
        </div>

        <div className="qx-modal__body qx-stack qx-stack--tight">
          {/* Main Content */}
          <div className="qx-field">
            <label className="qx-field__label">Content</label>
            <div style={{ fontSize: 13, color: '#fff', lineHeight: 1.5 }}>
              <MarkdownContent compact>{result.content}</MarkdownContent>
            </div>
          </div>

          {/* ID */}
          <div className="qx-field">
            <label className="qx-field__label">ID</label>
            <code className="qx-code">{result.id}</code>
          </div>

          {/* Provenance */}
          {result.provenance && (
            <div className="qx-row qx-row--wrap">
              <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                <label className="qx-field__label">Source</label>
                <span style={{ color: '#fff', fontSize: 13 }}>{SOURCE_LABELS[result.provenance.source] || result.provenance.source}</span>
              </div>
              <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                <label className="qx-field__label">Created</label>
                <span style={{ color: '#fff', fontSize: 13 }}>{result.provenance.createdAt ? new Date(result.provenance.createdAt).toLocaleString() : 'Unknown'}</span>
              </div>
            </div>
          )}

          {/* Confidence */}
          {result.confidence?.score != null && (
            <div className="qx-field">
              <label className="qx-field__label">Confidence</label>
              <div className="qx-row qx-row--tight">
                <div className="qx-progress qx-progress--brand" style={{ '--qx-progress': result.confidence.score }} />
                <span style={{ fontSize: 12, color: '#fff', minWidth: 36, textAlign: 'right' }}>{Math.round(result.confidence.score * 100)}%</span>
              </div>
            </div>
          )}

          {/* Entity-specific details */}
          {result.entity && (
            <>
              <div className="qx-field">
                <label className="qx-field__label">Entity Type</label>
                <span style={{ color: '#fff', fontSize: 13 }}>{result.entity.type}</span>
              </div>
              {result.entity.properties && Object.keys(result.entity.properties).length > 0 && (
                <div className="qx-field">
                  <label className="qx-field__label">Properties</label>
                  <div className="qx-stack qx-stack--tight">
                    {Object.entries(result.entity.properties).map(([k, v]) => (
                      <div key={k} className="qx-stat-row">
                        <span className="qx-stat-row__label">{k}</span>
                        <span className="qx-stat-row__value" style={{ fontWeight: 400, fontFamily: 'inherit', color: '#fff' }}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Failure-specific details */}
          {result.failure && (
            <>
              <div className="qx-row qx-row--wrap">
                <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                  <label className="qx-field__label">Failure Type</label>
                  <span style={{ color: '#fff', fontSize: 13 }}>{result.failure.type}</span>
                </div>
                <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                  <label className="qx-field__label">Severity</label>
                  <span className={`qx-severity qx-severity--${result.failure.severity}`}>{result.failure.severity}</span>
                </div>
              </div>
              {result.failure.whyItFailed && (
                <div className="qx-field">
                  <label className="qx-field__label">Why It Failed</label>
                  <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>{result.failure.whyItFailed}</p>
                </div>
              )}
              {result.failure.avoidanceAdvice && (
                <div className="qx-field">
                  <label className="qx-field__label">Avoidance Advice</label>
                  <p style={{ margin: 0, fontSize: 13, color: '#30ff90' }}>{result.failure.avoidanceAdvice}</p>
                </div>
              )}
              {result.failure.workaround && (
                <div className="qx-field">
                  <label className="qx-field__label">Workaround</label>
                  <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>{result.failure.workaround.description}</p>
                </div>
              )}
            </>
          )}

          {/* Belief-specific details */}
          {result.belief && (
            <>
              <div className="qx-row qx-row--wrap">
                <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                  <label className="qx-field__label">Status</label>
                  <span className={`qx-pill qx-pill--xs ${BELIEF_STATUS_PILL[result.belief.status] || 'qx-pill--ghost'}`}>{result.belief.status}</span>
                </div>
                {result.belief.domain && (
                  <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                    <label className="qx-field__label">Domain</label>
                    <span style={{ color: '#fff', fontSize: 13 }}>{result.belief.domain}</span>
                  </div>
                )}
              </div>
              {result.belief.basis && (
                <div className="qx-field">
                  <label className="qx-field__label">Basis</label>
                  <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.9)' }}>{result.belief.basis}</p>
                </div>
              )}
            </>
          )}

          {/* Cold storage details */}
          {result.cold && (
            <>
              <div className="qx-row qx-row--wrap">
                <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                  <label className="qx-field__label">Tier</label>
                  <span className="qx-pill qx-pill--xs qx-pill--ghost">{result.cold.tier}</span>
                </div>
                <div className="qx-field" style={{ flex: 1, minWidth: 160 }}>
                  <label className="qx-field__label">Import Source</label>
                  <span style={{ color: '#fff', fontSize: 13 }}>{result.cold.source}</span>
                </div>
              </div>
              {result.cold.topics?.length > 0 && (
                <div className="qx-field">
                  <label className="qx-field__label">Topics</label>
                  <div className="qx-row qx-row--wrap qx-row--tight">
                    {result.cold.topics.map((topic, idx) => (
                      <span key={idx} className="qx-chip qx-chip--brand">{topic}</span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default MemorySearchPanel

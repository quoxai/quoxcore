/**
 * DocsPanel — Quox DevSuite documentation browser
 *
 * DEVSUITE-DOCS Phase 1+2: reads existing, already-generated docs — no new
 * indexer. Repo picker lists every sibling repo under /opt/quoxcore that has
 * a CODEBASE_MAP.md (GET /collector/api/v1/docs/repos, collector's
 * lib/docsBrowser.js), plus this repo's own STATUS_AND_LIMITS_*.md docs
 * (GET /collector/api/v1/docs/status-and-limits). Selecting an entry renders
 * its raw markdown via the shared MarkdownContent component (no new
 * markdown dependency). Each CODEBASE_MAP.md entry carries a staleness
 * badge from the collector's drift check (map's "Last verified" header vs
 * the repo's actual last commit). Search delegates to the real RepoBrain
 * HTTP service (GET /collector/api/v1/docs/search) — no parallel search
 * index.
 *
 * Mirrors DevServersHubPanel.jsx's data-fetching pattern (loading/error/
 * empty states, monitoring.css classes) for the repo/status lists; adds its
 * own doc-content and search sub-states.
 *
 * DEVSUITE-DOCS Phase 3: GET .../status-and-limits/:name now also returns a
 * `maturity` array (parsed by the collector's parseMaturityTable()) and GET
 * .../status-and-limits returns a `rollup` of tag counts across every doc.
 * When a STATUS_AND_LIMITS doc parses to at least one row, render it as a
 * real table (tag as a qx-pill badge) with a Table/Raw toggle; otherwise
 * fall back to raw markdown only, same as before this phase.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import MarkdownContent from '../../ui/MarkdownContent'
import '../monitoring/monitoring.css'
import './docs-panel.css'

// Tag -> qx-pill variant. Mirrors the six STATUS_AND_LIMITS maturity tags
// (see docs/STATUS_AND_LIMITS_TEMPLATE.md "Maturity tags"). Any non-canonical
// tag text the parser passed through raw (real docs use compound statuses
// like "Broken (documented gap)") falls back to qx-pill--ghost.
const MATURITY_BADGE_VARIANT = {
  Stable: 'success',
  Beta: 'info',
  Experimental: 'warn',
  Stub: 'ghost',
  Broken: 'danger',
  'Not started': 'ghost',
}

const MATURITY_TAG_ORDER = ['Stable', 'Beta', 'Experimental', 'Stub', 'Broken', 'Not started']

function slugTag(tag) {
  return String(tag || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other'
}

// The row shows the AUTHOR'S OWN WORDING and is coloured by the bucket that
// wording counts towards. "NOT SHIPPED, explicitly deferred" says more than
// "Not started" and keeps its text, but it should not sit there grey while the
// rollup above counts it as Not started.
//
// `canonicalTag` comes from the server (docsBrowser.canonicalMaturityTag) so
// the synonym map lives in exactly one place. A second copy here is how the
// badge and the count end up disagreeing about the same row.
function MaturityBadge({ tag, canonicalTag }) {
  const variant = MATURITY_BADGE_VARIANT[canonicalTag || tag] || 'ghost'
  return (
    <span className={`qx-pill qx-pill--sm qx-pill--${variant}`} data-testid={`maturity-badge-${slugTag(tag)}`}>
      {tag}
    </span>
  )
}

// "12 Stable, 5 Beta, 3 Stub across 33 docs" — honest rollup data only, no
// DoneEngine reference (DoneEngine isn't real code yet).
function formatRollup(rollup) {
  if (!rollup) return ''
  const tagCounts = rollup.tagCounts || {}
  const parts = MATURITY_TAG_ORDER
    .map((tag) => ({ tag, count: tagCounts[tag] || 0 }))
    .filter((p) => p.count > 0)
    .map((p) => `${p.count} ${p.tag}`)
  const otherCount = Object.entries(tagCounts).reduce(
    (sum, [tag, count]) => (MATURITY_TAG_ORDER.includes(tag) ? sum : sum + count),
    0
  )
  if (otherCount > 0) parts.push(`${otherCount} other`)
  const docsLabel = `${rollup.totalDocs} doc${rollup.totalDocs === 1 ? '' : 's'}`
  return parts.length > 0 ? `${parts.join(', ')} across ${docsLabel}` : `No structured maturity data across ${docsLabel}`
}

function StaleBadge({ stale }) {
  if (stale === null || stale === undefined) {
    return (
      <span className="qx-pill qx-pill--sm qx-pill--ghost" data-testid="stale-badge-unknown" title="Drift status unavailable">
        drift unknown
      </span>
    )
  }
  return stale ? (
    <span className="qx-pill qx-pill--sm qx-pill--warn" data-testid="stale-badge-stale">stale</span>
  ) : (
    <span className="qx-pill qx-pill--sm qx-pill--online" data-testid="stale-badge-fresh">fresh</span>
  )
}

export default function DocsPanel() {
  const [repos, setRepos] = useState([])
  const [statusDocs, setStatusDocs] = useState([])
  const [maturityRollup, setMaturityRollup] = useState(null)
  const [listsLoading, setListsLoading] = useState(true)
  const [listsError, setListsError] = useState(null)

  const [selected, setSelected] = useState(null) // { kind: 'repo' | 'status', id }
  const [docContent, setDocContent] = useState(null)
  const [docStale, setDocStale] = useState(null)
  const [docMaturity, setDocMaturity] = useState([])
  const [docViewMode, setDocViewMode] = useState('table') // 'table' | 'raw' — status docs only
  const [docLoading, setDocLoading] = useState(false)
  const [docError, setDocError] = useState(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchRepo, setSearchRepo] = useState('quox-dashboard')
  const [searchResults, setSearchResults] = useState(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState(null)

  const connectionIdRef = useRef(0)
  const listsLoadingRef = useRef(true)
  useEffect(() => { listsLoadingRef.current = listsLoading }, [listsLoading])

  const fetchLists = useCallback(async () => {
    const currentId = connectionIdRef.current
    try {
      const [reposRes, statusRes] = await Promise.all([
        fetch('/collector/api/v1/docs/repos'),
        fetch('/collector/api/v1/docs/status-and-limits'),
      ])
      if (!reposRes.ok) throw new Error(`HTTP ${reposRes.status}`)
      if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`)
      const reposData = await reposRes.json()
      const statusData = await statusRes.json()

      if (connectionIdRef.current !== currentId) return
      setRepos(Array.isArray(reposData.repos) ? reposData.repos : [])
      setStatusDocs(Array.isArray(statusData.docs) ? statusData.docs : [])
      setMaturityRollup(statusData.rollup || null)
      setListsError(null)
    } catch (err) {
      if (connectionIdRef.current === currentId) setListsError(err.message)
    } finally {
      if (connectionIdRef.current === currentId) setListsLoading(false)
    }
  }, [])

  useEffect(() => {
    connectionIdRef.current++
    fetchLists()
    // FIRST-LOAD RESILIENCE (human-eyes review 2026-08-21): this panel
    // fetched once with no poll and no retry, so a boot-storm loss left a
    // human on "Loading docs…" PERMANENTLY on the dev-suite landing. Fast
    // retries (1s, 2s, 4s) recover from the storm; they stop once the lists
    // have loaded. A one-shot panel needs the retry more than a polling one.
    //
    // The retries read listsLoadingRef (not the listsLoading state value)
    // and this effect's deps carry only fetchLists (stable, no deps): the
    // dep array previously included listsLoading directly, so every loading
    // -> loaded transition RE-RAN this whole effect — bumping
    // connectionIdRef and firing an unrequested extra fetchLists() on top
    // of whatever the caller intended next (test evidence: a DocsPanel
    // search-mock-once became consumed by this stray relist call instead of
    // the search request it was meant for).
    const retries = [1000, 2000, 4000].map((ms) =>
      setTimeout(() => { if (listsLoadingRef.current) fetchLists() }, ms))
    return () => {
      connectionIdRef.current++
      retries.forEach(clearTimeout)
    }
  }, [fetchLists])

  const openDoc = useCallback(async (kind, id) => {
    setSelected({ kind, id })
    setDocLoading(true)
    setDocError(null)
    setDocContent(null)
    setDocStale(null)
    setDocMaturity([])
    setDocViewMode('table')
    try {
      const url = kind === 'repo'
        ? `/collector/api/v1/docs/repos/${encodeURIComponent(id)}/map`
        : `/collector/api/v1/docs/status-and-limits/${encodeURIComponent(id)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setDocContent(data.content || '')
      setDocStale(kind === 'repo' ? data.stale : null)
      setDocMaturity(kind === 'status' && Array.isArray(data.maturity) ? data.maturity : [])
    } catch (err) {
      setDocError(err.message)
    } finally {
      setDocLoading(false)
    }
  }, [])

  const runSearch = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault()
    const q = searchQuery.trim()
    if (!q) return
    setSearchLoading(true)
    setSearchError(null)
    setSearchResults(null)
    try {
      const url = `/collector/api/v1/docs/search?q=${encodeURIComponent(q)}&repo=${encodeURIComponent(searchRepo)}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSearchResults(Array.isArray(data.snippets) ? data.snippets : [])
    } catch (err) {
      setSearchError(err.message)
    } finally {
      setSearchLoading(false)
    }
  }, [searchQuery, searchRepo])

  return (
    <div className="agent-fleet-panel" data-testid="docs-panel">
      <div className="panel-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" style={{ marginRight: '0.5rem' }}>
            <path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
            <path d="M14 4v5h5" />
          </svg>
          Docs
        </h3>
        <div className="header-status">
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
            {repos.length + statusDocs.length} doc{repos.length + statusDocs.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Search */}
      <form onSubmit={runSearch} style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem 1rem' }}>
        <input
          data-testid="docs-search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search docs via RepoBrain..."
          className="qx-input qx-input--grow"
        />
        <select
          data-testid="docs-search-repo"
          value={searchRepo}
          onChange={(e) => setSearchRepo(e.target.value)}
          className="qx-select qx-select--auto"
        >
          <option value="quox-dashboard">quox-dashboard</option>
          {repos.filter((r) => r.repo !== 'quox-dashboard').map((r) => (
            <option key={r.repo} value={r.repo}>{r.repo}</option>
          ))}
        </select>
        <button data-testid="docs-search-submit" type="submit" className="qx-pill qx-pill--sm qx-pill--info" style={{ cursor: 'pointer' }}>
          Search
        </button>
      </form>

      {searchLoading && (
        <div className="qx-hint docs-panel__msg" data-testid="docs-search-loading">
          Searching RepoBrain…
        </div>
      )}
      {!searchLoading && searchError && (
        <div className="error-banner" data-testid="docs-search-error">
          <span>Search failed: {searchError}</span>
        </div>
      )}
      {!searchLoading && !searchError && searchResults && searchResults.length === 0 && (
        <div className="qx-hint docs-panel__msg" data-testid="docs-search-empty">
          No results.
        </div>
      )}
      {!searchLoading && !searchError && searchResults && searchResults.length > 0 && (
        <ul data-testid="docs-search-results" style={{ listStyle: 'none', margin: 0, padding: '0 1rem 0.5rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {searchResults.map((snippet, idx) => (
            <li key={`${snippet.path}-${idx}`} data-testid="docs-search-result" style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.75)' }}>
              <code>{snippet.path}</code>{snippet.start_line ? `:${snippet.start_line}-${snippet.end_line}` : ''}
              {snippet.reason && <span style={{ color: 'rgba(255,255,255,0.4)' }}> ({snippet.reason})</span>}
            </li>
          ))}
        </ul>
      )}

      {/* Lists */}
      {listsLoading && (
        <div className="qx-hint docs-panel__msg" data-testid="docs-lists-loading">
          Loading docs…
        </div>
      )}

      {!listsLoading && listsError && (
        <div className="error-banner" data-testid="docs-lists-error">
          <span>Docs fetch failed: {listsError}</span>
        </div>
      )}

      {!listsLoading && !listsError && repos.length === 0 && statusDocs.length === 0 && (
        <div className="qx-hint docs-panel__msg" data-testid="docs-empty">
          No docs found.
        </div>
      )}

      {!listsLoading && !listsError && (repos.length > 0 || statusDocs.length > 0) && (
        <div style={{ display: 'flex', gap: '1rem', padding: '0 1rem 1rem', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px', minWidth: 200 }}>
            <div className="qx-section-title">
              Repo maps
            </div>
            <ul data-testid="docs-repo-picker" className="docs-panel__list">
              {repos.map((r) => (
                <li key={r.repo}>
                  <button
                    type="button"
                    data-testid={`docs-repo-item-${r.repo}`}
                    onClick={() => openDoc('repo', r.repo)}
                    style={{
                      width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem',
                      background: selected && selected.kind === 'repo' && selected.id === r.repo ? 'rgba(56,189,248,0.12)' : 'transparent',
                      border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', padding: '0.35rem 0.5rem', cursor: 'pointer', fontSize: '0.78rem',
                    }}
                  >
                    <span>{r.repo}</span>
                    <StaleBadge stale={r.stale} />
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div style={{ flex: '1 1 220px', minWidth: 200 }}>
            <div className="qx-section-title">
              Status &amp; limits
            </div>
            {maturityRollup && (
              <div data-testid="docs-maturity-rollup" style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.55)', marginBottom: '0.35rem' }}>
                {formatRollup(maturityRollup)}
              </div>
            )}
            <ul data-testid="docs-status-picker" className="docs-panel__list">
              {statusDocs.map((d) => (
                <li key={d.name}>
                  <button
                    type="button"
                    data-testid={`docs-status-item-${d.name}`}
                    onClick={() => openDoc('status', d.name)}
                    style={{
                      width: '100%', textAlign: 'left',
                      background: selected && selected.kind === 'status' && selected.id === d.name ? 'rgba(56,189,248,0.12)' : 'transparent',
                      border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', padding: '0.35rem 0.5rem', cursor: 'pointer', fontSize: '0.78rem',
                    }}
                  >
                    {d.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Doc content */}
      {selected && (
        <div style={{ padding: '0 1rem 1rem', borderTop: '1px solid rgba(255,255,255,0.08)' }} data-testid="docs-content-pane">
          {docLoading && (
            <div style={{ padding: '1rem 0', color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }} data-testid="docs-content-loading">
              Loading {selected.id}…
            </div>
          )}
          {!docLoading && docError && (
            <div className="error-banner" data-testid="docs-content-error">
              <span>Failed to load {selected.id}: {docError}</span>
            </div>
          )}
          {!docLoading && !docError && docContent !== null && (
            <div data-testid="docs-content">
              {selected.kind === 'repo' && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <StaleBadge stale={docStale} />
                </div>
              )}

              {selected.kind === 'status' && docMaturity.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
                    <button
                      type="button"
                      data-testid="docs-maturity-view-table"
                      onClick={() => setDocViewMode('table')}
                      className={`qx-pill qx-pill--sm ${docViewMode === 'table' ? 'qx-pill--info' : 'qx-pill--ghost'}`}
                      style={{ cursor: 'pointer' }}
                    >
                      Table
                    </button>
                    <button
                      type="button"
                      data-testid="docs-maturity-view-raw"
                      onClick={() => setDocViewMode('raw')}
                      className={`qx-pill qx-pill--sm ${docViewMode === 'raw' ? 'qx-pill--info' : 'qx-pill--ghost'}`}
                      style={{ cursor: 'pointer' }}
                    >
                      Raw
                    </button>
                  </div>

                  {docViewMode === 'table' && (
                    <table data-testid="docs-maturity-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                      <thead>
                        <tr style={{ textAlign: 'left', color: 'rgba(255,255,255,0.5)', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
                          <th style={{ padding: '0.35rem 0.5rem' }}>Capability</th>
                          <th style={{ padding: '0.35rem 0.5rem' }}>Tag</th>
                          {docMaturity.some((r) => r.evidence) && <th style={{ padding: '0.35rem 0.5rem' }}>Evidence</th>}
                          <th style={{ padding: '0.35rem 0.5rem' }}>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {docMaturity.map((row, idx) => (
                          <tr key={idx} data-testid="docs-maturity-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', verticalAlign: 'top' }}>
                            <td style={{ padding: '0.35rem 0.5rem' }}>{row.capability}</td>
                            <td style={{ padding: '0.35rem 0.5rem' }}><MaturityBadge tag={row.tag} canonicalTag={row.canonical_tag} /></td>
                            {docMaturity.some((r) => r.evidence) && (
                              <td style={{ padding: '0.35rem 0.5rem', color: 'rgba(255,255,255,0.6)' }}>{row.evidence}</td>
                            )}
                            <td style={{ padding: '0.35rem 0.5rem', color: 'rgba(255,255,255,0.6)' }}>{row.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {selected.kind === 'status' && docMaturity.length === 0 && (
                <div data-testid="docs-maturity-none" style={{ marginBottom: '0.5rem', color: 'rgba(255,255,255,0.4)', fontSize: '0.78rem' }}>
                  No structured maturity table found, showing raw markdown.
                </div>
              )}

              {(selected.kind === 'repo' || docMaturity.length === 0 || docViewMode === 'raw') && (
                <MarkdownContent compact>{docContent}</MarkdownContent>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

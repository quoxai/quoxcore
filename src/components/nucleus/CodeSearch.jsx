/**
 * RepoBrain Code Search: full-page code search for the codebase.
 *
 * Stream QN Phase QN-4. Wave 2: cross-repo scope picker, snippet
 * line-number gutter, keyboard navigation over results, example-query
 * chips on the pre-search empty state.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import DOMPurify from 'dompurify'
import { queryCodebase, queryCrossRepo } from '../../services/nucleusClient'
import { useRepoBrainStatus } from './RepoBrainContext'

// ── Syntax highlighting (no external deps) ──────────────────────────

const KEYWORD_RE = /\b(export|import|from|function|const|let|var|class|return|if|else|async|await|new|this|throw|try|catch|typeof|default|switch|case|break|continue|for|while|do)\b/g
const STRING_RE = /('[^']*'|"[^"]*"|`[^`]*`)/g
const COMMENT_RE = /(\/\/.*$)/gm
const NUMBER_RE = /\b(\d+\.?\d*)\b/g

function highlightSyntax(code) {
  if (!code) return ''
  // Order matters: comments first (they contain other patterns), then strings, keywords, numbers
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  html = html.replace(COMMENT_RE, '<span class="syn-comment">$1</span>')
  html = html.replace(STRING_RE, '<span class="syn-string">$1</span>')
  html = html.replace(KEYWORD_RE, '<span class="syn-keyword">$1</span>')
  html = html.replace(NUMBER_RE, '<span class="syn-number">$1</span>')
  return html
}

function renderHighlightedCode(code) {
  return DOMPurify.sanitize(highlightSyntax(code))
}

// ── Snippet field helpers (shared by the card and the keyboard nav) ──

function snippetLocation(snippet) {
  const file = snippet.file || snippet.path || 'unknown'
  const startLine = snippet.line || snippet.start_line || snippet.lineNumber || ''
  const endLine = snippet.end_line || snippet.endLine || ''
  return endLine && endLine !== startLine
    ? `${file}:${startLine}-${endLine}`
    : startLine ? `${file}:${startLine}` : file
}

function snippetCode(snippet) {
  return snippet.content || snippet.snippet || snippet.text || ''
}

function snippetStartLine(snippet) {
  const n = Number(snippet.line || snippet.start_line || snippet.lineNumber)
  return Number.isFinite(n) && n > 0 ? n : 1
}

function snippetFile(snippet) {
  return snippet.file || snippet.path || ''
}

// ── Search Icon SVG ──────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

// ── Snippet Card ──────────────────────────────────────────────────────

function SnippetCard({ snippet, crossRepo, focused, cardRef }) {
  const [copied, setCopied] = useState(false)

  const location = snippetLocation(snippet)
  const code = snippetCode(snippet)
  const startLine = snippetStartLine(snippet)
  const reason = snippet.reason || snippet.note || null
  const score = snippet.score || snippet.relevance || null
  const repo = snippet.target_id || snippet.repo || null

  const copyLocation = useCallback(() => {
    navigator.clipboard.writeText(location).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [location])

  const copyCode = useCallback(() => {
    navigator.clipboard.writeText(code)
  }, [code])

  const lines = code ? code.split('\n') : []

  return (
    <div ref={cardRef} className={`qx-card qx-snippet${focused ? ' qx-snippet--focus' : ''}`}>
      <div className="qx-snippet__header">
        <span className="qx-snippet__loc" onClick={copyLocation} title="Copy path">
          <SearchIcon />
          {location}
          {crossRepo && repo && <span className="qx-pill qx-pill--purple qx-pill--xs">{repo}</span>}
        </span>
        <div className="qx-snippet__actions">
          <button className={`qx-btn qx-btn--ghost qx-btn--sm${copied ? ' qx-btn--success' : ''}`} onClick={copyLocation}>
            {copied ? 'Copied' : 'Path'}
          </button>
          <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={copyCode}>Code</button>
        </div>
      </div>
      {reason && <div className="qx-snippet__reason">{reason}</div>}
      {code && (
        <div style={{ display: 'flex' }}>
          <div className="qx-snippet__lines" aria-hidden="true">
            {lines.map((_, i) => (
              <div key={i}>{startLine + i}</div>
            ))}
          </div>
          <div
            className="qx-snippet__code"
            style={{ flex: 1 }}
            dangerouslySetInnerHTML={{ __html: renderHighlightedCode(code) }}
          />
        </div>
      )}
      {score != null && (
        <div className="qx-snippet__score">relevance: {typeof score === 'number' ? score.toFixed(2) : score}</div>
      )}
    </div>
  )
}

export const __testables = {
  highlightSyntax,
  renderHighlightedCode,
}

// ── Fallback target list ────────────────────────────────────────────────
// Intentionally EMPTY. The indexed-target list is authoritative and comes from
// the RepoBrain engine (useRepoBrainStatus -> getTargets). A hardcoded repo list
// here was a launch-estate defect on two counts: (1) it leaked the operator's own
// repo names (quox-dashboard/quoxflow/...) into every customer workspace; (2) it
// defaulted the search scope to a repo a given engine may not have indexed, so a
// fresh workspace's first query 404'd as "offline" instead of showing an honest
// "index a repo first" state. When the engine reports zero targets the component
// now renders the no-repos-indexed empty state; the default scope is derived from
// the first REAL indexed target.
const FALLBACK_TARGETS = []

function targetId(t) {
  return t.target_id || t.id || t.name
}

function targetFileCount(t) {
  return t.file_count || t.files || t.fileCount || 0
}

const EXAMPLE_QUERIES = [
  'where is AuthContext defined?',
  'what imports nucleusClient?',
  'how does chat dispatch flow?',
]

// ── Main Component ────────────────────────────────────────────────────

export default function CodeSearch() {
  const [query, setQuery] = useState('')
  // Scope: a Set of target_ids. Starts empty and is defaulted to the first REAL
  // indexed target once the engine reports its targets (see the scope-default
  // effect below), so the common case stays a single-repo queryCodebase() call
  // WITHOUT ever defaulting to a repo this engine may not have indexed.
  const [selectedTargets, setSelectedTargets] = useState(() => new Set())
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [timings, setTimings] = useState(null)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  // Shared with the rest of the RepoBrain surface via RepoBrainContext, so this
  // tab no longer runs its own getHealth()/getTargets() probe on mount.
  const { health, reason, targets, setLastQueryMs } = useRepoBrainStatus()
  const inputRef = useRef(null)
  const debounceRef = useRef(null)
  const scopeRef = useRef(null)
  const cardRefs = useRef([])
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  // Deep links from other tabs: Repos "Search this repo" passes ?repo=<targetId>
  // (scope search to it); Graph "Search this file" passes ?file=<path> (prefill
  // the query). Runs once on the incoming params so the user lands ready to search.
  const deepLinkDone = useRef(false)
  useEffect(() => {
    if (deepLinkDone.current) return
    const repo = searchParams.get('repo')
    const file = searchParams.get('file')
    if (!repo && !file) return
    if (repo) setSelectedTargets(new Set([repo]))
    if (file) setQuery(file)
    deepLinkDone.current = true
  }, [searchParams])

  // Default the search scope to the first REAL indexed target once the engine
  // reports its targets. Runs once. Respects a deliberate selection (a deep-link
  // repo, or a user pick) as long as every selected id is a real indexed target;
  // only a stale/absent selection (e.g. the pre-load empty set) is reset. This is
  // what removed the "default to quox-dashboard -> 404 on a fresh engine" bug.
  const scopeDefaulted = useRef(false)
  useEffect(() => {
    if (scopeDefaulted.current) return
    if (targets.length === 0) return
    scopeDefaulted.current = true
    const ids = targets.map(targetId)
    setSelectedTargets(prev => {
      const cur = [...prev]
      if (cur.length >= 1 && cur.every(id => ids.includes(id))) return prev
      return new Set([ids[0]])
    })
  }, [targets])

  const effectiveTargets = targets.length > 0 ? targets : FALLBACK_TARGETS
  const defaultTargetId = effectiveTargets[0] ? targetId(effectiveTargets[0]) : null
  const crossRepo = selectedTargets.size > 1

  const scopeLabel = selectedTargets.size === 0
    ? 'Select repos'
    : selectedTargets.size === 1
      ? [...selectedTargets][0]
      : selectedTargets.size === effectiveTargets.length
        ? 'All repos'
        : `${selectedTargets.size} repos`

  const toggleTarget = useCallback((id) => {
    setSelectedTargets(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        if (next.size > 1) next.delete(id) // never drop to zero repos selected
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const selectAllTargets = useCallback(() => {
    setSelectedTargets(new Set(effectiveTargets.map(targetId)))
  }, [effectiveTargets])

  const selectOnlyThisTarget = useCallback(() => {
    if (defaultTargetId) setSelectedTargets(new Set([defaultTargetId]))
  }, [defaultTargetId])

  // Close the scope popover on outside click.
  useEffect(() => {
    if (!scopeMenuOpen) return
    function handleClick(e) {
      if (scopeRef.current && !scopeRef.current.contains(e.target)) {
        setScopeMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [scopeMenuOpen])

  const doSearch = useCallback(async (q) => {
    if (!q || q.trim().length < 2) return
    setLoading(true)
    setError(null)

    const ids = [...selectedTargets]
    const result = ids.length > 1
      ? await queryCrossRepo(q, ids)
      : await queryCodebase(q, ids[0] || defaultTargetId)

    setLoading(false)
    setFocusedIndex(-1)

    if (result.error) {
      setError(result.error)
      setResults(null)
      setTimings(null)
    } else {
      setResults(result.snippets || [])
      setTimings(result.timings || null)
      setError(null)
      if (result.timings?.total_ms != null) setLastQueryMs(result.timings.total_ms)
    }
  }, [selectedTargets, setLastQueryMs, defaultTargetId])

  // Debounced search on input change
  const handleInputChange = useCallback((e) => {
    const val = e.target.value
    setQuery(val)
    clearTimeout(debounceRef.current)
    if (val.trim().length >= 3) {
      debounceRef.current = setTimeout(() => doSearch(val), 600)
    }
  }, [doSearch])

  // Enter forces immediate search
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      clearTimeout(debounceRef.current)
      doSearch(query)
    }
  }, [doSearch, query])

  const retry = useCallback(() => doSearch(query), [doSearch, query])

  const runExample = useCallback((q) => {
    setQuery(q)
    doSearch(q)
  }, [doSearch])

  // Scroll the keyboard-focused card into view.
  useEffect(() => {
    if (focusedIndex >= 0) {
      cardRefs.current[focusedIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex])

  // Keyboard shortcuts: "/" focus, Escape clear/close, j/k/Enter/c/g result nav.
  useEffect(() => {
    function handleKey(e) {
      const searchFocused = document.activeElement === inputRef.current

      if (e.key === '/' && !searchFocused) {
        e.preventDefault()
        inputRef.current?.focus()
        return
      }

      if (e.key === 'Escape') {
        if (scopeMenuOpen) {
          setScopeMenuOpen(false)
          return
        }
        setQuery('')
        setResults(null)
        setTimings(null)
        setFocusedIndex(-1)
        inputRef.current?.blur()
        return
      }

      // Result-list navigation is only active with results on screen and
      // the search input NOT focused (so typing "g"/"c" in the box is safe).
      if (searchFocused || !results || results.length === 0) return

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex(i => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        if (focusedIndex >= 0 && results[focusedIndex]) {
          navigator.clipboard.writeText(snippetLocation(results[focusedIndex]))
        }
      } else if (e.key === 'c') {
        if (focusedIndex >= 0 && results[focusedIndex]) {
          navigator.clipboard.writeText(snippetCode(results[focusedIndex]))
        }
      } else if (e.key === 'g') {
        if (focusedIndex >= 0 && results[focusedIndex]) {
          const file = snippetFile(results[focusedIndex])
          navigate(`/nucleus?tab=graph${file ? `&file=${encodeURIComponent(file)}` : ''}`)
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [results, focusedIndex, scopeMenuOpen, navigate])

  // Still probing (health === 'checking'), including retries through a cold-start.
  // Show a connecting state so a slow first load never flashes the search UI or a
  // premature "not connected" screen.
  if (health === 'checking') {
    return (
      <div className="qx-view">
        <div className="qx-empty">
          <div className="qx-spinner" aria-hidden="true" />
          <div className="qx-empty__title">Connecting to RepoBrain...</div>
          <div className="qx-empty__body">
            Checking the code intelligence engine for this workspace.
          </div>
        </div>
      </div>
    )
  }

  // Session has no resolved organisation context (401 from the collector's
  // nucleus proxy). The engine itself may be perfectly healthy: this is a
  // session/account issue, not a downed engine, so the copy must not say offline.
  if (health === 'unauthorized') {
    return (
      <div className="qx-view">
        <div className="qx-empty">
          <div className="qx-empty__title">Code Search needs organisation context</div>
          <div className="qx-empty__body">
            {reason || 'Organisation context required for RepoBrain.'}
          </div>
          <div className="qx-empty__body">
            The RepoBrain engine itself may be reachable. This is a session issue,
            not a downed engine. Try reloading the page or signing out and back in.
            If it keeps happening, contact your workspace admin.
          </div>
        </div>
      </div>
    )
  }

  // RepoBrain isn't licensed for this org (403 from the collector's nucleus
  // proxy). Again, the engine may be fine: this is a licensing gate.
  if (health === 'unlicensed') {
    return (
      <div className="qx-view">
        <div className="qx-empty">
          <div className="qx-empty__title">Code Search isn't licensed for this workspace</div>
          <div className="qx-empty__body">
            {reason || 'RepoBrain is not licensed for this organisation.'}
          </div>
          <div className="qx-empty__body">
            The RepoBrain engine itself may be reachable. This is a licensing
            gate, not a downed engine. Ask your workspace admin to enable the
            RepoBrain plugin for this organisation.
          </div>
        </div>
      </div>
    )
  }

  // Not-connected state: no RepoBrain engine is reachable for this workspace yet.
  if (health === 'offline') {
    return (
      <div className="qx-view">
        <div className="qx-empty">
          <div className="qx-empty__title">Code Search isn't connected yet</div>
          <div className="qx-empty__body">
            Code Search answers questions about your codebase with exact file and
            line citations. It reads from a RepoBrain engine, and there isn't one
            connected to this workspace right now.
          </div>
          <div className="qx-empty__body">
            If you manage this workspace, connect a RepoBrain engine and index a
            repository to get started. If not, your workspace admin can turn it on.
          </div>
        </div>
      </div>
    )
  }

  // Engine is reachable (health is not checking/unauthorized/unlicensed/offline)
  // but reports ZERO indexed targets. health and targets are set together in one
  // probe (RepoBrainContext), so this is a true "connected, nothing indexed yet"
  // state, not a load flicker. Show honest onboarding guidance instead of falling
  // through to the search UI, which would default the scope to a phantom repo and
  // 404 the first query.
  if (targets.length === 0) {
    return (
      <div className="qx-view">
        <div className="qx-empty">
          <div className="qx-empty__title">No repositories indexed yet</div>
          <div className="qx-empty__body">
            Code Search answers questions about your codebase with exact file and
            line citations. The RepoBrain engine is connected, but it hasn't
            indexed any repositories for this workspace yet.
          </div>
          <div className="qx-empty__body">
            Index a repository to start searching. If you manage this workspace,
            add a repository to the RepoBrain engine; otherwise your workspace
            admin can index one for you.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="qx-view qx-stack">
      {/* Search Bar */}
      <div className="qx-card qx-card--bar qx-row">
        <div className="qx-search-wrap">
          <span className="qx-search-wrap__icon"><SearchIcon /></span>
          <input
            ref={inputRef}
            className="glass-input"
            type="text"
            placeholder='Search codebase... (e.g. "where is AuthContext defined?")'
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
          />
        </div>

        {/* Cross-repo scope picker: a trigger chip that opens a checklist popover. */}
        <div ref={scopeRef} style={{ position: 'relative' }}>
          <button
            type="button"
            className={`qx-chip${crossRepo ? ' qx-chip--active' : ''}`}
            onClick={() => setScopeMenuOpen(v => !v)}
            aria-haspopup="true"
            aria-expanded={scopeMenuOpen}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            {scopeLabel}
          </button>
          {scopeMenuOpen && (
            <div
              className="qx-menu"
              style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 260, maxHeight: 340, overflowY: 'auto', zIndex: 20 }}
            >
              <div className="qx-menu__header">Search scope</div>
              <button type="button" className="qx-menu__item" onClick={selectAllTargets}>All repos</button>
              <button type="button" className="qx-menu__item" onClick={selectOnlyThisTarget}>Only this workspace</button>
              <div className="qx-menu__sep" />
              {effectiveTargets.map(t => {
                const id = targetId(t)
                const files = targetFileCount(t)
                return (
                  <label key={id} className="qx-menu__item qx-menu__item--check">
                    <input
                      type="checkbox"
                      checked={selectedTargets.has(id)}
                      onChange={() => toggleTarget(id)}
                    />
                    <span className="qx-checkbox__box" />
                    <span>{id}</span>
                    {files > 0 && <span className="qx-menu__meta">{files.toLocaleString()} files</span>}
                  </label>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      {(results || loading) && (
        <div className="qx-card qx-card--bar qx-row--apart">
          <span className="qx-hint qx-hint--sm">
            {loading ? 'Searching...' : `${results?.length || 0} results`}
            {!crossRepo && ` in ${[...selectedTargets][0] || defaultTargetId}`}
          </span>
          {timings?.total_ms && (
            <span className="qx-pill qx-pill--info qx-pill--xs">{timings.total_ms}ms</span>
          )}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-skeleton qx-skeleton--block" />
          <div className="qx-skeleton qx-skeleton--block" />
          <div className="qx-skeleton qx-skeleton--block" />
        </div>
      )}

      {/* Error State — title reflects the CAUSE. A fresh org querying a repo it hasn't indexed
          gets a 404; showing "RepoBrain Offline" there misleads the user into restarting a healthy
          engine (first-run audit 3.1). Distinguish not-indexed / timeout / genuinely-offline. */}
      {error && !loading && (() => {
        const e = String(error)
        const notIndexed = /404|not[\s-]*found|unknown target|no such target|not indexed/i.test(e)
        const timedOut = /timed out|timeout/i.test(e)
        const title = notIndexed ? 'No repository indexed' : timedOut ? 'RepoBrain timed out' : 'RepoBrain Offline'
        const body = notIndexed
          ? 'This repository is not indexed yet. Add one in the Repos tab, then run your query.'
          : e
        return (
          <div className="qx-banner qx-banner--error">
            <div>
              <span className="qx-banner__title">{title}</span>
              {body}
            </div>
            <div className="qx-banner__actions">
              <button className="qx-btn qx-btn--sm" onClick={retry}>Retry</button>
            </div>
          </div>
        )
      })()}

      {/* Results */}
      {results && !loading && !error && results.length > 0 && (
        <>
          <div className="qx-pad qx-stack">
            {results.map((snippet, i) => (
              <SnippetCard
                key={i}
                snippet={snippet}
                crossRepo={crossRepo}
                focused={i === focusedIndex}
                cardRef={el => { cardRefs.current[i] = el }}
              />
            ))}
          </div>
          <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="qx-hint qx-hint--sm"><span className="qx-kbd">j</span>/<span className="qx-kbd">k</span> move</span>
            <span className="qx-hint qx-hint--sm"><span className="qx-kbd">Enter</span> copy path</span>
            <span className="qx-hint qx-hint--sm"><span className="qx-kbd">c</span> copy code</span>
            <span className="qx-hint qx-hint--sm"><span className="qx-kbd">g</span> open in graph</span>
            <span className="qx-hint qx-hint--sm"><span className="qx-kbd">/</span> focus search</span>
          </div>
        </>
      )}

      {/* Empty Results */}
      {results && !loading && !error && results.length === 0 && (
        <div className="qx-empty">
          <div className="qx-empty__icon">&#x2205;</div>
          <div className="qx-empty__title">No results found</div>
          <div className="qx-empty__body">
            Try rephrasing your question or searching a different repo.
          </div>
        </div>
      )}

      {/* Initial Empty State */}
      {!results && !loading && !error && (
        <div className="qx-empty">
          <div className="qx-empty__icon">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M12 2a8 8 0 0 1 8 8c0 3.37-2.08 6.26-5.02 7.45L12 22l-2.98-4.55A8.001 8.001 0 0 1 12 2z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          </div>
          <div className="qx-empty__title">RepoBrain Code Search</div>
          <div className="qx-empty__body">
            Ask questions about the codebase in natural language. Press <span className="qx-kbd">/</span> to focus, <span className="qx-kbd">Enter</span> to search.
          </div>
          <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
            {EXAMPLE_QUERIES.map(q => (
              <button key={q} type="button" className="qx-chip" onClick={() => runExample(q)}>
                {q}
              </button>
            ))}
          </div>
          {targets.length > 0 && (
            <div className="qx-grid-3">
              {targets.map(t => {
                const id = targetId(t)
                const files = targetFileCount(t)
                return (
                  <div key={id} className="qx-host-row">
                    <span className="qx-dot qx-dot--online qx-host-row__dot" />
                    <div className="qx-host-row__body">
                      <span className="qx-host-row__primary">{id}</span>
                    </div>
                    {files > 0 && <span className="qx-host-row__meta">{files.toLocaleString()} files</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

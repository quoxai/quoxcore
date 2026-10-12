/**
 * CrystalsLibraryView — STUDY-REV W4 / P1.G rename
 *
 * Surface for the W2-persisted Crystal Library. Lists crystallised workflows
 * (latest version per source workflow), with search + tag filter + attach-to
 * action. The user-visible answer to "what did I just build that I can reuse?"
 *
 * Composes only global qx-* classes per glass-design-system. No bespoke CSS.
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listCrystals, listCrystalVersions, rollbackCrystal, getQuoxSkillsWithStatus } from '../../services/quoxflowClient'
import { runCrystal } from '../../services/crystalRunner'
import { useAuth } from '../../contexts/AuthContext'
import EvolutionStagePill from '../../components/automation/EvolutionStagePill'

function formatPercent(value) {
  if (value == null || isNaN(value)) return '—'
  return `${Math.round(value * 100)}%`
}

function formatDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString() } catch { return '—' }
}

/** Returns true when the originating skill is in a decay state. */
function isSkillInDecay(status) {
  if (!status) return false
  return status.edition !== 'stable' || status.decayState === 'archive_candidate' || status.decayState === 'archived'
}

function CrystalCard({ crystal, onAttach, onRun, onAfterRollback, sourceSkillStatus }) {
  const tags = Array.isArray(crystal.tags) ? crystal.tags : []
  const [historyOpen, setHistoryOpen] = useState(false)
  const [versions, setVersions] = useState(null)
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsError, setVersionsError] = useState(null)
  const [rollingBack, setRollingBack] = useState(null) // version number being rolled back
  const [feedback, setFeedback] = useState(null) // { type, text }
  const [running, setRunning] = useState(false)

  const toggleHistory = async () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next && versions === null) {
      setVersionsLoading(true)
      try {
        const rows = await listCrystalVersions(crystal.sourceWorkflowId)
        setVersions(Array.isArray(rows) ? rows : [])
        setVersionsError(null)
      } catch (err) {
        setVersionsError(err?.message || 'Failed to load versions')
      } finally {
        setVersionsLoading(false)
      }
    }
  }

  const handleRollback = async (targetVersion) => {
    setRollingBack(targetVersion)
    setFeedback(null)
    try {
      const result = await rollbackCrystal({ sourceWorkflowId: crystal.sourceWorkflowId, targetVersion })
      if (result.created) {
        setFeedback({ type: 'success', text: `Rolled back to v${targetVersion}; new latest is v${result.skill?.version}.` })
      } else {
        setFeedback({ type: 'info', text: `Already at v${targetVersion} — no rollback needed.` })
      }
      // Refresh versions list and the parent's crystals list.
      const rows = await listCrystalVersions(crystal.sourceWorkflowId)
      setVersions(Array.isArray(rows) ? rows : [])
      onAfterRollback?.()
    } catch (err) {
      setFeedback({ type: 'error', text: err?.message || 'Rollback failed' })
    } finally {
      setRollingBack(null)
    }
  }

  const handleRun = async () => {
    setRunning(true)
    setFeedback(null)
    try {
      await onRun?.(crystal)
    } catch (err) {
      setFeedback({ type: 'error', text: err?.message || 'Run failed' })
    } finally {
      setRunning(false)
    }
  }

  const latestVersion = versions && versions.length > 0
    ? versions[versions.length - 1].version
    : crystal.version

  return (
    <article className="qx-card qx-card--compact">
      <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="qx-stack" style={{ gap: 6 }}>
          <h3 style={{ margin: 0 }}>{crystal.name || crystal.sourceWorkflowId}</h3>
          <div className="qx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="qx-pill">v{crystal.version}</span>
            <span className="qx-pill">{formatPercent(crystal.confidence)} confidence</span>
            <span className="qx-pill">{crystal.executionCount ?? 0} runs</span>
            <span className="qx-pill">{formatPercent(crystal.successRate)} success</span>
          </div>
        </div>
        <div className="qx-row" style={{ gap: 6 }}>
          <button
            type="button"
            className="qx-btn qx-btn--sm"
            onClick={toggleHistory}
            aria-expanded={historyOpen}
          >
            {historyOpen ? 'Hide history' : 'Versions'}
          </button>
          <button
            type="button"
            className="qx-btn qx-btn--primary qx-btn--sm"
            onClick={handleRun}
            disabled={running}
            aria-label="Run now"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 5, pointerEvents: 'none' }}
            >
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            {running ? 'Running…' : 'Run now'}
          </button>
          <button
            type="button"
            className="qx-btn qx-btn--primary qx-btn--sm"
            onClick={() => onAttach?.(crystal)}
          >
            Attach Crystal to objective
          </button>
        </div>
      </header>

      {tags.length > 0 && (
        <div className="qx-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {tags.map(tag => (
            <span key={tag} className="qx-chip">{tag}</span>
          ))}
        </div>
      )}

      {isSkillInDecay(sourceSkillStatus) && (
        <div
          className="qx-banner"
          style={{
            marginTop: 10,
            background: 'rgba(245,158,11,0.12)',
            borderColor: 'rgba(245,158,11,0.4)',
            color: '#f59e0b',
          }}
          role="alert"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6, flexShrink: 0 }}
          >
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Originating skill in decay
        </div>
      )}

      {feedback && (
        <div
          className={`qx-banner${feedback.type === 'error' ? ' qx-banner--danger' : feedback.type === 'success' ? ' qx-banner--success' : ''}`}
          style={{ marginTop: 12 }}
        >
          {feedback.text}
        </div>
      )}

      {historyOpen && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--m-border-default)' }}>
          {versionsLoading && (
            <div className="qx-row" style={{ justifyContent: 'center', padding: 12 }}>
              <span className="qx-spinner" />
            </div>
          )}
          {versionsError && !versionsLoading && (
            <div className="qx-banner qx-banner--danger">{versionsError}</div>
          )}
          {!versionsLoading && !versionsError && versions && versions.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {versions.slice().reverse().map(v => {
                const isLatest = v.version === latestVersion
                const isRollback = Array.isArray(v.tags) && v.tags.includes('rolled-back')
                return (
                  <li
                    key={v.id}
                    className="qx-row"
                    style={{ justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 8 }}
                  >
                    <div className="qx-stack" style={{ gap: 4 }}>
                      <div className="qx-row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className="qx-pill">v{v.version}</span>
                        {isLatest && <span className="qx-pill" style={{ borderColor: 'rgba(56,189,248,0.4)' }}>latest</span>}
                        {isRollback && <span className="qx-pill" style={{ borderColor: 'rgba(245,158,11,0.4)' }}>rolled back</span>}
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
                          {formatPercent(v.confidence)} · {v.executionCount} runs · {formatPercent(v.successRate)} success
                        </span>
                      </div>
                      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{formatDate(v.createdAt)}</span>
                    </div>
                    {!isLatest && (
                      <button
                        type="button"
                        className="qx-btn qx-btn--sm"
                        disabled={rollingBack === v.version}
                        onClick={() => {
                          if (window.confirm(`Roll back ${crystal.name || crystal.sourceWorkflowId} to v${v.version}?\n\nThis writes a new version (v${latestVersion + 1}) that copies v${v.version}'s content. The history is preserved.`)) {
                            handleRollback(v.version)
                          }
                        }}
                      >
                        {rollingBack === v.version ? 'Rolling back…' : `Roll back to v${v.version}`}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {!versionsLoading && !versionsError && versions && versions.length === 0 && (
            <div className="qx-empty"><p>No version history available.</p></div>
          )}
        </div>
      )}

      <footer className="qx-row" style={{ justifyContent: 'space-between', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
          From <code className="qx-code">{crystal.sourceWorkflowId}</code>
          {(() => {
            // Task-time crystals encode the owning agent in source_workflow_id:
            // "task-time::<agentId>::<orgId>::<actionPattern>". Surface a link
            // back to the agent so the user can jump from Crystal → owner.
            const swid = crystal.sourceWorkflowId || ''
            if (!swid.startsWith('task-time::')) return null
            const parts = swid.split('::')
            const agentId = parts[1]
            if (!agentId) return null
            return (
              <>
                {' · earned by '}
                <Link to={`/agents/${encodeURIComponent(agentId)}`} className="qx-link">
                  {agentId}
                </Link>
              </>
            )
          })()}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
          {formatDate(crystal.createdAt)}
        </span>
      </footer>
    </article>
  )
}

export default function CrystalsLibraryView() {
  const navigate = useNavigate()
  const { authFetch } = useAuth()
  const [crystals, setCrystals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState(null)

  const [refreshTick, setRefreshTick] = useState(0)
  // QSKL-11a: Map<skillId, {edition, decayState}> for decay-warning badges
  const [skillStatusMap, setSkillStatusMap] = useState(new Map())
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listCrystals()
      .then(rows => { if (!cancelled) { setCrystals(Array.isArray(rows) ? rows : []); setError(null) } })
      .catch(err => { if (!cancelled) setError(err?.message || 'Failed to load Crystals') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshTick])

  // QSKL-11a: When the crystal list changes, fetch skill statuses for decay badges.
  useEffect(() => {
    if (!crystals.length) {
      setSkillStatusMap(new Map())
      return
    }
    const skillIds = [...new Set(
      crystals
        .map(c => c.metadata?.source_skill_id)
        .filter(Boolean)
    )]
    if (!skillIds.length) {
      setSkillStatusMap(new Map())
      return
    }
    let cancelled = false
    getQuoxSkillsWithStatus(skillIds)
      .then(rows => {
        if (cancelled) return
        const map = new Map(rows.map(r => [r.id, r]))
        setSkillStatusMap(map)
      })
      .catch(() => {
        // Non-critical: decay badges simply won't show on fetch failure
      })
    return () => { cancelled = true }
  }, [crystals])

  // Bumped after a rollback so the parent crystal list (latest-only) reflects
  // the new latest version that the rollback wrote.
  const handleAfterRollback = () => setRefreshTick(t => t + 1)

  const allTags = useMemo(() => {
    const set = new Set()
    crystals.forEach(c => (c.tags || []).forEach(t => set.add(t)))
    return Array.from(set).sort()
  }, [crystals])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return crystals.filter(c => {
      if (activeTag && !(c.tags || []).includes(activeTag)) return false
      if (!q) return true
      return (
        (c.name || '').toLowerCase().includes(q) ||
        (c.sourceWorkflowId || '').toLowerCase().includes(q) ||
        (c.tags || []).some(t => t.toLowerCase().includes(q))
      )
    })
  }, [crystals, search, activeTag])

  const handleAttach = (crystal) => {
    navigate(`/objectives?attach=${encodeURIComponent(crystal.id)}&source=${encodeURIComponent(crystal.sourceWorkflowId)}`)
  }

  const handleRun = async (crystal) => {
    const { executionId } = await runCrystal({
      authFetch,
      crystalId: crystal.id,
      sourceWorkflowId: crystal.sourceWorkflowId,
    })
    navigate(`/executions/${executionId}`)
  }

  return (
    <div className="qx-view">
      <div className="qx-stack">
        <section className="qx-card">
          <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="qx-stack" style={{ gap: 4 }}>
              <h2 style={{ margin: 0 }}>Crystals Library</h2>
              <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)' }}>
                Crystallised workflows ready to attach to new objectives.
              </p>
              <EvolutionStagePill currentStage="crystal" style={{ marginTop: 8 }} />
            </div>
            <span className="qx-badge">{crystals.length} Crystal{crystals.length === 1 ? '' : 's'}</span>
          </header>
        </section>

        <section className="qx-card">
          <div className="qx-row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="search"
              className="qx-input"
              placeholder="Search by name, source workflow, or tag…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 240 }}
            />
            {allTags.length > 0 && (
              <div className="qx-row" style={{ gap: 6, flexWrap: 'nowrap', overflowX: 'auto' }}>
                <button
                  type="button"
                  className={`qx-chip${activeTag === null ? ' qx-chip--active' : ''}`}
                  onClick={() => setActiveTag(null)}
                >
                  All
                </button>
                {allTags.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className={`qx-chip${activeTag === tag ? ' qx-chip--active' : ''}`}
                    onClick={() => setActiveTag(tag === activeTag ? null : tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {loading && (
          <section className="qx-card">
            <div className="qx-row" style={{ justifyContent: 'center', padding: 24 }}>
              <span className="qx-spinner" />
            </div>
          </section>
        )}

        {error && !loading && (
          <section className="qx-card">
            <div className="qx-banner qx-banner--danger">
              <strong>Couldn't load Crystals.</strong> {error}
            </div>
          </section>
        )}

        {!loading && !error && filtered.length === 0 && (
          <section className="qx-card">
            <div className="qx-empty">
              <h3>{crystals.length === 0 ? 'No Crystals yet' : 'Nothing matches'}</h3>
              <p>
                {crystals.length === 0
                  ? 'Run a workflow successfully 3+ times, then click "Package as Crystal" on the execution detail page.'
                  : 'Try clearing the search or tag filter.'}
              </p>
            </div>
          </section>
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="qx-stack">
            {filtered.map(crystal => (
              <CrystalCard
                key={crystal.id}
                crystal={crystal}
                onAttach={handleAttach}
                onRun={handleRun}
                onAfterRollback={handleAfterRollback}
                sourceSkillStatus={skillStatusMap.get(crystal.metadata?.source_skill_id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * SkillsView — QSKL-1
 *
 * Dashboard surface for the QuoxSkills procedural-knowledge layer.
 * Displays /api/quox-skills records with list, detail, and create flows.
 *
 * Composes only global qx-* classes per glass-design-system. No bespoke CSS.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  listQuoxSkills,
  listSkillScoreboards,
  createQuoxSkill,
  getQuoxSkillById,
  listSkillPatches,
  revertSkill,
  runQuoxSkillTests,
  archiveQuoxSkill,
} from '../../services/quoxflowClient'
import { useAuth } from '../../contexts/AuthContext'
import SkillSparkline from '../../components/skills/SkillSparkline'
import SkillScoreBadges from '../../components/skills/SkillScoreBadges'
import SkillCoverageBar from '../../components/skills/SkillCoverageBar'
import SkillReviewBadge from '../../components/skills/SkillReviewBadge'
import { shortLicenceLabel } from '../../lib/skillRightsLabels'

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  'ops/health',
  'security',
  'github',
  'compliance',
  'infra',
  'data',
  'communication',
  'workflow',
  'browser/automation',
  'memory/operations',
  'voice/operations',
  'observability/trace',
  'other',
]

const EDITIONS = ['experimental', 'beta', 'stable', 'deprecated']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString() } catch { return '—' }
}

function formatDateTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch { return '—' }
}

/**
 * Simple line-by-line diff. Returns an array of { type: 'same'|'removed'|'added', text }.
 * No external library — plain split+compare.
 */
function lineDiff(oldText, newText) {
  const oldLines = (oldText || '').split('\n')
  const newLines = (newText || '').split('\n')
  const result = []
  const maxLen = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i]
    const n = newLines[i]
    if (o === undefined) {
      result.push({ type: 'added', text: n })
    } else if (n === undefined) {
      result.push({ type: 'removed', text: o })
    } else if (o === n) {
      result.push({ type: 'same', text: o })
    } else {
      result.push({ type: 'removed', text: o })
      result.push({ type: 'added', text: n })
    }
  }
  return result
}

function parseTags(str) {
  return str
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
}

/**
 * QSKL-11a: Format an ISO timestamp as a human-relative string.
 * e.g. "3d ago", "12d ago", "2mo ago", "just now"
 */
function formatRelative(iso) {
  if (!iso) return null
  try {
    const diffMs = Date.now() - new Date(iso).getTime()
    if (diffMs < 0) return formatDate(iso)
    const diffMin = Math.floor(diffMs / 60_000)
    if (diffMin < 2) return 'just now'
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    const diffDay = Math.floor(diffHr / 24)
    if (diffDay < 60) return `${diffDay}d ago`
    const diffMo = Math.floor(diffDay / 30)
    return `${diffMo}mo ago`
  } catch { return '—' }
}

// ─── DiffModal ────────────────────────────────────────────────────────────────

function DiffModal({ fromVersion, toVersion, fromBody, toBody, onClose }) {
  const diff = useMemo(() => lineDiff(fromBody, toBody), [fromBody, toBody])
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Diff: v${fromVersion} → current`}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="qx-card" style={{ width: '100%', maxWidth: 780, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>Diff</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
              v{fromVersion} → current (v{toVersion})
            </p>
          </div>
          <button type="button" className="qx-btn qx-btn--sm" onClick={onClose} aria-label="Close diff">
            Close
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <pre style={{
            margin: 0, padding: 0, fontFamily: 'monospace', fontSize: 12,
            lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {diff.map((line, i) => {
              let bg = 'transparent'
              let color = 'rgba(255,255,255,0.75)'
              let prefix = '  '
              if (line.type === 'removed') { bg = 'rgba(239,68,68,0.15)'; color = 'rgba(252,165,165,1)'; prefix = '- ' }
              if (line.type === 'added')   { bg = 'rgba(34,197,94,0.15)'; color = 'rgba(134,239,172,1)'; prefix = '+ ' }
              return (
                <span key={i} style={{ display: 'block', background: bg, color, padding: '0 8px' }}>
                  {prefix}{line.text}
                </span>
              )
            })}
          </pre>
        </div>
      </div>
    </div>
  )
}

// ─── RevertConfirmModal ────────────────────────────────────────────────────────

function RevertConfirmModal({ skillName, targetVersion, onConfirm, onCancel, loading, error }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm revert"
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div className="qx-card" style={{ width: '100%', maxWidth: 460 }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: 15 }}>Confirm revert</h3>
        <p style={{ margin: '0 0 16px 0', color: 'rgba(255,255,255,0.8)', fontSize: 14 }}>
          Revert <strong>"{skillName}"</strong> to <strong>v{targetVersion}</strong>?
          This will run Crystal-eval safety net before promoting the older body.
        </p>
        {error && (
          <div className="qx-banner qx-banner--danger" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}
        <div className="qx-row" style={{ gap: 12, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="qx-btn qx-btn--sm"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="qx-btn qx-btn--primary qx-btn--sm"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading
              ? 'Reverting…'
              : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 5, pointerEvents: 'none' }}>
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74" />
                    <path d="M3 3v5h5" />
                  </svg>
                  Revert
                </>
              )
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── SkillVersionHistory ───────────────────────────────────────────────────────

function SkillVersionHistory({ skill, onReverted }) {
  const [patches, setPatches] = useState([])
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(null)

  // Diff modal state
  const [diffTarget, setDiffTarget] = useState(null) // { version, bodyMd }

  // Revert state
  const [revertTarget, setRevertTarget] = useState(null) // { version }
  const [reverting, setReverting] = useState(false)
  const [revertError, setRevertError] = useState(null)

  const loadPatches = useCallback(() => {
    if (!skill?.id) return
    setLoading(true)
    setFetchError(null)
    listSkillPatches(skill.id)
      .then(data => {
        setPatches(Array.isArray(data?.patches) ? data.patches : [])
        setVersions(Array.isArray(data?.versions) ? data.versions : [])
      })
      .catch(err => setFetchError(err?.message || 'Failed to load patch history.'))
      .finally(() => setLoading(false))
  }, [skill?.id])

  useEffect(() => { loadPatches() }, [loadPatches])

  const handleRevertConfirm = async () => {
    if (!revertTarget) return
    setReverting(true)
    setRevertError(null)
    try {
      await revertSkill(skill.id, { toVersion: revertTarget.version, reason: 'manual revert via UI' })
      setRevertTarget(null)
      setReverting(false)
      loadPatches()
      if (onReverted) onReverted()
    } catch (err) {
      const msg = err?.message || 'Revert failed.'
      // Surface crystal failures clearly
      if (msg.includes('PATCH_CRYSTALS_REGRESSED') || msg.includes('Crystal')) {
        setRevertError('Crystal-eval safety net blocked this revert: ' + msg)
      } else if (msg.includes('INVALID_TARGET_VERSION')) {
        setRevertError('Invalid target version: ' + msg)
      } else {
        setRevertError(msg)
      }
      setReverting(false)
    }
  }

  // Build a lookup from version string → bodyMd (from versions list)
  const versionBodyMap = useMemo(() => {
    const map = {}
    versions.forEach(v => { map[v.version] = v.bodyMd })
    return map
  }, [versions])

  const currentVersion = skill?.version

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={{ margin: '0 0 12px 0', fontSize: 14, color: 'rgba(255,255,255,0.85)' }}>Version history</h4>

      {loading && (
        <div className="qx-row" style={{ justifyContent: 'center', padding: 16 }}>
          <span className="qx-spinner" />
        </div>
      )}

      {fetchError && !loading && (
        <div className="qx-banner qx-banner--danger">{fetchError}</div>
      )}

      {!loading && !fetchError && patches.length === 0 && (
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, margin: 0 }}>
          No patch history yet — this skill is at v{currentVersion}.
        </p>
      )}

      {!loading && !fetchError && patches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ overflowY: 'auto', maxHeight: 340 }}>
            {patches.map((patch, idx) => {
              const isCurrent = patch.toVersion === currentVersion && idx === 0
              const outcome = patch.outcome || patch.action // 'promoted' | 'reverted'
              return (
                <div
                  key={patch.id || idx}
                  className="qx-row"
                  style={{
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: 6,
                    marginBottom: 4,
                    background: isCurrent ? 'rgba(56,189,248,0.08)' : 'rgba(255,255,255,0.03)',
                    border: isCurrent ? '1px solid rgba(56,189,248,0.25)' : '1px solid rgba(255,255,255,0.07)',
                    flexWrap: 'wrap',
                  }}
                >
                  {/* Version label */}
                  <span style={{ fontWeight: 600, fontSize: 13, color: isCurrent ? 'rgba(56,189,248,0.9)' : 'rgba(255,255,255,0.85)', flexShrink: 0 }}>
                    v{patch.toVersion}
                  </span>

                  <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, flexShrink: 0 }}>·</span>

                  {/* Timestamp */}
                  <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12, flexShrink: 0 }}>
                    {formatDateTime(patch.createdAt)}
                  </span>

                  {patch.reason && (
                    <>
                      <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, flexShrink: 0 }}>·</span>
                      <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 12, fontStyle: 'italic', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        "{patch.reason}"
                      </span>
                    </>
                  )}

                  {/* Outcome badge */}
                  {outcome && (
                    <span style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '2px 7px',
                      borderRadius: 99,
                      background: outcome === 'promoted'
                        ? 'rgba(34,197,94,0.15)'
                        : outcome === 'reverted'
                          ? 'rgba(251,191,36,0.15)'
                          : 'rgba(255,255,255,0.08)',
                      color: outcome === 'promoted'
                        ? 'rgba(134,239,172,0.9)'
                        : outcome === 'reverted'
                          ? 'rgba(253,224,71,0.9)'
                          : 'rgba(255,255,255,0.5)',
                      flexShrink: 0,
                    }}>
                      {outcome}
                    </span>
                  )}

                  {isCurrent && (
                    <span className="qx-pill" style={{ fontSize: 11, flexShrink: 0 }}>current</span>
                  )}

                  {/* Actions for non-current rows */}
                  {!isCurrent && (
                    <div className="qx-row" style={{ gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
                      {/* Diff button — only if we have a body for that version */}
                      {versionBodyMap[patch.toVersion] !== undefined && (
                        <button
                          type="button"
                          className="qx-btn qx-btn--sm"
                          onClick={() => setDiffTarget({ version: patch.toVersion, bodyMd: versionBodyMap[patch.toVersion] })}
                          title={`View diff for v${patch.toVersion}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4, pointerEvents: 'none' }}>
                            <polyline points="16 3 21 3 21 8" />
                            <line x1="4" y1="20" x2="21" y2="3" />
                            <polyline points="21 16 21 21 16 21" />
                            <line x1="15" y1="15" x2="21" y2="21" />
                          </svg>
                          Diff
                        </button>
                      )}
                      <button
                        type="button"
                        className="qx-btn qx-btn--sm"
                        onClick={() => { setRevertTarget({ version: patch.toVersion }); setRevertError(null) }}
                        title={`Revert to v${patch.toVersion}`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4, pointerEvents: 'none' }}>
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74" />
                          <path d="M3 3v5h5" />
                        </svg>
                        Revert to this version
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Diff modal */}
      {diffTarget && (
        <DiffModal
          fromVersion={diffTarget.version}
          toVersion={currentVersion}
          fromBody={diffTarget.bodyMd}
          toBody={skill.bodyMd || ''}
          onClose={() => setDiffTarget(null)}
        />
      )}

      {/* Revert confirm modal */}
      {revertTarget && (
        <RevertConfirmModal
          skillName={skill.name}
          targetVersion={revertTarget.version}
          onConfirm={handleRevertConfirm}
          onCancel={() => { setRevertTarget(null); setRevertError(null) }}
          loading={reverting}
          error={revertError}
        />
      )}
    </div>
  )
}

// ─── SkillCard ────────────────────────────────────────────────────────────────

function SkillCard({ skill, onClick, scoreboard, onArchived }) {
  const tags = Array.isArray(skill.tags) ? skill.tags : []
  const agents = Array.isArray(skill.bestForAgents) ? skill.bestForAgents : []
  const reviewNeeded = Boolean(skill.reviewNeeded) || Boolean(skill.evals?.review_needed)
  const isArchiveCandidate = skill.decayState === 'archive_candidate'

  // Build sparkline points from scoreboard 30d/7d rates (simplest 2-point trend)
  const sparklinePoints = scoreboard
    ? [scoreboard.success_rate_30d, scoreboard.success_rate_7d].filter(v => v != null)
    : []

  // QSKL-11a: relative last-used label for the card footer
  const lastUsedLabel = skill.lastUsedAt
    ? `Last used: ${formatRelative(skill.lastUsedAt)}`
    : 'Never used'

  const handleArchiveClick = async (e) => {
    e.stopPropagation()
    if (!window.confirm('Archive this skill?')) return
    try {
      await archiveQuoxSkill(skill.id)
      if (onArchived) onArchived(skill.id)
    } catch (err) {
      console.error('Archive failed:', err?.message || err)
    }
  }

  return (
    <article
      className="qx-card qx-card--compact"
      style={{ cursor: 'pointer' }}
      onClick={() => onClick(skill)}
      role="button"
      tabIndex={0}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick(skill)}
    >
      <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="qx-stack" style={{ gap: 4 }}>
          <h3 style={{ margin: 0 }}>{skill.name}</h3>
          <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
            {skill.description}
          </p>
        </div>
        <div className="qx-row" style={{ gap: 6, flexShrink: 0, marginLeft: 12, alignItems: 'center' }}>
          {/* QSKL-7.7b: sparkline + score badges when scoreboard data available */}
          {scoreboard && (
            <SkillSparkline points={sparklinePoints} />
          )}
          {scoreboard && (
            <SkillScoreBadges scoreboard={scoreboard} />
          )}
          {/* QSKL-7.7b: review needed badge */}
          <SkillReviewBadge reviewNeeded={reviewNeeded} />
          {skill.evals?.tests?.drifter === true && (
            <span className="qx-pill qx-pill--danger qx-pill--sm">Drifter</span>
          )}
          {/* QSKL-11a: archive-candidate badge */}
          {isArchiveCandidate && (
            <span className="qx-pill qx-pill--sm" style={{ background: 'rgba(251,191,36,0.15)', color: 'rgba(253,224,71,0.9)' }}>
              Archive candidate
            </span>
          )}
          <span className="qx-pill">{skill.category}</span>
          <span className="qx-pill">{skill.edition || 'experimental'}</span>
          {skill.version && <span className="qx-pill">v{skill.version}</span>}
          {/* SKILLRIGHTS-8: declared licence travels with the skill; shown, never enforced here */}
          {skill.license && (
            <span className="qx-pill qx-pill--ghost" data-testid="skill-licence-pill" title={skill.license}>
              {shortLicenceLabel(skill.license)}
            </span>
          )}
        </div>
      </header>

      {(tags.length > 0 || agents.length > 0) && (
        <div className="qx-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {tags.map(tag => (
            <span key={tag} className="qx-chip">{tag}</span>
          ))}
          {agents.map(agent => (
            <span key={agent} className="qx-chip" style={{ borderColor: 'rgba(56,189,248,0.3)' }}>
              {agent}
            </span>
          ))}
        </div>
      )}

      <footer className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        {/* QSKL-11a: last-used relative time */}
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>
          {lastUsedLabel}
        </span>
        <div className="qx-row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
            {formatDate(skill.updatedAt || skill.createdAt)}
          </span>
          {/* QSKL-11a: Archive button for archive-candidate skills */}
          {isArchiveCandidate && (
            <button
              type="button"
              className="qx-btn qx-btn--sm"
              aria-label="Archive"
              onClick={handleArchiveClick}
              style={{ padding: '2px 8px', background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(253,224,71,0.3)', color: 'rgba(253,224,71,0.9)' }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(253,224,71,0.9)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4, pointerEvents: 'none' }}
              >
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
                <line x1="10" y1="12" x2="14" y2="12" />
              </svg>
              Archive
            </button>
          )}
        </div>
      </footer>
    </article>
  )
}

// ─── JudgePanel helpers (QSKL-11b slice 5) ───────────────────────────────────

/**
 * judgeChipStyle — returns inline style for a score chip.
 * ≥4 → green, 3-3.9 → amber, <3 → red, null → muted.
 */
function judgeChipStyle(score) {
  if (score === null || score === undefined) return { color: 'rgba(255,255,255,0.55)' }
  if (score >= 4) return { background: 'rgba(74, 222, 128, 0.15)', color: 'rgba(187, 247, 208, 1)' }
  if (score >= 3) return { background: 'rgba(251, 191, 36, 0.15)', color: 'rgba(253, 230, 138, 1)' }
  return { background: 'rgba(248, 113, 113, 0.18)', color: 'rgba(254, 226, 226, 1)' }
}

function judgeBand(score) {
  if (score === null || score === undefined) return 'null'
  if (score >= 4) return 'ok'
  if (score >= 3) return 'warn'
  return 'bad'
}

/**
 * JudgeSparkline — minimal 120×24px polyline from avg_score values.
 * Renders nothing when < 2 values provided.
 * Values should be ordered oldest→newest so the rightmost point is most recent.
 */
function JudgeSparkline({ values }) {
  if (!Array.isArray(values) || values.length < 2) return null
  const width = 120, height = 24, pad = 2
  const maxScore = 5, minScore = 1
  const xs = values.map((_, i) => pad + (i * (width - 2 * pad)) / (values.length - 1))
  const ys = values.map(v => {
    const clamped = Math.max(minScore, Math.min(maxScore, v ?? minScore))
    const norm = (clamped - minScore) / (maxScore - minScore)
    return pad + (1 - norm) * (height - 2 * pad)
  })
  const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} data-testid="judge-sparkline" aria-hidden="true">
      <polyline points={points} fill="none" stroke="rgba(56, 189, 248, 0.7)" strokeWidth="1.5" />
    </svg>
  )
}

/**
 * JudgePanel — renders the judge evaluation panel inside SkillDetail.
 * Props:
 *   current  — JudgeResult (the latest)
 *   history  — Array of JudgeResult (older, newest-first per API spec)
 */
function JudgePanel({ current, history }) {
  const scores = current.scores || {}
  const notes = current.judge_notes || {}

  // Sparkline: oldest→newest, so reverse([current, ...history])
  // history is newest-first, so: [...history].reverse() is oldest-first, then current is newest
  const sparklineValues = [
    ...[...history].reverse().map(h => h.avg_score),
    current.avg_score,
  ]

  // Up to 3 most recent notes: current + history[0] + history[1]
  const recentEntries = [current, ...history.slice(0, 2)]

  const DIMS = ['clarity', 'completeness', 'recency', 'drift']

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      {/* Header row: title + avg_score + relative time */}
      <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="qx-stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Judge</span>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
            Last scored: {formatRelative(current.scored_at)}
          </span>
        </div>
        <div className="qx-row" style={{ gap: 12, alignItems: 'center' }}>
          <JudgeSparkline values={sparklineValues} />
          <span style={{ fontSize: 18, fontWeight: 700, color: 'rgba(255,255,255,0.9)' }}>
            Avg {Number(current.avg_score).toFixed(1)}
          </span>
        </div>
      </div>

      {/* Score chips row */}
      <div className="qx-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {DIMS.map(dim => {
          const score = scores[dim] ?? null
          const style = judgeChipStyle(score)
          const band = judgeBand(score)
          const titleAttr = (dim === 'drift' && score === null && notes.drift)
            ? notes.drift
            : undefined
          return (
            <span
              key={dim}
              className="qx-chip"
              data-testid={`judge-chip-${dim}`}
              data-judge-band={band}
              title={titleAttr}
              style={{ ...style, fontSize: 12, padding: '2px 8px' }}
            >
              {dim}: {score !== null && score !== undefined ? score : '—'}
            </span>
          )
        })}
      </div>

      {/* Recent notes collapsible */}
      <details data-testid="judge-notes-details">
        <summary style={{ fontSize: 13, cursor: 'pointer', color: 'rgba(255,255,255,0.7)', marginBottom: 6 }}>
          Recent notes ({recentEntries.length})
        </summary>
        <div className="qx-stack" style={{ gap: 8, marginTop: 8 }}>
          {recentEntries.map((entry, i) => {
            const entryNotes = entry.judge_notes || {}
            return (
              <div key={entry.scored_at || i} className="qx-card qx-card--compact" style={{ padding: '10px 14px' }}>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: 6 }}>
                  {formatRelative(entry.scored_at)}
                </span>
                {DIMS.map(dim => entryNotes[dim] && (
                  <div key={dim} style={{ fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: 'rgba(255,255,255,0.55)', marginRight: 6 }}>{dim}:</span>
                    <span style={{ color: 'rgba(255,255,255,0.85)' }}>{entryNotes[dim]}</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </details>
    </div>
  )
}

// ─── SkillDetail ──────────────────────────────────────────────────────────────

function SkillDetail({ skill: initialSkill, onClose, onSkillUpdated, scoreboard }) {
  const [skill, setSkill] = useState(initialSkill)
  const [runningTests, setRunningTests] = useState(false)
  const [testRunError, setTestRunError] = useState(null)

  // When the parent selects a different skill, reset
  useEffect(() => { setSkill(initialSkill); setTestRunError(null) }, [initialSkill?.id])

  const handleReverted = useCallback(() => {
    // Re-fetch the skill so the detail view shows the reverted body + new version
    getQuoxSkillById(skill.id)
      .then(updated => { if (updated) setSkill(updated) })
      .catch(() => {/* swallow — version history will still refresh */})
    if (onSkillUpdated) onSkillUpdated()
  }, [skill?.id, onSkillUpdated])

  const handleRunTests = useCallback(async () => {
    setRunningTests(true)
    setTestRunError(null)
    try {
      const envelope = await runQuoxSkillTests(skill.id)
      if (envelope?.success === false) {
        setTestRunError(envelope.error)
      } else {
        // Refresh skill to pick up updated evals
        const updated = await getQuoxSkillById(skill.id)
        if (updated) setSkill(updated)
      }
    } catch (err) {
      setTestRunError({ message: err?.message || String(err) })
    } finally {
      setRunningTests(false)
    }
  }, [skill?.id])

  const tags = Array.isArray(skill.tags) ? skill.tags : []
  const agents = Array.isArray(skill.bestForAgents) ? skill.bestForAgents : []
  const evals = skill.evals || null
  const testsData = evals?.tests || null
  // Other top-level evals keys excluding 'tests'
  const otherEvalsKeys = evals ? Object.keys(evals).filter(k => k !== 'tests' && k !== 'judge' && k !== 'judge_history') : []

  const hasTestPairs = Array.isArray(skill.tests) && skill.tests.length > 0
  const engineNotWired = testRunError?.code === 'TESTS_NOT_CONFIGURED'

  return (
    <div className="qx-card">
      <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div className="qx-stack" style={{ gap: 4 }}>
          <h2 style={{ margin: 0 }}>{skill.name}</h2>
          <div className="qx-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="qx-pill">{skill.category}</span>
            <span className="qx-pill">{skill.edition || 'experimental'}</span>
            {skill.version && <span className="qx-pill">v{skill.version}</span>}
            {/* SKILLRIGHTS-8: detail view is honest both ways: declared licence, or undeclared */}
            {skill.license ? (
              <span className="qx-pill qx-pill--ghost" data-testid="skill-licence-pill" title={skill.license}>
                {shortLicenceLabel(skill.license)}
              </span>
            ) : (
              <span className="qx-pill qx-pill--warn" data-testid="skill-licence-undeclared" title="This skill carries no SkillRights declaration">
                undeclared
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="qx-btn qx-btn--sm"
          onClick={onClose}
          aria-label="Close detail"
        >
          Close
        </button>
      </header>

      {skill.description && (
        <p style={{ color: 'rgba(255,255,255,0.8)', marginBottom: 16 }}>{skill.description}</p>
      )}

      {/* QSKL-7.7b: Review needed badge */}
      {Boolean(skill.evals?.review_needed) && (
        <div style={{ marginBottom: 12 }}>
          <SkillReviewBadge reviewNeeded={true} />
        </div>
      )}

      {/* QSKL-7.7b: Coverage map bar */}
      {scoreboard != null && (
        <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', display: 'block', marginBottom: 6 }}>
            Coverage
          </span>
          <SkillCoverageBar crystalHitRate={scoreboard.crystal_hit_rate} />
        </div>
      )}

      {tags.length > 0 && (
        <div className="qx-row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginRight: 4 }}>Tags:</span>
          {tags.map(tag => <span key={tag} className="qx-chip">{tag}</span>)}
        </div>
      )}

      {agents.length > 0 && (
        <div className="qx-row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginRight: 4 }}>Best for:</span>
          {agents.map(agent => (
            <span key={agent} className="qx-chip" style={{ borderColor: 'rgba(56,189,248,0.3)' }}>{agent}</span>
          ))}
        </div>
      )}

      {skill.lastUsedAt && (
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 12 }}>
          Last used: {formatDate(skill.lastUsedAt)}
        </p>
      )}

      {skill.bodyMd && (
        <div
          className="qx-card"
          style={{ marginTop: 16, background: 'rgba(255,255,255,0.04)', padding: '16px' }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.bodyMd}</ReactMarkdown>
        </div>
      )}

      {/* ── Required Tools panel (QSKL-6.7) ── */}
      {Array.isArray(skill.requiredTools) && skill.requiredTools.length > 0 && (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontWeight: 600, fontSize: 14, display: 'block', marginBottom: 12 }}>
            Required Tools
          </span>
          <div className="qx-stack" style={{ gap: 10 }}>
            {skill.requiredTools.map((tool, idx) => (
              <div
                key={tool.name || idx}
                className="qx-card qx-card--compact"
                style={{ background: 'rgba(255,255,255,0.04)', padding: '12px 16px' }}
              >
                <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                  <div className="qx-stack" style={{ gap: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{tool.name}</span>
                    {tool.version_constraint && (
                      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontFamily: 'var(--qx-font-mono, monospace)' }}>
                        {tool.version_constraint}
                      </span>
                    )}
                    {Array.isArray(tool.must_satisfy_policy) && tool.must_satisfy_policy.length > 0 && (
                      <div className="qx-row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                        {tool.must_satisfy_policy.map(policy => (
                          <span key={policy} className="qx-chip" style={{ fontSize: 11 }}>{policy}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Automated tool-presence resolution is not implemented yet (quoxflow's
                      toolPresenceLookup defaults to "not present" for everything — see
                      skills-actions.ts QSKL-6.4b). Rather than show a fake "pending" status,
                      we list the requirement without claiming any resolution state. */}
                  <span
                    className="qx-pill"
                    style={{ flexShrink: 0, fontSize: 11 }}
                  >
                    Status not tracked
                  </span>
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 10, marginBottom: 0 }}>
            Automatic tool-availability checking is not yet implemented — verify these tools are installed via the Tools library before relying on this skill.
          </p>
        </div>
      )}

      {/* ── Tests panel (QSKL-5.G) ── */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div className="qx-stack" style={{ gap: 4 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Tests</span>
            {testsData?.last_run_at && (
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                Last run: {formatDateTime(testsData.last_run_at)}
              </span>
            )}
          </div>
          <div className="qx-row" style={{ gap: 12, alignItems: 'center' }}>
            {testsData && (
              <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)' }}>
                {testsData.passed ?? 0} / {testsData.total ?? 0} passed
              </span>
            )}
            {hasTestPairs && (
              <button
                type="button"
                className="qx-btn qx-btn--sm"
                onClick={handleRunTests}
                disabled={runningTests || engineNotWired}
                aria-label="Run tests"
                title={engineNotWired ? 'Skill-tests engine not wired in this environment yet.' : undefined}
              >
                {runningTests ? (
                  <>
                    <span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} />
                    Running…
                  </>
                ) : 'Run tests'}
              </button>
            )}
          </div>
        </div>

        {/* Engine not wired inline note */}
        {engineNotWired && (
          <div className="qx-banner qx-banner--warn" style={{ marginBottom: 12 }}>
            Skill-tests engine not wired in this environment yet.
          </div>
        )}

        {/* Other test run error */}
        {testRunError && !engineNotWired && (
          <div className="qx-banner qx-banner--error" style={{ marginBottom: 12 }}>
            {testRunError.message || 'Test run failed.'}
          </div>
        )}

        {/* No tests declared */}
        {!hasTestPairs && (
          <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>No tests declared on this skill.</p>
        )}

        {/* Tests not run yet */}
        {hasTestPairs && !testsData && (
          <div className="qx-empty">
            <p className="qx-empty__title">Tests not run yet</p>
          </div>
        )}

        {/* Per-test result rows */}
        {testsData && Array.isArray(testsData.results) && testsData.results.length > 0 && (
          <div className="qx-stack qx-stack--tight">
            {testsData.results.map((result, i) => (
              <div key={result.name || i}>
                <div className="qx-row" style={{ gap: 10, alignItems: 'center' }}>
                  <span className={`qx-dot ${result.passed ? 'qx-dot--online' : 'qx-dot--offline'}`} />
                  <span style={{ fontSize: 13, flex: 1 }}>{result.name}</span>
                  <span
                    className={`qx-pill qx-pill--sm ${result.passed ? 'qx-pill--success' : 'qx-pill--danger'}`}
                  >
                    {result.passed ? 'Pass' : 'Fail'}
                  </span>
                </div>
                {!result.passed && result.failure_reason && (
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', margin: '4px 0 0 18px' }}>
                    {result.failure_reason}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Judge panel (QSKL-11b slice 5) ── */}
      {skill.evals?.judge && (
        <JudgePanel
          current={skill.evals.judge}
          history={Array.isArray(skill.evals.judge_history) ? skill.evals.judge_history : []}
        />
      )}

      {/* ── Other evals keys (QSKL-7 metrics etc.) ── */}
      {otherEvalsKeys.length > 0 && (
        <details className="qx-disclosure" style={{ marginTop: 16 }}>
          <summary className="qx-disclosure__head">
            <span className="qx-disclosure__chev" />
            Raw evals
          </summary>
          <div className="qx-disclosure__body">
            <div className="qx-stack qx-stack--tight" style={{ marginTop: 8 }}>
              {otherEvalsKeys.map(k => (
                <div key={k} className="qx-row qx-row--apart">
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{k}</span>
                  <span style={{ fontSize: 12, fontFamily: 'var(--qx-font-mono)' }}>
                    {typeof evals[k] === 'object' ? JSON.stringify(evals[k]) : String(evals[k])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </details>
      )}

      {/* ── Version history + revert (QSKL-4.F) ── */}
      <div style={{ marginTop: 8, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <SkillVersionHistory skill={skill} onReverted={handleReverted} />
      </div>
    </div>
  )
}

// ─── FirewallBlockedBanner — QSKL-SAFETY Gap 5 ───────────────────────────────
// Surfaces structured firewall findings inline on the skill publish flow so
// authors see exactly which rule fired, where, and how to fix it — instead of
// a generic "rejected by firewall" message.

const SEVERITY_COLORS = {
  block:   { bg: 'rgba(239, 68, 68, 0.16)',  border: 'rgba(239, 68, 68, 0.55)',  text: '#fca5a5' },
  high:    { bg: 'rgba(249, 115, 22, 0.16)', border: 'rgba(249, 115, 22, 0.55)', text: '#fdba74' },
  medium:  { bg: 'rgba(234, 179, 8, 0.16)',  border: 'rgba(234, 179, 8, 0.55)',  text: '#fde047' },
  low:     { bg: 'rgba(59, 130, 246, 0.16)', border: 'rgba(59, 130, 246, 0.55)', text: '#93c5fd' },
}

function FirewallBlockedBanner({ error }) {
  const findings = Array.isArray(error.findings) ? error.findings : []
  return (
    <div
      className="qx-banner qx-banner--danger"
      style={{ marginBottom: 16, padding: 16 }}
      role="alert"
      data-testid="firewall-blocked-banner"
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        Firewall blocked this skill — {findings.length} finding{findings.length === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', marginBottom: 12 }}>
        {error.message}
      </div>
      <div className="qx-stack" style={{ gap: 8 }}>
        {findings.map((f, idx) => {
          const colors = SEVERITY_COLORS[f.severity] || SEVERITY_COLORS.medium
          const location = f.reference_key
            ? `${f.surface}/${f.reference_key}:line ${f.line}`
            : `${f.surface}:line ${f.line}`
          return (
            <div
              key={`${f.rule_id}-${idx}`}
              style={{
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                padding: 10,
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontWeight: 600,
                    color: colors.text,
                    background: 'rgba(0,0,0,0.3)',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontSize: 11,
                  }}
                >
                  {f.rule_id}
                </span>
                <span style={{ color: colors.text, fontWeight: 600, fontSize: 11, textTransform: 'uppercase' }}>
                  {f.severity}
                </span>
                <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11 }}>
                  {location}
                </span>
              </div>
              <pre
                style={{
                  margin: '4px 0 0 0',
                  background: 'rgba(0,0,0,0.4)',
                  padding: 8,
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  color: 'rgba(255,255,255,0.9)',
                }}
              >
                {f.snippet}
              </pre>
              {f.remediation && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.5)' }}>Fix:</span> {f.remediation}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {(error.ruleSetVersion !== undefined || error.scannedAt) && (
        <div style={{ marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
          ruleset v{error.ruleSetVersion} · scanned {error.scannedAt}
        </div>
      )}
    </div>
  )
}

// ─── CreateSkillModal ──────────────────────────────────────────────────────────

function CreateSkillModal({ onClose, onCreated, authorEmail }) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState(CATEGORIES[0])
  const [description, setDescription] = useState('')
  const [bodyMd, setBodyMd] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [bestForAgentsRaw, setBestForAgentsRaw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError('Name is required.'); return }
    if (!description.trim()) { setError('Description is required.'); return }

    setSubmitting(true)
    try {
      const input = {
        name: name.trim(),
        category,
        description: description.trim(),
        bodyMd: bodyMd.trim(),
        tags: parseTags(tagsRaw),
        bestForAgents: parseTags(bestForAgentsRaw),
        author: authorEmail ? `user:${authorEmail}` : 'user:unknown',
      }
      const created = await createQuoxSkill(input)
      onCreated(created)
    } catch (err) {
      // QSKL-SAFETY Gap 5: preserve structured firewall details so the
      // findings panel can render rule_id + line + snippet inline.
      if (err?.code === 'FIREWALL_BLOCKED' && err?.data?.findings) {
        setError({
          message: err.message || 'Skill body was rejected by the firewall.',
          code: err.code,
          findings: err.data.findings,
          ruleSetVersion: err.data.rule_set_version,
          scannedAt: err.data.scanned_at,
        })
      } else {
        setError(err?.message || 'Failed to create skill.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create skill"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="qx-card" style={{ width: '100%', maxWidth: 600, maxHeight: '90vh', overflowY: 'auto' }}>
        <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>Create skill</h2>
          <button type="button" className="qx-btn qx-btn--sm" onClick={onClose} aria-label="Close modal">
            Close
          </button>
        </header>

        {error && typeof error === 'string' && (
          <div className="qx-banner qx-banner--danger" style={{ marginBottom: 16 }}>{error}</div>
        )}
        {error && typeof error === 'object' && error.code === 'FIREWALL_BLOCKED' && (
          <FirewallBlockedBanner error={error} />
        )}

        <form onSubmit={handleSubmit} className="qx-stack" style={{ gap: 16 }}>
          <div className="qx-stack" style={{ gap: 6 }}>
            <label style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Name *</label>
            <input
              type="text"
              className="qx-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. network-egress-snapshot"
              required
            />
          </div>

          <div className="qx-stack" style={{ gap: 6 }}>
            <label style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Category *</label>
            <select
              className="qx-input"
              value={category}
              onChange={e => setCategory(e.target.value)}
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="qx-stack" style={{ gap: 6 }}>
            <label style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Description *</label>
            <input
              type="text"
              className="qx-input"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="One-line description of what this skill does"
              required
            />
          </div>

          <div className="qx-stack" style={{ gap: 6 }}>
            <label style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Body (Markdown)</label>
            <textarea
              className="qx-input"
              value={bodyMd}
              onChange={e => setBodyMd(e.target.value)}
              placeholder="## Steps&#10;&#10;1. ..."
              rows={8}
              style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
            />
          </div>

          <div className="qx-stack" style={{ gap: 6 }}>
            <label style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Tags (comma-separated)</label>
            <input
              type="text"
              className="qx-input"
              value={tagsRaw}
              onChange={e => setTagsRaw(e.target.value)}
              placeholder="e.g. security, network, egress"
            />
          </div>

          <div className="qx-stack" style={{ gap: 6 }}>
            <label style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Best for agents (comma-separated)</label>
            <input
              type="text"
              className="qx-input"
              value={bestForAgentsRaw}
              onChange={e => setBestForAgentsRaw(e.target.value)}
              placeholder="e.g. cipher, sentinel"
            />
          </div>

          <div className="qx-stack" style={{ gap: 6 }}>
            <label style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Author</label>
            <input
              type="text"
              className="qx-input"
              value={authorEmail ? `user:${authorEmail}` : 'user:unknown'}
              disabled
              readOnly
              style={{ opacity: 0.6 }}
            />
          </div>

          <div className="qx-row" style={{ gap: 12, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="qx-btn qx-btn--sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="qx-btn qx-btn--primary qx-btn--sm"
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Create skill'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── SkillsView (main) ────────────────────────────────────────────────────────

export default function SkillsView() {
  const { user } = useAuth()
  const [skills, setSkills] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Scoreboard data — keyed by skill_id (QSKL-7.7b)
  const [scoreboards, setScoreboards] = useState({})

  // Filters
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [editionFilter, setEditionFilter] = useState('')
  const [activeTag, setActiveTag] = useState(null)
  // QSKL-11a: archive-candidate filter
  const [showArchiveCandidates, setShowArchiveCandidates] = useState(false)

  // Detail
  const [selected, setSelected] = useState(null)

  // Create modal
  const [showCreate, setShowCreate] = useState(false)

  // Refresh trigger
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listQuoxSkills({
      category: categoryFilter || undefined,
      edition: editionFilter || undefined,
    })
      .then(rows => {
        if (!cancelled) setSkills(Array.isArray(rows) ? rows : [])
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Failed to load skills.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [refreshTick, categoryFilter, editionFilter])

  // QSKL-7.7b: Fetch all scoreboard rows once per refresh, build a lookup map
  useEffect(() => {
    let cancelled = false
    listSkillScoreboards()
      .then(rows => {
        if (!cancelled) {
          const map = {}
          ;(Array.isArray(rows) ? rows : []).forEach(row => {
            if (row?.skill_id) map[row.skill_id] = row
          })
          setScoreboards(map)
        }
      })
      .catch(() => { /* scoreboard is optional — silence errors */ })
    return () => { cancelled = true }
  }, [refreshTick])

  const allTags = useMemo(() => {
    const set = new Set()
    skills.forEach(s => (s.tags || []).forEach(t => set.add(t)))
    return Array.from(set).sort()
  }, [skills])

  // QSKL-3: Experimental skills for the "Pending review" lane
  const experimentalSkills = useMemo(
    () => skills.filter(s => (s.edition || 'experimental') === 'experimental'),
    [skills],
  )

  // QSKL-11a: count of archive candidates
  const archiveCandidateCount = useMemo(
    () => skills.filter(s => s.decayState === 'archive_candidate').length,
    [skills],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return skills.filter(s => {
      // QSKL-11a: archive-candidate filter takes precedence over other filters
      if (showArchiveCandidates) return s.decayState === 'archive_candidate'
      if (activeTag && !(s.tags || []).includes(activeTag)) return false
      if (!q) return true
      return (
        (s.name || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        (s.tags || []).some(t => t.toLowerCase().includes(q))
      )
    })
  }, [skills, search, activeTag, showArchiveCandidates])

  // QSKL-11a: handle archive action from card — remove from local list immediately
  const handleSkillArchived = useCallback((archivedId) => {
    setSkills(prev => prev.filter(s => s.id !== archivedId))
    if (selected?.id === archivedId) setSelected(null)
  }, [selected?.id])

  const handleCreated = (skill) => {
    setShowCreate(false)
    setRefreshTick(t => t + 1)
    // If the backend returns the created record, open detail immediately
    if (skill?.id) setSelected(skill)
  }

  const authorEmail = user?.email || ''

  return (
    <div className="qx-view">
      <div className="qx-stack">

        {/* ── Header ── */}
        <section className="qx-card">
          <header className="qx-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="qx-stack" style={{ gap: 4 }}>
              <h2 style={{ margin: 0 }}>Skills Library</h2>
              <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)' }}>
                Procedural knowledge artefacts — how-to guides agents can load, patch, and share.
              </p>
            </div>
            <div className="qx-row" style={{ gap: 10, alignItems: 'center' }}>
              <span className="qx-badge">{skills.length} Skill{skills.length === 1 ? '' : 's'}</span>
              <button
                type="button"
                className="qx-btn qx-btn--primary qx-btn--sm"
                onClick={() => setShowCreate(true)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 5, pointerEvents: 'none' }}
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Create skill
              </button>
            </div>
          </header>
        </section>

        {/* ── Filters ── */}
        <section className="qx-card">
          <div className="qx-row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="search"
              className="qx-input"
              placeholder="Search by name, description, or tag…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 200 }}
            />
            <select
              className="qx-input"
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              style={{ minWidth: 140 }}
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              className="qx-input"
              value={editionFilter}
              onChange={e => setEditionFilter(e.target.value)}
              style={{ minWidth: 140 }}
              aria-label="Filter by edition"
            >
              <option value="">All editions</option>
              {EDITIONS.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          {/* QSKL-11a: Archive candidates chip */}
          {archiveCandidateCount > 0 && (
            <div className="qx-row" style={{ gap: 6, flexWrap: 'nowrap', overflowX: 'auto', marginTop: 10 }}>
              <button
                type="button"
                className={`qx-chip${showArchiveCandidates ? ' qx-chip--active' : ''}`}
                style={showArchiveCandidates ? {} : { borderColor: 'rgba(251,191,36,0.3)', color: 'rgba(253,224,71,0.8)' }}
                onClick={() => {
                  setShowArchiveCandidates(v => !v)
                  setActiveTag(null)
                }}
              >
                Archive candidates ({archiveCandidateCount})
              </button>
            </div>
          )}
          {allTags.length > 0 && (
            <div className="qx-row" style={{ gap: 6, flexWrap: 'nowrap', overflowX: 'auto', marginTop: 10 }}>
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
        </section>

        {/* ── Detail view ── */}
        {selected && (
          <SkillDetail
            skill={selected}
            onClose={() => setSelected(null)}
            onSkillUpdated={() => setRefreshTick(t => t + 1)}
            scoreboard={scoreboards[selected.id] || null}
          />
        )}

        {/* ── Loading ── */}
        {loading && (
          <section className="qx-card">
            <div className="qx-row" style={{ justifyContent: 'center', padding: 24 }}>
              <span className="qx-spinner" />
            </div>
          </section>
        )}

        {/* ── Error ── */}
        {error && !loading && (
          <section className="qx-card">
            <div className="qx-banner qx-banner--danger">
              <strong>Couldn't load skills.</strong> {error}
            </div>
            <button
              type="button"
              className="qx-btn qx-btn--sm"
              style={{ marginTop: 12 }}
              onClick={() => setRefreshTick(t => t + 1)}
            >
              Retry
            </button>
          </section>
        )}

        {/* ── Empty state ── */}
        {!loading && !error && filtered.length === 0 && (
          <section className="qx-card">
            <div className="qx-empty">
              <h3>{skills.length === 0 ? 'No skills yet' : 'Nothing matches'}</h3>
              <p>
                {skills.length === 0
                  ? 'Create the first skill to start building the procedural knowledge layer.'
                  : 'Try clearing the search, category, or tag filter.'}
              </p>
              {skills.length === 0 && (
                <button
                  type="button"
                  className="qx-btn qx-btn--primary qx-btn--sm"
                  onClick={() => setShowCreate(true)}
                >
                  Create skill
                </button>
              )}
            </div>
          </section>
        )}

        {/* ── QSKL-3: Pending review lane ── */}
        {!loading && !error && experimentalSkills.length > 0 && (
          <section className="qx-card">
            <header className="qx-row" style={{ alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>Pending review</h3>
              <span className="qx-badge">{experimentalSkills.length}</span>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginLeft: 4 }}>
                LLM-authored skills awaiting human review
              </span>
            </header>
            <div className="qx-stack">
              {experimentalSkills.map(skill => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onClick={setSelected}
                  scoreboard={scoreboards[skill.id] || null}
                  onArchived={handleSkillArchived}
                />
              ))}
            </div>
          </section>
        )}

        {/* ── Skill list ── */}
        {!loading && !error && filtered.length > 0 && (
          <div className="qx-stack">
            {filtered.map(skill => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onClick={setSelected}
                scoreboard={scoreboards[skill.id] || null}
                onArchived={handleSkillArchived}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Create modal ── */}
      {showCreate && (
        <CreateSkillModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
          authorEmail={authorEmail}
        />
      )}
    </div>
  )
}

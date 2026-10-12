/**
 * VersionHistory — STUDY-REV-2 P5.C
 *
 * Disclosure panel for a workflow's version history.
 * Fetches from GET /api/orgs/:orgId/workflows/:workflowId/versions,
 * lets the user view a JSON diff against the current version,
 * and restore any prior version via POST .../versions/:version/restore.
 *
 * Props:
 *   workflowId  {string}   — the loaded workflow's auth-service ID
 *   orgId       {string}   — caller's org (from useAuth)
 *   authFetch   {function} — from useAuth()
 *   currentDefinition {object|null} — the builder's current definition_json (for diff)
 *   onRestore   {function} — called after a successful restore; no args needed;
 *                            parent re-fetches the workflow and reloads the builder.
 */

import { useState, useEffect, useCallback } from 'react'
import { listWorkflowVersions, restoreWorkflowVersion } from '../../services/workflowEngine'

// ---------------------------------------------------------------------------
// Relative timestamp helper
// ---------------------------------------------------------------------------
function relativeTime(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

// ---------------------------------------------------------------------------
// Minimal line-diff: compare two JSON strings line-by-line.
// Returns array of {line, type: 'add'|'remove'|'context'}.
// ---------------------------------------------------------------------------
function computeLineDiff(aStr, bStr) {
  const aLines = (aStr || '').split('\n')
  const bLines = (bStr || '').split('\n')
  const result = []

  // Build a set for fast lookup
  const aSet = new Set(aLines)
  const bSet = new Set(bLines)

  // Emit lines from A (old) that are not in B as removals,
  // lines from B (new) that are not in A as additions,
  // and shared lines as context (up to 3 surrounding a change).
  // Simple approach: merge both line lists with markers.
  const maxLen = Math.max(aLines.length, bLines.length)
  for (let i = 0; i < maxLen; i++) {
    const a = aLines[i]
    const b = bLines[i]
    if (a === b) {
      result.push({ line: a ?? '', type: 'context' })
    } else {
      if (a !== undefined) result.push({ line: a, type: 'remove' })
      if (b !== undefined) result.push({ line: b, type: 'add' })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// DiffModal — side-by-side "old vs new" using .qx-diff
// ---------------------------------------------------------------------------
function DiffModal({ versionRecord, currentDefinition, onClose }) {
  const [showDiffOnly, setShowDiffOnly] = useState(false)

  const oldStr = JSON.stringify(
    JSON.parse(versionRecord.definition_json || '{}'),
    null,
    2
  )
  const newStr = JSON.stringify(currentDefinition || {}, null, 2)
  const diffLines = computeLineDiff(oldStr, newStr)
  const visibleLines = showDiffOnly
    ? diffLines.filter((l) => l.type !== 'context')
    : diffLines

  return (
    <div
      className="qx-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Diff for v${versionRecord.version}`}
    >
      <div
        className="qx-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 800, width: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="qx-row qx-row--apart" style={{ marginBottom: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            v{versionRecord.version} vs current
          </span>
          <div className="qx-row qx-row--tight">
            <label className="qx-row qx-row--tight" style={{ fontSize: 12, cursor: 'pointer', gap: 6 }}>
              <input
                type="checkbox"
                checked={showDiffOnly}
                onChange={(e) => setShowDiffOnly(e.target.checked)}
              />
              Differences only
            </label>
            <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose} type="button">
              Close
            </button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div className="qx-diff">
            {visibleLines.map((entry, idx) => (
              <div
                key={idx}
                className={`qx-diff__line${entry.type === 'add' ? ' qx-diff__line--add' : entry.type === 'remove' ? ' qx-diff__line--remove' : ' qx-diff__line--context'}`}
              >
                <span className="qx-diff__sign">
                  {entry.type === 'add' ? '+' : entry.type === 'remove' ? '-' : ' '}
                </span>
                <span className="qx-diff__ln">{entry.line}</span>
              </div>
            ))}
            {visibleLines.length === 0 && (
              <div className="qx-diff__line qx-diff__line--context" style={{ color: 'rgba(255,255,255,0.5)' }}>
                No differences
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// VersionHistory (main export)
// ---------------------------------------------------------------------------
export default function VersionHistory({ workflowId, orgId, authFetch, currentDefinition, onRestore }) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [diffTarget, setDiffTarget] = useState(null) // version record to diff
  const [restoring, setRestoring] = useState(null)   // version number being restored

  const fetchVersions = useCallback(async () => {
    if (!workflowId || !orgId || !authFetch) return
    setLoading(true)
    setError(null)
    try {
      // include=definition so we can show the diff
      const rows = await listWorkflowVersions(authFetch, orgId, workflowId, true)
      setVersions(rows)
    } catch (err) {
      // Workflows that live only in the agent engine (e.g. Warden) have no
      // auth-side row, so the versions endpoint returns 404. Render the empty
      // state instead of an error banner — there is no version history yet.
      if (err?.status === 404) {
        setVersions([])
      } else {
        setError(err.message || 'Failed to load versions')
      }
    } finally {
      setLoading(false)
    }
  }, [workflowId, orgId, authFetch])

  useEffect(() => {
    fetchVersions()
  }, [fetchVersions])

  const currentVersion = versions[0]?.version ?? '—'

  async function handleRestore(versionRecord) {
    const confirmed = window.confirm(
      `Restore v${versionRecord.version}? This creates a new version on top of the current (v${currentVersion}).`
    )
    if (!confirmed) return

    setRestoring(versionRecord.version)
    try {
      await restoreWorkflowVersion(authFetch, orgId, workflowId, versionRecord.version)
      // Refresh the version list before notifying the parent
      await fetchVersions()
      onRestore?.()
    } catch (err) {
      // Use the in-panel error banner (rendered below), not a raw window.alert (house UX consistency).
      setError(`Restore failed: ${err.message}`)
    } finally {
      setRestoring(null)
    }
  }

  if (!workflowId) return null

  return (
    <>
      <details className="qx-disclosure">
        <summary className="qx-disclosure__head">
          <span className="qx-disclosure__chev">▸</span>
          Version History
          {versions.length > 0 && (
            <span className="qx-pill qx-pill--ghost qx-pill--sm" style={{ marginLeft: 8 }}>
              v{versions[0].version}
            </span>
          )}
        </summary>

        <div className="qx-disclosure__body">
          {loading && (
            <div className="qx-row qx-row--center" style={{ padding: '12px 0' }}>
              <span className="qx-spinner qx-spinner--sm" />
            </div>
          )}

          {error && (
            <div className="qx-banner qx-banner--error" style={{ fontSize: 12 }}>
              {error}
            </div>
          )}

          {!loading && !error && versions.length === 0 && (
            <div className="qx-empty" style={{ padding: '12px 0' }}>
              <span className="qx-empty__body">No version history yet.</span>
            </div>
          )}

          {versions.length > 0 && (
            <div className="qx-stack qx-stack--tight">
              {versions.map((v) => (
                <div key={v.id} className="qx-row qx-row--apart" style={{ alignItems: 'flex-start', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="qx-stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                    <div className="qx-row qx-row--tight" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <span className="qx-pill qx-pill--info qx-pill--sm">v{v.version}</span>
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {v.change_summary || 'No summary'}
                      </span>
                    </div>
                    <div className="qx-row qx-row--tight" style={{ gap: 6 }}>
                      {v.created_by_name && (
                        <span className="qx-avatar qx-avatar--xs" aria-hidden="true">
                          {v.created_by_name.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>
                        {v.created_by_name || 'Unknown'}
                        {' · '}
                        {relativeTime(v.created_at)}
                      </span>
                    </div>
                  </div>

                  <div className="qx-row qx-row--tight" style={{ flexShrink: 0, gap: 4 }}>
                    <button
                      className="qx-btn qx-btn--ghost qx-btn--sm"
                      type="button"
                      title={`View diff for v${v.version}`}
                      onClick={() => setDiffTarget(v)}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="5" y1="12" x2="19" y2="12"/>
                        <polyline points="12 5 19 12 12 19"/>
                      </svg>
                      Diff
                    </button>
                    <button
                      className="qx-btn qx-btn--ghost qx-btn--sm"
                      type="button"
                      title={`Restore v${v.version}`}
                      disabled={restoring === v.version}
                      onClick={() => handleRestore(v)}
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="1 4 1 10 7 10"/>
                        <path d="M3.51 15a9 9 0 1 0 .49-4.35"/>
                      </svg>
                      {restoring === v.version ? '…' : 'Restore'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </details>

      {diffTarget && (
        <DiffModal
          versionRecord={diffTarget}
          currentDefinition={currentDefinition}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </>
  )
}

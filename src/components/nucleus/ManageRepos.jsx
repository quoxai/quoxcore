/**
 * ManageRepos: add-repo UX for RepoBrain
 *
 * Stream QN Phase 2. Two entry points over the governed proxy:
 *   1. Paste a repo URL + pin -> setupTarget (create, clone, index in one job)
 *   2. Connect GitHub -> pick repos from the org's github plugin mapping,
 *      add + index each one
 *
 * Also lists the org's current RepoBrain targets with their status.
 *
 * Wave 3 (repos-alive): live indexing progress (poll getSetupStatus, toast on
 * done/failed), per-target file/last-indexed stats (getTargetStats, lazy),
 * and per-row actions (search this repo, re-index).
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getTargets, setupTarget, getSetupStatus, getTargetStats } from '../../services/nucleusClient'
import { fetchRepos } from '../../services/githubClient'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { useRepoBrainStatus } from './RepoBrainContext'

// Mirrors the backend target_id validator: lowercase letters, numbers,
// hyphens, starting with a letter/number, max 32 chars.
function slugifyTargetId(name) {
  const slug = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || 'repo'
}

function cloneUrlForRepo(repo) {
  return repo.clone_url || (repo.html_url ? `${repo.html_url}.git` : '')
}

// Simple absolute -> relative formatting for "last indexed" meta, matching
// the pattern already used across the dashboard (e.g. GitHubPanel).
function relativeTime(dateStr) {
  if (!dateStr) return null
  const then = new Date(dateStr).getTime()
  if (Number.isNaN(then)) return null
  const s = Math.floor((Date.now() - then) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(dateStr).toLocaleDateString()
}

// getSetupStatus's "status" is a free-form frontend-facing string from the
// engine (registered/cloning/indexing/ready/error/not_found, or a lowered
// job message for anything else). Turn it into a short stage label, with a
// percent suffix when the job reports one.
function stageLabel(status, progress) {
  const label = status === 'registered' ? 'queued' : (status || 'working')
  if (typeof progress === 'number' && progress > 0 && progress < 100) {
    return `${label} ${Math.round(progress)}%`
  }
  return label
}

const POLL_INTERVAL_MS = 1500
// ~5 minutes of polling before giving up on a single setup job. Large
// monorepos can legitimately take a while; beyond this we stop polling and
// let the row fall back to the normal pending/indexed pill on next refresh.
const MAX_POLL_ATTEMPTS = 200

const ICONS = {
  search: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
  reindex: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  close: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  ),
}

const STATUS_PILL_TONE = {
  neutral: 'qx-pill--ghost',
  good: 'qx-pill--success',
  bad: 'qx-pill--critical',
  pending: 'qx-pill--purple',
}

function StatusPill({ children, tone = 'neutral' }) {
  const toneClass = STATUS_PILL_TONE[tone] || STATUS_PILL_TONE.neutral
  return <span className={`qx-pill qx-pill--xs ${toneClass}`}>{children}</span>
}

function SectionCard({ title, subtitle, children }) {
  return (
    <section className="qx-card">
      <h2>{title}</h2>
      {subtitle && <p className="qx-hint">{subtitle}</p>}
      {children}
    </section>
  )
}

export default function ManageRepos() {
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id || null
  const navigate = useNavigate()

  // Shared with the rest of the RepoBrain surface via RepoBrainContext, so this
  // tab no longer runs its own getHealth() probe on mount.
  const { health, reason, refresh: refreshStatus } = useRepoBrainStatus()

  // Current targets list
  const [targets, setTargets] = useState([])
  const [targetsLoading, setTargetsLoading] = useState(true)

  // Add-by-URL form
  const [repoUrl, setRepoUrl] = useState('')
  const [pin, setPin] = useState('main')
  const [description, setDescription] = useState('')
  const [urlSubmitting, setUrlSubmitting] = useState(false)
  const [urlResult, setUrlResult] = useState(null)

  // GitHub connect
  const [githubMapping, setGithubMapping] = useState(undefined) // undefined = loading, null = not connected
  const [githubRepos, setGithubRepos] = useState([])
  const [githubReposLoading, setGithubReposLoading] = useState(false)
  const [githubError, setGithubError] = useState(null)
  const [selectedRepos, setSelectedRepos] = useState(() => new Set())
  const [githubSubmitting, setGithubSubmitting] = useState(false)
  const [githubResults, setGithubResults] = useState([])

  // Wave 3: live setup progress per target_id, lazy per-row stats, toast
  // feedback, and inline re-index confirm.
  const [progressByTarget, setProgressByTarget] = useState({})
  const [statsByTarget, setStatsByTarget] = useState({})
  const [toast, setToast] = useState(null) // { message, kind }
  const [reindexConfirm, setReindexConfirm] = useState(null) // target_id awaiting confirm

  const pollTimers = useRef({})     // target_id -> interval id
  const pollAttempts = useRef({})   // target_id -> attempt count
  const loadedStats = useRef(new Set()) // target_ids whose stats have been fetched at least once

  const loadTargets = useCallback(async () => {
    setTargetsLoading(true)
    const t = await getTargets()
    setTargets(Array.isArray(t) ? t : [])
    setTargetsLoading(false)
  }, [])

  useEffect(() => { loadTargets() }, [loadTargets])

  const showToast = useCallback((message, kind = 'success') => {
    setToast({ message, kind })
    setTimeout(() => setToast(null), 5000)
  }, [])

  // Stop + clear any in-flight poll for a target (unmount and completion both
  // route through here so there is one place that clears the interval).
  const stopPolling = useCallback((targetId) => {
    const timer = pollTimers.current[targetId]
    if (timer) {
      clearInterval(timer)
      delete pollTimers.current[targetId]
    }
    delete pollAttempts.current[targetId]
  }, [])

  useEffect(() => {
    return () => {
      Object.values(pollTimers.current).forEach(clearInterval)
    }
  }, [])

  // Poll getSetupStatus(targetId) until it reaches a terminal state
  // (ready/error/not_found) or the attempt cap is hit. repoLabel is only
  // used for the toast copy (falls back to the target_id).
  const startPolling = useCallback((targetId, repoLabel) => {
    if (!targetId) return
    stopPolling(targetId)
    pollAttempts.current[targetId] = 0
    setProgressByTarget(prev => ({ ...prev, [targetId]: { status: 'registered', progress: 0 } }))

    const clearProgress = () => {
      setProgressByTarget(prev => {
        if (!(targetId in prev)) return prev
        const next = { ...prev }
        delete next[targetId]
        return next
      })
    }

    const tick = async () => {
      pollAttempts.current[targetId] = (pollAttempts.current[targetId] || 0) + 1
      const setupStatus = await getSetupStatus(targetId)
      const status = setupStatus?.status || 'error'

      if (status === 'ready') {
        stopPolling(targetId)
        clearProgress()
        const stats = await getTargetStats(targetId)
        const fileCount = stats?.file_count
        showToast(
          `${repoLabel || targetId} indexed. ${fileCount != null ? `${fileCount} files ready to search.` : 'Ready to search.'}`
        )
        setStatsByTarget(prev => ({ ...prev, [targetId]: stats || {} }))
        loadedStats.current.add(targetId)
        loadTargets()
        refreshStatus()
        return
      }

      if (status === 'error' || status === 'not_found') {
        stopPolling(targetId)
        clearProgress()
        showToast(
          `${repoLabel || targetId} failed to index. ${setupStatus?.error || setupStatus?.message || 'Check the job log.'}`,
          'error'
        )
        loadTargets()
        refreshStatus()
        return
      }

      setProgressByTarget(prev => ({
        ...prev,
        [targetId]: { status, progress: setupStatus?.progress ?? prev[targetId]?.progress ?? 0 },
      }))

      if (pollAttempts.current[targetId] >= MAX_POLL_ATTEMPTS) {
        stopPolling(targetId)
        clearProgress()
        showToast(`${repoLabel || targetId} is still indexing. Check back later.`, 'warn')
        loadTargets()
        refreshStatus()
      }
    }

    tick()
    pollTimers.current[targetId] = setInterval(tick, POLL_INTERVAL_MS)
  }, [stopPolling, showToast, loadTargets, refreshStatus])

  // Lazy-load per-target stats (file/chunk counts, last indexed) one at a
  // time so the list itself never blocks on it.
  useEffect(() => {
    let cancelled = false
    async function loadNext() {
      if (cancelled) return
      const next = targets.find(t => t.is_cached && !loadedStats.current.has(t.target_id))
      if (!next) return
      loadedStats.current.add(next.target_id)
      const stats = await getTargetStats(next.target_id)
      if (cancelled) return
      setStatsByTarget(prev => ({ ...prev, [next.target_id]: stats || {} }))
      loadNext()
    }
    loadNext()
    return () => { cancelled = true }
  }, [targets])

  // Look up whether this org has connected the GitHub plugin.
  useEffect(() => {
    let alive = true
    if (!orgId || !authFetch) { setGithubMapping(null); return undefined }
    authFetch(`/api/orgs/${orgId}/github`)
      .then(res => (res.ok ? res.json() : { mappings: [] }))
      .then(data => { if (alive) setGithubMapping((data.mappings || [])[0] || null) })
      .catch(() => { if (alive) setGithubMapping(null) })
    return () => { alive = false }
  }, [orgId, authFetch])

  // Once connected, list that GitHub org's repos.
  useEffect(() => {
    let alive = true
    if (!githubMapping?.github_org_login) { setGithubRepos([]); return undefined }
    setGithubReposLoading(true)
    setGithubError(null)
    fetchRepos(null, githubMapping.github_org_login)
      .then(repos => { if (alive) setGithubRepos(Array.isArray(repos) ? repos : []) })
      .catch(err => { if (alive) setGithubError(err.message) })
      .finally(() => { if (alive) setGithubReposLoading(false) })
    return () => { alive = false }
  }, [githubMapping])

  const handleAddByUrl = useCallback(async (e) => {
    e.preventDefault()
    if (!repoUrl.trim()) return
    setUrlSubmitting(true)
    setUrlResult(null)
    // A single setupTarget call registers the target and submits the
    // clone+index job in one request. The engine already does the cloning
    // and indexing, this is only the front door.
    const result = await setupTarget({
      repoUrl: repoUrl.trim(),
      pin: pin.trim() || 'main',
      description: description.trim(),
    })
    setUrlSubmitting(false)
    if (result.error) {
      setUrlResult({ error: result.error })
    } else {
      setUrlResult({ targetId: result.target_id, jobId: result.job_id, status: result.status })
      setRepoUrl('')
      setDescription('')
      loadTargets()
      refreshStatus()
      startPolling(result.target_id, result.target_id)
    }
  }, [repoUrl, pin, description, loadTargets, refreshStatus, startPolling])

  const toggleRepo = useCallback((fullName) => {
    setSelectedRepos(prev => {
      const next = new Set(prev)
      if (next.has(fullName)) next.delete(fullName)
      else next.add(fullName)
      return next
    })
  }, [])

  const handleAddSelectedGithubRepos = useCallback(async () => {
    if (selectedRepos.size === 0) return
    setGithubSubmitting(true)
    setGithubResults([])
    const results = []
    for (const fullName of selectedRepos) {
      const repo = githubRepos.find(r => (r.full_name || r.name) === fullName)
      if (!repo) continue
      const cloneUrl = cloneUrlForRepo(repo)
      const targetId = slugifyTargetId(repo.name)
      const result = await setupTarget({
        sourceType: 'remote_git_https',
        // Private repos borrow the org's own GitHub credential at clone/fetch
        // time (the collector stamps the org; the engine never stores the token).
        sourceConfig: { repo_url: cloneUrl, pin: repo.default_branch || 'main', ...(repo.private ? { auth: 'org_github' } : {}) },
        targetId,
        description: repo.description || '',
      })
      results.push({ name: fullName, ...result })
      if (!result.error && result.target_id) {
        startPolling(result.target_id, fullName)
      }
    }
    setGithubSubmitting(false)
    setGithubResults(results)
    setSelectedRepos(new Set())
    loadTargets()
    refreshStatus()
  }, [selectedRepos, githubRepos, loadTargets, refreshStatus, startPolling])

  const handleSearchThisRepo = useCallback((targetId) => {
    navigate(`/nucleus?tab=search&repo=${encodeURIComponent(targetId)}`)
  }, [navigate])

  const handleReindex = useCallback(async (target) => {
    setReindexConfirm(null)
    const result = await setupTarget({
      sourceType: target.source_type,
      sourceConfig: target.source_config,
      targetId: target.target_id,
      description: target.description || '',
    })
    if (result.error) {
      showToast(`Could not re-index ${target.target_id}. ${result.error}`, 'error')
      return
    }
    loadTargets()
    refreshStatus()
    startPolling(target.target_id, target.target_id)
  }, [loadTargets, refreshStatus, startPolling, showToast])

  // Still probing (health === 'checking'), including retries through a cold-start.
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

  // Session has no resolved organisation context (401). The engine may be fine;
  // this is a session issue, not a downed engine.
  if (health === 'unauthorized') {
    return (
      <div className="qx-view">
        <div className="qx-empty">
          <div className="qx-empty__title">Repos needs organisation context</div>
          <div className="qx-empty__body">
            {reason || 'Organisation context required for RepoBrain.'}
          </div>
          <div className="qx-empty__body">
            The RepoBrain engine itself may be reachable. Try reloading the page or
            signing out and back in. If it keeps happening, contact your workspace
            admin.
          </div>
        </div>
      </div>
    )
  }

  // RepoBrain isn't licensed for this org (403). Again, a licensing gate, not a
  // downed engine.
  if (health === 'unlicensed') {
    return (
      <div className="qx-view">
        <div className="qx-empty">
          <div className="qx-empty__title">Repos isn't licensed for this workspace</div>
          <div className="qx-empty__body">
            {reason || 'RepoBrain is not licensed for this organisation.'}
          </div>
          <div className="qx-empty__body">
            The RepoBrain engine itself may be reachable. Ask your workspace admin
            to enable the RepoBrain plugin for this organisation.
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
          <div className="qx-empty__title">No RepoBrain engine connected yet</div>
          <div className="qx-empty__body">
            This is where you connect repositories for RepoBrain to index, so your
            agents can search and cite your code. It needs a RepoBrain engine
            connected to this workspace, and there isn't one reachable right now.
          </div>
          <div className="qx-empty__body">
            If you manage this workspace, connect a RepoBrain engine to start adding
            repositories. If not, your workspace admin can turn it on.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="qx-view qx-pad">
      <div className="qx-stack">
        <div>
          <h1>Manage Repos</h1>
          <p className="qx-hint">
            Connect a repository so RepoBrain can clone it, index it, and answer
            structure-first questions about your code with file and line citations.
          </p>
        </div>

        {/* Add by URL */}
        <SectionCard
          title="Add a repo by URL"
          subtitle="Paste a Git URL and a branch, tag, or commit to pin. RepoBrain clones and indexes it in the background."
        >
          <form onSubmit={handleAddByUrl} className="qx-stack qx-stack--tight">
            <input
              type="text"
              className="qx-input"
              placeholder="https://github.com/org/repo.git"
              value={repoUrl}
              onChange={e => setRepoUrl(e.target.value)}
            />
            <div className="qx-row">
              <input
                type="text"
                className="qx-input qx-input--narrow"
                placeholder="main"
                value={pin}
                onChange={e => setPin(e.target.value)}
                title="Branch, tag, or commit"
              />
              <input
                type="text"
                className="qx-input qx-input--grow"
                placeholder="Description (optional)"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
              <button
                type="submit"
                className="qx-btn qx-btn--sm"
                disabled={!repoUrl.trim() || urlSubmitting}
              >
                {urlSubmitting ? 'Adding...' : 'Add repo'}
              </button>
            </div>
          </form>

          {urlResult?.error && (
            <div className="qx-banner qx-banner--error">
              <div>
                <span className="qx-banner__title">Could not add repo</span>
                {urlResult.error}
              </div>
            </div>
          )}
          {urlResult?.targetId && !urlResult.error && (
            <p className="qx-hint qx-hint--success">
              Added <code className="qx-code">{urlResult.targetId}</code>. Cloning and indexing started in the background (job {urlResult.jobId}).
              Progress shows below.
            </p>
          )}
        </SectionCard>

        {/* Connect GitHub */}
        <SectionCard
          title="Connect GitHub"
          subtitle="Pick repos from the GitHub organisation this workspace already connected."
        >
          {githubMapping === undefined && (
            <p className="qx-hint">Checking GitHub connection...</p>
          )}

          {githubMapping === null && (
            <p className="qx-hint">
              No GitHub organisation is connected for this workspace yet. Connect one in the{' '}
              <a href="/github">GitHub plugin</a>, then come back here to pick repos.
            </p>
          )}

          {githubMapping && (
            <>
              <p className="qx-hint">
                Connected to <strong>{githubMapping.github_org_login}</strong>.
              </p>

              {githubReposLoading && (
                <p className="qx-hint">Loading repositories...</p>
              )}

              {githubError && !githubReposLoading && (
                <div className="qx-banner qx-banner--error">
                  <div>
                    <span className="qx-banner__title">Could not load repositories</span>
                    {githubError}
                  </div>
                </div>
              )}

              {!githubReposLoading && !githubError && githubRepos.length === 0 && (
                <p className="qx-hint">No repositories found for this organisation.</p>
              )}

              {!githubReposLoading && !githubError && githubRepos.length > 0 && (
                <div className="qx-stack qx-stack--tight">
                  <div className="qx-scroll-list">
                    {githubRepos.map(r => {
                      const fullName = r.full_name || r.name
                      return (
                        <label key={fullName} className="qx-checkbox">
                          <input
                            type="checkbox"
                            checked={selectedRepos.has(fullName)}
                            onChange={() => toggleRepo(fullName)}
                          />
                          <span className="qx-checkbox__box" />
                          <code className="qx-code">{fullName}</code>
                          {r.private && <StatusPill>private</StatusPill>}
                        </label>
                      )
                    })}
                  </div>

                  <button
                    className="qx-btn qx-btn--sm"
                    onClick={handleAddSelectedGithubRepos}
                    disabled={selectedRepos.size === 0 || githubSubmitting}
                  >
                    {githubSubmitting ? 'Adding...' : `Add ${selectedRepos.size || ''} selected repo${selectedRepos.size === 1 ? '' : 's'}`.trim()}
                  </button>

                  {githubResults.length > 0 && (
                    <div className="qx-stack qx-stack--tight">
                      {githubResults.map(r => (
                        <div key={r.name} className={`qx-hint qx-hint--sm ${r.error ? 'qx-hint--danger' : 'qx-hint--success'}`}>
                          {r.name}: {r.error ? r.error : `queued (job ${r.job_id})`}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </SectionCard>

        {/* Current targets */}
        <SectionCard title="Current repos" subtitle="Every target RepoBrain knows about for this deployment.">
          {targetsLoading && (
            <p className="qx-hint">Loading...</p>
          )}
          {!targetsLoading && targets.length === 0 && (
            <p className="qx-hint">No repos added yet.</p>
          )}
          {!targetsLoading && targets.length > 0 && (
            <div className="qx-stack qx-stack--tight">
              {targets.map(t => {
                const activeProgress = progressByTarget[t.target_id]
                const stats = statsByTarget[t.target_id]
                const isConfirmingReindex = reindexConfirm === t.target_id
                const statsAge = stats?.last_sync ? relativeTime(stats.last_sync) : null

                return (
                  <div key={t.target_id} className="qx-host-row">
                    <span className={`qx-dot qx-host-row__dot ${t.is_cached ? 'qx-dot--online' : 'qx-dot--loading'}`} />
                    <div className="qx-host-row__body">
                      <span className="qx-host-row__primary">{t.target_id}</span>
                      <span className="qx-host-row__secondary">{t.source_type}</span>

                      {activeProgress && (
                        <div className="qx-stack qx-stack--tight" style={{ marginTop: 6, maxWidth: 280 }}>
                          <div
                            className="qx-progress qx-progress--brand"
                            style={{ '--qx-progress': Math.min(100, Math.max(0, activeProgress.progress || 0)) / 100 }}
                          />
                          <span className="qx-pill qx-pill--xs qx-pill--purple">
                            {stageLabel(activeProgress.status, activeProgress.progress)}
                          </span>
                        </div>
                      )}

                      {!activeProgress && (stats?.file_count != null || statsAge) && (
                        <span className="qx-host-row__meta">
                          {stats?.file_count != null ? `${stats.file_count} files` : ''}
                          {stats?.file_count != null && statsAge ? ' · ' : ''}
                          {statsAge ? `indexed ${statsAge}` : ''}
                        </span>
                      )}
                    </div>

                    {t.is_builtin && <StatusPill tone="neutral">builtin</StatusPill>}
                    {!activeProgress && (
                      <StatusPill tone={t.is_cached ? 'good' : 'pending'}>
                        {t.is_cached ? 'indexed' : 'pending'}
                      </StatusPill>
                    )}

                    {!t.is_builtin && (
                      <div className="qx-row-actions">
                        <button
                          type="button"
                          className="qx-row-action"
                          title="Search this repo"
                          onClick={() => handleSearchThisRepo(t.target_id)}
                        >
                          {ICONS.search}
                        </button>

                        {!isConfirmingReindex ? (
                          <button
                            type="button"
                            className="qx-row-action"
                            title="Re-index"
                            disabled={!!activeProgress}
                            onClick={() => setReindexConfirm(t.target_id)}
                          >
                            {ICONS.reindex}
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="qx-row-action"
                              title="Confirm re-index"
                              onClick={() => handleReindex(t)}
                            >
                              {ICONS.check}
                            </button>
                            <button
                              type="button"
                              className="qx-row-action"
                              title="Cancel"
                              onClick={() => setReindexConfirm(null)}
                            >
                              {ICONS.close}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>

      {toast && (
        <div className="qx-toast-stack">
          <div className={`qx-toast qx-toast--${toast.kind}`} role="status" aria-live="polite">
            <div className="qx-toast__body">
              <div className="qx-toast__msg">{toast.message}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import * as githubClient from '../../services/githubClient'
import {
  FLEET_LABELS, DEFAULT_REPO, inferGripe, buildTitle, buildBody, splitRepo, normaliseRepo,
} from './gripeInference'
import { buildVulcanSeedFromGripe } from '../gitq/sendToVulcan'

/**
 * The Gripe pad: one textarea, a live preview of the inferred repo + fleet
 * label (same deterministic tables as the GRIPE agent), editable repo / label /
 * title, and a File button that goes through the governed POST /github/issues.
 *
 * Honesty rules: "Filed" is only shown with a real issue URL. A held-for-approval
 * response is shown as held, with a link to Approvals. Errors are quoted verbatim.
 */
export function issueUrlOf(result) {
  const issue = result?.issue
  return issue?.html_url || issue?.url || null
}

export default function GripePad({ onFiled, onSendToVulcan }) {
  const [text, setText] = useState('')
  const [repoEdit, setRepoEdit] = useState(null)
  const [labelEdit, setLabelEdit] = useState(null)
  const [titleEdit, setTitleEdit] = useState(null)
  const [repoOptions, setRepoOptions] = useState([])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null) // { kind: 'filed'|'pending'|'no-url'|'error', ... }

  const inferred = useMemo(() => inferGripe(text), [text])
  const repo = normaliseRepo(repoEdit ?? inferred.repo)
  const label = labelEdit ?? inferred.label
  const title = titleEdit ?? buildTitle(inferred.text)

  // Repos the org's GitHub connector can see (server-side token; the browser
  // only holds the org name + selected repo names as preferences).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const config = githubClient.getConfig()
      const org = config?.orgName
      let names = (config?.selectedRepos || []).map((r) => (org && !r.includes('/') ? `${org}/${r}` : r))
      if (org) {
        try {
          const repos = await githubClient.fetchRepos(null, org)
          if (Array.isArray(repos) && repos.length) names = repos.map((r) => r.full_name || `${org}/${r.name}`)
        } catch { /* fall back to the selected repos */ }
      }
      if (!cancelled) setRepoOptions(names)
    })()
    return () => { cancelled = true }
  }, [])

  const options = useMemo(() => {
    const set = new Set(repoOptions)
    set.add(DEFAULT_REPO)
    if (repo) set.add(repo)
    return [...set].sort()
  }, [repoOptions, repo])

  const canFile = !busy && inferred.text.trim().length > 0 && title.trim().length > 0 && !!repo

  async function file() {
    if (!canFile) return
    setBusy(true)
    setOutcome(null)
    try {
      const { owner, name } = splitRepo(repo)
      const result = await githubClient.createIssueGoverned(owner, name, {
        title: title.trim(),
        body: buildBody(inferred.text, { repoDefaulted: inferred.repoDefaulted && repoEdit == null }),
        labels: [label],
      })
      const url = issueUrlOf(result)
      if (url) {
        setOutcome({ kind: 'filed', url, number: result.issue?.number, repo })
        onFiled?.({ url, repo, title: title.trim(), label })
        setText(''); setRepoEdit(null); setLabelEdit(null); setTitleEdit(null)
      } else if (result?.pending) {
        setOutcome({ kind: 'pending', message: result.message || result.error || null })
      } else {
        setOutcome({ kind: 'no-url' })
      }
    } catch (err) {
      setOutcome({ kind: 'error', message: err?.message || String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="qx-stack">
      <div className="qx-field">
        <label className="qx-label" htmlFor="gripe-text">What bugs you?</label>
        <textarea
          id="gripe-text"
          className="qx-textarea"
          rows={3}
          placeholder="e.g. sidebar tooltip clips on resize"
          value={text}
          onChange={(e) => { setText(e.target.value); setOutcome(null) }}
        />
        <div className="qx-hint qx-hint--sm">
          Override with <code>repo:name</code> or <code>label:fleet/qa</code> anywhere in the line.
        </div>
      </div>

      {text.trim() && (
        <div className="qx-row qx-row--tight" aria-label="Inferred routing" style={{ flexWrap: 'wrap' }}>
          <span className="qx-pill">{repo}{inferred.repoDefaulted && repoEdit == null ? ' (default)' : ''}</span>
          <span className="qx-pill">{label}{inferred.labelDefaulted && labelEdit == null ? ' (default)' : ''}</span>
        </div>
      )}

      <div className="qx-row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="qx-field" style={{ minWidth: 240 }}>
          <label className="qx-label" htmlFor="gripe-repo">Repo</label>
          <select
            id="gripe-repo"
            className="qx-select"
            value={repo}
            onChange={(e) => setRepoEdit(e.target.value)}
          >
            {options.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="qx-field">
          <span className="qx-label">Label</span>
          <div className="qx-row qx-row--tight" role="group" aria-label="Fleet label" style={{ flexWrap: 'wrap' }}>
            {FLEET_LABELS.map((l) => (
              <button
                key={l}
                type="button"
                className={`qx-chip ${label === l ? 'qx-chip--active' : ''}`}
                aria-pressed={label === l}
                onClick={() => setLabelEdit(l)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="qx-field">
        <label className="qx-label" htmlFor="gripe-title">Title</label>
        <input
          id="gripe-title"
          className="qx-input"
          type="text"
          value={title}
          onChange={(e) => setTitleEdit(e.target.value)}
        />
      </div>

      <div className="qx-row">
        <button type="button" className="glass-btn" onClick={file} disabled={!canFile}>
          {busy ? 'Filing...' : 'File'}
        </button>
        <button
          type="button"
          className="glass-btn"
          onClick={() => onSendToVulcan?.(buildVulcanSeedFromGripe(inferred.text))}
          disabled={!inferred.text.trim()}
          title="Hand this gripe to Vulcan for triage instead of filing it"
        >
          Send to Vulcan
        </button>
      </div>

      {outcome?.kind === 'filed' && (
        <div className="qx-banner qx-banner--success" role="status">
          Filed in {outcome.repo}:{' '}
          <a href={outcome.url} target="_blank" rel="noopener noreferrer">{outcome.url}</a>
        </div>
      )}
      {outcome?.kind === 'pending' && (
        <div className="qx-banner qx-banner--warn" role="status">
          Not filed yet: held for human approval.{outcome.message ? ` ${outcome.message}` : ''}{' '}
          <a href="/inbox">Open Approvals</a>
        </div>
      )}
      {outcome?.kind === 'no-url' && (
        <div className="qx-banner qx-banner--warn" role="status">
          No issue URL came back, so treat this as NOT filed until you can see the issue.
        </div>
      )}
      {outcome?.kind === 'error' && (
        <div className="qx-banner qx-banner--error" role="alert">{outcome.message}</div>
      )}
    </div>
  )
}

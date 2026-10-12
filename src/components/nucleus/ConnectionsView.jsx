/**
 * ConnectionsView — cross-repo import heatmap.
 *
 * Stream QN Wave 4. Computes a repo x repo matrix client-side from the same
 * /graph-data.json the Graph tab loads: cell[A][B] = count of import edges
 * from a file in repo A to a file in repo B. The diagonal is intra-repo
 * import volume (labelled as such, not hidden).
 */
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRepoBrainStatus } from './RepoBrainContext'

const GRAPH_DATA_URL = '/graph-data.json'

function buildMatrix(data) {
  const nodeRepoById = new Map()
  data.nodes.filter(n => n.type === 'file').forEach(n => nodeRepoById.set(n.id, n.repo))

  const repoSet = new Set(nodeRepoById.values())
  const counts = new Map() // `${fromRepo}|${toRepo}` -> count

  data.edges.filter(e => e.type === 'import').forEach(e => {
    const fromRepo = nodeRepoById.get(e.source)
    const toRepo = nodeRepoById.get(e.target)
    if (!fromRepo || !toRepo) return
    const key = `${fromRepo}|${toRepo}`
    counts.set(key, (counts.get(key) || 0) + 1)
  })

  const repos = Array.from(repoSet).sort()
  let max = 0
  counts.forEach(v => { if (v > max) max = v })

  return { repos, counts, max }
}

export default function ConnectionsView() {
  const navigate = useNavigate()
  const { health, reason } = useRepoBrainStatus()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [matrix, setMatrix] = useState(null)

  useEffect(() => {
    if (health === 'checking') return undefined

    // Session has no resolved organisation context (401): not the engine being
    // down, so name the actual remedy instead.
    if (health === 'unauthorized') {
      setError(
        `${reason || 'Organisation context required for RepoBrain.'} The engine itself may be reachable. Try reloading the page or signing out and back in.`
      )
      setLoading(false)
      return undefined
    }

    // RepoBrain isn't licensed for this org (403): a licensing gate, not a
    // downed engine.
    if (health === 'unlicensed') {
      setError(
        `${reason || 'RepoBrain is not licensed for this organisation.'} Ask your workspace admin to enable the RepoBrain plugin for this organisation.`
      )
      setLoading(false)
      return undefined
    }

    if (health === 'offline') {
      setError(
        "Connections needs a RepoBrain engine connected to this workspace. If you manage this workspace, connect one and index a repository; otherwise your admin can turn it on."
      )
      setLoading(false)
      return undefined
    }

    let destroyed = false
    async function load() {
      try {
        const res = await fetch(GRAPH_DATA_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (destroyed) return
        setMatrix(buildMatrix(data))
        setLoading(false)
      } catch (err) {
        if (!destroyed) {
          setError(err.message)
          setLoading(false)
        }
      }
    }
    load()
    return () => { destroyed = true }
  }, [health, reason])

  function openGraph(fromRepo, toRepo) {
    navigate(`/nucleus?tab=graph&repoA=${encodeURIComponent(fromRepo)}&repoB=${encodeURIComponent(toRepo)}`)
  }

  if (loading) {
    return (
      <div className="qx-card">
        <div className="qx-empty">
          <p>Loading connections...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="qx-card">
        <div className="qx-empty">
          <div className="qx-empty__title">Connections unavailable</div>
          <div className="qx-empty__body">{error}</div>
        </div>
      </div>
    )
  }

  if (!matrix || matrix.repos.length < 2) {
    return (
      <div className="qx-card">
        <div className="qx-empty">
          <div className="qx-empty__title">Connections</div>
          <div className="qx-empty__body">
            Connections maps how your repos depend on each other. It lights up once two or more repos are indexed.
          </div>
        </div>
      </div>
    )
  }

  const { repos, counts, max } = matrix

  return (
    <div className="qx-card qx-stack">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Cross-repo import heatmap</h3>
        <span className="qx-hint">Rows import from &middot; columns import to &middot; diagonal = intra-repo</span>
      </div>

      <div
        className="qx-heatmap"
        style={{ gridTemplateColumns: `140px repeat(${repos.length}, minmax(72px, 1fr))` }}
      >
        <div />
        {repos.map(repo => (
          <div key={`col-${repo}`} className="qx-heatmap__label" style={{ textAlign: 'center' }}>
            {repo}
          </div>
        ))}

        {repos.map(fromRepo => (
          <div key={`row-${fromRepo}-wrap`} style={{ display: 'contents' }}>
            <div className="qx-heatmap__label" style={{ display: 'flex', alignItems: 'center' }}>
              {fromRepo}
            </div>
            {repos.map(toRepo => {
              const count = counts.get(`${fromRepo}|${toRepo}`) || 0
              const intensity = max ? count / max : 0
              const isDiag = fromRepo === toRepo
              return (
                <div
                  key={`${fromRepo}-${toRepo}`}
                  className="qx-heatmap__cell"
                  style={{ '--qx-cell-intensity': intensity }}
                  onClick={() => openGraph(fromRepo, toRepo)}
                  title={`${fromRepo} → ${toRepo}: ${count} import${count === 1 ? '' : 's'}${isDiag ? ' (intra-repo)' : ''}`}
                >
                  <span className="qx-heatmap__val">{count}</span>
                  {isDiag && <span className="qx-hint qx-hint--sm">intra</span>}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * InstanceSettingsPanel (SETEC S2).
 *
 * Read-only table of every non-secret setting this Quox instance reads from
 * its environment. The server decides what may be shown (allowlist
 * projection); this component renders `row.value` ONLY when the server said
 * shown === 'value', so a secret can never reach the DOM from here.
 */
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../contexts/AuthContext'
import { fetchInstanceSettings } from '../../../services/instanceSettingsClient'

const CLASS_LABEL = { instance: 'Server configuration', infra: 'Infrastructure', user: 'User-facing (env defaults)', secret: 'Secrets (set or not set only)' }
const CLASS_ORDER = ['instance', 'infra', 'user', 'secret']

function valueCell(row) {
  if (row.shown === 'value') return <code>{row.value}</code>
  if (row.shown === 'not-reported') return <span className="qx-pill qx-pill--ghost qx-pill--sm">not reported yet</span>
  return row.isSet
    ? <span className="qx-pill qx-pill--online qx-pill--sm">set</span>
    : <span className="qx-pill qx-pill--ghost qx-pill--sm">not set</span>
}

function sourceCell(row) {
  if (row.shown === 'not-reported') return 'unknown'
  return row.source === 'env' ? 'environment' : 'unset'
}

function readBy(row) {
  const list = (row.services || []).join(', ')
  if (row.shown === 'not-reported') return `read by ${list}, value not reported yet`
  return list
}

export default function InstanceSettingsPanel({ authFetch: authFetchProp }) {
  const ctx = useAuth()
  const authFetch = authFetchProp || ctx?.authFetch
  const [state, setState] = useState({ loading: true, error: null, status: null, data: null })
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let alive = true
    fetchInstanceSettings(authFetch)
      .then((data) => { if (alive) setState({ loading: false, error: null, status: null, data }) })
      .catch((e) => { if (alive) setState({ loading: false, error: e.message, status: e.status || null, data: null }) })
    return () => { alive = false }
  }, [authFetch])

  const groups = useMemo(() => {
    const rows = state.data?.rows || []
    const q = filter.trim().toLowerCase()
    const hit = (r) => !q || r.name.toLowerCase().includes(q) || (r.note || '').toLowerCase().includes(q) || (r.services || []).join(' ').toLowerCase().includes(q)
    const out = []
    for (const cls of CLASS_ORDER) {
      const inClass = rows.filter((r) => r.classification === cls && hit(r))
      if (!inClass.length) continue
      const bySvc = new Map()
      for (const r of inClass) {
        const svc = (r.services && r.services[0]) || 'unknown'
        if (!bySvc.has(svc)) bySvc.set(svc, [])
        bySvc.get(svc).push(r)
      }
      out.push({ cls, services: [...bySvc.entries()].sort((a, b) => a[0].localeCompare(b[0])) })
    }
    return out
  }, [state.data, filter])

  return (
    <div className="qx-pad qx-stack" style={{ maxWidth: 1200 }}>
      <h2 style={{ marginTop: 0 }}>Instance settings</h2>
      <p className="qx-tip" style={{ opacity: 0.85 }}>
        Settings this Quox instance reads from its environment. Values come from the server; secrets are never shown.
        Changing one today means editing the server's environment and restarting the named service; settings that
        should be editable here are being moved into governed settings.
      </p>

      {state.loading && <div className="qx-empty"><div className="qx-empty__title">Loading instance settings</div></div>}

      {!state.loading && state.error && (
        <div className="qx-banner qx-banner--error" role="alert">
          {state.status === 403
            ? 'Only instance administrators can view instance settings. Ask an instance admin for access.'
            : state.error}
        </div>
      )}

      {!state.loading && state.data && (
        <>
          {!state.data.authReported && (
            <div className="qx-banner qx-banner--warn">Auth service did not report its settings, so its rows show as not reported.</div>
          )}
          <input
            className="qx-input"
            placeholder="Filter by name, description or service"
            aria-label="Filter instance settings"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {groups.length === 0 && (
            <div className="qx-empty"><div className="qx-empty__title">No settings match</div></div>
          )}
          {groups.map((g) => (
            <section key={g.cls} className="qx-card qx-stack" data-testid={`group-${g.cls}`}>
              <h3 style={{ margin: 0 }}>{CLASS_LABEL[g.cls] || g.cls}</h3>
              {g.services.map(([svc, rows]) => (
                <div key={svc}>
                  <h4 style={{ margin: '8px 0' }}>{svc}</h4>
                  <table className="qx-table">
                    <thead>
                      <tr><th>Name</th><th>What it does</th><th>Value</th><th>Source</th><th>Read by</th><th>Restart needed</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={`${r.name}:${r.reportedBy || 'x'}`}>
                          <td><code>{r.name}</code></td>
                          <td>{r.note || ''}</td>
                          <td>{valueCell(r)}</td>
                          <td>{sourceCell(r)}</td>
                          <td>{readBy(r)}</td>
                          <td>{r.restartNeeded ? 'yes' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  )
}

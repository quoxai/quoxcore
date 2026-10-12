/**
 * RepoBrainView — unified RepoBrain surface.
 *
 * Four sidebar/route entries collapse into one tabbed hub:
 *   ?tab=search      -> CodeSearch (labelled "Nucleus", the query face)
 *   ?tab=graph       -> CodebaseGraph
 *   ?tab=repos       -> ManageRepos
 *   ?tab=connections -> ConnectionsView (cross-repo import heatmap)
 *
 * /nucleus/graph and /nucleus/repos redirect here with the matching ?tab=
 * so old bookmarks and links keep working (see App.jsx).
 *
 * QN Phase 3.
 */
import { useSearchParams } from 'react-router-dom'
import CodeSearch from './CodeSearch'
import CodebaseGraph from './CodebaseGraph'
import ManageRepos from './ManageRepos'
import ConnectionsView from './ConnectionsView'
import HowToUseView from './HowToUseView'
import { RepoBrainProvider, useRepoBrainStatus } from './RepoBrainContext'
import QHorn from '../ui/QHorn'

const TABS = [
  { id: 'search', label: 'Nucleus' },
  { id: 'graph', label: 'Graph' },
  { id: 'repos', label: 'Repos' },
  { id: 'connections', label: 'Connections' },
  { id: 'use', label: 'How to Use' },
]

// Persistent command strip: brand mark, status dot, indexed-repo count,
// query latency, and a shortcut into the Repos tab. Replaces the three
// separate "Connecting to RepoBrain..." probes that used to run per-tab.
function CommandStrip({ onAddRepo }) {
  const { health, targetCount, lastQueryMs } = useRepoBrainStatus()

  // 'offline', 'unauthorized' and 'unlicensed' all render as the offline dot/pill
  // style (none of them mean the engine is usable right now), but the pill TEXT
  // stays distinct per fleet issue #363: a session/licence gate must not read as
  // "engine offline", or a user with a healthy engine goes and restarts it.
  const notConnected = health === 'offline' || health === 'unauthorized' || health === 'unlicensed'
  const dotClass = health === 'online' ? 'qx-dot--online' : notConnected ? 'qx-dot--offline' : 'qx-dot--loading'
  const pillClass = health === 'online' ? 'qx-pill--online' : notConnected ? 'qx-pill--offline' : 'qx-pill--ghost'
  const pillText = health === 'online'
    ? `${targetCount} repos indexed`
    : health === 'offline'
      ? 'engine offline'
      : health === 'unauthorized'
        ? 'sign-in required'
        : health === 'unlicensed'
          ? 'not licensed'
          : 'checking...'

  return (
    <div className="qx-card qx-card--bar qx-row qx-row--apart">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <QHorn size={18} />
        <strong>RepoBrain</strong>
        <span className={`qx-dot ${dotClass}`} aria-hidden="true" />
        <span className={`qx-pill ${pillClass} qx-pill--xs`}>{pillText}</span>
      </div>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        {lastQueryMs != null && (
          <span className="qx-pill qx-pill--info qx-pill--xs">{lastQueryMs}ms</span>
        )}
        <button className="qx-btn qx-btn--primary qx-btn--sm" type="button" onClick={onAddRepo}>
          Add repo
        </button>
      </div>
    </div>
  )
}

export default function RepoBrainView() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') || 'search'

  function switchTab(newTab) {
    const next = new URLSearchParams(params)
    next.set('tab', newTab)
    setParams(next, { replace: true })
  }

  return (
    <RepoBrainProvider>
      <div className="qx-view" style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <CommandStrip onAddRepo={() => switchTab('repos')} />

        <div className="qx-tabs" role="tablist" aria-label="RepoBrain tabs" style={{ marginTop: 16 }}>
          {TABS.map(t => (
            <button
              key={t.id}
              className={`qx-tab${tab === t.id ? ' qx-tab--active' : ''}`}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => switchTab(t.id)}
              type="button"
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', marginTop: 16, overflow: 'auto' }}>
          {tab === 'search' && <CodeSearch />}
          {tab === 'graph' && <CodebaseGraph />}
          {tab === 'repos' && <ManageRepos />}
          {tab === 'connections' && <ConnectionsView />}
          {tab === 'use' && <HowToUseView />}
        </div>
      </div>
    </RepoBrainProvider>
  )
}

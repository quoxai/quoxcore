import { useState, useEffect, useCallback } from 'react'

const ACCENT = '#4f46e5'
const ACCENT_LIGHT = 'rgba(79, 70, 229, 0.1)'

const styles = {
  container: {
    padding: '24px',
    maxWidth: '1400px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '24px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  scanBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 16px',
    background: ACCENT,
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '16px',
    marginBottom: '24px',
  },
  card: {
    background: 'var(--bg-secondary, rgba(255, 255, 255, 0.05))',
    border: '1px solid var(--border-color, #2a2a3e)',
    borderRadius: '10px',
    padding: '16px',
    transition: 'border-color 0.2s',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '12px',
  },
  cardName: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  cardType: {
    fontSize: '11px',
    padding: '2px 8px',
    borderRadius: '10px',
    background: ACCENT_LIGHT,
    color: ACCENT,
    fontWeight: 500,
    textTransform: 'uppercase',
  },
  metricRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 0',
    fontSize: '13px',
    color: 'var(--text-secondary)',
  },
  metricVal: {
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  badge: (status) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '10px',
    fontWeight: 500,
    background: status === 'pass' ? 'rgba(34, 197, 94, 0.1)' : status === 'warn' ? 'rgba(234, 179, 8, 0.1)' : 'rgba(239, 68, 68, 0.1)',
    color: status === 'pass' ? '#22c55e' : status === 'warn' ? '#eab308' : '#ef4444',
  }),
  section: {
    marginBottom: '24px',
  },
  sectionTitle: {
    fontSize: '18px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  },
  th: {
    textAlign: 'left',
    padding: '8px 12px',
    borderBottom: '1px solid var(--border-color, #2a2a3e)',
    color: 'var(--text-secondary)',
    fontWeight: 500,
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  td: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--border-color, rgba(42, 42, 62, 0.5))',
    color: 'var(--text-primary)',
  },
  empty: {
    textAlign: 'center',
    padding: '60px 20px',
    color: 'var(--text-secondary)',
  },
  emptyTitle: {
    fontSize: '20px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: '8px',
  },
  scanInput: {
    display: 'flex',
    gap: '8px',
    marginBottom: '16px',
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    background: 'var(--bg-secondary, rgba(255, 255, 255, 0.05))',
    border: '1px solid var(--border-color, #2a2a3e)',
    borderRadius: '6px',
    color: 'var(--text-primary)',
    fontSize: '14px',
  },
  expandBtn: {
    background: 'none',
    border: 'none',
    color: ACCENT,
    cursor: 'pointer',
    fontSize: '13px',
    padding: '4px 0',
  },
  registryTree: {
    paddingLeft: '16px',
    fontSize: '12px',
    color: 'var(--text-secondary)',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  changeItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderBottom: '1px solid var(--border-color, rgba(42, 42, 62, 0.3))',
    fontSize: '13px',
  },
  changeType: (type) => ({
    fontSize: '11px',
    padding: '1px 6px',
    borderRadius: '4px',
    fontWeight: 500,
    background: type === 'added' ? 'rgba(34, 197, 94, 0.15)' : type === 'removed' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)',
    color: type === 'added' ? '#22c55e' : type === 'removed' ? '#ef4444' : '#3b82f6',
  }),
}

export default function CodebaseMirrorView() {
  const [projects, setProjects] = useState([])
  const [selectedProject, setSelectedProject] = useState(null)
  const [scanDetail, setScanDetail] = useState(null)
  const [changes, setChanges] = useState([])
  const [scanPath, setScanPath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)
  const [expandedRegistries, setExpandedRegistries] = useState({})

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch('/collector/api/v1/codebase/projects')
      if (res.ok) {
        const data = await res.json()
        if (data.success) setProjects(data.projects || [])
      }
    } catch { /* silent */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])

  const triggerScan = async (path) => {
    if (!path || scanning) return
    setScanning(true)
    try {
      const res = await fetch('/collector/api/v1/codebase/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      if (res.ok) {
        await loadProjects()
        setScanPath('')
      }
    } catch { /* silent */ }
    setScanning(false)
  }

  const loadProjectDetail = async (projectPath) => {
    setSelectedProject(projectPath)
    try {
      const [scanRes, diffRes] = await Promise.all([
        fetch(`/collector/api/v1/codebase/${encodeURIComponent(projectPath)}`),
        fetch(`/collector/api/v1/codebase/${encodeURIComponent(projectPath)}/diff`),
      ])
      if (scanRes.ok) {
        const data = await scanRes.json()
        if (data.success) setScanDetail(data.scan)
      }
      if (diffRes.ok) {
        const data = await diffRes.json()
        if (data.success) setChanges(data.changes || [])
      }
    } catch { /* silent */ }
  }

  const toggleRegistry = (name) => {
    setExpandedRegistries((prev) => ({ ...prev, [name]: !prev[name] }))
  }

  const timeAgo = (isoStr) => {
    if (!isoStr) return '—'
    const diff = Date.now() - new Date(isoStr).getTime()
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    return `${Math.floor(diff / 86400000)}d ago`
  }

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.empty}>
          <div style={{ color: 'var(--text-secondary)' }}>Loading codebase data...</div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.title}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          Codebase Mirror
        </div>
        <button style={styles.scanBtn} onClick={() => triggerScan('~/quox-dashboard')} disabled={scanning}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
          {scanning ? 'Scanning...' : 'Scan Dashboard'}
        </button>
      </div>

      {/* Scan Input */}
      <div style={styles.scanInput}>
        <input
          style={styles.input}
          placeholder="Enter project path to scan (e.g., ~/quoxflow)"
          value={scanPath}
          onChange={(e) => setScanPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && triggerScan(scanPath)}
        />
        <button style={styles.scanBtn} onClick={() => triggerScan(scanPath)} disabled={scanning || !scanPath}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Scan
        </button>
      </div>

      {projects.length === 0 ? (
        <div style={styles.empty}>
          <div style={styles.emptyTitle}>No Projects Scanned</div>
          <p>Enter a project path above or click "Scan Dashboard" to get started.</p>
          <p style={{ fontSize: '13px', marginTop: '8px' }}>
            The scanner detects project types (React, Go, TypeScript, Rust) and extracts
            registries, routes, services, and schemas.
          </p>
        </div>
      ) : (
        <>
          {/* Project Cards */}
          <div style={styles.section}>
            <div style={styles.sectionTitle}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              Projects ({projects.length})
            </div>
            <div style={styles.grid}>
              {projects.map((p) => (
                <div
                  key={p.project_path}
                  style={{
                    ...styles.card,
                    borderColor: selectedProject === p.project_path ? ACCENT : undefined,
                    cursor: 'pointer',
                  }}
                  onClick={() => loadProjectDetail(p.project_path)}
                >
                  <div style={styles.cardHeader}>
                    <div style={styles.cardName}>{p.project_name}</div>
                    <span style={styles.cardType}>{p.project_type}</span>
                  </div>
                  <div style={styles.metricRow}>
                    <span>Routes</span>
                    <span style={styles.metricVal}>{p.metrics?.routeCount || 0}</span>
                  </div>
                  <div style={styles.metricRow}>
                    <span>Services</span>
                    <span style={styles.metricVal}>{p.metrics?.serviceCount || 0}</span>
                  </div>
                  <div style={styles.metricRow}>
                    <span>Test Files</span>
                    <span style={styles.metricVal}>{p.metrics?.testFileCount || 0}</span>
                  </div>
                  <div style={styles.metricRow}>
                    <span>Registries</span>
                    <span style={styles.metricVal}>{p.metrics?.registryCount || 0}</span>
                  </div>
                  <div style={{ ...styles.metricRow, marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--border-color, rgba(42, 42, 62, 0.5))' }}>
                    <span style={styles.badge(p.invariant_status)}>
                      {p.invariant_status === 'pass' ? '\u2713' : p.invariant_status === 'warn' ? '\u26A0' : '\u2717'} {p.invariant_status}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{timeAgo(p.last_scan)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Registry Explorer */}
          {scanDetail && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                Registry Explorer — {scanDetail.projectName}
              </div>
              {(scanDetail.registries || []).map((reg) => (
                <div key={reg.name} style={{ marginBottom: '8px' }}>
                  <button style={styles.expandBtn} onClick={() => toggleRegistry(reg.name)}>
                    {expandedRegistries[reg.name] ? '\u25BC' : '\u25B6'} {reg.name} ({reg.entryCount} entries) — {reg.file}
                  </button>
                  {expandedRegistries[reg.name] && (
                    <div style={styles.registryTree}>
                      {reg.entries.slice(0, 50).map((entry) => (
                        <div key={entry.id} style={{ padding: '2px 0' }}>
                          {entry.id}{entry.name !== entry.id ? ` — ${entry.name}` : ''}
                        </div>
                      ))}
                      {reg.entries.length > 50 && <div style={{ fontStyle: 'italic' }}>...and {reg.entries.length - 50} more</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Invariant Panel */}
          {scanDetail?.invariantChecks?.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                Invariant Checks
              </div>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Check</th>
                    <th style={styles.th}>Status</th>
                    <th style={styles.th}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {scanDetail.invariantChecks.map((check, i) => (
                    <tr key={i}>
                      <td style={styles.td}>{check.name}</td>
                      <td style={styles.td}><span style={styles.badge(check.status)}>{check.status}</span></td>
                      <td style={styles.td}>{check.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Diff Timeline */}
          {changes.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Changes Since Last Scan ({changes.length})
              </div>
              <div style={{ background: 'var(--bg-secondary, rgba(255, 255, 255, 0.05))', borderRadius: '8px', overflow: 'hidden' }}>
                {changes.slice(0, 30).map((change, i) => (
                  <div key={i} style={styles.changeItem}>
                    <span style={styles.changeType(change.change_type)}>{change.change_type}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{change.element_type}</span>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{change.element_name}</span>
                  </div>
                ))}
                {changes.length > 30 && (
                  <div style={{ ...styles.changeItem, fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                    ...and {changes.length - 30} more changes
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Routes Table */}
          {scanDetail?.routes?.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2">
                  <polyline points="16 18 22 12 16 6" />
                  <polyline points="8 6 2 12 8 18" />
                </svg>
                Routes ({scanDetail.routes.length})
              </div>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Path</th>
                    <th style={styles.th}>Protected</th>
                    <th style={styles.th}>Min Role</th>
                  </tr>
                </thead>
                <tbody>
                  {scanDetail.routes.map((route, i) => (
                    <tr key={i}>
                      <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '12px' }}>{route.path}</td>
                      <td style={styles.td}>{route.protected ? 'Yes' : 'No'}</td>
                      <td style={styles.td}>{route.minRole || '\u2014'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

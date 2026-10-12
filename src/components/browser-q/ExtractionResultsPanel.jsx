/**
 * ExtractionResultsPanel — BQ-CA-2: Results view for BrowserQ
 *
 * Shows saved extraction results + tracked files.
 * Each extraction is expandable with preview + export buttons.
 */

import { useState, useEffect, useCallback } from 'react'
import { listExtractions, deleteExtraction, getExtractionExportUrl, listBrowserFilesApi, getBrowserFileDownloadUrl } from '../../services/browserQService'

const TYPE_COLORS = {
  table: '#06b6d4',
  links: '#a855f7',
  metadata: '#f59e0b',
  schema: '#30ff90',
  template: '#38bdf8',
  generic: 'rgba(255,255,255,0.6)',
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

function ExtractionPreview({ data, type }) {
  if (!data) return <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>No data</div>

  // Table type
  if (type === 'table' && data.tables) {
    return data.tables.map((table, ti) => (
      <div key={ti} style={{ overflowX: 'auto', marginBottom: 8 }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse', fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          <thead>
            <tr>
              {(table.headers || []).map((h, i) => (
                <th key={i} style={{
                  textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid rgba(255,255,255,0.1)',
                  color: '#fff', fontWeight: 600, fontSize: 10, whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(table.rows || []).slice(0, 10).map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{
                    padding: '3px 8px', borderBottom: '1px solid rgba(255,255,255,0.04)',
                    color: '#fff', fontSize: 10, maxWidth: 200, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {(table.rows || []).length > 10 && (
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', padding: '4px 8px' }}>
            ...and {table.rows.length - 10} more rows
          </div>
        )}
      </div>
    ))
  }

  // Links type
  if (type === 'links' && Array.isArray(data)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {data.slice(0, 15).map((link, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span style={{ color: '#a855f7', flexShrink: 0 }}>{'\u2022'}</span>
            <a href={link.href} target="_blank" rel="noopener noreferrer" style={{
              color: '#38bdf8', textDecoration: 'none', overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{link.text || link.href}</a>
          </div>
        ))}
        {data.length > 15 && (
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', paddingLeft: 16 }}>
            ...and {data.length - 15} more links
          </div>
        )}
      </div>
    )
  }

  // Metadata type
  if (type === 'metadata') {
    const entries = Object.entries(data).filter(([, v]) => v && typeof v !== 'object')
    const nested = Object.entries(data).filter(([, v]) => v && typeof v === 'object')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
            <span style={{ color: 'rgba(255,255,255,0.6)', minWidth: 80, flexShrink: 0, fontWeight: 600 }}>{k}</span>
            <span style={{ color: '#fff' }}>{String(v)}</span>
          </div>
        ))}
        {nested.map(([k, v]) => (
          <details key={k} style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontWeight: 600 }}>{k}</summary>
            <pre style={{
              fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.2)',
              padding: 6, borderRadius: 4, margin: '4px 0 0', overflow: 'auto', maxHeight: 150,
            }}>{JSON.stringify(v, null, 2)}</pre>
          </details>
        ))}
      </div>
    )
  }

  // Fallback: JSON
  return (
    <pre style={{
      fontSize: 10, color: '#fff', background: 'rgba(0,0,0,0.2)',
      padding: 8, borderRadius: 4, overflow: 'auto', maxHeight: 200, margin: 0,
    }}>{JSON.stringify(data, null, 2)}</pre>
  )
}

export default function ExtractionResultsPanel({ authFetch, orgId }) {
  const [extractions, setExtractions] = useState([])
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')

  const fetchData = useCallback(async () => {
    if (!authFetch || !orgId) return
    setLoading(true)
    const [ext, f] = await Promise.all([
      listExtractions(authFetch, orgId, { limit: 50 }),
      listBrowserFilesApi(authFetch, orgId),
    ])
    setExtractions(ext)
    setFiles(f)
    setLoading(false)
  }, [authFetch, orgId])

  useEffect(() => { fetchData() }, [fetchData])

  const handleDelete = useCallback(async (id) => {
    if (!confirm('Delete this extraction result?')) return
    await deleteExtraction(authFetch, orgId, id)
    setExtractions(prev => prev.filter(e => e.id !== id))
  }, [authFetch, orgId])

  const handleCopyJson = useCallback(async (data) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    } catch { /* clipboard not available */ }
  }, [])

  const filtered = typeFilter === 'all'
    ? extractions
    : extractions.filter(e => e.extraction_type === typeFilter)

  const types = [...new Set(extractions.map(e => e.extraction_type))]

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        {[1, 2, 3].map(i => (
          <div key={i} style={{ height: 48, borderRadius: 8, background: 'rgba(255,255,255,0.04)', marginBottom: 8, animation: 'bqv-pulse 1.5s ease-in-out infinite' }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ padding: '8px 12px' }}>
      {/* Extractions Section */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
            color: '#fff', letterSpacing: 1,
          }}>
            EXTRACTIONS ({filtered.length})
          </div>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {['all', ...types].map(t => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                style={{
                  padding: '2px 8px', borderRadius: 4, fontSize: 9, fontWeight: 600,
                  cursor: 'pointer', border: 'none', textTransform: 'capitalize',
                  color: typeFilter === t ? '#fff' : 'rgba(255,255,255,0.6)',
                  background: typeFilter === t
                    ? 'linear-gradient(145deg, rgba(168,85,247,0.12) 0%, rgba(56,189,248,0.06) 100%)'
                    : 'rgba(255,255,255,0.03)',
                }}
              >{t}</button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '24px 12px' }}>
            <div style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>No extractions yet</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
              Ask Browser-Q to extract data from a website. Results will appear here automatically.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filtered.map(ext => {
              const isExpanded = expandedId === ext.id
              const typeColor = TYPE_COLORS[ext.extraction_type] || TYPE_COLORS.generic
              return (
                <div key={ext.id} style={{
                  borderRadius: 8, overflow: 'hidden',
                  border: isExpanded ? '1px solid rgba(6,182,212,0.2)' : '1px solid rgba(255,255,255,0.06)',
                  background: isExpanded ? 'rgba(6,182,212,0.03)' : 'rgba(255,255,255,0.02)',
                  transition: 'all 0.2s ease',
                }}>
                  {/* Row header */}
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : ext.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                      background: `${typeColor}15`, color: typeColor,
                      fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase',
                    }}>{ext.extraction_type}</span>
                    <span style={{ flex: 1, fontSize: 12, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ext.url || 'Unknown URL'}
                    </span>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {ext.row_count > 0 ? `${ext.row_count} rows` : ''}
                    </span>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
                      {formatDate(ext.created_at)}
                    </span>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>
                      {isExpanded ? '\u25BE' : '\u25B8'}
                    </span>
                  </div>

                  {/* Expanded preview + actions */}
                  {isExpanded && (
                    <div style={{ padding: '0 10px 10px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                      <div style={{ marginTop: 8, marginBottom: 8 }}>
                        <ExtractionPreview data={ext.data} type={ext.extraction_type} />
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <a
                          href={getExtractionExportUrl(orgId, ext.id, 'csv')}
                          download
                          style={{
                            padding: '3px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                            textDecoration: 'none', border: '1px solid rgba(48,255,144,0.25)',
                            background: 'rgba(48,255,144,0.08)', color: '#30ff90',
                          }}
                        >{'\u2B07'} CSV</a>
                        <a
                          href={getExtractionExportUrl(orgId, ext.id, 'json')}
                          download
                          style={{
                            padding: '3px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                            textDecoration: 'none', border: '1px solid rgba(56,189,248,0.25)',
                            background: 'rgba(56,189,248,0.08)', color: '#38bdf8',
                          }}
                        >{'\u2B07'} JSON</a>
                        <button
                          onClick={() => handleCopyJson(ext.data)}
                          style={{
                            padding: '3px 10px', borderRadius: 6, fontSize: 10, fontWeight: 600,
                            cursor: 'pointer', border: '1px solid rgba(255,255,255,0.12)',
                            background: 'rgba(255,255,255,0.04)', color: '#fff',
                          }}
                        >Copy</button>
                        <button
                          onClick={() => handleDelete(ext.id)}
                          style={{
                            marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, fontSize: 10,
                            fontWeight: 600, cursor: 'pointer',
                            border: '1px solid rgba(239,68,68,0.2)',
                            background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                          }}
                        >{'\u2715'} Delete</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Files Section */}
      {files.length > 0 && (
        <div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
            color: '#fff', letterSpacing: 1, marginBottom: 8,
          }}>
            FILES ({files.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {files.map(f => (
              <div key={f.id} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                borderRadius: 6, border: '1px solid rgba(255,255,255,0.06)',
                background: 'rgba(255,255,255,0.02)',
              }}>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 3,
                  background: f.file_type === 'pdf' ? 'rgba(239,68,68,0.12)' : 'rgba(56,189,248,0.12)',
                  color: f.file_type === 'pdf' ? '#ef4444' : '#38bdf8',
                  fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase',
                }}>{f.file_type}</span>
                <span style={{ flex: 1, fontSize: 11, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.filename}
                </span>
                {f.size_bytes > 0 && (
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace" }}>
                    {f.size_bytes < 1024 ? `${f.size_bytes}B` : f.size_bytes < 1024 * 1024 ? `${(f.size_bytes / 1024).toFixed(1)}KB` : `${(f.size_bytes / (1024 * 1024)).toFixed(1)}MB`}
                  </span>
                )}
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{formatDate(f.created_at)}</span>
                <a
                  href={getBrowserFileDownloadUrl(orgId, f.id)}
                  download
                  style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                    textDecoration: 'none', border: '1px solid rgba(48,255,144,0.2)',
                    background: 'rgba(48,255,144,0.08)', color: '#30ff90',
                  }}
                >{'\u2B07'}</a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

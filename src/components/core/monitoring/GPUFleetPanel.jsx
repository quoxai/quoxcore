/**
 * GPUFleetPanel - GPU-specific fleet monitoring panel
 * Filters agents that report gpu_devices and shows GPU hardware + inference backends
 */

import { useState, useEffect, useCallback, memo, useRef } from 'react'

const STATUS_COLORS = {
  connected: '#22c55e',
  stale: '#f59e0b',
  dead: '#ef4444',
  unknown: '#6b7280'
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let val = bytes
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++ }
  return `${val.toFixed(1)} ${units[i]}`
}

function formatMB(mb) {
  if (!mb) return '0 MB'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

// GPU card for a single host
const GPUHostCard = memo(function GPUHostCard({ agent, onClick }) {
  const { host_id, gpu_devices, inference_backends, loaded_models, status, system } = agent
  const connectionStatus = status?.connection || 'unknown'
  const gpus = gpu_devices || []
  const backends = inference_backends || []
  const models = loaded_models || []

  const totalVRAM = gpus.reduce((sum, g) => sum + (g.vram_total_mb || 0), 0)
  const usedVRAM = gpus.reduce((sum, g) => sum + (g.vram_used_mb || 0), 0)
  const vramPct = totalVRAM > 0 ? (usedVRAM / totalVRAM) * 100 : 0
  const maxTemp = gpus.reduce((max, g) => Math.max(max, g.temperature_c || 0), 0)
  const healthyBackends = backends.filter(b => b.healthy).length

  return (
    <div
      className="agent-card clickable"
      style={{ borderLeftColor: STATUS_COLORS[connectionStatus] }}
      onClick={() => onClick(agent)}
    >
      <div className="agent-header">
        <div className="agent-name">
          <span className="host-id">{host_id}</span>
          <span className="health-badge" style={{
            backgroundColor: maxTemp > 90 ? '#ef4444' : maxTemp > 75 ? '#f59e0b' : '#22c55e'
          }}>
            {maxTemp > 90 ? 'hot' : maxTemp > 75 ? 'warm' : 'ok'}
          </span>
        </div>
        <div className="connection-status" style={{ color: STATUS_COLORS[connectionStatus] }}>
          {connectionStatus}
          {status?.last_seen_seconds !== undefined && ` (${status.last_seen_seconds}s ago)`}
        </div>
      </div>

      <div className="agent-system">
        <span>{system?.hostname || host_id}</span>
        <span className="separator">|</span>
        <span>{gpus.length} GPU{gpus.length !== 1 ? 's' : ''}</span>
        <span className="separator">|</span>
        <span>{healthyBackends}/{backends.length} backends</span>
      </div>

      {/* GPU cards */}
      {gpus.map((gpu, i) => {
        const gpuVramPct = gpu.vram_total_mb > 0
          ? (gpu.vram_used_mb / gpu.vram_total_mb) * 100 : 0
        return (
          <div key={i} className="agent-resources" style={{ marginTop: i > 0 ? '0.5rem' : 0 }}>
            <div style={{
              fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)',
              marginBottom: '0.25rem', display: 'flex', justifyContent: 'space-between'
            }}>
              <span>GPU {gpu.index}: {gpu.name || 'Unknown'}</span>
              <span>{gpu.temperature_c >= 0 ? `${gpu.temperature_c}°C` : ''}</span>
            </div>

            <div className="resource-bar">
              <div className="resource-label">VRAM</div>
              <div className="bar-container">
                <div className="bar-fill gpu" style={{ width: `${Math.min(gpuVramPct, 100)}%` }} />
              </div>
              <div className="resource-value">
                {gpuVramPct.toFixed(0)}%
                <span className="resource-detail">
                  ({formatMB(gpu.vram_used_mb)}/{formatMB(gpu.vram_total_mb)})
                </span>
              </div>
            </div>

            {gpu.utilisation_pct >= 0 && (
              <div className="resource-bar">
                <div className="resource-label">UTIL</div>
                <div className="bar-container">
                  <div className="bar-fill cpu" style={{ width: `${Math.min(gpu.utilisation_pct, 100)}%` }} />
                </div>
                <div className="resource-value">{gpu.utilisation_pct}%</div>
              </div>
            )}
          </div>
        )
      })}

      <div className="agent-footer">
        <div className="agent-info">
          <span>{formatMB(totalVRAM)} total VRAM</span>
          <span className="separator">|</span>
          <span>{models.filter(m => m.loaded).length} loaded model{models.filter(m => m.loaded).length !== 1 ? 's' : ''}</span>
        </div>
        <div className="capabilities">
          {backends.map((b, i) => (
            <span key={i} className="capability-tag" style={{
              color: b.healthy ? '#22c55e' : '#ef4444',
              borderColor: b.healthy ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'
            }}>
              {b.type}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}, (prev, next) => {
  const pa = prev.agent, na = next.agent
  return (
    pa.host_id === na.host_id &&
    pa.status?.connection === na.status?.connection &&
    pa.status?.last_seen_seconds === na.status?.last_seen_seconds &&
    pa.gpu_devices?.length === na.gpu_devices?.length &&
    pa.inference_backends?.length === na.inference_backends?.length
  )
})

// GPU detail modal
function GPUDetailModal({ agent, onClose }) {
  if (!agent) return null

  const { host_id, gpu_devices, inference_backends, loaded_models, system, status } = agent
  const gpus = gpu_devices || []
  const backends = inference_backends || []
  const models = loaded_models || []

  return (
    <div className="agent-detail-modal" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-content">
        <div className="modal-header">
          <h3>{host_id} — GPU Detail</h3>
          <button className="modal-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {/* System info */}
          <div className="detail-section">
            <h4>System</h4>
            <div className="detail-grid">
              <div className="detail-item"><span className="detail-label">Hostname</span><span>{system?.hostname || host_id}</span></div>
              <div className="detail-item"><span className="detail-label">OS</span><span>{system?.os || '—'} {system?.arch || ''}</span></div>
              <div className="detail-item"><span className="detail-label">Status</span><span style={{ color: STATUS_COLORS[status?.connection] }}>{status?.connection || 'unknown'}</span></div>
              <div className="detail-item"><span className="detail-label">Agent</span><span>{agent.agent?.name || 'quoxgpu'} v{agent.agent?.version || '?'}</span></div>
            </div>
          </div>

          {/* GPU devices */}
          <div className="detail-section">
            <h4>GPU Devices ({gpus.length})</h4>
            {gpus.map((gpu, i) => (
              <div key={i} style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
                padding: '0.75rem',
                marginBottom: '0.5rem'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 600, color: '#f5f5f5' }}>GPU {gpu.index}: {gpu.name}</span>
                  <span style={{ color: gpu.healthy ? '#22c55e' : '#ef4444', fontSize: '0.8rem' }}>
                    {gpu.healthy ? 'healthy' : gpu.error || 'error'}
                  </span>
                </div>
                <div className="detail-grid">
                  <div className="detail-item"><span className="detail-label">UUID</span><span style={{ fontSize: '0.7rem' }}>{gpu.uuid || '—'}</span></div>
                  <div className="detail-item"><span className="detail-label">Driver</span><span>{gpu.driver_version || '—'}</span></div>
                  <div className="detail-item"><span className="detail-label">VRAM</span><span>{formatMB(gpu.vram_used_mb)} / {formatMB(gpu.vram_total_mb)}</span></div>
                  <div className="detail-item"><span className="detail-label">Temperature</span><span style={{ color: gpu.temperature_c > 90 ? '#ef4444' : gpu.temperature_c > 75 ? '#f59e0b' : '#22c55e' }}>{gpu.temperature_c >= 0 ? `${gpu.temperature_c}°C` : '—'}</span></div>
                  <div className="detail-item"><span className="detail-label">Power</span><span>{gpu.power_draw_w >= 0 ? `${gpu.power_draw_w.toFixed(0)}W` : '—'}{gpu.power_limit_w >= 0 ? ` / ${gpu.power_limit_w.toFixed(0)}W` : ''}</span></div>
                  <div className="detail-item"><span className="detail-label">Utilisation</span><span>{gpu.utilisation_pct >= 0 ? `${gpu.utilisation_pct}%` : '—'}</span></div>
                  <div className="detail-item"><span className="detail-label">Fan</span><span>{gpu.fan_speed_pct >= 0 ? `${gpu.fan_speed_pct}%` : '—'}</span></div>
                  <div className="detail-item"><span className="detail-label">PCI</span><span style={{ fontSize: '0.7rem' }}>{gpu.pci_bus || '—'}</span></div>
                </div>
              </div>
            ))}
          </div>

          {/* Inference backends */}
          <div className="detail-section">
            <h4>Inference Backends ({backends.length})</h4>
            {backends.length === 0 && <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem' }}>No backends configured</div>}
            {backends.map((b, i) => (
              <div key={i} style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
                padding: '0.75rem',
                marginBottom: '0.5rem'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span style={{ fontWeight: 600, color: '#f5f5f5' }}>{b.type}</span>
                  <span style={{ color: b.healthy ? '#22c55e' : '#ef4444', fontSize: '0.8rem' }}>
                    {b.healthy ? 'healthy' : b.error || 'unhealthy'}
                  </span>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                  {b.url}{b.version ? ` (v${b.version})` : ''}
                </div>
                {b.models?.length > 0 && (
                  <div style={{ marginTop: '0.5rem' }}>
                    {b.models.map((m, mi) => (
                      <div key={mi} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.25rem 0', borderTop: mi > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                        fontSize: '0.8rem'
                      }}>
                        <span style={{ color: '#f5f5f5' }}>{m.name}</span>
                        <span style={{ color: m.loaded ? '#22c55e' : 'rgba(255,255,255,0.4)' }}>
                          {m.loaded ? 'loaded' : 'available'}
                          {m.vram_used_bytes ? ` (${formatBytes(m.vram_used_bytes)})` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* All models summary */}
          {models.length > 0 && (
            <div className="detail-section">
              <h4>Model Inventory ({models.length})</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {models.map((m, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '0.35rem 0.5rem',
                    background: m.loaded ? 'rgba(34,197,94,0.06)' : 'transparent',
                    borderRadius: '4px',
                    fontSize: '0.8rem'
                  }}>
                    <span style={{ color: '#f5f5f5' }}>{m.name}</span>
                    <span style={{ color: 'rgba(255,255,255,0.5)', display: 'flex', gap: '0.75rem' }}>
                      {m.parameters && <span>{m.parameters}</span>}
                      {m.quantization && <span>{m.quantization}</span>}
                      <span style={{ color: m.loaded ? '#22c55e' : 'rgba(255,255,255,0.3)' }}>
                        {m.backend}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// GPU fleet summary bar
const GPUFleetSummary = memo(function GPUFleetSummary({ gpuAgents }) {
  const totalGPUs = gpuAgents.reduce((sum, a) => sum + (a.gpu_devices?.length || 0), 0)
  const totalVRAM = gpuAgents.reduce((sum, a) =>
    sum + (a.gpu_devices || []).reduce((s, g) => s + (g.vram_total_mb || 0), 0), 0)
  const usedVRAM = gpuAgents.reduce((sum, a) =>
    sum + (a.gpu_devices || []).reduce((s, g) => s + (g.vram_used_mb || 0), 0), 0)
  const totalModels = gpuAgents.reduce((sum, a) => sum + (a.loaded_models?.length || 0), 0)
  const loadedModels = gpuAgents.reduce((sum, a) =>
    sum + (a.loaded_models || []).filter(m => m.loaded).length, 0)
  const totalBackends = gpuAgents.reduce((sum, a) => sum + (a.inference_backends?.length || 0), 0)
  const healthyBackends = gpuAgents.reduce((sum, a) =>
    sum + (a.inference_backends || []).filter(b => b.healthy).length, 0)

  return (
    <div className="fleet-summary">
      <div className="summary-stat">
        <div className="stat-value">{gpuAgents.length}</div>
        <div className="stat-label">GPU Hosts</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value">{totalGPUs}</div>
        <div className="stat-label">GPUs</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value">{formatMB(totalVRAM)}</div>
        <div className="stat-label">Total VRAM</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value" style={{ color: totalVRAM > 0 && usedVRAM / totalVRAM > 0.8 ? '#f59e0b' : '#22c55e' }}>
          {totalVRAM > 0 ? ((usedVRAM / totalVRAM) * 100).toFixed(0) : 0}%
        </div>
        <div className="stat-label">VRAM Used</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value">{loadedModels}/{totalModels}</div>
        <div className="stat-label">Models Loaded</div>
      </div>
      <div className="summary-stat">
        <div className="stat-value" style={{ color: healthyBackends === totalBackends ? '#22c55e' : '#f59e0b' }}>
          {healthyBackends}/{totalBackends}
        </div>
        <div className="stat-label">Backends</div>
      </div>
    </div>
  )
})

// Main panel
export default function GPUFleetPanel() {
  const [agents, setAgents] = useState([])
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [error, setError] = useState(null)
  const connectionIdRef = useRef(0)

  const fetchGPUAgents = useCallback(async () => {
    const currentId = connectionIdRef.current
    try {
      const res = await fetch('/collector/api/v1/agents')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      if (connectionIdRef.current !== currentId) return

      // Filter to agents that have gpu_devices or inference_backends
      const gpuAgents = (data.agents || []).filter(a =>
        (a.gpu_devices && a.gpu_devices.length > 0) ||
        (a.inference_backends && a.inference_backends.length > 0) ||
        a.agent?.type === 'quoxgpu'
      )

      setAgents(gpuAgents)
      setError(null)
    } catch (err) {
      if (connectionIdRef.current === currentId) {
        setError(err.message)
      }
    }
  }, [])

  useEffect(() => {
    connectionIdRef.current++
    fetchGPUAgents()
    const interval = setInterval(fetchGPUAgents, 10000) // 10s polling
    return () => {
      connectionIdRef.current++
      clearInterval(interval)
    }
  }, [fetchGPUAgents])

  const gpuAgents = agents

  if (gpuAgents.length === 0 && !error) {
    return null // Hide panel entirely if no GPU agents
  }

  return (
    <div className="agent-fleet-panel">
      <div className="panel-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" style={{ marginRight: '0.5rem' }}>
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <line x1="9" y1="9" x2="9" y2="15" />
            <line x1="15" y1="9" x2="15" y2="15" />
            <line x1="9" y1="12" x2="15" y2="12" />
          </svg>
          GPU Fleet
        </h3>
        <div className="header-status">
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem' }}>
            {gpuAgents.length} host{gpuAgents.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <span>GPU fleet fetch failed: {error}</span>
        </div>
      )}

      <GPUFleetSummary gpuAgents={gpuAgents} />

      <div className="agent-grid">
        {gpuAgents.map(agent => (
          <GPUHostCard
            key={agent.host_id}
            agent={agent}
            onClick={setSelectedAgent}
          />
        ))}
      </div>

      {selectedAgent && (
        <GPUDetailModal
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </div>
  )
}

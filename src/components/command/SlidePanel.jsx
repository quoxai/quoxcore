import { useEffect, useRef } from 'react'

function SlidePanel({
  isOpen,
  onClose,
  title,
  children,
  position = 'right', // left, right
  width = '400px'
}) {
  const panelRef = useRef(null)

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (isOpen && panelRef.current && !panelRef.current.contains(e.target)) {
        // Check if click was on overlay
        if (e.target.classList.contains('slide-panel-overlay')) {
          onClose()
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, onClose])

  // Prevent body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  return (
    <>
      <div className={`slide-panel-overlay ${isOpen ? 'open' : ''}`} />
      <div
        ref={panelRef}
        className={`slide-panel ${position} ${isOpen ? 'open' : ''}`}
        style={{ '--panel-width': width }}
      >
        <div className="slide-panel-header">
          <h3 className="slide-panel-title">{title}</h3>
          <button className="slide-panel-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="slide-panel-content">
          {children}
        </div>
      </div>
    </>
  )
}

// Panel content components

export function HostsPanelContent({ hosts = [], onSelectHost }) {
  const categories = {
    proxmox: { label: 'Proxmox Cluster', color: '#e65100' },
    storage: { label: 'Storage', color: '#1565c0' },
    monitoring: { label: 'Monitoring', color: '#2e7d32' },
    security: { label: 'Security', color: '#c62828' },
    claude: { label: 'Claude Agents', color: '#7b1fa2' },
    applications: { label: 'Applications', color: '#00838f' },
    network: { label: 'Network', color: '#546e7a' },
    other: { label: 'Other', color: '#424242' }
  }

  const groupedHosts = hosts.reduce((acc, host) => {
    const cat = host.category || 'other'
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(host)
    return acc
  }, {})

  return (
    <div className="hosts-panel-content">
      {Object.entries(categories).map(([key, cat]) => {
        const catHosts = groupedHosts[key] || []
        if (catHosts.length === 0) return null
        return (
          <div key={key} className="host-category">
            <div className="category-header" style={{ '--cat-color': cat.color }}>
              {cat.label}
              <span className="category-count">{catHosts.length}</span>
            </div>
            <div className="category-hosts">
              {catHosts.map(host => (
                <button
                  key={host.hostname}
                  className={`host-item ${host.status || 'unknown'}`}
                  onClick={() => onSelectHost?.(host)}
                >
                  <span className="host-status-dot" />
                  <span className="host-name">{host.hostname}</span>
                  <span className="host-ip">{host.ip_address}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function MetricsPanelContent({ metrics = {} }) {
  const items = [
    { label: 'CPU Usage', value: metrics.cpu || 0, unit: '%', color: '#30ff90' },
    { label: 'Memory', value: metrics.memory || 0, unit: '%', color: '#3090ff' },
    { label: 'Disk', value: metrics.disk || 0, unit: '%', color: '#ff9030' },
    { label: 'Network I/O', value: metrics.network || 0, unit: 'Mbps', color: '#9d4edd' }
  ]

  return (
    <div className="metrics-panel-content">
      {items.map(item => (
        <div key={item.label} className="metric-item">
          <div className="metric-header">
            <span className="metric-label">{item.label}</span>
            <span className="metric-value">{item.value}{item.unit}</span>
          </div>
          <div className="metric-bar-bg">
            <div
              className="metric-bar-fill"
              style={{
                width: `${Math.min(item.value, 100)}%`,
                backgroundColor: item.color
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ThreatsPanelContent({ threats = [] }) {
  if (threats.length === 0) {
    return (
      <div className="threats-panel-content empty">
        <div className="no-threats">
          <span className="check-icon">✓</span>
          <p>No active threats detected</p>
        </div>
      </div>
    )
  }

  return (
    <div className="threats-panel-content">
      {threats.map((threat, i) => (
        <div key={i} className={`threat-item ${threat.severity}`}>
          <div className="threat-header">
            <span className="threat-severity">{threat.severity}</span>
            <span className="threat-time">{threat.time}</span>
          </div>
          <div className="threat-title">{threat.title}</div>
          <div className="threat-source">{threat.source}</div>
        </div>
      ))}
    </div>
  )
}

export function ActivityPanelContent({ activity = [] }) {
  const formatTime = (timestamp) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="activity-panel-content">
      {activity.length === 0 ? (
        <div className="no-activity">No recent activity</div>
      ) : (
        activity.map((item, i) => (
          <div key={item.id || i} className={`activity-item ${item.success ? 'success' : 'error'}`}>
            <div className="activity-time">{formatTime(item.timestamp)}</div>
            <div className="activity-details">
              <span className="activity-host">{item.host}</span>
              <span className="activity-prompt">{item.prompt}</span>
            </div>
            <span className={`activity-status ${item.success ? 'success' : 'error'}`}>
              {item.success ? '✓' : '✗'}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

export default SlidePanel

/**
 * Admin Overview Dashboard
 * System statistics and health overview
 */

import { useState, useEffect } from 'react'
import { csrfFetch } from '../../utils/csrfFetch'

const AUTH_API = '/api'

/* ── Inline SVG Icons (14-16px, explicit stroke colours) ── */
const Icon = ({ children, size = 16, ...props }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    {children}
  </svg>
)

const UsersIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
)

const BuildingIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
    <path d="M9 22v-4h6v4" />
    <path d="M8 6h.01" />
    <path d="M16 6h.01" />
    <path d="M12 6h.01" />
    <path d="M12 10h.01" />
    <path d="M12 14h.01" />
    <path d="M16 10h.01" />
    <path d="M16 14h.01" />
    <path d="M8 10h.01" />
    <path d="M8 14h.01" />
  </Icon>
)

const ActivityIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </Icon>
)

const KeyIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </Icon>
)

const LoginIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <polyline points="10 17 15 12 10 7" />
    <line x1="15" y1="12" x2="3" y2="12" />
  </Icon>
)

const AlertTriangleIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
)

const RefreshIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L2 9" />
    <path d="M2 2v7h7" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L22 15" />
    <path d="M22 22v-7h-7" />
  </Icon>
)

const SettingsIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
)

const ScrollTextIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
    <path d="M19 17V5a2 2 0 0 0-2-2H4" />
    <path d="M15 8h-5" />
    <path d="M15 12h-5" />
  </Icon>
)

const ShieldIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
  </Icon>
)

const ExternalLinkIcon = ({ size, color }) => (
  <Icon size={size} style={{ stroke: color }}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </Icon>
)

/* ── Stat card config ── */
const STAT_CARDS = [
  { key: 'users',           label: 'Active Users',   icon: UsersIcon,          color: '#38bdf8' },
  { key: 'organizations',   label: 'Organizations',  icon: BuildingIcon,       color: '#a78bfa' },
  { key: 'active_sessions', label: 'Active Sessions', icon: ActivityIcon,      color: '#22c55e' },
  { key: 'system_api_keys', label: 'API Keys',       icon: KeyIcon,            color: '#f59e0b' },
  { key: 'logins_24h',      label: 'Logins (24h)',   icon: LoginIcon,          color: '#38bdf8' },
  { key: 'errors_24h',      label: 'Errors (24h)',   icon: AlertTriangleIcon,  color: '#ef4444', isError: true },
]

/* ── Quick action config ── */
const QUICK_ACTIONS = [
  { href: '/admin/keys',    label: 'Manage API Keys',  icon: KeyIcon,        color: '#f59e0b' },
  { href: '/admin/config',  label: 'Instance Config',  icon: SettingsIcon,   color: '#38bdf8' },
  { href: '/admin/admins',  label: 'Manage Admins',    icon: ShieldIcon,     color: '#a78bfa' },
  { href: '/admin/logs',    label: 'View Logs',        icon: ScrollTextIcon, color: '#22c55e' },
]

export default function AdminOverview() {
  const [stats, setStats] = useState(null)
  const [services, setServices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchData()
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [])

  const fetchData = async () => {
    try {
      // Use httpOnly cookies for authentication
      const [statsRes, servicesRes] = await Promise.all([
        fetch(`${AUTH_API}/admin/stats`, { credentials: 'include' }),
        fetch(`${AUTH_API}/admin/services`, { credentials: 'include' })
      ])

      if (!statsRes.ok || !servicesRes.ok) {
        throw new Error('Failed to fetch data')
      }

      const statsData = await statsRes.json()
      const servicesData = await servicesRes.json()

      setStats(statsData.stats)
      setServices(servicesData.services)
      setLoading(false)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const checkService = async (serviceId) => {
    try {
      const res = await csrfFetch(`${AUTH_API}/admin/services/${serviceId}/check`, {
        method: 'POST'
      })

      if (res.ok) {
        fetchData()
      }
    } catch (err) {
      console.error('Failed to check service:', err)
    }
  }

  if (loading) {
    return <div className="admin-loading">Loading...</div>
  }

  if (error) {
    return <div className="admin-error-inline">{error}</div>
  }

  return (
    <div className="admin-overview">
      <div className="page-header">
        <h1>System Overview</h1>
        <p className="page-description">Instance statistics and service health</p>
      </div>

      {/* Stats Grid */}
      <div className="stats-grid">
        {STAT_CARDS.map(card => {
          const IconComp = card.icon
          const value = stats?.[card.key] || 0
          const hasErrors = card.isError && value > 0
          return (
            <div
              key={card.key}
              className={`stat-card${card.isError ? ' stat-card--error' : ''}`}
              style={{ borderLeftColor: card.color }}
            >
              <div className="stat-icon-wrap" style={{ background: `${card.color}1a` }}>
                <IconComp size={22} color={card.color} />
              </div>
              <div className="stat-content">
                <div className={`stat-value${hasErrors ? ' stat-value--danger' : ''}`}>
                  {value}
                </div>
                <div className="stat-label">{card.label}</div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Service Health */}
      <section className="section">
        <h2>Service Health</h2>
        <div className="services-grid">
          {services.map(service => (
            <div
              key={service.id}
              className={`service-card ${service.status}`}
            >
              <div className="service-header">
                <div className="service-header-left">
                  <span className={`service-dot service-dot--${service.status}`} />
                  <span className="service-name">{service.display_name || service.name}</span>
                </div>
                <span className={`service-status ${service.status}`}>
                  {service.status === 'healthy' ? 'ONLINE' :
                   service.status === 'unhealthy' ? 'OFFLINE' :
                   service.status === 'disabled' ? 'NOT CONFIGURED' : 'UNKNOWN'}
                </span>
              </div>
              <div className="service-details">
                <div className="detail-row">
                  <span className="detail-label">Port</span>
                  <span className="detail-value detail-value--mono">{service.expected_port}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Last Check</span>
                  <span className="detail-value detail-value--dim">
                    {service.last_check_at
                      ? new Date(service.last_check_at).toLocaleTimeString()
                      : 'Never'}
                  </span>
                </div>
                {service.status_message && (
                  <div className="detail-row">
                    <span className="detail-label">Status</span>
                    <span className="detail-value">{service.status_message}</span>
                  </div>
                )}
              </div>
              <button
                className="btn-check-icon"
                onClick={() => checkService(service.id)}
                title="Check Now"
              >
                <RefreshIcon size={14} color="rgba(255, 255, 255, 0.7)" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Quick Actions */}
      <section className="section">
        <h2>Quick Actions</h2>
        <div className="quick-actions-grid">
          {QUICK_ACTIONS.map(action => {
            const IconComp = action.icon
            return (
              <a key={action.href} href={action.href} className="action-card">
                <span className="action-icon" style={{ background: `${action.color}1a` }}>
                  <IconComp size={18} color={action.color} />
                </span>
                <span className="action-label">{action.label}</span>
              </a>
            )
          })}
        </div>
      </section>
    </div>
  )
}

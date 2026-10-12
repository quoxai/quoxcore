/**
 * Admin Services Health
 * Monitor and manage system services
 */

import { useState, useEffect } from 'react'
import { csrfFetch } from '../../utils/csrfFetch'
import { RefreshCw } from 'lucide-react'

const AUTH_API = '/api'

export default function AdminServices() {
  const [services, setServices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [checking, setChecking] = useState(null)

  useEffect(() => {
    fetchServices()
    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchServices, 60000)
    return () => clearInterval(interval)
  }, [])

  const fetchServices = async () => {
    try {
      const res = await fetch(`${AUTH_API}/admin/services`, {
        credentials: 'include'
      })

      if (!res.ok) throw new Error('Failed to fetch services')

      const data = await res.json()
      setServices(data.services)
      setLoading(false)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const checkService = async (serviceId) => {
    setChecking(serviceId)

    try {
      const res = await csrfFetch(`${AUTH_API}/admin/services/${serviceId}/check`, {
        method: 'POST'
      })

      if (res.ok) {
        fetchServices()
      }
    } catch (err) {
      console.error('Failed to check service:', err)
    } finally {
      setChecking(null)
    }
  }

  const checkAllServices = async () => {
    setChecking('all')
    for (const service of services) {
      await checkService(service.id)
    }
    setChecking(null)
  }

  const getStatusIcon = (status) => {
    switch (status) {
      case 'healthy': return <span className="status-dot healthy" />
      case 'unhealthy': return <span className="status-dot unhealthy" />
      default: return <span className="status-dot unknown" />
    }
  }

  const getStatusClass = (status) => {
    switch (status) {
      case 'healthy': return 'status-healthy'
      case 'unhealthy': return 'status-unhealthy'
      default: return 'status-unknown'
    }
  }

  if (loading) {
    return <div className="admin-loading">Loading...</div>
  }

  const healthyCount = services.filter(s => s.status === 'healthy').length
  const unhealthyCount = services.filter(s => s.status === 'unhealthy').length
  const unknownCount = services.filter(s => s.status === 'unknown').length

  return (
    <div className="admin-services">
      <div className="page-header">
        <div>
          <h1>Service Health</h1>
          <p className="page-description">Monitor system services and their status</p>
        </div>
        <button
          className="btn-primary"
          onClick={checkAllServices}
          disabled={checking === 'all'}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} className={checking === 'all' ? 'spin' : ''} />
          {checking === 'all' ? 'Checking...' : 'Check All'}
        </button>
      </div>

      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Status Summary */}
      <div className="status-summary">
        <div className="summary-item healthy">
          <span className="summary-count">{healthyCount}</span>
          <span className="summary-label">Healthy</span>
        </div>
        <div className="summary-item unhealthy">
          <span className="summary-count">{unhealthyCount}</span>
          <span className="summary-label">Unhealthy</span>
        </div>
        <div className="summary-item unknown">
          <span className="summary-count">{unknownCount}</span>
          <span className="summary-label">Unknown</span>
        </div>
      </div>

      {/* Services Grid */}
      <div className="services-list">
        {services.map(service => (
          <div key={service.id} className={`service-row ${getStatusClass(service.status)}`}>
            <div className="service-status-indicator" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {getStatusIcon(service.status)}
            </div>

            <div className="service-info">
              <div className="service-name">{service.display_name || service.name}</div>
              <div className="service-description">{service.description}</div>
            </div>

            <div className="service-details">
              <div className="detail-group">
                <span className="detail-label">Endpoint</span>
                <span className="detail-value code">{service.health_endpoint}</span>
              </div>
              <div className="detail-group">
                <span className="detail-label">Port</span>
                <span className="detail-value">{service.expected_port}</span>
              </div>
            </div>

            <div className="service-timing">
              <div className="timing-item">
                <span className="timing-label">Last Check</span>
                <span className="timing-value">
                  {service.last_check_at
                    ? new Date(service.last_check_at).toLocaleString()
                    : 'Never'}
                </span>
              </div>
              <div className="timing-item">
                <span className="timing-label">Last Healthy</span>
                <span className="timing-value">
                  {service.last_healthy_at
                    ? new Date(service.last_healthy_at).toLocaleString()
                    : 'N/A'}
                </span>
              </div>
              {service.status_message && (
                <div className="timing-item">
                  <span className="timing-label">Status</span>
                  <span className="timing-value">{service.status_message}</span>
                </div>
              )}
            </div>

            <div className="service-actions">
              <button
                className="icon-btn"
                onClick={() => checkService(service.id)}
                disabled={checking === service.id || checking === 'all'}
                title="Check service health"
              >
                <RefreshCw size={14} className={checking === service.id ? 'spin' : ''} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Info Section */}
      <section className="info-section">
        <h3>Service Monitoring</h3>
        <ul>
          <li>Services are automatically checked every 60 seconds</li>
          <li><strong>Healthy</strong>: Endpoint responds with HTTP 2xx</li>
          <li><strong>Unhealthy</strong>: Endpoint returns error or times out (5s)</li>
          <li><strong>Unknown</strong>: Service hasn't been checked yet</li>
        </ul>
      </section>
    </div>
  )
}

import { useState, useEffect } from 'react'
import {
  getCustomServices,
  addCustomService,
  removeCustomService,
  generateKey,
  validateService
} from '../../services/customServices'
import './settings.css'

/**
 * CustomServicesPanel - Manage custom services for dashboard monitoring
 */
export function CustomServicesPanel() {
  const [services, setServices] = useState({})
  const [isAdding, setIsAdding] = useState(false)
  const [editingKey, setEditingKey] = useState(null)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    port: '',
    healthEndpoint: '/health',
    critical: false
  })
  const [errors, setErrors] = useState([])

  useEffect(() => {
    loadServices()
  }, [])

  const loadServices = () => {
    setServices(getCustomServices())
  }

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      port: '',
      healthEndpoint: '/health',
      critical: false
    })
    setErrors([])
    setIsAdding(false)
    setEditingKey(null)
  }

  const handleSubmit = (e) => {
    e.preventDefault()

    const serviceData = {
      key: editingKey || generateKey(formData.name),
      name: formData.name.trim(),
      description: formData.description.trim(),
      port: parseInt(formData.port, 10),
      healthEndpoint: formData.healthEndpoint.trim() || '/health',
      critical: formData.critical
    }

    const validation = validateService(serviceData)
    if (!validation.valid) {
      setErrors(validation.errors)
      return
    }

    try {
      addCustomService(serviceData)
      loadServices()
      resetForm()
    } catch (err) {
      setErrors([err.message])
    }
  }

  const handleEdit = (key, service) => {
    setEditingKey(key)
    setFormData({
      name: service.name,
      description: service.description || '',
      port: service.port.toString(),
      healthEndpoint: service.healthEndpoint || '/health',
      critical: service.critical || false
    })
    setIsAdding(true)
    setErrors([])
  }

  const handleDelete = (key) => {
    if (confirm(`Remove "${services[key].name}" from monitoring?`)) {
      removeCustomService(key)
      loadServices()
    }
  }

  const serviceList = Object.entries(services)

  return (
    <div className="custom-services-panel">
      <div className="custom-services-panel__header">
        <div className="custom-services-panel__title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="3" width="20" height="6" rx="1" />
            <rect x="2" y="13" width="20" height="6" rx="1" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="16" r="1" fill="currentColor" />
          </svg>
          <span>Custom Services</span>
        </div>
        {!isAdding && (
          <button
            className="custom-services-panel__add-btn"
            onClick={() => setIsAdding(true)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Service
          </button>
        )}
      </div>

      <p className="custom-services-panel__desc">
        Add your own services to monitor on the dashboard. Custom services appear alongside core services in the Services panel.
      </p>

      {/* Add/Edit Form */}
      {isAdding && (
        <form className="custom-services-form" onSubmit={handleSubmit}>
          <div className="custom-services-form__header">
            <h4>{editingKey ? 'Edit Service' : 'Add New Service'}</h4>
            <button
              type="button"
              className="custom-services-form__close"
              onClick={resetForm}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {errors.length > 0 && (
            <div className="custom-services-form__errors">
              {errors.map((err, i) => (
                <div key={i}>{err}</div>
              ))}
            </div>
          )}

          <div className="custom-services-form__row">
            <div className="custom-services-form__field">
              <label>Service Name *</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. Pinecone"
                autoFocus
              />
            </div>
            <div className="custom-services-form__field custom-services-form__field--small">
              <label>Port *</label>
              <input
                type="number"
                value={formData.port}
                onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                placeholder="8080"
                min="1"
                max="65535"
              />
            </div>
          </div>

          <div className="custom-services-form__field">
            <label>Description</label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="e.g. Vector database for embeddings"
            />
          </div>

          <div className="custom-services-form__row">
            <div className="custom-services-form__field">
              <label>Health Endpoint</label>
              <input
                type="text"
                value={formData.healthEndpoint}
                onChange={(e) => setFormData({ ...formData, healthEndpoint: e.target.value })}
                placeholder="/health"
              />
            </div>
            <div className="custom-services-form__field custom-services-form__field--checkbox">
              <label>
                <input
                  type="checkbox"
                  checked={formData.critical}
                  onChange={(e) => setFormData({ ...formData, critical: e.target.checked })}
                />
                <span>Mark as critical</span>
              </label>
            </div>
          </div>

          <div className="custom-services-form__actions">
            <button type="button" className="custom-services-form__cancel" onClick={resetForm}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              Cancel
            </button>
            <button type="submit" className="custom-services-form__submit">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              {editingKey ? 'Update' : 'Add'} Service
            </button>
          </div>
        </form>
      )}

      {/* Service List */}
      {serviceList.length > 0 ? (
        <div className="custom-services-list">
          {serviceList.map(([key, service]) => (
            <div key={key} className="custom-services-item">
              <div className="custom-services-item__info">
                <div className="custom-services-item__name">
                  {service.name}
                  {service.critical && (
                    <span className="custom-services-item__critical">CRITICAL</span>
                  )}
                </div>
                <div className="custom-services-item__meta">
                  <span className="custom-services-item__port">:{service.port}</span>
                  <span className="custom-services-item__endpoint">{service.healthEndpoint}</span>
                </div>
                {service.description && (
                  <div className="custom-services-item__desc">{service.description}</div>
                )}
              </div>
              <div className="custom-services-item__actions">
                <button
                  className="custom-services-item__edit"
                  onClick={() => handleEdit(key, service)}
                  title="Edit service"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
                <button
                  className="custom-services-item__delete"
                  onClick={() => handleDelete(key)}
                  title="Remove service"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !isAdding && (
        <div className="custom-services-empty">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="3" width="20" height="6" rx="1" />
            <rect x="2" y="13" width="20" height="6" rx="1" />
            <line x1="12" y1="6" x2="12" y2="6.01" />
            <line x1="12" y1="16" x2="12" y2="16.01" />
          </svg>
          <p>No custom services configured</p>
          <span>Click "Add Service" to monitor additional services</span>
        </div>
      )}
    </div>
  )
}

export default CustomServicesPanel

/**
 * LayerPluginManager - Manage Installed AOCL Layer Plugins
 *
 * Lists installed plugins with enable/disable and management actions.
 * Part of AOCL Developer Kit (Free)
 */

import { useState, useEffect, useCallback } from 'react'
import {
  getRegisteredPlugins,
  enablePlugin,
  disablePlugin,
  unregisterLayerPlugin,
  loadAndInstallPlugin,
  downloadPlugin,
  VALID_LAYER_POSITIONS
} from '../../services/layers'
import {
  AOCL_PLUGIN_TRUST_NOTICE,
  AOCL_PLUGIN_JS_WARNING,
  TRUSTED_ADMIN_ONLY_LABEL,
  isDynamicPluginExtension
} from '../../services/pluginTrustModel'

export default function LayerPluginManager({ onEditPlugin }) {
  const [plugins, setPlugins] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [dragOver, setDragOver] = useState(false)
  const [installStatus, setInstallStatus] = useState(null)

  const loadPlugins = useCallback(() => {
    setLoading(true)
    try {
      const registered = getRegisteredPlugins()
      setPlugins(registered)
    } catch (err) {
      console.error('Failed to load plugins:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  const handleToggle = async (pluginId, currentlyEnabled) => {
    try {
      if (currentlyEnabled) {
        disablePlugin(pluginId)
      } else {
        enablePlugin(pluginId)
      }
      loadPlugins()
    } catch (err) {
      console.error('Failed to toggle plugin:', err)
    }
  }

  const handleDelete = async (pluginId) => {
    if (!window.confirm(`Are you sure you want to delete plugin "${pluginId}"?`)) {
      return
    }

    try {
      unregisterLayerPlugin(pluginId)
      loadPlugins()
    } catch (err) {
      console.error('Failed to delete plugin:', err)
    }
  }

  const handleExport = (plugin) => {
    downloadPlugin(plugin, 'json')
  }

  const handleFileDrop = async (e) => {
    e.preventDefault()
    setDragOver(false)

    const files = e.dataTransfer?.files || e.target?.files
    if (!files || files.length === 0) return

    const file = files[0]
    const isJsPlugin = isDynamicPluginExtension(file.name)

    if (isJsPlugin) {
      const confirmed = window.confirm(
        `${AOCL_PLUGIN_JS_WARNING}\n\nContinue with trusted-admin install for ${file.name}?`
      )
      if (!confirmed) {
        setInstallStatus({ type: 'error', message: 'JavaScript plugin install cancelled.' })
        setTimeout(() => setInstallStatus(null), 4000)
        return
      }
    }

    setInstallStatus({ type: 'loading', message: 'Installing plugin...' })

    try {
      const result = await loadAndInstallPlugin(file, { allowDynamicJsPlugins: isJsPlugin })

      if (result.success) {
        setInstallStatus({ type: 'success', message: `Plugin "${result.pluginId}" installed successfully` })
        loadPlugins()
      } else {
        setInstallStatus({ type: 'error', message: result.error })
      }

      setTimeout(() => setInstallStatus(null), 5000)
    } catch (err) {
      setInstallStatus({ type: 'error', message: err.message })
      setTimeout(() => setInstallStatus(null), 5000)
    }
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    setDragOver(true)
  }

  const handleDragLeave = () => {
    setDragOver(false)
  }

  // Filter plugins
  const filteredPlugins = plugins.filter(p => {
    if (filter === 'all') return true
    if (filter === 'enabled') return p.enabled
    if (filter === 'disabled') return !p.enabled
    return p.layer?.position === filter
  })

  const enabledCount = plugins.filter(p => p.enabled).length

  if (loading) {
    return (
      <div className="layer-plugin-manager">
        <div className="loading-state">Loading plugins...</div>
      </div>
    )
  }

  return (
    <div className="layer-plugin-manager">
      {/* Header */}
      <div className="manager-header">
        <div className="header-stats">
          <span className="stat-total">{plugins.length} plugins installed</span>
          <span className="stat-enabled">{enabledCount} enabled</span>
        </div>

        <div className="header-filter">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All Plugins</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
            <optgroup label="By Layer">
              {VALID_LAYER_POSITIONS.map(pos => (
                <option key={pos} value={pos}>{pos}</option>
              ))}
            </optgroup>
          </select>
        </div>
      </div>

      {/* Install Status */}
      {installStatus && (
        <div className={`install-status ${installStatus.type}`}>
          {installStatus.message}
        </div>
      )}

      {/* Drop Zone */}
      <div className="install-status" style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.28)', color: 'rgba(255,255,255,0.86)' }}>
        <strong>{TRUSTED_ADMIN_ONLY_LABEL}.</strong> {AOCL_PLUGIN_TRUST_NOTICE}
      </div>
      <div
        className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
        onDrop={handleFileDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <div className="drop-zone-content">
          <span className="drop-icon">[+]</span>
          <span className="drop-text">Drop plugin file here to install</span>
          <span className="drop-hint">or</span>
          <label className="file-input-label">
            <input
              type="file"
              accept=".json,.js"
              onChange={handleFileDrop}
              style={{ display: 'none' }}
            />
            Browse Files
          </label>
        </div>
      </div>

      {/* Plugin List */}
      {filteredPlugins.length === 0 ? (
        <div className="empty-state">
          <p>No plugins {filter !== 'all' ? 'match the filter' : 'installed yet'}</p>
          <p className="hint">Drop a plugin file above or create one in the Editor</p>
        </div>
      ) : (
        <div className="plugin-list">
          {filteredPlugins.map(plugin => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              onToggle={() => handleToggle(plugin.id, plugin.enabled)}
              onEdit={() => onEditPlugin?.(plugin)}
              onExport={() => handleExport(plugin)}
              onDelete={() => handleDelete(plugin.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PluginCard({ plugin, onToggle, onEdit, onExport, onDelete }) {
  const [expanded, setExpanded] = useState(false)

  const getLayerColor = (position) => {
    const colors = {
      L1: '#6b7280',
      L4: '#8b5cf6',
      L6: '#14b8a6',
      L11: '#f59e0b'
    }
    return colors[position] || '#666'
  }

  return (
    <div className={`plugin-card ${plugin.enabled ? 'enabled' : 'disabled'}`}>
      <div className="plugin-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="plugin-status">
          <span
            className={`status-indicator ${plugin.enabled ? 'active' : ''}`}
          />
        </div>

        <div className="plugin-info">
          <div className="plugin-name-row">
            <span className="plugin-name">{plugin.name}</span>
            <span
              className="plugin-layer"
              style={{ backgroundColor: getLayerColor(plugin.layer?.position) }}
            >
              {plugin.layer?.position || 'LX'}
            </span>
          </div>
          <div className="plugin-meta">
            <span className="plugin-id">{plugin.id}</span>
            <span className="plugin-version">v{plugin.version}</span>
            <span className="plugin-author">by {plugin.author}</span>
          </div>
        </div>

        <div className="plugin-toggle">
          <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={plugin.enabled}
              onChange={onToggle}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <span className="expand-icon">{expanded ? 'v' : '>'}</span>
      </div>

      {expanded && (
        <div className="plugin-card-body">
          {plugin.description && (
            <p className="plugin-description">{plugin.description}</p>
          )}

          <div className="plugin-details">
            <div className="detail-row">
              <span className="detail-label">Layer Position</span>
              <span className="detail-value">
                {plugin.layer?.position} ({plugin.layer?.positionMode || 'after'} {plugin.layer?.referenceLayer})
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Installed</span>
              <span className="detail-value">
                {new Date(plugin.installedAt).toLocaleDateString()}
              </span>
            </div>
            {plugin.updatedAt !== plugin.installedAt && (
              <div className="detail-row">
                <span className="detail-label">Updated</span>
                <span className="detail-value">
                  {new Date(plugin.updatedAt).toLocaleDateString()}
                </span>
              </div>
            )}
          </div>

          {plugin.configSchema && Object.keys(plugin.configSchema).length > 0 && (
            <div className="plugin-config-schema">
              <span className="config-label">Configuration Options:</span>
              <div className="config-fields">
                {Object.entries(plugin.configSchema).map(([key, def]) => (
                  <span key={key} className="config-field">
                    {key}: {def.type}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="plugin-actions">
            <button className="action-btn edit" onClick={onEdit}>
              Edit
            </button>
            <button className="action-btn export" onClick={onExport}>
              Export
            </button>
            <button className="action-btn delete" onClick={onDelete}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

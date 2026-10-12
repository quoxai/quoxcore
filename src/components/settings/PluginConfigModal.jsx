import React, { useState, useEffect } from 'react'
import { getPluginManifest } from '../../config/plugins'
import {
  getPluginConfig,
  savePluginConfig,
  validatePluginConfig,
  resetPluginConfig,
  getPluginConfigSchema
} from '../../services/pluginConfigStorage'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { saveWazuhConfig } from '../../services/wazuhClient'

export default function PluginConfigModal({ pluginName, onClose, onSave }) {
  const [config, setConfig] = useState({})
  const [errors, setErrors] = useState([])
  const [saving, setSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id

  const manifest = getPluginManifest(pluginName)
  const schema = getPluginConfigSchema(pluginName)
  const schemaEntries = Object.entries(schema)

  useEffect(() => {
    const currentConfig = getPluginConfig(pluginName)
    setConfig(currentConfig)
    setHasChanges(false)
  }, [pluginName])

  const handleChange = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }))
    setHasChanges(true)
    setErrors([])
  }

  const handleSave = async () => {
    const validation = validatePluginConfig(pluginName, config)
    if (!validation.valid) {
      setErrors(validation.errors)
      return
    }

    setSaving(true)
    try {
      // Wazuh credentials are server-of-truth in QuoxVault, never localStorage
      // (no-env-only / no-browser-persistence). Route this plugin's save through
      // the same vault write the setup gate uses, so the "edit later" path and
      // the onboarding path agree. Other plugins keep the local config store.
      if (pluginName === 'wazuh') {
        if (!orgId) {
          setErrors(['No active organisation, cannot save Wazuh credentials to the vault.'])
          return
        }
        await saveWazuhConfig(orgId, config)
        onSave?.()
        onClose()
        return
      }

      const success = savePluginConfig(pluginName, config)
      if (success) {
        onSave?.()
        onClose()
      } else {
        setErrors(['Failed to save configuration'])
      }
    } catch (err) {
      setErrors([err.message || 'Failed to save configuration'])
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (window.confirm('Reset all settings to defaults?')) {
      resetPluginConfig(pluginName)
      const defaultConfig = getPluginConfig(pluginName)
      setConfig(defaultConfig)
      setHasChanges(false)
      setErrors([])
    }
  }

  const renderField = (fieldName, field) => {
    const value = config[fieldName] ?? field.default

    if (field.type === 'boolean') {
      return (
        <label className="toggle-field">
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => handleChange(fieldName, e.target.checked)}
          />
          <span className="toggle-slider"></span>
          <span className="toggle-label">{value ? 'Enabled' : 'Disabled'}</span>
        </label>
      )
    }

    if (field.type === 'number') {
      return (
        <div className="number-field">
          <input
            type="range"
            min={field.min ?? 0}
            max={field.max ?? 100}
            step={field.step ?? 1}
            value={value}
            onChange={(e) => handleChange(fieldName, parseFloat(e.target.value))}
          />
          <span className="number-value">{value}</span>
        </div>
      )
    }

    if (field.type === 'string' && field.enum) {
      return (
        <select
          value={value}
          onChange={(e) => handleChange(fieldName, e.target.value)}
        >
          {field.enum.map(option => (
            <option key={option} value={option}>
              {field.enumLabels?.[option] || option}
            </option>
          ))}
        </select>
      )
    }

    if (field.type === 'password') {
      return (
        <input
          type="password"
          value={value || ''}
          onChange={(e) => handleChange(fieldName, e.target.value)}
          placeholder={field.placeholder || ''}
          autoComplete="new-password"
        />
      )
    }

    // Default text input
    return (
      <input
        type="text"
        value={value || ''}
        onChange={(e) => handleChange(fieldName, e.target.value)}
        placeholder={field.placeholder || ''}
      />
    )
  }

  if (!manifest || schemaEntries.length === 0) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="plugin-config-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Configure Plugin</h2>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
          <div className="modal-body">
            <p style={{ color: 'rgba(255,255,255,0.7)', textAlign: 'center', padding: '40px 0' }}>
              This plugin has no configurable settings.
            </p>
          </div>
        </div>
        <style>{modalStyles}</style>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="plugin-config-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="header-content">
            <h2>{manifest.displayName || pluginName}</h2>
            <span className="version">v{manifest.version}</span>
          </div>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {schemaEntries.map(([fieldName, field]) => (
            <div key={fieldName} className="config-field">
              <div className="field-header">
                <label htmlFor={fieldName}>{field.label || fieldName}</label>
                {field.premium && <span className="premium-badge">Premium</span>}
              </div>
              {field.description && (
                <p className="field-description">{field.description}</p>
              )}
              <div className="field-input">
                {renderField(fieldName, field)}
              </div>
            </div>
          ))}

          {errors.length > 0 && (
            <div className="error-box">
              {errors.map((err, i) => <div key={i}>{err}</div>)}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-reset" onClick={handleReset}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1 4v6h6M23 20v-6h-6" />
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
            </svg>
            Reset to Defaults
          </button>
          <div className="footer-actions">
            <button className="btn-cancel" onClick={onClose}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              Cancel
            </button>
            <button
              className="btn-save"
              onClick={handleSave}
              disabled={saving || !hasChanges}
            >
              {saving ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pcm-spin">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
              )}
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
      <style>{modalStyles}</style>
    </div>
  )
}

const modalStyles = `
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  }

  .plugin-config-modal {
    background: linear-gradient(rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.35)), var(--m-bg-float, rgba(255, 255, 255, 0.10));
    backdrop-filter: var(--qx-blur);
    -webkit-backdrop-filter: var(--qx-blur);
    border: 1px solid var(--m-border-default, rgba(255, 255, 255, 0.18));
    border-radius: var(--qx-radius, 20px);
    width: 100%;
    max-width: 520px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.18),
      inset 0 -1px 0 rgba(0, 0, 0, 0.45),
      0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 20px 24px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .header-content {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: #e4e4e7;
  }

  .version {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.05);
    padding: 2px 8px;
    border-radius: 4px;
  }

  .close-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.7);
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
    transition: color 0.2s;
  }

  .close-btn:hover {
    color: #e4e4e7;
  }

  .modal-body {
    padding: 24px;
    overflow-y: auto;
    flex: 1;
  }

  .config-field {
    margin-bottom: 24px;
  }

  .config-field:last-child {
    margin-bottom: 0;
  }

  .field-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .config-field label {
    font-weight: 500;
    color: #e4e4e7;
    font-size: 0.9rem;
  }

  .premium-badge {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #c084fc;
    background: rgba(157, 78, 221, 0.15);
    padding: 2px 6px;
    border-radius: 4px;
    border: 1px solid rgba(157, 78, 221, 0.3);
  }

  .field-description {
    margin: 0 0 10px 0;
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.5;
  }

  .field-input input[type="text"],
  .field-input input[type="password"],
  .field-input select {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #e4e4e7;
    font-size: 0.9rem;
    transition: border-color 0.2s, background 0.2s;
  }

  .field-input input[type="text"]:focus,
  .field-input input[type="password"]:focus,
  .field-input select:focus {
    outline: none;
    border-color: rgba(157, 78, 221, 0.5);
    background: rgba(255, 255, 255, 0.05);
  }

  .field-input select {
    cursor: pointer;
  }

  .number-field {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .number-field input[type="range"] {
    flex: 1;
    height: 6px;
    -webkit-appearance: none;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    cursor: pointer;
  }

  .number-field input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    background: linear-gradient(135deg, #9d4edd, #7c3aed);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(157, 78, 221, 0.4);
  }

  .number-value {
    min-width: 48px;
    text-align: center;
    font-weight: 600;
    color: #c084fc;
    font-size: 0.9rem;
    background: rgba(157, 78, 221, 0.1);
    padding: 4px 8px;
    border-radius: 6px;
  }

  .toggle-field {
    display: flex;
    align-items: center;
    gap: 12px;
    cursor: pointer;
  }

  .toggle-field input {
    display: none;
  }

  .toggle-slider {
    width: 44px;
    height: 24px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    position: relative;
    transition: background 0.2s;
  }

  .toggle-slider::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    background: rgba(255, 255, 255, 0.75);
    border-radius: 50%;
    transition: transform 0.2s, background 0.2s;
  }

  .toggle-field input:checked + .toggle-slider {
    background: rgba(157, 78, 221, 0.3);
  }

  .toggle-field input:checked + .toggle-slider::after {
    transform: translateX(20px);
    background: #9d4edd;
  }

  .toggle-label {
    font-size: 0.85rem;
    color: #a1a1aa;
  }

  .error-box {
    margin-top: 16px;
    padding: 12px 16px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    color: #f87171;
    font-size: 0.85rem;
  }

  .modal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.2);
    border-radius: 0 0 16px 16px;
  }

  .footer-actions {
    display: flex;
    gap: 12px;
  }

  .btn-reset,
  .btn-cancel,
  .btn-save {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 10px 20px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.9rem;
    transition: all 0.2s;
  }
  .btn-reset svg, .btn-cancel svg, .btn-save svg { flex-shrink: 0; }
  .pcm-spin { animation: pcm-spin 0.8s linear infinite; }
  @keyframes pcm-spin { to { transform: rotate(360deg); } }

  .btn-reset {
    background: transparent;
    color: rgba(255, 255, 255, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .btn-reset:hover {
    color: #a1a1aa;
    border-color: rgba(255, 255, 255, 0.2);
  }

  .btn-cancel {
    background: rgba(255, 255, 255, 0.05);
    color: #a1a1aa;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .btn-cancel:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .btn-save {
    background: linear-gradient(135deg, rgba(157, 78, 221, 0.3), rgba(124, 58, 237, 0.2));
    color: #c084fc;
    border: 1px solid rgba(157, 78, 221, 0.4);
  }

  .btn-save:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(157, 78, 221, 0.4), rgba(124, 58, 237, 0.3));
    border-color: rgba(157, 78, 221, 0.6);
  }

  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

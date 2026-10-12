/**
 * LicenseActivation Component
 *
 * Modal for entering a license key (JSON format).
 * Validates locally and shows success/error feedback.
 */

import React, { useState } from 'react'
import { fetchEntitlements } from '../../services/licenseValidator'
import { useAuth } from '../../contexts/AuthContext'

export default function LicenseActivation({ onClose, onActivated }) {
  const { authFetch } = useAuth()
  const [licenseKey, setLicenseKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!licenseKey.trim()) {
      setError('Please paste your license key')
      return
    }

    setLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const response = await authFetch('/api/setup/licensing/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: licenseKey.trim() })
      })

      const data = await response.json().catch(() => ({}))

      if (response.status === 409) {
        setError(`This licence is active on '${data.bound_instance_name || 'another instance'}'. Deactivate it there (or in the quox.ai admin) first.`)
        setLoading(false)
        return
      }

      if (!response.ok) {
        throw new Error(data.message || data.error || 'Failed to activate license')
      }

      // Refresh the entitlement cache so gates reflect the new licence immediately
      try {
        await fetchEntitlements(authFetch)
      } catch (refreshErr) {
        console.warn('[LicenseActivation] Entitlements refresh failed:', refreshErr.message)
      }

      setSuccess({
        message: 'License activated!',
        detail: 'Your entitlements have been refreshed. Available on all devices.'
      })

      setLoading(false)

      setTimeout(() => {
        onActivated?.(data)
      }, 1500)
    } catch (err) {
      setLoading(false)
      setError(err.message || 'Failed to activate license')
    }
  }

  return (
    <div className="license-modal-overlay" onClick={onClose}>
      <div className="license-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Activate License</h2>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {success ? (
              <div className="success-state">
                <div className="success-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M20 6L9 17l-5-5"/>
                  </svg>
                </div>
                <h3 className="success-title">{success.message}</h3>
                <p className="success-detail">{success.detail}</p>
              </div>
            ) : (
              <>
                <p className="modal-description">
                  Paste your license key below. You can find this in your purchase confirmation email.
                </p>

                <div className="input-group">
                  <label htmlFor="license-key">License Key</label>
                  <textarea
                    id="license-key"
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value)}
                    placeholder='{"id":"lic_...","customer_id":"cust_...","tiers":[...],...}'
                    disabled={loading}
                    autoFocus
                    autoComplete="off"
                    spellCheck="false"
                    rows={4}
                  />
                  <span className="input-hint">
                    Paste the entire JSON license key from your email
                  </span>
                </div>

                {error && (
                  <div className="error-message">
                    <svg className="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span>{error}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {!success && (
            <div className="modal-footer">
              <button
                type="button"
                className="cancel-btn"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="submit-btn"
                disabled={loading || !licenseKey.trim()}
              >
                {loading ? 'Activating...' : 'Activate License'}
              </button>
            </div>
          )}
        </form>
      </div>

      <style>{`
        .license-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .license-modal {
          background: var(--bg, #0a0a0f);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 12px;
          width: 100%;
          max-width: 500px;
          max-height: 90vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          animation: slideIn 0.3s ease;
        }

        @keyframes slideIn {
          from { transform: translateY(-20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        }

        .modal-header h2 {
          margin: 0;
          font-size: 1.2rem;
          color: var(--text, #e8e8e8);
        }

        .close-btn {
          background: none;
          border: none;
          color: var(--text-muted, #777);
          font-size: 1.5rem;
          cursor: pointer;
          padding: 0;
          line-height: 1;
        }

        .close-btn:hover {
          color: var(--text, #e8e8e8);
        }

        .modal-body {
          padding: 20px;
          overflow-y: auto;
        }

        .modal-description {
          margin: 0 0 16px 0;
          color: var(--text-muted, #777);
          font-size: 0.9rem;
          line-height: 1.5;
        }

        .input-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .input-group label {
          font-size: 0.9rem;
          font-weight: 500;
          color: var(--text, #e8e8e8);
        }

        .input-group textarea {
          width: 100%;
          padding: 14px 16px;
          background: var(--surface, #12121a);
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 6px;
          color: var(--text, #e8e8e8);
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 0.85rem;
          letter-spacing: 0.02em;
          box-sizing: border-box;
          resize: vertical;
          min-height: 100px;
        }

        .input-group textarea:focus {
          outline: none;
          border-color: #3090ff;
        }

        .input-group textarea::placeholder {
          color: var(--text-muted, #444);
          letter-spacing: 0.01em;
          font-size: 0.8rem;
        }

        .input-hint {
          display: block;
          margin-top: 8px;
          font-size: 0.75rem;
          color: var(--text-muted, #666);
        }

        .error-message {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          margin-top: 12px;
          padding: 12px 14px;
          background: rgba(255, 64, 64, 0.1);
          border: 1px solid rgba(255, 64, 64, 0.3);
          border-radius: 6px;
          color: #ff6b6b;
          font-size: 0.85rem;
          line-height: 1.4;
        }

        .error-icon {
          width: 18px;
          height: 18px;
          flex-shrink: 0;
          margin-top: 1px;
        }

        .success-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          padding: 20px 0;
        }

        .success-icon {
          width: 64px;
          height: 64px;
          background: rgba(52, 211, 153, 0.15);
          border: 2px solid rgba(52, 211, 153, 0.4);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-bottom: 16px;
          animation: successPop 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        @keyframes successPop {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.1); }
          100% { transform: scale(1); opacity: 1; }
        }

        .success-icon svg {
          width: 32px;
          height: 32px;
          color: #34d399;
        }

        .success-title {
          margin: 0 0 8px 0;
          font-size: 1.2rem;
          font-weight: 600;
          color: #34d399;
        }

        .success-detail {
          margin: 0;
          font-size: 0.9rem;
          color: var(--text-muted, #888);
        }

        .modal-footer {
          display: flex;
          justify-content: flex-end;
          gap: 12px;
          padding: 16px 20px;
          border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        }

        .cancel-btn {
          padding: 10px 20px;
          background: transparent;
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          border-radius: 6px;
          color: var(--text-muted, #777);
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s;
        }

        .cancel-btn:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.05);
          color: var(--text, #e8e8e8);
        }

        .submit-btn {
          padding: 10px 20px;
          background: rgba(48, 144, 255, 0.2);
          border: 1px solid rgba(48, 144, 255, 0.4);
          border-radius: 6px;
          color: #3090ff;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s;
        }

        .submit-btn:hover:not(:disabled) {
          background: rgba(48, 144, 255, 0.3);
        }

        .submit-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .cancel-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  )
}

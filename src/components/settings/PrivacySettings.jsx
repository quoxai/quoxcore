/**
 * PrivacySettings Component (Security Issue #72)
 *
 * Manages user consent for third-party AI data sharing.
 * Users must explicitly consent before their data is sent to
 * third-party AI providers like OpenAI, Anthropic, Perplexity, etc.
 *
 * Features:
 * - Main consent toggle for AI data sharing
 * - Provider-specific consent controls
 * - Consent history view
 * - Clear explanation of what data is shared
 */

import React, { useState, useEffect, useCallback } from 'react'
import SettingsSection from './SettingsSection'
import SettingsCard, { SettingsGroup, SettingsCardGroup } from './SettingsCard'
import { SettingItem } from '../ui/Input'
import Button from '../ui/Button'
import PlatformFlagsPanel from './PlatformFlagsPanel'
import {
  getConsentStatus,
  updateConsent,
  getConsentHistory,
  THIRD_PARTY_PROVIDERS
} from '../../services/consentService'

// Phase 25 (owner mandate 2026-08-06): privacy-relevant platform flags —
// server-side, org-scoped, override the env default, admin-only, audited.
// See services/collector/lib/platformSettingsStore.js.
// VAULT-INTEG P17: group-driven instead of a hand-curated key list — every
// settable entry tagged group:'privacy' renders here automatically.

export default function PrivacySettings({ onNotification }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [consent, setConsent] = useState({
    ai_data_sharing_consent: false,
    provider_consent: {},
    needs_re_consent: false
  })
  const [history, setHistory] = useState([])
  const [showHistory, setShowHistory] = useState(false)

  // Load consent status
  const loadConsent = useCallback(async () => {
    setLoading(true)
    try {
      const status = await getConsentStatus()
      setConsent(status)
      if (status?.error) {
        onNotification?.(`Failed to load privacy settings: ${status.error}`, 'error')
      }
    } catch (err) {
      console.error('Failed to load consent status:', err)
      onNotification?.('Failed to load privacy settings', 'error')
    } finally {
      setLoading(false)
    }
  }, [onNotification])

  // Load history
  const loadHistory = useCallback(async () => {
    try {
      const hist = await getConsentHistory(20)
      setHistory(hist)
    } catch (err) {
      console.error('Failed to load consent history:', err)
    }
  }, [])

  useEffect(() => {
    loadConsent()
  }, [loadConsent])

  useEffect(() => {
    if (showHistory) {
      loadHistory()
    }
  }, [showHistory, loadHistory])

  // Handle main consent toggle
  const handleConsentChange = async (enabled) => {
    setSaving(true)
    try {
      await updateConsent(enabled, consent.provider_consent)
      setConsent(prev => ({
        ...prev,
        ai_data_sharing_consent: enabled,
        ai_data_sharing_consent_at: enabled ? new Date().toISOString() : prev.ai_data_sharing_consent_at
      }))
      onNotification?.(
        enabled
          ? 'AI data sharing enabled. Your data may now be sent to third-party AI providers.'
          : 'AI data sharing disabled. Your data will not be sent to third-party AI providers.',
        enabled ? 'success' : 'info'
      )
    } catch (err) {
      console.error('Failed to update consent:', err)
      onNotification?.(err.message || 'Failed to update privacy settings', 'error')
    } finally {
      setSaving(false)
    }
  }

  // Handle provider-specific consent toggle
  const handleProviderConsentChange = async (provider, enabled) => {
    setSaving(true)
    try {
      const newProviderConsent = {
        ...consent.provider_consent,
        [provider]: enabled
      }
      await updateConsent(consent.ai_data_sharing_consent, newProviderConsent)
      setConsent(prev => ({
        ...prev,
        provider_consent: newProviderConsent
      }))
      onNotification?.(`${provider} ${enabled ? 'enabled' : 'disabled'}`, 'success')
    } catch (err) {
      console.error('Failed to update provider consent:', err)
      onNotification?.(err.message || 'Failed to update provider settings', 'error')
    } finally {
      setSaving(false)
    }
  }

  // Provider display names and descriptions
  const providerInfo = {
    openai: {
      name: 'OpenAI',
      description: 'GPT-4, GPT-3.5, embeddings, and other OpenAI models',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.896zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
        </svg>
      )
    },
    anthropic: {
      name: 'Anthropic',
      description: 'Claude models for chat and analysis',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 19.5h20L12 2z"/><path d="M12 6l6.5 11.5h-13L12 6z"/>
        </svg>
      )
    },
    perplexity: {
      name: 'Perplexity',
      description: 'Web-connected AI for research and fact-checking',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 6v6l4.5 4.5"/>
        </svg>
      )
    },
    gemini: {
      name: 'Google Gemini',
      description: 'Google AI models for various tasks',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      )
    },
    google: {
      name: 'Google AI',
      description: 'Google AI services and APIs',
      icon: (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.545 10.239v3.821h5.445c-.712 2.315-2.647 3.972-5.445 3.972-3.332 0-6.033-2.701-6.033-6.032s2.701-6.032 6.033-6.032c1.498 0 2.866.549 3.921 1.453l2.814-2.814C17.503 2.988 15.139 2 12.545 2 7.021 2 2.543 6.477 2.543 12s4.478 10 10.002 10c8.396 0 10.249-7.85 9.426-11.748L12.545 10.239z"/>
        </svg>
      )
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--ui-text-muted)' }}>
        Loading privacy settings...
      </div>
    )
  }

  return (
    <div>
      {/* Re-consent Banner */}
      {consent.needs_re_consent && (
        <div style={{
          background: 'rgba(251, 191, 36, 0.15)',
          border: '1px solid rgba(251, 191, 36, 0.5)',
          borderRadius: '8px',
          padding: '16px 20px',
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px'
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div>
            <strong style={{ color: '#fbbf24' }}>Privacy Policy Updated</strong>
            <p style={{ margin: '4px 0 0', fontSize: '14px', color: 'var(--ui-text-secondary)' }}>
              Our privacy policy has been updated. Please review and re-confirm your consent preferences.
            </p>
          </div>
        </div>
      )}

      <SettingsSection
        title="AI Data Sharing"
        description="Control whether your data can be sent to third-party AI providers"
      >
        <SettingsCard glass>
          {/* Main consent explanation */}
          <div style={{
            background: 'rgba(59, 130, 246, 0.1)',
            borderRadius: '8px',
            padding: '16px',
            marginBottom: '20px'
          }}>
            <h4 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: '600', color: 'var(--ui-blue)' }}>
              What data is shared?
            </h4>
            <ul style={{
              margin: '0',
              paddingLeft: '20px',
              fontSize: '13px',
              color: 'var(--ui-text-secondary)',
              lineHeight: '1.8'
            }}>
              <li>Your messages and queries sent to AI assistants</li>
              <li>Context from your documents used for AI analysis</li>
              <li>Text content for generating embeddings (semantic search)</li>
              <li>System prompts and configuration settings</li>
            </ul>
            <p style={{
              margin: '12px 0 0',
              fontSize: '13px',
              color: 'var(--ui-text-muted)',
              fontStyle: 'italic'
            }}>
              We do not share your personal information, passwords, or API keys with AI providers.
            </p>
          </div>

          <SettingsGroup>
            <SettingItem
              label="Enable Third-Party AI Data Sharing"
              description={
                consent.ai_data_sharing_consent
                  ? `Enabled on ${new Date(consent.ai_data_sharing_consent_at).toLocaleDateString()}`
                  : 'Your data will not be sent to external AI providers'
              }
              checked={consent.ai_data_sharing_consent}
              onChange={(e) => handleConsentChange(e.target.checked)}
              disabled={saving}
            />
          </SettingsGroup>

          {/* Consent status indicator */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: '16px',
            padding: '12px 16px',
            borderRadius: '8px',
            background: consent.ai_data_sharing_consent
              ? 'rgba(74, 222, 128, 0.1)'
              : 'rgba(239, 68, 68, 0.1)'
          }}>
            <div style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: consent.ai_data_sharing_consent ? '#4ade80' : '#ef4444'
            }} />
            <span style={{
              fontSize: '14px',
              fontWeight: '500',
              color: consent.ai_data_sharing_consent ? '#4ade80' : '#ef4444'
            }}>
              {consent.ai_data_sharing_consent
                ? 'AI features enabled - data may be sent to third-party providers'
                : 'AI features limited - using local/fallback processing only'}
            </span>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Transcript & Content Storage"
        description="Control how much of your chat activity is durably stored server-side"
      >
        <PlatformFlagsPanel
          group="privacy"
          title="Storage Flags"
          onNotification={onNotification}
        />
      </SettingsSection>

      {/* Provider-specific controls - only show if main consent is enabled */}
      {consent.ai_data_sharing_consent && (
        <SettingsSection
          title="Provider Settings"
          description="Fine-tune which AI providers can receive your data"
        >
          <SettingsCard glass>
            <div style={{
              display: 'grid',
              gap: '12px'
            }}>
              {THIRD_PARTY_PROVIDERS.map(providerId => {
                const info = providerInfo[providerId] || {
                  name: providerId,
                  description: 'AI provider',
                  icon: null
                }
                const isEnabled = consent.provider_consent[providerId] !== false

                return (
                  <div
                    key={providerId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 16px',
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderRadius: '8px',
                      border: '1px solid var(--ui-border-subtle)'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: isEnabled ? 'var(--ui-blue)' : 'var(--ui-text-muted)'
                      }}>
                        {info.icon}
                      </div>
                      <div>
                        <div style={{ fontWeight: '500', color: 'var(--ui-text-primary)' }}>
                          {info.name}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--ui-text-muted)' }}>
                          {info.description}
                        </div>
                      </div>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        onChange={(e) => handleProviderConsentChange(providerId, e.target.checked)}
                        disabled={saving}
                        style={{
                          width: '18px',
                          height: '18px',
                          accentColor: 'var(--ui-blue)'
                        }}
                      />
                    </label>
                  </div>
                )
              })}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Consent History */}
      <SettingsSection
        title="Consent History"
        description="View your consent preference changes"
      >
        <SettingsCard glass>
          <Button
            variant="secondary"
            onClick={() => setShowHistory(!showHistory)}
            style={{ marginBottom: showHistory ? '16px' : '0' }}
          >
            {showHistory ? 'Hide History' : 'Show History'}
          </Button>

          {showHistory && (
            <div style={{ marginTop: '16px' }}>
              {history.length === 0 ? (
                <p style={{ color: 'var(--ui-text-muted)', fontSize: '14px', margin: 0 }}>
                  No consent changes recorded yet.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {history.map((entry, index) => (
                    <div
                      key={entry.id || index}
                      style={{
                        padding: '12px',
                        background: 'rgba(255, 255, 255, 0.02)',
                        borderRadius: '6px',
                        fontSize: '13px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '500', color: 'var(--ui-text-primary)' }}>
                          {entry.consent_type === 'ai_data_sharing' ? 'AI Data Sharing' : entry.consent_type}
                        </span>
                        <span style={{ color: 'var(--ui-text-muted)' }}>
                          {new Date(entry.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div style={{ color: 'var(--ui-text-secondary)' }}>
                        {entry.new_value?.ai_data_sharing_consent
                          ? 'Consent granted'
                          : 'Consent revoked'}
                        {entry.ip_address && (
                          <span style={{ color: 'var(--ui-text-muted)', marginLeft: '8px' }}>
                            from {entry.ip_address}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Data Processing Info */}
      <SettingsSection
        title="How Your Data is Processed"
        description="Understanding the data flow"
      >
        <SettingsCard glass>
          <div style={{
            display: 'grid',
            gap: '16px'
          }}>
            <div>
              <h4 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: '600', color: 'var(--ui-text-primary)' }}>
                With Consent Enabled
              </h4>
              <ul style={{
                margin: 0,
                paddingLeft: '20px',
                fontSize: '13px',
                color: 'var(--ui-text-secondary)',
                lineHeight: '1.8'
              }}>
                <li>Your queries are sent to selected AI providers for processing</li>
                <li>Documents can be analyzed using advanced AI models</li>
                <li>Semantic search uses cloud-based embeddings for better accuracy</li>
                <li>Full AI assistant capabilities are available</li>
              </ul>
            </div>

            <div>
              <h4 style={{ margin: '0 0 8px', fontSize: '14px', fontWeight: '600', color: 'var(--ui-text-primary)' }}>
                Without Consent (Default)
              </h4>
              <ul style={{
                margin: 0,
                paddingLeft: '20px',
                fontSize: '13px',
                color: 'var(--ui-text-secondary)',
                lineHeight: '1.8'
              }}>
                <li>No data is sent to external AI providers</li>
                <li>Local/fallback processing is used where possible</li>
                <li>Some AI features may be limited or unavailable</li>
                <li>Your data stays on your infrastructure</li>
              </ul>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

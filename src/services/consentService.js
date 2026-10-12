/**
 * Consent Service (Security Issue #72)
 *
 * Manages user consent for third-party AI data sharing.
 * CRITICAL: Data must NOT be sent to AI providers without explicit consent.
 *
 * Features:
 * - Get/update consent status
 * - Verify consent before AI calls
 * - Track consent history
 * - Log consent changes
 */

import { logOperation } from './auditLogger'
import { csrfFetch } from '../utils/csrfFetch'
import { buildAuthApiUrl } from './authApiUrl'

/**
 * Get the API URL
 */
function getApiUrl(path) {
  return buildAuthApiUrl(path)
}

// Cache for consent status (short TTL)
let consentCache = null
let consentCacheTime = 0
const CONSENT_CACHE_TTL = 30000 // 30 seconds

// Third-party providers that require consent
export const THIRD_PARTY_PROVIDERS = ['openai', 'anthropic', 'perplexity', 'gemini', 'google']

/**
 * Get current consent status
 * @returns {Promise<Object>} Consent status
 */
export async function getConsentStatus() {
  const now = Date.now()

  // Return cached if valid
  if (consentCache && (now - consentCacheTime) < CONSENT_CACHE_TTL) {
    return consentCache
  }

  try {
    const response = await fetch(getApiUrl('/consent'), {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error('Failed to fetch consent status')
    }

    const data = await response.json()
    consentCache = data
    consentCacheTime = now
    return data
  } catch (err) {
    console.error('[Consent] Failed to get status:', err.message)
    // Return safe default (no consent)
    return {
      ai_data_sharing_consent: false,
      provider_consent: {},
      third_party_providers: THIRD_PARTY_PROVIDERS,
      error: err.message
    }
  }
}

/**
 * Update consent preferences
 * @param {boolean} aiDataSharingConsent - Whether to consent to AI data sharing
 * @param {Object} providerConsent - Provider-specific consent overrides
 * @returns {Promise<Object>} Updated consent status
 */
export async function updateConsent(aiDataSharingConsent, providerConsent = {}) {
  try {
    const response = await csrfFetch(getApiUrl('/consent'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ai_data_sharing_consent: aiDataSharingConsent,
        provider_consent: providerConsent
      })
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }))
      throw new Error(error.message || 'Failed to update consent')
    }

    const data = await response.json()

    // Clear cache to force refresh
    consentCache = null
    consentCacheTime = 0

    // Audit log
    logOperation({
      operation: aiDataSharingConsent ? 'consent.ai_data_sharing.granted' : 'consent.ai_data_sharing.revoked',
      query: 'User updated AI data sharing consent',
      result: 'success',
      metadata: {
        consent: aiDataSharingConsent,
        providers: THIRD_PARTY_PROVIDERS
      }
    })

    return data
  } catch (err) {
    console.error('[Consent] Failed to update:', err.message)
    throw err
  }
}

/**
 * Verify consent before making an AI provider call
 * This should be called BEFORE sending any data to third-party AI providers
 *
 * @param {string} provider - AI provider name (openai, anthropic, etc.)
 * @param {string} endpoint - Optional endpoint type (chat, embeddings, etc.)
 * @returns {Promise<Object>} Verification result with consented boolean
 */
export async function verifyConsent(provider, endpoint = 'unknown') {
  // Check if this provider requires consent
  if (!THIRD_PARTY_PROVIDERS.includes(provider?.toLowerCase())) {
    return { consented: true, requires_consent: false, provider }
  }

  try {
    const response = await csrfFetch(getApiUrl('/consent/verify'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ provider, endpoint })
    })

    if (!response.ok) {
      // Fail closed - if verification fails, deny
      console.error('[Consent] Verification request failed')
      return {
        consented: false,
        provider,
        blocked_reason: 'verification_failed',
        message: 'Failed to verify consent - defaulting to deny'
      }
    }

    return await response.json()
  } catch (err) {
    console.error('[Consent] Verification error:', err.message)
    // Fail closed
    return {
      consented: false,
      provider,
      blocked_reason: 'verification_error',
      message: err.message
    }
  }
}

/**
 * Get consent change history
 * @param {number} limit - Maximum number of entries
 * @returns {Promise<Array>} History entries
 */
export async function getConsentHistory(limit = 50) {
  try {
    const response = await fetch(getApiUrl(`/consent/history?limit=${limit}`), {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error('Failed to fetch consent history')
    }

    const data = await response.json()
    return data.history || []
  } catch (err) {
    console.error('[Consent] Failed to get history:', err.message)
    return []
  }
}

/**
 * Check if user has consented to a specific provider
 * This is a quick check using cached consent status
 *
 * @param {string} provider - AI provider name
 * @returns {Promise<boolean>} Whether consent is granted
 */
export async function hasConsentFor(provider) {
  const status = await getConsentStatus()

  // No general consent = no access
  if (!status.ai_data_sharing_consent) {
    return false
  }

  // Check provider-specific override
  const providerConsent = status.provider_consent || {}
  if (providerConsent[provider?.toLowerCase()] === false) {
    return false
  }

  return true
}

/**
 * Clear consent cache (call when user logs out or changes)
 */
export function clearConsentCache() {
  consentCache = null
  consentCacheTime = 0
}

/**
 * Create a consent-gated fetch wrapper
 * Wraps fetch to check consent before calling third-party AI APIs
 *
 * @param {string} provider - AI provider name
 * @returns {Function} Wrapped fetch function that checks consent
 */
export function createConsentGatedFetch(provider) {
  return async (url, options = {}) => {
    // Verify consent first
    const verification = await verifyConsent(provider, options.endpoint || 'api_call')

    if (!verification.consented) {
      const error = new Error(`AI data sharing consent required for ${provider}`)
      error.code = 'CONSENT_REQUIRED'
      error.provider = provider
      error.blocked_reason = verification.blocked_reason
      throw error
    }

    // Consent verified, proceed with the request
    return fetch(url, options)
  }
}

export default {
  getConsentStatus,
  updateConsent,
  verifyConsent,
  getConsentHistory,
  hasConsentFor,
  clearConsentCache,
  createConsentGatedFetch,
  THIRD_PARTY_PROVIDERS
}

/**
 * Plugin Client - API client for QuoxAgent plugin and license management
 *
 * Provides functions to:
 * - Check license status (local first, API fallback)
 * - Activate licenses (validates locally, stores in browser)
 * - List and manage plugins
 * - Access the plugin store
 *
 * License validation is now decoupled from QuoxAgent - the dashboard
 * can validate and store licenses locally using Ed25519 verification.
 */

import {
  getLicenseStatus as getLocalLicenseStatus,
  activateLicense as activateLocalLicense,
  isPluginLicensed,
  hasTier,
  getStoredLicense,
  getPluginTier as resolvePluginTier
} from './licenseValidator'
import { start as startHeartbeat } from './heartbeatService'
import { logPluginEnabled, logPluginDisabled, logLicenseActivated } from './pluginAudit'
import { syncPreferenceToServer } from './userPreferences'
import { invalidateReflectionCache } from './reflectionService'

// QuoxAgent agent API endpoint (proxied via vite/nginx)
const MHA_AGENT_URL = '/mha-agent';
const AGENT_OFFLINE_TTL_MS = 30000;
let agentOfflineUntil = 0;

// Cross-tab sync: when another tab/window changes plugin state, notify this tab
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'quox-extensions-state') {
      window.dispatchEvent(new CustomEvent('quox-settings-change'))
    }
  })
}

/**
 * Safely parse JSON response with content-type validation
 * Returns null if response is not valid JSON
 */
async function safeJsonParse(response) {
  const contentType = response?.headers?.get?.('content-type');
  if (!contentType) {
    if (typeof response?.json === 'function') {
      return response.json();
    }
    const text = await response.text();
    if (text.trim().startsWith('<')) {
      throw new Error('Plugin service returned HTML instead of JSON. The service may be offline or misconfigured.');
    }
    throw new Error('Unexpected response type: unknown');
  }
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    // Check if it looks like HTML (common error page)
    if (text.trim().startsWith('<')) {
      throw new Error('Plugin service returned HTML instead of JSON. The service may be offline or misconfigured.');
    }
    throw new Error(`Unexpected response type: ${contentType || 'unknown'}`);
  }
  return response.json();
}

function isAgentOfflineCached() {
  return Date.now() < agentOfflineUntil;
}

function markAgentOffline() {
  agentOfflineUntil = Date.now() + AGENT_OFFLINE_TTL_MS;
}

function clearAgentOffline() {
  agentOfflineUntil = 0;
}

function isExpectedAgentOfflineError(err) {
  return Boolean(
    err?.cachedOffline
    || /Plugin service unavailable/i.test(err?.message || '')
    || /Failed to fetch plugins: 5\d\d/i.test(err?.message || '')
    || /Failed to fetch store plugins: 5\d\d/i.test(err?.message || '')
  );
}

async function fetchAgentGet(path) {
  if (isAgentOfflineCached()) {
    const error = new Error('Plugin service unavailable (cached)');
    error.cachedOffline = true;
    throw error;
  }

  try {
    const res = await fetch(`${MHA_AGENT_URL}${path}`);
    if (res.status >= 500) {
      markAgentOffline();
    } else if (res.ok) {
      clearAgentOffline();
    }
    return res;
  } catch (err) {
    markAgentOffline();
    throw err;
  }
}

/**
 * Get current license status
 * Checks local storage first, falls back to API if needed
 * @returns {Promise<{valid: boolean, licensed: boolean, customer_name?: string, tiers: string[], expires_at?: string, days_remaining?: number, error?: string}>}
 */
export async function getLicenseStatus() {
  // Check local license first (primary source of truth)
  const localStatus = getLocalLicenseStatus()
  if (localStatus.licensed) {
    return { ...localStatus, source: 'local' }
  }

  // If no local license, try API as fallback (for legacy compatibility)
  try {
    const res = await fetchAgentGet('/api/v1/license');
    if (!res.ok) {
      return { ...localStatus, offline: true, source: 'local' };
    }
    const apiStatus = await safeJsonParse(res);
    return { ...apiStatus, source: 'api' };
  } catch (err) {
    // API unavailable - return local status (which is free tier if no license)
    if (!isExpectedAgentOfflineError(err)) {
      console.warn('[Plugin] Failed to fetch remote license status, using local status:', err);
    }
    return { ...localStatus, offline: true, source: 'local' };
  }
}

/**
 * Activate a license with a key
 * Validates locally using Ed25519, stores in browser localStorage
 * Optionally syncs to QuoxAgent if available
 * @param {string} licenseKey - The license key (JSON format)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export async function activateLicense(licenseKey, authFetch) {
  // Clean the key - trim whitespace
  const cleanKey = licenseKey.trim();

  if (!cleanKey) {
    return { success: false, error: 'License key cannot be empty' };
  }

  // Validate and store on server (instance-wide)
  const localResult = await activateLocalLicense(cleanKey, authFetch);

  if (!localResult.success) {
    return localResult;
  }

  // License validated and stored locally - now try to sync with agent
  try {
    const res = await fetch(`${MHA_AGENT_URL}/api/v1/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: cleanKey })
    });

    if (res.ok) {
      console.log('[Plugin] License synced to QuoxAgent');
    } else {
      console.log('[Plugin] Could not sync to QuoxAgent (agent may be offline)');
    }
  } catch (err) {
    // Agent sync failed - that's OK, local activation succeeded
    console.log('[Plugin] Agent sync skipped:', err.message);
  }

  // License is now stored — start heartbeat if telemetry is enabled
  // (initHeartbeat runs at boot, but if no license existed then it silently skips)
  startHeartbeat()

  logLicenseActivated()

  return {
    success: true,
    ...localResult,
    message: localResult.message || 'License activated successfully'
  };
}

/**
 * Get list of all plugins with their status
 * @returns {Promise<{count: number, plugins: PluginInfo[]}>}
 */
export async function getPlugins() {
  try {
    const res = await fetchAgentGet('/api/v1/plugins');
    if (!res.ok) {
      throw new Error(`Failed to fetch plugins: ${res.status}`);
    }
    return await safeJsonParse(res);
  } catch (err) {
    if (!isExpectedAgentOfflineError(err)) {
      console.error('[Plugin] Failed to get plugins:', err);
    }
    return { count: 0, plugins: [], error: err.message, offline: true };
  }
}

/**
 * Get details for a specific plugin
 * @param {string} name - Plugin name
 * @returns {Promise<PluginInfo|null>}
 */
export async function getPlugin(name) {
  try {
    const res = await fetchAgentGet(`/api/v1/plugins/${name}`);
    if (!res.ok) return null;
    return await safeJsonParse(res);
  } catch (err) {
    if (!isExpectedAgentOfflineError(err)) {
      console.error(`[Plugin] Failed to get plugin ${name}:`, err);
    }
    return null;
  }
}

/**
 * Enable a plugin
 * @param {string} name - Plugin name
 * @returns {Promise<{success: boolean, status?: string, error?: string}>}
 */
export async function enablePlugin(name) {
  // Always sync enabled state to localStorage + server for cross-device persistence
  // This must happen regardless of whether the agent API is reachable
  try {
    const state = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}')
    state[name] = true
    localStorage.setItem('quox-extensions-state', JSON.stringify(state))
    // Send full state — serverSyncQueue does read-modify-write at the namespace level
    syncPreferenceToServer('extensions', state)
    // Notify same-tab listeners (storage event only fires in OTHER tabs)
    window.dispatchEvent(new CustomEvent('quox-settings-change'))
    // Plugin state is a real mutation the Mirror reflects — force the next
    // read to rebuild instead of serving a stale 30s-old snapshot.
    invalidateReflectionCache()
  } catch { /* fire-and-forget */ }

  logPluginEnabled(name)

  // Also notify QuoxAgent if available (best-effort)
  try {
    const res = await fetch(`${MHA_AGENT_URL}/api/v1/plugins/${name}/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await safeJsonParse(res);
    if (!res.ok) {
      // Agent rejected, but local state is already saved
      console.warn(`[Plugin] Agent rejected enable for ${name}:`, data.error)
    }
    return { success: true, ...data };
  } catch (err) {
    // Agent offline — local enable still succeeded
    console.log(`[Plugin] Agent offline, enabled ${name} locally`);
    return { success: true, status: 'enabled', source: 'local' };
  }
}

/**
 * Disable a plugin
 * @param {string} name - Plugin name
 * @returns {Promise<{success: boolean, status?: string, error?: string}>}
 */
export async function disablePlugin(name) {
  // Always sync disabled state to localStorage + server for cross-device persistence
  try {
    const state = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}')
    state[name] = false
    localStorage.setItem('quox-extensions-state', JSON.stringify(state))
    syncPreferenceToServer('extensions', state)
    // Notify same-tab listeners (storage event only fires in OTHER tabs)
    window.dispatchEvent(new CustomEvent('quox-settings-change'))
    // Plugin state is a real mutation the Mirror reflects — force the next
    // read to rebuild instead of serving a stale 30s-old snapshot.
    invalidateReflectionCache()
  } catch { /* fire-and-forget */ }

  logPluginDisabled(name)

  // Also notify QuoxAgent if available (best-effort)
  try {
    const res = await fetch(`${MHA_AGENT_URL}/api/v1/plugins/${name}/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await safeJsonParse(res);
    if (!res.ok) {
      console.warn(`[Plugin] Agent rejected disable for ${name}:`, data.error)
    }
    return { success: true, ...data };
  } catch (err) {
    console.log(`[Plugin] Agent offline, disabled ${name} locally`);
    return { success: true, status: 'disabled', source: 'local' };
  }
}

/**
 * Get list of plugins available in the store
 * @returns {Promise<{count: number, plugins: StorePlugin[]}>}
 */
export async function getStorePlugins() {
  try {
    const res = await fetchAgentGet('/api/v1/store/plugins');
    if (!res.ok) {
      throw new Error(`Failed to fetch store plugins: ${res.status}`);
    }
    return await safeJsonParse(res);
  } catch (err) {
    if (!isExpectedAgentOfflineError(err)) {
      console.error('[Plugin] Failed to get store plugins:', err);
    }
    return { count: 0, plugins: [], error: err.message, offline: true };
  }
}

// LICENSE-ENFORCE: requestTrialLicense removed. Self-minted trial licences
// were a forgery path (local agent minted keys the validator blind-trusted).
// All keys — including 30-day trials — are issued from quox.ai and activated
// through the seat-bound activation flow (POST /api/setup/licensing/activate).

/**
 * Check if a specific plugin is enabled
 * Uses local license to determine if plugin tier is licensed
 * Falls back to API for enable/disable state if available
 * @param {string} name - Plugin name
 * @returns {Promise<boolean>}
 */
export async function isPluginEnabled(name) {
  // First check if licensed locally
  const licensed = isPluginLicensed(name);

  if (!licensed) {
    return false;
  }

  // Check localStorage state first (synced across devices via server preferences)
  try {
    const state = JSON.parse(localStorage.getItem('quox-extensions-state') || '{}');
    if (name in state) {
      return state[name];
    }
  } catch { /* corrupt localStorage */ }

  // Fall back to agent API for enable/disable state
  try {
    const plugin = await getPlugin(name);
    if (plugin) {
      return plugin.enabled ?? true;
    }
  } catch (err) {
    // Agent unavailable
  }

  // Licensed locally, not in localStorage, agent unavailable — default enabled
  return true;
}

/**
 * Check if a plugin is licensed (without checking enable state)
 * @param {string} name - Plugin name
 * @returns {boolean}
 */
export function isPluginLicensedSync(name) {
  return isPluginLicensed(name);
}

/**
 * Get the required tier for a plugin.
 *
 * LICENSE-LAUNCH LL-4c: resolved through licenseValidator.getPluginTier(), which
 * prefers the signed product catalogue the auth service serves and falls back to
 * the local PLUGIN_TIERS map. This module no longer reads that map directly, so
 * there is exactly one place a tier is decided.
 *
 * The `tier_b` default is unchanged: when NEITHER the catalogue nor the fallback
 * knows the id, a paid-tier label is the safe display (never free).
 * @param {string} name - Plugin name
 * @returns {string} Tier code (free, tier_a, tier_b, tier_c, or a catalogue tier)
 */
export function getPluginTier(name) {
  return resolvePluginTier(name) || 'tier_b';
}

/**
 * Get tier display name
 * @param {string} tier - Tier code (free, tier_a, tier_b, tier_c)
 * @returns {string}
 */
export function getTierDisplayName(tier) {
  const names = {
    'free': 'Free',
    'tier_a': 'Starter',
    'tier_b': 'Pro',
    'tier_c': 'Enterprise',
    'starter': 'Starter',
    'standard': 'Standard',
    'pro': 'Pro',
    'enterprise': 'Enterprise'
  };
  return names[tier] || tier;
}

export function __resetPluginAgentCache() {
  clearAgentOffline();
}

/**
 * Get tier color for UI
 * @param {string} tier - Tier code
 * @returns {string} - CSS color
 */
export function getTierColor(tier) {
  const colors = {
    'free': '#30ff90',
    'tier_a': '#3090ff',
    'starter': '#3090ff',
    'tier_b': '#9d4edd',
    'standard': '#60a5fa',
    'pro': '#9d4edd',
    'tier_c': '#ffb030',
    'enterprise': '#ffb030'
  };
  return colors[tier] || '#777';
}

/**
 * Get status color for UI
 * @param {string} status - Plugin status (active, inactive, unlicensed)
 * @returns {string} - CSS color
 */
export function getStatusColor(status) {
  const colors = {
    'active': '#30ff90',     // green
    'inactive': '#777',      // gray
    'unlicensed': '#ff4040'  // red
  };
  return colors[status] || '#777';
}

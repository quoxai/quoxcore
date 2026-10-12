/**
 * UI Settings Service
 *
 * Manages UI preferences (advancedMode, compactMode, debugMode,
 * dummyDataEnabled) that affect component visibility and behavior.
 *
 * VOLT-FIX B: storage moved back to raw `quox-ui-settings` from the
 * org-scoped `personalGet/Set('ui-settings')` keys. The reason: server
 * hydration (userPreferences.hydrateFromServer) writes to the unscoped
 * key — when the reader pointed at the scoped key, settings synced
 * to the server fine but never made it back to the reader, so toggles
 * appeared not to stick after a hard refresh. UI prefs are user-level,
 * not per-org, so a single global key is the right scope anyway.
 */

import { syncPreferenceToServer } from './userPreferences'

const STORAGE_KEY = 'quox-ui-settings'

// Default settings
const DEFAULT_SETTINGS = {
  advancedMode: false,      // Show layer insights, AOCL details, technical metrics
  compactMode: false,       // Denser UI for power users
  debugMode: false,         // Extra debugging info (console, timing)
  dummyDataEnabled: false,  // Populate memory with demo/test data
  dashboardTabs: { enabled: null, order: null }, // /dashboard tab visibility+order (null = all on, registry order)
}

// In-memory cache
let cachedSettings = null

// Bust the cache when the underlying storage changes outside this module —
// fires for cross-tab writes AND for hydrateFromServer (which dispatches a
// synthetic 'storage' event after writing).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e || e.key === STORAGE_KEY || e.key === null) cachedSettings = null
  })
}

// Event listeners for settings changes
const listeners = new Set()

/**
 * Load settings from localStorage
 */
function loadSettings() {
  if (cachedSettings) return cachedSettings

  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
    cachedSettings = stored
      ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
      : { ...DEFAULT_SETTINGS }
  } catch (err) {
    console.warn('[UISettings] Failed to load:', err)
    cachedSettings = { ...DEFAULT_SETTINGS }
  }

  return cachedSettings
}

/**
 * Save settings to localStorage
 */
function saveSettings(settings) {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    }
    cachedSettings = settings
    // Notify all listeners
    listeners.forEach(fn => fn(settings))
    syncPreferenceToServer('uiSettings', settings)
  } catch (err) {
    console.error('[UISettings] Failed to save:', err)
  }
}

/**
 * Get all UI settings
 * @returns {Object} Current settings
 */
export function getUISettings() {
  return loadSettings()
}

/**
 * Get a specific setting
 * @param {string} key - Setting key
 * @returns {*} Setting value
 */
export function getUISetting(key) {
  const settings = loadSettings()
  return settings[key]
}

/**
 * Check if advanced mode is enabled
 * @returns {boolean}
 */
export function isAdvancedMode() {
  return getUISetting('advancedMode') === true
}

/**
 * Update a setting
 * @param {string} key - Setting key
 * @param {*} value - New value
 */
export function setUISetting(key, value) {
  const settings = loadSettings()
  settings[key] = value
  saveSettings(settings)
}

/**
 * Update multiple settings
 * @param {Object} updates - Settings to update
 */
export function updateUISettings(updates) {
  const settings = loadSettings()
  Object.assign(settings, updates)
  saveSettings(settings)
}

/**
 * Subscribe to settings changes
 * @param {Function} callback - Called with new settings
 * @returns {Function} Unsubscribe function
 */
export function subscribeToUISettings(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

/**
 * Reset settings to defaults
 */
export function resetUISettings() {
  saveSettings({ ...DEFAULT_SETTINGS })
}

// React hook for using UI settings
import { useState, useEffect } from 'react'

/**
 * React hook for UI settings
 * @returns {[Object, Function]} [settings, updateSetting]
 */
export function useUISettings() {
  const [settings, setSettings] = useState(loadSettings)

  useEffect(() => {
    const unsubscribe = subscribeToUISettings(newSettings => {
      setSettings({ ...newSettings })
    })
    return unsubscribe
  }, [])

  const updateSetting = (key, value) => {
    setUISetting(key, value)
  }

  return [settings, updateSetting]
}

/**
 * React hook for checking advanced mode
 * @returns {boolean}
 */
export function useAdvancedMode() {
  const [settings] = useUISettings()
  return settings.advancedMode === true
}

/**
 * React hook for checking if dummy data is enabled
 * @returns {boolean}
 */
export function useDummyDataEnabled() {
  const [settings] = useUISettings()
  return settings.dummyDataEnabled === true
}

export default {
  getUISettings,
  getUISetting,
  setUISetting,
  updateUISettings,
  subscribeToUISettings,
  resetUISettings,
  isAdvancedMode,
  useUISettings,
  useAdvancedMode,
  useDummyDataEnabled,
}

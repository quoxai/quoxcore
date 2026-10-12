import { syncPreferenceToServer } from '../services/userPreferences';

/**
 * useSettings - Centralized Settings Hook
 *
 * Provides reactive access to settings stored in localStorage.
 * Settings sync across components and persist between sessions.
 *
 * Usage:
 *   const { settings, updateSetting, getSetting } = useSettings();
 *   const showThinking = getSetting('showThinking');
 *   updateSetting('showThinking', true);
 */

import { useState, useEffect, useCallback, useMemo } from 'react';

// localStorage key for settings
const SETTINGS_KEY = 'quox-settings';

// VOLT-DEFAULT-FIX: single source of truth for the VOLT toggle defaults.
// GeneralPanel.jsx imports this constant so the Settings UI and every
// useSettings()-based consumer (VoltSummaryCard, VoltStatusBadge, the
// legacy SettingsView panel) resolve a never-configured account to the
// SAME value, instead of two hardcoded literals silently drifting apart.
// Previously GeneralPanel.jsx defaulted voltEnabled to `true` while this
// file defaulted it to `false` — when hydrateFromServer() skipped an
// empty/absent server `settings` namespace on login, different readers
// fell back to different defaults, making the toggle appear to "reset".
//
// Decided defaults: voltEnabled defaults ON — VOLT audit trail is Quox's
// core evidence-layer capability. voltContentCapture defaults OFF —
// capturing full prompt/response bodies is opt-in due to storage and
// privacy cost.
export const VOLT_DEFAULTS = {
    voltEnabled: true,
    voltContentCapture: false,
};

// Default settings - single source of truth
const DEFAULT_SETTINGS = {
    theme: 'dark',
    notifications: true,
    sounds: true,
    autoSave: true,
    showThinking: false,
    useStreaming: true,
    jumpHost: {
        enabled: false,
        hostname: 'bastion01',
        ip: '',
        user: 'control'
    },
    monitoring: {
        prometheus: { url: 'http://localhost:9090', enabled: false },
        grafana: { url: 'http://localhost:3000', enabled: false },
        uptimeKuma: { url: 'http://localhost:3001', enabled: false }
    },
    ...VOLT_DEFAULTS
};

// Custom event for cross-component sync
const SETTINGS_CHANGE_EVENT = 'quox-settings-change';

/**
 * Load settings from localStorage with defaults
 */
function loadSettings() {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            // Merge with defaults to ensure new settings are available
            return { ...DEFAULT_SETTINGS, ...parsed };
        }
    } catch (err) {
        console.warn('[useSettings] Failed to load settings:', err);
    }
    return { ...DEFAULT_SETTINGS };
}

/**
 * Save settings to localStorage
 */
function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        // Dispatch custom event for cross-component sync
        window.dispatchEvent(new CustomEvent(SETTINGS_CHANGE_EVENT, { detail: settings }));
        syncPreferenceToServer('settings', settings);
        return true;
    } catch (err) {
        console.error('[useSettings] Failed to save settings:', err);
        return false;
    }
}

/**
 * useSettings hook - reactive settings management
 *
 * @returns {Object} Settings state and methods
 */
export function useSettings() {
    const [settings, setSettings] = useState(loadSettings);

    // Listen for settings changes from other components
    useEffect(() => {
        const handleSettingsChange = (event) => {
            if (event.detail) {
                setSettings(event.detail);
            }
        };

        // Also listen for storage events (cross-tab sync)
        const handleStorageChange = (event) => {
            if (event.key === SETTINGS_KEY && event.newValue) {
                try {
                    const newSettings = JSON.parse(event.newValue);
                    setSettings({ ...DEFAULT_SETTINGS, ...newSettings });
                } catch (err) {
                    console.warn('[useSettings] Failed to parse storage event:', err);
                }
            }
        };

        window.addEventListener(SETTINGS_CHANGE_EVENT, handleSettingsChange);
        window.addEventListener('storage', handleStorageChange);

        return () => {
            window.removeEventListener(SETTINGS_CHANGE_EVENT, handleSettingsChange);
            window.removeEventListener('storage', handleStorageChange);
        };
    }, []);

    /**
     * Update a single setting
     * @param {string} key - Setting key (supports dot notation for nested: 'jumpHost.enabled')
     * @param {any} value - New value
     * @returns {boolean} Success status
     */
    const updateSetting = useCallback((key, value) => {
        setSettings(prev => {
            let newSettings;

            // Handle nested keys (e.g., 'jumpHost.enabled')
            if (key.includes('.')) {
                const parts = key.split('.');
                newSettings = { ...prev };
                let current = newSettings;
                for (let i = 0; i < parts.length - 1; i++) {
                    current[parts[i]] = { ...current[parts[i]] };
                    current = current[parts[i]];
                }
                current[parts[parts.length - 1]] = value;
            } else {
                newSettings = { ...prev, [key]: value };
            }

            saveSettings(newSettings);
            return newSettings;
        });
        return true;
    }, []);

    /**
     * Get a specific setting value
     * @param {string} key - Setting key (supports dot notation)
     * @param {any} defaultValue - Default if not found
     * @returns {any} Setting value
     */
    const getSetting = useCallback((key, defaultValue = undefined) => {
        if (key.includes('.')) {
            const parts = key.split('.');
            let current = settings;
            for (const part of parts) {
                if (current === undefined || current === null) {
                    return defaultValue;
                }
                current = current[part];
            }
            return current !== undefined ? current : defaultValue;
        }
        return settings[key] !== undefined ? settings[key] : defaultValue;
    }, [settings]);

    /**
     * Reset all settings to defaults
     */
    const resetSettings = useCallback(() => {
        setSettings({ ...DEFAULT_SETTINGS });
        saveSettings({ ...DEFAULT_SETTINGS });
    }, []);

    /**
     * Batch update multiple settings
     * @param {Object} updates - Object with key-value pairs to update
     */
    const updateSettings = useCallback((updates) => {
        setSettings(prev => {
            const newSettings = { ...prev, ...updates };
            saveSettings(newSettings);
            return newSettings;
        });
    }, []);

    return useMemo(() => ({
        settings,
        updateSetting,
        updateSettings,
        getSetting,
        resetSettings,
        DEFAULT_SETTINGS
    }), [settings, updateSetting, updateSettings, getSetting, resetSettings]);
}

/**
 * useShowThinking - Convenience hook for the Show Thinking setting
 *
 * @returns {[boolean, Function]} [showThinking, setShowThinking]
 */
export function useShowThinking() {
    const { getSetting, updateSetting } = useSettings();
    const showThinking = getSetting('showThinking', false);

    const setShowThinking = useCallback((value) => {
        updateSetting('showThinking', value);
    }, [updateSetting]);

    return [showThinking, setShowThinking];
}

/**
 * useStreaming - Convenience hook for the Use Streaming setting
 *
 * @returns {[boolean, Function]} [useStreaming, setUseStreaming]
 */
export function useStreaming() {
    const { getSetting, updateSetting } = useSettings();
    const useStreamingSetting = getSetting('useStreaming', true);

    const setUseStreaming = useCallback((value) => {
        updateSetting('useStreaming', value);
    }, [updateSetting]);

    return [useStreamingSetting, setUseStreaming];
}

export default useSettings;

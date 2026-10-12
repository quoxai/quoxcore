/**
 * GeneralPanel — SET-IA parity restoration.
 *
 * V1 had this at /settings#general (lines 851-982 of SettingsView.jsx).
 * Three subsections: Preferences (UI/notification toggles),
 * Advanced Features (advancedMode + VOLT audit trail), Demo Memory
 * Data (sample memory population for testing).
 *
 * The V1 inline implementation pulled `settings` state from
 * SettingsView's local state. Here we read from useUISettings() for
 * the cross-app prefs and from a localStorage-backed `settings` slot
 * for the chat-feature toggles, matching V1's persistence behaviour.
 */

import { useState, useEffect, useRef } from 'react';
import { useUISettings } from '../../../services/uiSettings';
import { forceRepopulateDummyData } from '../../../services/dummyData';
import { syncPreferenceToServer } from '../../../services/userPreferences';
import { VOLT_DEFAULTS } from '../../../hooks/useSettings';
import voltBridge from '../../../lib/volt/volt-bridge';
import Button from '../../../components/ui/Button';
import SettingsSection from '../../../components/settings/SettingsSection';
import SettingsCard, { SettingsGroup } from '../../../components/settings/SettingsCard';
import { SettingItem } from '../../../components/ui/Input';
import SoundProfileSettings from '../../../components/settings/SoundProfileSettings';

// VOLT-FIX A: Write through the same key V1 used (`quox-settings`) and
// that App.jsx + VoltSummaryCard read on boot. Pre-fix this panel wrote
// to its own key (`quox-general-settings`) so the toggle never reached
// the boot reader and VOLT silently stayed off after a hard refresh.
// Merge instead of clobber so other writers' keys (theme, etc.) survive.
const STORAGE_KEY = 'quox-settings';

const PANEL_KEYS = ['notifications', 'sounds', 'showThinking', 'useStreaming', 'voltEnabled', 'voltContentCapture'];

// VOLT-DEFAULT-FIX: voltEnabled/voltContentCapture come from the shared
// VOLT_DEFAULTS constant (src/hooks/useSettings.js) — do NOT hardcode
// these two values here again. A previous drift (this file said `true`,
// useSettings.js said `false`) caused the VOLT toggle to appear reset on
// login whenever hydrateFromServer() skipped an empty/absent server
// value and different readers fell back to different defaults.
export const DEFAULTS = {
    notifications:        true,
    sounds:               true,
    showThinking:         false,
    useStreaming:         true,
    ...VOLT_DEFAULTS,
};

function loadGeneral() {
    if (typeof window === 'undefined') return DEFAULTS;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const stored = raw ? JSON.parse(raw) : {};
        // Pick only this panel's keys so we don't render unrelated state.
        const picked = Object.fromEntries(
            PANEL_KEYS.filter(k => stored[k] !== undefined).map(k => [k, stored[k]])
        );
        return { ...DEFAULTS, ...picked };
    } catch {
        return DEFAULTS;
    }
}

function saveGeneral(next) {
    if (typeof window === 'undefined') return;
    try {
        // Read-modify-write so settings written by other surfaces (theme,
        // legacy V1 SettingsView keys) aren't clobbered when this panel saves.
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const current = raw ? JSON.parse(raw) : {};
        const merged = { ...current, ...next };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        syncPreferenceToServer('settings', merged);
    } catch { /* quota */ }
}

export default function GeneralPanel() {
    const [settings, setSettings] = useState(loadGeneral);
    const [uiSettings, updateUISetting] = useUISettings();
    const [notice, setNotice] = useState(null);
    // SET-IA save-status restoration (fleet #429/#349): V1 SettingsView had a
    // Saving/Saved/Error indicator driven by its own saveStatus state; the
    // V2 GeneralPanel persisted silently with no feedback. Mirrors V1's
    // pattern (see dead SettingsView.jsx updateSetting/saveStatus effect).
    const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'

    // Skip the initial mount write. On a fresh login/reload, logout wiped
    // localStorage and hydrateFromServer may not have populated it yet, so
    // `settings` initialises to DEFAULTS; an unconditional mount write would
    // sync those defaults (showThinking:false, voltContentCapture:false) back
    // to the server — clobbering the user's real saved values ~2s later (the
    // sync debounce), i.e. "settings reset on every login". Only persist
    // user-driven changes; hydration alone is authoritative for load state.
    const skipFirstSave = useRef(true);
    useEffect(() => {
        if (skipFirstSave.current) { skipFirstSave.current = false; return; }
        setSaveStatus('saving');
        try {
            saveGeneral(settings);
            setSaveStatus('saved');
        } catch (err) {
            setSaveStatus('error');
        }
    }, [settings]);

    // Clear the save status after a delay, same 2000ms window as V1.
    useEffect(() => {
        if (saveStatus === 'saved' || saveStatus === 'error') {
            const timer = setTimeout(() => setSaveStatus(null), 2000);
            return () => clearTimeout(timer);
        }
    }, [saveStatus]);

    const update = (key, value) => setSettings(s => ({ ...s, [key]: value }));

    const showNotification = (msg) => {
        setNotice(msg);
        setTimeout(() => setNotice(null), 4000);
    };

    return (
        <div style={{ padding: 24, maxWidth: 980 }}>
            <SettingsSection title="Preferences"
                description="Configure your general application preferences">
                <SettingsCard glass>
                    <SettingsGroup>
                        <SettingItem
                            label="Enable Notifications"
                            description="Receive alerts and updates"
                            checked={settings.notifications}
                            onChange={(e) => update('notifications', e.target.checked)} />
                        <SettingItem
                            label="Show Thinking Process"
                            description="Display AI reasoning steps"
                            checked={settings.showThinking}
                            onChange={(e) => update('showThinking', e.target.checked)} />
                        <SettingItem
                            label="Use Streaming Responses"
                            description="Stream AI responses in real-time"
                            checked={settings.useStreaming}
                            onChange={(e) => update('useStreaming', e.target.checked)} />
                    </SettingsGroup>
                </SettingsCard>
            </SettingsSection>

            {/* QUOXSOUND-P1: replaces the old "Sound Effects" toggle, which was
                stored but read by nothing. */}
            <SoundProfileSettings />

            <SettingsSection title="Advanced Features"
                description="Enable power-user features and technical details">
                <SettingsCard glass>
                    <SettingsGroup>
                        <SettingItem
                            label="Advanced Mode"
                            description="Show layer analytics, processing traces, and technical metrics. Recommended for developers and power users."
                            checked={uiSettings.advancedMode}
                            onChange={(e) => updateUISetting('advancedMode', e.target.checked)} />
                        {uiSettings.advancedMode && (
                            <div className="settings-info-box">
                                <strong>Enabled features</strong>
                                <ul>
                                    <li>Layer Insights tab in Activity view</li>
                                    <li>Processing layer visualization during chat</li>
                                    <li>Detailed timing and performance metrics</li>
                                    <li>AOCL trace export and analysis</li>
                                </ul>
                            </div>
                        )}
                        <SettingItem
                            label="VOLT Audit Trail"
                            description="Record hash-chained audit events for agent actions via the AEE bridge. View traces at /volt. Requires page reload to take effect."
                            checked={settings.voltEnabled}
                            onChange={(e) => update('voltEnabled', e.target.checked)} />
                        {settings.voltEnabled && (
                            <SettingItem
                                label="VOLT Content Capture"
                                description="Record full prompts, responses, and tool I/O alongside VOLT audit events. Increases storage usage. Requires VOLT Audit Trail to be enabled."
                                checked={settings.voltContentCapture}
                                onChange={(e) => {
                                    const enabled = e.target.checked;
                                    // Toggle the bridge first — if it throws,
                                    // surface the error and keep the UI in
                                    // sync with the (failed) underlying state.
                                    try {
                                        if (enabled) voltBridge.enableContentCapture();
                                        else voltBridge.disableContentCapture();
                                        update('voltContentCapture', enabled);
                                    } catch (err) {
                                        showNotification(`VOLT capture toggle failed: ${err.message || err}`);
                                    }
                                }} />
                        )}
                    </SettingsGroup>
                </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Demo Memory Data"
                description="Populate memory system with sample data for testing and demos">
                <SettingsCard glass>
                    <SettingsGroup>
                        <SettingItem
                            label="Enable Demo Data"
                            description="Add sample memories (preferences, facts, decisions, constraints, errors, reflections) for testing. All demo items are clearly marked and will be removed when disabled."
                            checked={uiSettings.dummyDataEnabled}
                            onChange={(e) => {
                                updateUISetting('dummyDataEnabled', e.target.checked);
                                showNotification(e.target.checked
                                    ? 'Demo data added to memory system'
                                    : 'Demo data removed from memory system');
                            }} />
                        {uiSettings.dummyDataEnabled ? (
                            <div className="settings-info-box settings-info-box--green">
                                <strong>Demo data active</strong>
                                <p>Sample memories are loaded into the system. These are marked and will be automatically removed when you disable this setting.</p>
                                <Button variant="secondary" style={{ marginTop: 12 }}
                                    onClick={() => {
                                        forceRepopulateDummyData();
                                        showNotification('Demo data repopulated');
                                    }}>
                                    Repopulate Demo Data
                                </Button>
                            </div>
                        ) : (
                            <div className="settings-info-box settings-info-box--neutral">
                                <strong>Demo data disabled</strong>
                                <p>Enable to populate the memory system with useful sample data. Great for testing, demos, or exploring memory features.</p>
                            </div>
                        )}
                    </SettingsGroup>
                </SettingsCard>
            </SettingsSection>

            {notice && (
                <div role="status" aria-live="polite"
                    style={{
                        marginTop: 16, padding: 12, borderRadius: 6, fontSize: 13,
                        background: 'rgba(52, 211, 153, 0.12)', color: '#34d399',
                    }}>{notice}</div>
            )}

            {saveStatus && (
                <div
                    className={`settings-save-status settings-save-status--${saveStatus}`}
                    role="status"
                    aria-live="polite"
                    style={{ position: 'fixed', top: '80px', right: '24px', zIndex: 1000 }}
                >
                    {saveStatus === 'saving' && (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                                <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
                            </svg>
                            Saving...
                        </>
                    )}
                    {saveStatus === 'saved' && (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Settings saved
                        </>
                    )}
                    {saveStatus === 'error' && (
                        <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                            Failed to save settings
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * SoundProfileSettings (QUOXSOUND-P1): the per-user Sound Profile.
 *
 * Profile (Silent | Minimal | Operational | Full), master volume, per-layer
 * toggles, and a "Play test" button per earcon. Persists server-side through
 * the `soundProfile` preferences namespace (quoxSound.saveSoundSettings);
 * localStorage is only the hydrated cache.
 */

import { useState, useEffect, useCallback } from 'react';
import SettingsSection from './SettingsSection';
import SettingsCard, { SettingsGroup } from './SettingsCard';
import { SettingItem } from '../ui/Input';
import {
    getSoundSettings,
    saveSoundSettings,
    playSound,
    initQuoxSound,
    PROFILES,
    PROFILE_IDS,
    SOUND_IDS,
    SOUND_LABELS,
    SOUND_LAYERS,
} from '../../services/quoxSound';
import {
    getDesktopNotifySettings,
    saveDesktopNotifySettings,
    getDesktopPermission,
    requestDesktopPermission,
    sendTestDesktopNotification,
    describeDesktopTestResult,
    isSecureContextNow,
    INSECURE_CONTEXT_MESSAGE,
} from '../../services/desktopNotify';

const PROFILE_COPY = {
    silent: { label: 'Silent', hint: 'No sounds at all.' },
    minimal: { label: 'Minimal', hint: 'Only approvals that need you, and critical alerts.' },
    operational: { label: 'Operational', hint: 'Adds notifications, success and blocked/denied cues.' },
    full: { label: 'Full', hint: 'Same as Operational for now. Ambient interface cues arrive later.' },
};

const SOUND_COPY = {
    hitl: 'Calm three-note chime. Only when a human action is required.',
    notify: 'Soft two-tone for a new inbox notification.',
    success: 'Tiny resolving click when something completes.',
    denied: 'Muted low thunk when an action is blocked by policy.',
    critical: 'Dry triplet, reserved for critical events.',
};

const LAYER_COPY = [
    { id: 'notifications', label: 'Notifications', description: 'Approvals and inbox notifications.' },
    { id: 'agents', label: 'Agents', description: 'Agent outcomes such as success.' },
    { id: 'security', label: 'Security', description: 'Blocked/denied and critical alerts.' },
    { id: 'ui', label: 'Interface', description: 'Reserved for ambient interface cues (not used yet).' },
];

function SpeakerIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 5 6 9H2v6h4l5 4V5z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M19 5a10 10 0 0 1 0 14" />
        </svg>
    );
}

export default function SoundProfileSettings() {
    const [settings, setSettings] = useState(getSoundSettings);
    const [desktop, setDesktop] = useState(getDesktopNotifySettings);
    const [permission, setPermission] = useState(getDesktopPermission);
    const [testResult, setTestResult] = useState(null);
    const [testing, setTesting] = useState(false);
    const insecure = !isSecureContextNow();
    const runTest = useCallback(async () => {
        setTesting(true);
        setTestResult(null);
        try { setTestResult(await sendTestDesktopNotification()); }
        catch (e) { setTestResult({ ok: false, reason: 'error', error: e?.message || String(e) }); }
        finally { setTesting(false); }
    }, []);

    // Pick up server hydration that lands after mount.
    useEffect(() => {
        initQuoxSound();
        const refresh = () => { setSettings(getSoundSettings()); setDesktop(getDesktopNotifySettings()); };
        window.addEventListener('quox-settings-change', refresh);
        return () => window.removeEventListener('quox-settings-change', refresh);
    }, []);

    // Only user-driven changes persist (never a mount write that could
    // clobber the server value before hydration).
    const update = useCallback((patch) => {
        setSettings(prev => saveSoundSettings({ ...prev, ...patch }));
    }, []);

    const updateDesktop = useCallback((patch) => {
        setDesktop(prev => saveDesktopNotifySettings({ ...prev, ...patch }));
    }, []);
    const enableDesktop = useCallback(async () => {
        const result = await requestDesktopPermission();
        setPermission(result);
        if (result === 'granted') updateDesktop({ enabled: true });
    }, [updateDesktop]);

    const active = PROFILES[settings.profile];
    const volumePct = Math.round(settings.volume * 100);

    return (
        <SettingsSection title="Sound"
            description="Sound communicates state. The more common the event, the quieter the cue.">
            <SettingsCard glass>
                <SettingsGroup>
                    <div className="ui-setting-item">
                        <div className="ui-setting-info">
                            <span className="ui-setting-label">Sound profile</span>
                            <p className="ui-setting-description">{PROFILE_COPY[settings.profile].hint}</p>
                        </div>
                        <div className="qx-seg" role="radiogroup" aria-label="Sound profile">
                            {PROFILE_IDS.map(id => (
                                <button key={id} type="button" role="radio"
                                    aria-checked={settings.profile === id}
                                    className={`qx-seg__btn${settings.profile === id ? ' qx-seg__btn--active' : ''}`}
                                    onClick={() => update({ profile: id })}>
                                    {PROFILE_COPY[id].label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="ui-setting-item">
                        <div className="ui-setting-info">
                            <label htmlFor="quox-sound-volume" className="ui-setting-label">Volume</label>
                            <p className="ui-setting-description">{volumePct}%</p>
                        </div>
                        <input id="quox-sound-volume" type="range" className="qx-range"
                            min="0" max="100" step="5" value={volumePct}
                            style={{ '--qx-range-fill': `${volumePct}%` }}
                            onChange={(e) => update({ volume: Number(e.target.value) / 100 })} />
                    </div>

                    {LAYER_COPY.map(layer => (
                        <SettingItem key={layer.id}
                            label={layer.label}
                            description={layer.description}
                            checked={settings.layers[layer.id]}
                            onChange={(e) => update({ layers: { ...settings.layers, [layer.id]: e.target.checked } })} />
                    ))}

                    {SOUND_IDS.map(id => {
                        const on = active.includes(id) && settings.layers[SOUND_LAYERS[id]] !== false;
                        return (
                            <div key={id} className="ui-setting-item">
                                <div className="ui-setting-info">
                                    <span className="ui-setting-label">
                                        {SOUND_LABELS[id]}{' '}
                                        <span className={`qx-pill qx-pill--sm ${on ? 'qx-pill--online' : 'qx-pill--ghost'}`}>{on ? 'On' : 'Off'}</span>
                                    </span>
                                    <p className="ui-setting-description">{SOUND_COPY[id]}</p>
                                </div>
                                <button type="button" className="glass-btn"
                                    aria-label={`Play test: ${SOUND_LABELS[id]}`}
                                    onClick={() => playSound(id, { force: true, settings })}>
                                    <SpeakerIcon /> Play test
                                </button>
                            </div>
                        );
                    })}
                </SettingsGroup>
            </SettingsCard>
            <SettingsCard glass>
                <SettingsGroup>
                    <SettingItem label="Desktop notifications"
                        description="Show a system notification for new approvals when this tab is in the background. Independent of the Sound Profile."
                        checked={desktop.enabled}
                        onChange={(e) => updateDesktop({ enabled: e.target.checked })} />
                    <SettingItem label="Also notify for other items"
                        description="Include ordinary inbox notifications, not just approvals."
                        checked={desktop.other}
                        onChange={(e) => updateDesktop({ other: e.target.checked })} />
                    <div className="ui-setting-item" data-testid="desktop-notify-permission">
                        <div className="ui-setting-info">
                            <span className="ui-setting-label">
                                Browser permission{' '}
                                <span className={`qx-pill qx-pill--sm ${permission === 'granted' ? 'qx-pill--online' : 'qx-pill--ghost'}`}>{permission}</span>
                            </span>
                            <p className="ui-setting-description">
                                {permission === 'denied'
                                    ? 'Allow notifications for this site in your browser, and on macOS: System Settings > Notifications > <browser>.'
                                    : permission === 'unsupported'
                                        ? 'This browser does not support desktop notifications.'
                                        : 'Your browser asks once, when you click Enable.'}
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            {permission !== 'granted' && permission !== 'unsupported' && (
                                <button type="button" className="glass-btn" onClick={enableDesktop}>Enable</button>
                            )}
                            <button type="button" className="glass-btn"
                                disabled={permission !== 'granted'}
                                onClick={runTest}>{testing ? 'Testing...' : 'Send test'}</button>
                        </div>
                    </div>
                    {insecure && (
                        <p className="ui-setting-description" role="alert" data-testid="desktop-notify-insecure">
                            {INSECURE_CONTEXT_MESSAGE} Real approval notifications will not appear on this page.
                        </p>
                    )}
                    {testResult && (
                        <p className="ui-setting-description" role="status" data-testid="desktop-notify-test-result">
                            <span className={`qx-pill qx-pill--sm ${testResult.ok ? 'qx-pill--online' : 'qx-pill--ghost'}`}>{testResult.ok ? 'ok' : 'failed'}</span>{' '}
                            {describeDesktopTestResult(testResult)}
                        </p>
                    )}
                </SettingsGroup>
            </SettingsCard>
        </SettingsSection>
    );
}

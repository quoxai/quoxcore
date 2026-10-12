/**
 * TelemetryPanel — SET-IA parity restoration.
 *
 * V1 had this at /settings#telemetry: opt-in toggle, what-we-send /
 * what-we-never-send policy lists, and the TelemetryPayloadViewer.
 * Extracted from src/pages/views/SettingsView.jsx (lines 79-130 +
 * 1626-1711) as a self-contained panel.
 */

import { useState } from 'react';
import Button from '../../../components/ui/Button';
import SettingsSection from '../../../components/settings/SettingsSection';
import SettingsCard from '../../../components/settings/SettingsCard';
import { isTelemetryEnabled, setTelemetryEnabled, buildPayload } from '../../../services/heartbeatService';

function TelemetryPayloadViewer() {
    const [expanded, setExpanded] = useState(false);
    const [payload, setPayload] = useState(null);

    const handleToggle = () => {
        if (!expanded) {
            try { setPayload(buildPayload()); }
            catch { setPayload({ error: 'Could not build payload' }); }
        }
        setExpanded(!expanded);
    };

    return (
        <div>
            <Button variant="outline" onClick={handleToggle}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                </svg>
                {expanded ? 'Hide payload' : 'View exact payload'}
            </Button>
            {expanded && payload && (
                <pre style={{
                    marginTop: 12, padding: 14, borderRadius: 8,
                    background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
                    fontSize: 12, color: 'var(--ui-text-secondary)', overflow: 'auto',
                    maxHeight: 300, lineHeight: 1.5,
                }}>{JSON.stringify(payload, null, 2)}</pre>
            )}
        </div>
    );
}

export default function TelemetryPanel() {
    const [enabled, setEnabledState] = useState(() => isTelemetryEnabled());

    const handleChange = (e) => {
        setTelemetryEnabled(e.target.checked);
        setEnabledState(e.target.checked);
    };

    return (
        <div className="telemetry-section" style={{ padding: 24, maxWidth: 980 }}>
            <SettingsSection title="QuoxCores Online"
                description="Help improve QuoxCORE by sharing anonymous usage data">
                <SettingsCard glass>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ fontWeight: 600, color: 'var(--ui-text-primary)', marginBottom: 4 }}>
                                    Send anonymous heartbeat
                                </div>
                                <div style={{ fontSize: 13, color: 'var(--ui-text-secondary)' }}>
                                    A small ping every 5 minutes lets us know your instance is running
                                </div>
                            </div>
                            <label style={{ position: 'relative', display: 'inline-block', width: 48, height: 26, cursor: 'pointer' }}>
                                <input type="checkbox" checked={enabled} onChange={handleChange}
                                    style={{ opacity: 0, width: 0, height: 0 }} />
                                <span style={{
                                    position: 'absolute', inset: 0, borderRadius: 13, transition: 'background 0.2s',
                                    background: enabled ? 'var(--hal-green, #22c55e)' : 'rgba(255,255,255,0.15)',
                                }}>
                                    <span style={{
                                        position: 'absolute', top: 3, left: enabled ? 25 : 3,
                                        width: 20, height: 20, borderRadius: '50%', background: '#fff',
                                        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                                    }} />
                                </span>
                            </label>
                        </div>

                        <div style={{
                            padding: 16, borderRadius: 8,
                            background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.15)',
                        }}>
                            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--ui-text-primary)', fontSize: 14 }}>
                                What we send
                            </div>
                            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--ui-text-secondary)', lineHeight: 1.8 }}>
                                <li>A random instance ID (tied to your license for auth, not shared publicly)</li>
                                <li>QuoxCORE version number</li>
                                <li>Uptime and session duration</li>
                                <li>OS platform and browser type</li>
                                <li>Aggregate counts: enabled plugins, memory entries</li>
                            </ul>
                        </div>

                        <div style={{
                            padding: 16, borderRadius: 8,
                            background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.15)',
                        }}>
                            <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--ui-text-primary)', fontSize: 14 }}>
                                What we NEVER send
                            </div>
                            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--ui-text-secondary)', lineHeight: 1.8 }}>
                                <li>Conversation content or chat history</li>
                                <li>Hostnames, IP addresses, or network details</li>
                                <li>API keys, passwords, or credentials</li>
                                <li>File contents or personal data</li>
                            </ul>
                        </div>

                        <p style={{ fontSize: 13, color: 'var(--ui-text-muted)', margin: 0, lineHeight: 1.6 }}>
                            This data helps us understand how QuoxCORE is used, improve reliability,
                            and prioritize features. You can turn this off at any time — no questions asked.
                        </p>

                        <TelemetryPayloadViewer />
                    </div>
                </SettingsCard>
            </SettingsSection>
        </div>
    );
}

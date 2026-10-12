/**
 * Telemetry Step - QuoxCores Online opt-in during setup
 *
 * Explains what telemetry collects, what it doesn't, and lets the user
 * opt in before completing setup. Default is OFF (TRUST-PROOF audit
 * cycle 1): sending anything off-box requires an explicit yes.
 */

import { useState } from 'react'
import { setTelemetryEnabled } from '../../../services/heartbeatService'

export default function Telemetry({ data, onNext, onBack }) {
    // TRUST-PROOF audit cycle 1: starts UNCHECKED — enabling telemetry is an
    // explicit choice, not a pre-ticked default the user has to notice.
    const [enabled, setEnabled] = useState(false)

    const handleSubmit = (e) => {
        e.preventDefault()
        setTelemetryEnabled(enabled)
        onNext({ telemetry: { enabled } })
    }

    return (
        <div className="setup-step">
            <h2>QuoxCores Online</h2>
            <p>
                Help us make QuoxCORE better! When enabled, your instance sends a small
                heartbeat ping every 5 minutes so we know it's running healthy.
            </p>

            <form className="setup-form" onSubmit={handleSubmit}>
                {/* Toggle */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '1rem', background: 'rgba(255,255,255,0.05)',
                    borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)',
                    marginBottom: '1.5rem'
                }}>
                    <div>
                        <div style={{ fontWeight: 600, marginBottom: '4px' }}>Send anonymous heartbeat</div>
                        <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>
                            {enabled ? 'Your instance will appear on QuoxCores Online' : 'Telemetry is disabled — your instance stays private'}
                        </div>
                    </div>
                    <label style={{ position: 'relative', display: 'inline-block', width: '48px', height: '26px', cursor: 'pointer', flexShrink: 0 }}>
                        <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => setEnabled(e.target.checked)}
                            style={{ opacity: 0, width: 0, height: 0 }}
                        />
                        <span style={{
                            position: 'absolute', inset: 0, borderRadius: '13px', transition: 'background 0.2s',
                            background: enabled ? '#22c55e' : 'rgba(255,255,255,0.15)',
                        }}>
                            <span style={{
                                position: 'absolute', top: '3px', left: enabled ? '25px' : '3px',
                                width: '20px', height: '20px', borderRadius: '50%', background: '#fff',
                                transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                            }} />
                        </span>
                    </label>
                </div>

                {/* What we send */}
                <div style={{
                    padding: '1rem', borderRadius: '8px', marginBottom: '1rem',
                    background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.15)'
                }}>
                    <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '0.9rem' }}>
                        What we send
                    </div>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.85rem', opacity: 0.8, lineHeight: '1.8' }}>
                        <li>A random instance ID (tied to your license for auth, not shared publicly)</li>
                        <li>QuoxCORE version and uptime</li>
                        <li>OS platform and browser type</li>
                        <li>Aggregate counts: enabled plugins, memory entries</li>
                    </ul>
                </div>

                {/* What we never send */}
                <div style={{
                    padding: '1rem', borderRadius: '8px', marginBottom: '1rem',
                    background: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.15)'
                }}>
                    <div style={{ fontWeight: 600, marginBottom: '8px', fontSize: '0.9rem' }}>
                        What we NEVER send
                    </div>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.85rem', opacity: 0.8, lineHeight: '1.8' }}>
                        <li>Conversation content or chat history</li>
                        <li>Hostnames, IP addresses, or network details</li>
                        <li>API keys, passwords, or credentials</li>
                        <li>File contents or personal data</li>
                    </ul>
                </div>

                <div className="info-box" style={{ marginBottom: '1rem' }}>
                    You can change this at any time in Settings &gt; Telemetry — no questions asked.
                    Your instance will simply go quiet on our end.
                </div>

                <div className="setup-actions">
                    <button type="button" className="btn btn-secondary" onClick={onBack}>
                        &larr; Back
                    </button>
                    <button type="submit" className="btn btn-primary">
                        Continue &rarr;
                    </button>
                </div>
            </form>
        </div>
    )
}

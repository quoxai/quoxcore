/**
 * ThirdPartyPluginInstaller — Multi-step install flow for .quoxplugin files.
 *
 * Steps:
 *   1. Upload (drag-drop or file picker)
 *   2. Verification (signature, compatibility, manifest validation)
 *   3. Permissions (plain-English permission display, user approval)
 *   4. License (if not free — license key input)
 *   5. Done (success confirmation)
 *
 * GATE-INSTALL-UI: this modal has no admin check of its own — it assumes the
 * caller (PluginSettings.jsx) only mounts it for an org admin/owner. That is
 * a UX guard, not the enforcement boundary: if it were ever opened for a
 * non-admin (stale session, role change mid-session), the server's admin-only
 * install/activate/backend-start routes are what actually refuse the request
 * (installThirdPartyPlugin/activateThirdPartyPlugin surface that refusal as
 * `error` state above). Do not treat gating this component's mount as a
 * substitute for the backend check.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { installThirdPartyPlugin, activateThirdPartyPlugin } from '../../services/thirdPartyPluginHost';
import { validatePluginLicense, activatePluginLicense } from '../../services/licenseValidator';
import {
    COMMUNITY_PLUGIN_TRUST_DETAIL,
    COMMUNITY_PLUGIN_TRUST_NOTICE,
    TRUSTED_ADMIN_ONLY_LABEL,
} from '../../services/pluginTrustModel';

const STEPS = ['upload', 'verify', 'permissions', 'license', 'done'];

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const PERMISSION_LABELS = {
    sidebar: 'Add an item to your sidebar',
    storage: 'Store configuration data',
    network: 'Make API requests through its backend',
    memory: 'Read and write to memory',
    notifications: 'Show notifications',
    aee: 'Emit AEE events',
    tools: 'Register agent tools',
};

export default function ThirdPartyPluginInstaller({ onClose, onInstalled }) {
    const [step, setStep] = useState('upload');
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [manifest, setManifest] = useState(null);
    const [signatureStatus, setSignatureStatus] = useState(null);
    const [licenseKey, setLicenseKey] = useState('');
    const [licenseError, setLicenseError] = useState(null);
    const fileInputRef = useRef(null);
    const [dragOver, setDragOver] = useState(false);

    // Close on Escape key
    useEffect(() => {
        const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose]);

    // ── Step 1: Upload ──

    const handleFile = useCallback(async (file) => {
        setError(null);

        if (!file.name.endsWith('.quoxplugin') && !file.name.endsWith('.zip')) {
            setError('Please upload a .quoxplugin file');
            return;
        }

        if (file.size > MAX_FILE_SIZE) {
            setError(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`);
            return;
        }

        setLoading(true);
        try {
            const result = await installThirdPartyPlugin(file);
            if (!result.success) {
                setError(result.error);
                setLoading(false);
                return;
            }

            setManifest(result.manifest);
            setSignatureStatus(result.signatureStatus);
            setStep('verify');
        } catch (err) {
            setError(err.message);
        }
        setLoading(false);
    }, []);

    const handleDrop = useCallback((e) => {
        e.preventDefault();
        setDragOver(false);
        const files = e.dataTransfer?.files;
        if (files?.[0]) handleFile(files[0]);
    }, [handleFile]);

    const handleFileInput = useCallback((e) => {
        const files = e.target?.files;
        if (files?.[0]) handleFile(files[0]);
    }, [handleFile]);

    // ── Step 2: Verify → auto-advance ──

    const handleVerifyNext = () => {
        if (signatureStatus === 'invalid') {
            setError('Plugin has an invalid signature and cannot be installed.');
            return;
        }
        setStep('permissions');
    };

    // ── Step 3: Permissions → approve ──

    const handleApprove = () => {
        const isFree = manifest?.license === 'free' || !manifest?.license;
        if (isFree) {
            // Skip license step, activate directly
            handleActivate();
        } else {
            setStep('license');
        }
    };

    // ── Step 4: License ──

    const handleLicenseSubmit = async () => {
        setLicenseError(null);
        if (!licenseKey.trim()) {
            // Skip for now
            handleActivate();
            return;
        }

        setLoading(true);
        const result = await activatePluginLicense(manifest.id, licenseKey);
        setLoading(false);

        if (!result.success) {
            setLicenseError(result.error);
            return;
        }

        handleActivate();
    };

    // ── Activate & finish ──

    const handleActivate = async () => {
        setLoading(true);
        const result = await activateThirdPartyPlugin(manifest.id);
        setLoading(false);

        if (!result.success) {
            setError(`Activation failed: ${result.error}`);
            return;
        }

        setStep('done');
        if (onInstalled) onInstalled(manifest);
    };

    // ── Render ──

    const permissions = manifest?.permissions || [];

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        }} onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
            <div style={{
                background: 'linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)), rgba(255,255,255,0.10)',
                backdropFilter: 'var(--qx-blur)',
                WebkitBackdropFilter: 'var(--qx-blur)',
                border: '1px solid var(--m-border-default)',
                borderRadius: '20px',
                padding: '2rem',
                width: '480px',
                maxHeight: '80vh',
                overflow: 'auto',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.45), 0 20px 60px rgba(0,0,0,0.5)',
            }}>
                {/* Header */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <h3 style={{ color: 'rgba(255,255,255,0.9)', margin: 0, fontSize: '1.1rem' }}>
                        Install Plugin
                    </h3>
                    <button onClick={onClose} aria-label="Close" style={{
                        background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)',
                        cursor: 'pointer', padding: '4px', display: 'flex',
                    }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>

                {/* Step indicator */}
                <div style={{ display: 'flex', gap: '4px', marginBottom: '1.5rem' }}>
                    {STEPS.map((s, i) => (
                        <div key={s} style={{
                            flex: 1, height: '3px', borderRadius: '2px',
                            background: STEPS.indexOf(step) >= i ? '#14b8a6' : 'rgba(255,255,255,0.1)',
                            transition: 'background 0.3s',
                        }} />
                    ))}
                </div>

                {/* Error display */}
                {error && (
                    <div style={{
                        padding: '10px 14px', marginBottom: '1rem',
                        background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                        borderRadius: '8px', color: 'rgba(255,255,255,0.8)', fontSize: '0.85rem',
                    }}>
                        {error}
                    </div>
                )}

                <div style={{
                    padding: '10px 14px', marginBottom: '1rem',
                    background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.22)',
                    borderRadius: '8px', color: 'rgba(255,255,255,0.78)', fontSize: '0.82rem', lineHeight: 1.45,
                }}>
                    <strong style={{ color: '#f5c451' }}>{TRUSTED_ADMIN_ONLY_LABEL}.</strong> {COMMUNITY_PLUGIN_TRUST_NOTICE}
                    <div style={{ marginTop: '4px', color: 'rgba(255,255,255,0.62)' }}>
                        {COMMUNITY_PLUGIN_TRUST_DETAIL}
                    </div>
                </div>

                {/* ── Step: Upload ── */}
                {step === 'upload' && (
                    <div>
                        <div
                            onDrop={handleDrop}
                            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                            onDragLeave={() => setDragOver(false)}
                            onClick={() => fileInputRef.current?.click()}
                            style={{
                                border: `2px dashed ${dragOver ? '#14b8a6' : 'rgba(255,255,255,0.15)'}`,
                                borderRadius: '10px',
                                padding: '3rem 2rem',
                                textAlign: 'center',
                                cursor: 'pointer',
                                background: dragOver ? 'rgba(20,184,166,0.05)' : 'transparent',
                                transition: 'all 0.2s',
                            }}
                        >
                            <div style={{ marginBottom: '0.75rem', display: 'flex', justifyContent: 'center' }}>
                                {loading ? (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5"><circle cx="12" cy="12" r="10" strokeDasharray="50" strokeDashoffset="10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>
                                ) : (
                                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                )}
                            </div>
                            <p style={{ color: 'rgba(255,255,255,0.7)', margin: 0, fontSize: '0.9rem' }}>
                                {loading ? 'Processing...' : 'Drop .quoxplugin file here or click to browse'}
                            </p>
                            <p style={{ color: 'rgba(255,255,255,0.4)', margin: '0.5rem 0 0', fontSize: '0.75rem' }}>
                                Maximum file size: 5MB
                            </p>
                        </div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".quoxplugin,.zip"
                            style={{ display: 'none' }}
                            onChange={handleFileInput}
                        />
                    </div>
                )}

                {/* ── Step: Verify ── */}
                {step === 'verify' && manifest && (
                    <div>
                        <div style={{
                            background: 'rgba(255,255,255,0.06)', borderRadius: '8px',
                            padding: '1rem', marginBottom: '1rem',
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                <strong style={{ color: 'rgba(255,255,255,0.9)' }}>{manifest.name}</strong>
                                <span style={{
                                    padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem',
                                    background: signatureStatus === 'signed' ? 'rgba(34,197,94,0.2)' : 'rgba(234,179,8,0.2)',
                                    color: signatureStatus === 'signed' ? '#22c55e' : '#eab308',
                                }}>
                                    {signatureStatus === 'signed' ? 'Signed' : 'Unsigned'}
                                </span>
                            </div>
                            <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem' }}>
                                <p style={{ margin: '4px 0' }}>Version: {manifest.version}</p>
                                <p style={{ margin: '4px 0' }}>Author: {manifest.author || 'Unknown'}</p>
                                <p style={{ margin: '4px 0' }}>ID: {manifest.id}</p>
                                {manifest.description && (
                                    <p style={{ margin: '8px 0 0', color: 'rgba(255,255,255,0.5)' }}>{manifest.description}</p>
                                )}
                            </div>
                        </div>

                        {signatureStatus === 'unsigned' && (
                            <div style={{
                                padding: '10px 14px', marginBottom: '1rem',
                                background: 'rgba(234,179,8,0.1)', border: '1px solid rgba(234,179,8,0.2)',
                                borderRadius: '8px', color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem',
                            }}>
                                This plugin is not cryptographically signed. Only install if you trust the source.
                            </div>
                        )}

                        <button onClick={handleVerifyNext} style={{
                            width: '100%', padding: '10px',
                            background: 'rgba(20,184,166,0.2)', border: '1px solid rgba(20,184,166,0.4)',
                            borderRadius: '8px', color: 'rgba(255,255,255,0.9)',
                            cursor: 'pointer', fontSize: '0.9rem', transition: 'background 0.15s',
                        }}
                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,184,166,0.3)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'rgba(20,184,166,0.2)'}
                        >
                            Continue
                        </button>
                    </div>
                )}

                {/* ── Step: Permissions ── */}
                {step === 'permissions' && manifest && (
                    <div>
                        <p style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '1rem', fontSize: '0.9rem' }}>
                            <strong style={{ color: 'rgba(255,255,255,0.9)' }}>{manifest.name}</strong> requests the following permissions:
                        </p>
                        <div style={{ marginBottom: '1.5rem' }}>
                            {permissions.length > 0 ? permissions.map(perm => (
                                <div key={perm} style={{
                                    display: 'flex', alignItems: 'center', gap: '10px',
                                    padding: '8px 12px', marginBottom: '4px',
                                    background: 'rgba(255,255,255,0.06)', borderRadius: '6px',
                                }}>
                                    <span style={{ color: '#14b8a6' }}>&#x2713;</span>
                                    <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85rem' }}>
                                        {PERMISSION_LABELS[perm] || perm}
                                    </span>
                                </div>
                            )) : (
                                <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem' }}>
                                    No special permissions required.
                                </p>
                            )}
                        </div>
                        <button onClick={handleApprove} disabled={loading} style={{
                            width: '100%', padding: '10px',
                            background: 'rgba(20,184,166,0.2)', border: '1px solid rgba(20,184,166,0.4)',
                            borderRadius: '8px', color: 'rgba(255,255,255,0.9)',
                            cursor: loading ? 'wait' : 'pointer', fontSize: '0.9rem', transition: 'background 0.15s',
                        }}
                            onMouseEnter={e => { if (!loading) e.currentTarget.style.background = 'rgba(20,184,166,0.3)'; }}
                            onMouseLeave={e => e.currentTarget.style.background = 'rgba(20,184,166,0.2)'}
                        >
                            {loading ? 'Activating...' : 'Approve & Install'}
                        </button>
                    </div>
                )}

                {/* ── Step: License ── */}
                {step === 'license' && (
                    <div>
                        <p style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '1rem', fontSize: '0.9rem' }}>
                            This plugin requires a license key.
                        </p>
                        <textarea
                            value={licenseKey}
                            onChange={e => { setLicenseKey(e.target.value); setLicenseError(null); }}
                            placeholder="Paste your license key (JSON)..."
                            rows={5}
                            style={{
                                width: '100%', padding: '10px', boxSizing: 'border-box',
                                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)',
                                borderRadius: '8px', color: 'rgba(255,255,255,0.9)',
                                fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical',
                                marginBottom: '0.5rem',
                            }}
                        />
                        {licenseError && (
                            <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: '0 0 0.5rem' }}>{licenseError}</p>
                        )}
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button onClick={handleLicenseSubmit} disabled={loading} style={{
                                flex: 1, padding: '10px',
                                background: 'rgba(20,184,166,0.2)', border: '1px solid rgba(20,184,166,0.4)',
                                borderRadius: '8px', color: 'rgba(255,255,255,0.9)',
                                cursor: loading ? 'wait' : 'pointer', fontSize: '0.9rem',
                            }}>
                                {loading ? 'Validating...' : 'Activate'}
                            </button>
                            <button onClick={() => handleActivate()} disabled={loading} style={{
                                padding: '10px 16px',
                                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)',
                                borderRadius: '8px', color: 'rgba(255,255,255,0.6)',
                                cursor: 'pointer', fontSize: '0.85rem',
                            }}>
                                Skip for now
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step: Done ── */}
                {step === 'done' && manifest && (
                    <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
                            <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(20,184,166,0.15)', border: '1px solid rgba(20,184,166,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#14b8a6" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                            </div>
                        </div>
                        <h4 style={{ color: 'rgba(255,255,255,0.9)', marginBottom: '0.5rem' }}>
                            {manifest.name} installed
                        </h4>
                        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', marginBottom: '1.5rem' }}>
                            The plugin is now active and available in your sidebar.
                        </p>
                        <button onClick={onClose} style={{
                            padding: '10px 24px',
                            background: 'rgba(20,184,166,0.2)', border: '1px solid rgba(20,184,166,0.4)',
                            borderRadius: '8px', color: 'rgba(255,255,255,0.9)',
                            cursor: 'pointer', fontSize: '0.9rem', transition: 'background 0.15s',
                        }}
                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(20,184,166,0.3)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'rgba(20,184,166,0.2)'}
                        >
                            Done
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

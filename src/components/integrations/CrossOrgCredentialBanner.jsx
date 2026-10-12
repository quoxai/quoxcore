/**
 * CrossOrgCredentialBanner — TAILMESH-FIX
 *
 * When a connector reports "no credentials in this org", check whether
 * the user has the same kind of credential in any other org they belong
 * to. If so, render a small inline banner offering two actions:
 *
 *   - Switch to that org (single-click; uses WorkspaceContext.selectOrg)
 *   - Copy the credential here (re-encrypts into the active org)
 *
 * This makes org-context drift visible at the moment of failure instead
 * of looking like data loss. Reusable across TailscaleView, LinkedInView,
 * YouTubeView, etc — any onboarding screen that resolves a vault credential.
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { listCrossOrgCredentials, copyIntegrationFromOrg } from '../../services/integrationsClient';

export default function CrossOrgCredentialBanner({
    integrationType,
    /** Optional friendly label for the integration type, e.g. 'TailMesh' */
    integrationLabel,
    /** Called after a successful copy (so the parent can re-fetch) */
    onCopySuccess,
}) {
    const { currentOrg, selectOrg } = useWorkspace();
    const navigate = useNavigate();

    const [available, setAvailable] = useState([]);
    const [loading, setLoading] = useState(true);
    const [copying, setCopying] = useState(null); // credential_id being copied
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        async function run() {
            try {
                setLoading(true);
                setError(null);
                const { available_in } = await listCrossOrgCredentials(integrationType);
                if (cancelled) return;
                setAvailable(available_in.filter(c => c.org_id !== currentOrg?.id));
            } catch (err) {
                if (!cancelled) setError(err.message || 'Lookup failed');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        if (integrationType) run();
        return () => { cancelled = true; };
    }, [integrationType, currentOrg?.id, copied]);

    const handleSwitch = useCallback(async (org) => {
        try {
            await selectOrg({ id: org.org_id, name: org.org_name });
        } catch (err) {
            setError(err.message || 'Switch failed');
        }
    }, [selectOrg]);

    const handleCopy = useCallback(async (cred) => {
        if (!currentOrg?.id) return;
        try {
            setCopying(cred.credential_id);
            setError(null);
            await copyIntegrationFromOrg(currentOrg.id, cred.credential_id);
            setCopied(true);
            onCopySuccess?.();
        } catch (err) {
            setError(err.message || 'Copy failed');
        } finally {
            setCopying(null);
        }
    }, [currentOrg?.id, onCopySuccess]);

    if (loading || error || available.length === 0) return null;

    const label = integrationLabel || integrationType;

    return (
        <div
            role="status"
            style={{
                marginBottom: 16,
                padding: 14,
                borderRadius: 10,
                background: 'rgba(79,70,229,0.08)',
                border: '1px solid rgba(79,70,229,0.28)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
                    <circle cx="12" cy="12" r="10" stroke="#818cf8" strokeWidth="1.5" />
                    <path d="M12 8v4M12 16h.01" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 4 }}>
                        You already have {label} credentials in {available.length === 1 ? 'another organisation' : `${available.length} other organisations`}
                    </div>
                    <div style={{ fontSize: 12, color: 'rgba(226,232,240,0.7)', lineHeight: 1.5 }}>
                        Switch context to use them, or copy a credential into <strong>{currentOrg?.name || 'this org'}</strong>.
                    </div>
                </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {available.map(cred => (
                    <div
                        key={cred.credential_id}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 10px',
                            background: 'rgba(255,255,255,0.03)',
                            border: '1px solid rgba(255,255,255,0.06)',
                            borderRadius: 6,
                        }}
                    >
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {cred.org_name}
                                {cred.is_default && (
                                    <span style={{ marginLeft: 6, fontSize: 10, color: '#4ade80', textTransform: 'uppercase', letterSpacing: 0.4 }}>default</span>
                                )}
                            </div>
                            <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.55)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {cred.label}
                                {cred.test_status === 'success' && <span style={{ marginLeft: 6, color: '#4ade80' }}>· tested OK</span>}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => handleSwitch(cred)}
                            style={{
                                padding: '5px 10px',
                                fontSize: 11,
                                background: 'rgba(79,70,229,0.18)',
                                color: '#a5b4fc',
                                border: '1px solid rgba(79,70,229,0.35)',
                                borderRadius: 5,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            Switch
                        </button>
                        <button
                            type="button"
                            onClick={() => handleCopy(cred)}
                            disabled={!!copying}
                            style={{
                                padding: '5px 10px',
                                fontSize: 11,
                                background: copying === cred.credential_id ? 'rgba(74,222,128,0.18)' : 'transparent',
                                color: copying === cred.credential_id ? '#4ade80' : 'rgba(226,232,240,0.7)',
                                border: '1px solid rgba(255,255,255,0.12)',
                                borderRadius: 5,
                                cursor: copying ? 'wait' : 'pointer',
                                whiteSpace: 'nowrap',
                                opacity: copying && copying !== cred.credential_id ? 0.4 : 1,
                            }}
                            title="Re-encrypt this credential into the current organisation"
                        >
                            {copying === cred.credential_id ? 'Copying…' : 'Copy here'}
                        </button>
                    </div>
                ))}
            </div>

            {copied && (
                <div style={{ fontSize: 12, color: '#4ade80' }}>
                    Copied. Refreshing…
                    <button
                        type="button"
                        onClick={() => navigate('/vault/credentials')}
                        style={{
                            marginLeft: 8,
                            background: 'transparent',
                            color: '#a5b4fc',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 11,
                            padding: 0,
                            textDecoration: 'underline',
                        }}
                    >
                        View in vault
                    </button>
                </div>
            )}
            {error && <div style={{ fontSize: 12, color: '#f87171' }}>{error}</div>}
        </div>
    );
}

/**
 * EncryptionPanel — SET-IA Phase 4d.
 *
 * Master encryption key rotation. Surface for the existing
 * POST /api/admin/rotate-encryption-key endpoint.
 *
 * Visibility: only renders when useInstanceAdmin().role === 'superadmin'.
 * The endpoint enforces the same gate server-side.
 *
 * Rotation re-encrypts integration_credentials, encrypted
 * instance_config rows, and api_keys with a new master key. After
 * rotation, the operator must update the MASTER_ENCRYPTION_KEY env
 * var to the new key and restart the auth service — this UI prints
 * that reminder prominently and surfaces the per-class counts the
 * server returned.
 */

import { useEffect, useState } from 'react';
import { csrfFetch } from '../../../utils/csrfFetch';
import { useInstanceAdmin } from '../../../hooks/useInstanceAdmin.js';
import { Field, inputStyle, fieldsetStyle, legendStyle, SaveStatus }
    from './instancePanelStyles.jsx';

const AUTH_API = '/api';

export default function EncryptionPanel() {
    const { role } = useInstanceAdmin();
    const isSuperadmin = role === 'superadmin';

    const [meta, setMeta]       = useState({ version: null, rotatedAt: null });
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);

    const [newKey, setNewKey]   = useState('');
    const [confirm1, setC1]     = useState(false);
    const [confirm2, setC2]     = useState(false);
    const [busy, setBusy]       = useState(false);
    const [outcome, setOutcome] = useState(null);
    const [err, setErr]         = useState(null);

    useEffect(() => {
        let live = true;
        (async () => {
            try {
                const res = await fetch(`${AUTH_API}/admin/config`, { credentials: 'include' });
                if (!res.ok) throw new Error(`Failed to load (${res.status})`);
                const { config = [] } = await res.json();
                if (!live) return;
                const lookup = Object.fromEntries(config.map(c => [c.key, c.value]));
                setMeta({
                    version: lookup.encryption_key_version || '1',
                    rotatedAt: lookup.encryption_key_rotated_at || null,
                });
                setLoadError(null);
            } catch (e) {
                if (live) setLoadError(e.message);
            } finally {
                if (live) setLoading(false);
            }
        })();
        return () => { live = false; };
    }, []);

    const rotate = async (e) => {
        e.preventDefault();
        if (!isSuperadmin) return;
        if (!confirm1 || !confirm2) {
            setErr('Both confirmation checkboxes must be ticked.');
            return;
        }
        if (newKey.trim().length < 32) {
            setErr('New key must be at least 32 base64 characters.');
            return;
        }
        setBusy(true);
        setErr(null);
        setOutcome(null);
        try {
            const res = await csrfFetch(`${AUTH_API}/admin/rotate-encryption-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body:   JSON.stringify({ newKey: newKey.trim(), confirmRotation: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || `Rotation failed (${res.status})`);
            setOutcome(data);
            // Wipe sensitive form state on success.
            setNewKey('');
            setC1(false);
            setC2(false);
            // Refresh meta so the panel shows the new version.
            const cfgRes = await fetch(`${AUTH_API}/admin/config`, { credentials: 'include' });
            if (cfgRes.ok) {
                const { config = [] } = await cfgRes.json();
                const lookup = Object.fromEntries(config.map(c => [c.key, c.value]));
                setMeta({
                    version:   lookup.encryption_key_version   || meta.version,
                    rotatedAt: lookup.encryption_key_rotated_at || meta.rotatedAt,
                });
            }
        } catch (e) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    if (!isSuperadmin) {
        return (
            <div style={{ padding: 24, maxWidth: 720 }}>
                <h2 style={{ marginTop: 0 }}>Encryption</h2>
                <p style={{ opacity: 0.7 }}>
                    Master key rotation is restricted to instance superadmins.
                </p>
            </div>
        );
    }

    return (
        <form onSubmit={rotate} noValidate style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Encryption</h2>
            <p style={{ opacity: 0.7, marginBottom: 24 }}>
                Master key rotation re-encrypts every credential, encrypted
                config row, and API key in the database with a new key.
                After rotation succeeds, you <strong>must</strong> update the
                <code style={{ margin: '0 4px' }}>MASTER_ENCRYPTION_KEY</code>
                environment variable on the auth service and restart it.
                Failure to do so leaves the service unable to decrypt anything.
            </p>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Current state</legend>
                {loading ? (
                    <p style={{ opacity: 0.6 }}>Loading…</p>
                ) : loadError ? (
                    <p style={{ color: '#f87171' }}>Failed to load: {loadError}</p>
                ) : (
                    <dl style={{ margin: 0 }}>
                        <DescRow label="Key version" value={meta.version || '1'} />
                        <DescRow label="Last rotated"
                            value={meta.rotatedAt
                                ? new Date(meta.rotatedAt + (meta.rotatedAt.endsWith('Z') ? '' : 'Z')).toLocaleString()
                                : 'Never'} />
                    </dl>
                )}
            </fieldset>

            <fieldset style={{ ...fieldsetStyle, borderColor: 'rgba(248, 113, 113, 0.4)' }}>
                <legend style={{ ...legendStyle, color: '#f87171' }}>Rotate key — destructive</legend>

                <Field id="newKey" label="New master key (base64)"
                    help="Generate with: node -e &quot;console.log(require('crypto').randomBytes(64).toString('base64url'))&quot;"
                    error={err}>
                    <input id="newKey" type="text" autoComplete="off"
                        style={{ ...inputStyle, fontFamily: 'monospace', maxWidth: 640 }}
                        value={newKey}
                        onChange={(e) => setNewKey(e.target.value)} />
                </Field>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <input type="checkbox" checked={confirm1}
                        onChange={(e) => setC1(e.target.checked)} />
                    I have a current backup of the database and the existing key.
                </label>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <input type="checkbox" checked={confirm2}
                        onChange={(e) => setC2(e.target.checked)} />
                    I will update <code style={{ margin: '0 4px' }}>MASTER_ENCRYPTION_KEY</code>
                    and restart the auth service immediately after this completes.
                </label>

                {outcome && (
                    <pre style={{ background: 'rgba(52, 211, 153, 0.08)', color: '#34d399',
                        padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto' }}
                        aria-live="polite">
                        {JSON.stringify({
                            newKeyVersion:       outcome.newKeyVersion,
                            credentialsRotated:  outcome.credentialsRotated,
                            configsRotated:      outcome.configsRotated,
                            apiKeysRotated:      outcome.apiKeysRotated,
                            errors:              outcome.errors,
                        }, null, 2)}
                    </pre>
                )}

                <button type="submit"
                    disabled={busy || !confirm1 || !confirm2 || newKey.trim().length < 32}
                    style={{
                        background: '#dc2626', color: '#fff', border: 'none',
                        borderRadius: 6, padding: '10px 20px', fontWeight: 600,
                        cursor: busy ? 'progress' : 'pointer',
                        opacity: (!confirm1 || !confirm2 || newKey.trim().length < 32) ? 0.5 : 1,
                    }}
                >
                    {busy ? 'Rotating…' : 'Rotate master key'}
                </button>
            </fieldset>
        </form>
    );
}

function DescRow({ label, value }) {
    return (
        <div style={{ display: 'flex', gap: 16, padding: '4px 0' }}>
            <dt style={{ flex: '0 0 140px', opacity: 0.7 }}>{label}</dt>
            <dd style={{ margin: 0 }}>{value}</dd>
        </div>
    );
}

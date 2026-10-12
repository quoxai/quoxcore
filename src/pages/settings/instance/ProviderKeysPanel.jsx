/**
 * ProviderKeysPanel — SET-IA Phase 5c.
 *
 * Unified surface for the three-way API key precedence chain
 * (user > org > instance). Driven by GET /api/keys/by-provider
 * (Phase 5b) which returns per-provider scope rows + effective
 * resolution; this component renders them with inheritance
 * indicators and per-scope edit affordances.
 *
 * Replaces:
 *   - src/pages/admin/AdminKeys.jsx (deleted)
 *   - the per-provider key form half of src/components/settings/CoreIntegrations.jsx
 *
 * User-scope BYOK editing is deferred to Phase 5d. The panel still
 * shows the user-scope row when allow_user_byok is on (so the
 * effective resolution chain is visible) but writes are read-only
 * and point at the future endpoint.
 */

import { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { csrfFetch } from '../../../utils/csrfFetch';
import { Field, inputStyle, fieldsetStyle, legendStyle, saveButtonStyle, SaveStatus }
    from './instancePanelStyles.jsx';

// Render CoreIntegrations below the three-scope table so the
// Claude CLI OAuth flow + QuoxVault credential picker live on the
// same page as the structured key view. Lazy so the heavy
// CoreIntegrations bundle doesn't load until this section is rendered.
const CoreIntegrations = lazy(() => import('../../../components/settings/CoreIntegrations.jsx'));

const AUTH_API = '/api';

// Subset of provider metadata the UI needs. Avoids importing the
// full registry on the frontend bundle just for display purposes —
// the server-side registry is the source of truth and the endpoint
// includes everything the UI requires (id, displayName, etc).
const SCOPE_LABELS = {
    instance: 'Instance fallback',
    org:      'Org override',
    user:     'Your key',
};

const SCOPE_COLORS = {
    instance: '#94a3b8',
    org:      '#38bdf8',
    user:     '#a855f7',
};

export default function ProviderKeysPanel() {
    const [data, setData]     = useState(null);
    const [loading, setLoad]  = useState(true);
    const [error, setError]   = useState(null);
    const [editing, setEditing] = useState(null);    // { provider, scope }

    const reload = useCallback(async () => {
        setLoad(true);
        try {
            const res = await fetch(`${AUTH_API}/keys/by-provider`, { credentials: 'include' });
            if (!res.ok) throw new Error(`Failed to load (${res.status})`);
            setData(await res.json());
            setError(null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoad(false);
        }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    if (loading) return <div style={{ padding: 24, opacity: 0.6 }}>Loading provider keys…</div>;
    if (error)   return <div style={{ padding: 24 }}><h2 style={{ marginTop: 0 }}>Provider Keys</h2>
        <p style={{ color: '#f87171' }}>{error}</p></div>;
    if (!data)   return null;

    const { providers, policy, scopesVisible } = data;

    return (
        <div style={{ padding: 24, maxWidth: 980 }}>
            <h2 style={{ marginTop: 0 }}>Provider Keys</h2>
            <p style={{ opacity: 0.7, marginBottom: 8 }}>
                API keys for AI providers. Resolution order is
                <strong> user&nbsp;→&nbsp;org&nbsp;→&nbsp;instance fallback&nbsp;→&nbsp;environment</strong>.
                The "Effective" column shows which scope is winning right now.
            </p>
            <p style={{ opacity: 0.55, fontSize: 12, marginBottom: 16 }}>
                For Claude CLI subscription login (OAuth) or QuoxVault
                credential routing, scroll to <em>Advanced setup</em> below.
            </p>

            <PolicyBanner policy={policy} />

            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
                <thead>
                    <tr style={{ textAlign: 'left', opacity: 0.7, fontSize: 12,
                                 borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        <th style={cell}>Provider</th>
                        {scopesVisible.instance && <th style={cell}>Instance</th>}
                        {scopesVisible.org      && <th style={cell}>Org</th>}
                        {scopesVisible.user     && <th style={cell}>You</th>}
                        <th style={cell}>Effective</th>
                    </tr>
                </thead>
                <tbody>
                    {providers.map(p => (
                        <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                            <td style={{ ...cell, fontWeight: 500 }}>
                                {p.displayName}
                                <div style={{ opacity: 0.5, fontSize: 11 }}>{p.id}</div>
                            </td>
                            {scopesVisible.instance && (
                                <td style={cell}>
                                    <ScopeCell scope="instance" provider={p} value={p.instance}
                                        onEdit={() => setEditing({ provider: p, scope: 'instance' })} />
                                </td>
                            )}
                            {scopesVisible.org && (
                                <td style={cell}>
                                    <ScopeCell scope="org" provider={p} value={p.org}
                                        onEdit={() => setEditing({ provider: p, scope: 'org' })} />
                                </td>
                            )}
                            {scopesVisible.user && (
                                <td style={cell}>
                                    <ScopeCell scope="user" provider={p} value={p.user} disabled />
                                </td>
                            )}
                            <td style={cell}>
                                <EffectiveBadge effective={p.effective} />
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {editing && (
                <EditModal
                    provider={editing.provider}
                    scope={editing.scope}
                    activeOrgId={data.activeOrgId}
                    existing={editing.scope === 'instance' ? editing.provider.instance
                            : editing.scope === 'org'      ? editing.provider.org
                            : null}
                    onClose={() => setEditing(null)}
                    onSaved={async () => { setEditing(null); await reload(); }}
                />
            )}

            <section style={{
                marginTop: 32,
                paddingTop: 24,
                borderTop: '1px solid rgba(255,255,255,0.08)',
            }}>
                <h3 style={{ marginTop: 0 }}>Advanced setup</h3>
                <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 16 }}>
                    Per-provider configuration with the Claude CLI OAuth flow,
                    QuoxVault credential routing, test connectivity, and
                    last-used metadata.
                </p>
                <Suspense fallback={
                    <div style={{ padding: 24, opacity: 0.6 }}>Loading advanced setup…</div>
                }>
                    <CoreIntegrations />
                </Suspense>
            </section>
        </div>
    );
}

const cell = { padding: '12px 8px', verticalAlign: 'top' };

function PolicyBanner({ policy }) {
    if (policy.allowOrgOverride && policy.allowUserBYOK) return null;
    const lines = [];
    if (!policy.allowOrgOverride) lines.push('Org override is disabled — org-scoped keys are ignored at runtime.');
    if (!policy.allowUserBYOK)    lines.push('User BYOK is disabled — personal keys are ignored at runtime.');
    return (
        <div style={{
            padding: 12, borderRadius: 6, fontSize: 13,
            background: 'rgba(217, 119, 6, 0.12)',
            border: '1px solid rgba(217, 119, 6, 0.3)',
            color: '#fbbf24',
        }} role="note">
            {lines.map((l, i) => <div key={i}>{l}</div>)}
            <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>
                Toggle these in <strong>Instance → Org Policy</strong>.
            </div>
        </div>
    );
}

function ScopeCell({ scope, value, onEdit, disabled }) {
    const accent = SCOPE_COLORS[scope];
    if (!value) {
        return (
            <button type="button" onClick={onEdit} disabled={disabled}
                style={{
                    background: 'transparent', color: accent,
                    border: `1px dashed ${accent}55`, borderRadius: 4,
                    padding: '4px 10px', fontSize: 12,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.4 : 1,
                }}>
                {disabled ? '—' : 'Set'}
            </button>
        );
    }
    return (
        <div>
            <code style={{ fontSize: 12, color: accent }}>{value.keyPreview}</code>
            {!disabled && (
                <button type="button" onClick={onEdit} style={{
                    marginLeft: 8, background: 'transparent',
                    color: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
                }}>Replace</button>
            )}
        </div>
    );
}

function EffectiveBadge({ effective }) {
    if (!effective) {
        return <span style={{ color: '#94a3b8', fontSize: 12 }}>Not configured</span>;
    }
    const accent = SCOPE_COLORS[effective.source] || '#34d399';
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
            background: `${accent}22`, color: accent,
            border: `1px solid ${accent}55`,
        }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent }} />
            {SCOPE_LABELS[effective.source] || effective.source}
        </span>
    );
}

function EditModal({ provider, scope, activeOrgId, existing, onClose, onSaved }) {
    const [value, setValue] = useState('');
    const [busy, setBusy]   = useState(false);
    const [err, setErr]     = useState(null);

    const submit = async (e) => {
        e.preventDefault();
        if (!value.trim()) return setErr('Key cannot be empty.');
        setBusy(true);
        setErr(null);
        try {
            if (scope === 'instance') {
                // Reuses the existing /admin/config/integration POST
                // endpoint for the per-provider field map.
                const res = await csrfFetch(`${AUTH_API}/admin/config/integration`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                        field: `${provider.id}Key`,
                        value: value.trim(),
                    }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.message || data.error || `Save failed (${res.status})`);
                }
            } else if (scope === 'org') {
                if (!activeOrgId) throw new Error('No active org context.');
                const res = await csrfFetch(`${AUTH_API}/orgs/${activeOrgId}/integrations`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                        type:        provider.id,
                        label:       `${provider.displayName} (default)`,
                        credentials: { api_key: value.trim() },
                        is_default:  true,
                    }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.message || data.error || `Save failed (${res.status})`);
                }
            }
            await onSaved();
        } catch (e) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} role="dialog" aria-modal="true">
            <form onSubmit={submit} noValidate style={{
                background: '#0f172a', padding: 24, borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.12)',
                width: 480, maxWidth: '90vw',
            }}>
                <h3 style={{ marginTop: 0 }}>
                    {existing ? 'Replace' : 'Set'} {provider.displayName} key
                </h3>
                <p style={{ opacity: 0.7, fontSize: 13 }}>
                    Scope: <strong>{SCOPE_LABELS[scope]}</strong>
                    {scope === 'org' && activeOrgId && <span> · org <code>{activeOrgId}</code></span>}
                </p>

                <Field id="newkey" label="API key" error={err}>
                    <input id="newkey" type="password" autoComplete="off" autoFocus
                        style={{ ...inputStyle, fontFamily: 'monospace', maxWidth: '100%' }}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder={provider.displayName} />
                </Field>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                    <button type="button" onClick={onClose} disabled={busy}
                        style={{
                            background: 'transparent', color: '#cbd5e1',
                            border: '1px solid rgba(255,255,255,0.18)',
                            borderRadius: 6, padding: '8px 14px', cursor: 'pointer',
                        }}>Cancel</button>
                    <button type="submit" disabled={busy || !value.trim()}
                        style={saveButtonStyle(busy)}>
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </form>
        </div>
    );
}

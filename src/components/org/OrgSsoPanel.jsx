/**
 * OrgSsoPanel — ET-2 Phase D.
 *
 * Enterprise-only admin panel for configuring OIDC SSO providers.
 * Lists configured providers, supports add (templates for Google /
 * Okta / Azure / generic OIDC), inline edit (rotate secret, edit
 * domains, enable/disable), delete, and a "test login" link that
 * opens the /login handshake in a new tab.
 */

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    SSO_PROVIDER_KEYS,
    providerTemplate,
    isValidIssuerUrl,
    isValidEmailDomain,
    fetchSsoProviders,
    createSsoProvider,
    updateSsoProvider,
    deleteSsoProvider,
    loginUrlFor,
} from '../../services/ssoClient';

const KeyIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="M12 12l9-9M18 6l3 3M15 9l3 3" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
);

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const TestIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 12l5 5L20 7" />
    </svg>
);

const PROVIDER_LABELS = {
    google: 'Google',
    okta:   'Okta',
    azure:  'Microsoft Entra',
    oidc:   'OIDC',
    saml:   'SAML 2.0',
};

function isSamlInitial(initial) {
    return initial?.protocol === 'saml' || initial?.providerKey === 'saml';
}

function ProviderForm({ initial, onCancel, onSubmit, busy, submitLabel }) {
    const [form, setForm] = useState(initial);
    const [domainsInput, setDomainsInput] = useState((initial.emailDomains || []).join(', '));
    const isSaml = isSamlInitial(initial);

    // SAML: attribute_map + group_role_map are edited as JSON strings so
    // the admin can paste a config exported from their IdP. We parse on
    // submit and surface a clear error if the JSON is bad.
    const [attrMapText, setAttrMapText]   = useState(
        JSON.stringify(initial.attributeMap || {}, null, 2),
    );
    const [groupMapText, setGroupMapText] = useState(
        JSON.stringify(initial.groupRoleMap || {}, null, 2),
    );
    const [jsonError, setJsonError] = useState(null);

    const update = (key, value) => setForm(f => ({ ...f, [key]: value }));

    const handleSubmit = (e) => {
        e.preventDefault();
        const emailDomains = domainsInput
            .split(',')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean);

        let payload = { ...form, emailDomains };
        if (isSaml) {
            try {
                payload.attributeMap = attrMapText.trim() ? JSON.parse(attrMapText) : {};
                payload.groupRoleMap = groupMapText.trim() ? JSON.parse(groupMapText) : {};
            } catch (err) {
                setJsonError(`Invalid JSON: ${err.message}`);
                return;
            }
            payload.protocol = 'saml';
        }
        setJsonError(null);
        onSubmit(payload);
    };

    return (
        <form className="org-sso-panel__form" onSubmit={handleSubmit}>
            <div className="org-sso-panel__field">
                <label>Display name</label>
                <input value={form.displayName || ''}
                    onChange={e => update('displayName', e.target.value)}
                    placeholder={isSaml ? 'Okta (SAML)' : 'Google Workspace'} />
            </div>

            {isSaml ? (
                <>
                    <div className="org-sso-panel__field">
                        <label>IdP Entity ID</label>
                        <input value={form.entityId || ''}
                            onChange={e => update('entityId', e.target.value)}
                            placeholder="http://www.okta.com/exk..." required />
                    </div>
                    <div className="org-sso-panel__field">
                        <label>SSO URL</label>
                        <input value={form.ssoUrl || ''}
                            onChange={e => update('ssoUrl', e.target.value)}
                            placeholder="https://your-idp.example/sso/saml" required />
                    </div>
                    <div className="org-sso-panel__field">
                        <label>SLO URL <span className="org-sso-panel__hint-inline">(optional)</span></label>
                        <input value={form.sloUrl || ''}
                            onChange={e => update('sloUrl', e.target.value)} />
                    </div>
                    <div className="org-sso-panel__field">
                        <label>NameID format</label>
                        <input value={form.nameidFormat || ''}
                            onChange={e => update('nameidFormat', e.target.value)}
                            placeholder="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" />
                    </div>
                    <div className="org-sso-panel__field org-sso-panel__field--wide">
                        <label>IdP X.509 certificate (PEM)
                            {initial.id && <span className="org-sso-panel__hint-inline"> (paste to rotate; leave blank to keep)</span>}
                        </label>
                        <textarea
                            className="org-sso-panel__textarea"
                            rows={5}
                            value={form.x509Cert || ''}
                            onChange={e => update('x509Cert', e.target.value)}
                            placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"
                            required={!initial.id}
                        />
                    </div>
                    <div className="org-sso-panel__field org-sso-panel__field--wide">
                        <label>Attribute map (JSON)
                            <span className="org-sso-panel__hint-inline"> keys: email, firstName, lastName, groups</span>
                        </label>
                        <textarea
                            className="org-sso-panel__textarea"
                            rows={4}
                            value={attrMapText}
                            onChange={e => setAttrMapText(e.target.value)}
                        />
                    </div>
                    <div className="org-sso-panel__field org-sso-panel__field--wide">
                        <label>Group → role map (JSON)
                            <span className="org-sso-panel__hint-inline"> e.g. {'{ "Admins": "admin" }'}</span>
                        </label>
                        <textarea
                            className="org-sso-panel__textarea"
                            rows={4}
                            value={groupMapText}
                            onChange={e => setGroupMapText(e.target.value)}
                        />
                    </div>
                </>
            ) : (
                <>
                    <div className="org-sso-panel__field">
                        <label>Issuer URL</label>
                        <input value={form.issuer || ''}
                            onChange={e => update('issuer', e.target.value)}
                            placeholder="https://accounts.google.com" required />
                    </div>
                    <div className="org-sso-panel__field">
                        <label>Client ID</label>
                        <input value={form.clientId || ''}
                            onChange={e => update('clientId', e.target.value)} required />
                    </div>
                    <div className="org-sso-panel__field">
                        <label>Client Secret {initial.id && <span className="org-sso-panel__hint-inline">(leave blank to keep)</span>}</label>
                        <input type="password"
                            value={form.clientSecret || ''}
                            onChange={e => update('clientSecret', e.target.value)}
                            placeholder={initial.id ? '••••••••' : ''}
                            required={!initial.id} />
                    </div>
                    <div className="org-sso-panel__field org-sso-panel__field--wide">
                        <label>Scopes</label>
                        <input value={(form.scopes || []).join(' ')}
                            onChange={e => update('scopes', e.target.value.split(/\s+/).filter(Boolean))}
                            placeholder="openid email profile" />
                    </div>
                    {form.providerKey === 'oidc' && (
                        <>
                            <div className="org-sso-panel__field">
                                <label>Authorization URL</label>
                                <input value={form.authzUrl || ''} onChange={e => update('authzUrl', e.target.value)} />
                            </div>
                            <div className="org-sso-panel__field">
                                <label>Token URL</label>
                                <input value={form.tokenUrl || ''} onChange={e => update('tokenUrl', e.target.value)} />
                            </div>
                            <div className="org-sso-panel__field">
                                <label>Userinfo URL</label>
                                <input value={form.userinfoUrl || ''} onChange={e => update('userinfoUrl', e.target.value)} />
                            </div>
                        </>
                    )}
                </>
            )}

            <div className="org-sso-panel__field org-sso-panel__field--wide">
                <label>Email domains (comma-separated)
                    <span className="org-sso-panel__hint-inline"> used to auto-redirect the login page</span>
                </label>
                <input value={domainsInput}
                    onChange={e => setDomainsInput(e.target.value)}
                    placeholder="corp.io, example.com" />
            </div>

            {jsonError && <div className="org-sso-panel__error org-sso-panel__field--wide">{jsonError}</div>}

            <div className="org-sso-panel__form-actions">
                <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
                <Button type="submit" size="sm" variant="primary" loading={busy}>{submitLabel}</Button>
            </div>
        </form>
    );
}

export default function OrgSsoPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [providers, setProviders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [addingKey, setAddingKey] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setProviders(await fetchSsoProviders(orgId, authFetch));
        } catch (err) {
            setError(err.message || String(err));
        } finally {
            setLoading(false);
        }
    }, [orgId, authFetch]);

    useEffect(() => { load(); }, [load]);

    const handleCreate = async (payload) => {
        const isSaml = payload.protocol === 'saml' || payload.providerKey === 'saml';
        if (!isSaml && !isValidIssuerUrl(payload.issuer)) {
            setError(`Issuer must be an https:// URL — got "${payload.issuer}"`);
            return;
        }
        for (const d of payload.emailDomains || []) {
            if (!isValidEmailDomain(d)) {
                setError(`"${d}" is not a valid email domain`);
                return;
            }
        }
        setBusy(true);
        setError(null);
        try {
            await createSsoProvider(orgId, payload, authFetch);
            setAddingKey(null);
            await load();
        } catch (err) {
            setError(err.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    const handleUpdate = async (id, patch) => {
        // Strip empty client secret — backend keeps cipher when absent.
        const clean = { ...patch };
        if (!clean.clientSecret) delete clean.clientSecret;
        setBusy(true);
        setError(null);
        try {
            await updateSsoProvider(orgId, id, clean, authFetch);
            setEditingId(null);
            await load();
        } catch (err) {
            setError(err.message || String(err));
        } finally {
            setBusy(false);
        }
    };

    const handleToggleEnabled = async (p) => {
        try {
            await updateSsoProvider(orgId, p.id, { enabled: !p.enabled }, authFetch);
            await load();
        } catch (err) {
            setError(err.message || String(err));
        }
    };

    const handleDelete = async (p) => {
        if (!window.confirm(`Remove SSO provider "${p.display_name || p.provider_key}"? Users will no longer be able to sign in with it.`)) return;
        try {
            await deleteSsoProvider(orgId, p.id, authFetch);
            await load();
        } catch (err) {
            setError(err.message || String(err));
        }
    };

    return (
        <div className="qx-card org-sso-panel">
            <div className="org-sso-panel__head">
                <span className="org-sso-panel__icon"><KeyIcon /></span>
                <div className="org-sso-panel__title-group">
                    <h3 className="org-sso-panel__title">Single Sign-On (SSO)</h3>
                    <p className="org-sso-panel__sub">Configure OIDC providers so members can sign in with their company identity.</p>
                </div>
                {isAdmin && !addingKey && (
                    <div className="org-sso-panel__add-group">
                        <span className="org-sso-panel__add-label">Add provider</span>
                        {SSO_PROVIDER_KEYS.map(k => (
                            <Button key={k} size="sm" variant="ghost"
                                onClick={() => setAddingKey(k)}>
                                <PlusIcon />
                                <span>{PROVIDER_LABELS[k]}</span>
                            </Button>
                        ))}
                    </div>
                )}
            </div>

            {error && <div className="org-sso-panel__error">{error}</div>}

            {addingKey && isAdmin && (
                <ProviderForm
                    initial={{ ...providerTemplate(addingKey), clientId: '', clientSecret: '', emailDomains: [] }}
                    onCancel={() => setAddingKey(null)}
                    onSubmit={handleCreate}
                    busy={busy}
                    submitLabel="Create provider"
                />
            )}

            {loading ? (
                <div className="org-sso-panel__empty">Loading…</div>
            ) : providers.length === 0 && !addingKey ? (
                <div className="org-sso-panel__empty">
                    No SSO providers configured. {isAdmin && 'Pick a template above to add one.'}
                </div>
            ) : (
                <ul className="org-sso-panel__list">
                    {providers.map(p => (
                        <li key={p.id} className={`org-sso-panel__row${p.enabled ? '' : ' is-disabled'}`}>
                            <div className="org-sso-panel__row-head">
                                <div className="org-sso-panel__row-info">
                                    <div className="org-sso-panel__row-name">
                                        {p.display_name || PROVIDER_LABELS[p.provider_key] || p.provider_key}
                                    </div>
                                    <div className="org-sso-panel__row-issuer">{p.issuer}</div>
                                    {p.email_domains?.length > 0 && (
                                        <div className="org-sso-panel__row-domains">
                                            {p.email_domains.map(d => (
                                                <span key={d} className="org-sso-panel__domain-chip">{d}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <div className="org-sso-panel__row-actions">
                                    <a
                                        className="org-sso-panel__test-link"
                                        href={loginUrlFor(p.id)}
                                        target="_blank"
                                        rel="noreferrer"
                                        title="Run the login handshake in a new tab"
                                    >
                                        <TestIcon />
                                        <span>Test</span>
                                    </a>
                                    {isAdmin && (
                                        <>
                                            <label className="org-sso-panel__toggle">
                                                <input type="checkbox"
                                                    checked={!!p.enabled}
                                                    onChange={() => handleToggleEnabled(p)} />
                                                <span>{p.enabled ? 'Enabled' : 'Disabled'}</span>
                                            </label>
                                            <button type="button"
                                                className="org-sso-panel__edit-btn"
                                                onClick={() => setEditingId(editingId === p.id ? null : p.id)}>
                                                {editingId === p.id ? 'Close' : 'Edit'}
                                            </button>
                                            <button type="button"
                                                className="org-sso-panel__del-btn"
                                                aria-label={`Delete ${p.display_name || p.provider_key}`}
                                                onClick={() => handleDelete(p)}>
                                                <TrashIcon />
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                            {editingId === p.id && isAdmin && (
                                <ProviderForm
                                    initial={{
                                        id:           p.id,
                                        providerKey:  p.provider_key,
                                        displayName:  p.display_name || '',
                                        issuer:       p.issuer || '',
                                        clientId:     p.client_id || '',
                                        clientSecret: '',
                                        emailDomains: p.email_domains || [],
                                        scopes:       p.scopes || ['openid', 'email', 'profile'],
                                        authzUrl:     p.authz_url || '',
                                        tokenUrl:     p.token_url || '',
                                        userinfoUrl:  p.userinfo_url || '',
                                    }}
                                    onCancel={() => setEditingId(null)}
                                    onSubmit={(payload) => handleUpdate(p.id, payload)}
                                    busy={busy}
                                    submitLabel="Save changes"
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

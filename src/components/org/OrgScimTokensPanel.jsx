/**
 * OrgScimTokensPanel — ET-3 Phase E.
 *
 * Enterprise. Generates bearer tokens that IdPs (Okta, Azure, etc.)
 * use to authenticate against the SCIM v2 endpoints. Plaintext is
 * returned exactly once.
 */

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    fetchScimTokens,
    createScimToken,
    revokeScimToken,
} from '../../services/scimTokensClient';

const KeyIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="7.5" cy="15.5" r="4.5" />
        <path d="M12 12l9-9M18 6l3 3M15 9l3 3" />
    </svg>
);

const RevokeIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="5" y1="5" x2="19" y2="19" />
    </svg>
);

export default function OrgScimTokensPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [tokens, setTokens] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [label, setLabel] = useState('');
    const [busy, setBusy] = useState(false);
    const [reveal, setReveal] = useState(null);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try { setTokens(await fetchScimTokens(orgId, authFetch)); }
        catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, [orgId, authFetch]);

    useEffect(() => { load(); }, [load]);

    const handleCreate = async (e) => {
        e.preventDefault();
        setBusy(true); setError(null); setCopied(false);
        try {
            const out = await createScimToken(orgId, { label: label.trim() || null }, authFetch);
            setReveal(out.token);
            setLabel('');
            await load();
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
    };

    const handleRevoke = async (t) => {
        if (!window.confirm(`Revoke "${t.label || t.id}"? The IdP using this token will stop syncing.`)) return;
        try { await revokeScimToken(orgId, t.id, authFetch); await load(); }
        catch (err) { setError(err.message); }
    };

    const handleCopy = () => {
        if (!reveal) return;
        navigator.clipboard?.writeText(reveal).then(() => setCopied(true)).catch(() => {});
    };

    return (
        <div className="qx-card org-scim-panel">
            <div className="org-scim-panel__head">
                <span className="org-scim-panel__icon"><KeyIcon /></span>
                <div className="org-scim-panel__title-group">
                    <h3 className="org-scim-panel__title">SCIM Directory Sync</h3>
                    <p className="org-scim-panel__sub">Bearer tokens for Okta, Microsoft Entra, OneLogin, Google Workspace.</p>
                </div>
            </div>

            {error && <div className="org-scim-panel__error">{error}</div>}

            {reveal && (
                <div className="org-scim-panel__secret">
                    <div className="org-scim-panel__secret-title">Bearer token — copy it now</div>
                    <div className="org-scim-panel__secret-sub">
                        Paste this into your IdP's SCIM configuration. Quox does not store the plaintext — you will not see it again.
                    </div>
                    <div className="org-scim-panel__secret-row">
                        <code>{reveal}</code>
                        <Button size="sm" variant="ghost" onClick={handleCopy}>
                            {copied ? 'Copied' : 'Copy'}
                        </Button>
                    </div>
                    <div className="org-scim-panel__secret-info">
                        SCIM endpoint: <code>{typeof window !== 'undefined' ? window.location.origin : ''}/scim/v2</code>
                    </div>
                    <div className="org-scim-panel__secret-actions">
                        <Button size="sm" variant="primary" onClick={() => setReveal(null)}>I saved it</Button>
                    </div>
                </div>
            )}

            {isAdmin && !reveal && (
                <form className="org-scim-panel__add" onSubmit={handleCreate}>
                    <input
                        placeholder="Label (e.g. Okta prod)"
                        value={label}
                        onChange={e => setLabel(e.target.value)}
                    />
                    <Button type="submit" size="sm" variant="primary" loading={busy}>Generate token</Button>
                </form>
            )}

            {loading ? (
                <div className="org-scim-panel__empty">Loading…</div>
            ) : tokens.length === 0 ? (
                <div className="org-scim-panel__empty">
                    No SCIM tokens yet. {isAdmin && 'Generate one to connect an IdP.'}
                </div>
            ) : (
                <ul className="org-scim-panel__list">
                    {tokens.map(t => (
                        <li key={t.id} className={`org-scim-panel__row${t.revoked_at ? ' is-revoked' : ''}`}>
                            <div className="org-scim-panel__row-info">
                                <div className="org-scim-panel__row-label">{t.label || 'Unlabelled token'}</div>
                                <div className="org-scim-panel__row-meta">
                                    <span>Created {t.created_at?.slice(0, 10)}</span>
                                    {t.last_used_at
                                        ? <span>Last used {t.last_used_at.slice(0, 10)}</span>
                                        : <span>Never used</span>}
                                    {t.revoked_at && <span className="org-scim-panel__row-revoked">Revoked</span>}
                                </div>
                            </div>
                            {isAdmin && !t.revoked_at && (
                                <Button size="sm" variant="ghost" onClick={() => handleRevoke(t)}>
                                    <RevokeIcon />
                                    <span>Revoke</span>
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

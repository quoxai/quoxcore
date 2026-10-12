/**
 * OrgWebhooksPanel — ET-3 Phase E.
 *
 * Enterprise. Admin adds https webhook subscribers for the six
 * team_event types. Plaintext secret is returned once on create/
 * rotate — we surface it with an explicit copy-and-close modal
 * so the admin knows to capture it.
 */

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    TEAM_EVENT_TYPES,
    isValidWebhookUrl,
    fetchWebhooks,
    createWebhook,
    rotateWebhookSecret,
    deleteWebhook,
} from '../../services/webhooksClient';

const WebhookIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M18 16.98h-5.99c-1.66 0-3.01-1.34-3.01-3s1.35-3 3.01-3H18" />
        <path d="M6 8.98h5.99c1.66 0 3.01 1.35 3.01 3.01 0 1.67-1.35 3.01-3.01 3.01H6" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
);

function SecretReveal({ secret, onClose }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        navigator.clipboard?.writeText(secret).then(() => setCopied(true)).catch(() => {});
    };
    return (
        <div className="org-webhooks-panel__secret">
            <div className="org-webhooks-panel__secret-title">Signing secret — copy it now</div>
            <div className="org-webhooks-panel__secret-sub">
                Quox does not store the plaintext secret. You will not see it again.
            </div>
            <div className="org-webhooks-panel__secret-row">
                <code>{secret}</code>
                <Button size="sm" variant="ghost" onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy'}
                </Button>
            </div>
            <div className="org-webhooks-panel__secret-actions">
                <Button size="sm" variant="primary" onClick={onClose}>I saved it</Button>
            </div>
        </div>
    );
}

export default function OrgWebhooksPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [webhooks, setWebhooks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showAdd, setShowAdd] = useState(false);
    const [url, setUrl] = useState('');
    const [picked, setPicked] = useState(new Set(['team.created', 'team.member.joined', 'team.member.left']));
    const [busy, setBusy] = useState(false);
    const [secretReveal, setSecretReveal] = useState(null);

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try { setWebhooks(await fetchWebhooks(orgId, authFetch)); }
        catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, [orgId, authFetch]);

    useEffect(() => { load(); }, [load]);

    const togglePick = (type) => {
        setPicked(s => {
            const next = new Set(s);
            next.has(type) ? next.delete(type) : next.add(type);
            return next;
        });
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!isValidWebhookUrl(url)) { setError('URL must be https://'); return; }
        if (picked.size === 0)       { setError('Pick at least one event');   return; }
        setBusy(true); setError(null);
        try {
            const w = await createWebhook(orgId, { url, events: [...picked] }, authFetch);
            setUrl('');
            setShowAdd(false);
            setSecretReveal(w.secret);
            await load();
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
    };

    const handleRotate = async (w) => {
        if (!window.confirm('Rotate signing secret? Current subscribers will fail to verify signatures until they update.')) return;
        try {
            const out = await rotateWebhookSecret(orgId, w.id, authFetch);
            setSecretReveal(out.secret);
        } catch (err) { setError(err.message); }
    };

    const handleDelete = async (w) => {
        if (!window.confirm(`Delete webhook ${w.url}?`)) return;
        try { await deleteWebhook(orgId, w.id, authFetch); await load(); }
        catch (err) { setError(err.message); }
    };

    return (
        <div className="qx-card org-webhooks-panel">
            <div className="org-webhooks-panel__head">
                <span className="org-webhooks-panel__icon"><WebhookIcon /></span>
                <div className="org-webhooks-panel__title-group">
                    <h3 className="org-webhooks-panel__title">Webhooks</h3>
                    <p className="org-webhooks-panel__sub">Receive signed team_events on your endpoint. HMAC-SHA256 v1.</p>
                </div>
                {isAdmin && !showAdd && !secretReveal && (
                    <Button size="sm" variant="primary" onClick={() => setShowAdd(true)}>Add webhook</Button>
                )}
            </div>

            {error && <div className="org-webhooks-panel__error">{error}</div>}

            {secretReveal && (
                <SecretReveal secret={secretReveal} onClose={() => setSecretReveal(null)} />
            )}

            {showAdd && isAdmin && !secretReveal && (
                <form className="org-webhooks-panel__form" onSubmit={handleCreate}>
                    <div className="org-webhooks-panel__field">
                        <label>Endpoint URL</label>
                        <input value={url} onChange={e => setUrl(e.target.value)}
                            placeholder="https://hooks.corp.io/quox" required />
                    </div>
                    <div className="org-webhooks-panel__field">
                        <label>Subscribe to events</label>
                        <div className="org-webhooks-panel__events">
                            {TEAM_EVENT_TYPES.map(t => (
                                <label key={t} className={`org-webhooks-panel__event${picked.has(t) ? ' is-picked' : ''}`}>
                                    <input type="checkbox"
                                        checked={picked.has(t)}
                                        onChange={() => togglePick(t)} />
                                    <span>{t}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                    <div className="org-webhooks-panel__form-actions">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
                        <Button type="submit" size="sm" variant="primary" loading={busy}>Create</Button>
                    </div>
                </form>
            )}

            {loading ? (
                <div className="org-webhooks-panel__empty">Loading…</div>
            ) : webhooks.length === 0 ? (
                <div className="org-webhooks-panel__empty">
                    No webhooks configured. {isAdmin && 'Add one to stream team_events.'}
                </div>
            ) : (
                <ul className="org-webhooks-panel__list">
                    {webhooks.map(w => (
                        <li key={w.id} className="org-webhooks-panel__row">
                            <div className="org-webhooks-panel__row-info">
                                <code className="org-webhooks-panel__url">{w.url}</code>
                                <div className="org-webhooks-panel__events-line">
                                    {(w.events || []).map(e => (
                                        <span key={e} className="org-webhooks-panel__event-chip">{e}</span>
                                    ))}
                                </div>
                            </div>
                            {isAdmin && (
                                <div className="org-webhooks-panel__row-actions">
                                    <Button size="sm" variant="ghost" onClick={() => handleRotate(w)}>Rotate secret</Button>
                                    <button type="button"
                                        className="org-webhooks-panel__del-btn"
                                        aria-label={`Delete ${w.url}`}
                                        onClick={() => handleDelete(w)}>
                                        <TrashIcon />
                                    </button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

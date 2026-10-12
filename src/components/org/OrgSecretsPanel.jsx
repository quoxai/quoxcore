/**
 * OrgSecretsPanel — ET-6D.
 *
 * Team tier+. Manage org-wide and scope-bound secrets. Plaintext is
 * only exposed through an explicit Reveal action (server records an
 * audit event for each reveal). Create / rotate use a one-time entry
 * field that is cleared after submission.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    SCOPE_ORG,
    isValidSecretName,
    fetchSecrets,
    createSecret,
    revealSecret,
    rotateSecret,
    deleteSecret,
} from '../../services/secretsClient';

const VaultIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="12" cy="12" r="4" />
        <path d="M12 8v1M12 15v1M8 12h1M15 12h1" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
);

const EyeIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

function ScopeChip({ scopeId }) {
    return (
        <span className={`org-secrets-panel__scope-chip${scopeId ? '' : ' is-org'}`}>
            {scopeId ? scopeId : 'Org-wide'}
        </span>
    );
}

function SecretReveal({ value, name, onClose }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => {});
    };
    return (
        <div className="org-secrets-panel__reveal">
            <div className="org-secrets-panel__reveal-head">
                <span className="org-secrets-panel__reveal-title">{name}</span>
                <span className="org-secrets-panel__reveal-warn">Revealed, audit logged</span>
            </div>
            <div className="org-secrets-panel__reveal-row">
                <code>{value}</code>
                <Button size="sm" variant="ghost" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
            <div className="org-secrets-panel__reveal-actions">
                <Button size="sm" variant="primary" onClick={onClose}>Close</Button>
            </div>
        </div>
    );
}

function RotateBox({ onCancel, onRotate, busy }) {
    const [newValue, setNewValue] = useState('');
    return (
        <form className="org-secrets-panel__rotate" onSubmit={e => { e.preventDefault(); if (newValue) onRotate(newValue); }}>
            <label>New value</label>
            <div className="org-secrets-panel__rotate-row">
                <input
                    type="password"
                    value={newValue}
                    onChange={e => setNewValue(e.target.value)}
                    autoComplete="new-password"
                    required
                    autoFocus
                />
                <Button size="sm" variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
                <Button size="sm" variant="primary" type="submit" loading={busy} disabled={!newValue}>Rotate</Button>
            </div>
        </form>
    );
}

export default function OrgSecretsPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [scopeFilter, setScopeFilter] = useState('all'); // 'all' | SCOPE_ORG | '<scope-id>'
    const [showAdd, setShowAdd] = useState(false);
    const [formName, setFormName] = useState('');
    const [formValue, setFormValue] = useState('');
    const [formDesc,  setFormDesc]  = useState('');
    const [formScope, setFormScope] = useState('');  // '' → org-wide
    const [busy, setBusy] = useState(false);
    const [reveal, setReveal] = useState(null);
    const [rotateId, setRotateId] = useState(null);

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const opts = (scopeFilter === 'all') ? {} : { scopeId: scopeFilter };
            setRows(await fetchSecrets(orgId, opts, authFetch));
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [orgId, authFetch, scopeFilter]);

    useEffect(() => { load(); }, [load]);

    const knownScopes = useMemo(() => {
        const s = new Set();
        for (const r of rows) if (r.scope_id) s.add(r.scope_id);
        return [...s].sort();
    }, [rows]);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!isValidSecretName(formName)) {
            setError('Name must be A–Z, a–z, 0–9, _ . - (max 128 chars)');
            return;
        }
        if (!formValue) { setError('Value is required'); return; }
        setBusy(true); setError(null);
        try {
            await createSecret(orgId, {
                name:        formName,
                value:       formValue,
                description: formDesc || null,
                scopeId:     formScope || null,
            }, authFetch);
            setFormName(''); setFormValue(''); setFormDesc(''); setFormScope('');
            setShowAdd(false);
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    const handleReveal = async (row) => {
        setError(null);
        try {
            const out = await revealSecret(orgId, row.id, authFetch);
            setReveal(out);
        } catch (err) {
            setError(err.message);
        }
    };

    const handleRotate = async (rowId, value) => {
        setBusy(true); setError(null);
        try {
            await rotateSecret(orgId, rowId, value, authFetch);
            setRotateId(null);
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (row) => {
        if (!window.confirm(`Delete secret "${row.name}"? This cannot be undone.`)) return;
        try {
            await deleteSecret(orgId, row.id, authFetch);
            await load();
        } catch (err) { setError(err.message); }
    };

    return (
        <div className="qx-card org-secrets-panel">
            <div className="org-secrets-panel__head">
                <span className="org-secrets-panel__icon"><VaultIcon /></span>
                <div className="org-secrets-panel__title-group">
                    <h3 className="org-secrets-panel__title">Secrets</h3>
                    <p className="org-secrets-panel__sub">Encrypted at rest. Reveal is audit-logged.</p>
                </div>
                {isAdmin && !showAdd && (
                    <Button size="sm" variant="primary" onClick={() => setShowAdd(true)}>New secret</Button>
                )}
            </div>

            {error && <div className="org-secrets-panel__error">{error}</div>}

            {/* Scope filter tabs */}
            <div className="org-secrets-panel__filters">
                <button
                    type="button"
                    className={`org-secrets-panel__filter${scopeFilter === 'all' ? ' is-active' : ''}`}
                    onClick={() => setScopeFilter('all')}
                >All</button>
                <button
                    type="button"
                    className={`org-secrets-panel__filter${scopeFilter === SCOPE_ORG ? ' is-active' : ''}`}
                    onClick={() => setScopeFilter(SCOPE_ORG)}
                >Org-wide</button>
                {knownScopes.map(s => (
                    <button
                        key={s}
                        type="button"
                        className={`org-secrets-panel__filter${scopeFilter === s ? ' is-active' : ''}`}
                        onClick={() => setScopeFilter(s)}
                    >{s}</button>
                ))}
            </div>

            {reveal && <SecretReveal name={reveal.name} value={reveal.value} onClose={() => setReveal(null)} />}

            {showAdd && isAdmin && (
                <form className="org-secrets-panel__form" onSubmit={handleCreate}>
                    <div className="org-secrets-panel__field">
                        <label>Name</label>
                        <input value={formName} onChange={e => setFormName(e.target.value)}
                            placeholder="OPENAI_KEY" required autoFocus />
                    </div>
                    <div className="org-secrets-panel__field">
                        <label>Scope</label>
                        <input value={formScope} onChange={e => setFormScope(e.target.value)}
                            placeholder="Leave blank for org-wide, or paste a scope id" />
                    </div>
                    <div className="org-secrets-panel__field org-secrets-panel__field--wide">
                        <label>Value</label>
                        <input type="password" value={formValue}
                            onChange={e => setFormValue(e.target.value)}
                            autoComplete="new-password" required />
                    </div>
                    <div className="org-secrets-panel__field org-secrets-panel__field--wide">
                        <label>Description <span className="org-secrets-panel__hint-inline">(optional)</span></label>
                        <input value={formDesc} onChange={e => setFormDesc(e.target.value)} />
                    </div>
                    <div className="org-secrets-panel__form-actions">
                        <Button type="button" size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
                        <Button type="submit" size="sm" variant="primary" loading={busy}>Create</Button>
                    </div>
                </form>
            )}

            {loading ? (
                <div className="org-secrets-panel__empty">Loading…</div>
            ) : rows.length === 0 ? (
                <div className="org-secrets-panel__empty">
                    No secrets in this view. {isAdmin && 'Add one to start.'}
                </div>
            ) : (
                <ul className="org-secrets-panel__list">
                    {rows.map(row => (
                        <li key={row.id} className="org-secrets-panel__row">
                            <div className="org-secrets-panel__row-head">
                                <div className="org-secrets-panel__row-info">
                                    <div className="org-secrets-panel__row-name">{row.name}</div>
                                    {row.description && (
                                        <div className="org-secrets-panel__row-desc">{row.description}</div>
                                    )}
                                    <div className="org-secrets-panel__row-meta">
                                        <ScopeChip scopeId={row.scope_id} />
                                        {row.rotated_at && <span>Rotated {row.rotated_at.slice(0, 10)}</span>}
                                        <span>Created {row.created_at?.slice(0, 10)}</span>
                                    </div>
                                </div>
                                <div className="org-secrets-panel__row-actions">
                                    <Button size="sm" variant="ghost" onClick={() => handleReveal(row)}>
                                        <EyeIcon />
                                        <span>Reveal</span>
                                    </Button>
                                    {isAdmin && (
                                        <Button size="sm" variant="ghost" onClick={() => setRotateId(rotateId === row.id ? null : row.id)}>
                                            {rotateId === row.id ? 'Close' : 'Rotate'}
                                        </Button>
                                    )}
                                    {isAdmin && (
                                        <button
                                            type="button"
                                            className="org-secrets-panel__del-btn"
                                            onClick={() => handleDelete(row)}
                                            aria-label={`Delete ${row.name}`}
                                        >
                                            <TrashIcon />
                                        </button>
                                    )}
                                </div>
                            </div>
                            {rotateId === row.id && isAdmin && (
                                <RotateBox
                                    onCancel={() => setRotateId(null)}
                                    onRotate={(v) => handleRotate(row.id, v)}
                                    busy={busy}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * OrgDomainsPanel — ET-3 Phase E.
 *
 * Team tier+ feature. Admin adds a domain → gets TXT instructions →
 * publishes the record → clicks Verify. Once verified, the domain
 * unlocks auto-join and SSO JIT-routing.
 */

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    isValidDomainInput,
    buildTxtInstructions,
    fetchDomains,
    startDomain,
    verifyDomain,
    removeDomain,
} from '../../services/domainsClient';

const GlobeIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
);

export default function OrgDomainsPanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [domains, setDomains] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [input, setInput] = useState('');
    const [busyAdd, setBusyAdd] = useState(false);
    const [busyVerifyId, setBusyVerifyId] = useState(null);
    const [expanded, setExpanded] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try { setDomains(await fetchDomains(orgId, authFetch)); }
        catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, [orgId, authFetch]);

    useEffect(() => { load(); }, [load]);

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!isValidDomainInput(input)) {
            setError(`"${input}" is not a valid domain`);
            return;
        }
        setBusyAdd(true);
        setError(null);
        try {
            const out = await startDomain(orgId, input.trim(), authFetch);
            setInput('');
            setExpanded(out.domain.id);
            await load();
        } catch (err) { setError(err.message); }
        finally { setBusyAdd(false); }
    };

    const handleVerify = async (d) => {
        setBusyVerifyId(d.id);
        setError(null);
        try {
            const out = await verifyDomain(orgId, d.id, authFetch);
            if (!out.verified) setError(out.reason || 'TXT record not found yet. Give DNS a moment.');
            await load();
        } catch (err) { setError(err.message); }
        finally { setBusyVerifyId(null); }
    };

    const handleRemove = async (d) => {
        if (!window.confirm(`Remove "${d.domain}"? Auto-join and SSO routing for this domain will stop.`)) return;
        try { await removeDomain(orgId, d.id, authFetch); await load(); }
        catch (err) { setError(err.message); }
    };

    return (
        <div className="qx-card org-domains-panel">
            <div className="org-domains-panel__head">
                <span className="org-domains-panel__icon"><GlobeIcon /></span>
                <div className="org-domains-panel__title-group">
                    <h3 className="org-domains-panel__title">Verified Domains</h3>
                    <p className="org-domains-panel__sub">Claim email domains to unlock auto-join and SSO routing.</p>
                </div>
            </div>
            {error && <div className="org-domains-panel__error">{error}</div>}

            {isAdmin && (
                <form className="org-domains-panel__add" onSubmit={handleAdd}>
                    <input
                        placeholder="corp.io"
                        value={input}
                        onChange={e => setInput(e.target.value)}
                    />
                    <Button type="submit" size="sm" variant="primary" loading={busyAdd}>Add domain</Button>
                </form>
            )}

            {loading ? (
                <div className="org-domains-panel__empty">Loading…</div>
            ) : domains.length === 0 ? (
                <div className="org-domains-panel__empty">
                    No domains yet. {isAdmin && 'Add one above to get started.'}
                </div>
            ) : (
                <ul className="org-domains-panel__list">
                    {domains.map(d => {
                        const verified = !!d.verified_at;
                        return (
                            <li key={d.id} className={`org-domains-panel__row${verified ? ' is-verified' : ''}`}>
                                <div className="org-domains-panel__row-head">
                                    <code className="org-domains-panel__domain">{d.domain}</code>
                                    <span className={`org-domains-panel__status${verified ? ' is-verified' : ''}`}>
                                        {verified ? 'Verified' : 'Pending'}
                                    </span>
                                    <div className="org-domains-panel__row-actions">
                                        {!verified && (
                                            <button type="button"
                                                className="org-domains-panel__link-btn"
                                                onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                                                {expanded === d.id ? 'Hide TXT' : 'Show TXT'}
                                            </button>
                                        )}
                                        {!verified && isAdmin && (
                                            <Button size="sm" variant="primary"
                                                onClick={() => handleVerify(d)}
                                                loading={busyVerifyId === d.id}>
                                                Verify
                                            </Button>
                                        )}
                                        {isAdmin && (
                                            <button type="button"
                                                className="org-domains-panel__del-btn"
                                                aria-label={`Remove ${d.domain}`}
                                                onClick={() => handleRemove(d)}>
                                                <TrashIcon />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {!verified && expanded === d.id && (
                                    <pre className="org-domains-panel__txt">{buildTxtInstructions(d)}</pre>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

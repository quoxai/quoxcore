/**
 * In-Dashboard Marketplace Browse
 * Browse published listings, install free plugins, see ratings
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

const PRODUCT_TYPES = [
    { value: '', label: 'All' },
    { value: 'plugin', label: 'Plugins' },
    { value: 'workflow', label: 'Workflows' },
    { value: 'agent', label: 'Agents' },
    { value: 'agent_team', label: 'Agent Teams' },
];

const PAGE_SIZE = 20;

export default function MarketplaceBrowseView() {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const [listings, setListings] = useState([]);
    const [installed, setInstalled] = useState(new Set());
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState('');
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [page, setPage] = useState(1);
    const [actionError, setActionError] = useState(null);
    const [confirmUninstall, setConfirmUninstall] = useState(null);
    const debounceRef = useRef(null);

    // Debounce search input — 400ms
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(1);
        }, 400);
        return () => clearTimeout(debounceRef.current);
    }, [search]);

    const fetchListings = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
            if (filter) params.set('product_type', filter);
            if (debouncedSearch) params.set('search', debouncedSearch);

            const res = await authFetch(`/api/marketplace/listings?${params}`);

            // GTM-A1/B2a: an error body is not data. The nginx /api/ catch-all
            // answers an unrouted path with a 404 whose body is valid JSON
            // ({"error":"not_found",...}), so res.json() succeeds, data.listings
            // is undefined, and the failure used to fall through to
            // "No published listings yet." A buyer was told the store was empty
            // when the request never reached the store. Check the status first.
            if (!res.ok) {
                throw new Error(`Listings request failed: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
            }

            const data = await res.json();
            setListings(data.listings || []);
            setTotal(data.total || 0);
        } catch (err) {
            console.error('Browse error:', err);
            setError(`${err.message || 'Failed to load listings.'} The store could not be reached, so this is not a statement about what is for sale.`);
        } finally {
            setLoading(false);
        }
    }, [filter, debouncedSearch, page, authFetch]);

    // Fetch installed list
    useEffect(() => {
        if (!currentOrg?.id) return;
        authFetch(`/api/orgs/${currentOrg.id}/marketplace/installed`)
            .then(r => r.json())
            .then(data => {
                const ids = new Set((data.installs || []).map(i => i.listing_id));
                setInstalled(ids);
            })
            .catch(() => {});
    }, [currentOrg?.id, authFetch]);

    useEffect(() => { fetchListings(); }, [fetchListings]);

    async function handleInstall(listingId) {
        if (!currentOrg?.id) return;
        setActionError(null);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/marketplace/install/${listingId}`, { method: 'POST' });
            if (res.ok) {
                setInstalled(prev => new Set([...prev, listingId]));
            } else {
                const data = await res.json();
                setActionError(data.message || 'Install failed');
            }
        } catch (err) {
            setActionError('Install failed: ' + err.message);
        }
    }

    async function handleUninstall(listingId) {
        if (!currentOrg?.id) return;
        setActionError(null);
        setConfirmUninstall(null);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/marketplace/install/${listingId}`, { method: 'DELETE' });
            if (res.ok) {
                setInstalled(prev => { const s = new Set(prev); s.delete(listingId); return s; });
            } else {
                const data = await res.json();
                setActionError(data.message || 'Uninstall failed');
            }
        } catch (err) {
            setActionError('Uninstall failed: ' + err.message);
        }
    }

    const totalPages = Math.ceil(total / PAGE_SIZE);

    return (
        <div className="qx-view" style={{ padding: '2rem', maxWidth: 1100 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                <h1 style={{ color: '#fff', fontSize: '1.5rem', margin: 0 }}>Marketplace</h1>
                <Link to="/seller" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: '0.85rem' }}>
                    Seller Dashboard →
                </Link>
            </div>

            {/* Action error banner */}
            {actionError && (
                <div className="qx-banner qx-banner--error" style={{ marginBottom: '1rem', justifyContent: 'space-between' }}>
                    <span>{actionError}</span>
                    <button onClick={() => setActionError(null)} style={{
                        background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '1rem'
                    }}>✕</button>
                </div>
            )}

            {/* Filters */}
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                {PRODUCT_TYPES.map(pt => (
                    <button
                        key={pt.value}
                        onClick={() => { setFilter(pt.value); setPage(1); }}
                        className={`qx-btn qx-btn--sm${filter === pt.value ? ' qx-btn--primary' : ''}`}
                    >
                        {pt.label}
                    </button>
                ))}
                <input
                    type="text" placeholder="Search..." value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="qx-input"
                    style={{ marginLeft: 'auto', width: 200 }}
                />
            </div>

            {/* Grid */}
            {error ? (
                <div className="qx-banner qx-banner--error" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                    <span>{error}</span>
                    <button onClick={fetchListings} className="qx-btn qx-btn--sm">Retry</button>
                </div>
            ) : loading ? (
                <div className="qx-empty"><p>Loading...</p></div>
            ) : listings.length === 0 ? (
                <div className="qx-empty">
                    <p className="qx-empty__body">{debouncedSearch ? 'No listings match your search.' : 'No published listings yet.'}</p>
                    {!debouncedSearch && (
                        <a href="https://quox.ai/developers" target="_blank" rel="noopener noreferrer" style={{ color: '#a78bfa', textDecoration: 'none' }}>
                            Become a developer →
                        </a>
                    )}
                </div>
            ) : (
                <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                        {listings.map(listing => {
                            const isInstalled = installed.has(listing.id);
                            return (
                                <div key={listing.id} className="qx-card" style={{ display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                        <span className="qx-pill qx-pill--ghost qx-pill--sm">{listing.product_type}</span>
                                        {listing.trust_level !== 'registered' && (
                                            <span style={{ color: '#22c55e', fontSize: '0.7rem' }}>✓ {listing.trust_level}</span>
                                        )}
                                    </div>

                                    <Link to={`/marketplace/${listing.id}`} style={{ textDecoration: 'none', flex: 1 }}>
                                        <h3 style={{ color: '#fff', fontSize: '1rem', fontWeight: 600, margin: '0 0 6px' }}>
                                            {listing.title}
                                        </h3>
                                        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem', lineHeight: 1.5, margin: '0 0 12px' }}>
                                            {listing.description?.slice(0, 100)}{listing.description?.length > 100 ? '...' : ''}
                                        </p>
                                    </Link>

                                    <div style={{
                                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                        paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.1)'
                                    }}>
                                        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.75rem' }}>
                                            by {listing.seller_name}
                                        </span>
                                        {listing.price_model === 'free' ? (
                                            isInstalled ? (
                                                confirmUninstall === listing.id ? (
                                                    <span style={{ display: 'flex', gap: 4 }}>
                                                        <button onClick={() => handleUninstall(listing.id)} className="qx-btn qx-btn--sm qx-btn--danger">Confirm</button>
                                                        <button onClick={() => setConfirmUninstall(null)} className="qx-btn qx-btn--sm qx-btn--ghost">Cancel</button>
                                                    </span>
                                                ) : (
                                                    <button onClick={() => setConfirmUninstall(listing.id)} className="qx-btn qx-btn--sm qx-btn--danger">Uninstall</button>
                                                )
                                            ) : (
                                                <button onClick={() => handleInstall(listing.id)} className="qx-btn qx-btn--sm qx-btn--success">Install</button>
                                            )
                                        ) : (
                                            <span style={{ color: '#f59e0b', fontSize: '0.8rem', fontWeight: 600 }}>
                                                £{(listing.price_cents / 100).toFixed(2)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: '2rem' }}>
                            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="qx-btn qx-btn--sm">Previous</button>
                            <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }}>
                                Page {page} of {totalPages}
                            </span>
                            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="qx-btn qx-btn--sm">Next</button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

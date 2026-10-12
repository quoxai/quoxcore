/**
 * Seller Dashboard View
 * Dashboard page showing seller profile, listings overview, and quick actions
 */

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

const STATUS_COLOURS = {
    draft: '#71717a',
    submitted: '#3b82f6',
    in_review: '#f59e0b',
    published: '#22c55e',
    suspended: '#ef4444',
    delisted: '#52525b',
};

export default function SellerDashboard() {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const navigate = useNavigate();
    const [seller, setSeller] = useState(null);
    const [listings, setListings] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!currentOrg?.id) return;

        async function load() {
            setLoading(true);
            try {
                const sellerRes = await authFetch(`/api/orgs/${currentOrg.id}/sellers/me`);
                if (sellerRes.status === 404) {
                    navigate('/seller/register');
                    return;
                }
                const sellerData = await sellerRes.json();
                setSeller(sellerData.seller);

                const listingsRes = await authFetch(`/api/orgs/${currentOrg.id}/listings`);
                const listingsData = await listingsRes.json();
                setListings(listingsData.listings || []);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [currentOrg?.id, navigate]);

    if (!currentOrg) return <div className="qx-view qx-empty"><p>Select an organisation to continue.</p></div>;
    if (loading) return <div className="qx-view qx-empty"><p>Loading...</p></div>;
    if (error) return <div className="qx-view"><div className="qx-banner qx-banner--error">{error}</div></div>;
    if (!seller) return null;

    const statusCounts = listings.reduce((acc, l) => {
        acc[l.status] = (acc[l.status] || 0) + 1;
        return acc;
    }, {});

    return (
        <div className="qx-view" style={{ padding: '2rem', maxWidth: 1000 }}>
            {/* Header */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                marginBottom: '2rem', paddingBottom: '1.5rem',
                borderBottom: '1px solid rgba(255,255,255,0.1)'
            }}>
                <div>
                    <h1 style={{ color: '#fff', fontSize: '1.5rem', margin: '0 0 0.25rem' }}>
                        {seller.display_name}
                    </h1>
                    <span className="qx-pill qx-pill--purple qx-pill--sm">
                        {seller.trust_level}
                    </span>
                    {seller.bio && <p style={{ color: 'rgba(255,255,255,0.7)', margin: '0.5rem 0 0', fontSize: '0.9rem' }}>{seller.bio}</p>}
                </div>
                <Link to="/seller/submit" className="qx-btn qx-btn--primary">
                    + New Listing
                </Link>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
                {Object.entries(statusCounts).map(([status, count]) => (
                    <div key={status} className="qx-card qx-card--compact" style={{ minWidth: 100 }}>
                        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: STATUS_COLOURS[status] || '#fff' }}>
                            {count}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)', textTransform: 'capitalize' }}>
                            {status.replace('_', ' ')}
                        </div>
                    </div>
                ))}
                {listings.length === 0 && (
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.9rem' }}>
                        No listings yet. Create your first one.
                    </div>
                )}
            </div>

            {/* Listings Table */}
            {listings.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <h2 style={{ color: '#fff', fontSize: '1.1rem', margin: '0 0 0.5rem' }}>Listings</h2>
                    {listings.map(listing => (
                        <Link
                            key={listing.id}
                            to={`/seller/listings/${listing.id}`}
                            className="qx-card qx-card--compact"
                            style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                textDecoration: 'none'
                            }}
                        >
                            <div>
                                <span style={{ color: '#fff', fontWeight: 500 }}>{listing.title}</span>
                                <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                                    {listing.product_type}
                                </span>
                            </div>
                            <span
                                className="qx-pill qx-pill--sm"
                                style={{
                                    background: `${STATUS_COLOURS[listing.status] || '#71717a'}22`,
                                    color: STATUS_COLOURS[listing.status] || '#71717a'
                                }}
                            >
                                {listing.status}
                            </span>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}

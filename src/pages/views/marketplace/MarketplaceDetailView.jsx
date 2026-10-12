/**
 * In-Dashboard Marketplace Listing Detail
 * Shows full listing info, screenshots, reviews, install/uninstall button
 */

import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

export default function MarketplaceDetailView() {
    const { id } = useParams();
    const { authFetch, user } = useAuth();
    const { currentOrg } = useWorkspace();

    const [listing, setListing] = useState(null);
    const [versions, setVersions] = useState([]);
    const [screenshots, setScreenshots] = useState([]);
    const [reviews, setReviews] = useState([]);
    const [stats, setStats] = useState({ install_count: 0, review_count: 0, average_rating: 0 });
    const [isInstalled, setIsInstalled] = useState(false);
    const [loading, setLoading] = useState(true);
    const [actionError, setActionError] = useState(null);
    const [confirmUninstall, setConfirmUninstall] = useState(false);

    // Review form
    const [reviewRating, setReviewRating] = useState(5);
    const [reviewTitle, setReviewTitle] = useState('');
    const [reviewBody, setReviewBody] = useState('');
    const [reviewSubmitting, setReviewSubmitting] = useState(false);

    useEffect(() => {
        if (!id) return;
        setLoading(true);

        Promise.all([
            authFetch(`/api/marketplace/listings/${id}`).then(r => r.ok ? r.json() : null).catch(() => null),
            authFetch(`/api/marketplace/listings/${id}/reviews`).then(r => r.json()).catch(() => ({ reviews: [] })),
            authFetch(`/api/marketplace/listings/${id}/stats`).then(r => r.json()).catch(() => ({ stats: {} })),
        ]).then(([listingData, reviewsData, statsData]) => {
            if (listingData) {
                setListing(listingData.listing || listingData);
                setVersions(listingData.versions || []);
                setScreenshots(listingData.screenshots || []);
            }
            setReviews(reviewsData.reviews || []);
            setStats(statsData.stats || {});
            setLoading(false);
        });
    }, [id, authFetch]);

    // Check install status
    useEffect(() => {
        if (!currentOrg?.id || !id) return;
        authFetch(`/api/orgs/${currentOrg.id}/marketplace/installed`)
            .then(r => r.json())
            .then(data => {
                const installed = (data.installs || []).some(i => i.listing_id === id);
                setIsInstalled(installed);
            })
            .catch(() => {});
    }, [currentOrg?.id, id, authFetch]);

    async function handleInstall() {
        if (!currentOrg?.id) return;
        setActionError(null);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/marketplace/install/${id}`, { method: 'POST' });
            if (res.ok) {
                setIsInstalled(true);
                setStats(s => ({ ...s, install_count: (s.install_count || 0) + 1 }));
            } else {
                const data = await res.json();
                setActionError(data.message || 'Install failed');
            }
        } catch (err) {
            setActionError('Install failed: ' + err.message);
        }
    }

    async function handleUninstall() {
        if (!currentOrg?.id) return;
        setActionError(null);
        setConfirmUninstall(false);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/marketplace/install/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setIsInstalled(false);
                setStats(s => ({ ...s, install_count: Math.max(0, (s.install_count || 0) - 1) }));
            } else {
                const data = await res.json();
                setActionError(data.message || 'Uninstall failed');
            }
        } catch (err) {
            setActionError('Uninstall failed: ' + err.message);
        }
    }

    async function handleSubmitReview(e) {
        e.preventDefault();
        if (!currentOrg?.id) return;
        setReviewSubmitting(true);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/marketplace/reviews/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rating: reviewRating, title: reviewTitle || null, body: reviewBody || null })
            });
            const data = await res.json();
            if (res.ok) {
                setReviews(prev => [data.review, ...prev]);
                setReviewTitle('');
                setReviewBody('');
                setActionError(null);
            } else {
                setActionError(data.message || 'Failed to submit review');
            }
        } catch (err) {
            setActionError('Failed: ' + err.message);
        } finally {
            setReviewSubmitting(false);
        }
    }

    if (loading) return <div className="qx-view qx-empty"><p>Loading...</p></div>;
    if (!listing) return <div className="qx-view"><div className="qx-banner qx-banner--error">Listing not found.</div></div>;

    const latestApproved = versions.find(v => v.review_status === 'approved');
    const alreadyReviewed = reviews.some(r => r.user_id === user?.id);
    const isOwnListing = listing.org_id === currentOrg?.id;

    return (
        <div className="qx-view" style={{ padding: '2rem', maxWidth: 900 }}>
            <Link to="/marketplace/browse" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: '0.85rem' }}>
                ← Back to Marketplace
            </Link>

            {/* Header */}
            <div style={{ marginTop: '1rem', marginBottom: '2rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                        <span className="qx-pill qx-pill--ghost qx-pill--sm">{listing.product_type}</span>
                        <h1 style={{ color: '#fff', fontSize: '1.6rem', margin: '8px 0 4px' }}>{listing.title}</h1>
                        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85rem', margin: 0 }}>
                            by {listing.seller_name}
                        </p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                        {listing.price_model === 'free' && !isOwnListing && (
                            confirmUninstall ? (
                                <span style={{ display: 'flex', gap: 6 }}>
                                    <button onClick={handleUninstall} className="qx-btn qx-btn--danger">Confirm Uninstall</button>
                                    <button onClick={() => setConfirmUninstall(false)} className="qx-btn qx-btn--ghost">Cancel</button>
                                </span>
                            ) : (
                                <button
                                    onClick={isInstalled ? () => setConfirmUninstall(true) : handleInstall}
                                    className={`qx-btn ${isInstalled ? 'qx-btn--danger' : 'qx-btn--success'}`}
                                >
                                    {isInstalled ? 'Uninstall' : 'Install Free'}
                                </button>
                            )
                        )}
                        {listing.price_model !== 'free' && (
                            <div style={{ color: '#f59e0b', fontSize: '1.2rem', fontWeight: 700 }}>
                                £{(listing.price_cents / 100).toFixed(2)}
                                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.7)', fontWeight: 400 }}>Coming soon</div>
                            </div>
                        )}
                    </div>
                </div>
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

            {/* Stats bar */}
            <div className="qx-card" style={{ display: 'flex', gap: '2rem', marginBottom: '1.5rem' }}>
                <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
                    <strong style={{ color: '#fff' }}>{stats.install_count || 0}</strong> installs
                </span>
                <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
                    <strong style={{ color: '#fff' }}>{stats.review_count || 0}</strong> reviews
                </span>
                {stats.average_rating > 0 && (
                    <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
                        <strong style={{ color: '#f59e0b' }}>{'★'.repeat(Math.round(stats.average_rating))}</strong>
                        {' '}{stats.average_rating.toFixed(1)}
                    </span>
                )}
                {latestApproved && (
                    <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
                        v<strong style={{ color: '#fff' }}>{latestApproved.version}</strong>
                    </span>
                )}
            </div>

            {/* Description */}
            {listing.description && (
                <div style={{ marginBottom: '2rem' }}>
                    <h2 style={{ color: '#fff', fontSize: '1rem', margin: '0 0 8px' }}>Description</h2>
                    <p style={{ color: 'rgba(255,255,255,0.85)', lineHeight: 1.7, whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
                        {listing.description}
                    </p>
                </div>
            )}

            {/* Version History */}
            {versions.length > 0 && (
                <div style={{ marginBottom: '2rem' }}>
                    <h2 style={{ color: '#fff', fontSize: '1rem', margin: '0 0 8px' }}>Versions</h2>
                    {versions.filter(v => v.review_status === 'approved').map(v => (
                        <div key={v.id} style={{
                            display: 'flex', justifyContent: 'space-between', padding: '8px 0',
                            borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: '0.85rem'
                        }}>
                            <span style={{ color: '#22c55e', fontFamily: 'monospace' }}>v{v.version}</span>
                            <span style={{ color: 'rgba(255,255,255,0.7)' }}>{new Date(v.created_at).toLocaleDateString()}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Reviews */}
            <div style={{ marginBottom: '2rem' }}>
                <h2 style={{ color: '#fff', fontSize: '1rem', margin: '0 0 12px' }}>
                    Reviews ({reviews.length})
                </h2>

                {reviews.map(review => (
                    <div key={review.id} style={{
                        padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.06)'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 500 }}>
                                {review.reviewer_name || 'User'}
                            </span>
                            <span style={{ color: '#f59e0b', fontSize: '0.8rem' }}>
                                {'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}
                            </span>
                        </div>
                        {review.title && <p style={{ color: 'rgba(255,255,255,0.85)', fontSize: '0.85rem', fontWeight: 600, margin: '4px 0 2px' }}>{review.title}</p>}
                        {review.body && <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem', margin: 0, lineHeight: 1.5 }}>{review.body}</p>}
                    </div>
                ))}

                {/* Review form */}
                {!alreadyReviewed && !isOwnListing && user && (
                    <form onSubmit={handleSubmitReview} className="qx-card" style={{ marginTop: '1rem' }}>
                        <h3 style={{ color: '#fff', fontSize: '0.9rem', margin: '0 0 10px' }}>Leave a review</h3>
                        <div style={{ display: 'flex', gap: '4px', marginBottom: 8 }}>
                            {[1, 2, 3, 4, 5].map(n => (
                                <button key={n} type="button" onClick={() => setReviewRating(n)}
                                    aria-label={`Rate ${n} star${n > 1 ? 's' : ''}`}
                                    style={{
                                    background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem',
                                    color: n <= reviewRating ? '#f59e0b' : 'rgba(255,255,255,0.3)'
                                }}>★</button>
                            ))}
                        </div>
                        <input type="text" placeholder="Title (optional)" value={reviewTitle}
                            onChange={e => setReviewTitle(e.target.value)}
                            className="qx-input" style={{ marginBottom: 6 }} />
                        <textarea placeholder="Your review..." value={reviewBody} rows={3}
                            onChange={e => setReviewBody(e.target.value)}
                            className="qx-textarea" style={{ marginBottom: 8 }} />
                        <button type="submit" disabled={reviewSubmitting} className="qx-btn qx-btn--primary qx-btn--sm">
                            {reviewSubmitting ? 'Submitting...' : 'Submit Review'}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}

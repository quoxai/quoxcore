/**
 * Manage Listing View
 * Dashboard page for managing a specific listing (edit, upload versions, view review status)
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

const REVIEW_COLOURS = {
    pending: '#71717a',
    automated_passed: '#3b82f6',
    automated_failed: '#ef4444',
    approved: '#22c55e',
    rejected: '#ef4444',
    changes_requested: '#f59e0b',
    yanked: '#52525b',
};

export default function ManageListing() {
    const { id } = useParams();
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const navigate = useNavigate();
    const fileInputRef = useRef(null);

    const [listing, setListing] = useState(null);
    const [versions, setVersions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploadVersion, setUploadVersion] = useState('');
    const [uploadChangelog, setUploadChangelog] = useState('');
    const [uploading, setUploading] = useState(false);
    const [uploadResult, setUploadResult] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!currentOrg?.id || !id) return;
        loadListing();
    }, [currentOrg?.id, id]);

    async function loadListing() {
        setLoading(true);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/listings/${id}`);
            if (!res.ok) { navigate('/seller'); return; }
            const data = await res.json();
            setListing(data.listing);
            setVersions(data.versions || []);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    async function handleUploadVersion(e) {
        e.preventDefault();
        if (!fileInputRef.current?.files?.[0]) { setError('Select a .quoxplugin file'); return; }
        if (!uploadVersion) { setError('Version is required'); return; }

        setUploading(true);
        setError(null);
        setUploadResult(null);

        try {
            const formData = new FormData();
            formData.append('package', fileInputRef.current.files[0]);
            formData.append('version', uploadVersion);
            formData.append('changelog', uploadChangelog);

            const res = await authFetch(`/api/orgs/${currentOrg.id}/listings/${id}/versions`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (!res.ok) { setError(data.message || 'Upload failed'); return; }

            setUploadResult(data.gate);
            setUploadVersion('');
            setUploadChangelog('');
            fileInputRef.current.value = '';
            loadListing();
        } catch (err) {
            setError(err.message);
        } finally {
            setUploading(false);
        }
    }

    if (loading) return <div className="qx-view qx-empty"><p>Loading...</p></div>;
    if (!listing) return null;

    return (
        <div className="qx-view" style={{ padding: '2rem', maxWidth: 900 }}>
            <Link to="/seller" style={{ color: '#a78bfa', textDecoration: 'none', fontSize: '0.9rem' }}>
                ← Back to Seller Dashboard
            </Link>

            <div style={{ marginTop: '1rem', marginBottom: '2rem' }}>
                <h1 style={{ color: '#fff', fontSize: '1.5rem', margin: '0 0 0.25rem' }}>{listing.title}</h1>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85rem' }}>{listing.product_type}</span>
                    <span className="qx-pill qx-pill--ghost qx-pill--sm">
                        {listing.status}
                    </span>
                    <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85rem' }}>
                        {listing.price_cents === 0 ? 'Free' : `£${(listing.price_cents / 100).toFixed(2)}`}
                    </span>
                </div>
                {listing.description && (
                    <p style={{ color: 'rgba(255,255,255,0.7)', marginTop: '0.75rem', fontSize: '0.9rem', lineHeight: 1.6 }}>
                        {listing.description}
                    </p>
                )}
            </div>

            {/* Upload Version */}
            <div className="qx-card" style={{ marginBottom: '2rem' }}>
                <h2 style={{ color: '#fff', fontSize: '1.1rem', margin: '0 0 1rem' }}>Upload Version</h2>

                {error && (
                    <div className="qx-banner qx-banner--error" style={{ marginBottom: '0.75rem' }}>
                        {error}
                    </div>
                )}

                <form onSubmit={handleUploadVersion} className="qx-stack qx-stack--tight">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                        <input
                            type="text" placeholder="1.0.0" required
                            pattern="\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?"
                            value={uploadVersion} onChange={e => setUploadVersion(e.target.value)}
                            className="qx-input"
                        />
                        <input
                            type="file" ref={fileInputRef}
                            accept=".quoxplugin,.zip"
                            className="qx-input"
                            style={{ padding: '0.4rem' }}
                        />
                    </div>
                    <input
                        type="text" placeholder="Changelog (optional)"
                        value={uploadChangelog} onChange={e => setUploadChangelog(e.target.value)}
                        className="qx-input"
                    />
                    <button
                        type="submit" disabled={uploading}
                        className="qx-btn qx-btn--primary"
                        style={{ alignSelf: 'flex-start' }}
                    >
                        {uploading ? 'Uploading...' : 'Upload & Run Checks'}
                    </button>
                </form>

                {/* Gate Result */}
                {uploadResult && (
                    <div style={{ marginTop: '1rem' }}>
                        <div style={{
                            fontWeight: 600, fontSize: '0.9rem',
                            color: uploadResult.passed ? '#22c55e' : '#ef4444',
                            marginBottom: '0.5rem'
                        }}>
                            {uploadResult.passed ? '✓ Automated checks passed' : '✕ Automated checks failed'}
                        </div>
                        {uploadResult.checks?.map((check, i) => (
                            <div key={i} style={{
                                display: 'flex', gap: '0.5rem', fontSize: '0.8rem',
                                padding: '0.2rem 0', color: 'rgba(255,255,255,0.7)'
                            }}>
                                <span style={{ color: check.passed ? '#22c55e' : '#ef4444' }}>
                                    {check.passed ? '✓' : '✕'}
                                </span>
                                <span>{check.name}:</span>
                                <span style={{ color: 'rgba(255,255,255,0.7)' }}>{check.message}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Versions */}
            <div>
                <h2 style={{ color: '#fff', fontSize: '1.1rem', margin: '0 0 1rem' }}>
                    Versions ({versions.length})
                </h2>
                {versions.length === 0 ? (
                    <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.9rem' }}>No versions uploaded yet.</p>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {versions.map(v => (
                            <div key={v.id} className="qx-card qx-card--compact" style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                            }}>
                                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                                    <span style={{ color: '#fff', fontWeight: 500, fontSize: '0.9rem' }}>
                                        v{v.version}
                                    </span>
                                    {v.changelog && (
                                        <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem' }}>
                                            {v.changelog.slice(0, 60)}
                                        </span>
                                    )}
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    <span
                                        className="qx-pill qx-pill--sm"
                                        style={{
                                            background: `${REVIEW_COLOURS[v.review_status] || '#71717a'}22`,
                                            color: REVIEW_COLOURS[v.review_status] || '#71717a'
                                        }}
                                    >
                                        {v.review_status}
                                    </span>
                                    <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.75rem' }}>
                                        {new Date(v.created_at).toLocaleDateString()}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Submit Listing View
 * Dashboard page for creating a new marketplace listing
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

const PRODUCT_TYPES = [
    { value: 'plugin', label: 'Plugin' },
    { value: 'workflow', label: 'Workflow' },
    { value: 'agent', label: 'Agent' },
    { value: 'agent_team', label: 'Agent Team' },
    { value: 'community', label: 'Community' },
];

const PRICE_MODELS = [
    { value: 'free', label: 'Free' },
    { value: 'one_time', label: 'One-time Purchase' },
    { value: 'subscription_monthly', label: 'Monthly Subscription' },
    { value: 'subscription_yearly', label: 'Yearly Subscription' },
];

export default function SubmitListing() {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const navigate = useNavigate();
    const [form, setForm] = useState({
        title: '', description: '', product_type: 'plugin',
        price_model: 'free', price_cents: 0, category: '', tags: ''
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    async function handleSubmit(e) {
        e.preventDefault();
        if (!currentOrg?.id) { setError('No organisation selected'); return; }
        setLoading(true);
        setError(null);

        try {
            const body = {
                ...form,
                price_cents: parseInt(form.price_cents) || 0,
                tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : []
            };

            const res = await authFetch(`/api/orgs/${currentOrg.id}/listings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) { setError(data.message || 'Failed to create listing'); return; }
            navigate(`/seller/listings/${data.listing.id}`);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    const update = (field, value) => setForm(f => ({ ...f, [field]: value }));

    return (
        <div className="qx-view" style={{ maxWidth: 600, margin: '0 auto', padding: '2rem' }}>
            <h1 style={{ color: '#fff', fontSize: '1.5rem', marginBottom: '0.5rem' }}>
                New Listing
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '2rem', fontSize: '0.9rem' }}>
                Create a draft listing. You can upload a package and submit for review after creation.
            </p>

            {error && (
                <div className="qx-banner qx-banner--error" style={{ marginBottom: '1rem' }}>
                    {error}
                </div>
            )}

            <form onSubmit={handleSubmit} className="qx-stack">
                <label className="qx-field">
                    <span className="qx-field__label">Title *</span>
                    <input
                        type="text" required minLength={3} maxLength={200}
                        value={form.title} onChange={e => update('title', e.target.value)}
                        placeholder="My Plugin" className="qx-input"
                    />
                </label>

                <label className="qx-field">
                    <span className="qx-field__label">Description</span>
                    <textarea
                        value={form.description} onChange={e => update('description', e.target.value)}
                        placeholder="What does this do?" rows={4}
                        className="qx-textarea"
                    />
                </label>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <label className="qx-field">
                        <span className="qx-field__label">Product Type</span>
                        <select value={form.product_type} onChange={e => update('product_type', e.target.value)} className="qx-select">
                            {PRODUCT_TYPES.map(pt => <option key={pt.value} value={pt.value}>{pt.label}</option>)}
                        </select>
                    </label>

                    <label className="qx-field">
                        <span className="qx-field__label">Price Model</span>
                        <select value={form.price_model} onChange={e => update('price_model', e.target.value)} className="qx-select">
                            {PRICE_MODELS.map(pm => <option key={pm.value} value={pm.value}>{pm.label}</option>)}
                        </select>
                    </label>
                </div>

                {form.price_model !== 'free' && (
                    <label className="qx-field">
                        <span className="qx-field__label">Price (pence)</span>
                        <input
                            type="number" min={0}
                            value={form.price_cents} onChange={e => update('price_cents', e.target.value)}
                            placeholder="999" className="qx-input"
                        />
                        <span className="qx-field__hint">
                            Enter price in pence (e.g. 999 = £9.99)
                        </span>
                    </label>
                )}

                <label className="qx-field">
                    <span className="qx-field__label">Category</span>
                    <input
                        type="text" value={form.category}
                        onChange={e => update('category', e.target.value)}
                        placeholder="monitoring, security, etc." className="qx-input"
                    />
                </label>

                <label className="qx-field">
                    <span className="qx-field__label">Tags (comma separated)</span>
                    <input
                        type="text" value={form.tags}
                        onChange={e => update('tags', e.target.value)}
                        placeholder="docker, monitoring, alerts" className="qx-input"
                    />
                </label>

                <button
                    type="submit" disabled={loading}
                    className="qx-btn qx-btn--primary"
                    style={{ marginTop: '0.5rem', alignSelf: 'flex-start' }}
                >
                    {loading ? 'Creating...' : 'Create Draft Listing'}
                </button>
            </form>
        </div>
    );
}

/**
 * Seller Registration View
 * Dashboard page for registering an org as a marketplace seller
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

export default function SellerRegistration() {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const navigate = useNavigate();
    const [form, setForm] = useState({ display_name: '', github_username: '', bio: '', website: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    async function handleSubmit(e) {
        e.preventDefault();
        if (!currentOrg?.id) {
            setError('No organisation selected');
            return;
        }
        setLoading(true);
        setError(null);

        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/sellers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(form)
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || 'Registration failed');
                return;
            }
            navigate('/seller');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="qx-view" style={{ maxWidth: 600, margin: '0 auto', padding: '2rem' }}>
            <h1 style={{ color: '#fff', fontSize: '1.5rem', marginBottom: '0.5rem' }}>
                Register as Seller
            </h1>
            <p style={{ color: 'rgba(255,255,255,0.7)', marginBottom: '2rem' }}>
                Register your organisation on the Quox Marketplace to publish plugins, workflows, and agents.
            </p>

            {error && (
                <div className="qx-banner qx-banner--error" style={{ marginBottom: '1rem' }}>
                    {error}
                </div>
            )}

            <form onSubmit={handleSubmit} className="qx-stack">
                <label className="qx-field">
                    <span className="qx-field__label">Display Name *</span>
                    <input
                        type="text" required minLength={2} maxLength={100}
                        value={form.display_name}
                        onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                        placeholder="Your seller name"
                        className="qx-input"
                    />
                </label>

                <label className="qx-field">
                    <span className="qx-field__label">GitHub Username</span>
                    <input
                        type="text"
                        value={form.github_username}
                        onChange={e => setForm(f => ({ ...f, github_username: e.target.value }))}
                        placeholder="github-username"
                        className="qx-input"
                    />
                </label>

                <label className="qx-field">
                    <span className="qx-field__label">Bio</span>
                    <textarea
                        value={form.bio}
                        onChange={e => setForm(f => ({ ...f, bio: e.target.value }))}
                        placeholder="Tell us about your work..."
                        rows={4}
                        className="qx-textarea"
                    />
                </label>

                <label className="qx-field">
                    <span className="qx-field__label">Website</span>
                    <input
                        type="url"
                        value={form.website}
                        onChange={e => setForm(f => ({ ...f, website: e.target.value }))}
                        placeholder="https://example.com"
                        className="qx-input"
                    />
                </label>

                <button
                    type="submit" disabled={loading}
                    className="qx-btn qx-btn--primary"
                    style={{ marginTop: '0.5rem', alignSelf: 'flex-start' }}
                >
                    {loading ? 'Registering...' : 'Register as Seller'}
                </button>
            </form>
        </div>
    );
}

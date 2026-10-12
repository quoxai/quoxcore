/**
 * Org Selector Component
 * Dropdown to switch between organizations
 */

import { useState, useRef, useEffect } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import './workspace.css';

function OrgAvatar({ org }) {
    const [imgError, setImgError] = useState(false);
    const name = org?.name || '';
    const initials = name
        ? name.split(' ').filter(w => w.length > 0).map(w => w[0]).join('').slice(0, 2).toUpperCase()
        : 'O';

    return (
        <div className="org-avatar">
            {org?.logo_url && !imgError ? (
                <img src={org.logo_url} alt={name} onError={() => setImgError(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
            ) : (
                initials || 'O'
            )}
        </div>
    );
}

function CreateOrgModal({ isOpen, onClose, onCreated }) {
    const { authFetch } = useAuth();
    const [name, setName] = useState('');
    const [slug, setSlug] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    // Auto-generate slug from name
    useEffect(() => {
        if (name) {
            setSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        }
    }, [name]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;

        setLoading(true);
        setError(null);

        try {
            const response = await authFetch('/api/orgs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), slug: slug.trim() || undefined })
            });

            if (response.ok) {
                const data = await response.json();
                // Backend returns organization (not org)
                const newOrg = data.organization || data.org;
                onCreated(newOrg);
                setName('');
                setSlug('');
                onClose();
            } else {
                const data = await response.json();
                setError(data.error || 'Failed to create organization');
            }
        } catch (err) {
            setError('Failed to create organization: ' + err.message);
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="org-modal-overlay" onClick={onClose}>
            <div className="org-modal" onClick={(e) => e.stopPropagation()}>
                <div className="org-modal-header">
                    <h3>Create Organization</h3>
                    <button className="org-modal-close" onClick={onClose}>x</button>
                </div>
                <form onSubmit={handleSubmit}>
                    <div className="org-modal-body">
                        {error && (
                            <div className="org-modal-error">{error}</div>
                        )}
                        <div className="org-modal-field">
                            <label>Organization Name</label>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="My Organization"
                                required
                                autoFocus
                            />
                        </div>
                        <div className="org-modal-field">
                            <label>Slug (URL identifier)</label>
                            <input
                                type="text"
                                value={slug}
                                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                placeholder="my-organization"
                            />
                            <small>Used in URLs and API calls</small>
                        </div>
                    </div>
                    <div className="org-modal-footer">
                        <button type="button" className="btn btn-secondary" onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn btn-primary" disabled={loading || !name.trim()}>
                            {loading ? 'Creating...' : 'Create Organization'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default function OrgSelector() {
    const { orgs, currentOrg, selectOrg, reloadOrgs } = useWorkspace();
    const [isOpen, setIsOpen] = useState(false);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const dropdownRef = useRef(null);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Listen for createOrg event from WorkspaceOverview
    useEffect(() => {
        const handleCreateOrg = () => {
            setShowCreateModal(true);
        };

        window.addEventListener('createOrg', handleCreateOrg);
        return () => window.removeEventListener('createOrg', handleCreateOrg);
    }, []);

    const handleSelect = async (org) => {
        // Close the dropdown immediately so the user gets feedback that the
        // click registered. If the switch fails, surface the error inline —
        // previously this fire-and-forget swallowed the rejection silently
        // and the user would think they'd switched when they hadn't.
        setIsOpen(false);
        try {
            await selectOrg(org);
        } catch (err) {
            console.error('[OrgSelector] Failed to switch organization:', err);
            // Reopen the dropdown so the user can retry / pick another org.
            setIsOpen(true);
            // eslint-disable-next-line no-alert
            alert(`Couldn't switch to "${org?.name || org?.id}":\n${err?.message || 'Unknown error'}\n\nThe page may need a hard refresh: Cmd/Ctrl + Shift + R.`);
        }
    };

    const handleOrgCreated = async (newOrg) => {
        // Reload org list to include the new org
        if (reloadOrgs) {
            await reloadOrgs();
        }
        // Select the newly created org
        selectOrg(newOrg);
    };

    const handleCreateClick = () => {
        setIsOpen(false);
        setShowCreateModal(true);
    };

    // Show create button if no orgs exist
    if (orgs.length === 0) {
        return (
            <>
                <div className="org-selector">
                    <button
                        className="org-selector-trigger"
                        onClick={() => setShowCreateModal(true)}
                        style={{ justifyContent: 'center' }}
                    >
                        <span style={{ color: '#4ecdc4' }}>+ Create Organization</span>
                    </button>
                </div>
                <CreateOrgModal
                    isOpen={showCreateModal}
                    onClose={() => setShowCreateModal(false)}
                    onCreated={handleOrgCreated}
                />
            </>
        );
    }

    return (
        <>
            <div className="org-selector" ref={dropdownRef}>
                <button
                    className="org-selector-trigger"
                    onClick={() => setIsOpen(!isOpen)}
                >
                    {currentOrg ? (
                        <>
                            <OrgAvatar org={currentOrg} />
                            <div className="org-selector-info">
                                <span className="org-name">{currentOrg.name}</span>
                                <span className="org-role">{currentOrg.membership?.role}</span>
                            </div>
                        </>
                    ) : (
                        <span className="org-placeholder">Select organization...</span>
                    )}
                    <span className="org-selector-arrow">{isOpen ? '^' : 'v'}</span>
                </button>

                {isOpen && (
                    <div className="org-selector-dropdown">
                        <div className="org-selector-header">
                            <span>ORGANIZATIONS</span>
                        </div>
                        <div className="org-selector-list">
                            {orgs.map(org => (
                                <button
                                    key={org.id}
                                    className={`org-selector-item ${currentOrg?.id === org.id ? 'selected' : ''}`}
                                    onClick={() => handleSelect(org)}
                                >
                                    <OrgAvatar org={org} />
                                    <div className="org-item-info">
                                        <span className="org-name">{org.name}</span>
                                        <span className="org-role">{org.membership?.role}</span>
                                    </div>
                                    {currentOrg?.id === org.id && (
                                        <span className="org-check">*</span>
                                    )}
                                </button>
                            ))}
                        </div>
                        <div className="org-selector-footer">
                            <button className="org-create-btn" onClick={handleCreateClick}>
                                + Create Organization
                            </button>
                        </div>
                    </div>
                )}
            </div>
            <CreateOrgModal
                isOpen={showCreateModal}
                onClose={() => setShowCreateModal(false)}
                onCreated={handleOrgCreated}
            />
        </>
    );
}

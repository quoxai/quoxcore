/**
 * TagsView - Tag Management for Active Organisation
 *
 * Lists, creates, edits, and deletes tags used for categorizing
 * inbox items, workflows, agents, and other assets.
 */

import { useState, useEffect, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useAuth } from '../../contexts/AuthContext';
import { PageSection } from '../../components/layout';
import Button from '../../components/ui/Button';
import './views.css';

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

const TagIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
        <line x1="7" y1="7" x2="7.01" y2="7"/>
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
);

function TagsView() {
    const { setPageActions } = useOutletContext() || {};
    const { currentOrg, isOrgAdmin } = useWorkspace();
    const { authFetch } = useAuth();

    const [tags, setTags] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [newTagName, setNewTagName] = useState('');
    const [newTagColor, setNewTagColor] = useState('#8b5cf6');
    const [creating, setCreating] = useState(false);
    const [showCreate, setShowCreate] = useState(false);

    const loadTags = useCallback(async () => {
        if (!currentOrg?.id) { setLoading(false); return; }
        setLoading(true);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/tags?include_counts=true`);
            if (res.ok) {
                const data = await res.json();
                setTags(data.tags || []);
            } else {
                setError('Failed to load tags');
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [currentOrg?.id, authFetch]);

    useEffect(() => { loadTags(); }, [loadTags]);

    useEffect(() => {
        setPageActions?.(isOrgAdmin ? (
            <Button variant="primary" onClick={() => setShowCreate(true)}>
                <PlusIcon />
                <span style={{ marginLeft: '8px' }}>Create Tag</span>
            </Button>
        ) : null);
        return () => setPageActions?.(null);
    }, [setPageActions, isOrgAdmin]);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!newTagName.trim() || !currentOrg?.id) return;
        setCreating(true);
        try {
            const res = await authFetch(`/api/orgs/${currentOrg.id}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
            });
            if (res.ok) {
                setNewTagName('');
                setShowCreate(false);
                loadTags();
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (tagId) => {
        if (!currentOrg?.id) return;
        try {
            await authFetch(`/api/orgs/${currentOrg.id}/tags/${tagId}`, { method: 'DELETE' });
            loadTags();
        } catch (err) {
            setError(err.message);
        }
    };

    if (!currentOrg) {
        return (
            <PageSection>
                <div className="empty-state">
                    <p>Select an organisation to manage tags.</p>
                </div>
            </PageSection>
        );
    }

    return (
        <PageSection>
            {error && (
                <div style={{ color: '#f87171', marginBottom: '16px', fontSize: '0.85rem' }}>
                    {error}
                </div>
            )}

            {showCreate && (
                <form onSubmit={handleCreate} style={{
                    display: 'flex', gap: '12px', alignItems: 'center',
                    marginBottom: '20px', padding: '16px',
                    background: 'rgba(255,255,255,0.03)', borderRadius: '10px',
                    border: '1px solid rgba(255,255,255,0.06)',
                }}>
                    <input
                        type="color"
                        value={newTagColor}
                        onChange={e => setNewTagColor(e.target.value)}
                        style={{ width: '32px', height: '32px', border: 'none', background: 'none', cursor: 'pointer' }}
                    />
                    <input
                        type="text"
                        value={newTagName}
                        onChange={e => setNewTagName(e.target.value)}
                        placeholder="Tag name..."
                        autoFocus
                        style={{
                            flex: 1, padding: '8px 12px', background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px',
                            color: '#fff', fontSize: '0.85rem',
                        }}
                    />
                    <Button variant="primary" type="submit" disabled={creating || !newTagName.trim()}>
                        {creating ? 'Creating...' : 'Create'}
                    </Button>
                    <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
                </form>
            )}

            {loading ? (
                <div style={{ color: 'rgba(255,255,255,0.5)', padding: '40px', textAlign: 'center' }}>
                    Loading tags...
                </div>
            ) : tags.length === 0 ? (
                <div className="empty-state" style={{ textAlign: 'center', padding: '60px 20px' }}>
                    <TagIcon />
                    <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: '12px' }}>No tags yet.</p>
                    {isOrgAdmin && (
                        <Button variant="primary" onClick={() => setShowCreate(true)} style={{ marginTop: '16px' }}>
                            Create your first tag
                        </Button>
                    )}
                </div>
            ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                    {tags.map(tag => (
                        <div
                            key={tag.id}
                            style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '8px 14px',
                                background: `${tag.color || '#8b5cf6'}12`,
                                border: `1px solid ${tag.color || '#8b5cf6'}30`,
                                borderRadius: '8px',
                            }}
                        >
                            <span style={{
                                width: '10px', height: '10px', borderRadius: '50%',
                                background: tag.color || '#8b5cf6',
                            }} />
                            <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.85rem', fontWeight: 500 }}>
                                {tag.name}
                            </span>
                            {tag.total_usage > 0 && (
                                <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem' }}>
                                    ({tag.total_usage})
                                </span>
                            )}
                            {isOrgAdmin && (
                                <button
                                    onClick={() => handleDelete(tag.id)}
                                    title="Delete tag"
                                    style={{
                                        background: 'none', border: 'none', cursor: 'pointer',
                                        color: 'rgba(255,255,255,0.3)', padding: '2px',
                                    }}
                                >
                                    <TrashIcon />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </PageSection>
    );
}

export default TagsView;

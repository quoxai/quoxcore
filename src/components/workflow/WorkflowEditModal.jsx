/**
 * WorkflowEditModal - Edit workflow metadata (name, description, scope, tags)
 *
 * Scope is assigned via cascading org > division > department picker.
 * Changing org fetches scopes for the new org via onLoadScopes callback.
 */

import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Input, Textarea } from '../ui/Input';
import { ScopeFilterCascade } from '../scope';

// Icons
const EditIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
);

export default function WorkflowEditModal({
    isOpen,
    onClose,
    onSubmit,
    workflow = null,
    scopes = [],        // Available scopes from WorkspaceContext (myScopes)
    orgs = [],           // All orgs the user belongs to
    currentOrg = null,   // Currently selected org
    onLoadScopes,        // async (orgId) => scopesArray — fetches scopes for an org
    loading = false
}) {
    // Form state
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        notes: '',
        home_scope_id: null,
        tags: '',
    });
    const [errors, setErrors] = useState({});

    // Modal-local org and scopes (so changing org doesn't affect the main view)
    const [modalOrg, setModalOrg] = useState(null);
    const [modalScopes, setModalScopes] = useState([]);
    const [scopesLoading, setScopesLoading] = useState(false);

    // Reset form when modal opens or workflow changes
    useEffect(() => {
        if (isOpen && workflow) {
            const tags = workflow.tags || workflow.metadata?.tags || [];
            setFormData({
                name: workflow.name || '',
                description: workflow.description || '',
                notes: workflow.notes || '',
                home_scope_id: workflow.home_scope_id || null,
                tags: Array.isArray(tags)
                    ? tags.map(t => typeof t === 'string' ? t : t.name || '').filter(Boolean).join(', ')
                    : '',
            });
            setErrors({});
            setModalOrg(currentOrg);
            setModalScopes(scopes);
        }
    }, [isOpen, workflow?.id]);

    const handleChange = (field, value) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        if (errors[field]) {
            setErrors(prev => ({ ...prev, [field]: null }));
        }
    };

    const handleOrgChange = async (org) => {
        setModalOrg(org);
        handleChange('home_scope_id', null);

        if (onLoadScopes && org?.id) {
            setScopesLoading(true);
            try {
                const newScopes = await onLoadScopes(org.id);
                setModalScopes(newScopes || []);
            } catch (err) {
                console.error('[WorkflowEditModal] Failed to load scopes for org:', err);
                setModalScopes([]);
            } finally {
                setScopesLoading(false);
            }
        }
    };

    const validate = () => {
        const newErrors = {};
        if (!formData.name?.trim()) {
            newErrors.name = 'Name is required';
        } else if (formData.name.length > 128) {
            newErrors.name = 'Name must be less than 128 characters';
        }
        if (formData.description && formData.description.length > 1000) {
            newErrors.description = 'Description must be less than 1000 characters';
        }
        if (formData.notes && formData.notes.length > 5000) {
            newErrors.notes = 'Notes must be less than 5000 characters';
        }
        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!validate()) return;

        // Parse tags from comma-separated string
        const parsedTags = formData.tags
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);

        // Derive scope type from the selected scope entity
        const selectedScope = modalScopes.find(s => s.id === formData.home_scope_id);
        const scopeType = selectedScope?.scope_type || 'org';

        try {
            await onSubmit({
                name: formData.name.trim(),
                description: formData.description.trim(),
                notes: formData.notes.trim(),
                scope: scopeType,
                home_scope_id: formData.home_scope_id,
                org_id: modalOrg?.id,
                tags: parsedTags,
            });
        } catch (err) {
            setErrors({ submit: err.message || 'Failed to save changes' });
        }
    };

    const handleClose = () => {
        if (!loading) {
            onClose();
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            size="md"
            closeOnOverlay={!loading}
            closeOnEscape={!loading}
        >
            <Modal.Header
                title="Edit Workflow"
                description={workflow?.name ? `Editing "${workflow.name}"` : 'Update workflow details'}
                icon={<EditIcon />}
                onClose={!loading ? handleClose : undefined}
            />

            <form onSubmit={handleSubmit}>
                <Modal.Body>
                    {errors.submit && (
                        <div style={{
                            padding: '0.75rem 1rem',
                            background: 'rgba(239, 68, 68, 0.08)',
                            borderRadius: '8px',
                            borderLeft: '3px solid var(--color-danger, #ef4444)',
                            fontSize: '0.8rem',
                            color: 'var(--color-danger, #ef4444)',
                            marginBottom: '1rem'
                        }}>
                            {errors.submit}
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                        {/* Name */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label" htmlFor="wf-edit-name">
                                Name *
                            </label>
                            <Input
                                id="wf-edit-name"
                                value={formData.name}
                                onChange={(e) => handleChange('name', e.target.value)}
                                placeholder="Workflow name"
                                error={!!errors.name}
                                autoFocus
                                disabled={loading}
                            />
                            {errors.name && (
                                <span className="agent-config-field__error">{errors.name}</span>
                            )}
                        </div>

                        {/* Description */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label" htmlFor="wf-edit-desc">
                                Description
                            </label>
                            <Textarea
                                id="wf-edit-desc"
                                value={formData.description}
                                onChange={(e) => handleChange('description', e.target.value)}
                                placeholder="What does this workflow do?"
                                rows={3}
                                disabled={loading}
                            />
                            {errors.description && (
                                <span className="agent-config-field__error">{errors.description}</span>
                            )}
                        </div>

                        {/* Notes */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label" htmlFor="wf-edit-notes">
                                Notes
                            </label>
                            <Textarea
                                id="wf-edit-notes"
                                value={formData.notes}
                                onChange={(e) => handleChange('notes', e.target.value)}
                                placeholder="Longer explanation of how this workflow works, what it does, and any operational details..."
                                rows={5}
                                disabled={loading}
                            />
                            <span className="agent-config-field__hint">
                                Detailed explanation visible on the workflow detail page ({formData.notes.length}/5000)
                            </span>
                            {errors.notes && (
                                <span className="agent-config-field__error">{errors.notes}</span>
                            )}
                        </div>

                        {/* Scope — cascading org > division > department picker */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label">
                                Belongs to
                            </label>
                            <ScopeFilterCascade
                                orgs={orgs}
                                currentOrg={modalOrg}
                                onOrgChange={handleOrgChange}
                                scopes={scopesLoading ? [] : modalScopes}
                                currentScope={modalScopes.find(s => s.id === formData.home_scope_id)}
                                onScopeChange={(scope) => handleChange('home_scope_id', scope?.id || null)}
                                mode="filter"
                                placeholder="Organisation-wide"
                            />
                            {scopesLoading && (
                                <span className="agent-config-field__hint" style={{ color: 'var(--text-muted)' }}>
                                    Loading scopes...
                                </span>
                            )}
                            <span className="agent-config-field__hint">
                                Which organisation, division, department, or team owns this workflow
                            </span>
                        </div>

                        {/* Tags */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label" htmlFor="wf-edit-tags">
                                Tags
                            </label>
                            <Input
                                id="wf-edit-tags"
                                value={formData.tags}
                                onChange={(e) => handleChange('tags', e.target.value)}
                                placeholder="e.g., backup, monitoring, daily"
                                disabled={loading}
                            />
                            <span className="agent-config-field__hint">
                                Comma-separated tags for filtering and organisation
                            </span>
                        </div>
                    </div>
                </Modal.Body>

                <Modal.Footer>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={handleClose}
                        disabled={loading}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        loading={loading}
                        style={{ marginLeft: 'auto' }}
                    >
                        {loading ? 'Saving...' : 'Save Changes'}
                    </Button>
                </Modal.Footer>
            </form>
        </Modal>
    );
}

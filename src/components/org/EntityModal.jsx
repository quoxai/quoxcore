/**
 * EntityModal - Unified Create/Edit Modal
 *
 * Reusable modal for creating and editing organizations, divisions, teams.
 * Supports custom fields, validation, and logo upload for organizations.
 */

import { useState, useEffect, useRef } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Input } from '../ui/Input';
import './org-components.css';

// Icons
const CameraIcon = () => (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
    </svg>
);

const OrgIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/>
    </svg>
);

const DivisionIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
);

const TeamIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
);

function EntityModal({
    isOpen,
    onClose,
    onSubmit,
    title = 'Create',
    submitLabel = 'Create',
    entityType = 'entity',  // 'org' | 'division' | 'team' | 'department'
    initialData = null,
    parentName,            // e.g., "Creating division in Engineering"
    loading = false,
    fields = null          // Custom field definitions, or use defaults
}) {
    const [formData, setFormData] = useState({
        name: '',
        description: ''
    });
    const [logoFile, setLogoFile] = useState(null);
    const [logoPreview, setLogoPreview] = useState(null);
    const [errors, setErrors] = useState({});
    const fileInputRef = useRef(null);

    // Reset form when modal opens or initialData changes
    useEffect(() => {
        if (isOpen) {
            setFormData(initialData || { name: '', description: '' });
            setLogoFile(null);
            setLogoPreview(initialData?.logo_url || null);
            setErrors({});
        }
    }, [isOpen, initialData]);

    if (!isOpen) return null;

    const handleChange = (field, value) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        // Clear error on change
        if (errors[field]) {
            setErrors(prev => ({ ...prev, [field]: null }));
        }
    };

    const handleLogoSelect = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (!allowedTypes.includes(file.type)) {
            setErrors(prev => ({ ...prev, logo: 'Please select a JPG, PNG, GIF, WebP, or SVG image.' }));
            return;
        }

        // Validate file size (2MB max)
        if (file.size > 2 * 1024 * 1024) {
            setErrors(prev => ({ ...prev, logo: 'Image must be less than 2MB.' }));
            return;
        }

        setLogoFile(file);
        setErrors(prev => ({ ...prev, logo: null }));

        // Create preview
        const reader = new FileReader();
        reader.onload = (e) => {
            setLogoPreview(e.target.result);
        };
        reader.readAsDataURL(file);
    };

    const handleRemoveLogo = () => {
        setLogoFile(null);
        setLogoPreview(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const validate = () => {
        const newErrors = {};
        if (!formData.name?.trim()) {
            newErrors.name = 'Name is required';
        } else if (formData.name.length < 2) {
            newErrors.name = 'Name must be at least 2 characters';
        } else if (formData.name.length > 100) {
            newErrors.name = 'Name must be less than 100 characters';
        }
        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!validate()) return;

        try {
            // Include logo file in submission if present
            await onSubmit({ ...formData, logoFile });
        } catch (err) {
            setErrors({ submit: err.message });
        }
    };

    // Entity type specific placeholders and icons
    const entityConfig = {
        org: {
            name: 'My Organisation',
            description: 'What does this organisation do?',
            icon: <OrgIcon />
        },
        division: {
            name: 'Engineering, Sales, etc.',
            description: 'What does this division handle?',
            icon: <DivisionIcon />
        },
        team: {
            name: 'Frontend Team, DevOps, etc.',
            description: 'What does this team work on?',
            icon: <TeamIcon />
        },
        department: {
            name: 'Research, Support, etc.',
            description: 'What does this department handle?',
            icon: <DivisionIcon />
        }
    };

    const config = entityConfig[entityType] || entityConfig.org;
    const showLogoUpload = entityType === 'org';

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <Modal.Header
                title={title}
                icon={config.icon}
                onClose={onClose}
            />

            <form onSubmit={handleSubmit}>
                <Modal.Body>
                    {parentName && (
                        <p className="entity-parent-context">
                            Creating in <strong>{parentName}</strong>
                        </p>
                    )}

                    {errors.submit && (
                        <div className="entity-error-alert">
                            {errors.submit}
                        </div>
                    )}

                    {/* Logo upload for organizations */}
                    {showLogoUpload && (
                        <div className="entity-form-field">
                            <label className="entity-form-field__label">Logo (optional)</label>
                            <div className="entity-logo-upload">
                                <div
                                    onClick={() => fileInputRef.current?.click()}
                                    className={`entity-logo-preview ${logoPreview ? 'entity-logo-preview--filled' : 'entity-logo-preview--empty'}`}
                                >
                                    {logoPreview ? (
                                        <img
                                            src={logoPreview}
                                            alt="Logo preview"
                                        />
                                    ) : (
                                        <CameraIcon />
                                    )}
                                </div>
                                <div className="entity-logo-actions">
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
                                        onChange={handleLogoSelect}
                                        style={{ display: 'none' }}
                                    />
                                    <div className="entity-logo-buttons">
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="secondary"
                                            onClick={() => fileInputRef.current?.click()}
                                        >
                                            {logoPreview ? 'Change' : 'Upload'}
                                        </Button>
                                        {logoPreview && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="ghost"
                                                onClick={handleRemoveLogo}
                                            >
                                                Remove
                                            </Button>
                                        )}
                                    </div>
                                    <span className="entity-form-field__hint">
                                        JPG, PNG, GIF, WebP or SVG. Max 2MB.
                                    </span>
                                    {errors.logo && (
                                        <span className="entity-form-field__error">
                                            {errors.logo}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="entity-form-field">
                        <label className="entity-form-field__label" htmlFor="entity-name">
                            Name *
                        </label>
                        <Input
                            id="entity-name"
                            value={formData.name}
                            onChange={(e) => handleChange('name', e.target.value)}
                            placeholder={config.name}
                            error={errors.name}
                            autoFocus
                            required
                        />
                        {errors.name && (
                            <span className="entity-form-field__error">
                                {errors.name}
                            </span>
                        )}
                    </div>

                    <div className="entity-form-field">
                        <label className="entity-form-field__label" htmlFor="entity-description">
                            Description
                        </label>
                        <Input
                            id="entity-description"
                            value={formData.description}
                            onChange={(e) => handleChange('description', e.target.value)}
                            placeholder={config.description}
                        />
                        <span className="entity-form-field__hint">
                            A brief description helps the AI assistant understand context.
                        </span>
                    </div>

                    {/* Custom fields */}
                    {fields && fields.map(field => (
                        <div key={field.name} className="entity-form-field">
                            <label className="entity-form-field__label" htmlFor={`entity-${field.name}`}>
                                {field.label} {field.required && '*'}
                            </label>
                            <Input
                                id={`entity-${field.name}`}
                                type={field.type || 'text'}
                                value={formData[field.name] || ''}
                                onChange={(e) => handleChange(field.name, e.target.value)}
                                placeholder={field.placeholder}
                                required={field.required}
                            />
                            {field.hint && (
                                <span className="entity-form-field__hint">{field.hint}</span>
                            )}
                        </div>
                    ))}
                </Modal.Body>

                <Modal.Footer>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        loading={loading}
                        style={{ marginLeft: 'auto' }}
                    >
                        {submitLabel}
                    </Button>
                </Modal.Footer>
            </form>
        </Modal>
    );
}

// Confirm dialog variant
export function ConfirmModal({
    isOpen,
    onClose,
    onConfirm,
    title = 'Confirm',
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
    loading = false
}) {
    if (!isOpen) return null;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="sm"
            severity={danger ? 'danger' : 'default'}
        >
            <Modal.Header
                title={title}
                onClose={onClose}
            />

            <Modal.Body>
                <p style={{
                    color: 'var(--ui-text-secondary, #a1a1aa)',
                    margin: 0,
                    lineHeight: 1.6,
                    fontSize: '14px'
                }}>
                    {message}
                </p>
            </Modal.Body>

            <Modal.Footer>
                <Button variant="ghost" onClick={onClose}>
                    {cancelLabel}
                </Button>
                <Button
                    variant={danger ? 'danger' : 'primary'}
                    onClick={onConfirm}
                    loading={loading}
                    style={{ marginLeft: 'auto' }}
                >
                    {confirmLabel}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

export default EntityModal;

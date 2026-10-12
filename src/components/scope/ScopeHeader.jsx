/**
 * ScopeHeader — Full-width banner header for scope dashboard pages.
 *
 * Renders avatar (logo for orgs, icon for divisions/departments),
 * title + role badge, breadcrumb, description, stats ribbon, and actions.
 * Admins can inline-edit the name and description.
 */

import { useState, useRef, useEffect } from 'react';
import Button from '../ui/Button';
import ScopeBadge from './ScopeBadge';
import './ScopeDashboard.css';

// Icons
const BackIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
    </svg>
);

const InviteIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="8.5" cy="7" r="4" />
        <line x1="20" y1="8" x2="20" y2="14" />
        <line x1="23" y1="11" x2="17" y2="11" />
    </svg>
);

const CameraIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
        <circle cx="12" cy="13" r="4" />
    </svg>
);

const EditIcon = () => (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
);

const CheckIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

const InboxIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
);

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);

const LayersIcon = () => (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
    </svg>
);

const HashIcon = () => (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
);

const SCOPE_ICONS = {
    org: null,       // uses logo/initials
    division: <LayersIcon />,
    department: <HashIcon />,
};

const BACK_ROUTES = {
    org: '/orgs',
    division: '/divisions',
    department: null,  // handled via parentEntity
};

export default function ScopeHeader({
    entityType,
    name,
    description,
    logoUrl,
    logoImgError,
    isAdmin,
    accentColour,
    parentEntity,
    entity,
    // Stats
    memberCount = 0,
    childCount = 0,
    departmentCount = 0,
    teamCount = 0,
    childLabel = 'Children',
    entityLabel = 'Entity',
    // Handlers
    onInviteMember,
    onViewInbox,
    onDelete,
    onAddChild,
    onBack,
    onLogoUpload,
    onLogoImgError,
    // Inline editing
    onNameChange,
    onDescriptionChange,
    hasChanges,
    saving,
    onSave,
    // Scope
    entityScopeId,
}) {
    const backRoute = BACK_ROUTES[entityType];
    const icon = SCOPE_ICONS[entityType];

    // Inline editing state
    const [editingName, setEditingName] = useState(false);
    const [editingDesc, setEditingDesc] = useState(false);
    const nameInputRef = useRef(null);
    const descInputRef = useRef(null);

    useEffect(() => {
        if (editingName && nameInputRef.current) {
            nameInputRef.current.focus();
            nameInputRef.current.select();
        }
    }, [editingName]);

    useEffect(() => {
        if (editingDesc && descInputRef.current) {
            descInputRef.current.focus();
            descInputRef.current.select();
        }
    }, [editingDesc]);

    const handleNameKeyDown = (e) => {
        if (e.key === 'Enter') { setEditingName(false); }
        if (e.key === 'Escape') { setEditingName(false); }
    };

    const handleDescKeyDown = (e) => {
        if (e.key === 'Enter') { setEditingDesc(false); }
        if (e.key === 'Escape') { setEditingDesc(false); }
    };

    return (
        <div className="scope-header" style={{ '--scope-accent': accentColour }}>
            <div className="scope-header__main">
                <div className="scope-header__identity">
                    {/* Avatar */}
                    <div className="scope-header__avatar">
                        {entityType === 'org' ? (
                            logoUrl && !logoImgError ? (
                                <img src={logoUrl} alt={name} onError={onLogoImgError} />
                            ) : (
                                <span className="scope-header__avatar-letter">
                                    {name?.[0]?.toUpperCase() || 'O'}
                                </span>
                            )
                        ) : (
                            <span className="scope-header__avatar-icon">{icon}</span>
                        )}
                        {entityType === 'org' && isAdmin && onLogoUpload && (
                            <button
                                className="scope-header__avatar-edit"
                                onClick={onLogoUpload}
                                title="Upload logo"
                            >
                                <CameraIcon />
                            </button>
                        )}
                    </div>

                    <div className="scope-header__info">
                        <div className="scope-header__title-row">
                            {/* Inline-editable name */}
                            {editingName && isAdmin && onNameChange ? (
                                <input
                                    ref={nameInputRef}
                                    className="scope-header__title-input"
                                    value={name}
                                    onChange={(e) => onNameChange(e.target.value)}
                                    onBlur={() => setEditingName(false)}
                                    onKeyDown={handleNameKeyDown}
                                    aria-label="Edit name"
                                />
                            ) : (
                                <h1
                                    className="scope-header__title"
                                    onClick={isAdmin && onNameChange ? () => setEditingName(true) : undefined}
                                    style={isAdmin && onNameChange ? { cursor: 'pointer' } : undefined}
                                    title={isAdmin ? 'Click to edit name' : undefined}
                                >
                                    {name}
                                    {isAdmin && onNameChange && (
                                        <span className="scope-header__edit-hint"><EditIcon /></span>
                                    )}
                                </h1>
                            )}
                            <span className={`scope-header__badge ${isAdmin ? 'scope-header__badge--admin' : ''}`}>
                                {isAdmin ? 'Admin' : 'Member'}
                            </span>
                        </div>

                        {/* Breadcrumb */}
                        {(parentEntity || entityType !== 'org') && (
                            <div className="scope-header__breadcrumb">
                                {entityType === 'division' && parentEntity && (
                                    <span>Division in <a href="#" onClick={(e) => { e.preventDefault(); onBack?.(); }}>{parentEntity.name}</a></span>
                                )}
                                {entityType === 'department' && parentEntity && (
                                    <span>Department in <a href="#" onClick={(e) => { e.preventDefault(); onBack?.(); }}>{parentEntity.name}</a></span>
                                )}
                            </div>
                        )}

                        {/* Inline-editable description */}
                        {editingDesc && isAdmin && onDescriptionChange ? (
                            <input
                                ref={descInputRef}
                                className="scope-header__desc-input"
                                value={description}
                                onChange={(e) => onDescriptionChange(e.target.value)}
                                onBlur={() => setEditingDesc(false)}
                                onKeyDown={handleDescKeyDown}
                                placeholder="Add a description..."
                                aria-label="Edit description"
                            />
                        ) : (
                            <p
                                className="scope-header__description"
                                onClick={isAdmin && onDescriptionChange ? () => setEditingDesc(true) : undefined}
                                style={isAdmin && onDescriptionChange ? { cursor: 'pointer' } : undefined}
                                title={isAdmin ? 'Click to edit description' : undefined}
                            >
                                {description || 'No description provided'}
                                {isAdmin && onDescriptionChange && (
                                    <span className="scope-header__edit-hint"><EditIcon /></span>
                                )}
                            </p>
                        )}

                        {/* Stats moved to ScopeHUD below the header */}
                    </div>
                </div>

                {/* Actions */}
                <div className="scope-header__actions">
                    {(backRoute || onBack) && (
                        <Button variant="ghost" onClick={onBack}>
                            <BackIcon />
                            <span style={{ marginLeft: '6px' }}>Back</span>
                        </Button>
                    )}
                    {isAdmin && hasChanges && onSave && (
                        <Button variant="secondary" onClick={onSave} loading={saving} size="sm">
                            <CheckIcon />
                            <span style={{ marginLeft: '4px' }}>Save</span>
                        </Button>
                    )}
                    {isAdmin && onAddChild && (
                        <Button variant="secondary" size="sm" onClick={onAddChild}>
                            <PlusIcon />
                            <span style={{ marginLeft: '6px' }}>Add {childLabel.replace(/s$/, '')}</span>
                        </Button>
                    )}
                    {onViewInbox && (
                        <Button
                            variant="secondary"
                            size="sm"
                            as="a"
                            href={entityScopeId ? `/inbox?scope=${entityScopeId}` : '/inbox'}
                        >
                            <InboxIcon />
                            <span style={{ marginLeft: '6px' }}>Inbox</span>
                        </Button>
                    )}
                    {isAdmin && onInviteMember && (
                        <Button variant="primary" onClick={onInviteMember} title="Invite a new member">
                            <InviteIcon />
                            <span style={{ marginLeft: '6px' }}>Invite</span>
                        </Button>
                    )}
                    {isAdmin && onDelete && (
                        <Button variant="danger" size="sm" onClick={onDelete} title={`Delete ${entityLabel}`}>
                            <TrashIcon />
                            <span style={{ marginLeft: '4px' }}>Delete</span>
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

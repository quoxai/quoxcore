/**
 * HeaderUserMenu (M-P5 profiles): the top-right profile slot.
 *
 * Avatar button in the global header opening a small glass profile menu:
 * identity (photo or monogram, name, email, org/mode), a link to settings,
 * a photo uploader, and sign out. Extracted from the inline block that
 * previously lived in AppShell.jsx so the shell stays lean and the menu
 * owns its open/close + upload state.
 *
 * Avatar source of truth: `users.avatar_url` (auth DB), served from the
 * static /uploads path and returned by GET /api/auth/me. Uploads go
 * through POST /api/uploads/me/avatar (multer, 2MB, images only); on
 * success `refreshUser()` re-fetches /me so the new photo appears
 * everywhere without a reload. The Matrix profile mirrors the same file
 * at the next Matrix login (matrixClient.syncProfileAvatar), which is
 * what puts the photo on Rooms people-panel and timeline rows.
 *
 * Styling: global app-shell.css classes only (header-user-*), no
 * per-component CSS file.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';

// Two-letter monogram fallback (same pattern as the Rooms people panel).
function monogram(user) {
    const source = user?.display_name || user?.email || '';
    const clean = source.split('@')[0];
    const parts = clean.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return clean.slice(0, 2).toUpperCase() || 'U';
}

function AvatarBadge({ user, className }) {
    const [imgFailed, setImgFailed] = useState(false);
    useEffect(() => { setImgFailed(false); }, [user?.avatar_url]);

    if (user?.avatar_url && !imgFailed) {
        return (
            <span className={className}>
                <img
                    src={user.avatar_url}
                    alt={user.display_name || user.email || 'User avatar'}
                    onError={() => setImgFailed(true)}
                />
            </span>
        );
    }
    return <span className={className}>{monogram(user)}</span>;
}

export default function HeaderUserMenu({ user, orgName, isDevMode, isPreview, onLogout }) {
    const navigate = useNavigate();
    const { authFetch, refreshUser } = useAuth();
    const [open, setOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState(null);
    const rootRef = useRef(null);
    const fileInputRef = useRef(null);

    // Close on outside click / Escape
    useEffect(() => {
        if (!open) return;
        const handleClick = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        };
        const handleKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [open]);

    const handleFileChosen = useCallback(async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setUploading(true);
        setUploadError(null);
        try {
            const formData = new FormData();
            formData.append('avatar', file, file.name || 'avatar');
            const res = await authFetch('/api/uploads/me/avatar', {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setUploadError(data.message || 'Upload failed');
                return;
            }
            await refreshUser?.();
        } catch {
            setUploadError('Upload failed, please try again');
        } finally {
            setUploading(false);
        }
    }, [authFetch, refreshUser]);

    const roleLine = isDevMode ? 'Dev Mode'
        : isPreview ? 'Preview Mode'
        : (orgName || 'No Organization');

    return (
        <div className="header-user-menu" ref={rootRef}>
            <button
                className="header-user-btn"
                onClick={() => setOpen(prev => !prev)}
                title={user?.display_name || user?.email || 'User'}
                aria-label="User menu"
                aria-haspopup="menu"
                aria-expanded={open}
            >
                <AvatarBadge user={user} className="header-user-avatar" />
            </button>
            {open && (
                <div className="header-user-dropdown" role="menu">
                    <div className="header-user-dropdown__identity">
                        <AvatarBadge user={user} className="header-user-dropdown__avatar" />
                        <div className="header-user-dropdown__info" style={{ padding: 0, minWidth: 0 }}>
                            <span className="header-user-dropdown__name">
                                {user?.display_name || user?.email?.split('@')[0] || 'User'}
                            </span>
                            {user?.email && (
                                <span className="header-user-dropdown__email">{user.email}</span>
                            )}
                            <span className="header-user-dropdown__role">{roleLine}</span>
                        </div>
                    </div>
                    <div className="header-user-dropdown__divider" />
                    <button
                        className="header-user-dropdown__item"
                        role="menuitem"
                        onClick={() => { setOpen(false); navigate('/settings'); }}
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                        Profile and settings
                    </button>
                    {!isPreview && !isDevMode && (
                        <button
                            className="header-user-dropdown__item"
                            role="menuitem"
                            disabled={uploading}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                                <circle cx="12" cy="13" r="4"/>
                            </svg>
                            {uploading ? 'Uploading photo...' : 'Change photo'}
                        </button>
                    )}
                    {uploadError && (
                        <div className="header-user-dropdown__error" role="alert">{uploadError}</div>
                    )}
                    {!isPreview && (
                        <button
                            className="header-user-dropdown__item"
                            role="menuitem"
                            onClick={() => { setOpen(false); onLogout?.(); }}
                        >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                                <polyline points="16 17 21 12 16 7"/>
                                <line x1="21" y1="12" x2="9" y2="12"/>
                            </svg>
                            {isDevMode ? 'Exit Dev Mode' : 'Sign out'}
                        </button>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        style={{ display: 'none' }}
                        onChange={handleFileChosen}
                    />
                </div>
            )}
        </div>
    );
}

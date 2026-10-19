/**
 * AccountProfilePanel — SET-IA Phase 7.
 *
 * Self-contained version of the account section that previously
 * lived inline in src/pages/views/SettingsView.jsx (~280 lines of
 * JSX bound to that file's local state). Extracted so the V2 IA's
 * SectionRenderer can mount it under section id `account/profile`
 * without forcing users back to the V1 sidebar for password / MFA /
 * data export / account deletion.
 *
 * Still talks to the same backend endpoints:
 *   GET    /api/auth/me/deletion-status
 *   DELETE /api/auth/me            (with { password, immediate })
 *   POST   /api/auth/me/cancel-deletion
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useWorkspace } from '../../contexts/WorkspaceContext.jsx';
import { csrfFetch } from '../../utils/csrfFetch';
import Button from '../ui/Button';
import SettingsSection from './SettingsSection';
import SettingsCard from './SettingsCard';
import StepUpPinCard from './StepUpPinCard';

const cssVar = (name, fallback) => `var(${name}, ${fallback})`;

export default function AccountProfilePanel() {
    const { user, logout } = useAuth();
    const { currentOrg } = useWorkspace();
    const navigate = useNavigate();

    const [deletionStatus, setDeletionStatus] = useState(null);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deletePassword, setDeletePassword] = useState('');
    const [deleteImmediate, setDeleteImmediate] = useState(false);
    const [deleteLoading, setDeleteLoading] = useState(false);
    const [deleteError, setDeleteError] = useState(null);
    const [notice, setNotice] = useState(null);

    const showNotice = useCallback((message, kind = 'info') => {
        setNotice({ message, kind });
        // auto-clear after 5s; user may dismiss earlier
        setTimeout(() => setNotice(null), 5000);
    }, []);

    const checkDeletionStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/auth/me/deletion-status', { credentials: 'include' });
            if (res.ok) setDeletionStatus(await res.json());
        } catch { /* swallow */ }
    }, []);

    useEffect(() => { if (user) checkDeletionStatus(); }, [user, checkDeletionStatus]);

    const handleLogout = async () => {
        await logout();
        navigate('/login', { replace: true });
    };

    const handleDeleteAccount = async () => {
        if (!deletePassword) { setDeleteError('Please enter your password to confirm'); return; }
        setDeleteLoading(true);
        setDeleteError(null);
        try {
            const res = await csrfFetch('/api/auth/me', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: deletePassword, immediate: deleteImmediate }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 400 && data.error === 'org_owner') {
                    setDeleteError(`You must transfer ownership of these organizations first: ${data.owned_orgs.map(o => o.name).join(', ')}`);
                } else {
                    setDeleteError(data.message || 'Failed to delete account');
                }
                return;
            }
            if (deleteImmediate) {
                showNotice('Your account has been deleted.', 'success');
                navigate('/login', { replace: true });
            } else {
                setShowDeleteModal(false);
                setDeletePassword('');
                showNotice(`Account scheduled for deletion on ${new Date(data.deletion_date).toLocaleDateString()}. You can cancel within 14 days.`, 'warning');
                checkDeletionStatus();
            }
        } catch {
            setDeleteError('Network error — please try again');
        } finally {
            setDeleteLoading(false);
        }
    };

    const handleCancelDeletion = async () => {
        try {
            const res = await csrfFetch('/api/auth/me/cancel-deletion', { method: 'POST' });
            if (res.ok) {
                showNotice('Account deletion cancelled.', 'success');
                setDeletionStatus(null);
            } else {
                const data = await res.json().catch(() => ({}));
                showNotice(data.message || 'Failed to cancel deletion', 'error');
            }
        } catch {
            showNotice('Network error — please try again', 'error');
        }
    };

    return (
        <div style={{ padding: 24, maxWidth: 980 }}>
            <SettingsSection title="Account Information"
                description="Your profile and account details">
                <SettingsCard glass>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{
                            width: 64, height: 64, borderRadius: '50%',
                            background: `linear-gradient(135deg, ${cssVar('--ui-blue', '#38bdf8')}, ${cssVar('--ui-purple', '#a855f7')})`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 24, fontWeight: 600, color: '#fff', flexShrink: 0,
                            overflow: 'hidden',
                        }}>
                            {user?.avatar_url ? (
                                <img src={user.avatar_url}
                                    alt={user?.display_name || 'Profile photo'}
                                    style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%', display: 'block' }} />
                            ) : (
                                user?.display_name?.[0]?.toUpperCase()
                                  || user?.email?.[0]?.toUpperCase() || 'U'
                            )}
                        </div>
                        <div>
                            <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
                                {user?.display_name || 'User'}
                            </h3>
                            <p style={{ color: cssVar('--ui-text-secondary', '#cbd5e1'), fontSize: 14, margin: 0 }}>
                                {user?.email}
                            </p>
                            <p style={{ color: cssVar('--ui-text-muted', '#94a3b8'), fontSize: 13, marginTop: 4 }}>
                                Organization: {currentOrg?.name || 'None'}
                            </p>
                        </div>
                    </div>
                </SettingsCard>
            </SettingsSection>

            <StepUpPinCard />

            <SettingsSection title="Danger Zone">
                {deletionStatus?.scheduled && (
                    <SettingsCard variant="danger" glass style={{ marginBottom: 16 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div style={{ fontWeight: 600, color: cssVar('--ui-red-light', '#fca5a5') }}>
                                Account Scheduled for Deletion
                            </div>
                            <p style={{ color: cssVar('--ui-text-secondary', '#cbd5e1'), fontSize: 14, margin: 0 }}>
                                Your account is scheduled to be deleted on{' '}
                                <strong>{new Date(deletionStatus.deletion_date).toLocaleDateString()}</strong>{' '}
                                ({deletionStatus.days_remaining} days remaining). All your data will be permanently removed.
                            </p>
                            <Button variant="secondary" onClick={handleCancelDeletion}
                                style={{ alignSelf: 'flex-start' }}>
                                Cancel Deletion
                            </Button>
                        </div>
                    </SettingsCard>
                )}

                <SettingsCard variant="danger" glass>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <Button variant="danger" onClick={handleLogout}>Sign Out</Button>
                        {!deletionStatus?.scheduled && (
                            <Button variant="ghost"
                                style={{
                                    color: cssVar('--ui-red-light', '#fca5a5'),
                                    borderColor: cssVar('--ui-red', '#dc2626'),
                                }}
                                onClick={() => setShowDeleteModal(true)}>
                                Delete Account
                            </Button>
                        )}
                    </div>
                </SettingsCard>
            </SettingsSection>

            {notice && (
                <div role="status" aria-live="polite" style={{
                    marginTop: 16, padding: 12, borderRadius: 6, fontSize: 13,
                    background: notice.kind === 'error' ? 'rgba(248, 113, 113, 0.12)'
                              : notice.kind === 'success' ? 'rgba(52, 211, 153, 0.12)'
                              : notice.kind === 'warning' ? 'rgba(217, 119, 6, 0.12)'
                              : 'rgba(56, 189, 248, 0.12)',
                    color: notice.kind === 'error' ? '#f87171'
                         : notice.kind === 'success' ? '#34d399'
                         : notice.kind === 'warning' ? '#fbbf24'
                         : '#38bdf8',
                }}>
                    {notice.message}
                </div>
            )}

            {showDeleteModal && (
                <DeleteAccountModal
                    deletePassword={deletePassword}
                    setDeletePassword={setDeletePassword}
                    deleteImmediate={deleteImmediate}
                    setDeleteImmediate={setDeleteImmediate}
                    deleteLoading={deleteLoading}
                    deleteError={deleteError}
                    onConfirm={handleDeleteAccount}
                    onClose={() => {
                        setShowDeleteModal(false);
                        setDeletePassword('');
                        setDeleteError(null);
                    }}
                />
            )}
        </div>
    );
}

function DeleteAccountModal({
    deletePassword, setDeletePassword,
    deleteImmediate, setDeleteImmediate,
    deleteLoading, deleteError,
    onConfirm, onClose,
}) {
    return (
        <div role="dialog" aria-modal="true"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            style={{
                position: 'fixed', inset: 0, zIndex: 2000,
                background: 'rgba(0, 0, 0, 0.7)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 20,
            }}>
            <div style={{
                background: cssVar('--ui-bg-secondary', '#0f172a'), borderRadius: 12,
                padding: 24, maxWidth: 480, width: '100%',
                border: `1px solid ${cssVar('--ui-red', '#dc2626')}`,
                boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
            }}>
                <h2 style={{ fontSize: 20, fontWeight: 600,
                    color: cssVar('--ui-red-light', '#fca5a5'), marginBottom: 16 }}>
                    Delete Your Account
                </h2>
                <p style={{ color: cssVar('--ui-text-secondary', '#cbd5e1'), fontSize: 14, lineHeight: 1.6, marginBottom: 12 }}>
                    This action will permanently delete your account and all associated data, including:
                </p>
                <ul style={{ color: cssVar('--ui-text-muted', '#94a3b8'), fontSize: 13, margin: '0 0 16px 20px', lineHeight: 1.8 }}>
                    <li>Your profile and personal information</li>
                    <li>All active sessions</li>
                    <li>Organization and team memberships</li>
                    <li>Conversations and memories</li>
                    <li>Credentials and integrations you created</li>
                </ul>
                <p style={{ color: cssVar('--ui-text-secondary', '#cbd5e1'), fontSize: 14 }}>
                    <strong>This action cannot be undone.</strong>
                </p>

                {deleteError && (
                    <div role="alert" style={{
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: `1px solid ${cssVar('--ui-red', '#dc2626')}`,
                        borderRadius: 8, padding: 12, marginBottom: 16,
                        color: cssVar('--ui-red-light', '#fca5a5'), fontSize: 14,
                    }}>{deleteError}</div>
                )}

                <div style={{ marginBottom: 16 }}>
                    <label htmlFor="delete-pw" style={{
                        display: 'block', color: cssVar('--ui-text-secondary', '#cbd5e1'),
                        fontSize: 14, marginBottom: 8 }}>
                        Enter your password to confirm
                    </label>
                    <input id="delete-pw" type="password" autoComplete="current-password"
                        value={deletePassword}
                        onChange={(e) => setDeletePassword(e.target.value)}
                        placeholder="Your current password"
                        style={{
                            width: '100%', padding: '10px 12px',
                            background: cssVar('--ui-bg-tertiary', '#1e293b'),
                            border: `1px solid ${cssVar('--ui-border', '#334155')}`,
                            borderRadius: 6,
                            color: cssVar('--ui-text-primary', '#f1f5f9'),
                            fontSize: 14,
                        }} />
                </div>

                <label style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    cursor: 'pointer',
                    color: cssVar('--ui-text-secondary', '#cbd5e1'), fontSize: 14, marginBottom: 20,
                }}>
                    <input type="checkbox"
                        checked={deleteImmediate}
                        onChange={(e) => setDeleteImmediate(e.target.checked)}
                        style={{ width: 18, height: 18, accentColor: cssVar('--ui-red', '#dc2626') }} />
                    <span>
                        Delete immediately
                        <span style={{ color: cssVar('--ui-text-muted', '#94a3b8'), marginLeft: 8 }}>
                            (otherwise 14-day grace period)
                        </span>
                    </span>
                </label>

                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                    <Button variant="secondary" onClick={onClose} disabled={deleteLoading}>
                        Cancel
                    </Button>
                    <Button variant="danger" onClick={onConfirm}
                        disabled={deleteLoading || !deletePassword}>
                        {deleteLoading ? 'Deleting…' : (deleteImmediate ? 'Delete Now' : 'Schedule Deletion')}
                    </Button>
                </div>
            </div>
        </div>
    );
}

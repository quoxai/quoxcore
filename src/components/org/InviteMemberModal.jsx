/**
 * InviteMemberModal - Invite new members to an organization
 *
 * Allows admins/owners to invite users by email with a selected role.
 * The invite is sent via email (or displayed for manual sharing in dev mode).
 */

import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { useAuth } from '../../contexts/AuthContext';
import './org-components.css';

// Role descriptions for the dropdown
const ROLE_OPTIONS = [
    { value: 'viewer', label: 'Viewer', description: 'Can view org content but cannot make changes' },
    { value: 'runner', label: 'Runner', description: 'Can view and run workflows' },
    { value: 'builder', label: 'Builder', description: 'Can create and manage agents, tools, and workflows' },
    { value: 'admin', label: 'Admin', description: 'Full access except billing and org deletion' }
];

// Icons
const MailIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
        <path d="M22 6l-10 7L2 6"/>
    </svg>
);

const CheckIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"/>
    </svg>
);

export default function InviteMemberModal({
    isOpen,
    onClose,
    orgId,
    orgName,
    onSuccess
}) {
    const { authFetch } = useAuth();
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('viewer');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(false);
    const [inviteToken, setInviteToken] = useState(null);

    // Reset form when modal opens/closes
    useEffect(() => {
        if (isOpen) {
            setEmail('');
            setRole('member');
            setError(null);
            setSuccess(false);
            setInviteToken(null);
        }
    }, [isOpen]);

    const validateEmail = (email) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // Validate email
        if (!email.trim()) {
            setError('Email is required');
            return;
        }
        if (!validateEmail(email)) {
            setError('Please enter a valid email address');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await authFetch(`/api/orgs/${orgId}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, role })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Failed to send invite');
            }

            // Success! Show confirmation
            setSuccess(true);

            // If token is returned (dev mode), show it for manual sharing
            if (data.invite?.token) {
                setInviteToken(data.invite.token);
            }

            // Notify parent
            onSuccess?.();

        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleClose = () => {
        if (!loading) {
            onClose();
        }
    };

    const selectedRole = ROLE_OPTIONS.find(r => r.value === role);

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            size="md"
        >
            <Modal.Header
                title={success ? 'Invitation Sent' : 'Invite Member'}
                description={success ? `Invitation sent to ${email}` : `Invite someone to join ${orgName}`}
                icon={success ? <CheckIcon /> : <MailIcon />}
                onClose={handleClose}
            />

            {success ? (
                <>
                    <Modal.Body>
                        <div style={{
                            textAlign: 'center',
                            padding: '24px 0'
                        }}>
                            <div style={{
                                width: '64px',
                                height: '64px',
                                margin: '0 auto 16px',
                                background: 'rgba(52, 199, 89, 0.15)',
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}>
                                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#34c759" strokeWidth="2">
                                    <polyline points="20 6 9 17 4 12"/>
                                </svg>
                            </div>
                            <h3 style={{
                                margin: '0 0 8px',
                                color: 'var(--ui-text-primary, white)',
                                fontSize: '18px'
                            }}>
                                Invitation Sent!
                            </h3>
                            <p style={{
                                margin: 0,
                                color: 'var(--ui-text-muted, #999)',
                                fontSize: '14px'
                            }}>
                                {email} will receive an email to join as <strong style={{ color: 'var(--ui-text-secondary)' }}>{role}</strong>.
                            </p>

                            {/* Dev mode: Show invite link for manual sharing */}
                            {inviteToken && (
                                <div style={{
                                    marginTop: '24px',
                                    padding: '16px',
                                    background: 'rgba(255, 255, 255, 0.05)',
                                    borderRadius: '8px',
                                    border: '1px solid rgba(255, 255, 255, 0.1)'
                                }}>
                                    <p style={{
                                        margin: '0 0 8px',
                                        color: 'var(--ui-text-muted)',
                                        fontSize: '12px'
                                    }}>
                                        Dev Mode: Share this link manually
                                    </p>
                                    <code style={{
                                        display: 'block',
                                        padding: '8px 12px',
                                        background: 'rgba(0, 0, 0, 0.3)',
                                        borderRadius: '4px',
                                        fontSize: '12px',
                                        wordBreak: 'break-all',
                                        color: 'var(--ui-cyan, #38bdf8)'
                                    }}>
                                        {window.location.origin}/invite/{inviteToken}
                                    </code>
                                </div>
                            )}
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="secondary" onClick={handleClose} style={{ marginLeft: 'auto' }}>
                            Done
                        </Button>
                    </Modal.Footer>
                </>
            ) : (
                <form onSubmit={handleSubmit}>
                    <Modal.Body>
                        {error && (
                            <div style={{
                                padding: '12px 16px',
                                background: 'rgba(255, 59, 48, 0.1)',
                                border: '1px solid rgba(255, 59, 48, 0.2)',
                                borderRadius: '8px',
                                color: '#ff3b30',
                                fontSize: '14px',
                                marginBottom: '16px'
                            }}>
                                {error}
                            </div>
                        )}

                        <div className="entity-form-field">
                            <label
                                className="entity-form-field__label"
                                htmlFor="invite-email"
                            >
                                Email Address *
                            </label>
                            <Input
                                id="invite-email"
                                type="email"
                                value={email}
                                onChange={(e) => {
                                    setEmail(e.target.value);
                                    setError(null);
                                }}
                                placeholder="colleague@company.com"
                                autoFocus
                                disabled={loading}
                                required
                            />
                        </div>

                        <div className="entity-form-field">
                            <label
                                className="entity-form-field__label"
                                htmlFor="invite-role"
                            >
                                Role
                            </label>
                            <select
                                id="invite-role"
                                value={role}
                                onChange={(e) => setRole(e.target.value)}
                                disabled={loading}
                                style={{
                                    width: '100%',
                                    padding: '10px 12px',
                                    background: 'var(--ui-bg-secondary, #1a1a24)',
                                    border: '1px solid var(--ui-border, rgba(255, 255, 255, 0.1))',
                                    borderRadius: '8px',
                                    color: 'var(--ui-text-primary, white)',
                                    fontSize: '14px',
                                    cursor: 'pointer'
                                }}
                            >
                                {ROLE_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                            {selectedRole && (
                                <span className="entity-form-field__hint">
                                    {selectedRole.description}
                                </span>
                            )}
                        </div>

                        <div style={{
                            padding: '12px 16px',
                            background: 'rgba(56, 189, 248, 0.1)',
                            border: '1px solid rgba(56, 189, 248, 0.2)',
                            borderRadius: '8px',
                            fontSize: '13px',
                            color: 'var(--ui-text-secondary, #aaa)',
                            marginTop: '8px'
                        }}>
                            <strong style={{ color: 'var(--ui-cyan, #38bdf8)' }}>Note:</strong> The invited user will receive an email with a link to join the organization. If they don't have an account, they'll be prompted to create one.
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
                            Send Invitation
                        </Button>
                    </Modal.Footer>
                </form>
            )}
        </Modal>
    );
}

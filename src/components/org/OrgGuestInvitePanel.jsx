/**
 * OrgGuestInvitePanel — ET-6D.
 *
 * Enterprise. Minimal form to create an assistant-scoped guest invite
 * and show the resulting invite link. No list view — guest invites
 * are write-once links; the admin shares them out-of-band.
 */

import { useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    GUEST_INVITE_TYPES,
    isValidEmail,
    createGuestInvite,
} from '../../services/guestInviteClient';

const UserPlusIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="20" y1="8" x2="20" y2="14" />
        <line x1="17" y1="11" x2="23" y2="11" />
    </svg>
);

function InviteLinkReveal({ invite, onClose }) {
    const [copied, setCopied] = useState(false);
    const url = typeof window !== 'undefined'
        ? `${window.location.origin}/invite/guest/${invite.token}`
        : `/invite/guest/${invite.token}`;
    const copy = () => {
        navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => {});
    };
    return (
        <div className="org-guest-panel__reveal">
            <div className="org-guest-panel__reveal-title">Share this one-time link with {invite.email}</div>
            <div className="org-guest-panel__reveal-sub">
                They'll land on a scoped chat surface tied to <code>{invite.target_scope_id}</code>.
            </div>
            <div className="org-guest-panel__reveal-row">
                <code>{url}</code>
                <Button size="sm" variant="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
            <div className="org-guest-panel__reveal-actions">
                <Button size="sm" variant="primary" onClick={onClose}>Done</Button>
            </div>
        </div>
    );
}

export default function OrgGuestInvitePanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const [email, setEmail]       = useState('');
    const [scopeId, setScopeId]   = useState('');
    const [inviteType, setInviteType] = useState('guest');
    const [busy, setBusy]         = useState(false);
    const [error, setError]       = useState(null);
    const [lastInvite, setLastInvite] = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!isValidEmail(email)) { setError(`"${email}" is not a valid email`); return; }
        if (!scopeId)             { setError('target scope id is required'); return; }
        setBusy(true); setError(null);
        try {
            const invite = await createGuestInvite(orgId, {
                email, targetScopeId: scopeId, inviteType,
            }, authFetch);
            setLastInvite(invite);
            setEmail(''); setScopeId('');
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
    };

    return (
        <div className="qx-card org-guest-panel">
            <div className="org-guest-panel__head">
                <span className="org-guest-panel__icon"><UserPlusIcon /></span>
                <div className="org-guest-panel__title-group">
                    <h3 className="org-guest-panel__title">Guest Invite</h3>
                    <p className="org-guest-panel__sub">
                        Invite an external user pinned to a single scope.
                        They see only that scope's assistant — nothing else.
                    </p>
                </div>
            </div>

            {error && <div className="org-guest-panel__error">{error}</div>}

            {lastInvite && <InviteLinkReveal invite={lastInvite} onClose={() => setLastInvite(null)} />}

            {isAdmin && !lastInvite && (
                <form className="org-guest-panel__form" onSubmit={handleSubmit}>
                    <div className="org-guest-panel__field">
                        <label>Email</label>
                        <input type="email" value={email}
                            onChange={e => setEmail(e.target.value)}
                            placeholder="external.user@company.com" required />
                    </div>
                    <div className="org-guest-panel__field">
                        <label>Target scope id</label>
                        <input value={scopeId}
                            onChange={e => setScopeId(e.target.value)}
                            placeholder="SCP_team_abc" required />
                    </div>
                    <div className="org-guest-panel__field org-guest-panel__field--wide">
                        <label>Invite type</label>
                        <div className="org-guest-panel__type-row">
                            {GUEST_INVITE_TYPES.map(t => (
                                <label key={t} className={`org-guest-panel__type${inviteType === t ? ' is-active' : ''}`}>
                                    <input
                                        type="radio"
                                        name="invite_type"
                                        value={t}
                                        checked={inviteType === t}
                                        onChange={() => setInviteType(t)}
                                    />
                                    <span>{t.replace('_', ' ')}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                    <div className="org-guest-panel__form-actions">
                        <Button type="submit" size="sm" variant="primary" loading={busy}>
                            Create invite link
                        </Button>
                    </div>
                </form>
            )}
        </div>
    );
}

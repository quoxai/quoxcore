/**
 * InstanceAdminsPanel — SET-IA Phase 4c.
 *
 * CRUD for the instance_admins table. Replaces /admin/admins; that
 * route 301s here. Granting and revoking require the caller to be a
 * superadmin (enforced server-side in services/auth/routes/admin.js
 * — UI hides the controls if useInstanceAdmin().role !== 'superadmin').
 */

import { useEffect, useState, useCallback } from 'react';
import { csrfFetch } from '../../../utils/csrfFetch';
import { useInstanceAdmin } from '../../../hooks/useInstanceAdmin.js';
import { Field, inputStyle, fieldsetStyle, legendStyle, saveButtonStyle, SaveStatus }
    from './instancePanelStyles.jsx';

const AUTH_API = '/api';

const ROLE_CHOICES = [
    { value: 'readonly',   label: 'Readonly — view-only access' },
    { value: 'admin',      label: 'Admin — manage config / keys' },
    { value: 'superadmin', label: 'Superadmin — manage other admins, rotate keys' },
];

export default function InstanceAdminsPanel() {
    const { role: callerRole, refresh: refreshSelf } = useInstanceAdmin();
    const isSuperadmin = callerRole === 'superadmin';

    const [admins, setAdmins]     = useState([]);
    const [loading, setLoading]   = useState(true);
    const [error, setError]       = useState(null);
    const [grantUserId, setGrantUserId] = useState('');
    const [grantRole, setGrantRole]     = useState('admin');
    const [grantBusy, setGrantBusy]     = useState(false);
    const [grantNote, setGrantNote]     = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${AUTH_API}/admin/admins`, { credentials: 'include' });
            if (!res.ok) throw new Error(`Failed to load admins (${res.status})`);
            const { admins = [] } = await res.json();
            setAdmins(admins);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const grant = async (e) => {
        e.preventDefault();
        if (!grantUserId.trim()) return;
        setGrantBusy(true);
        setGrantNote(null);
        try {
            const res = await csrfFetch(`${AUTH_API}/admin/admins`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ user_id: grantUserId.trim(), role: grantRole }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || `Grant failed (${res.status})`);
            setGrantNote({ kind: 'ok', text: data.action === 'updated' ? 'Role updated.' : 'Admin granted.' });
            setGrantUserId('');
            await load();
        } catch (err) {
            setGrantNote({ kind: 'err', text: err.message });
        } finally {
            setGrantBusy(false);
        }
    };

    const revoke = async (admin) => {
        if (!isSuperadmin) return;
        const ok = window.confirm(`Revoke instance-admin role from ${admin.primary_email || admin.user_id}?`);
        if (!ok) return;
        try {
            const res = await csrfFetch(`${AUTH_API}/admin/admins/${admin.user_id}`, {
                method: 'DELETE',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || data.error || `Revoke failed (${res.status})`);
            await load();
            // If we just revoked ourselves we'd need a session refresh,
            // but the server blocks self-revocation — refresh the cached
            // role for safety.
            await refreshSelf();
        } catch (err) {
            setError(err.message);
        }
    };

    if (loading) return <div style={{ padding: 24, opacity: 0.6 }}>Loading instance admins…</div>;

    return (
        <div style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Instance Admins</h2>
            <p style={{ opacity: 0.7, marginBottom: 24 }}>
                Users with instance-wide privileges. Grants and revocations
                require superadmin and are recorded in the audit log.
            </p>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Active admins ({admins.length})</legend>
                {error && <p style={{ color: '#f87171' }} role="alert">{error}</p>}
                {admins.length === 0 ? (
                    <p style={{ opacity: 0.6 }}>No instance admins yet.</p>
                ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ textAlign: 'left', opacity: 0.7, fontSize: 12 }}>
                                <th style={cellStyle}>Email</th>
                                <th style={cellStyle}>Role</th>
                                <th style={cellStyle}>Granted by</th>
                                <th style={cellStyle}>Granted at</th>
                                <th style={cellStyle} aria-label="actions" />
                            </tr>
                        </thead>
                        <tbody>
                            {admins.map(a => (
                                <tr key={a.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                    <td style={cellStyle}>{a.primary_email}</td>
                                    <td style={cellStyle}>
                                        <span style={roleBadgeStyle(a.role)}>{a.role}</span>
                                    </td>
                                    <td style={cellStyle}>{a.granted_by_name || '—'}</td>
                                    <td style={cellStyle}>{a.granted_at ? new Date(a.granted_at).toLocaleDateString() : '—'}</td>
                                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                                        {isSuperadmin && (
                                            <button type="button" onClick={() => revoke(a)}
                                                style={revokeButtonStyle}>Revoke</button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </fieldset>

            {isSuperadmin ? (
                <form onSubmit={grant} noValidate>
                    <fieldset style={fieldsetStyle}>
                        <legend style={legendStyle}>Grant new admin</legend>

                        <Field id="grantUserId" label="User ID"
                            help="Look up the ULID from the user record (e.g. 01KKNKG580E967VC6YKAFWRT27).">
                            <input id="grantUserId" type="text" style={inputStyle}
                                value={grantUserId}
                                onChange={(e) => setGrantUserId(e.target.value)} />
                        </Field>

                        <Field id="grantRole" label="Role">
                            <select id="grantRole" style={inputStyle}
                                value={grantRole}
                                onChange={(e) => setGrantRole(e.target.value)}>
                                {ROLE_CHOICES.map(c => (
                                    <option key={c.value} value={c.value}>{c.label}</option>
                                ))}
                            </select>
                        </Field>

                        {grantNote && (
                            grantNote.kind === 'ok'
                                ? <SaveStatus savedAt={new Date()} />
                                : <p style={{ color: '#f87171' }} role="alert">{grantNote.text}</p>
                        )}

                        <button type="submit" disabled={grantBusy || !grantUserId.trim()}
                            style={saveButtonStyle(grantBusy)}>
                            {grantBusy ? 'Granting…' : 'Grant'}
                        </button>
                    </fieldset>
                </form>
            ) : (
                <p style={{ opacity: 0.6, fontSize: 13 }}>
                    Only superadmins can grant or revoke instance admin roles.
                </p>
            )}
        </div>
    );
}

const cellStyle = { padding: '8px 6px', verticalAlign: 'middle' };

function roleBadgeStyle(role) {
    const palette = {
        superadmin: { bg: 'rgba(217, 119, 6, 0.18)',  fg: '#fbbf24' },
        admin:      { bg: 'rgba(56, 189, 248, 0.18)', fg: '#38bdf8' },
        readonly:   { bg: 'rgba(148, 163, 184, 0.18)', fg: '#cbd5e1' },
    }[role] || { bg: 'rgba(255,255,255,0.08)', fg: 'inherit' };
    return {
        background: palette.bg, color: palette.fg,
        padding: '2px 8px', borderRadius: 4,
        fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
    };
}

const revokeButtonStyle = {
    background: 'transparent', color: '#f87171',
    border: '1px solid rgba(248, 113, 113, 0.4)',
    borderRadius: 4, padding: '4px 10px', fontSize: 12,
    cursor: 'pointer',
};

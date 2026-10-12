/**
 * CustomRoleAssignDialog — ET-FINISH Phase 2.
 *
 * Lets an admin attach (or clear) a custom role overlay on a single
 * member. The custom role unions extra capabilities on top of the
 * built-in role; the actual enforcement is in the auth service
 * (ET-ENFORCE-B). This dialog is the missing UI surface that lets an
 * admin actually assign one.
 *
 * Wraps assignMembershipCustomRole and maps each documented error
 * code to inline UX:
 *  - forbidden_escalation        → "you can't grant caps you don't hold"
 *  - cannot_modify_own_membership → "use a different surface for self-edits"
 *  - cannot_modify_higher_role   → "target outranks or matches you"
 *  - invalid_custom_role_id      → "role id doesn't belong to this org"
 */

import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
    fetchCustomRoles,
    assignMembershipCustomRole,
} from '../../services/customRolesClient';

export default function CustomRoleAssignDialog({
    orgId,
    member,
    onClose,
    onAssigned,
}) {
    const { authFetch } = useAuth();
    const [roles, setRoles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [selected, setSelected] = useState(member?.custom_role_id || null);
    const [saving, setSaving] = useState(false);
    const [submitError, setSubmitError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const list = await fetchCustomRoles(orgId, authFetch);
                if (!cancelled) setRoles(list);
            } catch (err) {
                if (!cancelled) setLoadError(err.message || 'Failed to load custom roles');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [orgId, authFetch]);

    // Esc closes the dialog (unless mid-save — don't strand a request in flight).
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape' && !saving) {
                e.stopPropagation();
                onClose?.();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [saving, onClose]);

    const onSave = async () => {
        if (saving) return;
        setSubmitError(null);
        setSaving(true);
        try {
            await assignMembershipCustomRole(orgId, member.id, selected, authFetch);
            if (onAssigned) onAssigned({ memberId: member.id, customRoleId: selected });
            onClose?.();
        } catch (err) {
            setSubmitError({
                code: err.code || 'unknown',
                message: err.message || 'Could not save',
            });
            setSaving(false);
        }
    };

    let errorBody = null;
    if (submitError) {
        const map = {
            forbidden_escalation:
                'You cannot grant capabilities you do not hold yourself.',
            cannot_modify_own_membership:
                'You cannot modify your own membership through this surface.',
            cannot_modify_higher_role:
                'You cannot modify a member whose role is equal to or higher than yours.',
            invalid_custom_role_id:
                'That custom role doesn’t belong to this organisation.',
        };
        errorBody = (
            <div className="cra-dialog__error" role="alert">
                {map[submitError.code] || submitError.message || 'Could not save changes.'}
            </div>
        );
    }

    return (
        <div className="cra-dialog__backdrop" onClick={onClose}>
            <div
                className="cra-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`Assign custom role for ${member?.name || member?.email || 'member'}`}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="cra-dialog__head">
                    <h3 className="cra-dialog__title">Custom role overlay</h3>
                    <p className="cra-dialog__subtitle">
                        {member?.name || member?.email || 'Member'} — built-in role: <strong>{member?.role || 'member'}</strong>
                    </p>
                </div>

                {loading && <div className="cra-dialog__loading">Loading roles…</div>}

                {loadError && (
                    <div className="cra-dialog__error" role="alert">{loadError}</div>
                )}

                {!loading && !loadError && (
                    <div className="cra-dialog__body">
                        {roles.length === 0 ? (
                            <p className="cra-dialog__empty">
                                No custom roles in this organisation yet. Create one in the Custom Roles panel first.
                            </p>
                        ) : (
                            <ul className="cra-dialog__list" role="radiogroup" aria-label="Custom roles">
                                <li>
                                    <label className="cra-dialog__option">
                                        <input
                                            type="radio"
                                            name="custom-role"
                                            checked={selected === null}
                                            onChange={() => setSelected(null)}
                                            disabled={saving}
                                        />
                                        <span>
                                            <strong>None</strong>
                                            <small>Clear any existing custom role overlay.</small>
                                        </span>
                                    </label>
                                </li>
                                {roles.map((r) => (
                                    <li key={r.id}>
                                        <label className="cra-dialog__option">
                                            <input
                                                type="radio"
                                                name="custom-role"
                                                checked={selected === r.id}
                                                onChange={() => setSelected(r.id)}
                                                disabled={saving}
                                            />
                                            <span>
                                                <strong>{r.name}</strong>
                                                {r.description && <small>{r.description}</small>}
                                            </span>
                                        </label>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                {errorBody}

                <div className="cra-dialog__actions">
                    <button
                        type="button"
                        className="cra-dialog__btn cra-dialog__btn--ghost"
                        onClick={onClose}
                        disabled={saving}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="cra-dialog__btn cra-dialog__btn--primary"
                        onClick={onSave}
                        disabled={loading || saving || !!loadError}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}

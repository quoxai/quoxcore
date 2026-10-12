/**
 * OrgSecurityPanel — ET-4 Phase D.
 *
 * Three sub-sections:
 *   1. Session policy — idle timeout, max session, remember-me toggle
 *   2. IP allowlist   — list + add + remove CIDR entries
 *   3. MFA policy     — disabled / optional / required radio group
 *
 * Reads/writes via orgSecurityClient. Only renders real controls when
 * admin; otherwise shows read-only view.
 */

import { useCallback, useEffect, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    MFA_MODES,
    isValidCidr,
    fetchSessionPolicy,
    setSessionPolicy,
    fetchIpAllowlist,
    addIpAllowlistEntry,
    removeIpAllowlistEntry,
    fetchMfaPolicy,
    setMfaPolicy,
} from '../../services/orgSecurityClient';

const LockIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="11" width="18" height="11" rx="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);

const TrashIcon = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
);

// TRUST-GATE-1.14 — last non-zero minutes/hours value the admin had entered,
// so toggling "disable" off restores a sensible number instead of 0.
const FALLBACK_IDLE_MIN  = 30;
const FALLBACK_MAX_HOURS = 12;

function SessionSection({ orgId, isAdmin, onError }) {
    const { authFetch } = useAuth();
    const [policy, setPolicy] = useState(null);
    const [idleMin, setIdleMin] = useState(30);
    const [maxHours, setMaxHours] = useState(12);
    const [idleDisabled, setIdleDisabled] = useState(false);
    const [maxDisabled, setMaxDisabled] = useState(false);
    const [rememberMeEnabled, setRememberMeEnabled] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const load = useCallback(async () => {
        try {
            const p = await fetchSessionPolicy(orgId, authFetch);
            if (p) {
                setPolicy(p);
                const idle = Math.round(p.idleTimeoutSec / 60);
                const max  = Math.round(p.maxSessionSec / 3600);
                setIdleDisabled(idle === 0);
                setMaxDisabled(max === 0);
                setIdleMin(idle || FALLBACK_IDLE_MIN);
                setMaxHours(max || FALLBACK_MAX_HOURS);
                setRememberMeEnabled(p.rememberMeEnabled !== false);
            }
            setLoaded(true);
        } catch (err) {
            onError?.(err.message);
        }
    }, [orgId, authFetch, onError]);

    useEffect(() => { load(); }, [load]);

    const save = async () => {
        setSaving(true);
        onError?.(null);
        try {
            const updated = await setSessionPolicy(orgId, {
                idleTimeoutSec: idleDisabled ? 0 : idleMin * 60,
                maxSessionSec:  maxDisabled  ? 0 : maxHours * 3600,
                rememberMeEnabled,
            }, authFetch);
            setPolicy(updated);
        } catch (err) {
            onError?.(err.message);
        } finally {
            setSaving(false);
        }
    };

    const savedIdle = loaded && policy ? Math.round(policy.idleTimeoutSec / 60) : null;
    const savedMax  = loaded && policy ? Math.round(policy.maxSessionSec / 3600) : null;
    const savedRememberMe = loaded && policy ? (policy.rememberMeEnabled !== false) : null;
    const dirty = loaded && policy && (
        (idleDisabled ? 0 : idleMin)  !== savedIdle ||
        (maxDisabled  ? 0 : maxHours) !== savedMax ||
        rememberMeEnabled !== savedRememberMe
    );

    return (
        <div className="org-security-panel__section">
            <div className="org-security-panel__section-head">
                <h4>Session Policy</h4>
                <span className="org-security-panel__hint">Applied to all members of this org.</span>
            </div>
            <div className="org-security-panel__row">
                <label>Idle timeout (minutes)</label>
                <input type="number" min="1" max="1440" value={idleMin}
                    onChange={e => setIdleMin(Number(e.target.value))}
                    disabled={!isAdmin || idleDisabled} />
            </div>
            <div className="org-security-panel__row org-security-panel__row--toggle">
                <label>
                    <input type="checkbox" checked={idleDisabled}
                        onChange={e => setIdleDisabled(e.target.checked)}
                        disabled={!isAdmin} />
                    <span>Disable idle logout (members are never signed out for inactivity)</span>
                </label>
            </div>
            <div className="org-security-panel__row">
                <label>Max session (hours)</label>
                <input type="number" min="1" max="720" value={maxHours}
                    onChange={e => setMaxHours(Number(e.target.value))}
                    disabled={!isAdmin || maxDisabled} />
            </div>
            <div className="org-security-panel__row org-security-panel__row--toggle">
                <label>
                    <input type="checkbox" checked={maxDisabled}
                        onChange={e => setMaxDisabled(e.target.checked)}
                        disabled={!isAdmin} />
                    <span>No absolute session limit (sessions never expire by age)</span>
                </label>
            </div>
            {(idleDisabled || maxDisabled) && (
                <p className="org-security-panel__warning">
                    Disabling {idleDisabled && maxDisabled ? 'both limits' : idleDisabled ? 'idle logout' : 'the absolute session limit'} weakens
                    this org's session security posture — a stolen or leaked session cookie stays valid indefinitely{idleDisabled ? ' until revoked' : ''}.
                </p>
            )}
            <div className="org-security-panel__row org-security-panel__row--toggle">
                <label>
                    <input type="checkbox" checked={rememberMeEnabled}
                        onChange={e => setRememberMeEnabled(e.target.checked)}
                        disabled={!isAdmin} />
                    <span>Allow members to stay signed in ("Remember me" at login)</span>
                </label>
            </div>
            {!rememberMeEnabled && (
                <p className="org-security-panel__hint">
                    Members will not see a "Remember me" option — every login uses the idle/max-session limits above.
                </p>
            )}
            {isAdmin && (
                <div className="org-security-panel__actions">
                    <Button size="sm" variant="primary" onClick={save} disabled={!dirty} loading={saving}>
                        Save session policy
                    </Button>
                </div>
            )}
        </div>
    );
}

function IpAllowlistSection({ orgId, isAdmin, onError }) {
    const { authFetch } = useAuth();
    const [entries, setEntries] = useState([]);
    const [cidr, setCidr] = useState('');
    const [label, setLabel] = useState('');
    const [adding, setAdding] = useState(false);

    const load = useCallback(async () => {
        try {
            const list = await fetchIpAllowlist(orgId, authFetch);
            setEntries(list);
        } catch (err) {
            onError?.(err.message);
        }
    }, [orgId, authFetch, onError]);

    useEffect(() => { load(); }, [load]);

    const add = async (e) => {
        e.preventDefault();
        if (!isValidCidr(cidr)) {
            onError?.(`"${cidr}" is not a valid IPv4 CIDR`);
            return;
        }
        setAdding(true);
        onError?.(null);
        try {
            await addIpAllowlistEntry(orgId, { cidr, label: label || null }, authFetch);
            setCidr(''); setLabel('');
            await load();
        } catch (err) {
            onError?.(err.message);
        } finally {
            setAdding(false);
        }
    };

    const remove = async (id) => {
        try {
            await removeIpAllowlistEntry(orgId, id, authFetch);
            await load();
        } catch (err) {
            onError?.(err.message);
        }
    };

    return (
        <div className="org-security-panel__section">
            <div className="org-security-panel__section-head">
                <h4>IP Allowlist</h4>
                <span className="org-security-panel__hint">
                    {entries.length === 0 ? 'Empty list → all IPs allowed. Add ranges to restrict.' : `${entries.length} rule${entries.length === 1 ? '' : 's'}`}
                </span>
            </div>
            {entries.length > 0 && (
                <ul className="org-security-panel__ip-list">
                    {entries.map(e => (
                        <li key={e.id} className="org-security-panel__ip-row">
                            <code>{e.cidr}</code>
                            {e.label && <span className="org-security-panel__ip-label">{e.label}</span>}
                            {isAdmin && (
                                <button type="button" className="org-security-panel__ip-del"
                                    aria-label={`Remove ${e.cidr}`}
                                    onClick={() => remove(e.id)}>
                                    <TrashIcon />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {isAdmin && (
                <form className="org-security-panel__ip-add" onSubmit={add}>
                    <input placeholder="10.0.0.0/8" value={cidr} onChange={e => setCidr(e.target.value)} />
                    <input placeholder="Label (optional)" value={label} onChange={e => setLabel(e.target.value)} />
                    <Button type="submit" size="sm" variant="primary" loading={adding}>Add</Button>
                </form>
            )}
        </div>
    );
}

function MfaSection({ orgId, isAdmin, onError }) {
    const { authFetch } = useAuth();
    const [mode, setMode] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetchMfaPolicy(orgId, authFetch).then(setMode).catch(err => onError?.(err.message));
    }, [orgId, authFetch, onError]);

    const choose = async (next) => {
        if (next === mode) return;
        setSaving(true);
        onError?.(null);
        try {
            const saved = await setMfaPolicy(orgId, next, authFetch);
            setMode(saved);
        } catch (err) {
            onError?.(err.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="org-security-panel__section">
            <div className="org-security-panel__section-head">
                <h4>MFA Policy</h4>
                <span className="org-security-panel__hint">Controls whether members must use multi-factor auth.</span>
            </div>
            <div className="org-security-panel__mfa-grid">
                {Object.values(MFA_MODES).map(m => (
                    <label key={m} className={`org-security-panel__mfa-opt${mode === m ? ' is-active' : ''}`}>
                        <input type="radio" name="mfa-mode" value={m}
                            checked={mode === m}
                            onChange={() => choose(m)}
                            disabled={!isAdmin || saving} />
                        <div>
                            <div className="org-security-panel__mfa-label">{m.toUpperCase()}</div>
                            <div className="org-security-panel__mfa-desc">
                                {m === 'disabled' && 'No MFA required; members cannot enrol.'}
                                {m === 'optional' && 'Members may enrol voluntarily.'}
                                {m === 'required' && 'Every member must enrol and verify at login.'}
                            </div>
                        </div>
                    </label>
                ))}
            </div>
        </div>
    );
}

export default function OrgSecurityPanel({ orgId, isAdmin = false }) {
    const [error, setError] = useState(null);

    return (
        <div className="qx-card org-security-panel">
            <div className="org-security-panel__head">
                <span className="org-security-panel__icon"><LockIcon /></span>
                <div>
                    <h3 className="org-security-panel__title">Security &amp; Access</h3>
                    <p className="org-security-panel__sub">Session, IP allowlist, and MFA policies for this organisation.</p>
                </div>
            </div>
            {error && <div className="org-security-panel__error">{error}</div>}
            <SessionSection orgId={orgId} isAdmin={isAdmin} onError={setError} />
            <IpAllowlistSection orgId={orgId} isAdmin={isAdmin} onError={setError} />
            <MfaSection orgId={orgId} isAdmin={isAdmin} onError={setError} />
        </div>
    );
}

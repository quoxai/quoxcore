/**
 * QlusterSettings — box-admin surface for the external Qluster fleet
 * controller (Qluster Phase 4).
 *
 * Replaces the developer-hostile "run POST /api/v1/qluster/enroll/issue"
 * instruction with a button. A box admin:
 *   1. Generates a single-use, 15-min enrollment token (scope checklist +
 *      allowed-orgs picker) → shown ONCE with a copy button + TTL countdown.
 *   2. Sees enrolled controllers and can revoke each one.
 *
 * Endpoints (via the dashboard's /collector proxy → collector :9848):
 *   POST /collector/api/v1/qluster/enroll/issue
 *   GET  /collector/api/v1/qluster/controllers
 *   POST /collector/api/v1/qluster/controllers/:id/revoke
 * All are gated by isAdminCaller on the box; the logged-in admin's session
 * cookie is forwarded by the proxy, so no curl / read token is needed.
 *
 * Org list for the allowed-orgs picker comes from useWorkspace().orgs
 * (backed by GET /api/orgs).
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import SettingsSection from './SettingsSection';
import SettingsCard from './SettingsCard';
import Button from '../ui/Button';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { csrfFetch } from '../../utils/csrfFetch';
import './settings.css';
import './QlusterSettings.css';

const COLLECTOR = '/collector/api/v1/qluster';

// Scope catalogue — node.read is always on (default, disabled).
const SCOPES = [
    { id: 'node.read',        label: 'Node read',       hint: 'Read-only fleet + node status. Always granted.', locked: true },
    { id: 'backup.trigger',   label: 'Trigger backups', hint: 'Let the controller start backups on this box.' },
    { id: 'backup.download',  label: 'Download backups', hint: 'Let the controller pull backup archives (data egress).' },
    {
        id: 'agent.delegate',
        label: 'Let the controller run governed tasks on this box',
        hint: "Delegated tasks still pass this box's own policy + HITL approval — the controller can't bypass them. This box also needs a working LLM credential for the target org, or delegated tasks won't run.",
    },
];

// Capability presets — bundle scopes so an admin doesn't have to hand-pick
// checkboxes. "Advanced" below still exposes the raw list for fine-tuning.
const PRESETS = [
    {
        id: 'monitoring',
        label: 'Monitoring only',
        hint: 'Read-only fleet + node status. Nothing this box does can be triggered remotely.',
        scopes: ['node.read'],
    },
    {
        id: 'backups',
        label: 'Backups',
        hint: 'Monitoring, plus letting the controller trigger and pull backups from this box.',
        scopes: ['node.read', 'backup.trigger', 'backup.download'],
    },
    {
        id: 'tasking',
        label: 'Backups + Tasking',
        hint: 'Backups, plus governed agent task delegation (still subject to this box’s policy + HITL).',
        scopes: ['node.read', 'backup.trigger', 'backup.download', 'agent.delegate'],
    },
];

// ── Icons (explicit strokes per CLAUDE.md — every button gets an SVG) ──
const KeyIcon = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3" />
    </svg>
);
const CopyIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.85)' }}>
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
);
const CheckIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: '#34d399' }}>
        <polyline points="20 6 9 17 4 12" />
    </svg>
);
const TrashIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(248,113,113,0.9)' }}>
        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
);
const RefreshIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.75)' }}>
        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
);
const ShieldIcon = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'rgba(255,255,255,0.9)' }}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" />
    </svg>
);
const RadioIcon = ({ checked }) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2" style={{ stroke: checked ? '#38bdf8' : 'rgba(255,255,255,0.35)' }}>
        <circle cx="12" cy="12" r="9" />
        {checked && <circle cx="12" cy="12" r="4" fill="#38bdf8" stroke="none" />}
    </svg>
);
const ChevronIcon = ({ open }) => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
        style={{ stroke: 'rgba(255,255,255,0.6)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}>
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

function fmtDate(ms) {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleString(); } catch { return '—'; }
}
function timeAgo(ms) {
    if (!ms) return 'never';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

// Turn a fetch failure into a human sentence.
async function humanError(res) {
    if (res.status === 403) return 'You need admin role on this box to manage Qluster controllers.';
    if (res.status === 401) return 'Your session expired, or read token / auth is not configured on this box.';
    let detail = '';
    try { const b = await res.json(); detail = b?.error || b?.detail || ''; } catch { /* ignore */ }
    return `Request failed (${res.status})${detail ? `: ${detail}` : ''}.`;
}

// ── Generated-token block: shown ONCE, with copy + 15-min countdown ──
function TokenReveal({ result, onDismiss }) {
    const [copied, setCopied] = useState(false);
    const [remaining, setRemaining] = useState(() => Math.max(0, (result.expires_at || 0) - Date.now()));

    useEffect(() => {
        const t = setInterval(() => {
            setRemaining(Math.max(0, (result.expires_at || 0) - Date.now()));
        }, 1000);
        return () => clearInterval(t);
    }, [result.expires_at]);

    const copy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(result.enrollment_token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard blocked — user can still select manually */ }
    }, [result.enrollment_token]);

    const expired = remaining <= 0;
    const mm = String(Math.floor(remaining / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');

    return (
        <div className={`qluster-token-reveal ${expired ? 'is-expired' : ''}`}>
            <div className="qluster-token-reveal__head">
                <span className="qluster-token-reveal__badge">Shown once</span>
                <span className={`qluster-token-reveal__ttl ${remaining < 60000 ? 'is-low' : ''}`}>
                    {expired ? 'Expired' : `Expires in ${mm}:${ss}`}
                </span>
            </div>
            <div className="qluster-token-reveal__value">
                <code>{result.enrollment_token}</code>
                <Button variant="outline" icon={copied ? <CheckIcon /> : <CopyIcon />} onClick={copy} disabled={expired}>
                    {copied ? 'Copied' : 'Copy'}
                </Button>
            </div>
            <p className="qluster-token-reveal__hint">
                Paste this into <strong>Qluster → Add / Enroll box</strong> on your controller. It is single-use and
                shown only once — if you lose it, generate a new one.
            </p>
            <div className="qluster-token-reveal__meta">
                <span>Scopes: {(result.scopes || []).join(', ') || 'node.read'}</span>
                <span>Allowed orgs: {(result.allowed_orgs || []).length ? result.allowed_orgs.join(', ') : 'none (backups deny-all)'}</span>
                <button className="qluster-linkbtn" onClick={onDismiss}>Dismiss</button>
            </div>
        </div>
    );
}

export default function QlusterSettings({ isAdmin = true }) {
    const { orgs = [] } = useWorkspace();

    // Generate form state
    const [name, setName] = useState('');
    const [scopes, setScopes] = useState(['node.read']);
    const [allowedOrgs, setAllowedOrgs] = useState([]);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [genError, setGenError] = useState(null);
    const [tokenResult, setTokenResult] = useState(null);

    // Controllers list state
    const [controllers, setControllers] = useState([]);
    const [loadingList, setLoadingList] = useState(true);
    const [listError, setListError] = useState(null);
    const [revokingId, setRevokingId] = useState(null);

    // QLUSTER-LOOP-B box-operator control: "require my approval for delegated
    // tasks". Reads/writes /collector/api/v1/qluster/settings/require-approval.
    const [requireApproval, setRequireApproval] = useState(false);
    const [loadingApproval, setLoadingApproval] = useState(true);
    const [savingApproval, setSavingApproval] = useState(false);
    const [approvalError, setApprovalError] = useState(null);

    const mounted = useRef(true);

    useEffect(() => () => { mounted.current = false; }, []);

    const loadControllers = useCallback(async () => {
        setLoadingList(true);
        setListError(null);
        try {
            const res = await fetch(`${COLLECTOR}/controllers`, { credentials: 'include' });
            if (!res.ok) { setListError(await humanError(res)); setControllers([]); return; }
            const data = await res.json();
            if (mounted.current) setControllers(Array.isArray(data.controllers) ? data.controllers : []);
        } catch {
            if (mounted.current) setListError('Could not reach the box (network error). Is the collector running?');
        } finally {
            if (mounted.current) setLoadingList(false);
        }
    }, []);

    useEffect(() => { loadControllers(); }, [loadControllers]);

    const loadRequireApproval = useCallback(async () => {
        setLoadingApproval(true);
        setApprovalError(null);
        try {
            const res = await fetch(`${COLLECTOR}/settings/require-approval`, { credentials: 'include' });
            if (!res.ok) { setApprovalError(await humanError(res)); return; }
            const data = await res.json();
            if (mounted.current) setRequireApproval(!!data.require_approval);
        } catch {
            if (mounted.current) setApprovalError('Could not reach the box (network error). Is the collector running?');
        } finally {
            if (mounted.current) setLoadingApproval(false);
        }
    }, []);

    useEffect(() => { loadRequireApproval(); }, [loadRequireApproval]);

    const updateRequireApproval = async (next) => {
        const prev = requireApproval;
        setRequireApproval(next); // optimistic
        setSavingApproval(true);
        setApprovalError(null);
        try {
            const res = await csrfFetch(`${COLLECTOR}/settings/require-approval`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ require_approval: next }),
            });
            if (!res.ok) {
                setApprovalError(await humanError(res));
                if (mounted.current) setRequireApproval(prev); // revert on failure
                return;
            }
            const data = await res.json();
            if (mounted.current) setRequireApproval(!!data.require_approval);
        } catch {
            if (mounted.current) {
                setApprovalError('Could not reach the box (network error). Is the collector running?');
                setRequireApproval(prev); // revert on failure
            }
        } finally {
            if (mounted.current) setSavingApproval(false);
        }
    };

    const toggleScope = (id) => {
        if (id === 'node.read') return; // locked on
        setScopes((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]);
    };
    const selectPreset = (preset) => {
        setScopes(preset.scopes);
    };
    // Highlight the preset that matches the current scope selection exactly;
    // null means the operator has hand-tuned scopes away from any preset.
    const activePresetId = useMemo(() => {
        const cur = [...scopes].sort().join(',');
        const match = PRESETS.find((p) => [...p.scopes].sort().join(',') === cur);
        return match ? match.id : null;
    }, [scopes]);
    const toggleOrg = (id) => {
        setAllowedOrgs((prev) => prev.includes(id) ? prev.filter((o) => o !== id) : [...prev, id]);
    };

    const generate = async () => {
        setGenerating(true);
        setGenError(null);
        setTokenResult(null);
        try {
            const res = await csrfFetch(`${COLLECTOR}/enroll/issue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: name.trim() || null,
                    scopes,
                    allowed_orgs: allowedOrgs,
                }),
            });
            if (!res.ok) { setGenError(await humanError(res)); return; }
            const data = await res.json();
            if (mounted.current) {
                setTokenResult(data);
                setName('');
            }
        } catch {
            if (mounted.current) setGenError('Could not reach the box (network error). Is the collector running?');
        } finally {
            if (mounted.current) setGenerating(false);
        }
    };

    const revoke = async (ctrl) => {
        if (!window.confirm(`Revoke "${ctrl.name || ctrl.id}"? The controller loses access within ~60s.`)) return;
        setRevokingId(ctrl.id);
        try {
            const res = await csrfFetch(`${COLLECTOR}/controllers/${encodeURIComponent(ctrl.id)}/revoke`, { method: 'POST' });
            if (!res.ok) { setListError(await humanError(res)); return; }
            await loadControllers();
        } catch {
            setListError('Could not reach the box (network error).');
        } finally {
            if (mounted.current) setRevokingId(null);
        }
    };

    return (
        <div className="qluster-settings">
            <SettingsSection
                title="Qluster fleet enrollment"
                description="Connect an external Qluster controller to this box. Generate an enrollment token below and paste it into Qluster — no terminal required."
            >
                {!isAdmin && (
                    <div className="qluster-notice qluster-notice--warn">
                        You are viewing this in read-only mode. You need admin role on this box to generate or revoke tokens.
                    </div>
                )}

                <SettingsCard title="Generate enrollment token" icon={<KeyIcon />}
                    subtitle="Single-use · valid 15 minutes · shown once">
                    <div className="qluster-field">
                        <label className="qluster-label" htmlFor="qluster-ctrl-name">Controller name</label>
                        <input
                            id="qluster-ctrl-name"
                            className="qluster-input"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. ops-controller-1"
                            disabled={!isAdmin || generating}
                        />
                    </div>

                    <div className="qluster-field">
                        <span className="qluster-label">Capability preset</span>
                        <div className="qluster-presets" role="radiogroup" aria-label="Capability preset">
                            {PRESETS.map((p) => (
                                <button
                                    key={p.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={activePresetId === p.id}
                                    className={`qluster-preset ${activePresetId === p.id ? 'is-active' : ''}`}
                                    onClick={() => selectPreset(p)}
                                    disabled={!isAdmin || generating}
                                >
                                    <RadioIcon checked={activePresetId === p.id} />
                                    <span className="qluster-preset__body">
                                        <span className="qluster-preset__label">{p.label}</span>
                                        <span className="qluster-preset__hint">{p.hint}</span>
                                    </span>
                                </button>
                            ))}
                        </div>

                        <button
                            type="button"
                            className="qluster-advanced-toggle"
                            onClick={() => setShowAdvanced((v) => !v)}
                        >
                            <ChevronIcon open={showAdvanced} />
                            {showAdvanced ? 'Hide advanced scopes' : (activePresetId ? 'Advanced: fine-tune raw scopes' : 'Advanced: fine-tune raw scopes (custom mix in use)')}
                        </button>

                        {showAdvanced && (
                            <div className="qluster-scopes">
                                {SCOPES.map((s) => (
                                    <label key={s.id} className={`qluster-check ${s.locked ? 'is-locked' : ''}`}>
                                        <input
                                            type="checkbox"
                                            checked={s.locked ? true : scopes.includes(s.id)}
                                            disabled={s.locked || !isAdmin || generating}
                                            onChange={() => toggleScope(s.id)}
                                        />
                                        <span className="qluster-check__body">
                                            <span className="qluster-check__label">{s.label} <code>{s.id}</code></span>
                                            <span className="qluster-check__hint">{s.hint}</span>
                                        </span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="qluster-field">
                        <span className="qluster-label">Allowed organizations
                            <span className="qluster-label__aside"> (which orgs backups may touch — leave empty to deny all backups)</span>
                        </span>
                        {orgs.length === 0 ? (
                            <p className="qluster-empty-inline">No organizations available on your account.</p>
                        ) : (
                            <div className="qluster-orgs">
                                {orgs.map((o) => (
                                    <label key={o.id} className="qluster-orgchip">
                                        <input
                                            type="checkbox"
                                            checked={allowedOrgs.includes(o.id)}
                                            disabled={!isAdmin || generating}
                                            onChange={() => toggleOrg(o.id)}
                                        />
                                        <span>{o.name || o.slug || o.id}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    {genError && <div className="qluster-notice qluster-notice--error">{genError}</div>}

                    <div className="qluster-actions">
                        <Button variant="primary" icon={<KeyIcon />} onClick={generate}
                            disabled={!isAdmin || generating} loading={generating}>
                            {generating ? 'Generating…' : 'Generate token'}
                        </Button>
                    </div>

                    {tokenResult && (
                        <TokenReveal result={tokenResult} onDismiss={() => setTokenResult(null)} />
                    )}
                </SettingsCard>
            </SettingsSection>

            <SettingsSection
                title="Delegated task approvals"
                description="Control whether tasks another Quox delegates to this box need your sign-off, independent of any policy you've written."
            >
                <SettingsCard title="Require my approval for delegated tasks" icon={<ShieldIcon />}>
                    {approvalError && <div className="qluster-notice qluster-notice--error">{approvalError}</div>}
                    <label className={`qluster-toggle ${(!isAdmin || loadingApproval || savingApproval) ? 'is-disabled' : ''}`}>
                        <input
                            type="checkbox"
                            checked={requireApproval}
                            disabled={!isAdmin || loadingApproval || savingApproval}
                            onChange={(e) => updateRequireApproval(e.target.checked)}
                            aria-label="Require my approval for delegated tasks"
                        />
                        <span className="qluster-toggle__track"><span className="qluster-toggle__thumb" /></span>
                        <span className="qluster-toggle__body">
                            <span className="qluster-toggle__label">
                                Require my approval for delegated tasks
                                {loadingApproval && <span className="qluster-toggle__busy"> (loading…)</span>}
                                {savingApproval && <span className="qluster-toggle__busy"> (saving…)</span>}
                            </span>
                            <span className="qluster-toggle__hint">
                                When on, tasks another Quox delegates to this box wait for your approval in the inbox before running.
                            </span>
                        </span>
                    </label>
                </SettingsCard>
            </SettingsSection>

            <SettingsSection
                title="Enrolled controllers"
                description="Qluster controllers currently paired with this box."
                actions={
                    <Button variant="ghost" icon={<RefreshIcon />} onClick={loadControllers} disabled={loadingList}>
                        Refresh
                    </Button>
                }
            >
                <SettingsCard>
                    {listError && <div className="qluster-notice qluster-notice--error">{listError}</div>}

                    {loadingList ? (
                        <p className="qluster-empty">Loading controllers…</p>
                    ) : controllers.length === 0 && !listError ? (
                        <div className="qluster-empty-state">
                            <p>No controllers enrolled yet.</p>
                            <p className="qluster-empty-state__sub">Generate a token above and enroll a box from your Qluster controller to see it here.</p>
                        </div>
                    ) : controllers.length > 0 ? (
                        <div className="qluster-table-wrap">
                            <table className="qluster-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Scopes</th>
                                        <th>Allowed orgs</th>
                                        <th>Created</th>
                                        <th>Last seen</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {controllers.map((c) => (
                                        <tr key={c.id} className={c.revoked ? 'is-revoked' : ''}>
                                            <td>
                                                <span className="qluster-ctrl-name">{c.name || <em>unnamed</em>}</span>
                                                {c.revoked && <span className="qluster-tag qluster-tag--revoked">revoked</span>}
                                            </td>
                                            <td>{(c.scopes || []).map((s) => <code key={s} className="qluster-scopetag">{s}</code>)}</td>
                                            <td>{(c.allowed_orgs && c.allowed_orgs.length) ? c.allowed_orgs.join(', ') : <span className="qluster-muted">—</span>}</td>
                                            <td>{fmtDate(c.created_at)}</td>
                                            <td>{timeAgo(c.last_seen)}</td>
                                            <td className="qluster-table__actions">
                                                {!c.revoked && (
                                                    <Button variant="outline-red" icon={<TrashIcon />}
                                                        onClick={() => revoke(c)}
                                                        disabled={!isAdmin || revokingId === c.id}
                                                        loading={revokingId === c.id}>
                                                        Revoke
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                </SettingsCard>
            </SettingsSection>
        </div>
    );
}

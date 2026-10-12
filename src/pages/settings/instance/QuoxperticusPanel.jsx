/**
 * QuoxperticusPanel — QUOXPERTICUS Phase 1.
 *
 * Instance-wide controls for QUOXPERTICUS, the resident governed
 * agent: its operating mode, whether this instance is a disposable
 * test sandbox, and the short-lived synthetic test-approver lease.
 *
 * Every key here is human-admin-only. Agents and service keys cannot
 * write them (requireInstanceAdmin on PATCH /api/admin/config/:key).
 */

import { useState, useMemo, useEffect } from 'react';
import { useInstanceConfig } from '../../../hooks/useInstanceConfig.js';
import { Field, fieldsetStyle, legendStyle, saveButtonStyle, SaveStatus, inputStyle }
    from './instancePanelStyles.jsx';

const KEY_MODE     = 'instance.mode.quoxperticus';
const KEY_SANDBOX  = 'instance.disposable_test';
const KEY_LEASE    = 'instance.test_approver_lease_until';
const KEY_ORG_ID   = 'instance.quoxperticus.org_id';

const SPEC = [
    { key: KEY_MODE,    type: 'string',  default: 'OFF' },
    { key: KEY_SANDBOX, type: 'boolean', default: false },
    { key: KEY_LEASE,   type: 'string',  default: '' },
    { key: KEY_ORG_ID,  type: 'string',  default: '' },
];

const MODES = [
    { value: 'OFF',     label: 'Off',
      help: 'The resident agent is absent. Nothing runs and nothing is filed.' },
    { value: 'OBSERVE', label: 'Observe',
      help: 'Read only exercising. The agent drives surfaces and files findings, it changes nothing.' },
    { value: 'PARTIAL', label: 'Partial',
      help: 'Scoped low risk actions. Anything above that bar still waits for a human.' },
    { value: 'FULL',    label: 'Full',
      help: 'Autopilot. Honored only on a disposable test instance, a real instance caps it to Partial server side.' },
];

const LEASE_GRANTS = [
    { label: '30m', minutes: 30 },
    { label: '1h',  minutes: 60 },
    { label: '4h',  minutes: 240 },
];

const FULL_BLOCKED_NOTE =
    'FULL requires a disposable test instance; a real instance caps at PARTIAL.';

// ── Icons (inline SVG, 14px, currentColor) ─────────────────────────
const svgProps = {
    width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round', strokeLinejoin: 'round',
    style: { flexShrink: 0 },
};

const IconSave = () => (
    <svg {...svgProps} aria-hidden="true">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <polyline points="17 21 17 13 7 13 7 21" />
        <polyline points="7 3 7 8 15 8" />
    </svg>
);

const IconClock = () => (
    <svg {...svgProps} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15.5 14" />
    </svg>
);

const IconRevoke = () => (
    <svg {...svgProps} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <line x1="8.5" y1="8.5" x2="15.5" y2="15.5" />
        <line x1="15.5" y1="8.5" x2="8.5" y2="15.5" />
    </svg>
);

// ── Lease helpers ──────────────────────────────────────────────────
function leaseState(raw, now) {
    const value = (raw || '').trim();
    if (!value) return { kind: 'none' };
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return { kind: 'invalid', raw: value };
    return { kind: at.getTime() > now ? 'active' : 'expired', at };
}

function formatRemaining(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m left`;
    if (m > 0) return `${m}m ${s}s left`;
    return `${s}s left`;
}

const leaseButtonStyle = (disabled, tone) => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: tone === 'danger'
        ? 'rgba(248, 113, 113, 0.12)'
        : 'rgba(255,255,255,0.06)',
    color: tone === 'danger' ? 'var(--m-error, #f87171)' : 'inherit',
    border: `1px solid ${tone === 'danger'
        ? 'rgba(248, 113, 113, 0.45)'
        : 'var(--m-border-default, rgba(255,255,255,0.18))'}`,
    borderRadius: 8, padding: '8px 14px',
    fontSize: 13, fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    transition: 'opacity 0.15s ease',
});

export default function QuoxperticusPanel() {
    const cfg = useInstanceConfig(SPEC);
    const [draft, setDraft] = useState({});
    const [errors, setErrors] = useState({});
    const [now, setNow] = useState(() => Date.now());

    // Display-only tick so the "left" countdown stays honest while the
    // panel is open. No scheduled work hangs off this.
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    const v = useMemo(() => ({ ...cfg.values, ...draft }), [cfg.values, draft]);

    if (cfg.loading) return <div style={{ padding: 24, opacity: 0.6 }}>Loading Quoxperticus controls…</div>;
    if (cfg.error && Object.keys(cfg.values).length === 0) {
        return (
            <div style={{ padding: 24 }}>
                <h2 style={{ marginTop: 0 }}>Quoxperticus Agent</h2>
                <p style={{ color: 'var(--m-error, #f87171)' }}>Failed to load: {cfg.error}</p>
            </div>
        );
    }

    const sandbox   = !!v[KEY_SANDBOX];
    const orgId     = (v[KEY_ORG_ID] || '').trim();
    const mode      = v[KEY_MODE] || 'OFF';
    const capped    = mode === 'FULL' && !sandbox;
    const effective = capped ? 'PARTIAL' : mode;
    const lease     = leaseState(v[KEY_LEASE], now);
    const leaseLive = lease.kind === 'active' && sandbox;

    const onSubmit = async (e) => {
        e.preventDefault();
        const errs = {};
        if (!MODES.some(m => m.value === mode)) errs.mode = 'Pick a known mode.';
        if (mode === 'FULL' && !sandbox) errs.mode = FULL_BLOCKED_NOTE;
        setErrors(errs);
        if (Object.keys(errs).length) return;
        try {
            await cfg.save(draft);
            setDraft({});
        } catch (err) {
            setErrors({ submit: err.message });
        }
    };

    // Lease writes apply straight away: an ISO instant computed now and
    // saved ten minutes later would be a lie about when it expires.
    const writeLease = async (value) => {
        setErrors({});
        try {
            await cfg.save({ [KEY_LEASE]: value });
            setDraft(d => {
                const next = { ...d };
                delete next[KEY_LEASE];
                return next;
            });
        } catch (err) {
            setErrors({ lease: err.message });
        }
    };

    const grant  = (minutes) => writeLease(new Date(Date.now() + minutes * 60_000).toISOString());
    const revoke = () => writeLease('');

    return (
        <form onSubmit={onSubmit} noValidate style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Quoxperticus Agent</h2>
            <p style={{ opacity: 0.7, marginBottom: 24 }}>
                QUOXPERTICUS is the resident governed agent: it lives on this
                instance, exercises it, and files what it finds. Every control
                on this page is human admin only. Agents and service keys
                cannot write these keys, so the agent can never widen its own
                permissions.
            </p>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Org binding</legend>

                <Field id="org-id" label="Org ID"
                    help="Find an org id under Settings > Organization, or in the org switcher.">
                    <input id="org-id" type="text" style={inputStyle}
                        value={v[KEY_ORG_ID] || ''}
                        placeholder="org_..."
                        onChange={(e) => setDraft(d => ({ ...d, [KEY_ORG_ID]: e.target.value }))} />
                </Field>

                <p style={{ margin: '0 0 8px', opacity: 0.7, fontSize: 13 }}>
                    The org QUOXPERTICUS patrols under on this instance. While
                    unbound, the wake seam refuses to create patrol
                    objectives, so the resident agent cannot run.
                </p>

                {!orgId && (
                    <p style={{ margin: 0, fontSize: 12, opacity: 0.6 }} role="status">
                        Unbound: wakes are refused.
                    </p>
                )}
            </fieldset>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Operating mode</legend>

                {MODES.map(m => {
                    const blocked = m.value === 'FULL' && !sandbox;
                    return (
                        <div key={m.value} style={{ marginBottom: 14, opacity: blocked ? 0.55 : 1 }}>
                            <label htmlFor={`mode-${m.value}`} style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                fontSize: 13, fontWeight: 500,
                                color: 'var(--m-text-primary, rgba(255,255,255,0.85))',
                                cursor: blocked ? 'not-allowed' : 'pointer',
                            }}>
                                <input id={`mode-${m.value}`} type="radio" name="quoxperticus-mode"
                                    value={m.value} disabled={blocked}
                                    checked={mode === m.value}
                                    onChange={() => setDraft(d => ({ ...d, [KEY_MODE]: m.value }))} />
                                {m.label}
                            </label>
                            <p style={{ margin: '4px 0 0 24px', opacity: 0.6, fontSize: 12 }}>{m.help}</p>
                            {blocked && (
                                <p style={{ margin: '4px 0 0 24px', fontSize: 12, color: 'var(--m-warning, #ffb347)' }}>
                                    {FULL_BLOCKED_NOTE}
                                </p>
                            )}
                        </div>
                    );
                })}

                {capped && (
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--m-warning, #ffb347)' }} role="status">
                        Stored mode is FULL, effective mode on this instance is {effective}.
                    </p>
                )}
                {errors.mode && (
                    <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--m-error, #f87171)' }} role="alert">
                        {errors.mode}
                    </p>
                )}
            </fieldset>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Disposable test instance</legend>

                <Field id="disposable" label="Mark this entire instance as a throwaway sandbox"
                    help="Turn this on only where no real data lives. It declares that the whole instance is expendable, and it is the single precondition for the approval relaxation below and for FULL mode. Never enable it on an instance holding customer, evidence or production data.">
                    <input id="disposable" type="checkbox"
                        checked={sandbox}
                        onChange={(e) => setDraft(d => ({ ...d, [KEY_SANDBOX]: e.target.checked }))} />
                </Field>

                {sandbox && (
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--m-warning, #ffb347)' }} role="status">
                        This instance is currently declared disposable. Treat everything in it as discardable.
                    </p>
                )}
            </fieldset>

            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Test-approver lease</legend>

                <p style={{ margin: '0 0 12px', opacity: 0.7, fontSize: 13 }}>
                    While a lease is unexpired and this instance is disposable,
                    the collector may perform sandbox approvals on its own.
                    Those approvals are recorded as <code>synthetic:test-approver</code>,
                    never as a human. Leases run for minutes to hours and they
                    expire on purpose.
                </p>

                <p style={{ margin: '0 0 4px', fontSize: 13 }} aria-live="polite">
                    {lease.kind === 'none'    && <span style={{ opacity: 0.75 }}>No lease. Sandbox approvals are not available.</span>}
                    {lease.kind === 'invalid' && <span style={{ color: 'var(--m-error, #f87171)' }}>Stored lease is not a valid instant: {lease.raw}</span>}
                    {lease.kind === 'active'  && (
                        <span style={{ color: 'var(--m-success, #34d399)' }}>
                            Active until {lease.at.toLocaleString()} ({formatRemaining(lease.at.getTime() - now)}).
                        </span>
                    )}
                    {lease.kind === 'expired' && (
                        <span style={{ opacity: 0.75 }}>Expired at {lease.at.toLocaleString()}.</span>
                    )}
                </p>

                {lease.kind === 'active' && !sandbox && (
                    <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--m-warning, #ffb347)' }}>
                        The lease has no effect while this instance is not marked disposable.
                    </p>
                )}
                {leaseLive && (
                    <p style={{ margin: '0 0 8px', fontSize: 12, opacity: 0.6 }}>
                        Sandbox approvals are live right now.
                    </p>
                )}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    {LEASE_GRANTS.map(g => (
                        <button key={g.label} type="button" disabled={cfg.saving}
                            onClick={() => grant(g.minutes)}
                            style={leaseButtonStyle(cfg.saving)}>
                            <IconClock />
                            Grant {g.label}
                        </button>
                    ))}
                    <button type="button" disabled={cfg.saving || lease.kind === 'none'}
                        onClick={revoke}
                        style={leaseButtonStyle(cfg.saving || lease.kind === 'none', 'danger')}>
                        <IconRevoke />
                        Revoke lease
                    </button>
                </div>

                <p style={{ margin: '10px 0 0', opacity: 0.6, fontSize: 12 }}>
                    Lease changes are written immediately, they do not wait for Save changes.
                </p>
                {errors.lease && (
                    <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--m-error, #f87171)' }} role="alert">
                        {errors.lease}
                    </p>
                )}
            </fieldset>

            <SaveStatus savedAt={cfg.savedAt} error={errors.submit || cfg.error} />

            <button type="submit" disabled={cfg.saving}
                style={{ ...saveButtonStyle(cfg.saving), display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <IconSave />
                {cfg.saving ? 'Saving…' : 'Save changes'}
            </button>
        </form>
    );
}

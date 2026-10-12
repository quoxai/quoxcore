/**
 * AuthSessionsPanel — SET-IA Phase 4a.
 *
 * Structured replacement for the five auth.* keys that today are
 * editable only via the raw key/value table at /admin/config:
 *
 *   - auth.session_idle_minutes         (1..43200, cap = 30 days)
 *   - auth.session_max_minutes          (1..129600, cap = 90 days)
 *   - auth.allow_signup                 (boolean)
 *   - auth.require_email_verification   (boolean)
 *   - auth.allowed_email_domains        (json array of strings)
 *
 * Caps mirror INSTANCE_SESSION_POLICY_BOUNDS in
 * services/auth/utils/sessionPolicy.js — keep in sync.
 *
 * Reads via GET /api/admin/config (returns the full table) and
 * writes via PATCH /api/admin/config/:key. Each field is a separate
 * round-trip on save; partial failures surface per-field.
 */

import { useEffect, useState } from 'react';
import { csrfFetch } from '../../../utils/csrfFetch';

const AUTH_API = '/api';

const KEY = {
    IDLE:    'auth.session_idle_minutes',
    MAX:     'auth.session_max_minutes',
    SIGNUP:  'auth.allow_signup',
    VERIFY:  'auth.require_email_verification',
    DOMAINS: 'auth.allowed_email_domains',
};

// Mirror of INSTANCE_SESSION_POLICY_BOUNDS in sessionPolicy.js.
// Defence in depth — backend clamps too, but UI prevents most foot-guns.
export const BOUNDS = Object.freeze({
    idleMin: 1,
    idleMax: 30 * 24 * 60,    // 43200 minutes (30 days)
    maxMin:  1,
    maxMax:  90 * 24 * 60,    // 129600 minutes (90 days)
});

function parseBoolean(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

function parseDomainsJson(v) {
    if (Array.isArray(v)) return v;
    if (typeof v !== 'string') return [];
    try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function domainsToText(arr) {
    return (arr || []).join('\n');
}

function textToDomains(text) {
    return (text || '')
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean);
}

export default function AuthSessionsPanel() {
    const [loading, setLoading]     = useState(true);
    const [saving, setSaving]       = useState(false);
    const [loadError, setLoadError] = useState(null);
    const [fieldErrors, setFieldErrors] = useState({});
    const [savedAt, setSavedAt]     = useState(null);

    const [form, setForm] = useState({
        idle:    30,
        max:     720,
        signup:  true,
        verify:  true,
        domains: '',
    });
    // TRUST-GATE-1.14 — 0 is the explicit "disabled" / "no limit" value for
    // idle/max, at both instance and org level (see sessionPolicy.js). These
    // track the checkbox state separately from `form.idle`/`form.max` so
    // toggling "disable" off restores the last value the admin had entered
    // instead of leaving 0 in the number input.
    const [idleDisabled, setIdleDisabled] = useState(false);
    const [maxDisabled, setMaxDisabled]   = useState(false);

    useEffect(() => {
        let live = true;
        (async () => {
            try {
                const res = await fetch(`${AUTH_API}/admin/config`, { credentials: 'include' });
                if (!res.ok) throw new Error(`Failed to load config (${res.status})`);
                const { config = [] } = await res.json();
                if (!live) return;
                const lookup = Object.fromEntries(config.map(c => [c.key, c.value]));

                // 0 is an explicit "disabled" value, distinct from unset
                // (NaN → falls back to the default). Number.isFinite lets
                // 0 through where `|| 30` previously would have masked it.
                const idleRaw = Number.parseInt(lookup[KEY.IDLE], 10);
                const maxRaw  = Number.parseInt(lookup[KEY.MAX], 10);
                const idleVal = Number.isFinite(idleRaw) ? idleRaw : 30;
                const maxVal  = Number.isFinite(maxRaw) ? maxRaw : 720;

                setIdleDisabled(idleVal === 0);
                setMaxDisabled(maxVal === 0);
                setForm({
                    idle:    idleVal || 30,
                    max:     maxVal || 720,
                    signup:  parseBoolean(lookup[KEY.SIGNUP]),
                    verify:  parseBoolean(lookup[KEY.VERIFY]),
                    domains: domainsToText(parseDomainsJson(lookup[KEY.DOMAINS])),
                });
                setLoadError(null);
            } catch (err) {
                if (live) setLoadError(err.message);
            } finally {
                if (live) setLoading(false);
            }
        })();
        return () => { live = false; };
    }, []);

    const validate = () => {
        const errs = {};
        // 0 (disabled) bypasses the min/max bounds entirely — those bounds
        // only apply when the timeout is actually enforced.
        if (!idleDisabled && (!Number.isInteger(form.idle) || form.idle < BOUNDS.idleMin || form.idle > BOUNDS.idleMax)) {
            errs.idle = `Idle timeout must be ${BOUNDS.idleMin}–${BOUNDS.idleMax} minutes.`;
        }
        if (!maxDisabled && (!Number.isInteger(form.max) || form.max < BOUNDS.maxMin || form.max > BOUNDS.maxMax)) {
            errs.max = `Max session must be ${BOUNDS.maxMin}–${BOUNDS.maxMax} minutes.`;
        }
        const domains = textToDomains(form.domains);
        const badDomain = domains.find(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d));
        if (badDomain) errs.domains = `Not a valid domain: ${badDomain}`;
        return errs;
    };

    const patchKey = async (key, value) => {
        const res = await csrfFetch(`${AUTH_API}/admin/config/${key}`, {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ value }),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || data.error || `PATCH ${key} failed (${res.status})`);
        }
    };

    const handleSave = async (e) => {
        e?.preventDefault();
        const errs = validate();
        setFieldErrors(errs);
        if (Object.keys(errs).length) return;

        setSaving(true);
        setSavedAt(null);
        try {
            const domains = textToDomains(form.domains);
            await Promise.all([
                patchKey(KEY.IDLE,    String(idleDisabled ? 0 : form.idle)),
                patchKey(KEY.MAX,     String(maxDisabled  ? 0 : form.max)),
                patchKey(KEY.SIGNUP,  String(!!form.signup)),
                patchKey(KEY.VERIFY,  String(!!form.verify)),
                patchKey(KEY.DOMAINS, JSON.stringify(domains)),
            ]);
            setSavedAt(new Date());
            setFieldErrors({});
        } catch (err) {
            setFieldErrors({ submit: err.message });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <div style={{ padding: 24, opacity: 0.6 }}>Loading auth & session settings…</div>;
    }

    if (loadError) {
        return (
            <div style={{ padding: 24 }}>
                <h2 style={{ marginTop: 0 }}>Auth &amp; Sessions</h2>
                <p style={{ color: '#f87171' }}>Failed to load: {loadError}</p>
            </div>
        );
    }

    return (
        // noValidate: rely on the JS validate() pass instead of HTML5
        // tooltips, so we can render inline errors with role="alert".
        <form onSubmit={handleSave} noValidate style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Auth &amp; Sessions</h2>
            <p style={{ opacity: 0.7, marginBottom: 24 }}>
                Instance-wide authentication and session lifetime policy. Per-org
                overrides (when present) win over these defaults.
            </p>

            <fieldset style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <legend style={{ padding: '0 8px', opacity: 0.85 }}>Session lifetime</legend>

                <Field
                    id="idle"
                    label="Idle timeout (minutes)"
                    help={`Session expires after this many minutes with no activity. ${BOUNDS.idleMin}–${BOUNDS.idleMax} (cap: 30 days).`}
                    error={fieldErrors.idle}
                >
                    <input
                        id="idle" type="number" min={BOUNDS.idleMin} max={BOUNDS.idleMax}
                        value={form.idle}
                        disabled={idleDisabled}
                        onChange={(e) => setForm(f => ({ ...f, idle: Number.parseInt(e.target.value, 10) || 0 }))}
                        style={{ ...inputStyle, opacity: idleDisabled ? 0.5 : 1 }}
                    />
                </Field>

                <label style={checkboxRowStyle} htmlFor="idle-disabled">
                    <input
                        id="idle-disabled" type="checkbox"
                        checked={idleDisabled}
                        onChange={(e) => setIdleDisabled(e.target.checked)}
                    />
                    <span>Disable idle logout (sessions are never expired for inactivity)</span>
                </label>

                <Field
                    id="max"
                    label="Maximum session length (minutes)"
                    help={`Absolute lifetime cap regardless of activity. ${BOUNDS.maxMin}–${BOUNDS.maxMax} (cap: 90 days).`}
                    error={fieldErrors.max}
                >
                    <input
                        id="max" type="number" min={BOUNDS.maxMin} max={BOUNDS.maxMax}
                        value={form.max}
                        disabled={maxDisabled}
                        onChange={(e) => setForm(f => ({ ...f, max: Number.parseInt(e.target.value, 10) || 0 }))}
                        style={{ ...inputStyle, opacity: maxDisabled ? 0.5 : 1 }}
                    />
                </Field>

                <label style={checkboxRowStyle} htmlFor="max-disabled">
                    <input
                        id="max-disabled" type="checkbox"
                        checked={maxDisabled}
                        onChange={(e) => setMaxDisabled(e.target.checked)}
                    />
                    <span>No absolute session limit (sessions never expire by age)</span>
                </label>

                {(idleDisabled || maxDisabled) && (
                    <p style={{ margin: '8px 0 0', padding: '8px 10px', fontSize: 12, lineHeight: 1.5, color: '#fde68a', background: 'rgba(217,119,6,0.12)', border: '1px solid rgba(217,119,6,0.35)', borderRadius: 6 }}>
                        Disabling {idleDisabled && maxDisabled ? 'both limits' : idleDisabled ? 'idle logout' : 'the absolute session limit'} weakens
                        this instance's session security posture — a stolen or leaked session cookie
                        stays valid indefinitely{idleDisabled ? ' until revoked' : ''}. This applies to every org without its own override.
                    </p>
                )}
            </fieldset>

            <fieldset style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <legend style={{ padding: '0 8px', opacity: 0.85 }}>Signup policy</legend>

                <Field id="signup" label="Allow public signups"
                    help="If off, accounts are created via invite only.">
                    <input id="signup" type="checkbox"
                        checked={form.signup}
                        onChange={(e) => setForm(f => ({ ...f, signup: e.target.checked }))} />
                </Field>

                <Field id="verify" label="Require email verification"
                    help="New accounts must verify their email before logging in.">
                    <input id="verify" type="checkbox"
                        checked={form.verify}
                        onChange={(e) => setForm(f => ({ ...f, verify: e.target.checked }))} />
                </Field>

                <Field
                    id="domains"
                    label="Allowed email domains"
                    help="One domain per line. Empty list allows any domain."
                    error={fieldErrors.domains}
                >
                    <textarea
                        id="domains" rows={4}
                        value={form.domains}
                        onChange={(e) => setForm(f => ({ ...f, domains: e.target.value }))}
                        style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
                        placeholder="example.com&#10;company.io"
                    />
                </Field>
            </fieldset>

            {fieldErrors.submit && (
                <p style={{ color: '#f87171' }}>{fieldErrors.submit}</p>
            )}
            {savedAt && (
                <p style={{ color: '#34d399' }} aria-live="polite">
                    Saved at {savedAt.toLocaleTimeString()}.
                </p>
            )}

            <button
                type="submit" disabled={saving}
                style={{
                    background: '#38bdf8', color: '#0b1220', border: 'none',
                    borderRadius: 6, padding: '10px 20px', fontWeight: 600,
                    cursor: saving ? 'progress' : 'pointer', opacity: saving ? 0.7 : 1,
                }}
            >
                {saving ? 'Saving…' : 'Save changes'}
            </button>
        </form>
    );
}

const inputStyle = {
    width: '100%', maxWidth: 360, padding: '8px 10px',
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6, color: 'inherit', fontSize: 14,
};

const checkboxRowStyle = {
    display: 'flex', alignItems: 'center', gap: 8,
    marginBottom: 16, fontSize: 13, opacity: 0.85, cursor: 'pointer',
};

function Field({ id, label, help, error, children }) {
    return (
        <div style={{ marginBottom: 16 }}>
            <label htmlFor={id} style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>{label}</label>
            {children}
            {help && <p style={{ margin: '4px 0 0', opacity: 0.6, fontSize: 12 }}>{help}</p>}
            {error && <p style={{ margin: '4px 0 0', color: '#f87171', fontSize: 12 }} role="alert">{error}</p>}
        </div>
    );
}

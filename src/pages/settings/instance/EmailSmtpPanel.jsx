/**
 * EmailSmtpPanel — SET-IA Phase 4b, rewritten against the dedicated
 * email admin API (commit 901095f3).
 *
 * SMTP is a product onboarding surface, not a creds handoff: the
 * status endpoint only ever returns host + from (never the stored
 * password), and every write re-sends the full connection details.
 * Leaving the password field blank on save keeps the stored value.
 *
 *   GET  /api/admin/email/status  -> { configured, host, from, last_test }
 *   PUT  /api/admin/email/smtp    -> { success } | 400 { fields: {...} }
 *   POST /api/admin/email/test    -> { delivered, reason?, message_id?, status }
 */

import { useCallback, useEffect, useState } from 'react';
import { csrfFetch } from '../../../utils/csrfFetch.js';
import { Field, inputStyle, fieldsetStyle, legendStyle, saveButtonStyle, SaveStatus }
    from './instancePanelStyles.jsx';

const AUTH_API = '/api';

const DEFAULT_DRAFT = {
    host: '', port: 587, user: '', from: '', secure: true,
};

function formatWhen(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export default function EmailSmtpPanel() {
    const [status, setStatus]     = useState(null);
    const [statusLoading, setSL]  = useState(true);
    const [statusError, setSE]    = useState(null); // { kind: 'forbidden' | 'error', message }

    const [draft, setDraft]       = useState(DEFAULT_DRAFT);
    const [password, setPassword] = useState('');
    const [errors, setErrors]     = useState({});
    const [saving, setSaving]     = useState(false);
    const [savedAt, setSavedAt]   = useState(null);

    const [testing, setTesting]     = useState(false);
    const [testResult, setTestResult] = useState(null);

    const loadStatus = useCallback(async () => {
        setSL(true);
        try {
            const res = await fetch(`${AUTH_API}/admin/email/status`, { credentials: 'include' });
            if (res.status === 401 || res.status === 403) {
                setSE({ kind: 'forbidden', message: 'You do not have permission to view email status.' });
                setStatus(null);
                return;
            }
            if (!res.ok) throw new Error(`Failed to load email status (${res.status})`);
            const data = await res.json();
            setStatus(data);
            setSE(null);
            // Prefill the non-sensitive fields we do get back so the form
            // isn't blank after a page reload.
            setDraft(d => ({ ...d, host: data.host || d.host, from: data.from || d.from, user: data.user || d.user }));
        } catch (err) {
            setSE({ kind: 'error', message: err.message });
        } finally {
            setSL(false);
        }
    }, []);

    useEffect(() => { loadStatus(); }, [loadStatus]);

    const validate = () => {
        const errs = {};
        if (draft.host && !/^[a-z0-9.-]+$/i.test(draft.host)) errs.host = 'Host must be a hostname.';
        if (draft.port != null && (draft.port < 1 || draft.port > 65535)) errs.port = 'Port must be 1-65535.';
        if (draft.from && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.from)) errs.from = 'From must be a valid email address.';
        return errs;
    };

    const onSubmit = async (e) => {
        e.preventDefault();
        const errs = validate();
        setErrors(errs);
        if (Object.keys(errs).length) return;

        setSaving(true);
        setSavedAt(null);
        try {
            const body = {
                host: draft.host, port: draft.port, user: draft.user,
                from: draft.from, secure: draft.secure,
            };
            // Blank password keeps the stored one server-side.
            if (password) body.pass = password;

            const res = await csrfFetch(`${AUTH_API}/admin/email/smtp`, {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (data.fields) { setErrors(data.fields); return; }
                throw new Error(data.message || data.error || `Save failed (${res.status})`);
            }
            setPassword('');
            setSavedAt(new Date());
            setTestResult(null);
            await loadStatus();
        } catch (err) {
            setErrors({ submit: err.message });
        } finally {
            setSaving(false);
        }
    };

    const onSendTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const res = await csrfFetch(`${AUTH_API}/admin/email/test`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({}),
            });
            const data = await res.json().catch(() => ({}));
            setTestResult(data);
            await loadStatus();
        } catch (err) {
            setTestResult({ delivered: false, reason: err.message });
        } finally {
            setTesting(false);
        }
    };

    if (statusLoading) return <div style={{ padding: 24, opacity: 0.6 }}>Loading email status...</div>;

    if (statusError && statusError.kind === 'forbidden') {
        return (
            <div style={{ padding: 24 }}>
                <h2 style={{ marginTop: 0 }}>Email &amp; SMTP</h2>
                <p style={{ color: '#f59e0b' }}>{statusError.message}</p>
            </div>
        );
    }

    const configured = !!status?.configured;
    const lastTest = status?.last_test;

    return (
        <div style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>Email &amp; SMTP</h2>

            <StatusChip configured={configured} host={status?.host} from={status?.from} />

            {lastTest && (
                <p style={{ fontSize: 13, marginTop: 8, color: lastTest.ok ? '#34d399' : '#f87171' }}>
                    {lastTest.ok
                        ? `Last test: delivered ${formatWhen(lastTest.at)}.`
                        : `Last test failed (${formatWhen(lastTest.at)}): ${lastTest.detail || 'no detail given'}.`}
                </p>
            )}

            {configured && status?.source === 'vault' && (
                <p style={{ fontSize: 13, marginTop: 4, opacity: 0.6 }}>Stored in QuoxVault.</p>
            )}
            {configured && status?.source === 'instance_config' && (
                <p style={{ fontSize: 13, marginTop: 4, opacity: 0.6 }}>
                    Stored in the instance config. Will move to QuoxVault on the next service restart.
                </p>
            )}

            <p style={{ opacity: 0.75, margin: '16px 0 24px', lineHeight: 1.5 }}>
                This one setup powers every email this instance sends: sign-in verification, password
                reset, and invitation emails, QuoxChat transcripts delivered to visitors, demo booking
                confirmations, and team notifications and alerts for handoffs (HITL) and inbox activity.
                There is no separate email configuration elsewhere. Credentials are stored encrypted in
                QuoxVault. Nothing sends until this is configured and tested.
            </p>

            {statusError && statusError.kind === 'error' && (
                <p style={{ color: '#f87171', fontSize: 13, marginBottom: 16 }} role="alert">{statusError.message}</p>
            )}

            <form onSubmit={onSubmit} noValidate>
                <fieldset style={fieldsetStyle}>
                    <legend style={legendStyle}>Server</legend>

                    <Field id="host" label="SMTP host" error={errors.host}>
                        <input id="host" type="text" style={inputStyle} value={draft.host}
                            onChange={(e) => setDraft(d => ({ ...d, host: e.target.value }))} />
                    </Field>

                    <Field id="port" label="Port" help="Typically 587 (STARTTLS) or 465 (TLS)." error={errors.port}>
                        <input id="port" type="number" style={inputStyle} value={draft.port}
                            onChange={(e) => setDraft(d => ({ ...d, port: Number.parseInt(e.target.value, 10) || 0 }))} />
                    </Field>

                    <Field id="secure" label="Use TLS" help="STARTTLS upgrade for port 587, direct TLS for 465.">
                        <input id="secure" type="checkbox" checked={!!draft.secure}
                            onChange={(e) => setDraft(d => ({ ...d, secure: e.target.checked }))} />
                    </Field>
                </fieldset>

                <fieldset style={fieldsetStyle}>
                    <legend style={legendStyle}>Authentication</legend>

                    <Field id="user" label="Username">
                        <input id="user" type="text" style={inputStyle} value={draft.user}
                            onChange={(e) => setDraft(d => ({ ...d, user: e.target.value }))} />
                    </Field>

                    <Field id="password" label="Password" help="Never shown back once saved. Leave blank to keep the existing value.">
                        <input id="password" type="password" style={inputStyle} value={password}
                            autoComplete="new-password"
                            placeholder={configured ? '••••••••' : ''}
                            onChange={(e) => setPassword(e.target.value)} />
                    </Field>

                    <Field id="from" label="From address" error={errors.from}
                        help="The address visitors and users see mail arrive from.">
                        <input id="from" type="email" style={inputStyle} value={draft.from}
                            onChange={(e) => setDraft(d => ({ ...d, from: e.target.value }))} />
                    </Field>
                </fieldset>

                <SaveStatus savedAt={savedAt} error={errors.submit} />

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                    <button type="submit" disabled={saving} style={saveButtonStyle(saving)}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" style={{ flexShrink: 0 }}>
                                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
                                <path d="M17 21v-8H7v8M7 3v5h8" />
                            </svg>
                            {saving ? 'Saving...' : 'Save changes'}
                        </span>
                    </button>

                    <button type="button" onClick={onSendTest} disabled={!configured || testing}
                        title={configured ? 'Send a test email using the saved settings' : 'Save and configure email before testing'}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            background: 'rgba(255,255,255,0.05)',
                            border: '1px solid rgba(255,255,255,0.16)',
                            borderRadius: 8, padding: '10px 16px',
                            color: !configured ? 'rgba(255,255,255,0.35)' : '#fff',
                            fontSize: 13, fontWeight: 600,
                            cursor: (!configured || testing) ? 'not-allowed' : 'pointer',
                            opacity: testing ? 0.7 : 1,
                        }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                            <path d="M22 2 11 13" />
                            <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
                        </svg>
                        {testing ? 'Sending...' : 'Send test email'}
                    </button>
                </div>
            </form>

            {testResult && (
                <p style={{
                    marginTop: 16, fontSize: 13,
                    color: testResult.delivered ? '#34d399' : '#f87171',
                }} role="status">
                    {testResult.delivered
                        ? `Test email delivered${testResult.message_id ? ` (id ${testResult.message_id})` : ''}.`
                        : `Test email failed: ${testResult.reason || testResult.status || 'no reason given'}.`}
                </p>
            )}
        </div>
    );
}

function StatusChip({ configured, host, from }) {
    const bg     = configured ? 'rgba(52,211,153,0.14)' : 'rgba(245,158,11,0.14)';
    const border = configured ? 'rgba(52,211,153,0.4)'  : 'rgba(245,158,11,0.4)';
    const color  = configured ? '#34d399' : '#f59e0b';
    return (
        <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '6px 12px', borderRadius: 999,
            background: bg, border: `1px solid ${border}`, color,
            fontSize: 13, fontWeight: 600,
        }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
            {configured ? 'Connected' : 'Not connected'}
            {configured && host && (
                <span style={{ opacity: 0.75, fontWeight: 500 }}>&middot; {host}{from ? ` → ${from}` : ''}</span>
            )}
        </div>
    );
}

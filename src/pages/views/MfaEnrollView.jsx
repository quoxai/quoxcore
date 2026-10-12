/**
 * MFA Enrolment page — reached when login() returns action: 'enroll_mfa'.
 *
 * #321 background: an org mandates MFA, the user has no authenticator, and no
 * access token is issued at login. This page used to explain the deadlock and
 * send the user to their administrator, because the enrolment endpoints sit
 * behind authenticate() and there was nothing to authenticate with.
 *
 * LAUNCH-SPINE (2026-07-28) closed that: the backend now issues a single-use,
 * 10-minute enrolment ticket alongside the 403, minted only after the password
 * check has already passed. The ticket authorises /mfa/setup and
 * /mfa/verify-setup and nothing else, so the real TOTP flow runs here.
 *
 * The ticket arrives in router state, never the URL — a credential in a query
 * string ends up in history, referrer headers and server logs. That also means
 * a hard refresh loses it, which is handled explicitly below rather than
 * failing with a confusing error.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

const AUTH_BASE = import.meta.env.VITE_AUTH_URL || '/auth';

const IconShield = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M12 2l8 4v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10V6l8-4z" />
    </svg>
);
const IconCheck = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);
const IconBack = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
    </svg>
);
const IconCopy = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
);

const muted = { color: 'var(--text-secondary, #aaa)' };

export default function MfaEnrollView() {
    const navigate = useNavigate();
    const location = useLocation();
    const [params] = useSearchParams();
    const email = params.get('email') || '';
    const enrolmentTicket = location.state?.enrolmentTicket || null;

    // 'loading' → fetching the QR; 'scan' → showing it; 'done' → backup codes.
    const [phase, setPhase] = useState(enrolmentTicket ? 'loading' : 'no_ticket');
    const [qr, setQr] = useState(null);
    const [secret, setSecret] = useState('');
    const [code, setCode] = useState('');
    const [backupCodes, setBackupCodes] = useState([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const startedRef = useRef(false);

    const ticketHeaders = useCallback(() => ({
        'Content-Type': 'application/json',
        'X-MFA-Enrolment-Ticket': enrolmentTicket,
    }), [enrolmentTicket]);

    // Kick off setup once. Guarded with a ref because StrictMode double-invokes
    // effects in dev, and a second /setup call rotates the secret under a user
    // who may already have scanned the first QR.
    useEffect(() => {
        if (!enrolmentTicket || startedRef.current) return;
        startedRef.current = true;

        (async () => {
            try {
                const res = await fetch(`${AUTH_BASE}/mfa/setup`, {
                    method: 'POST',
                    headers: ticketHeaders(),
                    body: JSON.stringify({}),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    setError(data.message || 'Could not start enrolment.');
                    setPhase(data.error === 'invalid_enrolment_ticket' ? 'no_ticket' : 'error');
                    return;
                }
                setQr(data.qr_code || null);
                setSecret(data.secret || '');
                setPhase('scan');
            } catch {
                setError('Could not reach the authentication service.');
                setPhase('error');
            }
        })();
    }, [enrolmentTicket, ticketHeaders]);

    async function handleVerify(e) {
        e.preventDefault();
        if (busy) return;
        setError('');
        setBusy(true);
        try {
            const res = await fetch(`${AUTH_BASE}/mfa/verify-setup`, {
                method: 'POST',
                headers: ticketHeaders(),
                body: JSON.stringify({ code: code.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.message || 'That code was not accepted.');
                return;
            }
            setBackupCodes(data.backup_codes || []);
            setPhase('done');
        } catch {
            setError('Could not reach the authentication service.');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="glass-page" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', padding: '1rem' }}>
            <div className="glass" style={{ maxWidth: 460, width: '100%', padding: '2rem', borderRadius: 12 }}>
                <h1 style={{ marginBottom: '0.75rem', fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <IconShield /> Set up multi-factor authentication
                </h1>

                {email && (
                    <p style={{ marginBottom: '1.25rem', fontSize: '0.875rem', ...muted }}>
                        Account: <strong>{email}</strong>
                    </p>
                )}

                {/* No ticket: either a hard refresh lost the router state, or it
                    expired. Both are recoverable by signing in again, so say so
                    plainly rather than blaming the user's administrator. */}
                {phase === 'no_ticket' && (
                    <>
                        <p style={{ marginBottom: '1.25rem', lineHeight: 1.6, ...muted }}>
                            {error || 'This enrolment session has expired or was not carried over. Sign in again to start enrolment. Enrolment links are valid for 10 minutes and can only be used once.'}
                        </p>
                        <button type="button" className="ui-btn ui-btn-primary" onClick={() => navigate('/login')} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 0 }}>
                            <IconBack /> Back to sign in
                        </button>
                    </>
                )}

                {phase === 'loading' && <p style={{ ...muted }}>Preparing your authenticator setup…</p>}

                {phase === 'error' && (
                    <>
                        <p style={{ marginBottom: '1.25rem', lineHeight: 1.6, color: 'var(--hal-red, #e06c75)' }}>{error}</p>
                        <button type="button" className="ui-btn ui-btn-primary" onClick={() => navigate('/login')} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 0 }}>
                            <IconBack /> Back to sign in
                        </button>
                    </>
                )}

                {phase === 'scan' && (
                    <>
                        <p style={{ marginBottom: '1rem', lineHeight: 1.6, ...muted }}>
                            Your organisation requires an authenticator app. Scan this with
                            Google Authenticator, 1Password, or any TOTP app, then enter the
                            six-digit code it shows.
                        </p>

                        {qr && (
                            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
                                <img src={qr} alt="MFA setup QR code" style={{ width: 190, height: 190, borderRadius: 8, background: '#fff', padding: 8 }} />
                            </div>
                        )}

                        {secret && (
                            <div style={{ marginBottom: '1.25rem' }}>
                                <p style={{ fontSize: '0.8125rem', marginBottom: 4, ...muted }}>Cannot scan? Enter this key manually:</p>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <code style={{ flex: 1, fontSize: '0.8125rem', wordBreak: 'break-all' }}>{secret}</code>
                                    <button type="button" className="ui-btn" title="Copy key" onClick={() => navigator.clipboard?.writeText(secret)} style={{ padding: 0 }}>
                                        <IconCopy />
                                    </button>
                                </div>
                            </div>
                        )}

                        <form onSubmit={handleVerify}>
                            <input
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                placeholder="123456"
                                value={code}
                                onChange={e => setCode(e.target.value)}
                                style={{ width: '100%', marginBottom: '0.75rem', letterSpacing: '0.2em', textAlign: 'center' }}
                            />
                            {error && <p style={{ marginBottom: '0.75rem', fontSize: '0.875rem', color: 'var(--hal-red, #e06c75)' }}>{error}</p>}
                            <button type="submit" className="ui-btn ui-btn-primary" disabled={busy || code.trim().length < 6} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 0 }}>
                                <IconCheck /> {busy ? 'Verifying…' : 'Verify and enable'}
                            </button>
                        </form>
                    </>
                )}

                {phase === 'done' && (
                    <>
                        <p style={{ marginBottom: '1rem', lineHeight: 1.6 }}>
                            Multi-factor authentication is enabled. Save these backup codes
                            somewhere safe. They are shown once and each works only once.
                        </p>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: '1rem' }}>
                            {backupCodes.map(bc => (
                                <code key={bc} style={{ fontSize: '0.8125rem' }}>{bc}</code>
                            ))}
                        </div>
                        <button
                            type="button"
                            className="ui-btn"
                            onClick={() => navigator.clipboard?.writeText(backupCodes.join('\n'))}
                            style={{ width: '100%', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 0 }}
                        >
                            <IconCopy /> Copy backup codes
                        </button>
                        {/* The ticket is spent and was never a session, so the
                            user genuinely has to sign in again. Say why. */}
                        <p style={{ margin: '0.75rem 0', fontSize: '0.8125rem', ...muted }}>
                            Sign in again to continue. You will be asked for a code from your
                            authenticator.
                        </p>
                        <button type="button" className="ui-btn ui-btn-primary" onClick={() => navigate('/login')} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 0 }}>
                            <IconBack /> Back to sign in
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

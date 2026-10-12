/**
 * MFA Challenge page — reached when login() returns action: 'mfa_challenge'.
 *
 * #322-FE: per-request MFA gate. The user is authenticated (holds a valid
 * access token) but the session lacks the mfa_verified flag that the org
 * policy requires. They complete a TOTP verify step here to elevate the
 * session.
 *
 * Endpoint: POST /api/mfa/verify
 *   Body:    { code: "123456" }  OR  { backup_code: "..." }
 *   Auth:    uses httpOnly session cookies (no token in body needed)
 *   200:     session mfa_verified flag set → navigate to /
 *   400:     { error: 'invalid_code' | 'code_required' }
 */

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

export default function MfaChallengeView() {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const email = params.get('email') || '';
    const returnTo = params.get('returnTo') || '/';

    const { authFetch } = useAuth();

    const [code, setCode] = useState('');
    const [backupCode, setBackupCode] = useState('');
    const [useBackup, setUseBackup] = useState(false);
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        const value = useBackup ? backupCode.trim() : code.trim();
        if (!value) return;

        setLoading(true);
        setErrorMsg('');

        try {
            const body = useBackup
                ? { backup_code: value }
                : { code: value };

            const response = await authFetch('/api/mfa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (response.ok) {
                navigate(returnTo);
                return;
            }

            let data = {};
            try {
                data = await response.json();
            } catch {
                // ignore parse error
            }

            if (data.error === 'invalid_code') {
                setErrorMsg('Code is incorrect. Try again.');
            } else {
                setErrorMsg(data.message || 'Verification failed. Please try again.');
            }
        } catch {
            setErrorMsg('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="glass-page" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
            <div className="glass" style={{ maxWidth: 440, padding: '2rem', borderRadius: 12 }}>
                <h1 style={{ marginBottom: '0.75rem', fontSize: '1.25rem', fontWeight: 600 }}>
                    Verify your identity
                </h1>
                <p style={{ marginBottom: '1.25rem', lineHeight: 1.6, color: 'var(--text-secondary, #aaa)' }}>
                    This organisation requires multi-factor authentication.
                    {useBackup
                        ? ' Enter one of your backup codes below.'
                        : ' Open your authenticator app and enter the six-digit code.'}
                </p>

                {email && (
                    <p style={{ marginBottom: '1.25rem', fontSize: '0.875rem', color: 'var(--text-secondary, #aaa)' }}>
                        Account: <strong>{email}</strong>
                    </p>
                )}

                <form onSubmit={handleSubmit} noValidate>
                    {useBackup ? (
                        <input
                            type="text"
                            aria-label="Backup code"
                            placeholder="Enter backup code"
                            value={backupCode}
                            onChange={(e) => setBackupCode(e.target.value)}
                            autoComplete="off"
                            disabled={loading}
                            style={{
                                width: '100%',
                                padding: '0.625rem 0.75rem',
                                fontSize: '1rem',
                                borderRadius: 8,
                                border: '1px solid var(--border-color, #333)',
                                background: 'var(--input-bg, #111)',
                                color: 'var(--text-primary, #fff)',
                                marginBottom: '0.75rem',
                                boxSizing: 'border-box',
                            }}
                        />
                    ) : (
                        <input
                            type="text"
                            aria-label="One-time code"
                            placeholder="6-digit code"
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            inputMode="numeric"
                            pattern="[0-9]*"
                            autoComplete="one-time-code"
                            maxLength={6}
                            disabled={loading}
                            style={{
                                width: '100%',
                                padding: '0.625rem 0.75rem',
                                fontSize: '1.5rem',
                                letterSpacing: '0.3em',
                                textAlign: 'center',
                                borderRadius: 8,
                                border: '1px solid var(--border-color, #333)',
                                background: 'var(--input-bg, #111)',
                                color: 'var(--text-primary, #fff)',
                                marginBottom: '0.75rem',
                                boxSizing: 'border-box',
                            }}
                        />
                    )}

                    {errorMsg && (
                        <p
                            role="alert"
                            style={{
                                marginBottom: '0.75rem',
                                fontSize: '0.875rem',
                                color: 'var(--color-error, #f87171)',
                            }}
                        >
                            {errorMsg}
                        </p>
                    )}

                    <button
                        type="submit"
                        className="ui-btn ui-btn-primary"
                        disabled={loading || (useBackup ? !backupCode.trim() : code.length < 6)}
                        style={{ width: '100%', marginBottom: '0.75rem' }}
                    >
                        {loading ? 'Verifying…' : 'Verify'}
                    </button>
                </form>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                        type="button"
                        className="ui-btn ui-btn-ghost"
                        onClick={() => { setUseBackup(!useBackup); setErrorMsg(''); }}
                        style={{ width: '100%', fontSize: '0.875rem' }}
                    >
                        {useBackup ? 'Use authenticator code instead' : 'Use a backup code'}
                    </button>
                    <button
                        type="button"
                        className="ui-btn ui-btn-secondary"
                        onClick={() => navigate('/login')}
                        style={{ width: '100%' }}
                    >
                        Back to sign in
                    </button>
                </div>
            </div>
        </div>
    );
}

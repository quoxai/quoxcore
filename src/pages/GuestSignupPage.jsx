/**
 * GuestSignupPage — ET-FINISH Phase 1 (closes ET-ENFORCE-G UI gap).
 *
 * Anonymous landing for /invite/guest/:token. Renders the signup form
 * an unauth visitor needs to complete their guest acceptance. On
 * submit hits POST /api/invites/:token/signup-and-accept which
 * creates the user, accepts the invite, and sets auth cookies in
 * one transaction.
 *
 * Designed to be embedded inside GuestInvitePage when state is
 * `need_login`, so the URL stays /invite/guest/:token.
 */

import { useEffect, useState } from 'react';
import { signupAndAcceptGuestInvite } from '../services/guestInviteClient';
import './GuestSignupPage.css';

const PASSWORD_MIN = 12;

// Optional invite preview fetcher — gives the user something to recognise
// (org name, inviter) before they hand over a password. Fails open: if the
// preview fetch fails we still render the form.
async function fetchInvitePreview(token) {
    try {
        const res = await fetch(`/api/invites/${encodeURIComponent(token)}`);
        if (!res.ok) return null;
        const body = await res.json();
        return body?.invite || null;
    } catch {
        return null;
    }
}

export default function GuestSignupPage({ token }) {
    const [preview, setPreview]       = useState(null);
    const [previewError, setPreviewError] = useState(null);
    const [password, setPassword]     = useState('');
    const [displayName, setDisplayName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError]           = useState(null);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        (async () => {
            const result = await fetchInvitePreview(token);
            if (cancelled) return;
            if (!result) {
                setPreviewError('We couldn’t verify this invite. The link may have expired.');
                return;
            }
            setPreview(result);
        })();
        return () => { cancelled = true; };
    }, [token]);

    const onSubmit = async (e) => {
        e.preventDefault();
        if (submitting) return;
        if (password.length < PASSWORD_MIN) {
            setError({ code: 'weak_password_client', message: `Password must be at least ${PASSWORD_MIN} characters.` });
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            await signupAndAcceptGuestInvite(token, {
                password,
                displayName: displayName.trim() || undefined,
            });
            // Server set httpOnly access + refresh cookies. Hard-navigate so
            // the auth context picks up the fresh session from cookies.
            window.location.assign('/guest');
        } catch (err) {
            setError({
                code: err.code || 'unknown',
                message: err.message || 'Could not complete signup',
            });
            setSubmitting(false);
        }
    };

    // Map server-side error codes to specific UX. Falls back to the raw
    // message for any code not enumerated.
    let errorBody = null;
    if (error) {
        if (error.code === 'invite_not_usable') {
            errorBody = (
                <p className="guest-signup-page__error">
                    This invite link is no longer usable. Ask your administrator for a fresh invite.
                </p>
            );
        } else if (error.code === 'email_exists') {
            const loginUrl = `/login?return_to=${encodeURIComponent(`/invite/guest/${token}`)}`;
            errorBody = (
                <p className="guest-signup-page__error">
                    An account with this email already exists.{' '}
                    <a href={loginUrl}>Sign in instead</a> and you'll be returned here to accept the invite.
                </p>
            );
        } else if (error.code === 'weak_password' || error.code === 'weak_password_client') {
            errorBody = (
                <p className="guest-signup-page__error">
                    {error.message || `Password must be at least ${PASSWORD_MIN} characters.`}
                </p>
            );
        } else if (error.code === 'ip_not_allowed') {
            errorBody = (
                <p className="guest-signup-page__error">
                    Your IP address is not on this organisation’s allowlist. Contact the administrator who sent this invite.
                </p>
            );
        } else {
            errorBody = (
                <p className="guest-signup-page__error">
                    {error.message || 'Could not complete signup. Please try again.'}
                </p>
            );
        }
    }

    if (previewError) {
        return (
            <div className="guest-signup-page">
                <h2>Invite unavailable</h2>
                <p className="guest-signup-page__error">{previewError}</p>
                <a className="guest-signup-page__cta" href="/login">Go to sign in</a>
            </div>
        );
    }

    return (
        <div className="guest-signup-page">
            <h2>Create your account</h2>
            {preview && (
                <p className="guest-signup-page__preview">
                    You’ve been invited to <strong>{preview.organization?.name || 'an organisation'}</strong>
                    {preview.invited_by?.display_name ? <> by <strong>{preview.invited_by.display_name}</strong></> : null}
                    {preview.email ? <>. We’ll set up your account using <strong>{preview.email}</strong>.</> : '.'}
                </p>
            )}

            <form onSubmit={onSubmit} className="guest-signup-page__form" noValidate>
                <label htmlFor="guest-signup-display-name">Display name (optional)</label>
                <input
                    id="guest-signup-display-name"
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    disabled={submitting}
                    maxLength={120}
                />

                <label htmlFor="guest-signup-password">Password</label>
                <input
                    id="guest-signup-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={submitting}
                    minLength={PASSWORD_MIN}
                    aria-describedby="guest-signup-password-hint"
                />
                <small id="guest-signup-password-hint" className="guest-signup-page__hint">
                    Minimum {PASSWORD_MIN} characters.
                </small>

                {errorBody}

                <button
                    type="submit"
                    className="guest-signup-page__cta"
                    disabled={submitting || !password}
                >
                    {submitting ? 'Creating account…' : 'Accept invite & continue'}
                </button>
            </form>

            <p className="guest-signup-page__alt">
                Already have an account?{' '}
                <a href={`/login?return_to=${encodeURIComponent(`/invite/guest/${token}`)}`}>Sign in</a>
            </p>
        </div>
    );
}

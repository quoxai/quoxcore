/**
 * GuestInvitePage — ET-6D.3.
 *
 * Public route `/invite/guest/:token`. Detects auth, calls the
 * accept-guest endpoint when signed in, then redirects the user to
 * /guest (the scoped landing surface).
 *
 * We don't sign users up here — if they're anonymous, we bounce them
 * to /login with a return_to so the existing login flow finishes the
 * job and brings them back.
 */

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { acceptGuestInvite } from '../services/guestInviteClient';
import { resolveGuestFlowState } from '../services/guestFlow';
import GuestSignupPage from './GuestSignupPage';
import './GuestInvitePage.css';

export default function GuestInvitePage() {
    const { token } = useParams();
    const navigate  = useNavigate();
    const { user, authFetch } = useAuth();
    const [acceptResult, setAcceptResult] = useState(null);
    const [error, setError] = useState(null);

    const state = resolveGuestFlowState({ user, token, acceptResult, error });

    useEffect(() => {
        if (state !== 'accepting') return;
        let cancelled = false;
        (async () => {
            try {
                const out = await acceptGuestInvite(token, authFetch);
                if (!cancelled) setAcceptResult(out);
            } catch (err) {
                if (!cancelled) setError(err.message || String(err));
            }
        })();
        return () => { cancelled = true; };
    }, [state, token, authFetch]);

    useEffect(() => {
        if (state === 'accepted') {
            const t = setTimeout(() => navigate('/guest'), 1200);
            return () => clearTimeout(t);
        }
    }, [state, navigate]);

    return (
        <div className="guest-invite-page">
            <div className="guest-invite-page__card">
                <div className="guest-invite-page__brand">Quox</div>

                {state === 'need_login' && (
                    <GuestSignupPage token={token} />
                )}

                {state === 'accepting' && (
                    <>
                        <h2>Accepting invite…</h2>
                        <div className="guest-invite-page__spinner" aria-hidden="true" />
                    </>
                )}

                {state === 'accepted' && (
                    <>
                        <h2>You're in.</h2>
                        <p>Taking you to your workspace…</p>
                    </>
                )}

                {state === 'error' && (
                    <>
                        <h2>We couldn't accept that invite</h2>
                        <p className="guest-invite-page__error">{error || 'Invite link is missing or invalid.'}</p>
                        <a className="guest-invite-page__cta" href="/login">Go to sign in</a>
                    </>
                )}
            </div>
        </div>
    );
}

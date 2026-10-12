/**
 * GuestLandingView — ET-6D.3.
 *
 * Authenticated route `/guest`. Renders a minimal scoped surface for
 * users whose membership.preferences_json.guest_scope_id is set — no
 * sidebar, no navigation, just the scoped assistant surface.
 *
 * The actual chat experience is intentionally minimal for this phase:
 * we surface the user's identity + the scope they have access to, and
 * embed the Command Center chat scoped via a URL param so downstream
 * UX work can flesh this out without changing routes.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './GuestInvitePage.css';

export default function GuestLandingView() {
    const navigate = useNavigate();
    const { user, authFetch } = useAuth();
    const [membership, setMembership] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!user) { navigate('/login?return_to=%2Fguest'); return; }
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch('/api/auth/me');
                const body = await res.json().catch(() => null);
                if (cancelled) return;
                // Pick the first membership whose preferences_json carries
                // a guest_scope_id. A user could in principle be a regular
                // member elsewhere, but THIS view is for the guest context.
                const memberships = Array.isArray(body?.memberships) ? body.memberships : [];
                const guestMembership = memberships.find(m => {
                    try {
                        const prefs = typeof m.preferences_json === 'string'
                            ? JSON.parse(m.preferences_json || '{}')
                            : (m.preferences_json || {});
                        return !!prefs.guest_scope_id;
                    } catch { return false; }
                });
                if (!guestMembership) {
                    // Not a guest — bounce into the main app.
                    navigate('/', { replace: true });
                    return;
                }
                setMembership(guestMembership);
            } catch (err) {
                if (!cancelled) setError(err.message || String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [user, authFetch, navigate]);

    if (loading) {
        return (
            <div className="guest-invite-page">
                <div className="guest-invite-page__card">
                    <div className="guest-invite-page__brand">Quox</div>
                    <div className="guest-invite-page__spinner" aria-hidden="true" />
                </div>
            </div>
        );
    }

    if (error || !membership) {
        return (
            <div className="guest-invite-page">
                <div className="guest-invite-page__card">
                    <div className="guest-invite-page__brand">Quox</div>
                    <h2>We couldn't load your space</h2>
                    <p className="guest-invite-page__error">{error || 'No guest access found on this account.'}</p>
                </div>
            </div>
        );
    }

    let prefs = {};
    try {
        prefs = typeof membership.preferences_json === 'string'
            ? JSON.parse(membership.preferences_json || '{}')
            : (membership.preferences_json || {});
    } catch { /* noop */ }
    const scopeId = prefs.guest_scope_id;

    return (
        <div className="guest-landing">
            <header className="guest-landing__bar">
                <div className="guest-landing__brand">Quox · Guest space</div>
                <div className="guest-landing__user">{user?.email}</div>
            </header>
            <main className="guest-landing__main">
                <div className="guest-landing__card">
                    <div className="guest-landing__scope-label">Your access</div>
                    <div className="guest-landing__scope-id">{scopeId}</div>
                    <p className="guest-landing__hint">
                        This account is scoped to a single assistant. The chat surface lives inside the
                        main app once we ship the minimal guest chat in a follow-up phase.
                    </p>
                    <a className="guest-landing__cta" href={`/?scope_id=${encodeURIComponent(scopeId)}`}>
                        Open assistant
                    </a>
                </div>
            </main>
        </div>
    );
}

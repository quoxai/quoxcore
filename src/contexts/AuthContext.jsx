/**
 * Auth Context for Quox Dashboard
 * Provides authentication state and methods throughout the app
 *
 * Features:
 * - JWT-based authentication with refresh tokens
 * - MFA support
 * - Timeout handling to prevent stuck loading states
 */

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { hydrateFromServer, hydrateOrgPreferences } from '../services/userPreferences';
import { setOrgSyncContext, markHydrated } from '../services/serverSyncQueue';
import { fetchEntitlements, clearEntitlements, clearServerLicense, clearServerPluginLicenses } from '../services/licenseValidator';
import { setStorageContext } from '../services/orgScopedStorage';
import { buildDevModeUser, isDevBypassEnabled } from '../utils/devMode';

const AUTH_API = '/api/auth';

// Timeout for auth checks (prevent infinite loading)
// 10s allows for slow responses during container rebuilds
const AUTH_CHECK_TIMEOUT = 10000; // 10 seconds

// TRUST-GATE-1.14b — proactive refresh keepalive. Access tokens live for
// 1h (must match JWT_ACCESS_EXPIRY default in services/auth/utils/crypto.js).
// While the tab is visible we refresh at ~80% of that lifetime so an
// actively-open dashboard renews the access-token cookie — and slides the
// server's idle-timeout window (services/auth/utils/sessionPolicy.js) —
// before either the JWT TTL or the server idle timeout can trip. This is a
// tab-scoped keepalive timer, not a background job: it only runs while the
// tab is visible and re-checks on visibilitychange.
const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1h
const PROACTIVE_REFRESH_RATIO = 0.8;
const PROACTIVE_REFRESH_MS = ACCESS_TOKEN_LIFETIME_MS * PROACTIVE_REFRESH_RATIO;

// ET-ENFORCE — map server error codes to user-facing copy + action.
// `action: 'logout'` means the client should drop the session and force
// re-login. `action: 'switch_org'` means the user should pick a different
// org. `action: 'enroll_mfa'` deep-links to the MFA enrolment flow.
// Anything not in this table falls through to generic toast handling.
const ENFORCE_ERROR_MAP = {
    // Per-request session/auth failures — drop the session.
    session_expired: {
        action: 'logout',
        message: 'Your session timed out. Please sign in again.',
    },
    session_revoked: {
        action: 'logout',
        message: 'Your session was revoked. Please sign in again.',
    },
    membership_revoked: {
        action: 'logout',
        message: 'Your access to this organisation has been removed. Please sign in again.',
    },
    org_deleted: {
        action: 'logout',
        message: 'This organisation has been deleted.',
    },
    // Login/refresh-time policy refusals — surface in the login form.
    deprovisioned: {
        action: 'login_form',
        message: 'Your access has been removed. Contact your administrator for a new invite.',
    },
    ip_not_allowed: {
        action: 'login_form',
        message: 'Your IP address is not on this organisation’s allowlist. Contact your administrator.',
    },
    ipv6_not_supported_by_allowlist: {
        action: 'login_form',
        message: 'IPv6 connections are not supported by this organisation’s allowlist. Connect over IPv4 or contact your administrator.',
    },
    mfa_enrollment_required: {
        action: 'enroll_mfa',
        message: 'This organisation requires multi-factor authentication. Enrol before continuing.',
    },
    mfa_challenge_required: {
        action: 'mfa_challenge',
        message: 'Verify multi-factor authentication for this organisation.',
    },
    // Per-mutation refusals — surface as a toast on the offending screen.
    forbidden_escalation: {
        action: 'toast',
        message: 'You cannot grant capabilities you do not hold yourself.',
    },
    cannot_modify_own_membership: {
        action: 'toast',
        message: 'You cannot modify your own membership through this surface.',
    },
    cannot_modify_higher_role: {
        action: 'toast',
        message: 'You cannot modify a member whose role is equal to or higher than yours.',
    },
    cannot_modify_owner_via_scim: {
        action: 'toast',
        message: 'The organisation owner cannot be modified through SCIM. Use the dashboard transfer-ownership flow.',
    },
    invite_not_usable: {
        action: 'invite_failed',
        message: 'This invite link is no longer usable. Ask your administrator for a fresh invite.',
    },
    forbidden_scope_unknown: {
        action: 'toast',
        message: 'This secret’s scope is not recognised in your current organisation.',
    },
    forbidden_not_team_member: {
        action: 'toast',
        message: 'You must be an active member of the team to access this team-scoped resource.',
    },
};

/**
 * Translate a server error response body into a user-facing message + action.
 * Returns the canonical entry from ENFORCE_ERROR_MAP if `data.error` matches,
 * otherwise a generic fallback. Always returns a non-null object.
 */
export function describeServerError(data) {
    const code = data?.error;
    if (code && ENFORCE_ERROR_MAP[code]) {
        return { code, ...ENFORCE_ERROR_MAP[code] };
    }
    return {
        code: code || 'unknown',
        action: 'toast',
        message: data?.message || data?.error || 'Something went wrong. Please try again.',
    };
}

const AuthContext = createContext(null);

/**
 * Hydrate org-scoped preferences from /me response.
 * Picks the current org from localStorage or falls back to first org.
 */
function hydrateCurrentOrgPrefs(data) {
    try {
        const orgs = data?.organizations;
        if (!orgs?.length || !data?.user?.id) return;

        // Determine current org
        const savedOrgId = localStorage.getItem('current_org_id');
        const currentOrg = orgs.find(o => o.id === savedOrgId) || orgs[0];
        if (!currentOrg?.id) return;

        // LI-OVERHAUL P11 fix: the sync context must be set even when the org
        // has NO stored preferences yet. It used to sit below the empty-prefs
        // early return, so a fresh org could never persist its FIRST org
        // preference — queueOrgSync warned "No org context set" and silently
        // dropped every write (plugin configs included) for that whole
        // session. Only the HYDRATION step is skippable when there is
        // nothing to hydrate.
        setOrgSyncContext(currentOrg.id);
        if (!currentOrg?.preferences || Object.keys(currentOrg.preferences).length === 0) return;

        hydrateOrgPreferences(currentOrg.preferences, currentOrg.id, data.user.id);
    } catch (err) {
        console.warn('[Auth] Failed to hydrate org preferences:', err.message);
    }
}

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    // #325: ref so authFetch closures always read the current user even when
    // useCallback hasn't re-memoized (its dep array is [logout] only).
    const userRef = useRef(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [setupRequired, setSetupRequired] = useState(false);
    const [isDevMode, setIsDevMode] = useState(() => isDevBypassEnabled());

    // TRUST-GATE-1.14c — effective session policy for the current user/org,
    // as returned by GET /me (services/auth/routes/auth.js). Powers the
    // inactivity warning below. null until the first successful /me response.
    const [sessionPolicy, setSessionPolicy] = useState(null);
    // Advisory-only inactivity warning. Never forces a logout itself — the
    // existing 401 → logout path (authFetch/checkAuth) remains the sole
    // authoritative mechanism. See effect below.
    const [idleWarning, setIdleWarning] = useState({ visible: false, secondsRemaining: 0 });
    const lastActivityAtRef = useRef(Date.now());

    // TRUST-GATE-1.14b — best-effort bookkeeping for the proactive refresh
    // keepalive (see effect below). We can't read the httpOnly access-token
    // cookie's actual issued-at time from JS, so we track "last moment we
    // confirmed/renewed the session" as our baseline for the 80%-lifetime
    // schedule. Updated on successful checkAuth/login/verifyMfa/refresh.
    const lastRefreshAtRef = useRef(Date.now());
    // Last HTTP status from a refresh attempt, so callers can distinguish a
    // DEFINITIVE session death (401/403 → logout / stop the keepalive) from a
    // TRANSIENT refusal (429 rate-limit, 5xx → keep the session, back off). A
    // bare boolean return conflated them and could force-logout a valid but
    // rate-limited session.
    const lastRefreshStatusRef = useRef(null);

    // GTM-A1/B4: the error CODE from the last refused refresh. The status alone
    // cannot tell "this browser never had a session" (401 no_refresh_token)
    // apart from "the session died" (401 invalid_refresh_token), and telling a
    // first-ever visitor their session timed out is a small lie on the very
    // first screen of the product.
    const lastRefreshErrorRef = useRef(null);

    // Keep userRef in sync with user state so authFetch callbacks always
    // have access to the latest user even when the closure is stale.
    useEffect(() => { userRef.current = user; }, [user]);

    // Load user on mount
    useEffect(() => {
        checkSetupAndAuth();
    }, []);

    useEffect(() => {
        const syncDevMode = () => setIsDevMode(isDevBypassEnabled());
        window.addEventListener('storage', syncDevMode);
        return () => window.removeEventListener('storage', syncDevMode);
    }, []);

    const checkSetupAndAuth = async () => {
        // First check if setup is required (with timeout to prevent infinite loading)
        try {
            const setupTimeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Setup check timeout')), AUTH_CHECK_TIMEOUT);
            });

            const setupRes = await Promise.race([
                fetch('/api/setup/status'),
                setupTimeoutPromise
            ]);

            if (setupRes.ok) {
                const setupData = await setupRes.json();
                if (!setupData.complete && !setupData.hasAdmin) {
                    setSetupRequired(true);
                    setLoading(false);
                    return;
                }
            }
        } catch (err) {
            // If setup endpoint fails or times out, continue with auth check
            console.log('[Auth] Setup status check failed or timed out, continuing with auth');
        }

        // Then check auth
        checkAuth();
    };

    const checkAuth = async () => {
        try {
            if (isDevBypassEnabled()) {
                setIsDevMode(true);
                setUser(buildDevModeUser());
                setLoading(false);
                return;
            }

            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Auth check timeout')), AUTH_CHECK_TIMEOUT);
            });

            const response = await Promise.race([
                fetch(`${AUTH_API}/me`, {
                    credentials: 'include'
                }),
                timeoutPromise
            ]);

            if (response.ok) {
                const text = await response.text();
                if (text) {
                    try {
                        const data = JSON.parse(text);
                        setUser(data.user);
                        setSessionPolicy(data.session_policy || null); // TRUST-GATE-1.14c
                        lastRefreshAtRef.current = Date.now(); // TRUST-GATE-1.14b keepalive baseline
                        if (data.user?.preferences) hydrateFromServer(data.user.preferences);
                        markHydrated();
                        hydrateCurrentOrgPrefs(data);
                        // Fetch server-side entitlements (LE-3a: gating authority)
                        try { await fetchEntitlements(fetch); } catch (e) {
                            console.warn('[Auth] Entitlements fetch failed:', e.message);
                        }
                    } catch {
                        console.error('[Auth] Invalid JSON in /me response');
                    }
                }
            } else if (response.status === 401) {
                // Access token expired — try refresh before giving up
                console.log('[Auth] Access token expired, attempting refresh...');
                let refreshed = false;
                try {
                    refreshed = await refreshToken();
                } catch {
                    // Network error during refresh — keep the user signed in
                    // (the next mount or authFetch call will retry). Same
                    // "network ≠ logout" invariant as authFetch.
                    console.warn('[Auth] Refresh fetch failed (network); leaving session as-is');
                }
                if (refreshed) {
                    // Retry /me with the new access token
                    const retryResponse = await Promise.race([
                        fetch(`${AUTH_API}/me`, { credentials: 'include' }),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Auth retry timeout')), AUTH_CHECK_TIMEOUT)
                        )
                    ]);
                    if (retryResponse.ok) {
                        const text = await retryResponse.text();
                        if (text) {
                            try {
                                const data = JSON.parse(text);
                                setUser(data.user);
                                setSessionPolicy(data.session_policy || null); // TRUST-GATE-1.14c
                                if (data.user?.preferences) hydrateFromServer(data.user.preferences);
                                markHydrated();
                                try { await fetchEntitlements(fetch); } catch (e) {
                                    console.warn('[Auth] Entitlements fetch failed after refresh:', e.message);
                                }
                                console.log('[Auth] Token refreshed successfully');
                            } catch {
                                console.error('[Auth] Invalid JSON in /me retry response');
                            }
                        }
                    } else {
                        console.warn('[Auth] /me failed after refresh, status:', retryResponse.status);
                    }
                } else {
                    // Read the /me 401 body to derive the correct reason.
                    // The response body has not been consumed at this point.
                    let meErrorBody = null;
                    try { meErrorBody = await response.json(); } catch { /* non-JSON — fall back */ }

                    // GTM-A1/B4: 'session-expired' used to be the catch-all, so
                    // a brand-new visitor with no cookies and a rate-limited
                    // user were both told their session timed out. Neither had
                    // a session. Derive the honest cases first.
                    const neverAuthenticated =
                        lastRefreshErrorRef.current === 'no_refresh_token' && !userRef.current;
                    const rateLimited = lastRefreshStatusRef.current === 429;

                    const reasonKey401 =
                        meErrorBody?.error === 'session_revoked'    ? 'session-revoked'    :
                        meErrorBody?.error === 'membership_revoked' ? 'membership-revoked' :
                        meErrorBody?.error === 'org_deleted'        ? 'org-deleted'        :
                        rateLimited                                ? 'rate-limited'       :
                        neverAuthenticated                         ? null                 :
                                                                       'session-expired';

                    if (reasonKey401 === null) {
                        // Nothing went wrong. This visitor has simply never
                        // signed in, so the login page shows no banner at all.
                        console.log('[Auth] No prior session in this browser; showing a clean login page');
                    } else {
                        console.warn('[Auth] Token refresh failed — reason:', reasonKey401);
                        try {
                            sessionStorage.setItem('quox-auth-redirect-reason', reasonKey401);
                            const emailForStash = userRef.current?.email || userRef.current?.primary_email;
                            if (emailForStash) sessionStorage.setItem('quox-auth-redirect-email', emailForStash);
                        } catch { /* sessionStorage unavailable */ }
                    }
                }
            }
        } catch (err) {
            console.error('Auth check failed:', err);
            if (isDevBypassEnabled()) {
                setIsDevMode(true);
                setUser(buildDevModeUser());
                markHydrated();
                return;
            }
            setError('Auth service unavailable');
            markHydrated(); // Unblock sync queue even on auth failure
        } finally {
            setLoading(false);
        }
    };

    const login = async (email, password, rememberMe = false) => {
        setError(null);
        try {
            const response = await fetch(`${AUTH_API}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, remember_me: !!rememberMe }),
                credentials: 'include'
            });

            // Read response text first to handle empty responses gracefully
            const text = await response.text();
            let data = {};
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch {
                    throw new Error('Invalid server response');
                }
            }

            // ET-2 Phase C: sso_required → surface login_url so the
            // login page can deep-link to the provider's handshake
            // instead of showing a generic error.
            if (response.status === 403 && data.error === 'sso_required') {
                setError(data.message || 'Single sign-on required');
                return { error: data.message, ssoRequired: true, loginUrl: data.login_url };
            }

            // ET-ENFORCE — translate enforcement refusals into structured
            // results so the login page can render meaningful UX (rather
            // than throwing a generic 'Login failed' toast).
            if (!response.ok) {
                const desc = describeServerError(data);
                if (desc.code !== 'unknown') {
                    setError(desc.message);
                    return {
                        error:    desc.message,
                        code:     desc.code,
                        action:   desc.action,
                        // Carry through any extra payload fields the
                        // backend returned (e.g. retryAfter, login_url).
                        ...(data.retry_after ? { retryAfter: data.retry_after } : {}),
                        // LAUNCH-SPINE: single-use, 10-minute ticket issued with
                        // mfa_enrollment_required so the enrol screen can call
                        // /mfa/setup without a session. Held in memory and passed
                        // to the enrol view via router state — never persisted to
                        // localStorage and never put in the URL, where it would
                        // land in history and server logs.
                        ...(data.enrolment_ticket ? { enrolmentTicket: data.enrolment_ticket } : {}),
                    };
                }
                throw new Error(data.message || data.error || 'Login failed');
            }

            // Handle MFA if required
            if (data.requires_mfa) {
                return { requiresMfa: true, mfaToken: data.mfa_token };
            }

            setUser(data.user);
            lastRefreshAtRef.current = Date.now(); // TRUST-GATE-1.14b keepalive baseline
            if (data.user?.preferences) hydrateFromServer(data.user.preferences);
            markHydrated();
            try { await fetchEntitlements(fetch); } catch (e) {
                console.warn('[Auth] Entitlements fetch failed after login:', e.message);
            }
            return { success: true };
        } catch (err) {
            setError(err.message);
            return { error: err.message };
        }
    };

    const verifyMfa = async (mfaToken, code) => {
        setError(null);
        try {
            const response = await fetch('/api/mfa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mfa_token: mfaToken, code }),
                credentials: 'include'
            });

            // Read response text first to handle empty responses gracefully
            const text = await response.text();
            let data = {};
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch {
                    throw new Error('Invalid server response');
                }
            }

            if (!response.ok) {
                throw new Error(data.message || data.error || 'MFA verification failed');
            }

            // Tokens are now set as httpOnly cookies by the server
            // No need to store in localStorage
            setUser(data.user);
            lastRefreshAtRef.current = Date.now(); // TRUST-GATE-1.14b keepalive baseline
            if (data.user?.preferences) hydrateFromServer(data.user.preferences);
            markHydrated();
            try { await fetchEntitlements(fetch); } catch (e) {
                console.warn('[Auth] Entitlements fetch failed after MFA:', e.message);
            }
            return { success: true };
        } catch (err) {
            setError(err.message);
            return { error: err.message };
        }
    };

    const signup = async (email, password, displayName) => {
        setError(null);
        try {
            const response = await fetch(`${AUTH_API}/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, display_name: displayName }),
                credentials: 'include'
            });

            // Read response text first to handle empty responses gracefully
            const text = await response.text();
            let data = {};
            if (text) {
                try {
                    data = JSON.parse(text);
                } catch {
                    throw new Error('Invalid server response');
                }
            }

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Signup failed');
            }

            // GTM-A1/B5: signup now mints the same session, tokens and cookies
            // as /login, so adopt them instead of sending the user back to the
            // login form to retype the credentials they just chose. Guarded on
            // signed_in: server-side session creation is non-fatal there, and
            // if it did not happen we keep the old "now sign in" behaviour
            // rather than claiming a session that does not exist.
            if (data.signed_in && data.user) {
                setUser(data.user);
                lastRefreshAtRef.current = Date.now();
                if (data.user?.preferences) hydrateFromServer(data.user.preferences);
                markHydrated();
                try { await fetchEntitlements(fetch); } catch (e) {
                    console.warn('[Auth] Entitlements fetch failed after signup:', e.message);
                }
                return { success: true, message: data.message, signedIn: true, org: data.org || null };
            }

            return { success: true, message: data.message, signedIn: false };
        } catch (err) {
            setError(err.message);
            return { error: err.message };
        }
    };

    const logout = useCallback(async () => {
        try {
            if (!isDevBypassEnabled()) {
                await fetch(`${AUTH_API}/logout`, {
                    method: 'POST',
                    credentials: 'include'
                });
            }
        } catch (err) {
            console.error('Logout error:', err);
        } finally {
            // Clear all quox- prefixed localStorage keys to prevent data leaking to next user
            const keysToRemove = []
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i)
                if (key && (key.startsWith('quox-') || key.startsWith('quox_'))) {
                    keysToRemove.push(key)
                }
            }
            keysToRemove.forEach(key => localStorage.removeItem(key))
            clearServerLicense();
            clearServerPluginLicenses();
            clearEntitlements();
            // LL-7 C5: clear the org storage context too. current_org_id is not
            // quox- prefixed so the sweep above never removed it, and without
            // setStorageContext(null) the 'quox-org-switch' org-clear event
            // never fires — thirdPartyPluginHost kept the previous account's
            // loadedPlugins (in-memory bundles) alive into the next login.
            // Storage write first, then the event (same ordering rule as C1).
            localStorage.removeItem('current_org_id');
            setStorageContext(null, null);
            setUser(null);
            setSessionPolicy(null); // TRUST-GATE-1.14c — don't leak the prior user's policy
            setIdleWarning({ visible: false, secondsRemaining: 0 });
        }
    }, []);

    // ONE refresh at a time: every concurrent 401 awaits the same call. Before
    // 2026-10-10 each started its own (11 at once when a token aged out), which
    // stalled the page and raced the server's refresh-token rotation.
    const refreshInFlightRef = useRef(null);
    const refreshToken = () => {
        if (isDevBypassEnabled()) {
            return Promise.resolve(false);
        }
        if (refreshInFlightRef.current) return refreshInFlightRef.current;
        const p = refreshTokenOnce().finally(() => { refreshInFlightRef.current = null; });
        refreshInFlightRef.current = p;
        return p;
    };
    const refreshTokenOnce = async () => {
        // Refresh token is sent via httpOnly cookie automatically.
        //
        // ET-FINISH Phase 3: do NOT swallow fetch rejections here. A network
        // failure ("Failed to fetch") is materially different from a 4xx
        // refusal — the former is transient and must NOT cause the user to
        // be logged out, while the latter means the session is dead. Let the
        // throw propagate; authFetch wraps the call in a try/catch that
        // returns the original 401 to the caller without logging out.
        // checkAuth wraps it too and treats a throw as "refresh unavailable".
        const response = await fetch(`${AUTH_API}/refresh`, {
            method: 'POST',
            credentials: 'include'
        });
        // Server sets new access token as httpOnly cookie. ok ⇔ refresh worked.
        // TRUST-GATE-1.14b: reset the keepalive baseline on a successful
        // refresh so the next proactive tick is scheduled from now.
        lastRefreshStatusRef.current = response.status;
        // GTM-A1/B4: capture WHY a refresh was refused. 'no_refresh_token'
        // means this browser never held a session, which is a different fact
        // from "your session expired" and must not be reported as one.
        lastRefreshErrorRef.current = null;
        if (!response.ok) {
            try {
                const body = await response.clone().json();
                lastRefreshErrorRef.current = body?.error || null;
            } catch { /* non-JSON refusal: leave null and fall back */ }
        }
        if (response.ok) lastRefreshAtRef.current = Date.now();
        return response.ok;
    };

    // A refresh that returned 401/403 means the session is genuinely dead
    // (logout / stop keepalive). 429 (rate-limited) or 5xx is transient — the
    // session may still be valid, so must NOT trigger logout.
    const isDefinitiveRefreshFailure = () =>
        lastRefreshStatusRef.current === 401 || lastRefreshStatusRef.current === 403;

    // TRUST-GATE-1.14b — proactive refresh keepalive. Purely additive: does
    // not touch logout/refresh-failure handling in authFetch/checkAuth above.
    // While a user session is active and the tab is visible, schedules a
    // refreshToken() call at ~80% of ACCESS_TOKEN_LIFETIME_MS since the last
    // known-good refresh, and reschedules after each tick. Also fires an
    // immediate refresh on visibilitychange-to-visible if the last refresh
    // is already stale (e.g. the tab was backgrounded past the threshold).
    // This is a tab-scoped timer for session keepalive, not a background
    // job — it renews the httpOnly cookie AND slides the server's idle
    // window (services/auth/utils/sessionPolicy.js), so an actively-open
    // dashboard never hits the idle wall.
    useEffect(() => {
        if (!user || isDevMode) return undefined;

        let cancelled = false;
        let timerId = null;

        const clearScheduled = () => {
            if (timerId) {
                clearTimeout(timerId);
                timerId = null;
            }
        };

        const attemptProactiveRefresh = async () => {
            if (cancelled || document.visibilityState !== 'visible') return;
            try {
                const ok = await refreshToken();
                if (!ok && isDefinitiveRefreshFailure()) {
                    // DEFINITIVE rejection (401/403): the session is dead.
                    // refreshToken() returns false (never throws) here, so the
                    // catch below does NOT fire — and lastRefreshAtRef only
                    // advances on success, so scheduleNext would compute delay=0
                    // and re-arm instantly. That produced a ~5/sec proactive
                    // STORM once a session expired overnight with the tab
                    // visible. Stop the loop; the next real authFetch 401 owns
                    // the clean logout/redirect.
                    cancelled = true;
                    clearScheduled();
                }
                // If !ok but TRANSIENT (429 rate-limit / 5xx): do NOT stop — the
                // session may still be valid. Keep looping; the 30s scheduleNext
                // floor means at most one retry per 30s (no storm).
            } catch (err) {
                // Network error — leave lastRefreshAtRef as-is; the next
                // scheduled tick (or a visibilitychange check) will retry.
                console.warn('[Auth] Proactive refresh failed (will retry later):', err.message);
            }
        };

        // Only arms a timer while the tab is visible — while hidden, no
        // timer runs at all (avoids a hidden-tab tight-loop of zero-delay
        // reschedules once the threshold has already elapsed) and the
        // visibilitychange handler below does the catch-up + re-arm.
        const scheduleNext = () => {
            clearScheduled();
            if (cancelled || document.visibilityState !== 'visible') return;
            const elapsed = Date.now() - lastRefreshAtRef.current;
            // Floor at 30s so no code path can ever zero-delay-loop (defense in
            // depth alongside the stop-on-definitive-failure above). When it's
            // time to refresh, firing up to 30s late is harmless (proactive
            // refresh runs at ~80% of a 1h token, so ~48min in).
            const delay = Math.max(PROACTIVE_REFRESH_MS - elapsed, 30_000);
            timerId = setTimeout(async () => {
                await attemptProactiveRefresh();
                scheduleNext();
            }, delay);
        };

        scheduleNext();

        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            const elapsed = Date.now() - lastRefreshAtRef.current;
            if (elapsed >= PROACTIVE_REFRESH_MS) {
                attemptProactiveRefresh().then(scheduleNext);
            } else {
                scheduleNext();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            cancelled = true;
            clearScheduled();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshToken
        // is intentionally excluded (see #325 authFetch precedent above); it
        // closes over no per-render state and is stable in behavior.
    }, [user, isDevMode]);

    // TRUST-GATE-1.14c — inactivity warning. Purely advisory: it mirrors the
    // org/instance's own idle window (services/auth/utils/sessionPolicy.js,
    // surfaced via GET /me as session_policy) so a user sees it coming
    // instead of being silently bounced on their next click. It NEVER forces
    // a logout itself — when the countdown reaches zero the banner simply
    // hides and the existing 401 → logout path (authFetch/checkAuth) is the
    // sole authoritative mechanism, exactly as it is today. When idle logout
    // is disabled for this org/instance (idleTimeoutSec === 0, per
    // TRUST-GATE-1.14's 0="disabled" sentinel) this effect no-ops entirely —
    // no client-side timer runs at all.
    const IDLE_WARNING_WINDOW_SEC = 60;
    const IDLE_ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    const IDLE_ACTIVITY_THROTTLE_MS = 5000;

    useEffect(() => {
        const idleSec = sessionPolicy?.idleTimeoutSec;
        if (!user || isDevMode || !idleSec) {
            setIdleWarning(prev => (prev.visible ? { visible: false, secondsRemaining: 0 } : prev));
            return undefined;
        }

        lastActivityAtRef.current = Date.now();
        let lastRecordedAt = Date.now();
        const recordActivity = () => {
            const now = Date.now();
            if (now - lastRecordedAt < IDLE_ACTIVITY_THROTTLE_MS) return;
            lastRecordedAt = now;
            lastActivityAtRef.current = now;
        };
        IDLE_ACTIVITY_EVENTS.forEach(evt => window.addEventListener(evt, recordActivity, { passive: true }));

        const tick = () => {
            const remainingMs = idleSec * 1000 - (Date.now() - lastActivityAtRef.current);
            setIdleWarning(prev => {
                if (remainingMs <= 0 || remainingMs > IDLE_WARNING_WINDOW_SEC * 1000) {
                    return prev.visible ? { visible: false, secondsRemaining: 0 } : prev;
                }
                const secondsRemaining = Math.ceil(remainingMs / 1000);
                return (prev.visible && prev.secondsRemaining === secondsRemaining)
                    ? prev
                    : { visible: true, secondsRemaining };
            });
        };
        tick();
        const intervalId = setInterval(tick, 1000);

        return () => {
            IDLE_ACTIVITY_EVENTS.forEach(evt => window.removeEventListener(evt, recordActivity));
            clearInterval(intervalId);
        };
    }, [user, isDevMode, sessionPolicy?.idleTimeoutSec]);

    // Dismisses the warning and slides the idle window — same effect a real
    // click/keypress would have had — by piggy-backing on the existing
    // refreshToken() call (which also renews the httpOnly cookie and stamps
    // last_active_at server-side, see enforcement.js).
    const staySignedIn = async () => {
        lastActivityAtRef.current = Date.now();
        setIdleWarning({ visible: false, secondsRemaining: 0 });
        try {
            await refreshToken();
        } catch (err) {
            // Best-effort — if this genuinely fails the next real request's
            // 401 will surface it via the normal logout path.
            console.warn('[Auth] staySignedIn refresh failed:', err.message);
        }
    };

    // Read CSRF token from cookie for double-submit pattern
    const getCsrfToken = () => {
        const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
        return match ? match[1] : null;
    };

    // Fetch a fresh CSRF token when the cookie is empty/expired. Returns
    // the new token or null. Used to recover the org-switch flow (and any
    // other mutating call) when the user's csrf_token cookie has been
    // cleared without their session being invalidated.
    const ensureCsrfToken = async () => {
        let token = getCsrfToken();
        if (token) return token;
        try {
            const resp = await fetch('/api/csrf-token', { credentials: 'include' });
            if (!resp.ok) return null;
            const body = await resp.json().catch(() => null);
            return body?.csrfToken || getCsrfToken() || null;
        } catch {
            return null;
        }
    };

    const isMutatingMethod = (m) => {
        const method = (m || 'GET').toUpperCase();
        return method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
    };

    // Authenticated fetch wrapper - uses httpOnly cookies automatically
    const authFetch = useCallback(async (url, options = {}) => {
        let csrfToken = getCsrfToken();
        // If this is a mutating request and we have no token, try to mint one
        // before sending — otherwise the server will reject with 403 CSRF.
        if (!csrfToken && isMutatingMethod(options.method)) {
            csrfToken = await ensureCsrfToken();
        }
        const headers = { ...options.headers };
        if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
        }

        if (isDevBypassEnabled()) {
            return fetch(url, {
                ...options,
                credentials: 'include',
                headers
            });
        }

        let response;
        try {
            response = await fetch(url, {
                ...options,
                credentials: 'include',
                headers
            });
        } catch (networkErr) {
            // Network error (offline, DNS, connection refused) — do NOT logout
            console.warn('[Auth] Network error during fetch:', networkErr.message);
            throw networkErr;
        }

        // If unauthorized, try to refresh
        if (response.status === 401) {
            let refreshed = false;
            try {
                refreshed = await refreshToken();
            } catch {
                // Refresh failed due to network — don't logout, let caller handle
                console.warn('[Auth] Refresh failed (network), not logging out');
                return response;
            }
            if (refreshed) {
                // Re-read CSRF token (may have been rotated)
                const freshCsrf = getCsrfToken();
                const retryHeaders = { ...options.headers };
                if (freshCsrf) {
                    retryHeaders['X-CSRF-Token'] = freshCsrf;
                }
                return fetch(url, {
                    ...options,
                    credentials: 'include',
                    headers: retryHeaders
                });
            } else if (!isDefinitiveRefreshFailure()) {
                // Refresh was refused TRANSIENTLY (429 rate-limit / 5xx), not a
                // real 401/403 — the session may still be valid. Do NOT logout;
                // return the original 401 and let the caller deal with it. (A
                // rate-limited valid session must never be force-logged-out.)
                console.warn('[Auth] Refresh rate-limited/transient — not logging out');
                return response;
            } else {
                // Refresh returned a DEFINITIVE rejection (401/403) — session is
                // truly dead. Derive reason from the original 401 body.
                let authFetch401Body = null;
                try {
                    const cloned401 = response.clone();
                    authFetch401Body = await cloned401.json();
                } catch { /* non-JSON — fall back */ }
                const authFetchReasonKey =
                    authFetch401Body?.error === 'session_revoked'    ? 'session-revoked'    :
                    authFetch401Body?.error === 'membership_revoked' ? 'membership-revoked' :
                    authFetch401Body?.error === 'org_deleted'        ? 'org-deleted'        :
                                                                        'session-expired';
                try {
                    sessionStorage.setItem('quox-auth-redirect-reason', authFetchReasonKey);
                    const emailForStash = userRef.current?.email || userRef.current?.primary_email;
                    if (emailForStash) sessionStorage.setItem('quox-auth-redirect-email', emailForStash);
                } catch { /* sessionStorage unavailable */ }
                logout();
            }
        }

        // ET-ENFORCE — drop the session immediately on terminal 403s that
        // mean the current credential cannot continue (membership revoked,
        // org deleted, IP allowlist refusal). Non-destructive 403s like
        // forbidden_escalation pass through so the calling component can
        // toast them.
        if (response.status === 403) {
            try {
                const cloned = response.clone();
                const data = await cloned.json().catch(() => null);
                // CSRF mismatch — token rotated or cookie evicted. Mint a fresh
                // one and retry once. This unblocks the org switcher when the
                // session's CSRF state has drifted out from under us.
                if (data?.error === 'csrf_validation_failed' && isMutatingMethod(options.method)) {
                    const fresh = await ensureCsrfToken();
                    if (fresh) {
                        const retryHeaders = { ...options.headers, 'X-CSRF-Token': fresh };
                        return fetch(url, { ...options, credentials: 'include', headers: retryHeaders });
                    }
                }
                const desc = data ? describeServerError(data) : null;
                if (desc && desc.action === 'logout') {
                    // #325: stash the current user's email so LoginPage can
                    // pre-fill it after the enforcement bounce. Read from
                    // userRef so we always have the latest value even when
                    // the authFetch closure was captured before the user state
                    // last updated (authFetch useCallback dep = [logout] only).
                    try {
                        const currentUser = userRef.current;
                        const emailToStash = currentUser?.email || currentUser?.primary_email;
                        if (emailToStash) {
                            sessionStorage.setItem('quox-auth-redirect-email', emailToStash);
                        }
                    } catch { /* sessionStorage unavailable — skip */ }
                    setError(desc.message);
                    logout();
                }
            } catch {
                // Body wasn't JSON — let the caller handle it.
            }
        }

        return response;
    }, [logout]);

    const value = {
        user,
        loading,
        error,
        setupRequired,
        isDevMode,
        isAuthenticated: !!user || isDevMode,
        login,
        logout,
        signup,
        verifyMfa,
        authFetch,
        refreshToken,
        // M-P5 profiles: re-fetch GET /me so profile edits made outside the
        // login flow (avatar upload from the header user menu) reflect in
        // `user` without a full page reload.
        refreshUser: checkAuth,
        clearError: () => setError(null),
        // TRUST-GATE-1.14c — effective idle/max session policy (from GET
        // /me) and the advisory inactivity-warning state/dismisser. Null
        // policy or idleTimeoutSec === 0 both mean "no client-side timer".
        sessionPolicy,
        idleWarning,
        staySignedIn,
        // ET-ENFORCE — exposed so call sites (settings panels, member-edit
        // dialogs, secret-reveal screens) can translate 4xx server error
        // codes into user-facing copy without duplicating the table.
        describeServerError,
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

export default AuthContext;

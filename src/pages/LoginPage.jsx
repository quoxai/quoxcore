/**
 * Login Page — professional, glass-DS, Commander Sigil mark.
 *
 * No boot theater. No HAL eye. Form interactive on first paint.
 * Auth API unchanged; preserves test selectors (#email, #password,
 * #displayName, #mfaCode, h1.ui-auth-title, .ui-auth-subtitle).
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Input, FormField, Alert, CodeInput } from '../components/ui/Input'
import Button from '../components/ui/Button'
import { fetchSsoDiscovery, loginUrlFor } from '../services/ssoClient'
import LoginSigil from '../components/login/LoginSigil'
import LoginEyeBackdrop from '../components/login/LoginEyeBackdrop'
import '../components/login/LoginEyeBackdrop.css'
import '../components/ui/ui.css'
import './LoginPage.css'

// HTTPS enforcement — voice/mic requires secure context
const isInsecure = typeof window !== 'undefined'
    && window.location.protocol === 'http:'
    && window.location.hostname !== 'localhost'
    && window.location.hostname !== '127.0.0.1'

// DEMO-SERVER banner + credential pre-fill. Gated on VITE_DEMO_BANNER (build-time,
// demo box only — distinct from VITE_DEMO_MODE which is offline/mock mode). The
// public demo runs one shared superadmin account and wipes itself every 15 minutes.
const DEMO = import.meta.env.VITE_DEMO_BANNER === 'true'
const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL || 'demo@example.com'
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD || 'QuoxDemo-2026'

// CLARITY-3: the bare '/health' path is served directly by nginx itself
// (dashboard container liveness stub — see nginx.conf) and always returns
// 200 regardless of whether the auth service is actually up. It was never
// checking auth. '/api/auth/me' is the same auth-liveness probe healthCheck.js
// uses (CORE_SERVICES.auth.requiredEndpoints) — a 401 there means auth IS
// responding (just correctly rejecting the unauthenticated request).
const LOGIN_SERVICES = [
    { key: 'auth', label: 'Auth', url: '/api/auth/me' },
    { key: 'memory', label: 'Memory', url: '/api/memory/health' },
    { key: 'qdrant', label: 'Vector DB', url: '/qdrant/' },
]

function ServiceStatusLights() {
    const [services, setServices] = useState({})

    useEffect(() => {
        const checkAll = async () => {
            const results = {}
            await Promise.all(LOGIN_SERVICES.map(async (svc) => {
                try {
                    const res = await fetch(svc.url, { signal: AbortSignal.timeout(3000) })
                    results[svc.key] = res.status < 500
                } catch {
                    results[svc.key] = false
                }
            }))
            setServices(results)
        }
        checkAll()
        const interval = setInterval(checkAll, 30000)
        return () => clearInterval(interval)
    }, [])

    if (Object.keys(services).length === 0) return null
    const allUp = LOGIN_SERVICES.every(s => services[s.key])

    return (
        <div className="login-status">
            <span className={`login-status-dot ${allUp ? 'up' : 'mixed'}`} aria-hidden />
            <span className="login-status-text">
                {LOGIN_SERVICES.map(svc => (
                    <span key={svc.key} className={services[svc.key] ? 'up' : 'down'}>
                        {svc.label}
                    </span>
                )).reduce((acc, el, i) => i === 0 ? [el] : [...acc, ' · ', el], [])}
            </span>
        </div>
    )
}


function DemoBanner() {
    return (
        <div
            className="glass"
            style={{
                width: '100%',
                maxWidth: '420px',
                margin: '0 auto 16px',
                padding: '16px 18px',
                borderRadius: '14px',
                border: '1px solid var(--hal-green, #30d158)',
                boxShadow: '0 0 0 1px rgba(48,209,88,0.15)',
                textAlign: 'left',
                fontSize: '13px',
                lineHeight: 1.5,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--hal-green, #30d158)" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
                </svg>
                <strong style={{ letterSpacing: '0.5px', color: 'var(--hal-green, #30d158)' }}>DEMO SERVER</strong>
            </div>
            <div style={{ color: 'var(--text-secondary, #b8c0cc)' }}>
                Sign in with the credentials below (already filled in):
                <div style={{ margin: '8px 0', fontFamily: 'monospace', color: 'var(--text-primary, #eef2f7)' }}>
                    {DEMO_EMAIL}<br />{DEMO_PASSWORD}
                </div>
                To use chat, open <strong>Settings → Provider Keys</strong> and paste your own
                Anthropic or OpenAI API key (BYOK). This server <strong>wipes all data every 15 minutes</strong>,
                so keys and anything you create are removed automatically.
            </div>
        </div>
    )
}


const SESSION_REDIRECT_REASON_KEY = 'quox-auth-redirect-reason';

const SESSION_REDIRECT_MESSAGES = {
    'session-expired':    'Your session timed out. Please sign in again.',
    'session-revoked':    'Your session was revoked. Please sign in again.',
    'membership-revoked': 'Your access to this organisation has been removed. Please sign in again.',
    'org-deleted':        'This organisation has been deleted.',
    // GTM-A1/B4: a lockout used to render as "Your session timed out", which
    // sent people to re-enter credentials that were never the problem.
    'rate-limited':       'Too many sign-in attempts. Please wait a few minutes and try again.',
};

export default function LoginPage() {
    const navigate = useNavigate()
    const {
        login,
        signup,
        verifyMfa,
        error,
        clearError,
        isAuthenticated,
    } = useAuth()

    // ET-6D.3 — honor ?return_to=... for the guest invite flow. Only
    // allow same-origin paths to prevent open-redirect.
    const returnTo = (() => {
        const raw = new URLSearchParams(window.location.search).get('return_to') || ''
        return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/'
    })()

    useEffect(() => {
        if (isAuthenticated) navigate(returnTo)
    }, [isAuthenticated, navigate, returnTo])

    // CLARITY-CONSOLE-9: read and clear the session-redirect reason flag so
    // the user knows why they were bounced to login.
    const [redirectReason, setRedirectReason] = useState(() => {
        const reason = sessionStorage.getItem(SESSION_REDIRECT_REASON_KEY)
        if (reason) sessionStorage.removeItem(SESSION_REDIRECT_REASON_KEY)
        return reason || null
    })

    const [mode, setMode] = useState('login')
    // #325 / #327: read pre-fill email written by the bouncer on any logout
    // path (401 or 403 enforcement), clear it immediately so it doesn't
    // persist to the next user's session.
    const [email, setEmail] = useState(() => {
        try {
            const prefill = sessionStorage.getItem('quox-auth-redirect-email')
            if (prefill) {
                sessionStorage.removeItem('quox-auth-redirect-email')
                return prefill
            }
        } catch { /* sessionStorage unavailable */ }
        return DEMO ? DEMO_EMAIL : ''
    })
    const [password, setPassword] = useState(DEMO ? DEMO_PASSWORD : '')
    const [rememberMe, setRememberMe] = useState(false)
    const [displayName, setDisplayName] = useState('')
    const [mfaCode, setMfaCode] = useState('')
    const [mfaToken, setMfaToken] = useState(null)
    const [loading, setLoading] = useState(false)
    const [signupSuccess, setSignupSuccess] = useState(false)
    const [ssoProvider, setSsoProvider] = useState(null)

    // ET-2 Phase C: discover SSO provider for typed email (debounced).
    useEffect(() => {
        if (mode !== 'login') { setSsoProvider(null); return }
        if (!email || !email.includes('@')) { setSsoProvider(null); return }
        let cancelled = false
        const t = setTimeout(async () => {
            try {
                const p = await fetchSsoDiscovery(email)
                if (!cancelled) setSsoProvider(p)
            } catch {
                if (!cancelled) setSsoProvider(null)
            }
        }, 400)
        return () => { cancelled = true; clearTimeout(t) }
    }, [email, mode])

    const handleSubmit = async (e) => {
        e.preventDefault()
        setLoading(true)
        clearError()
        setSignupSuccess(false)

        try {
            if (mfaToken) {
                const result = await verifyMfa(mfaToken, mfaCode)
                if (result.success) navigate(returnTo)
            } else if (mode === 'signup') {
                const result = await signup(email, password, displayName)
                if (result.success) {
                    setPassword('')
                    if (result.signedIn) {
                        // GTM-A1/B5: the account is already signed in, with a
                        // workspace provisioned. Sending the user back to the
                        // login form to retype the credentials they chose ten
                        // seconds ago was a needless drop-off at the exact
                        // moment they have the most momentum.
                        setRedirectReason(null)
                        navigate(returnTo)
                        return
                    }
                    setSignupSuccess(true)
                    setMode('login')
                }
            } else {
                const result = await login(email, password, rememberMe)
                if (result.success) {
                    // Explicit save-password signal: this SPA login is
                    // fetch()+preventDefault()+client-side navigate, so the
                    // native submit/navigation events browser password
                    // managers key off never fire. Chromium-family honors
                    // the Credential Management API; Firefox/Safari keep
                    // relying on their own heuristics. Best-effort.
                    if (window.PasswordCredential) {
                        try {
                            const cred = new window.PasswordCredential({ id: email, password, name: email })
                            await navigator.credentials.store(cred)
                        } catch { /* non-blocking */ }
                    }
                    // Insecure-context (http on LAN IP → PasswordCredential is
                    // undefined, [SecureContext]-gated) and non-Chromium
                    // fallback: force a REAL navigation instead of SPA routing
                    // so the browser's native form-submit heuristic fires and
                    // offers to save the password. Works over http;
                    // credentials.store() above still wins on https.
                    if (isInsecure || !window.PasswordCredential) {
                        window.location.assign(returnTo)
                    } else {
                        navigate(returnTo)
                    }
                } else if (result.requiresMfa) {
                    setMfaToken(result.mfaToken)
                } else if (result.ssoRequired && result.loginUrl) {
                    window.location.href = result.loginUrl
                } else if (result.action === 'enroll_mfa') {
                    // #321: org requires MFA but user has none enrolled, so no
                    // access token is issued. LAUNCH-SPINE: the backend now
                    // returns a single-use enrolment ticket alongside the
                    // refusal, which lets the enrol page run the real TOTP setup
                    // instead of telling the user to email an administrator.
                    // Passed via router state, NOT the query string: a ticket in
                    // the URL ends up in browser history, referrer headers and
                    // server logs.
                    const params = new URLSearchParams({ email })
                    navigate(`/mfa/enroll?${params}`, {
                        state: result.enrolmentTicket ? { enrolmentTicket: result.enrolmentTicket } : undefined,
                    })
                } else if (result.action === 'mfa_challenge') {
                    // #322-FE: per-request MFA gate — user is authenticated
                    // but token lacks mfa_verified claim for this org.
                    const params = new URLSearchParams({ email })
                    navigate(`/mfa/challenge?${params}`)
                }
            }
        } finally {
            setLoading(false)
        }
    }

    const subtitle = mfaToken
        ? 'Enter your verification code'
        : mode === 'signup'
            ? 'Create your account'
            : 'Sign in to your workspace'

    return (
        <div className="login-page glass-page">
            <div className="login-eye-backdrop">
                <LoginEyeBackdrop />
            </div>
            <div className="login-content">
                {isInsecure && (
                    <div className="login-https-warning">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <div>
                            <strong>Insecure connection</strong> — HTTPS is required for voice, microphone, and secure authentication.
                            Access via <a href={`https://${window.location.hostname}:${window.location.port || 3000}${window.location.pathname}`}>HTTPS</a> instead.
                        </div>
                    </div>
                )}

                {DEMO && <DemoBanner />}

                <div className="login-card glass">
                    <header className="login-header">
                        <LoginSigil size={140} />
                        <p className="ui-auth-subtitle login-subtitle">{subtitle}</p>
                    </header>

                    {redirectReason && (
                        <div data-testid="session-redirect-banner">
                            <Alert variant="warning" className="ui-mb-4">
                                {SESSION_REDIRECT_MESSAGES[redirectReason] ?? 'Could not refresh session — please sign in again.'}
                            </Alert>
                        </div>
                    )}
                    {error && <Alert variant="error" className="ui-mb-4">{error}</Alert>}
                    {signupSuccess && <Alert variant="success" className="ui-mb-4">Account created successfully! Please sign in.</Alert>}

                    <form onSubmit={handleSubmit} className="login-form">
                        {!mfaToken ? (
                            <>
                                {mode === 'signup' && (
                                    <FormField label="Display Name" htmlFor="displayName">
                                        <Input
                                            id="displayName"
                                            type="text"
                                            value={displayName}
                                            onChange={(e) => setDisplayName(e.target.value)}
                                            required
                                            placeholder="Your name"
                                            autoComplete="name"
                                            disabled={loading}
                                        />
                                    </FormField>
                                )}

                                <FormField label="Email" htmlFor="email">
                                    <Input
                                        id="email"
                                        type="email"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                        required
                                        placeholder="you@example.com"
                                        autoComplete="email"
                                        disabled={loading}
                                        autoFocus
                                    />
                                </FormField>

                                {mode === 'login' && ssoProvider && (
                                    <div className="ui-auth-sso-block">
                                        <a className="ui-auth-sso-button" href={loginUrlFor(ssoProvider.provider_id, '/')}>
                                            <span>Sign in with {ssoProvider.display_name}</span>
                                        </a>
                                        {ssoProvider.sso_only ? (
                                            <div className="ui-auth-sso-hint">Your organisation requires single sign-on.</div>
                                        ) : (
                                            <div className="ui-auth-sso-divider"><span>or use your password</span></div>
                                        )}
                                    </div>
                                )}

                                {(mode !== 'login' || !ssoProvider?.sso_only) && (
                                    <FormField
                                        label="Password"
                                        htmlFor="password"
                                        hint={mode === 'signup' ? 'Minimum 12 characters with letters and numbers' : undefined}
                                    >
                                        <Input
                                            id="password"
                                            type="password"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            required
                                            minLength={mode === 'signup' ? 12 : undefined}
                                            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                                            disabled={loading}
                                        />
                                    </FormField>
                                )}

                                {mode === 'login' && (!ssoProvider?.sso_only) && (
                                    <label className="login-remember-me">
                                        <input
                                            type="checkbox"
                                            id="rememberMe"
                                            checked={rememberMe}
                                            onChange={(e) => setRememberMe(e.target.checked)}
                                            disabled={loading}
                                        />
                                        <span>Remember me</span>
                                    </label>
                                )}
                            </>
                        ) : (
                            <FormField label="Verification Code" htmlFor="mfaCode">
                                <CodeInput
                                    id="mfaCode"
                                    value={mfaCode}
                                    onChange={(e) => setMfaCode(e.target.value)}
                                    placeholder="000000"
                                    maxLength={6}
                                    required
                                    autoFocus
                                    disabled={loading}
                                />
                                <button
                                    type="button"
                                    onClick={() => { setMfaToken(null); setMfaCode('') }}
                                    className="ui-auth-link login-back"
                                    disabled={loading}
                                >
                                    Back to login
                                </button>
                            </FormField>
                        )}

                        <Button
                            type="submit"
                            variant="primary"
                            loading={loading}
                            disabled={loading}
                            className="login-submit-btn"
                            style={{ width: '100%', marginTop: '4px' }}
                        >
                            {mfaToken ? 'Verify' : (mode === 'signup' ? 'Create Account' : 'Sign In')}
                        </Button>
                    </form>

                    <div className="login-footer">
                        {mode === 'login' ? (
                            <button
                                type="button"
                                onClick={() => { setMode('signup'); clearError(); setSignupSuccess(false) }}
                                className="ui-auth-link"
                                disabled={loading}
                            >
                                Create an account
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() => { setMode('login'); clearError() }}
                                className="ui-auth-link"
                                disabled={loading}
                            >
                                Already have an account? Sign in
                            </button>
                        )}
                    </div>
                </div>

                <ServiceStatusLights />
            </div>
        </div>
    )
}

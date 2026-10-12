/**
 * EmailNotConnectedNotice — shared inline nudge for any feature that
 * depends on outbound email (SMTP is a product onboarding surface,
 * not a creds handoff). Fetches /api/admin/email/status once; renders
 * nothing while loading and nothing once email is configured, so it's
 * safe to drop next to any email-dependent control without extra
 * plumbing from the caller.
 *
 * Usage: <EmailNotConnectedNotice featureLabel="transcript email" />
 */

import { useEffect, useState } from 'react';

const AUTH_API = '/api';
const CONNECT_EMAIL_HREF = '/settings#instance/email';

export default function EmailNotConnectedNotice({ featureLabel }) {
    const [state, setState] = useState('loading'); // 'loading' | 'configured' | 'not_configured' | 'forbidden'

    useEffect(() => {
        let live = true;
        (async () => {
            try {
                const res = await fetch(`${AUTH_API}/admin/email/status`, { credentials: 'include' });
                if (!live) return;
                if (res.status === 401 || res.status === 403) { setState('forbidden'); return; }
                if (!res.ok) { setState('not_configured'); return; }
                const data = await res.json();
                setState(data.configured ? 'configured' : 'not_configured');
            } catch {
                if (live) setState('not_configured');
            }
        })();
        return () => { live = false; };
    }, []);

    if (state === 'loading' || state === 'configured') return null;

    const message = state === 'forbidden'
        ? `Email delivery is not connected on this instance, so ${featureLabel} cannot send yet. Ask your instance administrator to connect email in Settings.`
        : `Email delivery is not connected on this instance, so ${featureLabel} cannot send yet.`;

    return (
        <div role="note" style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '8px 12px', borderRadius: 8, fontSize: 11,
            background: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.28)',
            color: '#f59e0b',
        }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                <path d="M12 9v4" /><path d="M12 17h.01" />
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
            <span>{message}</span>
            {state === 'not_configured' && (
                <a href={CONNECT_EMAIL_HREF} style={{ color: '#fbbf24', fontWeight: 700, textDecoration: 'underline' }}>
                    Connect email
                </a>
            )}
        </div>
    );
}

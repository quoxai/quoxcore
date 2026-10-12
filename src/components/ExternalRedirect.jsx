/**
 * ExternalRedirect Component
 * Redirects to an external URL (outside React Router)
 */

import { useEffect } from 'react'

export default function ExternalRedirect({ to }) {
    useEffect(() => {
        window.location.href = to
    }, [to])

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            background: 'var(--bg-primary, #0a0a0f)',
            color: 'var(--text-primary, #f5f5f5)',
            fontFamily: 'system-ui, sans-serif'
        }}>
            <p>Redirecting to {to}...</p>
        </div>
    )
}

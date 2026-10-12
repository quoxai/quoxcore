/**
 * AccessDenied - Shown when user lacks required role/capability for a route
 */

import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';

export default function AccessDenied() {
    const navigate = useNavigate();
    const { currentOrg } = useWorkspace();
    const role = currentOrg?.membership?.role;

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '60vh',
            gap: '16px',
            color: 'var(--m-text-secondary, #999)',
            padding: '24px'
        }}>
            <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                style={{ width: '48px', height: '48px', opacity: 0.6 }}
            >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <h2 style={{
                margin: 0,
                fontSize: '18px',
                fontWeight: 600,
                color: 'var(--m-text-primary, #e0e0e0)'
            }}>
                You don't have access to this page
            </h2>
            {role && (
                <p style={{ margin: 0, fontSize: '13px' }}>
                    Your role: <span style={{ fontWeight: 600, color: 'var(--m-text-primary, #e0e0e0)' }}>{role}</span>
                </p>
            )}
            <button
                onClick={() => navigate('/dashboard')}
                style={{
                    marginTop: '8px',
                    padding: '8px 20px',
                    background: 'var(--m-bg-elevated, #1e1e2e)',
                    border: '1px solid var(--m-border-default, #333)',
                    borderRadius: 'var(--m-radius-md, 6px)',
                    color: 'var(--m-text-primary, #e0e0e0)',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 500,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                }}
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: '14px', height: '14px' }}>
                    <rect x="3" y="3" width="7" height="7"/>
                    <rect x="14" y="3" width="7" height="7"/>
                    <rect x="14" y="14" width="7" height="7"/>
                    <rect x="3" y="14" width="7" height="7"/>
                </svg>
                Go to Dashboard
            </button>
        </div>
    );
}

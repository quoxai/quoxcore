/**
 * ObservabilityLayout — SET-IA Phase 2.
 *
 * Top-level peer surface to /settings and /admin. Houses runtime
 * telemetry (logs, errors, feedback, health, overview, audit) that
 * was previously scattered under /admin/*.
 *
 * Access gate: same as AdminLayout — must succeed on /api/admin/stats
 * (any instance-admin tier including readonly).
 */

import { useState, useEffect } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { useFeedbackStats } from '../../hooks/useFeedbackStats'
import {
    LayoutDashboard, Activity, ScrollText, MessageSquare,
    AlertTriangle, BookOpen, ArrowLeft,
} from 'lucide-react'
import './observability.css'

const AUTH_API = '/api'

// Audit Trail is hidden from the sidebar until it has real content
// (the existing AuditTrail.jsx is a placeholder pointing users at
// /orgs/:id activity). Route still exists for direct linking.
const NAV_ITEMS = [
    { path: '',         label: 'Overview',      icon: LayoutDashboard, end: true },
    { path: 'health',   label: 'Service Health', icon: Activity },
    { path: 'logs',     label: 'System Logs',   icon: ScrollText },
]

const SUPPORT_ITEMS = [
    { path: 'feedback', label: 'User Feedback',  icon: MessageSquare,   badgeKey: 'feedbackCount' },
    { path: 'errors',   label: 'Error Reports',  icon: AlertTriangle,   badgeKey: 'errorReportCount' },
]

export default function ObservabilityLayout() {
    const [user, setUser] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const { feedbackCount, errorReportCount } = useFeedbackStats()

    useEffect(() => { checkAuth() }, [])

    const checkAuth = async () => {
        try {
            const res = await fetch(`${AUTH_API}/auth/me`, { credentials: 'include' })
            if (!res.ok) {
                setError(res.status === 401 ? 'Not authenticated' : 'Session expired')
                setLoading(false)
                return
            }
            const data = await res.json()
            const adminRes = await fetch(`${AUTH_API}/admin/stats`, { credentials: 'include' })
            if (!adminRes.ok) {
                setError('Instance admin access required')
                setLoading(false)
                return
            }
            setUser(data.user)
            setLoading(false)
        } catch {
            setError('Failed to verify observability access')
            setLoading(false)
        }
    }

    if (loading) {
        return (
            <div className="admin-page">
                <div className="admin-loading">
                    <div className="loading-indicator">AUTHENTICATING...</div>
                </div>
            </div>
        )
    }

    if (error) {
        return (
            <div className="admin-page">
                <div className="admin-error">
                    <div className="error-icon">!</div>
                    <h2>Access Denied</h2>
                    <p>{error}</p>
                    <Link to="/" className="btn-back">Return to Dashboard</Link>
                </div>
            </div>
        )
    }

    return (
        <div className="admin-page">
            <header className="admin-header" style={{ boxShadow: '0 1px 0 rgba(56, 189, 248, 0.1)' }}>
                <Link to="/" className="admin-logo">
                    <img src="/logo-quox-icon.png?v=3" alt="QuoxCORE Observability" className="admin-logo-img" />
                </Link>
                <div className="admin-title">
                    <span className="title-label">OBSERVABILITY</span>
                </div>
                <div className="admin-user">
                    <span className="user-email">{user?.email}</span>
                </div>
            </header>

            <div className="admin-layout">
                <nav className="admin-sidebar">
                    <div className="sidebar-section">
                        <div className="section-title">SYSTEM</div>
                        {NAV_ITEMS.map(item => (
                            <NavLink
                                key={item.path}
                                to={`/observability/${item.path}`}
                                end={item.end}
                                className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                            >
                                {({ isActive }) => (
                                    <>
                                        <span className="nav-icon">
                                            <item.icon size={16} style={{ stroke: isActive ? '#38bdf8' : 'rgba(255, 255, 255, 0.7)' }} />
                                        </span>
                                        <span className="nav-label">{item.label}</span>
                                    </>
                                )}
                            </NavLink>
                        ))}
                    </div>

                    <div className="sidebar-section">
                        <div className="section-title">SUPPORT</div>
                        {SUPPORT_ITEMS.map(item => {
                            const count = item.badgeKey === 'feedbackCount' ? feedbackCount : errorReportCount
                            return (
                                <NavLink
                                    key={item.path}
                                    to={`/observability/${item.path}`}
                                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                                >
                                    {({ isActive }) => (
                                        <>
                                            <span className="nav-icon">
                                                <item.icon size={16} style={{ stroke: isActive ? '#38bdf8' : 'rgba(255, 255, 255, 0.7)' }} />
                                            </span>
                                            <span className="nav-label">{item.label}</span>
                                            {count > 0 && <span className="admin-nav-badge">{count > 99 ? '99+' : count}</span>}
                                        </>
                                    )}
                                </NavLink>
                            )
                        })}
                    </div>

                    <div className="sidebar-section">
                        <div className="section-title">QUICK LINKS</div>
                        <Link to="/settings" className="nav-item">
                            <span className="nav-icon">
                                <BookOpen size={16} style={{ stroke: 'rgba(255, 255, 255, 0.7)' }} />
                            </span>
                            <span className="nav-label">Settings</span>
                        </Link>
                        <Link to="/" className="nav-item">
                            <span className="nav-icon">
                                <ArrowLeft size={16} style={{ stroke: 'rgba(255, 255, 255, 0.7)' }} />
                            </span>
                            <span className="nav-label">Back to Dashboard</span>
                        </Link>
                    </div>
                </nav>

                <main className="admin-content">
                    <Outlet />
                </main>
            </div>
        </div>
    )
}

/**
 * AppShell - Unified Application Shell
 *
 * The main layout wrapper for the unified QuoxCORE application.
 * Combines the HAL interface elements with the workspace navigation
 * into a single cohesive experience.
 *
 * Features:
 * - Collapsible sidebar navigation
 * - HAL eye always visible in sidebar header
 * - Quick chat access
 * - Unified header with user info
 * - Protected route handling
 */

import { BREADCRUMB_LEAF_EVENT, applyBreadcrumbLeaf } from './breadcrumbLeaf';
import { nextRouteRenderKey } from '../../lib/routeRenderKey';
import { useState, useEffect, useCallback, useMemo, useRef, Fragment, lazy, Suspense } from 'react';
import { Outlet, Navigate, useLocation, useNavigate, NavLink, Link } from 'react-router-dom';
import AuditorBanner from './AuditorBanner';
import IdleSessionWarning from './IdleSessionWarning';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSafety } from '../../contexts/SafetyContext';
import { KillSwitch, DefconIndicator } from '../safety/KillSwitch';
import { getEnabledExtensionsByCategory, searchExtensions } from '../../config/extensions';
import { hasRoleLevel } from '../../lib/policy';
import { isPluginLicensed } from '../../services/licenseValidator';
import { getNavSections } from '../../config/navRegistry';
import { initDatapointsWatcher, cleanupDatapointsWatcher } from '../../services/datapointsService';
import SystemHealthBadge from './SystemHealthBadge';
import QHorn from '../ui/QHorn';
import VoltStatusBadge from './VoltStatusBadge';
import AEEStatusBadge from './AEEStatusBadge';
import AOCLStatusBadge from './AOCLStatusBadge';
import WARDStatusBadge from './WARDStatusBadge';
import FeedbackModal from '../feedback/FeedbackModal';
import HeaderScopeSelector from './HeaderScopeSelector';
import AIRunningIndicator from './AIRunningIndicator';
import QuickBar, { isQuickBarPinned, toggleQuickBarItem } from './QuickBar';
import HeaderInboxBadge from './HeaderInboxBadge';
import GlobalSearch from './GlobalSearch';
import HeaderUserMenu from './HeaderUserMenu';
import { useInboxStats } from '../../hooks/useInboxStats';
import { useBackupStatus } from '../../hooks/useBackupStatus';
import { useUpdateStatus } from '../../hooks/useUpdateStatus';
import { useInboxNotifyStreams } from '../../hooks/useInboxStream';
import { initQuoxSound } from '../../services/quoxSound';
import { createInboxSoundTracker } from '../../services/quoxSoundInbox';
import { notifyInboxItem } from '../../services/desktopNotify';
import useExecutionSync from '../../hooks/useExecutionSync';
import { useActionStats } from '../../hooks/useActionStats';
import { buildAuthApiUrl } from '../../services/authApiUrl';
import { preloadShellRoute, warmCriticalShellRoutes } from '../../services/routePreloader';
import './app-shell.css';

// SDK-DX P4: lazy — the agent dock loads ChatTab's weight only when a plugin
// actually summons it via pluginApi.chat.openSidebar().
const AgentChatPanel = lazy(() =>
    import('../chat/AgentChatPanel').then((m) => ({ default: m.AgentChatPanel }))
);

function routeDebugEnabled() {
    if (!import.meta.env.DEV || typeof window === 'undefined') return false;
    try {
        return localStorage.getItem('quox_route_debug') === 'true';
    } catch {
        return false;
    }
}

// Simple HAL-style eye indicator for sidebar (CSS-based, not full HALVisualizer)
function MiniHALEye({ state = 'idle' }) {
    const stateColors = {
        idle: '#38bdf8',
        listening: '#3090ff',
        thinking: '#ff9030',
        speaking: '#30ff90',
        error: '#38bdf8'
    };
    const color = stateColors[state] || stateColors.idle;

    return (
        <div className="mini-hal-eye" style={{ '--hal-color': color }}>
            <div className="mini-hal-eye__inner" />
        </div>
    );
}

// Navigation configuration sourced from navRegistry (supports third-party plugin items)
// getNavSections() moved to src/config/navRegistry.js — see getNavSections()

// Icon components
const Icons = {
    target: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/>
            <circle cx="12" cy="12" r="6"/>
            <circle cx="12" cy="12" r="2"/>
        </svg>
    ),
    eye: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
        </svg>
    ),
    grid: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="7" height="7"/>
            <rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/>
            <rect x="3" y="14" width="7" height="7"/>
        </svg>
    ),
    server: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            <line x1="6" y1="6" x2="6.01" y2="6"/>
            <line x1="6" y1="18" x2="6.01" y2="18"/>
        </svg>
    ),
    shield: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
    ),
    cpu: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="4" y="4" width="16" height="16" rx="2" ry="2"/>
            <rect x="9" y="9" width="6" height="6"/>
            <line x1="9" y1="1" x2="9" y2="4"/>
            <line x1="15" y1="1" x2="15" y2="4"/>
            <line x1="9" y1="20" x2="9" y2="23"/>
            <line x1="15" y1="20" x2="15" y2="23"/>
            <line x1="20" y1="9" x2="23" y2="9"/>
            <line x1="20" y1="14" x2="23" y2="14"/>
            <line x1="1" y1="9" x2="4" y2="9"/>
            <line x1="1" y1="14" x2="4" y2="14"/>
        </svg>
    ),
    tool: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
    ),
    'git-branch': () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="6" y1="3" x2="6" y2="15"/>
            <circle cx="18" cy="6" r="3"/>
            <circle cx="6" cy="18" r="3"/>
            <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
    ),
    bot: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="10" rx="2"/>
            <circle cx="12" cy="5" r="2"/>
            <path d="M12 7v4"/>
            <line x1="8" y1="16" x2="8" y2="16"/>
            <line x1="16" y1="16" x2="16" y2="16"/>
        </svg>
    ),
    building: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 21h18"/>
            <path d="M5 21V7l8-4v18"/>
            <path d="M19 21V11l-6-4"/>
            <path d="M9 9v.01"/>
            <path d="M9 12v.01"/>
            <path d="M9 15v.01"/>
            <path d="M9 18v.01"/>
        </svg>
    ),
    briefcase: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
        </svg>
    ),
    settings: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
    ),
    chevronLeft: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
        </svg>
    ),
    chevronRight: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
        </svg>
    ),
    search: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.3-4.3"/>
        </svg>
    ),
    user: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
        </svg>
    ),
    logout: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
    ),
    menu: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
        </svg>
    ),
    database: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <ellipse cx="12" cy="5" rx="9" ry="3"/>
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
        </svg>
    ),
    eye: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
        </svg>
    ),
    activity: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
        </svg>
    ),
    folder: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
    ),
    topology: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="3"/>
            <circle cx="4" cy="4" r="2"/>
            <circle cx="20" cy="4" r="2"/>
            <circle cx="4" cy="20" r="2"/>
            <circle cx="20" cy="20" r="2"/>
            <path d="M12 9V6M12 15v3M9 12H6M15 12h3"/>
            <path d="M6.5 6.5l3 3M14.5 14.5l3 3M6.5 17.5l3-3M14.5 9.5l3-3"/>
        </svg>
    ),
    layers: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/>
            <polyline points="2 17 12 22 22 17"/>
            <polyline points="2 12 12 17 22 12"/>
        </svg>
    ),
    users: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
    ),
    inbox: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22 6 12 13 2 6"/>
        </svg>
    ),
    // INBOXQ-1: navRegistry's /inboxq row uses icon "mail" — distinct glyph
    // from "inbox" above (the internal HITL approvals queue) so the two
    // don't read as the same feature in the rail. Missing entries here
    // render a blank rail icon (see the "trending-up"/"mic"/"compass" notes
    // below), so this is added in the same commit as the nav row.
    mail: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="M2 6l10 7 10-7"/>
        </svg>
    ),
    // AQ-9B: navRegistry's /calendarq row uses icon "calendar" — missing
    // entries render a blank rail icon, same reasoning as "mail" above.
    calendar: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
    ),
    // NOTESQ-1: navRegistry's /notes row uses icon "file-text"; a missing entry
    // here renders a blank rail icon, so it is added with the nav row.
    'file-text': () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
            <path d="M14 3v6h6M8 13h8M8 17h6"/>
        </svg>
    ),
    bell: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
    ),
    tree: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="4" r="2"/>
            <line x1="12" y1="6" x2="12" y2="10"/>
            <line x1="6" y1="10" x2="18" y2="10"/>
            <line x1="6" y1="10" x2="6" y2="14"/>
            <line x1="18" y1="10" x2="18" y2="14"/>
            <circle cx="6" cy="16" r="2"/>
            <circle cx="18" cy="16" r="2"/>
            <line x1="6" y1="18" x2="6" y2="20"/>
            <line x1="18" y1="18" x2="18" y2="20"/>
        </svg>
    ),
    radar: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" opacity="0.3"/>
            <circle cx="12" cy="12" r="6" opacity="0.5"/>
            <circle cx="12" cy="12" r="2"/>
            <line x1="12" y1="12" x2="19" y2="5"/>
        </svg>
    ),
    // Extension-related icons
    puzzle: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.743-.953a2.5 2.5 0 1 0-4.95-.24 2.5 2.5 0 0 0 .289 1.193c.233.412.176.915-.136 1.227l-1.611 1.611a2.406 2.406 0 0 1-1.704.706 2.406 2.406 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-.777 1.004a2.5 2.5 0 1 1-4.95-.24 2.5 2.5 0 0 1 2.212-2.476c.311-.047.651.068.878.289L4.85 15.561c.47.47 1.087.706 1.704.706.617 0 1.234-.235 1.704-.706l1.611-1.611c.312-.312.369-.815.136-1.227a2.5 2.5 0 0 1 4.661-1.193c.097.453-.276.923-.743.953a.98.98 0 0 1-.837-.276L11.475 10.596a2.406 2.406 0 0 1-.706-1.704c0-.617.235-1.234.706-1.704l1.568-1.568c.23-.23.337-.556.289-.878-.074-.493-.504-.84-1.004-.777a2.5 2.5 0 1 1 .24-4.95 2.5 2.5 0 0 1 2.476 2.212c.047.311-.068.651-.289.878L13.143 4.717a2.406 2.406 0 0 1-.706 1.704c0 .617.235 1.234.706 1.704l1.611 1.611c.312.312.815.369 1.227.136a2.5 2.5 0 0 1 1.193 4.661c-.453.097-.923-.276-.953-.743a.98.98 0 0 1 .276-.837l1.611-1.611c.47-.47.706-1.087.706-1.704 0-.617-.235-1.234-.706-1.704L15.54 6.366c-.23-.23-.337-.556-.289-.878.074-.493.504-.84 1.004-.777a2.5 2.5 0 1 0-.24-4.95 2.5 2.5 0 0 0-2.476 2.212"/>
        </svg>
    ),
    award: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>
        </svg>
    ),
    'book-open': () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
    ),
    fileCheck: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="m9 15 2 2 4-4"/>
        </svg>
    ),
    box: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>
        </svg>
    ),
    // QUOXPLAN-MIGRATE: RepoBrain's nav entry names 'code-2' but the map never
    // had it, so the entry rendered iconless. Lucide-style code chevrons.
    'code-2': () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>
        </svg>
    ),
    // VULCAN #780: megaphone, the Gripe page's glyph. A missing key renders a blank icon.
    megaphone: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 11 18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>
        </svg>
    ),
    // QUOXPLAN-P4: octahedron — the Quox 3D node primitive, QuoxPlan's identity glyph.
    octahedron: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2 3 12l9 10 9-10z"/><path d="M3 12h18"/><path d="M12 2v20"/>
        </svg>
    ),
    plus: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
    ),
    chevronDown: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"/>
        </svg>
    ),
    chevronUp: () => (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15"/>
        </svg>
    ),
    userCheck: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="8.5" cy="7" r="4"/>
            <polyline points="17 11 19 13 23 9"/>
        </svg>
    ),
    gitBranch: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="6" y1="3" x2="6" y2="15"/>
            <circle cx="18" cy="6" r="3"/>
            <circle cx="6" cy="18" r="3"/>
            <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
    ),
    brain: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.54"/>
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.54"/>
        </svg>
    ),
    barChart: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="12" y1="20" x2="12" y2="10"/>
            <line x1="18" y1="20" x2="18" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="16"/>
        </svg>
    ),
    messageSquare: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
    ),
    phone: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
    ),
    headset: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
            <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
        </svg>
    ),
    send: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
    ),
    fileText: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
        </svg>
    ),
    archive: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="21 8 21 21 3 21 3 8"/>
            <rect x="1" y="3" width="22" height="5"/>
            <line x1="10" y1="12" x2="14" y2="12"/>
        </svg>
    ),
    book: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            <line x1="8" y1="6" x2="16" y2="6"/>
            <line x1="8" y1="10" x2="14" y2="10"/>
        </svg>
    ),
    filter: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
        </svg>
    ),
    beaker: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4.5 3h15"/>
            <path d="M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3"/>
            <path d="M6 14h12"/>
        </svg>
    ),
    network: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="5" r="3"/>
            <circle cx="5" cy="19" r="3"/>
            <circle cx="19" cy="19" r="3"/>
            <path d="M12 8v4M8.5 14.5L12 12l3.5 2.5"/>
        </svg>
    ),
    globe: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M2 12h20"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
    ),
    clock: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
        </svg>
    ),
    terminal: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
    ),
    zap: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
    ),
    x: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
    ),
    lock: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
    ),
    home: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
    ),
    clipboardList: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
            <line x1="8" y1="11" x2="16" y2="11"/>
            <line x1="8" y1="15" x2="16" y2="15"/>
            <line x1="8" y1="19" x2="12" y2="19"/>
        </svg>
    ),
    image: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
        </svg>
    ),
    'shield-lock': () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <rect x="9" y="10" width="6" height="5" rx="1"/>
            <path d="M10 10V8a2 2 0 0 1 4 0v2"/>
        </svg>
    ),
    key: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
        </svg>
    ),
    history: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3v5h5"/>
            <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/>
            <path d="M12 7v5l4 2"/>
        </svg>
    ),
    dashboard: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="7" height="9"/>
            <rect x="14" y="3" width="7" height="5"/>
            <rect x="14" y="12" width="7" height="9"/>
            <rect x="3" y="16" width="7" height="5"/>
        </svg>
    ),
    grafana: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(244, 104, 0, 0.9)' }} strokeWidth="1.5">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
        </svg>
    ),
    docker: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(36, 150, 237, 0.9)' }} strokeWidth="1.5">
            <rect x="2" y="12" width="4" height="4" rx="0.5"/>
            <rect x="7" y="12" width="4" height="4" rx="0.5"/>
            <rect x="12" y="12" width="4" height="4" rx="0.5"/>
            <rect x="7" y="7" width="4" height="4" rx="0.5"/>
            <rect x="12" y="7" width="4" height="4" rx="0.5"/>
            <rect x="12" y="2" width="4" height="4" rx="0.5"/>
            <path d="M2 16c0 2 1.5 4 6 5s8 .5 12-1c2-.75 3-2 3-4"/>
        </svg>
    ),
    linkedin: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(10, 102, 194, 0.9)' }} strokeWidth="1.5">
            <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/>
            <rect x="2" y="9" width="4" height="12"/>
            <circle cx="4" cy="4" r="2"/>
        </svg>
    ),
    youtube: () => (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5">
            <rect x="2" y="4" width="20" height="16" rx="4" style={{ stroke: 'rgba(255, 0, 0, 0.9)' }}/>
            <path d="M10 8.5v7l6-3.5-6-3.5z" style={{ fill: 'rgba(255, 0, 0, 0.9)' }}/>
        </svg>
    ),
    facebook: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(24, 119, 242, 0.9)' }} strokeWidth="1.5">
            <path d="M15 4h-2a5 5 0 0 0-5 5v3H6v4h2v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1h3z"/>
        </svg>
    ),
    instagram: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(228, 64, 95, 0.9)' }} strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="5"/>
            <circle cx="12" cy="12" r="4"/>
            <circle cx="17.5" cy="6.5" r="1.2" style={{ fill: 'rgba(228, 64, 95, 0.9)' }}/>
        </svg>
    ),
    tiktok: () => (
        <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8">
            <path d="M16 3v9.5a4 4 0 1 1-4-4V3" style={{ stroke: 'rgba(254, 44, 85, 0.9)' }} strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M16 3a5 5 0 0 0 5 5" style={{ stroke: 'rgba(37, 244, 238, 0.9)' }} strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
    ),
    // X-PLUGIN P3: brand accent is pure black, invisible on the dark rail —
    // use the visible off-white fallback (#E7E9EA at 0.9), per the manifest's
    // accentColorFallback.
    x: () => (
        <svg viewBox="0 0 24 24" style={{ fill: 'rgba(231, 233, 234, 0.9)' }}>
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
    ),
    prometheus: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(230, 82, 44, 0.9)' }} strokeWidth="1.5">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
    ),
    proxmox: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(229, 112, 0, 0.9)' }} strokeWidth="1.5">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
        </svg>
    ),
    wazuh: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(0, 169, 229, 0.9)' }} strokeWidth="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
    ),
    github: () => (
        <svg viewBox="0 0 24 24" style={{ fill: 'rgba(139, 92, 246, 0.9)' }}>
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>
    ),
    'uptime-kuma': () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(92, 221, 139, 0.9)' }} strokeWidth="1.5">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
    ),
    clipboardCheck: () => (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
            <path d="M9 14l2 2 4-4"/>
        </svg>
    ),
    // SIGNAL-EMBED: broadcast/wifi glyph for QuoxSignal — picking up signal
    // from watched external sources. Explicit rgba stroke (never currentColor
    // — it disappears on the dark theme once nested/inherited) at 0.9 opacity.
    signal: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(56, 189, 248, 0.9)' }} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h.01"/>
            <path d="M8.5 16.429a5 5 0 0 1 7 0"/>
            <path d="M5 12.859a10 10 0 0 1 14 0"/>
            <path d="M2 9.289a15 15 0 0 1 20 0"/>
        </svg>
    ),
    // QUOXLENS-UI: magnifying-glass glyph — a Lens judges an artifact, it
    // does not act on it. Explicit rgba stroke (never currentColor — see
    // house icon rule) at 0.9 opacity, amber rather than QuoxSignal's cyan
    // or QuoxPlan's octahedron purple so the three Developers-section icons
    // stay visually distinct at a glance.
    lens: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(251, 191, 36, 0.9)' }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7"/>
            <path d="m21 21-4.35-4.35"/>
        </svg>
    ),
    // QuoxSEO: rising-trend glyph. Its manifest sidebar icon is "trending-up",
    // which had no entry here so NavIcon rendered null (blank rail icon). Green
    // (QuoxSEO accent #34d399) keeps it distinct from signal cyan / lens amber /
    // octahedron purple in the Developers section. Explicit rgba stroke per the
    // house icon rule (never currentColor).
    'trending-up': () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(52, 211, 153, 0.9)' }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
            <polyline points="16 7 22 7 22 13"/>
        </svg>
    ),
    // Quox Voice: microphone glyph. Its manifest sidebar icon is "mic", which
    // had no entry here so the rail icon rendered blank (same class of bug as
    // "trending-up"). Rose accent to stay distinct. Explicit rgba stroke per
    // the house icon rule (never currentColor).
    mic: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(244, 114, 182, 0.9)' }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3"/>
            <path d="M5 10a7 7 0 0 0 14 0"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
        </svg>
    ),
    // QuoxTrade (star-alignment): compass glyph. Manifest sidebar icon is
    // "compass", missing from this map so the rail icon rendered blank. Indigo
    // accent. Explicit rgba stroke per the house icon rule.
    compass: () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(129, 140, 248, 0.9)' }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>
        </svg>
    ),
    // QLoop (qloop): refresh/loop glyph. navRegistry uses "refresh-cw", missing
    // from this map so the rail icon rendered blank. Teal accent. Explicit rgba
    // stroke per the house icon rule.
    'refresh-cw': () => (
        <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'rgba(94, 234, 212, 0.9)' }} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
    ),
};

function NavIcon({ name }) {
    const Icon = Icons[name];
    return Icon ? <Icon /> : null;
}

// Q Logo SVG — gradient cyan→purple, used in header
function QLogoSVG({ size = 24 }) {
    const h = size * (740 / 620);
    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 740" width={size} height={h}>
            <defs>
                <linearGradient id="q-logo-grad" x1="0" y1="0" x2="620" y2="0" gradientUnits="userSpaceOnUse">
                    <stop offset="0%" stopColor="#38bdf8" />
                    <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
            </defs>
            <g transform="translate(96,30) scale(0.72)">
                <path d="M450.532 359.603L400.532 273C565.532 211.001 473.032 164 488.532 94.5C504.032 25 546.032 0 546.032 0C546.032 0 521.173 49.0536 522.532 85.5C524.38 135.078 577.449 175.548 576.032 227.5C573.947 303.958 450.532 359.603 450.532 359.603Z" fill="url(#q-logo-grad)" />
                <path d="M125.528 359.603L175.528 273C10.5279 211.001 103.028 164 87.5279 94.5C72.0279 25 30.0279 0 30.0279 0C30.0279 0 54.8869 49.0536 53.5279 85.5C51.6792 135.078 -1.38893 175.548 0.0278679 227.5C2.113 303.958 125.528 359.603 125.528 359.603Z" fill="url(#q-logo-grad)" />
            </g>
            <g transform="translate(50,200)">
                <path d="M262.181 1.92871C284.097 2.34428 321.484 3.59138 348.179 7.35156C400.234 14.6836 431.354 36.4934 464.679 77.9629C511.474 136.194 506.182 266.278 506.179 266.352H506.035C506.405 278.968 508.307 382.893 472.884 441.409L537.178 497.719L529.178 566.719H427.178L377.932 517.592C368.718 520.411 358.808 522.563 347.994 524.086C321.446 527.825 284.325 529.078 262.361 529.501V529.719C262.361 529.719 258.937 529.716 253.178 529.646C247.426 529.716 244.003 529.719 243.994 529.719V529.501C222.03 529.078 184.909 527.825 158.361 524.086C106.307 516.754 75.1863 494.944 41.8611 453.475C-2.24106 398.594 -0.0773581 279.892 0.320081 266.352H0.181409C0.178448 266.279 -5.11349 136.194 41.6814 77.9629C75.0066 36.4934 106.127 14.6836 158.181 7.35156C184.877 3.59139 222.263 2.34428 244.179 1.92871V1.71875C244.188 1.71875 247.539 1.72075 253.18 1.78809C258.829 1.72067 262.181 1.71875 262.181 1.71875V1.92871ZM253.18 84.8887C211.412 85.2342 162.416 88.5837 138.181 112.352C112.356 137.68 106.629 202.685 106.68 265.086H106.861C106.732 327.871 112.361 393.586 138.361 419.086C162.56 442.819 211.449 446.192 253.178 446.546C269.601 446.407 287.132 445.8 303.832 443.668L234.178 374.181V316.719H330.511L389.933 368.762C395.717 338.812 396.569 301.457 396.494 265.086H396.68C396.771 202.685 394.005 137.68 368.179 112.352C343.945 88.5837 294.949 85.2342 253.18 84.8887Z" fill="url(#q-logo-grad)" />
            </g>
        </svg>
    );
}

// Compact backup status badge for header bar
function BackupHeaderBadge() {
    const { status, error } = useBackupStatus();
    const navigate = useNavigate();

    if (!status && !error) return null;

    const COLORS = { healthy: '#10b981', warning: '#f59e0b', critical: '#ef4444', unknown: '#6b7280' };
    const health = status?.health || 'unknown';
    const color = COLORS[health] || COLORS.unknown;
    const isCritical = health === 'critical';

    const label = health === 'healthy' ? 'Backups OK' : health === 'warning' ? 'Backup Warning' : health === 'critical' ? 'Backup Overdue' : 'Backup Unknown';

    return (
        <button
            className="app-shell__status-badge"
            onClick={() => navigate('/system')}
            title={label}
            style={{ cursor: 'pointer', background: 'none', border: 'none', padding: '5px 10px' }}
        >
            <span className={`status-dot ${isCritical ? 'status-dot--offline' : health === 'warning' ? 'status-dot--degraded' : health === 'healthy' ? 'status-dot--online' : 'status-dot--loading'}`} />
            <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.03em', color: 'var(--shell-text-muted)', fontFamily: "'SF Mono','Cascadia Code','JetBrains Mono','Fira Code',monospace" }}>Backups</span>
        </button>
    );
}

// Section icon mapping for the icon rail — maps nav section IDs to icons
const SECTION_ICON_MAP = {
    'home': 'home',
    'communications': 'messageSquare',
    'dev-suite': 'server',
    'work': 'terminal',
    'monitoring': 'activity',
    'vault': 'key',
    'organisation': 'building',
    'ai-studio': 'cpu',
    'social': 'globe',
    'intelligence': 'search',
    'governance': 'shield',
    'marketplace': 'grid',
    'platform': 'settings',
    'community-plugins': 'puzzle',
};

/**
 * ExtensionsSection - Collapsible sidebar section for extensions/plugins
 *
 * Features:
 * - Collapsible to save space when many extensions are installed
 * - Search/filter for finding extensions in large lists
 * - Grouped by category when expanded
 * - Visual indicators for badges (new, beta, notifications)
 * - Persists collapsed state
 */
function ExtensionsSection({ collapsed: sidebarCollapsed, userRole }) {
    const [isExpanded, setIsExpanded] = useState(() => {
        return localStorage.getItem('quox-extensions-expanded') !== 'false';
    });
    const [searchQuery, setSearchQuery] = useState('');
    const [showSearch, setShowSearch] = useState(false);

    // Recompute when third-party plugins/extensions finish hydrating. main.jsx
    // fires loadInstalledPlugins() async (no await) before render, so on a cold
    // load this section can mount with zero enabled extensions, read
    // totalExtensions === 0, and hide itself (return null below). 'quox-plugins-loaded'
    // (hydration done) and 'quox-plugin-nav-change' (register/unregister) bump this
    // version so extensionCategories recomputes; the immediate bump() catches
    // hydration that finished before this listener attached (the boot race, both ways).
    const [extVersion, setExtVersion] = useState(0);
    useEffect(() => {
        // INIT-OPT (2026-09-03): coalesce the burst. Plugins now activate
        // concurrently (thirdPartyPluginHost.loadInstalledPlugins), so a batch
        // of 'quox-plugin-nav-change' events lands within a frame or two on
        // boot. Debouncing the bump through rAF collapses that burst into ONE
        // recompute instead of one per plugin, so the sidebar rebuilds a single
        // time when hydration settles rather than flickering per icon.
        let scheduled = false;
        const bump = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; setExtVersion(v => v + 1); });
        };
        window.addEventListener('quox-plugins-loaded', bump);
        window.addEventListener('quox-plugin-nav-change', bump);
        bump();
        return () => {
            window.removeEventListener('quox-plugins-loaded', bump);
            window.removeEventListener('quox-plugin-nav-change', bump);
        };
    }, []);

    // Get enabled extensions grouped by category, filtered by role
    const extensionCategories = useMemo(() => {
        if (searchQuery.trim()) {
            // When searching, show flat list of matching extensions filtered by role
            let matches = searchExtensions(searchQuery).filter(ext => ext.enabled);
            if (userRole !== undefined) {
                matches = matches.filter(ext =>
                    !ext.minRole || hasRoleLevel(userRole, ext.minRole)
                );
            }
            return [{
                id: 'search-results',
                label: 'Search Results',
                extensions: matches
            }];
        }
        return getEnabledExtensionsByCategory(userRole);
    }, [searchQuery, userRole, extVersion]);

    // Total count of enabled extensions
    const totalExtensions = useMemo(() => {
        return extensionCategories.reduce((sum, cat) => sum + cat.extensions.length, 0);
    }, [extensionCategories]);

    // Persist expanded state
    useEffect(() => {
        localStorage.setItem('quox-extensions-expanded', isExpanded);
    }, [isExpanded]);

    // Auto-show search when there are many extensions
    const shouldShowSearch = totalExtensions > 5 && isExpanded && !sidebarCollapsed;

    // Toggle search visibility
    const handleToggleSearch = useCallback((e) => {
        e.stopPropagation();
        setShowSearch(prev => !prev);
        if (showSearch) {
            setSearchQuery('');
        }
    }, [showSearch]);

    // Clear search
    const handleClearSearch = useCallback(() => {
        setSearchQuery('');
    }, []);

    if (totalExtensions === 0) {
        return null; // Don't show section if no extensions enabled
    }

    return (
        <div className={`sidebar__extensions ${isExpanded ? 'sidebar__extensions--expanded' : ''}`}>
            {/* Section Header - Collapsible */}
            <button
                className="sidebar__extensions-header"
                onClick={() => setIsExpanded(prev => !prev)}
                aria-expanded={isExpanded}
            >
                <div className="sidebar__extensions-header-left">
                    <span className="sidebar__extensions-icon">
                        <NavIcon name="puzzle" />
                    </span>
                    {!sidebarCollapsed && (
                        <>
                            <span className="sidebar__extensions-label">Extensions</span>
                            <span className="sidebar__extensions-count">{totalExtensions}</span>
                        </>
                    )}
                </div>
                {!sidebarCollapsed && (
                    <span className="sidebar__extensions-chevron">
                        <NavIcon name={isExpanded ? 'chevronUp' : 'chevronDown'} />
                    </span>
                )}
            </button>

            {/* Expanded Content */}
            {isExpanded && !sidebarCollapsed && (
                <div className="sidebar__extensions-content">
                    {/* Search Bar (shown for 5+ extensions) */}
                    {shouldShowSearch && (
                        <div className="sidebar__extensions-search-wrapper">
                            {showSearch ? (
                                <div className="sidebar__extensions-search">
                                    <NavIcon name="search" />
                                    <input
                                        type="text"
                                        placeholder="Filter extensions..."
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        className="sidebar__extensions-search-input"
                                        autoFocus
                                    />
                                    {searchQuery && (
                                        <button
                                            className="sidebar__extensions-search-clear"
                                            onClick={handleClearSearch}
                                            aria-label="Clear search"
                                        >
                                            <NavIcon name="x" />
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <button
                                    className="sidebar__extensions-search-toggle"
                                    onClick={handleToggleSearch}
                                    title="Filter extensions"
                                >
                                    <NavIcon name="filter" />
                                    <span>Filter</span>
                                </button>
                            )}
                        </div>
                    )}

                    {/* Extension Categories */}
                    <div className="sidebar__extensions-categories">
                        {extensionCategories.map(category => (
                            <div key={category.id} className="sidebar__extensions-category">
                                {/* Category label (hide for search results or single category) */}
                                {extensionCategories.length > 1 && category.id !== 'search-results' && (
                                    <div className="sidebar__extensions-category-label">
                                        {category.label}
                                    </div>
                                )}

                                {/* Extension Items */}
                                <div className="sidebar__extensions-items">
                                    {category.extensions.map(ext => (
                                        <NavLink
                                            key={ext.id}
                                            to={ext.path}
                                            className={({ isActive }) =>
                                                `sidebar__nav-item sidebar__extension-item ${isActive ? 'sidebar__nav-item--active' : ''}`
                                            }
                                            title={ext.fullName || ext.name}
                                        >
                                            <span className="sidebar__nav-icon">
                                                <NavIcon name={ext.icon} />
                                            </span>
                                            <span className="sidebar__nav-label">{ext.name}</span>
                                            {ext.badge && (
                                                <span className={`sidebar__extension-badge sidebar__extension-badge--${ext.badge}`}>
                                                    {ext.badge === 'new' ? 'NEW' : ext.badge === 'beta' ? 'BETA' : ext.badge}
                                                </span>
                                            )}
                                        </NavLink>
                                    ))}
                                </div>
                            </div>
                        ))}

                        {/* No results message */}
                        {searchQuery && totalExtensions === 0 && (
                            <div className="sidebar__extensions-no-results">
                                No extensions match "{searchQuery}"
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Collapsed mode - show icons only in a compact grid */}
            {!isExpanded && !sidebarCollapsed && (
                <div className="sidebar__extensions-collapsed-list">
                    {extensionCategories.flatMap(cat => cat.extensions).slice(0, 4).map(ext => (
                        <NavLink
                            key={ext.id}
                            to={ext.path}
                            className={({ isActive }) =>
                                `sidebar__extension-collapsed-item ${isActive ? 'sidebar__extension-collapsed-item--active' : ''}`
                            }
                            title={ext.name}
                        >
                            <NavIcon name={ext.icon} />
                        </NavLink>
                    ))}
                    {totalExtensions > 4 && (
                        <span className="sidebar__extensions-more">+{totalExtensions - 4}</span>
                    )}
                </div>
            )}

            {/* Sidebar collapsed mode - vertical list of icons */}
            {sidebarCollapsed && (
                <div className="sidebar__extensions-icons">
                    {extensionCategories.flatMap(cat => cat.extensions).map(ext => (
                        <NavLink
                            key={ext.id}
                            to={ext.path}
                            className={({ isActive }) =>
                                `sidebar__nav-item ${isActive ? 'sidebar__nav-item--active' : ''}`
                            }
                            title={ext.name}
                        >
                            <span className="sidebar__nav-icon">
                                <NavIcon name={ext.icon} />
                            </span>
                        </NavLink>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * SidebarSearch - Quick filter for navigation items
 * Filters nav items as user types, with keyboard shortcut support
 */
function SidebarSearch({ searchQuery, setSearchQuery, collapsed, inputRef }) {
    if (collapsed) return null;

    return (
        <div className="sidebar__search">
            <div className="sidebar__search-inner">
                <NavIcon name="search" />
                <input
                    ref={inputRef}
                    type="text"
                    placeholder="Filter nav... (/ or Ctrl+K)"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="sidebar__search-input"
                />
                {searchQuery && (
                    <button
                        className="sidebar__search-clear"
                        onClick={() => setSearchQuery('')}
                        title="Clear filter"
                        aria-label="Clear filter"
                    >
                        <NavIcon name="x" />
                    </button>
                )}
            </div>
        </div>
    );
}

/**
 * Breadcrumbs - Shows current navigation path
 * Provides context and quick navigation back to parent sections
 */
function Breadcrumbs({ location, actions }) {
    const navigate = useNavigate();
    const { currentOrg } = useWorkspace();

    // Signed-bundle plugins (QuoxSignal, QuoxLens, …) register their nav items at
    // runtime, AFTER this component first renders. Without listening for that we
    // compute the trail against an incomplete getNavSections() and the plugin page
    // falls through to the parent-less fallback (owner: "QuoxSignal is just
    // QuoxSignal, no parent category"). Recompute when plugin nav changes.
    const [navVersion, setNavVersion] = useState(0);
    useEffect(() => {
        const bump = () => setNavVersion(v => v + 1);
        window.addEventListener('quox-plugin-nav-change', bump);
        return () => window.removeEventListener('quox-plugin-nav-change', bump);
    }, []);

    // The dashboard is tabbed (Overview/Operations/…); it publishes its active
    // tab via 'quox-dashboard-tab' so we can append the tab name to the trail
    // (owner ask). detail === null clears it (tab left / view unmounted).
    const [dashTab, setDashTab] = useState(null);
    useEffect(() => {
        const onTab = (e) => setDashTab(e.detail?.label || null);
        window.addEventListener('quox-dashboard-tab', onTab);
        return () => window.removeEventListener('quox-dashboard-tab', onTab);
    }, []);

    // Detail pages publish a human label for their own path (widget name, not ULID).
    const [leaf, setLeaf] = useState(null);
    useEffect(() => {
        const onLeaf = (e) => setLeaf(e.detail || null);
        window.addEventListener(BREADCRUMB_LEAF_EVENT, onLeaf);
        return () => window.removeEventListener(BREADCRUMB_LEAF_EVENT, onLeaf);
    }, []);

    // Routes that are scoped to the current org — show org name in breadcrumb
    const ORG_SCOPED_ROUTES = ['/inbox', '/teams-overview', '/agentic-teams', '/opsdeck'];

    // Build breadcrumb trail from current path
    const breadcrumbs = useMemo(() => {
        const path = location.pathname;
        const crumbs = [{ label: 'Command', path: '/', icon: 'eye' }];

        // Alias routes that share a parent nav item (e.g. /agentic-teams/:id → /teams-overview)
        const ROUTE_ALIASES = {
            '/agentic-teams': { parentPath: '/teams-overview', parentLabel: 'Agentic Teams' },
        };

        // Category landing pages (/category/:sectionId). The generic fallback
        // title-cases URL segments, which rendered the meaningless literal
        // "Category" (owner). Resolve the section and show its label instead.
        if (path.startsWith('/category/')) {
            const sectionId = path.slice('/category/'.length).split('/')[0];
            const section = getNavSections().find(s => s.id === sectionId);
            if (section) {
                crumbs.push({ label: section.label, path });
                return crumbs;
            }
        }

        // Check if current path matches an alias prefix
        for (const [prefix, alias] of Object.entries(ROUTE_ALIASES)) {
            if (path.startsWith(prefix)) {
                // Find the parent nav item to get its section
                for (const section of getNavSections()) {
                    for (const item of section.items) {
                        if (item.path === alias.parentPath) {
                            if (section.id !== 'home') {
                                crumbs.push({ label: section.label, path: null });
                            }
                            crumbs.push({ label: alias.parentLabel, path: alias.parentPath, icon: item.icon });
                            // Add sub-label from remaining path
                            if (path !== prefix) {
                                const subPath = path.slice(prefix.length + 1);
                                const subLabel = subPath.split('/').map(s =>
                                    s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
                                ).join(' > ');
                                crumbs.push({ label: subLabel, path: path });
                            }
                            return crumbs;
                        }
                    }
                }
            }
        }

        // Find current section and item from getNavSections()
        // First try exact match, then prefix match (prevents /teams matching /teams-overview)
        let matchedSection = null;
        let matchedItem = null;
        for (const section of getNavSections()) {
            for (const item of section.items) {
                if (path === item.path) {
                    matchedSection = section;
                    matchedItem = item;
                    break;
                }
            }
            if (matchedItem) break;
        }
        if (!matchedItem) {
            for (const section of getNavSections()) {
                for (const item of section.items) {
                    if (item.path !== '/' && path.startsWith(item.path + '/')) {
                        matchedSection = section;
                        matchedItem = item;
                        break;
                    }
                }
                if (matchedItem) break;
            }
        }
        if (matchedSection && matchedItem) {
            if (matchedSection.id !== 'home') {
                crumbs.push({ label: matchedSection.label, path: null });
            }
            crumbs.push({ label: matchedItem.label, path: matchedItem.path, icon: matchedItem.icon });

            // Show org name on org-scoped pages (inbox, teams, opsdeck)
            if (currentOrg?.name && ORG_SCOPED_ROUTES.some(r => path.startsWith(r))) {
                crumbs.push({ label: currentOrg.name, path: null });
            }

            // Handle sub-paths (e.g., /agents/family-tree)
            if (path !== matchedItem.path && path.startsWith(matchedItem.path + '/')) {
                const subPath = path.slice(matchedItem.path.length + 1);
                const subLabel = subPath.split('/').map(s =>
                    s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
                ).join(' > ');
                crumbs.push({ label: subLabel, path: path });
            }

            // Dashboard is tabbed — append the active tab name to the trail.
            if (path === '/dashboard' && dashTab) {
                crumbs.push({ label: dashTab, path: null });
            }
            return applyBreadcrumbLeaf(crumbs, path, leaf);
        }

        // Fallback for paths not in getNavSections()
        const segments = path.split('/').filter(Boolean);
        segments.forEach((segment, index) => {
            const segmentPath = '/' + segments.slice(0, index + 1).join('/');
            const label = segment.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            crumbs.push({ label, path: segmentPath });
        });

        return crumbs;
    }, [location.pathname, currentOrg?.name, navVersion, dashTab, leaf]);

    // At home, show just the page name
    if (location.pathname === '/') {
        return (
            <nav className="breadcrumbs" aria-label="Breadcrumb">
                <ol className="breadcrumbs__list">
                    <li className="breadcrumbs__item">
                        <span className="breadcrumbs__text breadcrumbs__text--current">Command Center</span>
                    </li>
                </ol>
                {actions && <div className="breadcrumbs__actions">{actions}</div>}
            </nav>
        );
    }

    return (
        <nav className="breadcrumbs" aria-label="Breadcrumb">
            <ol className="breadcrumbs__list">
                {breadcrumbs.map((crumb, index) => {
                    const isLast = index === breadcrumbs.length - 1;
                    const isClickable = crumb.path && !isLast;

                    return (
                        <li key={index} className="breadcrumbs__item">
                            {index > 0 && (
                                <span className="breadcrumbs__separator">
                                    <NavIcon name="chevronRight" />
                                </span>
                            )}
                            {isClickable ? (
                                <button
                                    className={`breadcrumbs__link ${index === 0 ? 'breadcrumbs__link--home' : ''}`}
                                    onClick={() => navigate(crumb.path)}
                                    title={index === 0 ? 'Command Center (home)' : undefined}
                                    aria-label={index === 0 ? 'Command Center (home)' : undefined}
                                >
                                    {index === 0 && crumb.icon ? (
                                        // Top-bar A: home crumb is an icon-only link, not the
                                        // word "Command" leading every page (read as "home").
                                        <span className="breadcrumbs__icon">
                                            <NavIcon name={crumb.icon} />
                                        </span>
                                    ) : (
                                        <span>{crumb.label}</span>
                                    )}
                                </button>
                            ) : (
                                <span className={`breadcrumbs__text ${isLast ? 'breadcrumbs__text--current' : ''}`}>
                                    {crumb.label}
                                </span>
                            )}
                        </li>
                    );
                })}
            </ol>
            {actions && <div className="breadcrumbs__actions">{actions}</div>}
        </nav>
    );
}

const READINESS_SNOOZE_MS = 24 * 60 * 60 * 1000;

function PlatformReadinessBanner({ readiness, onOpenSetup, onOpenSettings, onDismiss }) {
    const degradedFeatures = Array.isArray(readiness?.degradedFeatures) ? readiness.degradedFeatures : [];
    const failingServices = Object.values(readiness?.services || {})
        .filter((svc) => svc?.status === 'fail' || svc?.status === 'warn')
        .map((svc) => svc.label || svc.key || 'Unknown');
    const coreDown = readiness?.coreShellReady === false;

    return (
        <div className="qx-banner qx-banner--warn" role="status" style={{ margin: '0 20px 16px', alignItems: 'flex-start' }}>
            <svg className="qx-banner__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div style={{ minWidth: 0 }}>
                <div className="qx-banner__title">
                    {coreDown ? 'Platform degraded: core services unreachable' : 'Core shell ready, some platform services degraded'}
                </div>
                <div style={{ color: 'var(--m-text-tertiary)', fontSize: 12 }}>
                    {coreDown
                        ? 'Login and navigation work, but a core service is not responding.'
                        : 'Login and basic navigation work, but one or more feature services are still missing or unhealthy.'}
                    {failingServices.length > 0 && (
                        <> Unreachable: <strong style={{ color: 'var(--m-text-primary)' }}>{failingServices.join(' • ')}</strong>.</>
                    )}
                    {degradedFeatures.length > 0 && (
                        <> Affected: <strong style={{ color: 'var(--m-text-primary)' }}>{degradedFeatures.join(' • ')}</strong>.</>
                    )}
                </div>
            </div>
            <div className="qx-banner__actions">
                <button type="button" className="qx-btn qx-btn--sm" onClick={onOpenSetup}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 11l3 3L22 4" />
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                    Review Readiness
                </button>
                <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onOpenSettings}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    Open Settings
                </button>
                <button
                    type="button"
                    className="qx-btn qx-btn--sm qx-btn--ghost"
                    onClick={onDismiss}
                    aria-label="Snooze readiness notice for 24 hours"
                    title="Snooze for 24 hours"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>
        </div>
    );
}

function AppShell() {
    const location = useLocation();
    const navigate = useNavigate();
    const { user, isAuthenticated, loading: authLoading, logout, isDevMode, setupRequired, authFetch } = useAuth();
    const { loading: workspaceLoading, currentOrg, orgs: workspaceOrgs } = useWorkspace();
    const { killSwitchActive } = useSafety();

    // Action Tracker overdue badge
    const { overdueCount: actionOverdueCount } = useActionStats(currentOrg?.id, user?.id);

    // Development preview bypass - allows testing UI without authentication
    // Usage: Add ?preview=1 to URL (e.g., https://localhost:3443/?preview=1)
    // SECURITY: Only enabled in development mode to prevent auth bypass in production
    const isPreview = import.meta.env.DEV && window.location.search.includes('preview=1');

    // Combined dev/preview mode check
    const isDevOrPreview = isDevMode || isPreview;

    // Mock user for preview mode (dev mode user comes from AuthContext)
    const previewUser = isPreview ? {
        display_name: 'Preview User',
        email: 'preview@quox.dev'
    } : null;
    const displayUser = user || previewUser;
    const [halState, setHalState] = useState('idle');
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [sidebarSearchQuery, setSidebarSearchQuery] = useState('');
    const sidebarSearchRef = useRef(null);
    const [feedbackOpen, setFeedbackOpen] = useState(false);
    const [platformReadiness, setPlatformReadiness] = useState(null);
    const [platformReadinessDismissed, setPlatformReadinessDismissed] = useState(false);
    // Setup-wizard step completion, captured from the same /setup/status
    // response that populates platformReadiness — no extra request.
    // Consumed by the V2 settings IA (SettingsSidebarV2 pinned Setup
    // group + SectionRenderer readiness checklist) via the Outlet context.
    const [setupSteps, setSetupSteps] = useState(null);

    // Icon rail sidebar state
    const [activeGroup, setActiveGroup] = useState(null);
    const flyoutRef = useRef(null);

    // Rail expand/collapse — SIDEBAR-RESTORE: labelled expanded rail restored
    // (2026-04-11's 1aed117c dropped this to an icon-only 76px rail with no
    // toggle). Default is EXPANDED so labels are visible without a click.
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        if (typeof window === 'undefined') return false;
        try {
            return window.localStorage.getItem('quox-sidebar-collapsed') === 'true';
        } catch {
            return false;
        }
    });
    useEffect(() => {
        try {
            window.localStorage.setItem('quox-sidebar-collapsed', String(sidebarCollapsed));
        } catch {
            // localStorage unavailable (private browsing, etc.) — non-fatal
        }
    }, [sidebarCollapsed]);

    // SDK-DX P4: right-side agent chat dock, summoned by plugins via
    // pluginApi.chat.openSidebar(agentId, options) — PluginSandbox dispatches
    // 'quox-open-agent-chat' with { agentId, ...options }.
    const [agentDock, setAgentDock] = useState(null);
    const [agentDockCollapsed, setAgentDockCollapsed] = useState(false);
    useEffect(() => {
        const onOpen = (e) => {
            const { agentId, ...options } = e.detail || {};
            if (!agentId) return;
            setAgentDock({ agentId, ...options });
            setAgentDockCollapsed(false);
        };
        const onClose = () => setAgentDock(null);
        window.addEventListener('quox-open-agent-chat', onOpen);
        window.addEventListener('quox-close-agent-chat', onClose);
        return () => {
            window.removeEventListener('quox-open-agent-chat', onOpen);
            window.removeEventListener('quox-close-agent-chat', onClose);
        };
    }, []);

    // Keyboard shortcuts help overlay

    // QuickBar re-render trigger
    const [, setQuickBarTick] = useState(0);
    useEffect(() => {
        const handler = () => setQuickBarTick(t => t + 1);
        window.addEventListener('quox-quickbar-change', handler);
        return () => window.removeEventListener('quox-quickbar-change', handler);
    }, []);

    // Page actions — views push buttons here to render in the breadcrumb bar
    const [pageActions, setPageActions] = useState(null);

    // Legacy collapsed sections state removed — icon rail replaces collapsible sections

    // Page actions are cleaned up by each view's own effect cleanup.
    // Do NOT clear them here — parent effects fire AFTER child effects,
    // which would wipe out the button the child just set.

    // Inbox badge count
    const { badgeCount: inboxBadgeCount, hasUrgent: inboxHasUrgent, refetch: refetchInboxStats } = useInboxStats();

    // Backup health for sidebar badge
    const { status: backupHealthStatus } = useBackupStatus();

    // Update status for sidebar badge
    const { status: updateStatusData } = useUpdateStatus();

    // Inbox notification toast
    const [inboxToast, setInboxToast] = useState(null);
    const inboxToastTimerRef = useRef(null);

    const showInboxToast = useCallback((item) => {
        if (inboxToastTimerRef.current) clearTimeout(inboxToastTimerRef.current);
        setInboxToast({ title: item.title || 'New inbox item', kind: item.kind || 'info' });
        const demoMode = typeof window !== 'undefined' &&
            (new URLSearchParams(window.location.search).get('demo') === '1' ||
             window.__QUOX_DEMO_MODE__ === true);
        const dismissMs = demoMode ? 20000 : 5000;
        inboxToastTimerRef.current = setTimeout(() => setInboxToast(null), dismissMs);
        refetchInboxStats();
    }, [refetchInboxStats]);

    // QUOXSOUND-P1: earcons for new inbox items (hitl for approvals, notify
    // for the rest), gated by the user's Sound Profile. One tracker per shell
    // so a replayed SSE item never chimes twice.
    const authFetchRef = useRef(authFetch);
    authFetchRef.current = authFetch;
    const navigateRef = useRef(navigate);
    navigateRef.current = navigate;
    const inboxSoundRef = useRef(null);
    if (inboxSoundRef.current === null) inboxSoundRef.current = createInboxSoundTracker({
        onNewItem: (item) => notifyInboxItem(item, { authFetch: authFetchRef.current, navigate: (p) => navigateRef.current(p) }),
    });
    useEffect(() => { initQuoxSound(); }, []);

    const onInboxItemCreated = useCallback((item) => {
        inboxSoundRef.current.handle(item);
        showInboxToast(item);
    }, [showInboxToast]);

    // SSE streams for real-time inbox notifications, across EVERY org the user
    // belongs to (INBOX-LIVE 2026-10-07: listening to currentOrg only meant an
    // approval in any other org never toasted, chimed or notified). Streams are
    // shared per org with the inbox page hooks, so this adds no extra connections there.
    const allInboxOrgIds = useMemo(() => {
        const ids = (workspaceOrgs || []).map(o => o.id).filter(Boolean);
        if (currentOrg?.id && !ids.includes(currentOrg.id)) ids.unshift(currentOrg.id);
        return ids;
    }, [workspaceOrgs, currentOrg?.id]);
    useInboxNotifyStreams(allInboxOrgIds, {
        onItemCreated: onInboxItemCreated
    });

    // Sync QuoxFlow executions into AEE store for Activity page
    useExecutionSync();

    // Initialize datapoints watcher once (deferred from module scope)
    useEffect(() => {
        if (typeof window !== 'undefined') {
            initDatapointsWatcher();
        }
        return () => cleanupDatapointsWatcher();
    }, []);

    // Re-render sidebar when third-party plugins register/unregister nav items.
    // navVersion MUST be read into navSectionsWithBadges' deps below — otherwise
    // this re-render returns the stale memo and getNavSections() is never
    // re-invoked, so plugin-registered sections (Official/Community) don't appear
    // until an unrelated dep changes or a reload wins the boot race.
    const [navVersion, setNavVersion] = useState(0);
    useEffect(() => {
        // INIT-OPT (2026-09-03): coalesce via rAF, same reason as extVersion
        // above — concurrent plugin activation fires a burst of nav-change
        // events on boot, and we want ONE sidebar rebuild when the burst
        // settles, not one per plugin.
        let scheduled = false;
        const handler = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => { scheduled = false; setNavVersion(v => v + 1); });
        };
        window.addEventListener('quox-plugin-nav-change', handler);
        // Boot-race fix: loadInstalledPlugins() (main.jsx) is async and can
        // dispatch 'quox-plugin-nav-change' before this listener attaches, so the
        // Official/Community plugin sections (and their sidebar icons) sometimes
        // never render until an unrelated re-render wins. Re-read once on mount to
        // catch any registration that fired during the pre-mount window.
        handler();
        return () => window.removeEventListener('quox-plugin-nav-change', handler);
    }, []);

    // Inject dynamic badge counts into nav sections
    const navSectionsWithBadges = useMemo(() => {
        return getNavSections().map(section => ({
            ...section,
            items: section.items.map(item => {
                if (item.path === '/inbox') {
                    const updates = {};
                    if (inboxBadgeCount > 0) updates.badge = String(inboxBadgeCount);
                    if (inboxHasUrgent) updates.urgent = true;
                    return Object.keys(updates).length > 0 ? { ...item, ...updates } : item;
                }
                if (item.path === '/backup' && backupHealthStatus) {
                    const bh = backupHealthStatus.health;
                    if (bh === 'critical') return { ...item, badge: 'OVERDUE', urgent: true };
                    if (bh === 'warning') return { ...item, badge: 'WARNING' };
                }
                if (item.path === '/system' && updateStatusData?.update_available) {
                    return { ...item, badge: 'UPDATE' };
                }
                if (item.path === '/actions') {
                    if (actionOverdueCount > 0) return { ...item, badge: String(actionOverdueCount) };
                    return { ...item, badge: undefined };
                }
                if (item.path === '/volt') {
                    const voltSettings = JSON.parse(localStorage.getItem('quox-settings') || '{}');
                    if (!voltSettings.voltEnabled) return { ...item, badge: 'OFF' };
                }
                return item;
            })
        }));
    }, [navVersion, inboxBadgeCount, inboxHasUrgent, backupHealthStatus, updateStatusData, actionOverdueCount]);

    // Filter navigation by user role and plugin activation — hide items the user can't access
    const userRole = currentOrg?.membership?.role || null;
    // AUD-WS-2: auditor sees only governance routes. Everything else is hidden
    // from the sidebar entirely so the UI mirrors the limited capability set.
    const isAuditor = userRole === 'auditor';
    const AUDITOR_ALLOWED_PATHS = new Set([
        '/compliance', '/volt', '/ward', '/certification',
        '/evidence', '/policies',
        // Audit log path has dynamic orgId — special-cased below
    ]);
    const roleFilteredSections = useMemo(() => {
        return navSectionsWithBadges
            .filter(section => !section.minRole || (userRole && hasRoleLevel(userRole, section.minRole)))
            .map(section => ({
                ...section,
                items: section.items.filter(item => {
                    // AUD-WS-2: auditor-only filter — path must be in allow-list
                    // or match the audit-log pattern.
                    if (isAuditor) {
                        const itemPath = item.path || '';
                        const isAuditLog = itemPath.includes('/audit');
                        const isAllowed = AUDITOR_ALLOWED_PATHS.has(itemPath) || isAuditLog;
                        if (!isAllowed) return false;
                    }
                    // Role gating (skipped for auditor on items they're allowed)
                    if (!isAuditor && item.minRole && !(userRole && hasRoleLevel(userRole, item.minRole))) return false;
                    // Plugin activation gating — hide sidebar items for unlicensed paid plugins.
                    // Third-party/community plugins are EXEMPT: they carry a pluginId (tagged by
                    // registerPluginNavItems) but are NOT in the first-party entitlement set, so
                    // isPluginLicensed() always returns false for them and would wrongly strip
                    // every community item — emptying the Community Plugins section and hiding its
                    // rail icon. They only register a nav item when installed AND active, and have
                    // their own licence path (isThirdPartyPluginLicensed), so this gate must skip them.
                    //
                    // F11 (QuoxTrust launch-estate): items flagged `preview: true` stay VISIBLE
                    // for all orgs even when their plugin is unlicensed. Clicking one routes to the
                    // view, which renders the locked PluginLicenseNotice (usePluginLicenseDiagnosis)
                    // instead of the working surface — a governed "locked preview" that both invites
                    // the upsell and closes the by-URL gap (the routes existed for unlicensed orgs).
                    if (item.pluginId && !item._thirdParty && !item.preview && !isPluginLicensed(item.pluginId)) return false;
                    return true;
                })
            }))
            .filter(section => section.items.length > 0);
    }, [navSectionsWithBadges, userRole, isAuditor]);

    // Filter navigation sections based on search query
    const filteredNavSections = useMemo(() => {
        if (!sidebarSearchQuery.trim()) return roleFilteredSections;

        const query = sidebarSearchQuery.toLowerCase();
        return roleFilteredSections.map(section => ({
            ...section,
            items: section.items.filter(item =>
                item.label.toLowerCase().includes(query) ||
                item.path.toLowerCase().includes(query)
            )
        })).filter(section => section.items.length > 0);
    }, [sidebarSearchQuery, roleFilteredSections]);

    // Close flyout on navigation
    useEffect(() => {
        setActiveGroup(null);
        setSidebarSearchQuery('');
    }, [location.pathname]);

    // Close flyout on outside click
    useEffect(() => {
        const handler = (e) => {
            if (flyoutRef.current && !flyoutRef.current.contains(e.target)) {
                setActiveGroup(null);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    useEffect(() => {
        if ((!isAuthenticated && !isDevOrPreview) || location.pathname === '/setup') {
            return;
        }

        let cancelled = false;

        async function fetchPlatformReadiness() {
            try {
                const response = await fetch(buildAuthApiUrl('/setup/status'), { credentials: 'include' });
                if (!response.ok) return;
                const data = await response.json();
                if (!cancelled) {
                    setPlatformReadiness(data?.readiness || null);
                    setSetupSteps(data?.steps || null);
                }
            } catch {
                if (!cancelled) {
                    setPlatformReadiness(null);
                    setSetupSteps(null);
                }
            }
        }

        fetchPlatformReadiness();
        return () => { cancelled = true; };
    }, [isAuthenticated, isDevOrPreview, location.pathname]);

    useEffect(() => {
        if (!import.meta.env.DEV) return;

        warmCriticalShellRoutes().catch(() => {});
    }, []);

    useEffect(() => {
        if (!routeDebugEnabled()) return;

        console.debug('[RouteDebug] AppShell location', {
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
        });
    }, [location.pathname, location.search, location.hash]);

    const readinessState = platformReadiness?.platformState || '';

    useEffect(() => {
        if (!readinessState || readinessState === 'full') {
            setPlatformReadinessDismissed(false);
            return;
        }
        const raw = localStorage.getItem(`quox-platform-readiness-snooze:${readinessState}`);
        const snoozedUntil = raw ? Number(raw) : 0;
        setPlatformReadinessDismissed(Number.isFinite(snoozedUntil) && snoozedUntil > Date.now());
    }, [readinessState]);

    // Close mobile menu on navigation
    useEffect(() => {
        setMobileMenuOpen(false);
    }, [location.pathname]);

    // Escape closes open flyouts / clears sidebar search.
    // Custom shortcut bindings (?, 1-0, /) were removed — they broke as features shifted.
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key !== 'Escape') return;
            const tag = document.activeElement?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;

            if (activeGroup) {
                setActiveGroup(null);
                setSidebarSearchQuery('');
                e.preventDefault();
            } else if (sidebarSearchQuery) {
                setSidebarSearchQuery('');
                e.preventDefault();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [activeGroup, sidebarSearchQuery]);

    // Handle logout with explicit navigation to ensure redirect
    // IMPORTANT: This must be defined before any conditional returns (Rules of Hooks)
    const handleLogout = useCallback(async () => {
        await logout();
        // Explicit navigation to login - ensures redirect even if state update is slow
        navigate('/login', { replace: true });
    }, [logout, navigate]);

    const toggleMobileMenu = useCallback(() => setMobileMenuOpen(prev => !prev), []);

    const handleShellNavigation = useCallback(async (event, path) => {
        if (!path) return;
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;

        event.preventDefault();

        try {
            await preloadShellRoute(path);
        } catch {
            // If preload fails, still attempt navigation and let the route render path handle it.
        }

        navigate(path);
    }, [navigate]);

    // Route render key memory (used below; declared before the early return, hooks rule).
    const routeKeyRef = useRef(null);

    // Loading state
    if (authLoading || workspaceLoading) {
        return (
            <div className="app-shell app-shell--loading">
                <div className="app-shell__loader">
                    <div className="loader-brand">
                        <QHorn size={72} animated />
                    </div>
                    <span>Initializing QuoxCORE...</span>
                </div>
            </div>
        );
    }

    // Redirect to setup wizard if initial setup is required
    if (setupRequired) {
        return <Navigate to="/setup" replace />;
    }

    // Redirect to login if not authenticated (bypassed in dev/preview mode)
    if (!isAuthenticated && !isDevOrPreview) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    const showPlatformReadinessBanner = Boolean(
        platformReadiness
        && platformReadiness.fullPlatformReady === false
        && location.pathname !== '/setup'
        && !platformReadinessDismissed
    );

    const dismissPlatformReadiness = () => {
        if (!readinessState) return;
        localStorage.setItem(`quox-platform-readiness-snooze:${readinessState}`, String(Date.now() + READINESS_SNOOZE_MS));
        setPlatformReadinessDismissed(true);
    };

    // A view's own in-place URL sync (NotesQ/Qortex ?note=) must not remount it; links still do.
    routeKeyRef.current = nextRouteRenderKey(routeKeyRef.current, location);
    const routeRenderKey = routeKeyRef.current.key;

    // BRAIN2-V2 Phase 2a's "immersive" variant (hide the global rail on
    // /brain2) is RETIRED per quox#589: the owner ruled the app nav and
    // Qortex's own Library rail must BOTH be visible, like every other view.
    return (
        <div className="app-shell app-shell--rail">
            {/* Skip link for keyboard/screen reader users */}
            <a href="#main-content" className="skip-link">
                Skip to main content
            </a>

            {/* Full-width Header — glass panel */}
            <header className="app-shell__header glass-panel">
                <button
                    className="app-shell__mobile-toggle"
                    onClick={toggleMobileMenu}
                    aria-label="Toggle menu"
                >
                    <NavIcon name="menu" />
                </button>

                {/* Left: QUOX wordmark + scope selector */}
                <div className="app-shell__header-left">
                    <Link to="/" className="header-quox-logo" title="Command Center" aria-label="Command Center">
                        <img src="/logo-quox.png?v=3" alt="Quox" className="header-quox-logo__img" />
                    </Link>
                    <HeaderScopeSelector />
                </div>

                {/* Centre: breadcrumb trail + page title, pinned so the org
                    switcher expanding/collapsing never reflows it */}
                <div className="app-shell__header-center">
                    <Breadcrumbs location={location} actions={pageActions} />
                </div>

                {/* Center: global search (Top-bar #4) + inbox badge + QuickBar */}
                <div className="app-shell__header-mid" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <GlobalSearch />
                    <HeaderInboxBadge />
                    <QuickBar NavIcon={NavIcon} />
                </div>

                {/* Right: utility actions (E-STOP + DEFCON moved to the footer ops strip — Top-bar #7) */}
                <div className="app-shell__header-utils">
                    <button
                        className="header-icon-btn"
                        onClick={() => navigate('/settings')}
                        title="Settings"
                        aria-label="Settings"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <circle cx="12" cy="12" r="3"/>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                        </svg>
                    </button>
                    <Link
                        to="/docs"
                        className="header-icon-btn"
                        title="Documentation"
                        aria-label="Documentation"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                            <line x1="8" y1="6" x2="16" y2="6"/>
                            <line x1="8" y1="10" x2="14" y2="10"/>
                        </svg>
                    </Link>
                    <HeaderUserMenu
                        user={displayUser}
                        orgName={currentOrg?.name}
                        isDevMode={isDevMode}
                        isPreview={isPreview}
                        onLogout={handleLogout}
                    />
                </div>
            </header>

            {/* Body: Icon Rail + Main Content */}
            <div className="app-shell__body">
                {/* Mobile Menu Overlay */}
                <div
                    className={`app-shell__overlay ${mobileMenuOpen ? 'app-shell__overlay--visible' : ''}`}
                    onClick={() => setMobileMenuOpen(false)}
                    aria-hidden={!mobileMenuOpen}
                />

                {/* Icon Rail Sidebar — glass panel */}
                <aside
                    className={`app-shell__rail glass-panel ${mobileMenuOpen ? 'app-shell__rail--open' : ''} ${sidebarCollapsed ? '' : 'app-shell__rail--expanded'}`}
                    ref={flyoutRef}
                >
                    <nav className="rail__icons" role="navigation" aria-label="Main navigation">
                        <button
                            type="button"
                            className="rail__collapse-toggle"
                            onClick={() => setSidebarCollapsed(v => !v)}
                            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                            aria-expanded={!sidebarCollapsed}
                        >
                            <NavIcon name={sidebarCollapsed ? 'chevronRight' : 'chevronLeft'} />
                        </button>

                        {filteredNavSections.map(section => {
                            const sectionIcon = SECTION_ICON_MAP[section.id] || 'grid';
                            const isOpen = activeGroup === section.id;
                            const hasActiveChild = section.items.some(item =>
                                location.pathname === item.path ||
                                (item.path !== '/' && location.pathname.startsWith(item.path + '/'))
                            );
                            return (
                                <button
                                    key={section.id}
                                    type="button"
                                    className={`rail__group ${isOpen ? 'rail__group--open' : ''} ${hasActiveChild ? 'rail__group--active-child' : ''}`}
                                    onClick={() => setActiveGroup(activeGroup === section.id ? null : section.id)}
                                    title={section.label}
                                    aria-label={section.label}
                                >
                                    <div className={`rail__icon-btn ${isOpen ? 'rail__icon-btn--open' : ''}`}>
                                        <span className="rail__icon">
                                            <NavIcon name={sectionIcon} />
                                        </span>
                                    </div>
                                    <span className="rail__icon-label">{section.label}</span>
                                </button>
                            );
                        })}

                        {/* Dev/Preview badge at bottom */}
                        {isDevOrPreview && (
                            <div className="rail__dev-badge">
                                {isDevMode ? 'DEV' : 'PRV'}
                            </div>
                        )}
                    </nav>

                    {/* Flyout Panel */}
                    {activeGroup && (() => {
                        const section = filteredNavSections.find(s => s.id === activeGroup);
                        if (!section) return null;
                        return (
                            <div className="rail__flyout">
                                <div className="flyout__header">
                                    <span className="flyout__header-icon">
                                        <NavIcon name={SECTION_ICON_MAP[section.id] || 'grid'} />
                                    </span>
                                    {section.label}
                                </div>

                                {/* Search within flyout */}
                                <div className="flyout__search">
                                    <input
                                        ref={sidebarSearchRef}
                                        type="text"
                                        placeholder="Filter..."
                                        value={sidebarSearchQuery}
                                        onChange={(e) => setSidebarSearchQuery(e.target.value)}
                                        className="flyout__search-input"
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                </div>

                                <div className="flyout__items">
                                    {section.items
                                        .filter(item => !sidebarSearchQuery || item.label.toLowerCase().includes(sidebarSearchQuery.toLowerCase()))
                                        .map(item => {
                                            const isActive = location.pathname === item.path ||
                                                (item.path !== '/' && location.pathname.startsWith(item.path + '/'));
                                            return (
                                                <NavLink
                                                    key={item.path}
                                                    to={item.path}
                                                    end={item.exact}
                                                    onClick={(e) => {
                                                        void handleShellNavigation(e, item.path);
                                                        setActiveGroup(null);
                                                        setSidebarSearchQuery('');
                                                    }}
                                                    onMouseEnter={() => preloadShellRoute(item.path)}
                                                    className={`flyout__item ${isActive ? 'flyout__item--active' : ''}`}
                                                >
                                                    <span className="flyout__item-icon">
                                                        <NavIcon name={item.icon} />
                                                    </span>
                                                    <span className="flyout__item-label">{item.label}</span>
                                                    {item.badge && (
                                                        <span className={`flyout__item-badge flyout__item-badge--${item.badge.toLowerCase()}`}>
                                                            {item.badge}
                                                        </span>
                                                    )}
                                                    {item.urgent && (
                                                        <span className="flyout__item-urgent" />
                                                    )}
                                                    <button
                                                        className={`flyout__item-pin ${isQuickBarPinned(item.path) ? 'flyout__item-pin--active' : ''}`}
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            toggleQuickBarItem(item);
                                                        }}
                                                        title={isQuickBarPinned(item.path) ? 'Unpin from Quick Access' : 'Pin to Quick Access'}
                                                    >
                                                        {isQuickBarPinned(item.path) ? '★' : '☆'}
                                                    </button>
                                                </NavLink>
                                            );
                                        })}
                                </div>
                                <NavLink
                                    to={`/category/${section.id}`}
                                    className="flyout__view-all"
                                    onClick={() => { setActiveGroup(null); setSidebarSearchQuery(''); }}
                                >
                                    View All {section.label}
                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polyline points="9 18 15 12 9 6" />
                                    </svg>
                                </NavLink>
                            </div>
                        );
                    })()}
                </aside>

                {/* Main Content Area */}
                <div className="app-shell__main">
                    {/* Feedback modal (triggered from header button) */}
                    <FeedbackModal isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} hideFab />

                    {/* Emergency Stop Overlay - blocks all interaction when active */}
                    {killSwitchActive && (
                        <div className="app-shell__kill-switch-overlay">
                            <div className="kill-switch-message">
                                <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                                </svg>
                                <h2>ALL OPERATIONS HALTED</h2>
                                <p>Emergency stop is active. Use Ctrl+Shift+K or click HALTED to enter your deactivation code.</p>
                            </div>
                        </div>
                    )}

                    {showPlatformReadinessBanner && (
                        <PlatformReadinessBanner
                            readiness={platformReadiness}
                            onOpenSetup={() => navigate('/setup?force=true')}
                            onOpenSettings={() => navigate('/settings')}
                            onDismiss={dismissPlatformReadiness}
                        />
                    )}

                    {/* Content */}
                    <main id="main-content" className="app-shell__content" tabIndex="-1" key={routeRenderKey}>
                        {/* AUD-WS-2: auditor mode banner — renders only when role=auditor */}
                        <AuditorBanner />
                        {/* TRUST-GATE-1.14c: advisory inactivity warning — renders only inside the idle countdown's warning window */}
                        <IdleSessionWarning />
                        <Outlet
                            context={{ halState, setHalState, setPageActions, NavIcon, platformReadiness, setupSteps }}
                        />
                    </main>
                </div>

                {/* SDK-DX P4: plugin-summoned agent chat dock */}
                {agentDock && (
                    <aside className="app-shell__agent-dock" aria-label="Agent chat">
                        <Suspense fallback={null}>
                            <AgentChatPanel
                                agentId={agentDock.agentId}
                                agentName={agentDock.agentName}
                                agentColor={agentDock.agentColor}
                                additionalContext={agentDock.additionalContext}
                                width={agentDock.width || 360}
                                collapsed={agentDockCollapsed}
                                onToggle={() => setAgentDockCollapsed((c) => !c)}
                                headerContent={
                                    <div className="agent-dock__header">
                                        <button
                                            type="button"
                                            onClick={() => setAgentDockCollapsed(true)}
                                            title="Collapse agent chat"
                                            aria-label="Collapse agent chat"
                                        >
                                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="9 18 15 12 9 6" />
                                            </svg>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setAgentDock(null)}
                                            title="Close agent chat"
                                            aria-label="Close agent chat"
                                        >
                                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                            </svg>
                                        </button>
                                    </div>
                                }
                            />
                        </Suspense>
                    </aside>
                )}
            </div>

            {/* Footer — glass panel with live status */}
            <footer className="app-shell__footer glass-panel">
                <div className="footer__left">
                    <button
                        className="footer__feedback-btn"
                        onClick={() => setFeedbackOpen(true)}
                        title="Send Feedback"
                        aria-label="Send Feedback"
                    >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        Feedback
                    </button>
                    {/* Top-bar #7: dead shortcut legend removed (the ?, /, 1-9 bindings
                        were already gone — see the Escape-only handler comment above).
                        E-STOP + DEFCON relocated here from the header. */}
                    <div className="footer__ops">
                        <KillSwitch />
                        <DefconIndicator />
                    </div>
                </div>
                <div className="footer__right">
                    <AEEStatusBadge />
                    <span className="header-divider" />
                    <AOCLStatusBadge />
                    <span className="header-divider" />
                    <VoltStatusBadge />
                    <span className="header-divider" />
                    <WARDStatusBadge />
                    <span className="header-divider" />
                    <SystemHealthBadge />
                    <span className="header-divider" />
                    <BackupHeaderBadge />
                    <span className="header-divider" />
                    <AIRunningIndicator />
                </div>
            </footer>

            {/* Execution notification toast container */}
            <div id="quox-toast-container" style={{ position: 'fixed', top: 60, right: 16, zIndex: 9000, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
              <div style={{ pointerEvents: 'auto' }} />
            </div>

            {/* Inbox notification toast */}
            {inboxToast && (
                <div className="inbox-toast" onClick={() => { setInboxToast(null); navigate('/inbox'); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
                        <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" />
                    </svg>
                    <div className="inbox-toast__content">
                        <span className="inbox-toast__label">New inbox item</span>
                        <span className="inbox-toast__title">{inboxToast.title}</span>
                    </div>
                    <span className="inbox-toast__badge">{inboxToast.kind}</span>
                </div>
            )}
        </div>
    );
}

export default AppShell;

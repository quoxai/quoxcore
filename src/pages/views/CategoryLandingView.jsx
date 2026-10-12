/**
 * CategoryLandingView — Glass-styled landing page for a navigation category.
 *
 * Shows all items as glass cards with icons, descriptions, and pin-to-quickbar.
 * Accessible at /category/:sectionId and via "View All" in flyout.
 */

import { useMemo, useState, useEffect } from 'react'
import { useParams, useNavigate, useOutletContext } from 'react-router-dom'
import { getNavSections } from '../../config/navRegistry'
import { isQuickBarPinned, toggleQuickBarItem } from '../../components/layout/QuickBar'
import './category-landing.css'

// Section metadata — icon, description, long intro
const SECTION_META = {
    'home': {
        icon: 'home',
        desc: 'Core command and control interfaces',
        intro: 'Your central hub for commanding the QuoxCORE platform. The Command Center provides a unified voice and text interface to all agents, while the Dashboard gives you a bird\'s-eye view of your entire operation. Manage your inbox, communications, missions, and activity from one place.',
    },
    'work': {
        icon: 'terminal',
        desc: 'Development tools, terminals, and file management',
        intro: 'Hands-on tools for building, deploying, and managing your infrastructure. Access the CLI, web terminals, bastion SSH gateway, fleet agents, file browser, action tracker, and automated browser sessions. Everything you need to get work done without leaving the platform.',
    },
    'monitoring': {
        icon: 'activity',
        desc: 'Infrastructure monitoring and observability',
        intro: 'Full-stack observability across your fleet. The Network Operations Center aggregates all monitoring data, while dedicated integrations for Grafana, Prometheus, Uptime Kuma, Proxmox, Wazuh SIEM, and Docker provide deep visibility into every layer of your infrastructure.',
    },
    'vault': {
        icon: 'key',
        desc: 'Secrets, credentials, and secure storage',
        intro: 'Enterprise secrets management with full audit trails. Browse and manage credentials, API keys, certificates, and sensitive configuration. Every access is logged, every lease is tracked, and every secret is encrypted at rest.',
    },
    'organisation': {
        icon: 'building',
        desc: 'Organisation structure, teams, and access control',
        intro: 'Define your enterprise hierarchy: organisations, divisions, departments, and teams. Control who has access to what with role-based policies. Integrate with GitHub for developer identity and repository management.',
    },
    'ai-studio': {
        icon: 'cpu',
        desc: 'Agents, workflows, prompts, and AI tools',
        intro: 'The creative workshop for your AI workforce. Configure assistants, deploy specialist agents, build agentic teams, design workflows, manage prompt libraries, and explore the workflow marketplace. This is where you teach your AI fleet what to do and how to do it.',
    },
    'social': {
        icon: 'globe',
        desc: 'Social media integrations and automation',
        intro: 'AI-powered social media management. The LinkedIn, Facebook, and YouTube agents can draft posts, analyse engagement, schedule content, and manage your brand presence across platforms, all with full AOCL audit trails.',
    },
    'intelligence': {
        icon: 'search',
        desc: 'Code intelligence and codebase analysis',
        intro: 'Deep codebase understanding powered by RepoBrain. Search code semantically, visualise dependency graphs, and get AI-grounded answers about your codebase structure, 42x cheaper than reading full files.',
    },
    'governance': {
        icon: 'shield',
        desc: 'Compliance, policies, and audit trails',
        intro: 'Enterprise governance with teeth. The Compliance Command Center unifies GDPR, SOC2, HIPAA, and ISO readiness assessment. Define and enforce policies across your agent fleet with real-time posture monitoring.',
    },
    'marketplace': {
        icon: 'grid',
        desc: 'Plugin marketplace and developer tools',
        intro: 'Discover, install, and publish plugins for the QuoxCORE ecosystem. Browse the marketplace for community extensions, manage your seller dashboard, and submit new listings to extend the platform.',
    },
    'platform': {
        icon: 'settings',
        desc: 'System configuration, memory, diagnostics, and administration',
        intro: 'Platform internals and administrative tools. View service topology, inspect the memory system, manage plugins, run diagnostics in the test lab, explore the 3D cognitive core, and configure system settings. Everything needed to keep QuoxCORE running at peak performance.',
    },
}

// Item descriptions — keyed by path
const ITEM_DESCRIPTIONS = {
    '/': 'Unified voice and text command interface with AI agent orchestration',
    '/dashboard': 'System-wide metrics, health overview, and quick access panels',
    '/inbox': 'Approvals, notifications, and human-in-the-loop tasks',
    '/comms': 'Cross-platform communications hub',
    '/mission-control': 'Objectives, agentic teams, schedules, and live operations',
    '/activity': 'Real-time AEE envelope stream and execution history',
    '/schedules': 'Cron jobs, recurring workflows, and scheduled agent tasks',
    '/cli': 'Interactive Quox CLI with command history and auto-complete',
    '/terminal': 'Multi-pane web terminal with AI chat sidebar and vim mode',
    '/bastion': 'SSH bastion gateway: secure access to all fleet hosts',
    '/infra': 'QuoxAgent fleet: deploy, monitor, and manage host agents',
    '/files': 'File browser with AI-powered summarise, compare, and extract',
    '/actions': 'Task tracker with priorities, deadlines, and agent delegation',
    '/browser-q': 'AI-driven browser automation: record, extract, and monitor',
    '/noc': 'Network Operations Center: unified monitoring dashboard',
    '/monitoring/grafana': 'Grafana dashboards embedded with SSO',
    '/monitoring/prometheus': 'Prometheus metrics explorer and PromQL playground',
    '/monitoring/uptime-kuma': 'Uptime monitoring for all services and endpoints',
    '/monitoring/proxmox': 'Proxmox hypervisor management and VM overview',
    '/wazuh': 'Wazuh SIEM: threat detection and security analytics',
    '/docker': 'Docker container fleet: images, health, and resource usage',
    '/vault': 'Vault dashboard: secrets overview and health',
    '/vault/browse': 'Browse all secrets and configuration entries',
    '/vault/credentials': 'API keys, passwords, and service credentials',
    '/vault/folders': 'Organised secret storage with path-based access',
    '/vault/leases': 'Dynamic secret leases and expiry tracking',
    '/vault/activity': 'Audit log of all vault access and modifications',
    '/orgs': 'Create and manage organisations',
    '/divisions': 'Business divisions within organisations',
    '/departments': 'Departments within divisions',
    '/teams': 'Team management and member assignment',
    '/github': 'GitHub integration: repos, issues, and developer identity',
    '/assistants': 'AI assistant personas: customise voice, style, and behaviour',
    '/agents': 'Specialist agents: configure tools, capabilities, and autonomy',
    '/teams-overview': 'Agentic teams: multi-agent collaboration groups',
    '/agents/stream': 'Live agent activity and decision stream',
    '/agents/family-tree': 'Agent hierarchy and delegation tree visualisation',
    '/tools': 'Tool registry: all available agent capabilities',
    '/prompts-library': 'Reusable prompt templates and chains',
    '/workflows': 'Your saved workflows and execution history',
    '/workflow-builder': 'Visual workflow designer with node-based editor',
    '/workflow-library': '1,340+ workflow templates ready to deploy',
    '/image-gallery': 'AI-generated images and visual asset library',
    '/linkedin': 'LinkedIn agent: draft posts, analyse engagement, manage presence',
    '/facebook': 'Facebook agent: Page posts (human-approved), insights, Lead Ads retrieval',
    '/instagram': 'Instagram agent: media publishing (human-approved), insights, comment replies',
    '/tiktok': 'TikTok agent: video publishing and draft uploads (human-approved), profile and video stats',
    '/youtube': 'YouTube agent: channel management, content planning, analytics',
    '/nucleus': 'Semantic code search across all repositories',
    '/nucleus/graph': 'Interactive codebase dependency graph visualisation',
    '/compliance': 'Compliance Command Center: GDPR, SOC2, HIPAA, ISO readiness',
    '/policies': 'Policy editor: define and enforce agent behaviour rules',
    '/marketplace/browse': 'Discover and install community plugins',
    '/seller': 'Plugin seller dashboard: revenue, downloads, ratings',
    '/seller/submit': 'Submit a new plugin to the marketplace',
    '/topology': 'Service topology map: containers, ports, and dependencies',
    '/memory': 'Memory system: facts, preferences, entities, and vector search',
    '/plugins': 'Plugin manager: enable, disable, and configure extensions',
    '/test-lab': 'Sandbox for testing agent tools and API calls',
    '/diagnostics': 'System diagnostics: health checks and troubleshooting',
    '/cogcore3d': '3D cognitive core: immersive spatial agent visualisation',
    '/system': 'System maintenance: backups, updates, and health',
    '/settings': 'Platform settings: auth, voice, theme, and preferences',
    '/feedback': 'Send feedback to the QuoxCORE team',
    '/admin': 'Instance administration: users, roles, and system config',
}

// Section icon SVG mapping (inline for the big header icon)
const SECTION_ICONS = {
    home: <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
    terminal: <><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></>,
    activity: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></>,
    key: <><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></>,
    building: <><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/></>,
    cpu: <><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></>,
    globe: <><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>,
    search: <><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></>,
    grid: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
}

export default function CategoryLandingView() {
    const { sectionId } = useParams()
    const navigate = useNavigate()
    const { NavIcon } = useOutletContext() || {}
    const [, setTick] = useState(0)

    useEffect(() => {
        const handler = () => setTick(t => t + 1)
        window.addEventListener('quox-quickbar-change', handler)
        return () => window.removeEventListener('quox-quickbar-change', handler)
    }, [])

    const section = useMemo(() => {
        return getNavSections().find(s => s.id === sectionId)
    }, [sectionId])

    if (!section) {
        return (
            <div className="cat-landing">
                <div className="cat-landing__empty">Category not found</div>
            </div>
        )
    }

    const meta = SECTION_META[section.id] || {}
    const iconPaths = SECTION_ICONS[meta.icon] || SECTION_ICONS.grid

    return (
        <div className="cat-landing">
            {/* Header with big icon */}
            <div className="cat-landing__header">
                <div className="cat-landing__header-icon">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5">
                        {iconPaths}
                    </svg>
                </div>
                <div className="cat-landing__header-text">
                    <h1 className="cat-landing__title">{section.label}</h1>
                    <p className="cat-landing__subtitle">{meta.desc}</p>
                    <p className="cat-landing__intro">{meta.intro}</p>
                </div>
            </div>

            {/* Item count */}
            <div className="cat-landing__count">
                {section.items.length} {section.items.length === 1 ? 'item' : 'items'}
            </div>

            {/* Glass card grid */}
            <div className="cat-landing__grid">
                {section.items.map(item => {
                    const pinned = isQuickBarPinned(item.path)
                    const desc = ITEM_DESCRIPTIONS[item.path] || ''
                    return (
                        <div
                            key={item.path}
                            className="cat-card"
                            onClick={() => navigate(item.path)}
                        >
                            <div className="cat-card__top">
                                <div className="cat-card__icon-wrap">
                                    <span className="cat-card__icon">
                                        {NavIcon ? <NavIcon name={item.icon} /> : item.icon}
                                    </span>
                                </div>
                                <button
                                    className={`cat-card__pin ${pinned ? 'cat-card__pin--active' : ''}`}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        toggleQuickBarItem(item)
                                    }}
                                    title={pinned ? 'Unpin from Quick Access' : 'Pin to Quick Access'}
                                >
                                    {pinned ? '★' : '☆'}
                                </button>
                            </div>
                            <div className="cat-card__body">
                                <div className="cat-card__label-row">
                                    <span className="cat-card__label">{item.label}</span>
                                    {item.badge && (
                                        <span className={`cat-card__badge cat-card__badge--${item.badge.toLowerCase()}`}>
                                            {item.badge}
                                        </span>
                                    )}
                                </div>
                                {desc && <p className="cat-card__desc">{desc}</p>}
                            </div>
                            <div className="cat-card__shimmer" />
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

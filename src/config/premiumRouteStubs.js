/**
 * Premium route stubs (LICENSE-LAUNCH LL-7).
 *
 * When a view is stripped out of the free build and rehomed into a signed
 * plugin bundle, its route disappears from buildCoreRoutes. Without a stub, a
 * direct hit on that path from an org that does not hold the entitlement falls
 * through to the 404 catch-all — which reads as "Quox is broken", not "this is
 * a paid surface you have not activated".
 *
 * This table is the answer, and it is METADATA ONLY. It must never import a
 * component, a view, a hook or anything that transitively reaches one: the
 * whole point of the strip is that Rollup cannot walk from the free build into
 * the premium view tree, and one stray import here would undo it. The generic
 * renderer lives in components/plugins/PluginLockedView.jsx and is imported by
 * App.jsx, not from here. eslint.config.js enforces the same boundary.
 *
 * ── Increment 2: the table is FULL, the scaffolding is INERT ──────────────
 *
 * Every category-1 route path (LL-5 strip groups A + B, see
 * docs/LL5_CLASSIFICATION_TABLE_2026-08-28.md) has a row here NOW, so that no
 * future strip increment can ship a path that 404s because someone forgot the
 * stub. But the code for 31 of those 32 plugins is STILL IN THE FREE BUILD and
 * their real routes still win, so mounting their stubs today would replace a
 * working page with an upsell. Two independent filters stop that, and
 * selectPremiumStubRoutes applies both:
 *
 *   1. STATUS — a stub mounts only once src/config/stripRegistry.js says its
 *      plugin is `stripped`. Today that is quoxbox-macmini alone.
 *   2. TAKEN PATH — a stub is dropped if any live route (core or
 *      plugin-registered) already owns its path. This is what makes activation
 *      win with no ordering subtlety: the instant the bundle registers
 *      /quoxbox, the real view claims the path and the stub vanishes.
 *
 * Filter 1 is the one that matters for the pending rows, because filter 2 only
 * sees the routeRegistry table — routes declared directly as JSX in App.jsx
 * (/cogcore3d lives in the standalone block) are invisible to it.
 *
 * ── Where the copy comes from ────────────────────────────────────────────
 *
 * Marketing copy is a reviewed SNAPSHOT of each plugin's catalogue manifest in
 * src/config/plugins/*.json, deliberately duplicated rather than imported. The
 * plan's §"Manifest rehoming" keeps manifests static and exempt from the strip,
 * but pulling forty manifests into the router's critical path for a name and a
 * tagline is a worse trade than a short, reviewed copy. Wording is verbatim
 * from the manifest so the locked view and the store cannot disagree.
 */

// Explicit .js extension: this module is loaded by node scripts
// (scripts/check-strip-registry.mjs) as well as by Vite, and bare node ESM
// does not do extensionless resolution.
import { STRIP_REGISTRY, STRIP_STATUS } from './stripRegistry.js';

/**
 * One entry per plugin, with every path that plugin owns. Flattened to one
 * row per path below, which is the shape App.jsx and the tests consume.
 */
const PREMIUM_PLUGIN_STUBS = [
    {
        pluginId: 'quoxbox-macmini',
        paths: ['/quoxbox'],
        name: 'QuoxBox — Mac mini',
        tagline: 'The only AI that can use your Mac, and pass an audit.',
        blurb:
            'QuoxBox is a governed gateway between Quox and an always-on Mac mini. Every screen '
            + 'read, click and keystroke runs through a policy engine that holds high-risk actions '
            + 'for human approval, verifies each step actually happened, and writes a tamper-evident '
            + 'evidence chain you can hand to an auditor.',
        chips: ['Live Watch', 'Governed Tasks', 'HITL Approvals', 'Evidence Feed'],
        points: [
            {
                title: 'Checked before it runs',
                body: 'A policy engine evaluates every action up front, not after the fact. Nothing reaches the machine unreviewed.',
                icon: 'shield',
            },
            {
                title: 'A human holds the risky step',
                body: 'High-impact actions pause and wait for a decision, with the tool, impact, reasoning and rollback plan shown before you approve.',
                icon: 'check',
            },
            {
                title: 'Evidence, not screenshots',
                body: 'Every allow, deny, mode change and verified effect is chained into a tamper-evident record built for EU AI Act oversight.',
                icon: 'activity',
            },
        ],
        priceDisplay: '$1,499/yr',
        accentColor: '#38bdf8',
        minRole: 'admin',
        auditorAllowed: true,
    },
    {
        pluginId: 'prompts-library',
        paths: ['/prompts-library'],
        name: 'Prompts Library',
        tagline: 'Your own prompt workspace — saved, versioned, deployed.',
        blurb: 'Save, version, and deploy your own prompts.',
        points: [
            {
                title: 'Save & Version',
                body: 'Every edit is auto-versioned. Restore any prior version instantly.',
                icon: 'shield',
            },
            {
                title: 'Search & Filter',
                body: 'Full-text search by name, description, body, or tags. Filter by category or visibility.',
                icon: 'shield',
            },
            {
                title: 'Deploy to Composer',
                body: 'Push any prompt directly into the chat composer or register as a slash command.',
                icon: 'shield',
            },
        ],
        priceDisplay: 'Free',
        accentColor: '#8b5cf6',
    },
    {
        pluginId: 'system-maintenance',
        paths: ['/system'],
        name: 'System Maintenance',
        tagline: 'Backup, Update & Protect Your AI Infrastructure',
        blurb: 'Backup, update, restore, and maintain your entire QuoxCORE installation.',
        points: [
            {
                title: 'Update Detection',
                body: 'Automatic version checks against GitHub Releases. Get notified when new versions are available.',
                icon: 'shield',
            },
            {
                title: 'One-Click Updates',
                body: 'Apply updates with automatic pre-update backup, rolling service restart, and health verification.',
                icon: 'shield',
            },
            {
                title: 'Rollback',
                body: 'Instantly revert to a previous version using the pre-update backup. Never get stuck on a bad release.',
                icon: 'shield',
            },
        ],
        priceDisplay: 'Free',
        accentColor: '#10b981',
        minRole: 'admin',
    },
    {
        pluginId: 'github',
        paths: ['/github'],
        name: 'GitHub Operations',
        tagline: 'Cross-repo operations, AI-powered GitHub agent, and org-scoped governance',
        blurb: 'Cross-repo issues, PRs, VULCAN AI agent, vault credentials, and governed releases.',
        points: [
            {
                title: 'Cross-Repo Issue Board',
                body: 'Unified view of issues across all repositories. Filter by repo, label, status, and assignee. Inline actions and markdown rendering.',
                icon: 'shield',
            },
            {
                title: 'PR View',
                body: 'Open pull requests across all repos with review status, CI results, and merge readiness.',
                icon: 'shield',
            },
            {
                title: 'VULCAN Agent',
                body: 'AI-powered GitHub agent with 13 MCP tools. Natural language queries, issue creation, release notes, CI status checks.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$29',
        accentColor: '#8b5cf6',
        minRole: 'builder',
    },
    {
        pluginId: 'qlarity',
        paths: ['/qlarity/*'],
        name: 'Qlarity',
        tagline: 'Look at the page yourself, with a receipt.',
        blurb: 'Governed headless-browser inspection for dev servers',
        points: [
            {
                title: 'Named inspectors',
                body: 'Parameterised reads that take a selector and a property, never a code string: computed style, ::before/::after rules, text, attributes, element count, bounding box, storage.',
                icon: 'shield',
            },
            {
                title: 'Per-session isolation',
                body: 'Every session gets its own browser context, owned by one org, reaped on idle and on a hard lifetime ceiling.',
                icon: 'shield',
            },
            {
                title: 'Default-deny egress',
                body: 'An operator declares which origins may be inspected. Redirects, iframes and page fetches are all checked, and an allowlisted name resolving to an internal address is still refused.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$29',
        accentColor: '#38bdf8',
    },
    {
        pluginId: 'discord-pro',
        paths: ['/discord-pro'],
        name: 'Quox Discord Pro',
        tagline: 'The community server, run by the product',
        blurb: 'Server management, build and GitHub feeds, AutoMod baseline, and governed grounded support in your Discord server',
        points: [
            {
                title: 'Status',
                body: 'Daemon health, uptime, and connection state for the running Discord Pro process.',
                icon: 'activity',
            },
            {
                title: 'Channel Bindings',
                body: 'Every bound channel with its mode, agent instance, and persona in one table.',
                icon: 'shield',
            },
            {
                title: 'Support Gaps',
                body: 'Questions the grounded corpus could not answer, queued for a human to close.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$49',
        accentColor: '#5865F2',
    },
    {
        pluginId: 'proxmox',
        paths: ['/monitoring/proxmox'],
        name: 'Proxmox VE',
        tagline: 'Virtualization Made Visible',
        blurb: 'VM and container management for Proxmox clusters.',
        points: [
            {
                title: 'Cluster Overview',
                body: 'See all nodes, quorum status, and cluster health at a glance.',
                icon: 'shield',
            },
            {
                title: 'VM Management',
                body: 'List, start, stop, and reboot virtual machines across all nodes.',
                icon: 'shield',
            },
            {
                title: 'Container Management',
                body: 'Manage LXC containers - view status, resource usage, and lifecycle.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$29',
        accentColor: '#e65100',
        minRole: 'builder',
    },
    {
        pluginId: 'uptime-kuma',
        paths: ['/monitoring/uptime-kuma'],
        name: 'Uptime Kuma',
        tagline: 'Know When Things Break',
        blurb: 'Service uptime monitoring and status tracking.',
        points: [
            {
                title: 'Status Dashboard',
                body: 'See all your services and their current status in a clean, organized panel.',
                icon: 'shield',
            },
            {
                title: 'Uptime Tracking',
                body: 'Track 24-hour and 30-day uptime percentages for every monitored service.',
                icon: 'shield',
            },
            {
                title: 'Ping Monitoring',
                body: 'See real-time ping times and latency for all services.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$9',
        accentColor: '#10b981',
        minRole: 'builder',
    },
    {
        pluginId: 'prometheus',
        paths: ['/monitoring/prometheus'],
        name: 'Prometheus Intelligence',
        tagline: 'Fleet Health & Anomaly Detection',
        blurb: 'Fleet heatmap, anomaly detection, capacity forecasting.',
        points: [
            {
                title: 'Metrics Dashboard',
                body: 'See CPU, memory, and disk usage across all monitored hosts at a glance.',
                icon: 'shield',
            },
            {
                title: 'Alert Integration',
                body: 'View all firing and pending alerts with severity classification.',
                icon: 'shield',
            },
            {
                title: 'Target Health',
                body: 'Monitor scrape target status - see which hosts are up or down.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$19',
        accentColor: '#e6522c',
        minRole: 'builder',
    },
    {
        pluginId: 'grafana',
        paths: ['/monitoring/grafana'],
        name: 'Grafana',
        tagline: 'Dashboards at Your Fingertips',
        blurb: 'Dashboard discovery and alert visibility.',
        points: [
            {
                title: 'Dashboard Discovery',
                body: 'Automatically find and list all dashboards in your Grafana instance.',
                icon: 'shield',
            },
            {
                title: 'Alert Rules',
                body: 'View all configured Grafana alert rules and their current states.',
                icon: 'shield',
            },
            {
                title: 'Quick Links',
                body: 'Jump directly to any dashboard from within QUOX.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$9',
        accentColor: '#f46800',
        minRole: 'builder',
    },
    {
        pluginId: 'files',
        paths: ['/files'],
        name: 'Files',
        tagline: "Your AI's Shared Memory",
        blurb: 'File management with memory integration.',
        points: [
            {
                title: 'File Upload',
                body: 'Upload images, PDFs, text files, and JSON documents with drag-and-drop or file picker.',
                icon: 'shield',
            },
            {
                title: 'File Preview',
                body: 'Preview images and read text files directly in the dashboard without downloading.',
                icon: 'shield',
            },
            {
                title: 'Chat Attachments',
                body: 'Attach files to conversations to give QUOX visual and document context.',
                icon: 'shield',
            },
        ],
        priceDisplay: 'Free',
        accentColor: '#60a5fa',
    },
    {
        pluginId: 'core-comms',
        paths: ['/comms'],
        name: 'CoreComms',
        tagline: 'Never Miss a Critical Alert',
        blurb: 'External notification channels for Telegram, Slack, and Email.',
        points: [
            {
                title: 'Telegram Bot Integration',
                body: 'Create your own Telegram bot via @BotFather and receive HITL notifications instantly. Supports private chats and groups.',
                icon: 'shield',
            },
            {
                title: 'Slack Webhook Notifications',
                body: 'Send alerts to any Slack channel via incoming webhooks. Rich formatting with service details and action links.',
                icon: 'shield',
            },
            {
                title: 'Email Notifications',
                body: 'SMTP-based email alerts. Works with Gmail, Outlook, SendGrid, or any email provider.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$5',
        accentColor: '#0088cc',
    },
    {
        pluginId: 'mikrotik-routeros',
        paths: ['/routeros'],
        name: 'RouterOS',
        tagline: 'Intelligent Network Management',
        blurb: 'MikroTik RouterOS management — connects to live routers.',
        points: [
            {
                title: 'Router Discovery',
                body: 'Automatically discover MikroTik routers on your network using neighbor discovery protocols. Build a complete inventory of all devices.',
                icon: 'shield',
            },
            {
                title: 'Health Monitoring',
                body: 'Real-time monitoring of CPU, memory, temperature, and interface status. Get health scores and instant alerts when issues arise.',
                icon: 'shield',
            },
            {
                title: 'DHCP Management',
                body: 'View and manage DHCP leases, create static reservations, detect IP conflicts, and monitor pool utilization with MAC vendor lookup.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$35',
        accentColor: '#e6522c',
        minRole: 'builder',
    },
    {
        pluginId: 'web-terminal',
        paths: ['/terminal'],
        name: 'Web Terminal',
        tagline: 'Your Infrastructure, One Click Away',
        blurb: 'Browser-based terminal with multi-pane workspaces and AI assistant.',
        points: [
            {
                title: 'Web Shell',
                body: 'Full interactive shell in the browser with xterm.js rendering, 256-color support, clickable links, and auto-fit to viewport.',
                icon: 'shield',
            },
            {
                title: 'Multi-Pane Layouts',
                body: 'Split your terminal into 2 or 4 panes with 8 layout presets. Each pane runs an independent session.',
                icon: 'shield',
            },
            {
                title: 'SSH via Bastion',
                body: 'SSH into any registered host through the bastion gateway. Supports password and key-based authentication.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$20',
        accentColor: '#22c55e',
        minRole: 'runner',
    },
    {
        pluginId: 'action-tracker',
        paths: ['/actions'],
        name: 'Action Tracker',
        tagline: 'Get Things Done',
        blurb: 'Kanban board with drag-and-drop, streaks, and AI integration.',
        points: [
            {
                title: 'Kanban Board',
                body: 'Three-column board (TODO, DOING, DONE) to visualize your action items at a glance.',
                icon: 'shield',
            },
            {
                title: 'Drag & Drop',
                body: 'Move cards between columns with smooth drag-and-drop. Status updates automatically.',
                icon: 'shield',
            },
            {
                title: 'Completion Streaks',
                body: 'Track consecutive days of completing items. Build momentum and stay motivated.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$5',
        accentColor: '#f59e0b',
    },
    {
        pluginId: 'wazuh',
        paths: ['/wazuh'],
        name: 'Wazuh SIEM',
        tagline: 'Security monitoring without the headaches',
        blurb: 'SIEM, vulnerability scanning, and fleet-wide agent deployment.',
        points: [
            {
                title: 'Fleet Agent Setup',
                body: 'Deploy Wazuh agents to any host via bastion SSH. No manual installation needed — select hosts, click deploy.',
                icon: 'shield',
            },
            {
                title: 'Alert Feed & Triage',
                body: 'Real-time security alerts with severity levels, MITRE ATT&CK mapping, and AI-powered triage.',
                icon: 'shield',
            },
            {
                title: 'Vulnerability Scanner',
                body: 'CVE detection per host with severity, affected packages, and fix commands.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$25',
        accentColor: '#00a9e5',
        minRole: 'builder',
    },
    {
        pluginId: 'codebase-mirror',
        paths: ['/codebase-mirror'],
        name: 'Codebase Mirror',
        tagline: 'Your AI knows your code.',
        blurb: 'Codebase indexing and drift detection for AI agents',
        points: [
            {
                title: 'Project Scanning',
                body: 'Detect project type, extract registries, routes, services, schemas',
                icon: 'shield',
            },
            {
                title: 'Drift Detection',
                body: 'Compare scans over time, detect added/removed/modified elements',
                icon: 'shield',
            },
            {
                title: 'Query API',
                body: 'Agents query specific elements on demand via /api/v1/codebase/:id/query',
                icon: 'shield',
            },
        ],
        priceDisplay: 'Free',
        accentColor: '#4f46e5',
        minRole: 'builder',
    },
    {
        pluginId: 'opsdeck',
        paths: ['/opsdeck'],
        name: 'OpsDeck',
        tagline: 'Watch your agents work. In real-time.',
        blurb: 'Real-time agent activity constellation',
        points: [
            {
                title: 'Live Constellation',
                body: 'Orbital layout with QUOX orchestrator at center and agents in concentric rings',
                icon: 'activity',
            },
            {
                title: 'Scanning Glow',
                body: 'Conic gradient border that sweeps like radar — speed and color driven by agent state',
                icon: 'shield',
            },
            {
                title: 'System Pulse Bar',
                body: 'Top status strip with objective progress, agent utilization, and elapsed time',
                icon: 'shield',
            },
        ],
        priceDisplay: '$8',
        accentColor: '#6366f1',
        minRole: 'builder',
    },
    {
        pluginId: 'bastion-fleet',
        paths: ['/bastion'],
        name: 'QuoxBastion Fleet Manager',
        tagline: "Your Fleet's Single Source of Truth",
        blurb: 'Host registry and secure remote access.',
        points: [
            {
                title: 'Host Registry',
                body: 'Manage all hosts from one central registry. Add, edit, group, and tag hosts.',
                icon: 'shield',
            },
            {
                title: 'Remote Execution',
                body: 'Execute commands on any host or group with full audit trail.',
                icon: 'shield',
            },
            {
                title: 'SSH Key Management',
                body: 'Manage and deploy SSH keys across your fleet.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$15',
        accentColor: '#0ea5e9',
        minRole: 'builder',
    },
    {
        pluginId: 'docker-fleet',
        paths: ['/docker'],
        name: 'Docker Fleet',
        tagline: 'AI-powered container fleet management',
        blurb: 'Fleet-wide Docker management with AI diagnostics and auto-discovery.',
        points: [
            {
                title: 'Fleet Auto-Discovery',
                body: 'Automatically find all Docker hosts in your fleet via bastion SSH. No manual configuration needed.',
                icon: 'shield',
            },
            {
                title: 'Container Management',
                body: 'Start, stop, restart, inspect, and monitor containers across every host from one dashboard.',
                icon: 'shield',
            },
            {
                title: 'Compose Stack Management',
                body: 'Manage Docker Compose stacks fleet-wide. Deploy, update, and detect drift between running state and compose files.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$25',
        accentColor: '#2496ed',
        minRole: 'builder',
    },
    {
        pluginId: 'quoxchat',
        paths: ['/quoxchat', '/quoxchat/:widgetId'],
        name: 'QuoxChat',
        tagline: 'AI chat widgets for any website',
        blurb: 'Website chat widgets. BYOK, unlimited, fully customisable.',
        points: [
            {
                title: 'Widget Room',
                body: 'Ten-tab management room per widget: Knowledge, Training, Style, Actions, Simulation, Availability, Logs, Analytics, Settings, Compliance.',
                icon: 'shield',
            },
            {
                title: 'Knowledge Pipeline',
                body: 'Upload PDFs, crawl URLs, add Q&A pairs. Tiered RAG with FAQ cache, page context, and semantic search.',
                icon: 'shield',
            },
            {
                title: '5-Level CSS Control',
                body: 'Theme presets, CSS variables, ::part() selectors, or a full stylesheet override. (A headless SDK is planned, not yet published.)',
                icon: 'shield',
            },
        ],
        priceDisplay: '$199/year',
        accentColor: '#30ff90',
    },
    {
        pluginId: 'browser-q',
        paths: ['/browser-q', '/browser-q/run/:objectiveId'],
        name: 'Browser-Q',
        tagline: 'Web Automation',
        blurb: 'AI web automation — navigate, interact, and extract data from any website.',
        points: [
            {
                title: 'Web Navigation',
                body: 'Navigate to any URL with intelligent page load detection and redirect handling.',
                icon: 'shield',
            },
            {
                title: 'Screenshot Capture',
                body: 'Capture full-page or element-specific screenshots with automatic storage.',
                icon: 'shield',
            },
            {
                title: 'Data Extraction',
                body: 'Extract structured data from web pages — tables, lists, links, text, and images.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$10/mo',
        accentColor: '#06b6d4',
    },
    {
        pluginId: 'cogcore3d',
        paths: ['/cogcore3d'],
        name: 'Cognitive Core 3D',
        tagline: 'See inside the brain.',
        blurb: 'Immersive 3D cognitive architecture visualiser',
        points: [
            {
                title: 'Immersive 3D Scene',
                body: 'Fullscreen WebGL environment with fog, bloom, holo-grid floor, and ambient particles',
                icon: 'shield',
            },
            {
                title: 'Elite HUD Frame',
                body: 'Cockpit bezels, corner brackets, pulse bar, and FPS counter inspired by Elite: Dangerous',
                icon: 'shield',
            },
            {
                title: 'Adaptive Quality',
                body: 'Automatic 4-tier quality switching based on GPU and frame rate detection',
                icon: 'shield',
            },
        ],
        priceDisplay: '$18',
        accentColor: '#8b5cf6',
    },
    {
        pluginId: 'tailscale',
        paths: ['/tailscale'],
        name: 'TailMesh',
        tagline: 'See Your Mesh. Talk to Your Network.',
        blurb: 'Tailscale mesh monitoring, management, and alerting',
        points: [
            {
                title: 'Mesh Overview',
                body: 'Live device grid with online/offline status, IPs, OS, routes, key expiry — auto-refreshing every 30 seconds.',
                icon: 'shield',
            },
            {
                title: 'Route Management',
                body: 'View and control subnet routes and exit nodes. Approve, enable, or disable routes with HITL confirmation.',
                icon: 'shield',
            },
            {
                title: 'Key Lifecycle',
                body: 'Auth key inventory with expiry timeline. Create pre-auth keys for device enrollment, revoke compromised keys.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$55',
        accentColor: '#4f46e5',
        minRole: 'viewer',
    },
    {
        pluginId: 'quox-nucleus',
        paths: ['/nucleus'],
        name: 'RepoBrain',
        tagline: 'Your agents know their own code.',
        blurb: 'Codebase-aware AI with cited code answers',
        points: [
            {
                title: 'Code Search',
                body: 'Natural language search across your entire codebase. Returns cited snippets with file:line references.',
                icon: 'shield',
            },
            {
                title: 'Agent Codebase Tool',
                body: 'Agents can query the codebase during conversations. QUOX, DAEDALUS, WARDEN, VULCAN, and COREY get codebase_query.',
                icon: 'shield',
            },
            {
                title: 'RepoBrain Implant',
                body: 'Cognitive implant that tracks indexed files, connections, cache hit rate, and query performance.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$59',
        accentColor: '#06b6d4',
    },
    {
        pluginId: 'quoxplan',
        paths: ['/quoxplan/*'],
        name: 'QuoxPlan',
        tagline: 'The roadmap companion that answers what matters now.',
        blurb: 'Roadmap and stream planning for Quox devs',
        points: [
            {
                title: 'Focus Lens',
                body: 'Default view: blockers, decisions needed, and stale in-flight streams. A handful of cards, never a wall.',
                icon: 'shield',
            },
            {
                title: 'Dependency Timeline',
                body: "Gantt-style view auto-sequenced from dependencies, priority, and effort. See what runs in parallel and what's gating what.",
                icon: 'activity',
            },
            {
                title: 'Governed Edit Mode',
                body: 'One explicit toggle flips a view into editing. Every mutation is logged to an append-only event feed.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$50',
        accentColor: '#a855f7',
    },
    {
        pluginId: 'telegram-pro',
        paths: ['/telegram-pro'],
        name: 'Quox Telegram Pro',
        tagline: 'Multi-Agent Telegram, With Terminal Channels and HITL in Chat',
        blurb: 'Bidirectional Telegram gateway with terminal topic channels and in-chat HITL.',
        points: [
            {
                title: 'Gateway Bot',
                body: 'A single bot you create through BotFather and connect with a token. Quox never asks for BotFather access on your behalf.',
                icon: 'shield',
            },
            {
                title: 'Terminal Topic Channels',
                body: 'Forum topics in your Quox Dev group map to live terminal sessions, so you can watch and steer work from Telegram.',
                icon: 'shield',
            },
            {
                title: 'Replay-Safe Webhooks',
                body: 'Inbound updates are deduplicated and idempotent, so retries and redeliveries from Telegram never double-process.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$29',
        accentColor: '#0088cc',
    },
    {
        pluginId: 'dev-servers',
        paths: ['/dev-suite', '/dev-suite/servers/:hostId', '/quoxperticus/:hostId'],
        name: 'Quox Dev Servers',
        tagline: 'Every dev server, one hub.',
        blurb: 'Registered dev-server inventory with per-host capability visibility.',
        points: [
            {
                title: 'Dev Server Inventory',
                body: 'See every host that has enabled the dev-mode agent profile, sourced from the durable dev_servers registry.',
                icon: 'server',
            },
            {
                title: 'Profile Verification',
                body: 'Each host shows whether its signed dev-mode capability profile has been verified.',
                icon: 'shield',
            },
            {
                title: 'Capability Visibility',
                body: 'Enabled vs. known dev-suite capabilities (dev.register, dev.build, dev.clarify, dev.gripe, dev.docs) per host.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$39',
        accentColor: '#38bdf8',
    },
    {
        pluginId: 'quoxsignal',
        paths: ['/quoxsignal/*'],
        name: 'QuoxSignal',
        tagline: 'Watches your sources, transcribes what matters, drafts the finding.',
        blurb: 'Account-watching, transcription, and evidence-gated proposal triage',
        points: [
            {
                title: 'Feed',
                body: 'Every discovered item across every followed source, with triage score, stage, and thumbnail in one scannable list.',
                icon: 'activity',
            },
            {
                title: 'Sources',
                body: 'Follow accounts and feeds across TikTok, Instagram, YouTube, and RSS/podcasts; see health and last-poll status per source.',
                icon: 'shield',
            },
            {
                title: 'Proposals',
                body: 'Evidence-gated findings queued for human decision: approve, reject, or hand off to a QuoxPlan stream entry.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$39',
        accentColor: '#38bdf8',
    },
    {
        pluginId: 'quoxlens',
        paths: ['/quoxlens'],
        name: 'QuoxLens',
        tagline: 'Judges what you show it, and can prove why.',
        blurb: 'Evidence-gated Lens verdicts on artifacts, with typed findings and replayable evidence',
        points: [
            {
                title: 'Lenses',
                body: 'Every registered Lens: its declared stance, blind spots, eval status, and whether it is proven or unproven against a no-Lens baseline.',
                icon: 'shield',
            },
            {
                title: 'Findings',
                body: 'Typed findings across every scope, tracked through a real lifecycle (new, confirmed, accepted-risk, remediated, regressed) with stable fingerprints that dedupe repeat sweeps.',
                icon: 'shield',
            },
            {
                title: 'Evidence Trail',
                body: "Every applied verdict's AEE envelope and VOLT bundle, traceable back to the cited quote or record a finding was drawn from.",
                icon: 'shield',
            },
        ],
        priceDisplay: '$29',
        accentColor: '#eab308',
    },
    {
        pluginId: 'linkedin',
        paths: ['/linkedin'],
        name: 'LinkedIn',
        tagline: 'Publish and Monitor LinkedIn from QuoxCORE',
        blurb: 'LinkedIn publishing and engagement monitoring.',
        points: [
            {
                title: 'Post Publishing',
                body: 'Publish text posts, image posts, and article links to your LinkedIn profile or company page directly from QuoxCORE.',
                icon: 'shield',
            },
            {
                title: 'Media Upload',
                body: "Upload images and attach them to posts. Two-step flow handles LinkedIn's upload API transparently.",
                icon: 'shield',
            },
            {
                title: 'Engagement Tracking',
                body: 'See reactions, comments, and engagement totals for every post. Per-post sparklines show performance at a glance.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$2',
        accentColor: '#0A66C2',
    },
    {
        pluginId: 'facebook',
        paths: ['/facebook'],
        name: 'Facebook',
        tagline: 'Publish and Monitor Facebook Pages from QuoxCORE',
        blurb: 'Facebook Page publishing, insights, and lead retrieval.',
        points: [
            {
                title: 'Page Publishing',
                body: 'Publish text posts, optional link, and optional image to a Facebook Page feed. Every publish files a human approval card first.',
                icon: 'shield',
            },
            {
                title: 'Page Insights',
                body: 'Read organic Page performance: impressions, post engagements, and fan counts across day, week, or 28-day windows.',
                icon: 'shield',
            },
            {
                title: 'Lead Ads Retrieval',
                body: 'List Lead Ads forms on a Page and retrieve submitted leads with field data.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$2',
        accentColor: '#1877F2',
    },
    {
        pluginId: 'instagram',
        paths: ['/instagram'],
        name: 'Instagram',
        tagline: 'Publish and Monitor Instagram from QuoxCORE',
        blurb: 'Instagram publishing, insights, and comment management on the shared Meta credential.',
        points: [
            {
                title: 'Media Publishing',
                body: 'Publish a single image, video, or reel by public https URL. Every publish files a human approval card first.',
                icon: 'shield',
            },
            {
                title: 'Shared Credential',
                body: 'Reads the same vaulted Meta token as the Facebook plugin; the linked Instagram account is discovered automatically.',
                icon: 'shield',
            },
            {
                title: 'Insights & Comments',
                body: 'Read media and account insights, plus comments, with governed replies.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$2',
        accentColor: '#E4405F',
    },
    {
        pluginId: 'tiktok',
        paths: ['/tiktok'],
        name: 'TikTok',
        tagline: 'Publish and Monitor TikTok from QuoxCORE',
        blurb: 'Governed TikTok video publishing and draft uploads on your own dedicated credential.',
        points: [
            {
                title: 'Governed Publishing',
                body: 'Publish a video from the org media library. Every publish files a human approval card first.',
                icon: 'shield',
            },
            {
                title: 'Draft Uploads',
                body: 'Upload a video to the account\'s TikTok inbox as a draft, finished manually in the TikTok app, the pre-audit workhorse.',
                icon: 'shield',
            },
            {
                title: 'Honest Token Countdown',
                body: 'Access tokens live 24 hours with no auto-refresh yet; the Health tab shows exactly how many hours are left.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$2',
        accentColor: '#FE2C55',
    },
    // X-PLUGIN P3: row is DORMANT until the x stripRegistry entry flips to
    // STRIPPED (selectPremiumStubRoutes only serves stubs for stripped
    // plugins whose path is untaken; today /x is a live core route and XView
    // paywalls itself via usePluginLicensed). Registered now so the strip
    // increment cannot forget it.
    {
        pluginId: 'x',
        paths: ['/x'],
        name: 'X',
        tagline: 'Governed X Publishing from QuoxCORE',
        blurb: 'HITL-gated X publishing with a hard posting budget.',
        points: [
            {
                title: 'HITL-Gated Publishing',
                body: 'Drafts never post directly — every post and thread files an owner approval card, enforced in the collector gate, not just declared.',
                icon: 'shield',
            },
            {
                title: 'Posting Budget',
                body: 'A hard daily and monthly budget per org, checked at draft and again at approval time, backed by a durable ledger.',
                icon: 'shield',
            },
            {
                title: 'Image Media',
                body: 'Attach up to 4 images per post from the org media library; every path is containment-checked server-side.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$2',
        accentColor: '#E7E9EA',
    },
    {
        pluginId: 'youtube',
        paths: ['/youtube'],
        name: 'YouTube',
        tagline: 'Publish and Manage YouTube from QuoxCORE',
        blurb: 'YouTube channel management and video publishing.',
        points: [
            {
                title: 'Video Upload',
                body: 'Upload MP4, MOV, and WebM videos with full metadata control. Resumable uploads handle large files and network interruptions.',
                icon: 'shield',
            },
            {
                title: 'Metadata Management',
                body: 'Edit titles, descriptions, tags, categories, and privacy status. AI-assisted suggestions for SEO-friendly metadata.',
                icon: 'shield',
            },
            {
                title: 'Thumbnail Upload',
                body: 'Set custom thumbnails on videos. Supports JPG and PNG up to 2MB at 1280x720.',
                icon: 'shield',
            },
        ],
        priceDisplay: '$4',
        accentColor: '#FF0000',
    },
];

/**
 * One row per PATH — the shape App.jsx maps over.
 * @type {Array<{path: string, pluginId: string, name: string}>}
 */
export const PREMIUM_ROUTE_STUBS = PREMIUM_PLUGIN_STUBS.flatMap(({ paths, ...copy }) =>
    paths.map((path) => ({ path, ...copy })));

const BY_PATH = new Map(PREMIUM_ROUTE_STUBS.map((stub) => [stub.path, stub]));

/**
 * Look up one stub by its route path.
 * @param {string} path
 * @returns {object|undefined}
 */
export function getPremiumRouteStub(path) {
    return BY_PATH.get(path);
}

/**
 * The stubs that should actually be mounted right now.
 *
 * Both filters, in order:
 *   1. the plugin has been stripped (its code is genuinely out of this build);
 *   2. no real route already owns the path.
 *
 * @param {Set<string>|Iterable<string>} activePaths — paths of the live route table
 * @param {{registry?: Array}} [options] — override the strip registry (tests)
 * @returns {Array<object>}
 */
export function selectPremiumStubRoutes(activePaths, { registry = STRIP_REGISTRY } = {}) {
    const taken = activePaths instanceof Set ? activePaths : new Set(activePaths || []);
    const stripped = new Set(
        registry.filter((row) => row.status === STRIP_STATUS.STRIPPED).map((row) => row.pluginId),
    );
    return PREMIUM_ROUTE_STUBS.filter((stub) => stripped.has(stub.pluginId) && !taken.has(stub.path));
}

export default PREMIUM_ROUTE_STUBS;

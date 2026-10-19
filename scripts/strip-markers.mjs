/**
 * Dist-scan markers for stripped plugins (LICENSE-LAUNCH LL-7 increment 2).
 *
 * ── Why these are NOT in src/config/stripRegistry.js ─────────────────────
 *
 * They were, for about an hour, and the dist scan immediately failed with four
 * leaks in main-*.js. Of course it did: stripRegistry is imported by
 * premiumRouteStubs, which is imported by App.jsx, so every marker string got
 * compiled into the free build — and a marker's whole definition is "a string
 * that appears in the paid code and NOWHERE else in the dashboard". Shipping
 * the marker list to the browser makes the scan permanently red and, worse,
 * would have trained someone into "just delete that marker, it's a false
 * alarm".
 *
 * So the markers live HERE, in a scripts-only module that nothing under src/
 * may import. check-strip-registry.mjs enforces both halves: every stripped
 * plugin has a marker row, and no marker string appears anywhere in src/ except
 * inside that plugin's own coreModules (where it belongs — that IS the paid
 * code, it is simply no longer reachable from the free build).
 *
 * ── Adding a row when a new plugin strips ────────────────────────────────
 *
 *   sentinel: 'QX_P1_<id>' — must ALSO be attached to the object passed to
 *     window.__quoxPluginRegister in plugins-src/<id>/index.jsx as
 *     `__qxSentinel`. A bare const is tree-shaken out of the minified bundle
 *     and the positive control dies with it (plan review note 2).
 *   markers: 2-4 strings from this plugin's code and nowhere else. A
 *     user-facing sentence from the view and the API path only its hook calls
 *     are the reliable kind. Component names, CSS classes and generic
 *     identifiers are NOT — they surface in unrelated chunks and produce false
 *     alarms.
 *
 * Then: npm run check:strip && npm run build && npm run scan:dist
 */

export const STRIP_MARKERS = {
    'files': {
        sentinel: 'QX_P1_files',
        // Runtime microcopy exclusive to the stripped FileManager.jsx — the file
        // grid FilesView actually renders. Deliberately NOT the marketing strings
        // from the static manifest src/config/plugins/files.json (which stays in
        // the free build), NOT the shared-picker strings under
        // components/files/shared/ (which stay reachable from core via the
        // assistant-editor KnowledgeTab), and NOT FolderChat.jsx strings (FolderChat
        // is only re-exported by the barrel, never rendered by FileManager, so it is
        // tree-shaken out of the bundle and would fail the positive control).
        markers: [
            'Enable AI-powered semantic search',
            'Delete ALL files? This cannot be undone.',
            'Deselect All',
        ],
    },
    'quoxchat': {
        sentinel: 'QX_P1_quoxchat',
        // Runtime microcopy exclusive to the stripped QuoxChatWidgetRoom.jsx admin
        // tabs. Deliberately NOT the marketing strings from the static manifest
        // src/config/plugins/quoxchat.json (which stays in the free build), NOT
        // strings from the shared assistant-editor OnboardingWizard / automation
        // EvolutionStagePill (which stay reachable from core), and NOT 'Name must be
        // 50 characters or less' (which also appears in the quoxchatWidgetRoom test
        // and would trip the source-tree guard).
        markers: [
            'Risk tier, retention, DPIA',
            'Operator status, office hours, alerts',
            'Conversation archive',
        ],
    },
    'quoxlens': {
        sentinel: 'QX_P1_quoxlens',
        // Runtime microcopy exclusive to the stripped QuoxLensLocked.jsx upsell view
        // inside the components/quoxlens subtree. Deliberately NOT the marketing
        // strings from the static manifest src/config/plugins/quoxlens.json (which
        // stays in the free build), and NOT strings that also live in the tree's own
        // co-located test files (LensCard.test.jsx, evidenceTrail.test.js,
        // EvidenceTrail.test.jsx), which would trip the source-tree guard.
        markers: [
            'Declare a stance',
            'Enforce the contract',
            'Prove it, or say so',
        ],
    },
    'tailscale': {
        sentinel: 'QX_P1_tailscale',
        // Runtime microcopy exclusive to the stripped tailscale VIEW tree
        // (TailscaleChatSidebar.jsx + MeshOverview.jsx). Deliberately NOT the
        // marketing strings from the static manifest src/config/plugins/tailscale.json
        // (which stays in the free build), NOT the MESHNET agent's suggested prompts
        // ('Is my mesh healthy?', 'Explain the ACL policy') that also live in
        // agentRegistry.js / meshnet.json, and NOT anything from the "Tailscale"
        // INTEGRATION TYPE surfaces (tailscaleClient / integrationTypes / extensions),
        // which stay in core untouched.
        markers: [
            'Create a pre-auth key for tag:server',
            'Focused device and mesh evidence',
            'Copy Tailscale IP',
        ],
    },
    'mikrotik-routeros': {
        sentinel: 'QX_P1_mikrotik-routeros',
        // Runtime microcopy exclusive to the stripped RouterOSView.jsx (the NETWATCH
        // chat placeholder + two quick-prompt buttons). Deliberately NOT the marketing
        // strings from the static manifest src/config/plugins/mikrotik.json (which
        // stays in the free build), NOT the NETWATCH agent's suggested prompts that
        // also live in agentRegistry.js / netwatch.json ('Are there any IP conflicts?',
        // 'What devices are on my network?', 'Check my router's health'), and NOT
        // anything from the "RouterOS" INTEGRATION TYPE (routerosClient / extensions),
        // which stays in core.
        markers: [
            'Ask NETWATCH about your network...',
            'How is my WiFi performing?',
            'Give me a network health summary',
        ],
    },
    'quoxbox-macmini': {
        sentinel: 'QX_P1_quoxbox-macmini',
        markers: [
            'QuoxBox gateway unreachable',
            '/collector/api/quoxbox',
            'propose = every action is held for your approval.',
        ],
    },
    'prompts-library': {
        sentinel: 'QX_P1_prompts-library',
        markers: [
            'Variables must be valid JSON',
            'Name and body are required',
            'Restore this version? The current content will be saved as a new version.',
        ],
    },
    'system-maintenance': {
        sentinel: 'QX_P1_system-maintenance',
        markers: [
            'KEEPER continuity sidebar',
            'Backup and update posture',
            'Focused backup and continuity signals',
        ],
    },
    'github': {
        sentinel: 'QX_P1_github',
        markers: [
            'No open blockers in this milestone',
            'No releases found across your tracked repositories.',
            'All deploy checklist items must be ticked before creating a release.',
        ],
    },
    'qlarity': {
        sentinel: 'QX_P1_qlarity',
        markers: [
            'Open a page, ask it a question, keep the receipt.',
            'The page logged nothing. That is a result, not an empty panel.',
            'Blocked by egress policy',
        ],
    },
    'discord-pro': {
        sentinel: 'QX_P1_discord-pro',
        markers: [
            'Discord server(s) this daemon bridges',
            'Require approval (all)',
            'Bridge remote inbox',
        ],
    },
    'codebase-mirror': {
        sentinel: 'QX_P1_codebase-mirror',
        markers: [
            'Enter a project path above or click "Scan Dashboard" to get started.',
            'Enter project path to scan (e.g., ~/quoxflow)',
            'No Projects Scanned',
        ],
    },
    'docker-fleet': {
        sentinel: 'QX_P1_docker-fleet',
        markers: [
            'DOCKULA docker sidebar',
            'Focused host and container evidence',
            'Run a fleet scan to discover Docker hosts and containers.',
        ],
    },
    'browser-q': {
        sentinel: 'QX_P1_browser-q',
        markers: [
            'No active sessions right now',
            'Start a new session from the sidebar chat, or click a chip below.',
            'Run an automation to capture your first screenshot',
        ],
    },
    'linkedin': {
        sentinel: 'QX_P1_linkedin',
        markers: [
            'Draft a post about our latest blog article',
            'Show engagement trends for recent posts',
            'Upload an image and create a post',
        ],
    },
    'facebook': {
        sentinel: 'QX_P1_facebook',
        // These three are deliberately NOT the SUGGESTIONS chip text (that
        // list is duplicated into src/config/entities/assistants/facebook.json
        // ui.suggestions, which entityRegistry.js — a FREE-build core file —
        // imports; a marker matching a chip string would false-positive
        // there). Picked instead from prose unique to the two coreModules.
        markers: [
            'You are the Facebook specialist for organic Pages',
            '## Facebook Context',
            'Meta long-lived Page tokens live roughly',
        ],
    },
    'instagram': {
        sentinel: 'QX_P1_instagram',
        // Same discipline as facebook above: deliberately NOT the SUGGESTIONS
        // chip text (that list is duplicated into
        // src/config/entities/assistants/instagram.json ui.suggestions, which
        // entityRegistry.js — a FREE-build core file — imports). Picked
        // instead from prose unique to the two coreModules: two lines from
        // InstagramChatSidebar's contextBuilder and one from InstagramView's
        // Health tab, each confirmed to sit within a single source line so
        // JSX's line-join never breaks the literal match.
        markers: [
            '## Instagram Context',
            'You are the Instagram specialist for a professional account reached through its linked Facebook Page',
            'Instagram is its own plugin SKU, but it reads the SAME vaulted Meta',
        ],
    },
    'tiktok': {
        sentinel: 'QX_P1_tiktok',
        // Same discipline as instagram above: deliberately NOT the SUGGESTIONS
        // chip text (that list is duplicated into
        // src/config/entities/assistants/tiktok.json ui.suggestions, which
        // entityRegistry.js — a FREE-build core file — imports). Picked
        // instead from prose unique to the two coreModules: two lines from
        // TikTokChatSidebar's contextBuilder and one from TikTokView's
        // Health tab, each confirmed to sit within a single source line so
        // JSX's line-join never breaks the literal match. Checked against
        // the facebook/instagram marker lists above for collisions: none.
        markers: [
            '## TikTok Context',
            'You are the TikTok specialist. An unaudited TikTok app is restricted to private (SELF_ONLY) viewing until the app audit clears',
            'Audit status and token rotation',
        ],
    },
    'youtube': {
        sentinel: 'QX_P1_youtube',
        markers: [
            'Exchange credentials for access + refresh tokens',
            'Set up once, publish and manage forever',
            'Store all four values securely in the QuoxCORE vault.',
        ],
    },
    'telegram-pro': {
        sentinel: 'QX_P1_telegram-pro',
        // Microcopy from the wizard only — deliberately NOT the marketing lines
        // ("Replay-safe webhooks…" etc), because those are ALSO in the static
        // manifest src/config/plugins/telegram-pro.json, which stays in the free
        // build, so they would surface in the dist scan as a false leak.
        markers: [
            'Bot joined and bound to the group.',
            'Webhook registration failed. You can retry from the roster later.',
            'Send this to @BotFather to start bot creation',
        ],
    },
    'bastion-fleet': {
        sentinel: 'QX_P1_bastion-fleet',
        // Runtime microcopy from the panel + chat sidebar only — deliberately NOT
        // the marketing lines from the static manifest src/config/plugins/
        // bastion-fleet.json, which stays in the free build and would surface as a
        // false leak. These live in BastionPanel.jsx and BastionChatSidebar.jsx.
        markers: [
            'Could not connect to QuoxBastion server',
            'Host added to registry',
            'Rotate my SSH key across the fleet',
        ],
    },
    'wazuh': {
        sentinel: 'QX_P1_wazuh',
        // Runtime microcopy exclusive to the stripped WazuhView tree — a setup-gate
        // validation string and two chat-sidebar suggestion chips. Deliberately NOT
        // the marketing lines from the static manifest src/config/plugins/wazuh.json,
        // which stays in the free build and would surface as a false leak.
        markers: [
            'Wazuh Server IP is required.',
            'Which Wazuh daemons are currently down?',
            'What does a healthy Wazuh manager look like?',
        ],
    },
    'quox-nucleus': {
        sentinel: 'QX_P1_quox-nucleus',
        // Runtime microcopy exclusive to the stripped RepoBrainView.jsx command
        // strip — the tablist aria-label and two health-pill states. Deliberately
        // NOT the marketing lines from the static manifest
        // src/config/plugins/quox-nucleus.json (which stays in the free build), and
        // NOT the "repos indexed" pill text (which also appears in the core
        // nucleusMetrics.js / quoxContext.js services and would be a false leak).
        markers: [
            'RepoBrain tabs',
            'sign-in required',
            'engine offline',
        ],
    },
    'quoxsignal': {
        sentinel: 'QX_P1_quoxsignal',
        // Runtime microcopy exclusive to the stripped QuoxSignalView.jsx command
        // strip — a header hint and a spend-pill title. Deliberately NOT the
        // marketing lines from the static manifest src/config/plugins/quoxsignal.json
        // (which stays in the free build), NOT drawn from the shared quoxplan lib the
        // view reaches into (quoxplan is not stripped, so a marker there would be a
        // false leak), and NOT the tablist aria-label 'QuoxSignal tabs' (which also
        // appears in views/tabCaching.test.jsx and would trip the source-tree guard).
        markers: [
            'Watch sources, transcribe what you pick, score it against your roadmap.',
            'Transcription and analysis both spend.',
        ],
    },
    'quoxplan': {
        sentinel: 'QX_P1_quoxplan',
        // Runtime microcopy exclusive to the stripped QuoxPlanView.jsx — the empty
        // -state line and the two governed-editing tooltips. Deliberately NOT the
        // marketing lines from the static manifest src/config/plugins/quoxplan.json
        // (which stays in the free build), NOT 'Ask ROADY about this roadmap' (which
        // also lives in RoadyRail.jsx, another quoxplan file that is not a
        // coreModule and would trip the source-tree guard), and NOT 'server
        // unreachable' (which also appears in QuoxSignalView / VoltSummaryCard and
        // would be a false leak).
        markers: [
            'The QuoxPlan server has no roadmaps seeded.',
            'Turn on governed editing',
            'Turn governed editing off',
        ],
    },
    'core-comms': {
        sentinel: 'QX_P1_core-comms',
        // Runtime microcopy exclusive to CommsView.jsx (the stripped view).
        // Deliberately NOT the promo/upsell lines, which are ALSO in the core
        // CoreCommsSettings.jsx panel and the static manifest core-comms.json —
        // both stay in the free build and would surface as a false leak.
        markers: [
            'Loading Communications Centre...',
            'Configure via server-side routing.',
            'Bot token and chat ID required',
        ],
    },
    'web-terminal': {
        sentinel: 'QX_P1_web-terminal',
        // Vim-mode + observer/snapshot microcopy and a localStorage key prefix,
        // all exclusive to the stripped TerminalView.jsx workspace. Deliberately
        // NOT the marketing lines from the static manifest src/config/plugins/
        // web-terminal.json, which stays in the free build, and NOT anything from
        // TerminalPromo/SnapshotViewer, which stay in core (/terminal/about and
        // /terminal/share).
        markers: [
            'Enter INSERT mode (type in shell)',
            'Observer link copied to clipboard',
            'quox-terminal-vim-',
        ],
    },
    'action-tracker': {
        sentinel: 'QX_P1_action-tracker',
        // User-facing microcopy exclusive to the stripped ActionsView.jsx Kanban
        // board and its ActionQSidebar. Deliberately NOT anything from
        // useActionExecution/ActionResultsPanel — that is the CORE actions module
        // (src/components/core/actions/) used by NOC/SOC, which stays in the free
        // build and must never carry these markers.
        markers: [
            'No items match your filters',
            'Completed per day (last 7 days)',
            'Ask ACTION-Q anything...',
        ],
    },
    'dev-servers': {
        sentinel: 'QX_P1_dev-servers',
        // User-facing microcopy exclusive to the stripped DevSuiteView.jsx tabbed
        // hub, DevSuiteHostDetailView.jsx capability drill-in, and
        // QuoxperticusResidentView.jsx resident page. Deliberately NOT anything
        // from DevServersHubPanel/DocsPanel — those are the CORE devsuite module
        // (src/components/core/devsuite/) rendered on /infra, which stays in the
        // free build and must never carry these markers.
        markers: [
            'run governed AI coding loops on them',
            'Dev suite tabs',
            'Dev Servers is not licensed for this org',
        ],
    },
    'quoxbuild': {
        sentinel: 'QX_P1_quoxbuild',
        // Runtime microcopy exclusive to the stripped DevBuildPanel.jsx — the
        // dev.build capability panel, which is quoxbuild's ENTIRE UI (no route,
        // no view; see plugins-src/quoxbuild/index.jsx). Deliberately NOT the
        // marketing strings from the static manifest
        // src/config/plugins/quoxbuild.json (which stays in the free build, as
        // does the locked-slot metadata in capabilityPanelRegistry.js), NOT
        // anything from the sibling panels that stay core (DevRegisterPanel/
        // DevSessionsPanel/DevPlanPanel) or from core DevServersHubPanel, and
        // NOT 'No pre-registered targets on this host.' which also lives in
        // cli/lib/commands/build.js and would read as a leak from a file that
        // never ships to the browser at all.
        markers: [
            'No build-targets.yaml registered on this host',
            'queued. Watching the queue',
            'Build queue unavailable',
        ],
    },
    'quoxslots': {
        sentinel: 'QX_P1_quoxslots',
        // Runtime microcopy exclusive to the stripped SlotsDeckPanel.jsx — the
        // dev.slots capability panel, which is quoxslots' ENTIRE UI (routeless
        // by manifest; see plugins-src/quoxslots/index.jsx). Each string was
        // checked to appear in exactly one file under src/, and in no CLI or
        // collector file. Deliberately NOT the marketing strings from the static
        // manifest src/config/plugins/quoxslots.json (which stays in the free
        // build, as does the locked-slot metadata in
        // capabilityPanelRegistry.js), NOT anything from GovernedConfirmDialog
        // (extracted OUT of this panel to be shared with the free
        // DevSessionsPanel, so it is core), and NOT the /collector/api/v1/slots
        // paths, which the collector serves for the CLI whether or not any
        // browser code exists.
        markers: [
            'A slot is a durable, named address.',
            'Session names cannot contain spaces.',
            'Bridge config fetch failed',
        ],
    },
    'local-inference': {
        sentinel: 'QX_P1_local-inference',
        // Runtime microcopy exclusive to the stripped LocalInferenceSettings.jsx
        // — the 'settings.local-inference' premium settings section, which is
        // this plugin's ENTIRE client UI (routeless; see
        // plugins-src/local-inference/index.jsx). Each string was checked to
        // appear in exactly one file under src/, and in no CLI or collector
        // file. Deliberately NOT the marketing strings from the static manifest
        // src/config/plugins/local-inference.json (which stays in the free
        // build, as does the locked-slot metadata in capabilityPanelRegistry.js
        // and the section row in settingsSections.js), NOT the backend names
        // 'Ollama'/'vLLM'/'llama.cpp'/'NVIDIA NIM' (which appear in GpuSetupView
        // and the docs pages, both core), and NOT the /api/v1/local-inference
        // paths, which the collector serves whether or not any browser code
        // exists.
        markers: [
            'No inference sources configured. Add a connection to get started.',
            'e.g. Office GPU, ML Cluster',
            'Easiest setup, best for workstations',
        ],
    },
    cogcore3d: {
        sentinel: 'QX_P1_cogcore3d',
        // User-facing microcopy exclusive to the stripped
        // CognitiveCore3DView.jsx (its error boundary and its in-view upsell
        // list). Deliberately NOT anything from src/components/opsdeck3d/ —
        // that directory stays CORE for ThreeDLabView (/3d-lab) and
        // QuoxbrainView (/brain2, BrainOrgan3D), so a marker taken from a zone,
        // effect or lib module there would fire on the free build. Also
        // deliberately not the premiumRouteStubs.js / plugins/cogcore3d.json
        // marketing copy, which stays in the free build by design.
        //
        // DRIFT FIX (2026-09-25): LICENSING-UX (commit e789700d, "reason-gate
        // rollout to 18 plugin views") replaced the view's bespoke upsell
        // feature-chip list with the shared PluginLicenseNotice component,
        // deleting the two markers that used to live there ('Elite-style
        // cockpit HUD with live telemetry', 'Deep-link to any objective or
        // preset') without updating this registry — check-dist-clean's
        // positive control started failing because the strings no longer
        // exist anywhere, not because the plugin leaked. Replaced with two
        // strings still exclusive to CognitiveCore3DView.jsx today: the
        // shortcuts-overlay hint and the view's own localStorage settings
        // key (same pattern as the 'web-terminal' / 'quoxbox-macmini' rows
        // below, which also use a key/path instead of a sentence).
        markers: [
            'An unexpected error occurred in the 3D renderer',
            'Press any key to close',
            'cogcore3d_settings',
        ],
    },
    // ── The four monitoring plugins (LL-7 extraction 4) ───────────────────
    //
    // These four strip as a SET because they shared one component directory.
    // The shared half of that directory is now src/components/core/monitoring/
    // and stays in the free build: ProxmoxPanel, MetricsPanel, UptimePanel,
    // GrafanaEmbed, GrafanaAlertBadge, useProxmoxData, AgentFleetPanel,
    // GPUFleetPanel, ServiceDetailModal, ToolOutcomesPanel, LiveEventStream,
    // PlaybooksPanel, JobsPanel and the four chat sidebars all render on core
    // NOC / SOC / Infra / Dashboard / NOCPopout for every org. So NOT ONE
    // marker below may come from a core/monitoring file, and each was
    // grep-verified against all of src/ before being listed here. The
    // premiumRouteStubs.js and src/config/plugins/*.json marketing copy is also
    // off limits for the usual reason — it stays in the free build, so several
    // otherwise-obvious candidates ('Status Dashboard', 'Uptime Tracking',
    // 'Ping Monitoring', 'Alert Rules', 'Quick Links') were rejected.
    proxmox: {
        sentinel: 'QX_P1_proxmox',
        // ProxmoxView's connection-check and reconnect states, plus two ProxmoxActions
        // strings. Deliberately NOT the HYPERION persona/suggestion lines from
        // ProxmoxChatSidebar — those are duplicated in core NOCChatSidebar and
        // agentRegistry.js, and would fire on the free build.
        markers: [
            'Checking Proxmox connection...',
            'Connect or reconnect Proxmox',
            'Click a row in the table to see actions',
        ],
    },
    prometheus: {
        sentinel: 'QX_P1_prometheus',
        // PrometheusView's connection-check state, a MetricsChatSidebar
        // suggestion chip, and an AlertTimeline empty state. Deliberately NOT
        // anything from MetricsPanel — that is core now and renders on NOC.
        markers: [
            'Checking Prometheus connection...',
            'Are any scrape targets down?',
            'No alerts in the selected time range',
        ],
    },
    grafana: {
        sentinel: 'QX_P1_grafana',
        // SENTINEL-ONLY positive control (owner call on quoxai/quox#595,
        // 2026-09-25, option b). This plugin's exclusive surface is one thin
        // page whose functional components (GrafanaEmbed, GrafanaAlertBadge)
        // are CORE, not plugin-exclusive. LICENSING-UX (commit e789700d)
        // collapsed GrafanaView.jsx to a license gate + <GrafanaEmbed/>,
        // replacing the bespoke upsell (which carried the three copy markers
        // 'Dashboard Embed' / 'Panel Viewer' / 'view alert rules, and monitor
        // everything from one place.') with the shared PluginLicenseNotice —
        // deliberately, for cross-plugin consistency. So there is no
        // grafana-exclusive COPY left to pin, and re-adding some purely to
        // feed this scan (option a) would be test-driven product copy that
        // fights that standardisation.
        //
        // Instead, the build-injected sentinel QX_P1_grafana IS the positive
        // control: it is a property of the registered plugin exports (verified
        // present in services/auth/first-party-plugins/grafana/plugin.esm.js
        // and absent from the free dist/assets on 2026-09-25), so it survives
        // UI refactors that copy strings do not. sentinelOnly tells
        // check-dist-clean to accept an empty markers[] for this plugin: the
        // negative pass still scans the sentinel (nothing of it may reach the
        // free build) and the positive pass still requires it in the paid
        // bundle. Note the old copy markers were ALSO unusable as leak markers
        // because 'Dashboard Embed'/'Panel Viewer' legitimately live in the
        // CORE GrafanaEmbed and so appear in the free build by design.
        sentinelOnly: true,
        markers: [],
    },
    'uptime-kuma': {
        sentinel: 'QX_P1_uptime-kuma',
        // UptimeKumaView's connection-check state and the first line of its
        // in-view upsell paragraph (chosen to sit entirely within one source
        // line, since JSX collapses a multi-line text node into one string).
        // Deliberately NOT anything from UptimePanel — that is core now.
        markers: [
            'Checking Uptime Kuma connection...',
            'Real-time service uptime monitoring. See which services are up, down, or',
        ],
    },
};

export default STRIP_MARKERS;

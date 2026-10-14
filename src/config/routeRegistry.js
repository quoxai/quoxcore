/**
 * Route Registry
 *
 * Centralises route configuration. Core routes are defined here (migrated from
 * the static <Route> declarations in App.jsx). Third-party plugins can register
 * additional routes at runtime via registerPluginRoute / unregisterPluginRoutes.
 *
 * All third-party routes are namespaced under /plugins/{pluginId}/ to prevent
 * collision with core routes.
 */

import { lazy } from 'react';

// ── Core route definitions ────────────────────────────────────────────────
// These map 1:1 to the static <Route> elements previously in App.jsx.
// The `component` field holds the imported React component reference.
// Routes are grouped by access level for clarity.

/**
 * Build the core route table. Called once from App.jsx with all view imports.
 * We accept components as a map so this module doesn't need 80+ import statements.
 *
 * @param {Object} views - Map of view name → React component
 * @returns {Array<{path: string, element: React.ReactNode, minRole?: string, pluginId?: string}>}
 */
export function buildCoreRoutes(views) {
    return [
        // ── Main routes (no role gate) ──
        { path: '/', element: views.HomeView },
        { path: '/dashboard', element: views.DashboardView },
        { path: '/soc', element: views.SOCView },
        { path: '/lucid', element: views.LucidView },
        { path: '/noc', element: views.NOCView },
        { path: '/agents', element: views.AgentsView },
        { path: '/agents/stream', element: views.AgentStreamPage },
        { path: '/agents/family-tree', element: views.AgentFamilyTreeView },
        { path: '/agents/:agentId', element: views.AgentDetailView },
        // VULCAN-DASH: Vulcan agent surface (stats + history + talk-to-agent).
        // Ungated (no pluginId) so it stays visible; a dev/agent page.
        { path: '/vulcan', element: views.VulcanView },
        // VULCAN #780: Gripe page, files a one-liner as a GitHub issue via the
        // governed POST /github/issues. Free plugin; ungated route.
        { path: '/gripe', element: views.GripeView },
        // QUOXON J3: index of every live session in the org (GET /api/v1/sessions).
        { path: '/sessions', element: views.SessionsView },
        { path: '/activity', element: views.ActivityView },
        // LICENSE-LAUNCH LL-7 increment 3h: the /files row is deliberately GONE.
        // FilesView now ships only in the signed files bundle (plugins-src/files/),
        // which re-registers the root path on activation. Deleting this edge is what
        // stops Rollup reaching the view tree from the free build — enforced by
        // scripts/check-dist-clean.mjs. The /files row was ungated, so no routeGuards
        // in the signed manifest. The shared file pickers (components/files/shared/*)
        // and the file backend are separate surfaces and are not touched here.
        { path: '/archivist', element: views.ArchivistView },
        { path: '/settings', element: views.SettingsView },
        { path: '/feedback', element: views.FeedbackView },

        // ── QuoxVault ──
        { path: '/vault', element: views.VaultDashboardView },
        { path: '/vault/browse', element: views.VaultBrowseView },
        { path: '/vault/credentials', element: views.VaultCredentialsView, minRole: 'builder' },
        { path: '/vault/folders', element: views.VaultFoldersView, minRole: 'builder' },
        { path: '/vault/leases', element: views.VaultLeasesView, minRole: 'builder' },
        { path: '/vault/activity', element: views.VaultActivityView, minRole: 'admin' },

        // ── Runner+ routes ──
        { path: '/infra', element: views.InfraView, minRole: 'runner' },
        // QUOXPERTICUS-REVISIT N1: landing page for this org's resident hosts
        // (the headless supervisor answering a dev-slot, per-host detail at
        // /quoxperticus/:hostId). A CORE, ungated route, same posture as
        // /infra above (DevServersHubPanel renders there for every org
        // regardless of licence): the view gates itself with
        // isPluginLicensed('dev-servers') inline, mirroring
        // QuoxperticusResidentView's own QuoxperticusLocked pattern, rather
        // than going through the dev-servers plugin strip (that strip only
        // covers the tabbed hub + per-host drill-in routes registered by
        // plugins-src/dev-servers/index.jsx; this landing route is new and
        // does not import any of that bundle's stripped view files).
        { path: '/quoxperticus', element: views.QuoxperticusLandingView },
        // STUDY-REV-2 P8.A / ACAT-6: unified trigger management (webhook + schedule + event)
        // /schedules redirect is handled in App.jsx (JSX required; routeRegistry is plain .js)
        { path: '/triggers', element: views.TriggersView },
        { path: '/executions/:id', element: views.ExecutionDetailView },
        // LICENSE-LAUNCH LL-7 increment 3e: the /terminal row is deliberately GONE.
        // TerminalView now ships only in the signed web-terminal bundle
        // (plugins-src/web-terminal/), which re-registers the root path (with its
        // minRole 'runner' guard from manifest.routeGuards) on activation. Deleting
        // this edge is what stops Rollup reaching the view from the free build —
        // enforced by scripts/check-dist-clean.mjs. /terminal/about and
        // /terminal/share (below) are FREE core surfaces and stay. Do not re-add it.

        // ── Builder+ routes ──
        { path: '/tools', element: views.ToolsView, minRole: 'builder' },
        { path: '/tools/add', element: views.ToolAddView, minRole: 'builder' },
        { path: '/tools/:id', element: views.ToolDetailView, minRole: 'builder' },
        // STUDY-REV-2 P5.A: unified workflow hub — three views as tab panes.
        // /workflows, /workflow-builder, /workflow-library redirect here (see App.jsx).
        { path: '/workflows-hub', element: views.WorkflowsHubView, minRole: 'builder' },
        // /workflows/:id is now handled in App.jsx with a redirect to
        // /workflow-builder?id=:id (STUDY-REV-2 P6 unification).
        // /workflows and /workflow-builder are redirect routes defined in App.jsx (P5.A).
        { path: '/crystals', element: views.CrystalsLibraryView, minRole: 'builder' },
        { path: '/teams-overview', element: views.TeamsOverviewView, minRole: 'builder' },
        // QUOXGPU: Fable-guided GPU compute onboarding wizard
        { path: '/gpu-setup', element: views.GpuSetupView, minRole: 'builder' },
        { path: '/agentic-teams/:teamId', element: views.AgenticTeamView, minRole: 'builder' },
        // LICENSE-LAUNCH LL-7 increment 3g: the /nucleus row is deliberately GONE.
        // RepoBrainView now ships only in the signed quox-nucleus bundle
        // (plugins-src/quox-nucleus/), which re-registers the root path on activation.
        // Deleting this edge is what stops Rollup reaching the view from the free
        // build — enforced by scripts/check-dist-clean.mjs. The /nucleus row was
        // ungated, so no routeGuards in the signed manifest. The /nucleus/graph and
        // /nucleus/repos redirects live as JSX in App.jsx and only <Navigate> to
        // /nucleus — they never reference the view. The RepoBrain engine (:3105) is a
        // separate BACKEND surface and is not touched here.
        // LICENSE-LAUNCH LL-7 increment 4a: the /quoxplan/* row is deliberately
        // GONE. QuoxPlanView now ships only in the signed quoxplan bundle
        // (plugins-src/quoxplan/), which re-registers the root path on activation.
        // Deleting this edge is what stops Rollup reaching the view from the free
        // build — enforced by scripts/check-dist-clean.mjs. The /quoxplan/* row was
        // ungated (pluginId only, no minRole), so no routeGuards in the signed
        // manifest. The QuoxPlan API client OnboardView needs was extracted to a
        // core service (src/services/quoxplanApiClient.js) in the prior commit. The
        // QuoxPlan service (:3107) + its /api/v1/quoxplan/* collector proxy are a
        // separate BACKEND surface and are not touched here.
        // QUOX-SECURITY: SecurityEngagementsView manages list/detail via
        // internal state, not nested routes, so no trailing /* needed.
        { path: '/quox-security', element: views.SecurityEngagementsView, pluginId: 'quox-security' },
        // ONBOARD: visual tenant onboarding wizard (org + roadmap + security
        // engagement + GitHub PAT capture), mirrors `quox onboard <host>`.
        { path: '/onboard', element: views.OnboardView, minRole: 'admin' },
        // INBOXQ-1: InboxQView owns its own flat layout (no nested <Routes>
        // sub-paths in v1), but keeps the trailing /* for parity with the
        // other collector-native plugin views (QuoxSignal, QuoxLens) in case
        // a detail sub-route is added later. Not in the strip registry, so
        // no pluginId gate beyond the usePluginLicensed() check inside the
        // view itself (same pattern as QuoxLensView).
        { path: '/inboxq/*', element: views.InboxQView, pluginId: 'inboxq' },
        // AQ-9B L2-C1b: Calendar-Q. Same posture as InboxQ above — a trailing
        // /* for parity with other collector-native plugin views even though
        // this phase has no nested sub-routes of its own, gated by pluginId
        // plus the view's own usePluginLicensed() check.
        { path: '/calendarq/*', element: views.CalendarQView, pluginId: 'calendar-q' },
        // NOTESQ-1: NotesQView owns its own three-pane layout; trailing /* for parity.
        { path: '/notes/*', element: views.NotesQView, pluginId: 'notesq' },
        // CONTACTSQ: governed contacts (core-free; collector-native).
        { path: '/contacts/*', element: views.ContactsQView, pluginId: 'contactsq' },
        // QUOXVOICE-CONSOLE P0: org telephony numbers + policy. Writes are org-admin enforced server-side.
        { path: '/quox-voice-console', element: views.QuoxVoiceConsoleView },
        // LICENSE-LAUNCH LL-7 increment 3b: the /qlarity/* row is deliberately GONE.
        // QlarityView now ships only in the signed qlarity bundle
        // (plugins-src/qlarity/), which re-registers the root path on activation.
        // Deleting this edge is what stops Rollup reaching the view from the free
        // build — enforced by scripts/check-dist-clean.mjs. Do not re-add it.
        // LICENSE-LAUNCH LL-7 increment 3g: the /quoxsignal/* row is deliberately
        // GONE. QuoxSignalView now ships only in the signed quoxsignal bundle
        // (plugins-src/quoxsignal/), which re-registers the root path on activation.
        // Deleting this edge is what stops Rollup reaching the view from the free
        // build — enforced by scripts/check-dist-clean.mjs. The /quoxsignal/* row
        // was ungated, so no routeGuards in the signed manifest. The quoxsignal
        // service (:3108) + its /api/v1/signal/* collector proxy are a separate
        // BACKEND surface and are not touched here.
        // QUOXLENS-UI: QuoxLensView is a single view with ?tab=/scope=/fp=
        // query-param panes only (no nested sub-routes), unlike QuoxSignal/
        // QuoxPlan — so no trailing /* needed.
        // QUOXLENS-GATING: pluginId added (matches /quoxsignal, /quoxplan,
        // /nucleus above). The real gate lives inside QuoxLensView itself
        // (isPluginLicensed check -> QuoxLensLocked), same pattern as
        // QuoxSignalView -- this field documents the route's plugin
        // ownership for consistency, core routes don't consult it for
        // rendering.
        // LICENSE-LAUNCH LL-7 increment 3h: the /quoxlens row is deliberately GONE.
        // QuoxLensView now ships only in the signed quoxlens bundle
        // (plugins-src/quoxlens/), which re-registers the root path on activation.
        // Deleting this edge is what stops Rollup reaching the view (and its
        // components/quoxlens subtree) from the free build — enforced by
        // scripts/check-dist-clean.mjs. The route was ungated (the real gate lives
        // inside the view via isPluginLicensed), so no routeGuards in the signed
        // manifest. The QuoxLens collector routes are a separate BACKEND surface.
        // LICENSE-LAUNCH LL-7 increment 3d: the /telegram-pro row is deliberately
        // GONE. TelegramProView now ships only in the signed telegram-pro bundle
        // (plugins-src/telegram-pro/), which re-registers the root path on
        // activation. Deleting this edge is what stops Rollup reaching the view
        // from the free build — enforced by scripts/check-dist-clean.mjs. The
        // collector /telegram-pro routes are a separate BACKEND surface, already
        // entitlement-gated by LL-6d, and are not touched here.
        // LICENSE-LAUNCH LL-7 increment 3b: the /discord-pro row is deliberately
        // GONE. DiscordProView now ships only in the signed discord-pro bundle
        // (plugins-src/discord-pro/), which re-registers the root path on
        // activation. Deleting this edge is what stops Rollup reaching the view
        // from the free build — enforced by scripts/check-dist-clean.mjs. Do not
        // re-add it.
        { path: '/topology', element: views.CognitiveTopologyView, minRole: 'builder' },
        { path: '/diagnostics', element: views.DiagnosticsView, minRole: 'builder' },
        { path: '/test-lab', element: views.TestLabView, minRole: 'builder' },
        { path: '/cli', element: views.QuoxCLIView, minRole: 'builder' },
        // LICENSE-LAUNCH LL-7 increment 3c: the /docker row is deliberately GONE.
        // DockerView now ships only in the signed docker-fleet bundle
        // (plugins-src/docker-fleet/), which re-registers the root path (with its
        // minRole 'builder' guard from manifest.routeGuards) on activation.
        // Deleting this edge is what stops Rollup reaching the view from the free
        // build — enforced by scripts/check-dist-clean.mjs. Do not re-add it.
        // LICENSE-LAUNCH LL-7 increment 3e: the /bastion row is deliberately GONE.
        // BastionView now ships only in the signed bastion-fleet bundle
        // (plugins-src/bastion-fleet/), which re-registers the root path (with its
        // minRole 'builder' guard from manifest.routeGuards) on activation.
        // Deleting this edge is what stops Rollup reaching the view from the free
        // build — enforced by scripts/check-dist-clean.mjs. Do not re-add it.
        // LICENSE-LAUNCH LL-7 increment 3h: the /tailscale row is deliberately GONE.
        // TailscaleView now ships only in the signed tailscale bundle
        // (plugins-src/tailscale/), which re-registers the root path on activation.
        // Deleting this edge is what stops Rollup reaching the view (and its
        // components/tailscale subtree) from the free build — enforced by
        // scripts/check-dist-clean.mjs. The row was minRole 'viewer', preserved in the
        // signed manifest.routeGuards. The "Tailscale" integration TYPE is untouched.
        // LICENSE-LAUNCH LL-7 increment 3f: the /wazuh row is deliberately GONE.
        // WazuhView now ships only in the signed wazuh bundle (plugins-src/wazuh/),
        // which re-registers the root path on activation. Deleting this edge is what
        // stops Rollup reaching the view from the free build — enforced by
        // scripts/check-dist-clean.mjs. /wazuh carried minRole 'builder', preserved
        // in the signed manifest.routeGuards. The Wazuh collector handlers are a
        // separate BACKEND surface and are not touched here.
        // LICENSE-LAUNCH LL-7 increment 3b: the /github row is deliberately GONE.
        // GitHubView now ships only in the signed github bundle (plugins-src/github/),
        // which re-registers the root path (with its minRole 'builder' guard from
        // manifest.routeGuards) on activation. Deleting this edge is what stops
        // Rollup reaching the view from the free build — enforced by
        // scripts/check-dist-clean.mjs. Do not re-add it.
        // LICENSE-LAUNCH LL-7 increment 3h: the /routeros row is deliberately GONE.
        // RouterOSView now ships only in the signed mikrotik-routeros bundle
        // (plugins-src/mikrotik-routeros/), which re-registers the root path on
        // activation. Deleting this edge is what stops Rollup reaching the view (and
        // its components/routeros subtree) from the free build — enforced by
        // scripts/check-dist-clean.mjs. The row was minRole 'builder', preserved in the
        // signed manifest.routeGuards. The "RouterOS" integration TYPE is untouched.
        // LICENSE-LAUNCH LL-7 extraction 4: the four /monitoring/* rows are
        // deliberately GONE. GrafanaView, PrometheusView, UptimeKumaView and
        // ProxmoxView now ship only in their signed bundles (plugins-src/grafana/,
        // prometheus/, uptime-kuma/, proxmox/), each of which re-registers its root
        // path on activation. They strip as a SET per LL-5, because they shared one
        // component directory: the shared half of it is now
        // src/components/core/monitoring/ and stays in the free build for NOC, SOC,
        // Infra, Dashboard and NOCPopout. Deleting these edges is what stops Rollup
        // reaching the views (and the quad-exclusive components/monitoring subtree)
        // from the free build — enforced by scripts/check-dist-clean.mjs. All four
        // rows were minRole 'builder', preserved in the signed manifest.routeGuards.
        { path: '/memory', element: views.MemoryView, minRole: 'builder' },
        { path: '/brain2', element: views.QuoxbrainView, minRole: 'builder', pluginId: 'quox-brain2' },
        // LICENSE-LAUNCH LL-7 increment 3c: the /codebase-mirror row is
        // deliberately GONE. CodebaseMirrorView now ships only in the signed
        // codebase-mirror bundle (plugins-src/codebase-mirror/), which re-registers
        // the root path (with its minRole 'builder' guard from manifest.routeGuards)
        // on activation. Deleting this edge is what stops Rollup reaching the view
        // from the free build — enforced by scripts/check-dist-clean.mjs. Do not
        // re-add it.
        { path: '/opsdeck', element: views.OpsDeckView, minRole: 'builder' },

        // ── Admin+ routes ──
        // AUD-WS-2: governance read-only routes — auditorAllowed lets the
        // auditor role through ProtectedRoute even though it's not in the
        // numeric hierarchy. Write actions inside each view are still
        // gated by the user's capability set.
        { path: '/policies', element: views.PoliciesView, minRole: 'admin', auditorAllowed: true },
        { path: '/evidence', element: views.EvidenceView, minRole: 'admin', auditorAllowed: true },
        // LICENSE-LAUNCH LL-7 increment 1: /quoxbox was stripped out of the
        // free build. It now ships in the signed quoxbox-macmini plugin bundle,
        // which re-registers this exact path (with these exact guards, from its
        // signed manifest's routeGuards) on activation. Unentitled orgs get the
        // locked stub from src/config/premiumRouteStubs.js instead of a 404.
        // Deleting this row is what makes Rollup unable to reach QuoxBoxView.
        { path: '/volt', element: views.VoltView, minRole: 'admin', auditorAllowed: true },
        { path: '/ward', element: views.WardView, minRole: 'admin', auditorAllowed: true },
        // AGH-CHAIN honesty ledger: same governance read-only gate as VOLT/WARD.
        { path: '/honesty', element: views.HonestyLedgerView, minRole: 'admin', auditorAllowed: true },
        // Phase 24 (#setecastronomy): read-only env-flag visibility surface,
        // same governance read-only gate as the other admin-only surfaces above.
        { path: '/platform-capabilities', element: views.PlatformCapabilitiesView, minRole: 'admin', auditorAllowed: true },
        { path: '/certification', element: views.CertificationView, minRole: 'admin', auditorAllowed: true },
        { path: '/orgs', element: views.OrgsView, minRole: 'admin' },
        { path: '/orgs/:orgId', element: views.OrgManagementView, minRole: 'admin' },
        { path: '/orgs/:orgId/audit', element: views.AuditLogView, minRole: 'admin', auditorAllowed: true },
        { path: '/divisions', element: views.DivisionsView, minRole: 'admin' },
        { path: '/divisions/:divId', element: views.DivisionManagementView, minRole: 'admin' },
        { path: '/departments', element: views.DepartmentsView, minRole: 'admin' },
        { path: '/departments/:deptId', element: views.DepartmentManagementView, minRole: 'admin' },
        { path: '/tags', element: views.TagsView, minRole: 'admin' },
        { path: '/teams', element: views.TeamsView, minRole: 'admin' },
        { path: '/teams/:teamId', element: views.TeamManagementView, minRole: 'admin' },
        { path: '/plugins', element: views.PluginsView, minRole: 'admin' },
        { path: '/layer-plugins', element: views.LayerPluginsView, minRole: 'admin' },
        // LICENSE-LAUNCH LL-7 increment 3a: the /system row is deliberately GONE.
        // SystemMaintenanceView now ships only in the signed system-maintenance
        // bundle (plugins-src/system-maintenance/), which re-registers the root
        // path (minRole admin, via manifest.routeGuards) on activation. Deleting
        // this edge is what stops Rollup reaching the view from the free build —
        // enforced by scripts/check-dist-clean.mjs. Do not re-add it.

        // ── Ungated routes ──
        // /workflow-library redirects to /workflows-hub?tab=library (see App.jsx P5.A)
        // LICENSE-LAUNCH LL-7 increment 3a: the /prompts-library row is deliberately
        // GONE. PromptsLibraryView now ships only in the signed prompts-library
        // bundle (plugins-src/prompts-library/), which re-registers the root path on
        // activation. Deleting this edge is what stops Rollup reaching the view from
        // the free build — enforced by scripts/check-dist-clean.mjs. Do not re-add it.
        { path: '/image-gallery', element: views.ImageGalleryView },
        { path: '/assistants', element: views.AssistantsView },
        { path: '/inbox', element: views.InboxView },
        { path: '/inbox/:itemId', element: views.InboxItemDetailView },
        // LICENSE-LAUNCH LL-7 increment 3f: the /comms row is deliberately GONE.
        // CommsView now ships only in the signed core-comms bundle
        // (plugins-src/core-comms/), which re-registers the root path on
        // activation. Deleting this edge is what stops Rollup reaching the view
        // from the free build — enforced by scripts/check-dist-clean.mjs. The
        // collector notification routes (auth routes/messages.js +
        // routes/notifications.js) are a separate BACKEND surface and are not
        // touched here.
        // MATRIX-P4a: Matrix rooms pilot (distinct from /comms — CoreComms
        // external notification channels). Ungated for the pilot, like /soc, /noc.
        { path: '/matrix-comms', element: views.MatrixCommsView },
        // QUOXCHAT-PRO: Live Support desk. Matrix-free operator surface for
        // website chat conversations (org-authed conversation APIs only);
        // pairs with /matrix-comms on Matrix installs via matrix_room_id.
        { path: '/live-support', element: views.LiveSupportView },
        // LICENSE-LAUNCH LL-7 increment 3d: the /linkedin row is deliberately
        // GONE. LinkedInView now ships only in the signed linkedin bundle
        // (plugins-src/linkedin/), which re-registers the root path on
        // activation. Deleting this edge is what stops Rollup reaching the view
        // from the free build — enforced by scripts/check-dist-clean.mjs. The
        // LinkedIn OAuth routes are a separate BACKEND surface, not touched.
        // FB-3: the /facebook row is deliberately GONE, same shape as
        // /linkedin above. FacebookView ships only in the signed facebook
        // bundle (plugins-src/facebook/), which re-registers the root path
        // on activation.
        // IG-3: the /instagram row is deliberately GONE, same shape as
        // /facebook above. InstagramView ships only in the signed instagram
        // bundle (plugins-src/instagram/), which re-registers the root path
        // on activation.
        // TT-4: the /tiktok row is deliberately GONE, same shape as
        // /instagram above. TikTokView ships only in the signed tiktok
        // bundle (plugins-src/tiktok/), which re-registers the root path
        // on activation.
        // X-PLUGIN P3: /x is a CORE edge (pre-strip, unlike /linkedin above).
        // Entitlement-gated inside XView via usePluginLicensed('x'); the
        // signed x bundle (plugins-src/x/) exists additively. A future strip
        // increment removes this row, as LL-7 increment 3d did for /linkedin.
        { path: '/x', element: views.XView },
        // LICENSE-LAUNCH LL-7 increment 3d: the /youtube row is deliberately
        // GONE too. YouTubeView now ships only in the signed youtube bundle
        // (plugins-src/youtube/), which re-registers the root path on activation.
        // The YouTube OAuth routes are a separate BACKEND surface, not touched.
        { path: '/objectives', element: views.ObjectivesView },
        // LICENSE-LAUNCH LL-7 dev-servers strip (2026-08-30): the /dev-suite,
        // /dev-suite/servers/:hostId and /quoxperticus/:hostId rows are
        // deliberately GONE. DevSuiteView, DevSuiteHostDetailView and
        // QuoxperticusResidentView now ship only in the signed dev-servers
        // bundle (plugins-src/dev-servers/), which re-registers these paths on
        // activation. Deleting these edges is what stops Rollup reaching the
        // views from the free build — enforced by scripts/check-dist-clean.mjs.
        // The dev-server HUB itself (DevServersHubPanel + DocsPanel) stays
        // reachable for every org via the core /infra route — see InfraView.jsx.
        { path: '/mission-control', element: views.MissionControlView, minRole: 'runner' },
        // LICENSE-LAUNCH LL-7 extraction 1: the /actions row is deliberately
        // GONE. ActionsView now ships only in the signed action-tracker bundle
        // (plugins-src/action-tracker/), which re-registers the root path on
        // activation. It was ungated in core, so no guards travel with it.
        // Deleting this edge is what stops Rollup reaching the view from the
        // free build — enforced by scripts/check-dist-clean.mjs. Do not re-add it.
        // LICENSE-LAUNCH LL-7 increment 3c: the /browser-q and
        // /browser-q/run/:objectiveId rows are deliberately GONE. BrowserQView +
        // BrowserQRunDetailView now ship only in the signed browser-q bundle
        // (plugins-src/browser-q/), which re-registers both root paths on
        // activation. Both rows were ungated, so no guards travel with them.
        // Deleting these edges is what stops Rollup reaching the views from the
        // free build — enforced by scripts/check-dist-clean.mjs. Do not re-add them.
        { path: '/compliance', element: views.ComplianceView, auditorAllowed: true },
        { path: '/traces', element: views.TraceBrowserView },
        { path: '/traces/:runId', element: views.TraceDetailView },
        { path: '/traces/:runId/replay', element: views.TraceReplayView },
        { path: '/traces/:runId/compare/:otherRunId', element: views.TraceCompareView },
        { path: '/playground', element: views.PlaygroundView },
        { path: '/org', element: views.OrgView },
        { path: '/terminal/about', element: views.TerminalPromo },
        { path: '/terminal/share/:shareId', element: views.SnapshotViewer },

        // ── QuoxChat (Stream CW) ──
        // LICENSE-LAUNCH LL-7 increment 3h: the /quoxchat rows are deliberately GONE.
        // QuoxChatView + QuoxChatWidgetRoom now ship only in the signed quoxchat
        // bundle (plugins-src/quoxchat/), which re-registers the root paths on
        // activation. Deleting these edges is what stops Rollup reaching the views
        // from the free build — enforced by scripts/check-dist-clean.mjs. The rows
        // were ungated, so no routeGuards in the signed manifest. The QuoxChat
        // collector routes + widget store are a separate BACKEND surface, not touched.

        // ── QuoxMCP (Claude Desktop integration) ──
        { path: '/quoxmcp', element: views.QuoxMCPView },

        // ── Marketplace (Stream 2+3) ──
        { path: '/marketplace/browse', element: views.MarketplaceBrowseView },
        { path: '/marketplace/:id', element: views.MarketplaceDetailView },
        { path: '/seller', element: views.SellerDashboardView },
        { path: '/seller/register', element: views.SellerRegistrationView },
        { path: '/seller/submit', element: views.SubmitListingView, minRole: 'builder' },
        { path: '/seller/listings/:id', element: views.ManageListingView, minRole: 'builder' },
    ];
}

// ── Third-party plugin routes ─────────────────────────────────────────────

/** Map<pluginId, routeDef[]> */
const pluginRoutes = new Map();

// LL-7: paths a plugin may never claim, even with the root-route privilege.
// '/' is the Command Centre and '*' is the router catch-all; handing either to
// a bundle would let one plugin swallow the whole application shell.
const RESERVED_ROOT_PATHS = new Set(['/', '*', '/*']);

/**
 * Register a route for a third-party plugin.
 *
 * By default all plugin routes are namespaced under /plugins/{pluginId}/.
 *
 * LICENSE-LAUNCH LL-7: a FIRST-PARTY bundle may instead keep the root path its
 * stripped core route used to own (/quoxbox, /github, /qlarity/*), so moving a
 * view out of the free build does not break every bookmark and deep link
 * pointing at it. That privilege is opt-in per call via `allowRootRoutes` and
 * is granted ONLY by thirdPartyPluginHost, only after it has verified the
 * install is Quox-signed AND its manifest says official === true. It is never
 * read off the manifest the bundle ships with — see
 * services/officialPluginSignature.js.
 *
 * @param {string} pluginId
 * @param {{path: string, component: React.ComponentType, minRole?: string, auditorAllowed?: boolean}} routeDef
 * @param {{allowRootRoutes?: boolean}} [options]
 */
export function registerPluginRoute(pluginId, routeDef, options = {}) {
    if (!pluginId || !routeDef || !routeDef.path || !routeDef.component) {
        throw new Error('registerPluginRoute: pluginId, path, and component required');
    }

    const { allowRootRoutes = false } = options;
    const prefix = `/plugins/${pluginId}`;
    const alreadyNamespaced = routeDef.path.startsWith(prefix);

    // A root route is only the OPT-IN case: an absolute path that is not
    // already inside the plugin namespace, on a call that was granted the
    // privilege. Everything else keeps the historic namespacing behaviour.
    const wantsRootRoute = allowRootRoutes
        && !alreadyNamespaced
        && routeDef.path.startsWith('/');

    if (allowRootRoutes && RESERVED_ROOT_PATHS.has(routeDef.path)) {
        throw new Error(`registerPluginRoute: "${routeDef.path}" is a reserved path and cannot be claimed by a plugin`);
    }

    const fullPath = wantsRootRoute
        ? routeDef.path
        : (alreadyNamespaced
            ? routeDef.path
            : `${prefix}${routeDef.path.startsWith('/') ? routeDef.path : '/' + routeDef.path}`);

    const entry = pluginRoutes.get(pluginId) || [];
    entry.push({
        path: fullPath,
        element: routeDef.component,
        minRole: routeDef.minRole,
        // AUD-WS-2 parity: core rows like /quoxbox carried auditorAllowed, and
        // App.jsx wraps a route in ProtectedRoute when EITHER guard is set. The
        // flag has to survive the hop into the bundle or the stripped route
        // silently loses auditor access. Only forwarded when actually declared,
        // so an unguarded plugin route stays unguarded.
        ...(routeDef.auditorAllowed === undefined ? {} : { auditorAllowed: routeDef.auditorAllowed }),
        pluginId,
        _thirdParty: true,
        _rootRoute: wantsRootRoute,
    });
    pluginRoutes.set(pluginId, entry);

    window.dispatchEvent(new CustomEvent('quox-plugin-route-change', {
        detail: { pluginId, action: 'register' }
    }));
}

/**
 * Unregister all routes for a plugin.
 * @param {string} pluginId
 */
export function unregisterPluginRoutes(pluginId) {
    if (!pluginRoutes.has(pluginId)) return;
    pluginRoutes.delete(pluginId);

    window.dispatchEvent(new CustomEvent('quox-plugin-route-change', {
        detail: { pluginId, action: 'unregister' }
    }));
}

/**
 * Get all third-party plugin routes.
 * @returns {Array}
 */
export function getPluginRoutes() {
    const routes = [];
    for (const [, entries] of pluginRoutes) {
        routes.push(...entries);
    }
    return routes;
}

/**
 * Get all routes (core + plugin). Core routes must be seeded first via buildCoreRoutes().
 * @param {Array} coreRoutes - Output of buildCoreRoutes()
 * @returns {Array}
 */
export function getAllRoutes(coreRoutes) {
    return [...coreRoutes, ...getPluginRoutes()];
}

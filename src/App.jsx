/**
 * QuoxCORE Dashboard - Main Application
 *
 * Unified application shell with integrated HAL interface and workspace.
 * All authenticated routes use the AppShell layout for consistent navigation.
 *
 * Route Structure:
 * - / -> Home (HAL interface with quick status)
 * - /dashboard -> Dashboard (system overview)
 * - /noc -> NOC Operations
 * - /soc -> SOC Security
 * - /agents -> Agent Fleet Management
 * - /tools -> Tools Management
 * - /workflows -> Workflow Automation
 * - /assistants -> AI Assistants
 * - /org -> Organization Management
 * - /settings -> Unified Settings
 * - /login -> Login (no shell)
 * - /docs/* -> Documentation (separate layout, will become website)
 * - /admin/* -> Admin Dashboard (separate layout)
 *
 * Build: 2026-03-20T11:30Z
 */

import { useEffect, useMemo, useState, Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useSearchParams, useLocation } from 'react-router-dom'
import './App.css'
import './styles/glass.css'
import './styles/qx-components.css'
import './styles/hal.css'
import './styles/design-system.css'

// Preload services
import { preloadCognitiveData } from './services/cognitiveDataCache'
import { startBackgroundSync, stopBackgroundSync } from './lib/aee'
import { initFileStorage } from './services/fileStorage'
import { initCookieConsent } from './services/cookieConsentService'
import { initVoltStore, closeVoltDB, startVoltBackgroundSync } from './lib/volt/volt-store'
import voltBridge from './lib/volt/volt-bridge'
import { initSyncQueue } from './services/serverSyncQueue'
import { getMemoryManager } from './services/memoryManager'
import { hydrateAlertsFromServer } from './services/alertService'
import { hydrateWorkingSetFromServer } from './services/workingSetMemory'
import { hydrateBeliefsFromServer } from './services/beliefMemory'
import { hydrateFailuresFromServer } from './services/failureMemory'
import { hydrateStyleFromServer } from './services/styleEngine'
import { hydratePromotionFromServer } from './services/memoryPromotion'

// Privacy Components (Security Issue #74)
import { CookieConsentBanner } from './components/privacy'

// Layout Components
import { AppShell } from './components/layout'

// Glass Concept Demo (standalone, no AppShell)
import GlassConceptView from './pages/views/GlassConceptView'
// QX Lab — design-system prototype (inside AppShell)
import QxLabComponentsView, { QxLabLayout } from './pages/views/qx-lab/QxLabComponentsView'
import QxLabApplicationView from './pages/views/qx-lab/QxLabApplicationView'
import QxLabEdgeCasesView from './pages/views/qx-lab/QxLabEdgeCasesView'
import QxLabStoreView from './pages/views/qx-lab/QxLabStoreView'
import CategoryLandingView from './pages/views/CategoryLandingView'
// Files-Q Mockup (standalone design review)
import FilesQMockup, { FilesQComponentGallery } from './pages/views/FilesQMockup'
// R3F views MUST be lazy-loaded — their hooks crash if modules are eagerly evaluated
const ThreeDLabView = lazy(() => import('./pages/views/ThreeDLabView'))
const PublicWaypointView = lazy(() => import('./pages/views/PublicWaypointView'))
const NotFoundView = lazy(() => import('./pages/views/NotFoundView'))
// LICENSE-LAUNCH LL-7 cogcore3d strip (2026-08-30): CognitiveCore3DView's
// lazy() import is deliberately GONE. It now ships only in the signed cogcore3d
// plugin bundle (plugins-src/cogcore3d/), and this deleted edge is precisely
// what stops Rollup walking into it — and into the opsdeck3d hud/, hooks/ and
// CognitiveCore.jsx modules nothing else imports — from the free build.
// Enforced by scripts/check-dist-clean.mjs.
// src/components/opsdeck3d/ itself STAYS CORE: ThreeDLabView (/3d-lab, above)
// and QuoxbrainView (/brain2, lazy BrainOrgan3D) still consume its zones,
// effects and lib. Do not re-add this line.
// QN Phase 3: Search/Graph/Repos/Connections unified into one tabbed view
// LICENSE-LAUNCH LL-7 increment 3g: RepoBrainView's lazy() import is deliberately
// GONE. It now ships only in the signed quox-nucleus plugin bundle
// (plugins-src/quox-nucleus/), and this deleted edge is precisely what stops Rollup
// walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. The RepoBrain engine (:3105) + its collector proxy
// are a separate BACKEND surface and stay. The /nucleus/graph and /nucleus/repos
// redirects below only <Navigate> to /nucleus and never touch the view. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 4a: QuoxPlanView's lazy() import is deliberately
// GONE. It now ships only in the signed quoxplan bundle (plugins-src/quoxplan/),
// which re-registers /quoxplan/* on activation. Deleting this edge is what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. The QuoxPlan API client OnboardView needs was
// extracted to src/services/quoxplanApiClient.js in the prior commit. The QuoxPlan
// service (:3107) + its collector proxy are a separate BACKEND surface and stay.
// Do not re-add it.
const SecurityEngagementsView = lazy(() => import('./pages/views/SecurityEngagementsView'))
// ONBOARD: visual tenant onboarding wizard mirroring `quox onboard <host>`
const OnboardView = lazy(() => import('./pages/views/OnboardView'))
// INBOXQ-1: dashboard-embedded InboxQ view (governed IMAP inbox triage).
// Collector-native (no separate service/port to proxy) - not in the LL-7
// strip registry, so it ships directly in the free build like InboxView.
const InboxQView = lazy(() => import('./components/inboxq/InboxQView'))
// AQ-9B L2-C1b: dashboard-embedded Calendar-Q view. Collector-native, same
// posture as InboxQView above - ships directly in the free build.
const CalendarQView = lazy(() => import('./components/calendarq/CalendarQView'))
// NOTESQ-1: dashboard-embedded NotesQ markdown notebook (collector-native).
const NotesQView = lazy(() => import('./components/notesq/NotesQView'))
// CONTACTSQ: governed contacts view (collector-native, core-free).
const ContactsQView = lazy(() => import('./components/contactsq/ContactsQView'))
// QuoxVoice Console (P0): org numbers + policy editor.
const QuoxVoiceConsoleView = lazy(() => import('./pages/views/QuoxVoiceConsoleView'))
// LICENSE-LAUNCH LL-7 increment 3b: QlarityView's lazy() import is deliberately
// GONE. It now ships only in the signed qlarity plugin bundle
// (plugins-src/qlarity/), and this deleted edge is precisely what stops Rollup
// walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3g: QuoxSignalView's lazy() import is deliberately
// GONE. It now ships only in the signed quoxsignal plugin bundle
// (plugins-src/quoxsignal/), and this deleted edge is precisely what stops Rollup
// walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. The quoxsignal service (:3108) + its /api/v1/signal/*
// collector proxy are a separate BACKEND surface and stay. Do not re-add it.
// QUOXLENS-UI: dashboard-embedded QuoxLens view (?tab=/scope=/fp= query panes only)
// LICENSE-LAUNCH LL-7 increment 3h: QuoxLensView's lazy() import is deliberately
// GONE. It now ships only in the signed quoxlens plugin bundle
// (plugins-src/quoxlens/), and this deleted edge is precisely what stops Rollup
// walking into the view (and its components/quoxlens subtree) from the free build
// — enforced by scripts/check-dist-clean.mjs. The QuoxLens collector routes are a
// separate BACKEND surface and stay. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3d: TelegramProView's lazy() import is
// deliberately GONE. It now ships only in the signed telegram-pro plugin bundle
// (plugins-src/telegram-pro/), and this deleted edge is precisely what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3b: DiscordProView's lazy() import is
// deliberately GONE. It now ships only in the signed discord-pro plugin bundle
// (plugins-src/discord-pro/), and this deleted edge is precisely what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.

// View Components (Unified App)
import HomeView from './pages/views/HomeView'
import ActivityView from './pages/views/ActivityViewPage'
// LICENSE-LAUNCH LL-7 increment 3h: FilesView's import is deliberately GONE. It
// now ships only in the signed files plugin bundle (plugins-src/files/), and
// this deleted edge is precisely what stops Rollup walking into the view tree
// from the free build — enforced by scripts/check-dist-clean.mjs. The shared
// file pickers (components/files/shared/*) and the file backend stay. Do not re-add it.
import SettingsView from './pages/views/SettingsView'
import PluginsView from './pages/views/PluginsView'
import LayerPluginsView from './pages/views/LayerPluginsView'
const DashboardView = lazy(() => import('./pages/views/DashboardView'))
const NOCView = lazy(() => import('./pages/views/NOCView'))
const SOCView = lazy(() => import('./pages/views/SOCView'))
const LucidView = lazy(() => import('./pages/views/LucidView'))
const InfraView = lazy(() => import('./pages/views/InfraView'))
// QUOXPERTICUS-REVISIT N1: landing page for this org's resident hosts, a
// CORE ungated route (see routeRegistry.js comment above /quoxperticus).
const QuoxperticusLandingView = lazy(() => import('./pages/views/QuoxperticusLandingView'))
const AgentsView = lazy(() => import('./pages/views/AgentsView'))
const MemoryView = lazy(() => import('./pages/views/MemoryView'))
const QuoxbrainView = lazy(() => import('./pages/views/QuoxbrainView'))
const ToolsView = lazy(() => import('./pages/views/ToolsView'))
const ToolAddView = lazy(() => import('./pages/views/ToolAddView'))
const ToolDetailView = lazy(() => import('./pages/views/ToolDetailView'))
const WorkflowsView = lazy(() => import('./pages/views/WorkflowsView'))
const WorkflowBuilderView = lazy(() => import('./pages/views/WorkflowBuilderView'))
const WorkflowsHubView = lazy(() => import('./pages/views/WorkflowsHubView'))
const AssistantsView = lazy(() => import('./pages/views/AssistantsView'))
const OrgView = lazy(() => import('./pages/views/OrgView'))
const OrgsView = lazy(() => import('./pages/views/OrgsView'))
const OrgManagementView = lazy(() => import('./pages/views/OrgManagementView'))
const AuditLogView = lazy(() => import('./pages/views/AuditLogView'))
const DivisionsView = lazy(() => import('./pages/views/DivisionsView'))
const DivisionManagementView = lazy(() => import('./pages/views/DivisionManagementView'))
const DepartmentsView = lazy(() => import('./pages/views/DepartmentsView'))
const DepartmentManagementView = lazy(() => import('./pages/views/DepartmentManagementView'))
const TeamsView = lazy(() => import('./pages/views/TeamsView'))
const TeamManagementView = lazy(() => import('./pages/views/TeamManagementView'))
const TagsView = lazy(() => import('./pages/views/TagsView'))
const InboxView = lazy(() => import('./pages/views/InboxView'))
const InboxItemDetailView = lazy(() => import('./pages/views/InboxItemDetailView'))
const CognitiveTopologyView = lazy(() => import('./pages/views/CognitiveTopologyView'))
const ArchivistView = lazy(() => import('./pages/views/ArchivistView'))
const DiagnosticsView = lazy(() => import('./pages/views/DiagnosticsView'))
const ComplianceView = lazy(() => import('./pages/views/ComplianceView'))
const PlaygroundView = lazy(() => import('./pages/views/PlaygroundView'))
const AgentFamilyTreeView = lazy(() => import('./pages/views/AgentFamilyTreeView'))
const AgentDetailView = lazy(() => import('./pages/views/AgentDetailView'))
const VulcanView = lazy(() => import('./pages/views/VulcanView'))
const GripeView = lazy(() => import('./pages/views/GripeView'))
const SessionsView = lazy(() => import('./pages/views/SessionsView'))
const AgentStreamPage = lazy(() => import('./pages/views/AgentStreamPage'))
const TestLabView = lazy(() => import('./pages/views/TestLabView'))
const TriggersView = lazy(() => import('./pages/views/TriggersView'))
const ExecutionDetailView = lazy(() => import('./pages/views/ExecutionDetailView'))
const CrystalsLibraryView = lazy(() => import('./pages/views/CrystalsLibraryView'))
const SkillsView = lazy(() => import('./pages/views/SkillsView'))
const SkillReviewQueueView = lazy(() => import('./pages/views/SkillReviewQueueView'))
const ObjectivesView = lazy(() => import('./pages/views/ObjectivesView'))
// LICENSE-LAUNCH LL-7 dev-servers strip (2026-08-30): DevSuiteView,
// DevSuiteHostDetailView and QuoxperticusResidentView's lazy() imports are
// deliberately GONE. They now ship only in the signed dev-servers plugin
// bundle (plugins-src/dev-servers/), and this deleted edge is precisely what
// stops Rollup walking into them from the free build — enforced by
// scripts/check-dist-clean.mjs. The dev-server HUB content itself
// (DevServersHubPanel + DocsPanel) stays reachable for every org via the core
// /infra route (LL-7 extraction 2 moved them to src/components/core/devsuite/)
// — only the /dev-suite drill-in routes leave core. Do not re-add these.
const TeamsOverviewView = lazy(() => import('./pages/views/TeamsOverviewView'))
const AgenticTeamView = lazy(() => import('./pages/views/AgenticTeamView'))
// LICENSE-LAUNCH LL-7 extraction 1: ActionsView's lazy() import is deliberately
// GONE. It now ships only in the signed action-tracker plugin bundle
// (plugins-src/action-tracker/), and this deleted edge is precisely what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3c: the BrowserQView + BrowserQRunDetailView
// lazy() imports are deliberately GONE. They now ship only in the signed
// browser-q plugin bundle (plugins-src/browser-q/), and these deleted edges are
// precisely what stops Rollup walking into the views from the free build —
// enforced by scripts/check-dist-clean.mjs. Do not re-add them.
// LICENSE-LAUNCH LL-7 increment 3c: CodebaseMirrorView's lazy() import is
// deliberately GONE. It now ships only in the signed codebase-mirror plugin
// bundle (plugins-src/codebase-mirror/), and this deleted edge is precisely what
// stops Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3h: QuoxChatView + QuoxChatWidgetRoom lazy()
// imports are deliberately GONE. They now ship only in the signed quoxchat plugin
// bundle (plugins-src/quoxchat/), and these deleted edges are precisely what stops
// Rollup walking into the views from the free build — enforced by
// scripts/check-dist-clean.mjs. The QuoxChat collector routes + widget store are a
// separate BACKEND surface and stay. Do not re-add them.
const QuoxMCPView = lazy(() => import('./pages/views/QuoxMCPView'))
const OpsDeckView = lazy(() => import('./pages/views/OpsDeckView'))
const MissionControlView = lazy(() => import('./pages/views/MissionControlView'))
const CrystalsPage = lazy(() => import('./pages/docs/CrystalsPage'))

// Standalone Pages
import VisualizerPopup from './pages/VisualizerPopup'
import TopologyPopup from './pages/TopologyPopup'
import NOCPopout from './pages/NOCPopout'
import QuoxCore from './pages/QuoxCore'
import LoginPage from './pages/LoginPage'
const GuestInvitePage  = lazy(() => import('./pages/GuestInvitePage'))
const GuestLandingView = lazy(() => import('./pages/GuestLandingView'))
// #321 / #322-FE — MFA enrol + challenge pages (no auth required)
const MfaEnrollView   = lazy(() => import('./pages/views/MfaEnrollView'))
const MfaChallengeView = lazy(() => import('./pages/views/MfaChallengeView'))
import SetupWizard from './pages/Setup'
// Website removed - all website content now served from quox.ai
import ExternalRedirect from './components/ExternalRedirect'

// Documentation removed - all docs now served from quox.ai

// Observability surface — SET-IA Phase 2 (peer to /admin)
// SET-IA Phase 7: AdminLayout + AdminConfig retired. All /admin/*
// paths now redirect into the unified /settings tree.
import {
    ObservabilityLayout,
    Overview as ObsOverview,
    Health as ObsHealth,
    Logs as ObsLogs,
    ErrorReports as ObsErrorReports,
    Feedback as ObsFeedback,
    AuditTrail as ObsAuditTrail,
} from './pages/observability'

// Context Providers
import { SafetyProvider } from './contexts/SafetyContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { WorkspaceProvider } from './contexts/WorkspaceContext'
import { HealthProvider } from './contexts/HealthContext'

// Route Protection
import ProtectedRoute from './components/auth/ProtectedRoute'
import renderRouteElement, { ROUTE_FALLBACK_STYLE } from './components/router/renderRouteElement'

// Route Registry (Stream A — third-party plugin framework)
import { buildCoreRoutes, getPluginRoutes } from './config/routeRegistry'
// LICENSE-LAUNCH LL-7: metadata-only stub table for premium routes whose view
// has been stripped into a signed plugin bundle. Zero component imports by
// contract — see src/config/premiumRouteStubs.js.
import { selectPremiumStubRoutes } from './config/premiumRouteStubs'
import { PremiumRouteStub } from './components/plugins/PluginLockedView'
import PluginSandbox from './components/plugins/PluginSandbox'
import { deactivateThirdPartyPlugin, arePluginsHydrated } from './services/thirdPartyPluginHost'

const WorkflowLibraryView = lazy(() => import('./pages/views/WorkflowLibraryView'))
// LICENSE-LAUNCH LL-7 increment 3a: the PromptsLibraryView and
// SystemMaintenanceView lazy() imports are deliberately GONE. Each now ships
// only in its signed plugin bundle (plugins-src/prompts-library/,
// plugins-src/system-maintenance/), and these deleted edges are precisely what
// stop Rollup walking into the views from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add them.
// LICENSE-LAUNCH LL-7 increment 3e: BastionView's lazy() import is deliberately
// GONE. It now ships only in the signed bastion-fleet plugin bundle
// (plugins-src/bastion-fleet/), and this deleted edge is precisely what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3h: TailscaleView's lazy() import is deliberately
// GONE. It now ships only in the signed tailscale plugin bundle
// (plugins-src/tailscale/), and this deleted edge is precisely what stops Rollup
// walking into the view (and its components/tailscale subtree) from the free build
// — enforced by scripts/check-dist-clean.mjs. The "Tailscale" integration TYPE
// (tailscaleClient / integrationTypes / extensions) stays. Do not re-add the view.
// LICENSE-LAUNCH LL-7 increment 3h: RouterOSView's lazy() import is deliberately
// GONE. It now ships only in the signed mikrotik-routeros plugin bundle
// (plugins-src/mikrotik-routeros/), and this deleted edge is precisely what stops
// Rollup walking into the view (and its components/routeros subtree) from the free
// build — enforced by scripts/check-dist-clean.mjs. The "RouterOS" integration TYPE
// (routerosClient / extensions) stays. Do not re-add the view.
const PoliciesView = lazy(() => import('./pages/views/PoliciesView'))
const EvidenceView = lazy(() => import('./pages/views/EvidenceView'))
// LICENSE-LAUNCH LL-7 increment 1: QuoxBoxView's lazy() import is deliberately
// GONE. It now ships only in the signed quoxbox-macmini plugin bundle
// (plugins-src/quoxbox-macmini/), and this deleted edge is precisely what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
const GpuSetupView = lazy(() => import('./pages/views/GpuSetupView'))
// LICENSE-LAUNCH LL-7 increment 3e: TerminalView's lazy() import is deliberately
// GONE. The /terminal workspace now ships only in the signed web-terminal plugin
// bundle (plugins-src/web-terminal/), and this deleted edge is precisely what
// stops Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it. TerminalPromo (/terminal/about)
// and SnapshotViewer (/terminal/share) stay in core, below.
const TerminalPromo = lazy(() => import('./pages/views/TerminalPromo'))
const SnapshotViewer = lazy(() => import('./pages/views/SnapshotViewer'))
const QuoxCLIView = lazy(() => import('./pages/views/QuoxCLIView'))
const VoltView = lazy(() => import('./pages/views/VoltView'))
const TraceBrowserView = lazy(() => import('./pages/views/TraceBrowserView'))
const TraceDetailView = lazy(() => import('./pages/views/TraceDetailView'))
const TraceReplayView = lazy(() => import('./pages/views/TraceReplayView'))
const TraceCompareView = lazy(() => import('./pages/views/TraceCompareView'))
const WardView = lazy(() => import('./pages/views/WardView'))
const HonestyLedgerView = lazy(() => import('./pages/views/HonestyLedgerView'))
const PlatformCapabilitiesView = lazy(() => import('./pages/views/PlatformCapabilitiesView'))
// LICENSE-LAUNCH LL-7 increment 3f: CommsView's lazy() import is deliberately
// GONE. It now ships only in the signed core-comms plugin bundle
// (plugins-src/core-comms/), and this deleted edge is precisely what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it. MatrixCommsView is a SEPARATE
// surviving core view (/matrix-comms) that merely ends in "CommsView"; it stays.
const MatrixCommsView = lazy(() => import('./pages/views/MatrixCommsView'))
const LiveSupportView = lazy(() => import('./pages/views/LiveSupportView'))
// X-PLUGIN P3: XView is a CORE edge today (pre-strip, unlike linkedin/youtube).
// The signed x bundle (plugins-src/x/) exists additively; a future strip
// increment deletes this lazy import + the routeRegistry row, exactly as
// LL-7 increment 3d did for linkedin. See src/config/stripRegistry.js ('x').
const XView = lazy(() => import('./pages/views/XView'))
const ImageGalleryView = lazy(() => import('./pages/views/ImageGalleryView'))
const VaultBrowseView = lazy(() => import('./pages/views/VaultBrowseView'))
const VaultDashboardView = lazy(() => import('./pages/views/VaultDashboardView'))
const VaultCredentialsView = lazy(() => import('./pages/views/VaultCredentialsView'))
const VaultFoldersView = lazy(() => import('./pages/views/VaultFoldersView'))
const VaultLeasesView = lazy(() => import('./pages/views/VaultLeasesView'))
const VaultActivityView = lazy(() => import('./pages/views/VaultActivityView'))
const FeedbackView = lazy(() => import('./pages/views/FeedbackView'))
const CertificationView = lazy(() => import('./pages/views/CertificationView'))
// LICENSE-LAUNCH LL-7 increment 3f: WazuhView's lazy() import is deliberately
// GONE. It now ships only in the signed wazuh plugin bundle (plugins-src/wazuh/),
// and this deleted edge is precisely what stops Rollup walking into the view from
// the free build — enforced by scripts/check-dist-clean.mjs. The 16 Wazuh
// collector handlers are a separate BACKEND surface and stay. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3b: GitHubView's lazy() import is deliberately
// GONE. It now ships only in the signed github plugin bundle
// (plugins-src/github/), and this deleted edge is precisely what stops Rollup
// walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
// LICENSE-LAUNCH LL-7 extraction 4: the lazy() imports for GrafanaView,
// PrometheusView, UptimeKumaView and ProxmoxView are deliberately GONE. The
// four monitoring plugins strip as a SET (LL-5's classification: they shared
// one component directory, so deleting any one edge alone gave zero dist
// reduction) and now ship only in their signed bundles (plugins-src/grafana/,
// prometheus/, uptime-kuma/, proxmox/). Deleting these edges is what stops
// Rollup walking into the views — enforced by scripts/check-dist-clean.mjs.
// The SHARED panels those views used to share with NOC/SOC/Infra/Dashboard
// moved to src/components/core/monitoring/ in the preceding commit and are
// still in the free build. Do not re-add these four.
// LICENSE-LAUNCH LL-7 increment 3c: DockerView's lazy() import is deliberately
// GONE. It now ships only in the signed docker-fleet plugin bundle
// (plugins-src/docker-fleet/), and this deleted edge is precisely what stops
// Rollup walking into the view from the free build — enforced by
// scripts/check-dist-clean.mjs. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3d: LinkedInView's and YouTubeView's lazy()
// imports are deliberately GONE. They now ship only in the signed linkedin and
// youtube plugin bundles (plugins-src/linkedin/, plugins-src/youtube/), and
// these deleted edges are precisely what stop Rollup walking into the views from
// the free build — enforced by scripts/check-dist-clean.mjs. Do not re-add them.
// FB-3: FacebookView's lazy() import is deliberately GONE, same shape as
// LinkedInView above. It ships only in the signed facebook plugin bundle
// (plugins-src/facebook/). Do not re-add it.
// IG-3: InstagramView's lazy() import is deliberately GONE, same shape as
// FacebookView above. It ships only in the signed instagram plugin bundle
// (plugins-src/instagram/). Do not re-add it.
// TT-4: TikTokView's lazy() import is deliberately GONE, same shape as
// InstagramView above. It ships only in the signed tiktok plugin bundle
// (plugins-src/tiktok/). Do not re-add it.
const SellerRegistrationView = lazy(() => import('./pages/views/marketplace/SellerRegistration'))
const SellerDashboardView = lazy(() => import('./pages/views/marketplace/SellerDashboard'))
const SubmitListingView = lazy(() => import('./pages/views/marketplace/SubmitListing'))
const ManageListingView = lazy(() => import('./pages/views/marketplace/ManageListing'))
const MarketplaceBrowseView = lazy(() => import('./pages/views/marketplace/MarketplaceBrowseView'))
const MarketplaceDetailView = lazy(() => import('./pages/views/marketplace/MarketplaceDetailView'))

/**
 * Main App Component
 *
 * The application uses a unified shell (AppShell) for all main routes,
 * with documentation and admin sections using their own layouts.
 */

// Build core route table from view imports (moved from static <Route> declarations)
const CORE_ROUTES = buildCoreRoutes({
    HomeView, DashboardView, SOCView, LucidView, NOCView, InfraView,
    AgentsView, AgentStreamPage, AgentFamilyTreeView, AgentDetailView, VulcanView, GripeView, SessionsView,
    ActivityView, ArchivistView, SettingsView, FeedbackView,
    VaultDashboardView, VaultBrowseView, VaultCredentialsView, VaultFoldersView,
    VaultLeasesView, VaultActivityView,
    TriggersView, ExecutionDetailView,
    ToolsView, ToolAddView, ToolDetailView, WorkflowsView, WorkflowBuilderView, WorkflowsHubView, CrystalsLibraryView,
    TeamsOverviewView, AgenticTeamView,
    CognitiveTopologyView, DiagnosticsView, TestLabView,
    QuoxCLIView,
    MemoryView, QuoxbrainView, OpsDeckView, MissionControlView, QuoxperticusLandingView,
    PoliciesView, EvidenceView, VoltView, WardView, HonestyLedgerView, PlatformCapabilitiesView, CertificationView, GpuSetupView,
    OrgsView, OrgManagementView, AuditLogView,
    DivisionsView, DivisionManagementView,
    DepartmentsView, DepartmentManagementView,
    TeamsView, TeamManagementView, TagsView,
    PluginsView, LayerPluginsView,
    WorkflowLibraryView, ImageGalleryView,
    AssistantsView, InboxView, InboxItemDetailView,
    MatrixCommsView, LiveSupportView, ObjectivesView, XView,
    QuoxMCPView,
    ComplianceView, PlaygroundView, OrgView, TraceBrowserView, TraceDetailView, TraceReplayView, TraceCompareView,
    TerminalPromo, SnapshotViewer,
    SellerRegistrationView, SellerDashboardView, SubmitListingView, ManageListingView,
    MarketplaceBrowseView, MarketplaceDetailView,
    SecurityEngagementsView,
    OnboardView,
    InboxQView,
    CalendarQView,
    NotesQView,
    ContactsQView,
    QuoxVoiceConsoleView,
});

// Settings uses hash-based navigation internally. This redirects /settings/<section>
// (single legacy segment, e.g. /settings/members, OR a full canonical section id
// with a scope prefix, e.g. /settings/instance/quoxperticus) → /settings#<section>
// so that deep-linked URLs, docs links and bookmarks in the path form resolve
// instead of hitting the 404 catch-all (F7). The route below uses a splat so
// multi-segment canonical ids (scope/id, e.g. instance/quoxperticus) match too —
// a single :section param only captures one path segment.
const SETTINGS_SECTION_MAP = {
    members: 'account', integrations: 'vault', routing: 'router',
    tags: null, divisions: null, departments: null,
    security: 'account', 'api-keys': 'vault',
    plugins: 'plugins', backup: 'backup', notifications: 'notifications',
    services: 'services', privacy: 'privacy', telemetry: 'telemetry',
    voice: 'voice', files: 'files', assistants: 'assistants',
    infrastructure: 'infrastructure', docs: 'docs'
};
function SettingsRedirect() {
    const params = useParams();
    const section = params['*'];
    const mapped = SETTINGS_SECTION_MAP[section];
    // null = section has its own top-level route (e.g. /divisions, /departments, /tags)
    if (mapped === null) return <Navigate to={`/${section}`} replace />;
    return <Navigate to={`/settings#${mapped || section}`} replace />;
}

// STUDY-REV-2 P6: /workflows/:id → /workflow-builder?id=:id
// The builder already supports ?id= for loading existing workflows
// (WB-SURFACE P4) so the redirect preserves bookmarks + in-app links.
function WorkflowDetailRedirect() {
    const { id } = useParams();
    return <Navigate to={`/workflow-builder?id=${encodeURIComponent(id)}`} replace />;
}

// STUDY-REV-2 P5.A: three old sidebar routes → unified hub with ?tab=
// Query params (?id=, ?wf=, ?mode=, etc.) are preserved so deep links
// continue to work after the redirect.
function WorkflowsRedirect() {
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'mine');
    return <Navigate to={`/workflows-hub?${next.toString()}`} replace />;
}

function WorkflowBuilderRedirect() {
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'build');
    return <Navigate to={`/workflows-hub?${next.toString()}`} replace />;
}

function WorkflowLibraryRedirect() {
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'library');
    return <Navigate to={`/workflows-hub?${next.toString()}`} replace />;
}

// QN Phase 3: /nucleus/graph and /nucleus/repos collapse into RepoBrainView's
// tabs — old bookmarks/links redirect to the matching ?tab=.
function NucleusGraphRedirect() {
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'graph');
    return <Navigate to={`/nucleus?${next.toString()}`} replace />;
}

function NucleusReposRedirect() {
    const [searchParams] = useSearchParams();
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'repos');
    return <Navigate to={`/nucleus?${next.toString()}`} replace />;
}

// CLARITY-1: AEE background sync only runs for authenticated sessions. It
// previously started unconditionally from the top-level App effect below,
// which fires before AuthProvider's /me check resolves and keeps running on
// the unauthenticated /login route (AuthProvider + HealthProvider both wrap
// the router, per the tree in App()'s return). This component is rendered
// as a child of AuthProvider so it can read auth state directly via
// useAuth(). start*/stop* are idempotent no-ops (warn + return) when
// already in the requested state.
//
// TRUST-GATE-1.18f: the ReflectionLoop mining cycle (extractMemories/
// detectPatterns/generateAlerts) that used to start/stop here has moved
// server-side — collector's reflectionMiningScheduler.js runs it on an
// env-configurable interval regardless of whether a browser tab is open
// (zero-tolerance: browser timers are not background jobs). reflectionLoop.js
// had no other responsibilities and has been removed.
//
// QMH2-CONSOLIDATION: WSM/Beliefs/Failures/Style use dynamic
// quox_{org}_{user}_* local cache keys (via personalGet/personalSet), so the
// static-key hydrateIdentityFromServer() above cannot hydrate them. This
// runs them separately, AFTER setStorageContext(org, user) has been set —
// once on auth, and again on every 'quox-org-switch' so switching orgs
// hydrates the newly-selected org's blobs.
function hydrateOrgScopedIdentityFromServer() {
    hydrateWorkingSetFromServer();
    hydrateBeliefsFromServer();
    hydrateFailuresFromServer();
    hydrateStyleFromServer();
    hydratePromotionFromServer();
}

export function AuthGatedBackgroundServices() {
    const { isAuthenticated } = useAuth();

    useEffect(() => {
        if (!isAuthenticated) return undefined;

        // CLARITY-4: identity/alert hydration only runs for authenticated
        // sessions. Fires once per auth transition — covers both a fresh
        // login and an already-authenticated page load (this effect also
        // runs on mount when isAuthenticated is already true).
        getMemoryManager().hydrateIdentityFromServer();
        hydrateAlertsFromServer();
        hydrateOrgScopedIdentityFromServer();

        window.addEventListener('quox-org-switch', hydrateOrgScopedIdentityFromServer);

        startBackgroundSync(30000);

        return () => {
            window.removeEventListener('quox-org-switch', hydrateOrgScopedIdentityFromServer);
            stopBackgroundSync();
        };
    }, [isAuthenticated]);

    return null;
}

// Catch-all redirect. Third-party plugin routes (namespaced under /plugins/*)
// register asynchronously on boot via loadInstalledPlugins(), which resolves
// AFTER React's first render. On a hard refresh of a /plugins/* URL the route
// isn't in the table yet, so this catch-all would fire and rewrite the URL to
// home — the "refresh always lands on Command Centre" bug. While plugin
// hydration is still in flight we hold a /plugins/* path on a lightweight
// loader instead of redirecting; once hydration settles the route either
// matches (renders the plugin) or falls through to the home redirect (genuine
// 404). Non-plugin paths redirect immediately, exactly as before.
function CatchAllRedirect({ pluginsHydrated }) {
    const location = useLocation();
    if (!pluginsHydrated && location.pathname.startsWith('/plugins/')) {
        return (
            <div style={ROUTE_FALLBACK_STYLE}>
                Loading plugin...
            </div>
        );
    }
    // CW quick-win B8: unregistered routes used to silently redirect to
    // Command Center, which made an undeployed route (e.g. before a stream
    // shipped it) look like a working page. Show a real 404 instead.
    return (
        <Suspense fallback={null}>
            <NotFoundView />
        </Suspense>
    );
}

function App({ onReady }) {
    // Re-render when third-party plugins register/unregister routes
    const [pluginRoutes, setPluginRoutes] = useState(() => getPluginRoutes());
    useEffect(() => {
        const handler = () => setPluginRoutes(getPluginRoutes());
        window.addEventListener('quox-plugin-route-change', handler);
        return () => window.removeEventListener('quox-plugin-route-change', handler);
    }, []);

    // Track boot-time third-party plugin hydration so the catch-all doesn't
    // bounce /plugins/* URLs to home before their routes finish registering.
    const [pluginsHydrated, setPluginsHydrated] = useState(() => arePluginsHydrated());
    useEffect(() => {
        if (pluginsHydrated) return undefined;
        if (arePluginsHydrated()) { setPluginsHydrated(true); return undefined; }
        const handler = () => setPluginsHydrated(true);
        window.addEventListener('quox-plugins-loaded', handler);
        return () => window.removeEventListener('quox-plugins-loaded', handler);
    }, [pluginsHydrated]);

    // LL-7: mount a locked stub for every premium path no live route owns.
    // Recomputed with pluginRoutes so an activation removes its stub in the
    // same render that adds the real route (no gap, no double match).
    const premiumStubRoutes = useMemo(
        () => selectPremiumStubRoutes(new Set([...CORE_ROUTES, ...pluginRoutes].map(r => r.path))),
        [pluginRoutes],
    );

    useEffect(() => {
        const path = window.location.pathname;
        if (path === '/topology' || path === '/quoxcore') {
            preloadCognitiveData();
        }
        // CLARITY-1: AEE background sync moved to <AuthGatedBackgroundServices>,
        // rendered inside AuthProvider below, so it only starts once a
        // session is authenticated.

        // Initialize cookie consent service (Security Issue #74)
        initCookieConsent()

        // Initialize file storage (server sync, orphan recovery)
        initFileStorage().then(result => {
            if (!result.serverAvailable) {
                console.warn('[App] File server not available - files stored in browser only')
            }
        }).catch(err => {
            console.error('[App] File storage init failed:', err)
        })

        // Initialize VOLT audit trail (opt-in via settings)
        // Initialize server sync queue (retries pending changes from previous sessions)
        initSyncQueue()

        try {
            const saved = JSON.parse(localStorage.getItem('quox-settings') || '{}')
            if (saved.voltEnabled) {
                const startVolt = () => {
                    initVoltStore().then(() => {
                        voltBridge.enable()
                        if (saved.voltContentCapture) {
                            voltBridge.enableContentCapture()
                        }
                        startVoltBackgroundSync()
                    }).catch(err => {
                        console.warn('[App] VOLT store init failed, retrying in 3s:', err.message)
                        setTimeout(startVolt, 3000)
                    })
                }
                startVolt()
            }
        } catch (_) { /* settings parse failure — VOLT stays disabled */ }

        // Signal that React is ready - hides boot loader
        if (onReady) onReady()

        return () => {
            voltBridge.disable()
            closeVoltDB()
        }
    }, [onReady])

    return (
        <AuthProvider>
            <AuthGatedBackgroundServices />
            <WorkspaceProvider>
                <HealthProvider>
                <SafetyProvider>
                    <BrowserRouter>
                        {/* Cookie Consent Banner - GDPR Compliance (Security Issue #74) */}
                        <CookieConsentBanner />

                        <Routes>
                            {/* ============================================
                                UNIFIED APP SHELL ROUTES
                                All main application routes use AppShell
                                for consistent sidebar and header navigation.
                            ============================================ */}
                            <Route element={<AppShell />}>
                                {/* ====== Routes from route registry (core + third-party plugins) ====== */}
                                {[...CORE_ROUTES, ...pluginRoutes].map(r => {
                                    // Core routes: element is a component function, render as JSX
                                    // Third-party: wrap in PluginSandbox (ErrorBoundary + API context)
                                    let el;
                                    if (r._thirdParty) {
                                        const PluginComponent = r.element;
                                        el = (
                                            <Suspense fallback={<div style={ROUTE_FALLBACK_STYLE}>Loading plugin...</div>}>
                                                <PluginSandbox pluginId={r.pluginId} onDisable={() => deactivateThirdPartyPlugin(r.pluginId)}>
                                                    {typeof PluginComponent === 'function' ? <PluginComponent /> : PluginComponent}
                                                </PluginSandbox>
                                            </Suspense>
                                        );
                                    } else {
                                        // Core route: element is a component reference, instantiate it
                                        const CoreComponent = r.element;
                                        el = renderRouteElement(CoreComponent);
                                    }
                                    // AUD-WS-2: wrap with ProtectedRoute when minRole OR auditorAllowed
                                    // (so auditor routes like /compliance without minRole still go
                                    // through the role-aware guard when auditorAllowed is set).
                                    const needsGuard = r.minRole || r.auditorAllowed;
                                    return (
                                        <Route
                                            key={r.path}
                                            path={r.path}
                                            element={needsGuard
                                                ? <ProtectedRoute minRole={r.minRole} auditorAllowed={r.auditorAllowed}>{el}</ProtectedRoute>
                                                : el}
                                        />
                                    );
                                })}

                                {/* ====== LL-7 premium route stubs ======
                                    A route whose view now lives in a signed plugin bundle keeps
                                    a locked stub here so the path never falls through to the 404
                                    catch-all. selectPremiumStubRoutes drops any stub the real
                                    route already claims, so activation wins with no ordering
                                    subtlety; PremiumRouteStub holds a loading state until plugin
                                    hydration settles so an entitled user never sees a flash of
                                    the upsell. Role guards mirror the core row that was stripped. */}
                                {premiumStubRoutes.map(stub => {
                                    const el = <PremiumRouteStub stub={stub} pluginsHydrated={pluginsHydrated} />;
                                    return (
                                        <Route
                                            key={stub.path}
                                            path={stub.path}
                                            element={(stub.minRole || stub.auditorAllowed)
                                                ? <ProtectedRoute minRole={stub.minRole} auditorAllowed={stub.auditorAllowed}>{el}</ProtectedRoute>
                                                : el}
                                        />
                                    );
                                })}

                                {/* Settings deep-link redirect (not part of registry). Splat so
                                    multi-segment canonical ids (e.g. instance/quoxperticus) match,
                                    not just single-segment legacy hashes (e.g. members). */}
                                <Route path="/settings/*" element={<SettingsRedirect />} />

                                {/* Legacy redirects */}
                                {/* Category Landing Pages */}
                                <Route path="/category/:sectionId" element={<CategoryLandingView />} />

                                <Route path="/skills" element={<SkillsView />} />
                                <Route path="/skills/review" element={<SkillReviewQueueView />} />
                                <Route path="/directory" element={<Navigate to="/orgs" replace />} />
                                <Route path="/backup" element={<Navigate to="/system?tab=backups" replace />} />
                                {/* ACAT-6: /schedules → /triggers?tab=schedules (canonical surface) */}
                                <Route path="/schedules" element={<Navigate to="/triggers?tab=schedules" replace />} />
                                {/* STUDY-REV-2 P5.A: three sidebar entries collapse into one hub */}
                                <Route path="/workflows" element={<WorkflowsRedirect />} />
                                <Route path="/workflow-builder" element={<WorkflowBuilderRedirect />} />
                                <Route path="/workflow-library" element={<WorkflowLibraryRedirect />} />
                                <Route path="/workflows/builder" element={<Navigate to="/workflows-hub?tab=build" replace />} />
                                {/* STUDY-REV-2 P6: workflow detail folds into the builder. The
                                    builder already accepts ?id= for view/edit; the redirect
                                    preserves bookmarks + every "open in detail" link in the app. */}
                                <Route path="/workflows/:id" element={<WorkflowDetailRedirect />} />
                                {/* QN Phase 3: unified RepoBrain surface — old split routes redirect to ?tab= */}
                                <Route path="/nucleus/graph" element={<NucleusGraphRedirect />} />
                                <Route path="/nucleus/repos" element={<NucleusReposRedirect />} />
                            </Route>

                            {/* ============================================
                                STANDALONE ROUTES (No AppShell)
                            ============================================ */}

                            {/* Glass Concept Demo */}
                            <Route path="/glass-concept" element={<GlassConceptView />} />

                            {/* QX Lab — design-system prototype pages */}
                            {/* #544: /qx-lab (incl. the application view, which renders infra-shaped
                                composition) mounted outside any auth guard and served to anonymous
                                visitors. Guard the whole subtree admin-only, like every other internal view. */}
                            <Route path="/qx-lab" element={<ProtectedRoute minRole="admin"><QxLabLayout /></ProtectedRoute>}>
                                <Route index element={<QxLabComponentsView />} />
                                <Route path="components"  element={<QxLabComponentsView />} />
                                <Route path="application" element={<QxLabApplicationView />} />
                                <Route path="edge-cases"  element={<QxLabEdgeCasesView />} />
                                <Route path="store"       element={<QxLabStoreView />} />
                            </Route>

                            {/* Category Landing Pages — kept standalone, see below */}

                            {/* Files-Q Mockup (design review) */}
                            <Route path="/files-q-mockup" element={<FilesQMockup />} />
                            <Route path="/files-q-gallery" element={<FilesQComponentGallery />} />

                            {/* QN Phase 3: Codebase Graph moved into RepoBrainView (/nucleus?tab=graph),
                                registered inside AppShell above. See NucleusGraphRedirect. */}

                            {/* OpsDeck3D Prototype Lab (lazy — R3F) */}
                            <Route path="/3d-lab" element={<Suspense fallback={null}><ThreeDLabView /></Suspense>} />

                            {/* Quoxel public VOX share page — unauthenticated, no AppShell.
                                What an external recipient (delivery driver, visitor) sees when
                                a share link is opened. Reads only the public read surface. */}
                            <Route path="/w/:code" element={<Suspense fallback={null}><PublicWaypointView /></Suspense>} />

                            {/* Cognitive Core 3D — LICENSE-LAUNCH LL-7 strip (2026-08-30).
                                The /cogcore3d route is deliberately GONE from this
                                STANDALONE block. It now comes from the signed cogcore3d
                                bundle, which registers plugin routes inside the AppShell
                                block above; unlicensed orgs get the locked
                                PremiumRouteStub mounted there instead
                                (src/config/premiumRouteStubs.js already carries the copy).
                                Both mount points sit inside the app-level <AuthProvider>
                                at the top of this tree, so the useAuth dependency that
                                justified the inline AuthProvider here is still satisfied,
                                and the view still fills the viewport because its own root
                                is `position: fixed; inset: 0`. */}

                            {/* Login Page */}
                            <Route path="/login" element={<LoginPage />} />
                            {/* #321 / #322-FE — MFA flows (no auth shell) */}
                            <Route path="/mfa/enroll" element={<Suspense fallback={null}><MfaEnrollView /></Suspense>} />
                            <Route path="/mfa/challenge" element={<Suspense fallback={null}><MfaChallengeView /></Suspense>} />

                            {/* ET-6D.3 — guest invite accept + landing */}
                            <Route path="/invite/guest/:token" element={
                                <AuthProvider>
                                    <Suspense fallback={null}><GuestInvitePage /></Suspense>
                                </AuthProvider>
                            } />
                            <Route path="/guest" element={
                                <AuthProvider>
                                    <Suspense fallback={null}><GuestLandingView /></Suspense>
                                </AuthProvider>
                            } />

                            {/* Setup Wizard (first-run configuration) */}
                            <Route path="/setup" element={<SetupWizard />} />

                            {/* Plugin Store - redirects to quox.ai */}
                            <Route path="/store" element={<ExternalRedirect to="https://quox.ai/store" />} />

                            {/* Visualizer Popup (opens in new window) */}
                            <Route path="/visualizer-popup" element={<VisualizerPopup />} />

                            {/* Topology Popup (brain galaxy in new window) */}
                            <Route path="/visualizer/topology" element={<TopologyPopup />} />

                            {/* NOC Popout (multi-monitor NOC window) */}
                            <Route path="/noc/popout" element={<NOCPopout />} />

                            {/* QuoxCore - Full-screen cognitive visualizer */}
                            <Route path="/quoxcore" element={<QuoxCore />} />

                            {/* ============================================
                                WEBSITE REDIRECTS
                                All website content now served from quox.ai
                            ============================================ */}
                            <Route path="/landing" element={<ExternalRedirect to="https://quox.ai/" />} />
                            <Route path="/compliance-suite" element={<ExternalRedirect to="https://quox.ai/compliance-suite" />} />
                            <Route path="/developer-kit" element={<ExternalRedirect to="https://quox.ai/developer-kit" />} />
                            <Route path="/pricing" element={<ExternalRedirect to="https://quox.ai/pricing" />} />

                            {/* ============================================
                                DOCUMENTATION REDIRECT
                                All docs now served from quox.ai
                                Exception: /docs/crystals is an in-app page
                                (must appear BEFORE the catch-all below)
                            ============================================ */}
                            <Route path="/docs/crystals" element={<CrystalsPage />} />
                            <Route path="/docs/*" element={<ExternalRedirect to="https://quox.ai/docs" />} />

                            {/* ============================================
                                ADMIN ROUTES — RETIRED in SET-IA Phase 7.
                                Every /admin/* path now redirects into the
                                unified /settings tree (or /observability for
                                the runtime telemetry surfaces). AdminLayout +
                                AdminConfig deleted; bookmarks survive forever
                                via these aliases.
                            ============================================ */}
                            <Route path="/admin"          element={<Navigate to="/settings" replace />} />
                            <Route path="/admin/config"   element={<Navigate to="/settings#instance/auth" replace />} />
                            <Route path="/admin/keys"     element={<Navigate to="/settings#instance/provider-keys" replace />} />
                            <Route path="/admin/admins"   element={<Navigate to="/settings#instance/admins" replace />} />
                            <Route path="/admin/services" element={<Navigate to="/observability/health" replace />} />
                            <Route path="/admin/logs"     element={<Navigate to="/observability/logs" replace />} />
                            <Route path="/admin/feedback" element={<Navigate to="/observability/feedback" replace />} />
                            <Route path="/admin/errors"   element={<Navigate to="/observability/errors" replace />} />

                            {/* ============================================
                                OBSERVABILITY ROUTES — SET-IA Phase 2
                                Runtime telemetry: logs, errors, feedback,
                                health, instance overview, audit trail.
                            ============================================ */}
                            <Route path="/observability" element={
                                <ProtectedRoute minRole="admin">
                                    <ObservabilityLayout />
                                </ProtectedRoute>
                            }>
                                <Route index            element={<ObsOverview />} />
                                <Route path="health"    element={<ObsHealth />} />
                                <Route path="logs"      element={<ObsLogs />} />
                                <Route path="errors"    element={<ObsErrorReports />} />
                                <Route path="feedback"  element={<ObsFeedback />} />
                                <Route path="audit"     element={<ObsAuditTrail />} />
                            </Route>

                            {/* ============================================
                                LEGACY WORKSPACE ROUTES
                                Deprecated - redirects to new unified routes
                            ============================================ */}
                            <Route path="/workspace" element={<Navigate to="/" replace />} />
                            <Route path="/workspace/tools" element={<Navigate to="/tools" replace />} />
                            <Route path="/workspace/workflows" element={<Navigate to="/workflows-hub" replace />} />
                            <Route path="/workspace/assistants" element={<Navigate to="/assistants" replace />} />
                            <Route path="/workspace/settings" element={<Navigate to="/settings" replace />} />
                            <Route path="/workspace/*" element={<Navigate to="/" replace />} />

                            {/* ============================================
                                CATCH-ALL REDIRECT
                            ============================================ */}
                            <Route path="*" element={<CatchAllRedirect pluginsHydrated={pluginsHydrated} />} />
                        </Routes>
                    </BrowserRouter>
                </SafetyProvider>
                </HealthProvider>
            </WorkspaceProvider>
        </AuthProvider>
    )
}

export default App

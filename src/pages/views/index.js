/**
 * Views Index
 * Exports all view components for the unified app shell
 */

export { default as HomeView } from './HomeView';
export { default as DashboardView } from './DashboardView';
export { default as NOCView } from './NOCView';
export { default as SOCView } from './SOCView';
export { default as InfraView } from './InfraView';
export { default as AgentsView } from './AgentsView';
export { default as MemoryView } from './MemoryView';
export { default as ActivityView } from './ActivityViewPage';
// LICENSE-LAUNCH LL-7 increment 3h: FilesView is stripped into the signed files
// bundle (plugins-src/files/). Re-exporting it here would re-arm the free-build
// edge the strip deletes. Do not re-add it.
export { default as ToolsView } from './ToolsView';
export { default as WorkflowsView } from './WorkflowsView';
export { default as WorkflowBuilderView } from './WorkflowBuilderView';
export { default as AssistantsView } from './AssistantsView';
export { default as OrgView } from './OrgView';
export { default as OrgsView } from './OrgsView';
export { default as OrgManagementView } from './OrgManagementView';
export { default as AuditLogView } from './AuditLogView';
export { default as DivisionsView } from './DivisionsView';
export { default as DivisionManagementView } from './DivisionManagementView';
export { default as TeamsView } from './TeamsView';
export { default as TeamManagementView } from './TeamManagementView';
export { default as DepartmentsView } from './DepartmentsView';
export { default as DepartmentManagementView } from './DepartmentManagementView';
export { default as TagsView } from './TagsView';
export { default as SettingsView } from './SettingsView';
export { default as PluginsView } from './PluginsView';
export { default as InboxView } from './InboxView';
export { default as InboxItemDetailView } from './InboxItemDetailView';
export { default as WorkflowLibraryView } from './WorkflowLibraryView';
// LICENSE-LAUNCH LL-7 increment 3a: PromptsLibraryView is stripped into the
// signed prompts-library bundle (plugins-src/prompts-library/). Re-exporting it
// here would re-arm the free-build edge the strip deletes. Do not re-add it.
export { default as CognitiveTopologyView } from './CognitiveTopologyView';
export { default as ArchivistView } from './ArchivistView';
export { default as DiagnosticsView } from './DiagnosticsView'
export { default as ComplianceView } from './ComplianceView';
export { default as PlaygroundView } from './PlaygroundView';
export { default as LayerPluginsView } from './LayerPluginsView';
export { default as AgentFamilyTreeView } from './AgentFamilyTreeView';
export { default as AgentDetailView } from './AgentDetailView';
export { default as AgentStreamPage } from './AgentStreamPage';
export { default as TestLabView } from './TestLabView';
// LICENSE-LAUNCH LL-7 increment 3a: SystemMaintenanceView is stripped into the
// signed system-maintenance bundle (plugins-src/system-maintenance/).
// Re-exporting it here would re-arm the free-build edge the strip deletes.

// LICENSE-LAUNCH LL-7 increment 3e: BastionView is stripped into the signed
// bastion-fleet bundle (plugins-src/bastion-fleet/). Re-exporting it here would
// re-arm the free-build edge the strip deletes. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3h: TailscaleView is stripped into the signed
// tailscale bundle (plugins-src/tailscale/). Re-exporting it here would re-arm the
// free-build edge the strip deletes. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3h: RouterOSView is stripped into the signed
// mikrotik-routeros bundle (plugins-src/mikrotik-routeros/). Re-exporting it here
// would re-arm the free-build edge the strip deletes. Do not re-add it.
export { default as ExecutionDetailView } from './ExecutionDetailView';
export { default as PoliciesView } from './PoliciesView';
export { default as EvidenceView } from './EvidenceView';
// LICENSE-LAUNCH LL-7 increment 3e: TerminalView is stripped into the signed
// web-terminal bundle (plugins-src/web-terminal/). Re-exporting it here would
// re-arm the free-build edge the strip deletes. Do not re-add it. TerminalPromo
// and SnapshotViewer stay in core (/terminal/about, /terminal/share).
export { default as TerminalPromo } from './TerminalPromo';
export { default as SnapshotViewer } from './SnapshotViewer';
export { default as QuoxCLIView } from './QuoxCLIView';
export { default as VoltView } from './VoltView';
export { default as WardView } from './WardView';
export { default as HonestyLedgerView } from './HonestyLedgerView';
export { default as ObjectivesView } from './ObjectivesView';
// LICENSE-LAUNCH LL-7 increment 3f: CommsView's barrel re-export is deliberately
// GONE. It ships only in the signed core-comms bundle (plugins-src/core-comms/);
// re-exporting it here would drag the stripped view back into the free build.
export { default as TeamsOverviewView } from './TeamsOverviewView';
export { default as AgenticTeamView } from './AgenticTeamView';
// LICENSE-LAUNCH LL-7 extraction 1: ActionsView is stripped into the signed
// action-tracker bundle (plugins-src/action-tracker/). Re-exporting it here
// would re-arm the free-build edge the strip deletes. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3c: BrowserQView + BrowserQRunDetailView are
// stripped into the signed browser-q bundle (plugins-src/browser-q/).
// Re-exporting them here would re-arm the free-build edges the strip deletes.
// Do not re-add them.
export { default as ImageGalleryView } from './ImageGalleryView';
export { default as VaultBrowseView } from './VaultBrowseView';
export { default as VaultDashboardView } from './VaultDashboardView';
export { default as VaultCredentialsView } from './VaultCredentialsView';
export { default as VaultFoldersView } from './VaultFoldersView';
export { default as VaultLeasesView } from './VaultLeasesView';
export { default as VaultActivityView } from './VaultActivityView';
// LICENSE-LAUNCH LL-7 increment 3c: CodebaseMirrorView is stripped into the
// signed codebase-mirror bundle (plugins-src/codebase-mirror/). Re-exporting it
// here would re-arm the free-build edge the strip deletes. Do not re-add it.
export { default as OpsDeckView } from './OpsDeckView';
export { default as MissionControlView } from './MissionControlView';
export { default as FeedbackView } from './FeedbackView';
export { default as CertificationView } from './CertificationView';
// LICENSE-LAUNCH LL-7 increment 3f: WazuhView's barrel re-export is deliberately
// GONE. It ships only in the signed wazuh bundle (plugins-src/wazuh/);
// re-exporting it here would drag the stripped view back into the free build.
// LICENSE-LAUNCH LL-7 increment 3b: GitHubView is stripped into the signed
// github bundle (plugins-src/github/). Re-exporting it here would re-arm the
// free-build edge the strip deletes. Do not re-add it.
// LICENSE-LAUNCH LL-7 extraction 4: GrafanaView, PrometheusView,
// UptimeKumaView and ProxmoxView are stripped into their signed bundles
// (plugins-src/grafana/, prometheus/, uptime-kuma/, proxmox/). Re-exporting any
// of them here would re-arm the free-build edge the strip deletes, and would
// also drag the quad-exclusive src/components/monitoring/ subtree back in. Do
// not re-add them.
// LICENSE-LAUNCH LL-7 increment 3c: DockerView is stripped into the signed
// docker-fleet bundle (plugins-src/docker-fleet/). Re-exporting it here would
// re-arm the free-build edge the strip deletes. Do not re-add it.
// LICENSE-LAUNCH LL-7 increment 3d: LinkedInView and YouTubeView are stripped
// into the signed linkedin and youtube bundles (plugins-src/linkedin/,
// plugins-src/youtube/). Re-exporting them here would re-arm the free-build edge
// the strip deletes. Do not re-add them.
// FB-3: FacebookView is stripped into the signed facebook bundle
// (plugins-src/facebook/), same shape as LinkedInView above. Re-exporting it
// here would re-arm the free-build edge the strip deletes. Do not re-add it.
// IG-3: InstagramView is stripped into the signed instagram bundle
// (plugins-src/instagram/), same shape as FacebookView above. Re-exporting it
// here would re-arm the free-build edge the strip deletes. Do not re-add it.
// TT-4: TikTokView is stripped into the signed tiktok bundle
// (plugins-src/tiktok/), same shape as InstagramView above. Re-exporting it
// here would re-arm the free-build edge the strip deletes. Do not re-add it.
// CognitiveCore3DView: NOT barrel-exported — R3F hooks crash if eagerly evaluated outside <Canvas>
// Imported directly in App.jsx instead
// Marketplace (Stream 2: Developer Portal)
export { default as SellerRegistrationView } from './marketplace/SellerRegistration';
export { default as SellerDashboardView } from './marketplace/SellerDashboard';
export { default as SubmitListingView } from './marketplace/SubmitListing';
export { default as ManageListingView } from './marketplace/ManageListing';
export { default as MarketplaceBrowseView } from './marketplace/MarketplaceBrowseView';
export { default as MarketplaceDetailView } from './marketplace/MarketplaceDetailView';

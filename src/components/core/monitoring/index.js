/**
 * Monitoring — core module (LICENSE-LAUNCH LL-7 extraction 4).
 *
 * Moved from src/components/monitoring/ so the five CORE consumers
 * (NOCView, SOCView, InfraView, DashboardView, NOCPopout) do not import
 * anything from a stripped plugin bundle when proxmox / prometheus /
 * grafana / uptime-kuma leave the free build.
 *
 * What STAYED in src/components/monitoring/ is quad-exclusive (ProxmoxTable,
 * ProxmoxTopology, ProxmoxActions, ProxmoxChatSidebar, ProxmoxContextMenu,
 * ProxmoxNodes, ProxmoxBackups, ProxmoxAlertConfig, MonitoringSetup,
 * useResourceHistory, and the Prometheus-only panels) and ships with those
 * plugin bundles.
 *
 * The files here moved VERBATIM (git mv): the only edits inside them are
 * relative-import depths. useProxmoxData's useEffect/setInterval/mountedRef
 * shape is byte-for-byte what it was, because a dropped interval is the
 * "renders fine, never updates" failure this extraction exists to avoid.
 */

export { ProxmoxPanel } from './ProxmoxPanel'
export { MetricsPanel } from './MetricsPanel'
export { UptimePanel } from './UptimePanel'
export { ServiceDetailModal } from './ServiceDetailModal'
export { RestartButton } from './RestartButton'
export { useProxmoxData, timeAgo, getStatusColor } from './useProxmoxData'
export { default as AgentFleetPanel } from './AgentFleetPanel'
export { default as GPUFleetPanel } from './GPUFleetPanel'
export { GrafanaEmbed } from './GrafanaEmbed'
export { GrafanaAlertBadge } from './GrafanaAlertBadge'
export { NOCChatSidebar } from './NOCChatSidebar'
export { SOCChatSidebar } from './SOCChatSidebar'
export { InfraChatSidebar } from './InfraChatSidebar'
export { InfraActionsSidebar } from './InfraActionsSidebar'
export { default as LiveEventStream } from './LiveEventStream'
export { default as PlaybooksPanel } from './PlaybooksPanel'
export { default as JobsPanel } from './JobsPanel'
export { ToolOutcomesPanel } from './ToolOutcomesPanel'

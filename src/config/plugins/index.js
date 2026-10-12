/**
 * Plugin Registry
 *
 * Exports plugin manifests for all available Quox plugins.
 * These manifests define features, pricing, and tier limits.
 */

import advancedMemory from './advanced-memory.json'
import advancedVoice from './advanced-voice.json'
import files from './files.json'
import uptimeKuma from './uptime-kuma.json'
import grafana from './grafana.json'
import prometheus from './prometheus.json'
import proxmox from './proxmox.json'
import quoxagentFleet from './quoxagent-fleet.json'
import cognitiveTopology from './cognitive-topology.json'
import aoclComplianceSuite from './aocl-compliance-suite.json'
import aoclDeveloperKit from './aocl-developer-kit.json'
import quoxtrade from './quoxtrade.json'
import backupRestore from './backup-restore.json'
import systemMaintenance from './system-maintenance.json'
import bastionFleet from './bastion-fleet.json'
import coreComms from './core-comms.json'
import telegramPro from './telegram-pro.json'
import promptsLibrary from './prompts-library.json'
import mikrotik from './mikrotik.json'
import workflowLibrary from './workflow-library.json'
import webTerminal from './web-terminal.json'
import actionTracker from './action-tracker.json'
import codebaseMirror from './codebase-mirror.json'
import opsdeck from './opsdeck.json'
import wazuh from './wazuh.json'
import dockerFleet from './docker-fleet.json'
import decisionEvidence from './decision-evidence.json'
import localInference from './local-inference.json'
import linkedin from './linkedin.json'
import facebook from './facebook.json'
import instagram from './instagram.json'
import tiktok from './tiktok.json'
import x from './x.json'
import github from './github.json'
import developerTools from './developer-tools.json'
import tailscale from './tailscale.json'
import visualizations from './visualizations.json'
import youtube from './youtube.json'
import browserQ from './browser-q.json'
import cogcore3d from './cogcore3d.json'
import quoxmindPro from './quoxmind-pro.json'
import quoxmindComplete from './quoxmind-complete.json'
import quoxNucleus from './quox-nucleus.json'
import quoxplan from './quoxplan.json'
import quoxSecurity from './quox-security.json'
import qlarity from './qlarity.json'
import quoxchat from './quoxchat.json'
import quoxboxMacmini from './quoxbox-macmini.json'
import quoxQortex from './quox-brain2.json'
import comms from './comms.json'
import quoxsignal from './quoxsignal.json'
import inboxq from './inboxq.json'
// AQ-9B: Calendar-Q, the second AssistantQ family member after InboxQ.
import calendarQ from './calendar-q.json'
import notesq from './notesq.json'
import contactsq from './contactsq.json'
import quoxVoice from './quox-voice.json'
import quoxseo from './quoxseo.json'
import discordPro from './discord-pro.json'
import quoxlens from './quoxlens.json'
import chiefTeamSmall from './chief-team-small.json'
import chiefTeamMedium from './chief-team-medium.json'
import chiefTeamEnterprise from './chief-team-enterprise.json'
// SLUG FIX 2026-08-18: this manifest was keyed 'quox-dev-servers' while the
// licensing axis (pluginCatalog.js + entitlements.js) both say 'dev-servers'.
// They can never agree, so a customer entitled to the hub never had it enabled.
// The add-product rule is one id everywhere; licensing wins because it is the
// side that fails SILENTLY.
import devServers from './dev-servers.json'
// DEVSUITE phase 9: the bundle members that were sellable (in the catalogue and
// entitlements) but had NO dashboard manifest, so buying them enabled nothing.
import qloop from './qloop.json'
import quoxslots from './quoxslots.json'
import quoxbuild from './quoxbuild.json'
import gripe from './gripe.json'

/**
 * All available plugins
 */
export const PLUGINS = {
  'quoxtrade': quoxtrade,
  'prompts-library': promptsLibrary,
  'core-comms': coreComms,
  'telegram-pro': telegramPro,
  'advanced-memory': advancedMemory,
  'advanced-voice': advancedVoice,
  'files': files,
  'uptime-kuma': uptimeKuma,
  'grafana': grafana,
  'prometheus': prometheus,
  'proxmox': proxmox,
  'quoxagent-fleet': quoxagentFleet,
  'bastion-fleet': bastionFleet,
  'cognitive-topology': cognitiveTopology,
  'aocl-compliance-suite': aoclComplianceSuite,
  'aocl-developer-kit': aoclDeveloperKit,
  'backup-restore': backupRestore,
  'system-maintenance': systemMaintenance,
  'mikrotik-routeros': mikrotik,
  'workflow-library': workflowLibrary,
  'web-terminal': webTerminal,
  'action-tracker': actionTracker,
  'codebase-mirror': codebaseMirror,
  'opsdeck': opsdeck,
  'wazuh': wazuh,
  'docker-fleet': dockerFleet,
  'decision-evidence': decisionEvidence,
  'local-inference': localInference,
  'linkedin': linkedin,
  'facebook': facebook,
  'instagram': instagram,
  'tiktok': tiktok,
  'x': x,
  'github': github,
  'developer-tools': developerTools,
  'tailscale': tailscale,
  'visualizations': visualizations,
  'youtube': youtube,
  'browser-q': browserQ,
  'cogcore3d': cogcore3d,
  'quoxmind-pro': quoxmindPro,
  'quoxmind-complete': quoxmindComplete,
  'quox-nucleus': quoxNucleus,
  'quoxplan': quoxplan,
  'quox-security': quoxSecurity,
  'qlarity': qlarity,
  'quoxchat': quoxchat,
  'quoxbox-macmini': quoxboxMacmini,
  'quox-brain2': quoxQortex,
  'comms': comms,
  'quoxsignal': quoxsignal,
  'inboxq': inboxq,
  'calendar-q': calendarQ,
  'notesq': notesq,
  'contactsq': contactsq,
  'quox-voice': quoxVoice,
  'quoxseo': quoxseo,
  'discord-pro': discordPro,
  'quoxlens': quoxlens,
  'chief-team-small': chiefTeamSmall,
  'chief-team-medium': chiefTeamMedium,
  'chief-team-enterprise': chiefTeamEnterprise,
  'dev-servers': devServers,
  qloop,
  quoxslots,
  quoxbuild,
  gripe
}

/**
 * AOCL Plugin names for easy reference
 */
export const AOCL_PLUGINS = {
  COMPLIANCE_SUITE: 'aocl-compliance-suite',
  DEVELOPER_KIT: 'aocl-developer-kit'
}

/**
 * Get plugin by name
 */
export function getPluginManifest(name) {
  return PLUGINS[name] || null
}

/**
 * Get all plugin manifests
 */
export function getAllPluginManifests() {
  return Object.values(PLUGINS)
}

/**
 * Get features for a plugin
 */
export function getPluginFeatures(name) {
  const plugin = PLUGINS[name]
  return plugin?.features || {}
}

/**
 * Get limits for a tier from a plugin
 */
export function getPluginLimits(name, tier = 'free') {
  const plugin = PLUGINS[name]
  return plugin?.limits?.[tier] || plugin?.limits?.free || {}
}

export default {
  PLUGINS,
  getPluginManifest,
  getAllPluginManifests,
  getPluginFeatures,
  getPluginLimits
}

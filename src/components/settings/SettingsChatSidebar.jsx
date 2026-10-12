/**
 * SettingsChatSidebar — REGULA agent chat for the Settings surface.
 *
 * Thin wrapper around AgentChatSidebar.
 * Agents: REGULA (default, configuration warden), QUOX (general).
 */

import { useState, useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import { getSettingsBySection } from '../../config/settingsRegistry'
import '../activity/activity-chat.css'

const SETTINGS_AGENTS = [
  { id: 'regula', name: 'REGULA', role: 'Configuration Warden', color: '#38bdf8' },
  { id: 'quox', name: 'CommanderQ', role: 'General', color: '#a78bfa' },
]

const SECTION_LABELS = {
  general: 'General',
  appearance: 'Appearance',
  voice: 'Voice',
  files: 'Files',
  assistants: 'Assistants',
  'execution-policy': 'Execution Policy',
  quoxmind: 'QuoxMind',
  'smart-router': 'Smart Router',
  'local-inference': 'Local Inference',
  plugins: 'Plugins',
  backup: 'Backup',
  notifications: 'Notifications',
  services: 'Services',
  infrastructure: 'Infrastructure',
  vault: 'Integrations Vault',
  account: 'Account',
  privacy: 'Privacy',
  telemetry: 'Telemetry',
  license: 'License',
}

const SECTION_SUGGESTIONS = {
  general: [
    'Walk me through my current settings',
    'Recommend settings for a small team',
    'What does Advanced Mode do?',
  ],
  appearance: [
    'Explain the background modes',
    'What theme options are available?',
    'How do I enable animated backgrounds?',
  ],
  voice: [
    'Which voices are configured per agent?',
    'What does verbosity control?',
    'How do I change REGULA\'s voice?',
  ],
  plugins: [
    'What plugins are active and what do they do?',
    'What happens if I disable VOLT?',
    'Which plugins require a licence?',
  ],
  backup: [
    'How healthy is my backup schedule?',
    'When was my last successful backup?',
    'What\'s my retention policy?',
  ],
  license: [
    'When does my licence expire?',
    'What features are in my tier?',
    'How do I activate a trial?',
  ],
  vault: [
    'Is my vault secure? (read-only check)',
    'Which integrations are connected?',
    'Test my credentials',
  ],
  privacy: [
    'What data do we retain?',
    'Explain the cookie policy',
    'What settings affect compliance?',
  ],
  telemetry: [
    'What telemetry am I sending?',
    'How do I opt out of telemetry?',
    'Is diagnostic data anonymised?',
  ],
}

const DEFAULT_SUGGESTIONS = [
  'Walk me through my current settings',
  'What settings affect compliance?',
  'Recommend settings for a small team',
  'What happens if I disable VOLT?',
  'When does my licence expire?',
]

export function SettingsChatSidebar({
  currentSection,
  settingsSnapshot,
  pluginCount,
  activePluginCount,
  licenseStatus,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState('regula')

  const agent = SETTINGS_AGENTS.find(a => a.id === selectedAgentId) || SETTINGS_AGENTS[0]
  const sectionLabel = SECTION_LABELS[currentSection] || 'Settings'

  const buildContext = useCallback(async () => {
    const summary = [
      { label: 'Current section', value: sectionLabel },
      { label: 'Agent lane', value: agent.name },
    ]

    if (typeof pluginCount === 'number') {
      summary.push({ label: 'Plugins installed', value: pluginCount })
    }
    if (typeof activePluginCount === 'number') {
      summary.push({ label: 'Plugins active', value: activePluginCount })
    }
    if (licenseStatus) {
      if (licenseStatus.tier) summary.push({ label: 'Licence tier', value: licenseStatus.tier })
      if (licenseStatus.daysRemaining != null) {
        summary.push({ label: 'Licence days remaining', value: licenseStatus.daysRemaining })
      }
    }

    const evidence = []
    if (settingsSnapshot && typeof settingsSnapshot === 'object') {
      Object.entries(settingsSnapshot).slice(0, 8).forEach(([key, value]) => {
        const v = typeof value === 'object' ? JSON.stringify(value).slice(0, 120) : String(value)
        evidence.push({ label: key, text: v })
      })
    }

    // Inject registry metadata for the current section so REGULA can
    // explain settings without hallucinating.
    const sectionSettings = getSettingsBySection(currentSection || 'general')
    if (sectionSettings.length > 0) {
      summary.push({ label: 'Settings in this section', value: sectionSettings.length })
      sectionSettings.slice(0, 10).forEach(s => {
        const flags = []
        if (s.destructive) flags.push('destructive')
        if (s.hitlRequired) flags.push('HITL')
        const flagStr = flags.length ? ` [${flags.join(', ')}]` : ''
        evidence.push({
          label: `${s.label}${flagStr}`,
          text: s.shortDescription,
        })
      })
    }

    const preambles = {
      regula: 'You are REGULA, the configuration warden for QuoxCORE. You are meticulous, protective, and dependency-aware. Explain settings in plain English, surface dependencies before changes, and never be flippant about destructive actions. Speak in calm, deliberate British English. When the user asks about a setting, reference the current section and walk through what depends on it.',
      quox: 'You are CommanderQ, the orchestrator. Provide high-level guidance on the Settings surface. Defer configuration specifics to REGULA when appropriate.',
    }

    return {
      surface: 'sidebar',
      page: 'Settings',
      panel: `${agent.name} settings sidebar`,
      focus: {
        type: 'Settings section',
        label: sectionLabel,
        id: currentSection || 'general',
        detail: `Configuring ${sectionLabel}`,
      },
      summary,
      evidenceTitle: 'Visible settings snapshot',
      evidence,
      instructions: [preambles[selectedAgentId] || preambles.regula],
    }
  }, [agent.name, sectionLabel, currentSection, settingsSnapshot, pluginCount, activePluginCount, licenseStatus, selectedAgentId])

  const suggestions = SECTION_SUGGESTIONS[currentSection] || DEFAULT_SUGGESTIONS

  const headerContent = (
    <div className="acc-header__agent-wrap">
      <button
        className="acc-header__agent-btn"
        onClick={() => setDropdownOpen(v => !v)}
        style={{ '--agent-color': agent.color }}
      >
        <span className="acc-header__dot" style={{ background: agent.color }} />
        <span className="acc-header__name">{agent.name}</span>
        <span className="acc-header__chevron">{dropdownOpen ? '\u25B4' : '\u25BE'}</span>
      </button>
      {dropdownOpen && (
        <div className="acc-dropdown">
          {SETTINGS_AGENTS.map(a => (
            <button
              key={a.id}
              className={`acc-dropdown__item ${a.id === selectedAgentId ? 'acc-dropdown__item--active' : ''}`}
              onClick={() => { setSelectedAgentId(a.id); setDropdownOpen(false); }}
            >
              <span className="acc-dropdown__dot" style={{ background: a.color }} />
              <span className="acc-dropdown__name">{a.name}</span>
              <span className="acc-dropdown__role">{a.role}</span>
            </button>
          ))}
        </div>
      )}
      <span className="acc-header__role">{agent.role}</span>
    </div>
  )

  return (
    <AgentChatSidebar
      agentId={selectedAgentId}
      agentName={agent.name}
      agentColor={agent.color}
      agentRole={agent.role}
      headerContent={headerContent}
      contextBuilder={buildContext}
      suggestions={suggestions}
      sessionPrefix={`SETTINGS_${selectedAgentId.toUpperCase()}_CHAT`}
      vizStorageKey="settings-viz-collapsed"
      placeholder={`Ask ${agent.name} about ${sectionLabel}...`}
      emptyText={`Ask ${agent.name} about your settings...`}
    />
  )
}

export default SettingsChatSidebar

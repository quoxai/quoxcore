/**
 * PlaybooksPanel — Shows QuoxAgent's 18 built-in playbooks by tier.
 *
 * Playbooks ship with the binary. This panel is informational + chat-interactive.
 * When the playbook execution API is added, a "Run" button can be wired up.
 */

import { useState, useEffect, memo } from 'react'

const MHA_BASE = `${window.location.origin}/mha-agent`

const TIERS = [
  {
    id: 'a', label: 'Tier A', sublabel: 'Free', color: '#30ff90', locked: false,
    playbooks: [
      { id: 'health-check', name: 'Health Check', desc: 'Host and service health monitoring with alerting', schedule: '*/5 * * * *' },
      { id: 'disk-cleanup', name: 'Disk Cleanup', desc: 'Disk usage monitoring and safe cleanup (temp, caches, logs)', schedule: null },
      { id: 'service-restart', name: 'Service Restart', desc: 'Service health check, graceful restart, verification', schedule: null },
      { id: 'log-rotation', name: 'Log Rotation', desc: 'Automated log rotation, compression, retention', schedule: null },
      { id: 'backup-check', name: 'Backup Check', desc: 'Verify backup age, size, alert on staleness', schedule: null },
    ],
  },
  {
    id: 'b', label: 'Tier B', sublabel: 'Pro', color: '#fbbf24', locked: true,
    playbooks: [
      { id: 'patch-management', name: 'Patch Management', desc: 'Rolling patch deployment with rollback', schedule: 'Sun 2am' },
      { id: 'incident-response', name: 'Incident Response', desc: 'Security alert response with evidence collection', schedule: null },
      { id: 'compliance-scan', name: 'Compliance Scan', desc: 'Multi-framework: CIS, PCI-DSS, NIST, SOC2', schedule: null },
      { id: 'capacity-planning', name: 'Capacity Planning', desc: 'Fleet-wide capacity analysis and trend projection', schedule: null },
      { id: 'security-audit', name: 'Security Audit', desc: 'Comprehensive vuln scan, config check, threat hunting', schedule: null },
    ],
  },
  {
    id: 'c', label: 'Tier C', sublabel: 'Enterprise', color: '#a78bfa', locked: true,
    playbooks: [
      { id: 'blue-green-deploy', name: 'Blue-Green Deploy', desc: 'Canary rollout with auto-rollback', schedule: null },
      { id: 'disaster-recovery', name: 'Disaster Recovery', desc: 'Site failover, DB failover, DNS reconfiguration', schedule: null },
      { id: 'zero-day-response', name: 'Zero-Day Response', desc: 'Threat intel, isolation, forensics, executive notify', schedule: null },
      { id: 'fleet-migration', name: 'Fleet Migration', desc: 'Staged rollout: canary, pilot, waves', schedule: null },
      { id: 'soc-playbook', name: 'SOC Playbook', desc: 'Full SOC workflow: analysis, IOC matching, MITRE mapping', schedule: null },
    ],
  },
]

const PlaybookRow = memo(function PlaybookRow({ playbook, locked, onAsk }) {
  return (
    <button
      className={`pbp-row ${locked ? 'pbp-row--locked' : ''}`}
      onClick={() => !locked && onAsk(playbook)}
      disabled={locked}
      title={locked ? 'Requires higher license tier' : `Ask about ${playbook.name}`}
    >
      <span className="pbp-row__name">{playbook.name}</span>
      <span className="pbp-row__desc">{playbook.desc}</span>
      {playbook.schedule && (
        <span className="pbp-row__schedule">{playbook.schedule}</span>
      )}
    </button>
  )
})

export default function PlaybooksPanel({ onAskChat }) {
  const [licenseTiers, setLicenseTiers] = useState([])
  const [collapsed, setCollapsed] = useState({ a: false, b: true, c: true })

  useEffect(() => {
    fetch(`${MHA_BASE}/api/v1/license`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.tiers) setLicenseTiers(data.tiers)
        else if (data?.licensed === false) setLicenseTiers(['free'])
      })
      .catch(() => {})
  }, [])

  const isTierUnlocked = (tierId) => {
    if (tierId === 'a') return true // Free tier always unlocked
    return licenseTiers.includes(`tier_${tierId}`)
  }

  const handleAsk = (playbook) => {
    if (onAskChat) {
      onAskChat(`Tell me about the ${playbook.name} playbook. What does it do, what variables does it accept, and how would I use it?`)
    }
  }

  return (
    <div className="pbp-panel">
      <div className="pbp-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        <span className="pbp-header__title">Playbooks</span>
        <span className="pbp-header__count">18 built-in</span>
      </div>

      {TIERS.map(tier => {
        const unlocked = isTierUnlocked(tier.id)
        const isCollapsed = collapsed[tier.id]
        return (
          <div key={tier.id} className="pbp-tier">
            <button
              className="pbp-tier__header"
              onClick={() => setCollapsed(prev => ({ ...prev, [tier.id]: !prev[tier.id] }))}
            >
              <span className="pbp-tier__chevron">{isCollapsed ? '\u25B8' : '\u25BE'}</span>
              <span className="pbp-tier__label" style={{ color: tier.color }}>{tier.label}</span>
              <span className="pbp-tier__sublabel">({tier.sublabel})</span>
              <span className="pbp-tier__count">{tier.playbooks.length}</span>
              {!unlocked && <span className="pbp-tier__lock">&#x1F512;</span>}
            </button>
            {!isCollapsed && (
              <div className="pbp-tier__list">
                {tier.playbooks.map(pb => (
                  <PlaybookRow
                    key={pb.id}
                    playbook={pb}
                    locked={!unlocked}
                    onAsk={handleAsk}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

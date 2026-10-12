/**
 * QuoxMindSettings — Cognitive implant suite status and tier management
 *
 * Shows: current tier, 12 implant grid (active/locked), upgrade buttons.
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { COGNITIVE_IMPLANTS } from '../../config/cognitiveImplants'
import { getLockedImplants } from '../../services/cognitiveTopologyService'
import { isPluginLicensed, getActiveQuoxMindTier } from '../../services/licenseValidator'
import SettingsSection from './SettingsSection'
import PlatformFlagsPanel from './PlatformFlagsPanel'

// Phase 25 (owner mandate 2026-08-06): memory-relevant platform flags —
// server-side, org-scoped, override the env default, admin-only, audited.
// See services/collector/lib/platformSettingsStore.js.
// VAULT-INTEG P17: group-driven instead of a hand-curated key list — every
// settable entry tagged group:'memory' in the registry (platformCapabilities.js)
// renders here automatically, including ones promoted after this page shipped.

const TIERS = [
  {
    id: 'free', label: 'Free', price: 'Included', color: '#22c55e',
    desc: 'Ships with QuoxCORE. 6 cognitive implants for perception, memory, sequencing, attention, prioritisation, and basic safety.',
    implants: ['quox-sense', 'quox-memory', 'quox-temporal', 'quox-focus', 'quox-value', 'quox-guard'],
  },
  {
    id: 'pro', label: 'Pro', price: '$29', color: '#f59e0b', plugin: 'quoxmind-pro',
    desc: 'Strategic intelligence. Significance recognition, goal-directed action, predictive processing, and advanced safety authority.',
    implants: ['quox-insight', 'quox-executive', 'quox-predict'],
  },
  {
    id: 'complete', label: 'Complete', price: '$49', color: '#a855f7', plugin: 'quoxmind-complete',
    desc: 'Self-improving intelligence. Post-action evaluation, memory consolidation, and behavioural adaptation. Includes everything in Pro.',
    implants: ['quox-reflect', 'quox-dream', 'quox-learn'],
  },
]

// QMH-5/4 — single source of truth in licenseValidator.getActiveQuoxMindTier.
const getCurrentTier = () => getActiveQuoxMindTier({ check: isPluginLicensed })

// QMH-5/4 — pick the right tierBehavior copy for "what does this implant
// do for me right now?" (active tier) and "what would I get if I upgraded?"
// (next paid tier). Source is the tierBehavior map added in QMH-5/2.
// Exported so the test suite can pin the contract.
export function describeImplantForTier(implant, currentTier) {
  const tb = implant.tierBehavior || {}
  const current = tb[currentTier] || implant.description
  let upgrade = null
  if (currentTier === 'free' && tb.pro && tb.pro !== tb.free) {
    upgrade = `Pro: ${tb.pro}`
  } else if (currentTier === 'free' && tb.complete && tb.complete !== tb.free) {
    upgrade = `Complete: ${tb.complete}`
  } else if (currentTier === 'pro' && tb.complete && tb.complete !== tb.pro) {
    upgrade = `Complete: ${tb.complete}`
  }
  return { current, upgrade, upsell: tb.upsell || null }
}

export default function QuoxMindSettings() {
  const navigate = useNavigate()
  const [currentTier, setCurrentTier] = useState(getCurrentTier)
  const lockedImplants = getLockedImplants()

  useEffect(() => {
    setCurrentTier(getCurrentTier())
  }, [])

  const allImplants = Object.values(COGNITIVE_IMPLANTS)

  return (
    <div>
      <SettingsSection title="QuoxMind" subtitle="Cognitive implant suite">
        {/* Current tier banner */}
        <div style={{
          padding: '16px 20px', borderRadius: 10, marginBottom: 24,
          background: currentTier === 'complete' ? 'rgba(168,85,247,0.08)' : currentTier === 'pro' ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)',
          border: `1px solid ${currentTier === 'complete' ? 'rgba(168,85,247,0.2)' : currentTier === 'pro' ? 'rgba(245,158,11,0.2)' : 'rgba(34,197,94,0.2)'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12,
        }}>
          <div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Current tier</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
              QuoxMind {currentTier === 'free' ? 'Free' : currentTier === 'pro' ? 'Pro' : 'Complete'}
              <span style={{
                padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                background: currentTier === 'complete' ? 'rgba(168,85,247,0.15)' : currentTier === 'pro' ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)',
                color: currentTier === 'complete' ? '#a855f7' : currentTier === 'pro' ? '#f59e0b' : '#22c55e',
              }}>
                {allImplants.length - lockedImplants.length}/{allImplants.length} active
              </span>
            </div>
          </div>
          <button
            onClick={() => navigate('/topology')}
            style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: 6 }}>
              <circle cx="12" cy="12" r="3" /><circle cx="12" cy="4" r="2" /><circle cx="20" cy="12" r="2" /><circle cx="12" cy="20" r="2" /><circle cx="4" cy="12" r="2" />
            </svg>
            Open Topology
          </button>
        </div>

        {/* Implant grid */}
        <div style={{ marginBottom: 24 }}>
          <h4 style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 12 }}>Implant Status</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {allImplants.map(implant => {
              const locked = lockedImplants.includes(implant.id)
              const tierColor = implant.tier === 'free' ? '#22c55e' : implant.tier === 'pro' ? '#f59e0b' : '#a855f7'
              // QMH-5/4 — tooltip shows tier-aware copy: what this implant
              // does for the user today and what they'd unlock by upgrading.
              const copy = describeImplantForTier(implant, currentTier)
              const tooltip = copy.upgrade
                ? `Now: ${copy.current}\n\nWith upgrade — ${copy.upgrade}`
                : copy.current
              return (
                <div key={implant.id} title={tooltip} style={{
                  padding: '12px 14px', borderRadius: 8,
                  background: locked ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${locked ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)'}`,
                  opacity: locked ? 0.55 : 1,
                  display: 'flex', flexDirection: 'column', gap: 6,
                  cursor: 'help',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: locked ? 'rgba(255,255,255,0.2)' : tierColor,
                      flexShrink: 0,
                    }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: locked ? 'rgba(255,255,255,0.4)' : '#fff' }}>
                        {implant.name}
                      </div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                        {implant.inspiredBy}
                      </div>
                    </div>
                    <span style={{
                      fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                      padding: '2px 5px', borderRadius: 3,
                      background: locked ? 'rgba(255,255,255,0.06)' : `${tierColor}15`,
                      color: locked ? 'rgba(255,255,255,0.3)' : tierColor,
                    }}>
                      {locked ? 'Locked' : implant.tier}
                    </span>
                  </div>
                  {/* QMH-5/4 — inline upgrade hint when there's something
                      to gain from upgrading. Falls back to the upsell line
                      authored on the implant config when present. */}
                  {(copy.upgrade || copy.upsell) && (
                    <div style={{
                      fontSize: 11, color: 'rgba(245,158,11,0.85)', lineHeight: 1.4,
                      paddingLeft: 18,
                    }}>
                      {copy.upsell || copy.upgrade}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Tier cards */}
        <h4 style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 12 }}>Tiers</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          {TIERS.map(tier => {
            const isActive = currentTier === tier.id || (tier.id === 'pro' && currentTier === 'complete')
            return (
              <div key={tier.id} style={{
                padding: '18px 20px', borderRadius: 10,
                background: isActive ? `${tier.color}08` : 'rgba(255,255,255,0.02)',
                border: `1px solid ${isActive ? `${tier.color}30` : 'rgba(255,255,255,0.06)'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{tier.label}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: tier.color }}>{tier.price}</span>
                </div>
                <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 1.5, marginBottom: 12 }}>{tier.desc}</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
                  {tier.implants.map(id => {
                    const imp = COGNITIVE_IMPLANTS[id]
                    return imp ? (
                      <span key={id} style={{
                        padding: '2px 7px', borderRadius: 4, fontSize: 10,
                        background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)',
                      }}>{imp.name}</span>
                    ) : null
                  })}
                </div>
                {tier.id === 'free' ? (
                  <span style={{ fontSize: 12, fontWeight: 600, color: tier.color }}>Included with QuoxCORE</span>
                ) : isActive ? (
                  <span style={{ fontSize: 12, fontWeight: 600, color: tier.color }}>Active</span>
                ) : (
                  <button
                    onClick={() => navigate('/settings', { state: { section: 'plugins', highlight: tier.plugin } })}
                    style={{
                      padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                      background: `${tier.color}15`, border: `1px solid ${tier.color}30`,
                      color: tier.color, cursor: 'pointer',
                    }}
                  >
                    Upgrade to {tier.label}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Memory Behaviour" subtitle="Recall and consolidation flags">
        <PlatformFlagsPanel group="memory" title="Memory & Recall" />
      </SettingsSection>
    </div>
  )
}

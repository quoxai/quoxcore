/**
 * HonestyLedgerView — AGH-Chain Honesty Ledger
 *
 * Governance visibility surface for the AGH-Chain guards (AGH-CHAIN-1/2/3):
 * every agent response is checked for promises made, promise fulfillment
 * claims, and claims about other agents or organisations, against the
 * AEE/VOLT evidence chain — before it reaches the user. When a claim can't
 * be verified, the guard rewrites the response with an honest correction.
 *
 * Sections:
 *   1. Header + live flag-state chip (GET /api/v1/agh-chain/status)
 *   2. The four guards, one row each, with their verification windows
 *   3. Recent corrections feed (GET /api/v1/agh-chain/corrections)
 *   4. Per-agent leaderboard (embeds HonestyLeaderboardTab)
 *
 * Route: /honesty
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { HonestyLeaderboardTab } from '../../components/agents/HonestyLeaderboardTab'
import GovernancePageLayout from '../../components/compliance/GovernancePageLayout'
import { COLORS, GlassPanel, GlassButton, GlassPill, M, F } from '../../components/compliance/glass-primitives'

const GUARDS = [
  {
    key: 'detect_promise',
    label: 'Promise Detection',
    description: 'Flags when an agent commits to a future action (e.g. "I will send that email") and records it against the conversation.',
    window: 'Continuous — every response is scanned',
  },
  {
    key: 'verify_promise_kept',
    label: 'Promise Fulfillment',
    description: 'When an agent later claims a promise was kept, checks the chain for the matching tool execution. No match rewrites the claim honestly.',
    window: '7-day promise lookback',
  },
  {
    key: 'verify_cross_agent_claim',
    label: 'Cross-Agent Verification',
    description: 'When an agent claims another named Quox agent acted, checks the AEE envelope chain for that agent’s activity in the conversation.',
    window: '2-hour envelope lookback',
  },
  {
    key: 'verify_cross_org_claim',
    label: 'Cross-Org Verification',
    description: 'When an agent claims an external organisation approved or confirmed something, checks the trust relationship on file. Name-only check today — signed WARD-CRYPTO envelope proof is planned.',
    window: 'Trust-relationship check (no fixed window)',
    beta: true,
  },
]

const WINDOWS = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
]

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

function SectionTitle({ children }) {
  return (
    <h2 style={{
      fontFamily: M, fontSize: 11, fontWeight: 700, letterSpacing: 1.2,
      textTransform: 'uppercase', color: COLORS.dimText, margin: '0 0 8px',
    }}>
      {children}
    </h2>
  )
}

function GuardRow({ guard }) {
  return (
    <GlassPanel style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: '1 1 260px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#fff' }}>{guard.label}</span>
            {guard.beta && <GlassPill color={COLORS.amber}>BETA</GlassPill>}
          </div>
          <p style={{ fontFamily: F, fontSize: 11.5, color: COLORS.dimText, lineHeight: 1.5, margin: '4px 0 0' }}>
            {guard.description}
          </p>
        </div>
        <div style={{ flexShrink: 0 }}>
          <GlassPill color={guard.beta ? COLORS.amber : COLORS.cyan}>{guard.window}</GlassPill>
        </div>
      </div>
    </GlassPanel>
  )
}

const CHAIN_GUARD_LABELS = {
  detect_promise: 'Promise Detection',
  verify_promise_kept: 'Promise Fulfillment',
  verify_cross_agent_claim: 'Cross-Agent Verification',
  verify_cross_org_claim: 'Cross-Org Verification',
}

function CorrectionRow({ correction }) {
  const guardLabel = CHAIN_GUARD_LABELS[correction.guard] || correction.guard
  return (
    <GlassPanel style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: M, fontSize: 9, color: COLORS.dimText,
          fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 64,
        }}>{timeAgo(correction.ts)}</span>
        <GlassPill color={COLORS.purple} style={{ flexShrink: 0 }}>{guardLabel}</GlassPill>
        <span style={{ fontFamily: M, fontSize: 11, color: '#fff', flexShrink: 0 }}>{correction.agent_id}</span>
        <span style={{ fontFamily: F, fontSize: 11.5, color: COLORS.dimText, flex: '1 1 200px', minWidth: 0 }}>
          {correction.summary}
        </span>
      </div>
    </GlassPanel>
  )
}

const windowBtnStyle = (active) => ({
  fontFamily: M, fontSize: 10, fontWeight: 600,
  padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
  background: active ? `${COLORS.cyan}22` : 'rgba(255,255,255,0.04)',
  border: `1px solid ${active ? `${COLORS.cyan}4d` : 'rgba(255,255,255,0.12)'}`,
  color: active ? COLORS.cyan : COLORS.dimText,
})

const selectStyle = {
  fontFamily: M, fontSize: 11, color: '#fff',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8, padding: '5px 10px', outline: 'none', cursor: 'pointer',
}

export default function HonestyLedgerView() {
  const { authFetch } = useAuth()
  const [enabled, setEnabled] = useState(null) // null = loading

  const [correctionsWindow, setCorrectionsWindow] = useState('7d')
  const [corrections, setCorrections] = useState([])
  const [correctionsLoading, setCorrectionsLoading] = useState(false)
  const [correctionsError, setCorrectionsError] = useState(null)

  const [agents, setAgents] = useState([])
  const [agentsLoading, setAgentsLoading] = useState(false)
  const [selectedAgentId, setSelectedAgentId] = useState(null)

  // Flag-state chip
  useEffect(() => {
    let cancelled = false
    authFetch('/collector/api/v1/agh-chain/status')
      .then(r => r.json())
      .then(d => { if (!cancelled) setEnabled(!!d.enabled) })
      .catch(() => { if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [authFetch])

  // Recent corrections feed
  const loadCorrections = useCallback(() => {
    setCorrectionsLoading(true)
    setCorrectionsError(null)
    authFetch(`/collector/api/v1/agh-chain/corrections?window=${correctionsWindow}&limit=25`)
      .then(r => r.json())
      .then(d => setCorrections(d.corrections || []))
      .catch(e => setCorrectionsError(String(e?.message || e)))
      .finally(() => setCorrectionsLoading(false))
  }, [authFetch, correctionsWindow])

  useEffect(() => { loadCorrections() }, [loadCorrections])

  // Per-agent leaderboard roster
  useEffect(() => {
    let cancelled = false
    setAgentsLoading(true)
    authFetch('/collector/api/v1/agh-chain/leaderboard?window=7d')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        const list = d.agents || []
        setAgents(list)
        setSelectedAgentId(prev => prev || (list.length > 0 ? list[0].agent_id : null))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setAgentsLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authFetch])

  const statusPill = enabled === null
    ? null
    : enabled
      ? { label: 'AGH-CHAIN ON', color: COLORS.green }
      : { label: 'AGH-CHAIN OFF', color: COLORS.dimText }

  return (
    <GovernancePageLayout
      protocol="AGH"
      title="Honesty Ledger"
      subtitle="AGH-Chain guard visibility · Promises, fulfillment, cross-agent + cross-org claims"
      statusPill={statusPill}
      crumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'Honesty' }]}
    >
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 20,
        minHeight: 0, overflowY: 'auto', padding: '4px 4px 16px',
      }}>
        {/* Header explainer */}
        <GlassPanel style={{ padding: 18 }}>
          <p style={{ fontFamily: F, fontSize: 13, color: '#fff', lineHeight: 1.6, margin: 0 }}>
            AGH-Chain is Quox&rsquo;s honesty layer: four guards inspect every agent response for promises made,
            promises claimed kept, and claims about other agents or organisations, checking each against the
            AEE/VOLT evidence chain before the response reaches the user. When a claim can&rsquo;t be verified,
            the guard rewrites the response with an honest correction instead of letting an unverifiable claim stand.
          </p>
        </GlassPanel>

        {/* The four guards */}
        <div>
          <SectionTitle>The Four Guards</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {GUARDS.map(g => <GuardRow key={g.key} guard={g} />)}
          </div>
        </div>

        {/* Recent corrections feed */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <SectionTitle>Recent Corrections</SectionTitle>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {WINDOWS.map(w => (
                <button
                  key={w.id}
                  onClick={() => setCorrectionsWindow(w.id)}
                  style={windowBtnStyle(w.id === correctionsWindow)}
                >
                  {w.label}
                </button>
              ))}
              <GlassButton size="sm" onClick={loadCorrections}>Refresh</GlassButton>
            </div>
          </div>

          {correctionsError && (
            <GlassPanel highlight={COLORS.red} style={{ padding: 12, marginBottom: 8 }}>
              <span style={{ fontFamily: M, fontSize: 11, color: COLORS.red }}>
                Corrections unavailable: {correctionsError}
              </span>
            </GlassPanel>
          )}

          {correctionsLoading ? (
            <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
              <span style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>Loading corrections…</span>
            </GlassPanel>
          ) : corrections.length === 0 ? (
            <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
              <span style={{ fontFamily: M, fontSize: 12, color: COLORS.dimText }}>
                No corrections yet: the guards are watching.
              </span>
            </GlassPanel>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {corrections.map(c => <CorrectionRow key={c.event_id} correction={c} />)}
            </div>
          )}
        </div>

        {/* Per-agent leaderboard */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <SectionTitle>Per-Agent Leaderboard</SectionTitle>
            {agents.length > 0 && (
              <select
                value={selectedAgentId || ''}
                onChange={e => setSelectedAgentId(e.target.value)}
                style={selectStyle}
              >
                {agents.map(a => (
                  <option key={a.agent_id} value={a.agent_id} style={{ background: '#1a1a2e' }}>{a.agent_id}</option>
                ))}
              </select>
            )}
          </div>

          {agentsLoading ? (
            <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
              <span style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>Loading leaderboard…</span>
            </GlassPanel>
          ) : agents.length === 0 ? (
            <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
              <span style={{ fontFamily: M, fontSize: 12, color: COLORS.dimText }}>
                No agent activity recorded yet: the guards are watching.
              </span>
            </GlassPanel>
          ) : (
            <GlassPanel style={{ padding: 16 }}>
              {selectedAgentId && <HonestyLeaderboardTab agentId={selectedAgentId} />}
            </GlassPanel>
          )}
        </div>
      </div>
    </GovernancePageLayout>
  )
}

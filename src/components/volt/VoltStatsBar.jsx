/**
 * VoltStatsBar — Hero stats dashboard with 4 metric cards + bridge status
 *
 * Cards: Total Runs | Events Recorded | Evidence Bundles | Chain Integrity (ring)
 * Bridge status shown inline with pulse dot when active.
 *
 * GLV-2: migrated to glass-primitives (GlassPanel, ProgressRing) for
 * visual cohesion with the unified governance shell.
 */

import { GlassPanel, ProgressRing, COLORS, M } from '../compliance/glass-primitives'

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
)

const ChainIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

function StatCard({ icon, iconColor, value, label, highlight }) {
  return (
    <GlassPanel highlight={highlight} style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 8, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${iconColor}1f`, color: iconColor,
        }}>
          {icon}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span style={{
            fontFamily: M, fontSize: 20, fontWeight: 700, color: '#fff',
            fontVariantNumeric: 'tabular-nums', lineHeight: 1.2,
          }}>{value}</span>
          <span style={{
            fontFamily: M, fontSize: 10, fontWeight: 500, color: COLORS.dimText,
            textTransform: 'uppercase', letterSpacing: 1,
          }}>{label}</span>
        </div>
      </div>
    </GlassPanel>
  )
}

export default function VoltStatsBar({ stats = {}, bridgeStats = {} }) {
  const recorded = bridgeStats.eventsRecorded || 0
  const failed = bridgeStats.eventsFailed || 0
  const total = recorded + failed
  const integrityPct = total > 0 ? Math.round((recorded / total) * 100) : 100
  const integrityColor = integrityPct >= 95 ? COLORS.green : integrityPct >= 80 ? COLORS.amber : COLORS.red

  return (
    <div style={{ padding: '16px 24px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 12,
      }}>
        <StatCard
          icon={<ShieldIcon />}
          iconColor={COLORS.amber}
          value={stats.runs ?? 0}
          label="Total Runs"
        />
        <StatCard
          icon={<ChainIcon />}
          iconColor={COLORS.cyan}
          value={stats.events ?? 0}
          label="Events Recorded"
        />
        <StatCard
          icon={<DownloadIcon />}
          iconColor={COLORS.purple}
          value={stats.bundles ?? 0}
          label="Evidence Bundles"
        />
        <GlassPanel highlight={integrityColor} style={{ padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flexShrink: 0 }}>
              <ProgressRing value={integrityPct} size={52} strokeWidth={4} color={integrityColor} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{
                fontFamily: M, fontSize: 20, fontWeight: 700, color: '#fff',
                fontVariantNumeric: 'tabular-nums', lineHeight: 1.2,
              }}>{integrityPct}%</span>
              <span style={{
                fontFamily: M, fontSize: 10, fontWeight: 500, color: COLORS.dimText,
                textTransform: 'uppercase', letterSpacing: 1,
              }}>Chain Integrity</span>
            </div>
          </div>
        </GlassPanel>
      </div>

      {/* Bridge status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 4px 2px',
        fontFamily: M, fontSize: 11, color: COLORS.dimText,
      }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: bridgeStats.enabled ? COLORS.green : 'rgba(255,255,255,0.3)',
          boxShadow: bridgeStats.enabled ? `0 0 8px ${COLORS.green}` : 'none',
          animation: bridgeStats.enabled ? 'pulse 1.8s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontWeight: 600, letterSpacing: 0.3 }}>
          {bridgeStats.enabled ? 'BRIDGE ACTIVE' : 'BRIDGE INACTIVE'}
        </span>
        {bridgeStats.enabled && recorded > 0 && (
          <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
            {recorded} recorded
            {failed > 0 && (
              <span style={{ color: COLORS.red }}> / {failed} failed</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}

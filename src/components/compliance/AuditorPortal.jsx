/**
 * AuditorPortal — External Auditor Workspace
 *
 * Engagement-scoped read-only view with PBC auto-match,
 * working paper templates, and evidence access.
 *
 * AUD-UX Phase 6
 */

import { useState, useCallback, useMemo } from 'react'
import {
  GlassPanel,
  GlassPill,
  SectionHeader,
  ProgressRing,
  COLORS,
  PROTOCOL_COLORS,
  M,
  F,
} from './glass-primitives'

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '◈' },
  { id: 'pbc', label: 'PBC Match', icon: '▣' },
  { id: 'papers', label: 'Working Papers', icon: '◉' },
  { id: 'evidence', label: 'Evidence', icon: '★' },
]

function AuditorBanner({ engagement }) {
  const daysRemaining = engagement?.expires_at
    ? Math.max(0, Math.ceil((new Date(engagement.expires_at) - Date.now()) / 86400000))
    : null

  return (
    <GlassPanel highlight={COLORS.cyan} style={{ padding: '10px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={COLORS.cyan} strokeWidth={2}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 700 }}>
            Auditor View — Read Only
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {engagement?.auditor_name && (
            <span style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText }}>
              {engagement.auditor_name} ({engagement.firm_name})
            </span>
          )}
          {engagement?.framework && (
            <GlassPill color={COLORS.cyan}>{engagement.framework.toUpperCase()}</GlassPill>
          )}
          {daysRemaining !== null && (
            <GlassPill color={daysRemaining < 14 ? COLORS.amber : COLORS.green}>
              {daysRemaining}d remaining
            </GlassPill>
          )}
        </div>
      </div>
    </GlassPanel>
  )
}

function EngagementDashboard({ engagement, stats }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[
          { label: 'Controls', value: stats?.controlCount || 0, color: COLORS.cyan },
          { label: 'Evidence Items', value: stats?.evidenceCount || 0, color: COLORS.green },
          { label: 'Chain Integrity', value: stats?.chainIntact ? 'INTACT' : '—', color: stats?.chainIntact ? COLORS.green : COLORS.subtleText },
          { label: 'VOLT Bundles', value: stats?.bundleCount || 0, color: PROTOCOL_COLORS.VOLT },
        ].map(kpi => (
          <GlassPanel key={kpi.label} style={{ textAlign: 'center', padding: 14 }}>
            <div style={{ fontFamily: M, fontSize: 20, color: kpi.color, fontWeight: 800 }}>
              {typeof kpi.value === 'number' ? kpi.value.toLocaleString() : kpi.value}
            </div>
            <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 4, letterSpacing: 0.5 }}>
              {kpi.label}
            </div>
          </GlassPanel>
        ))}
      </div>

      <GlassPanel>
        <SectionHeader title="Engagement Details" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            ['Framework', engagement?.framework?.toUpperCase()],
            ['Period', engagement?.period_start ? `${engagement.period_start} — ${engagement.period_end}` : 'Not set'],
            ['Auditor', engagement?.auditor_name || '—'],
            ['Firm', engagement?.firm_name || '—'],
            ['Status', engagement?.status || 'draft'],
            ['Expires', engagement?.expires_at ? new Date(engagement.expires_at).toLocaleDateString() : '—'],
          ].map(([label, value]) => (
            <div key={label} style={{ padding: '6px 0' }}>
              <div style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, letterSpacing: 0.5 }}>{label}</div>
              <div style={{ fontFamily: F, fontSize: 11, color: '#fff', marginTop: 2 }}>{value}</div>
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  )
}

function PbcMatchPanel({ pbcResults = [], onUpload }) {
  const matchedCount = pbcResults.filter(r => r.matched).length
  const totalCount = pbcResults.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <GlassPanel>
        <SectionHeader
          title="PBC List Auto-Match"
          subtitle="Upload your Prepared by Client request list for automatic evidence matching"
          action={
            <GlassPill color={COLORS.cyan} style={{ cursor: 'pointer' }} onClick={onUpload}>
              Upload PBC List
            </GlassPill>
          }
        />
        {totalCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <ProgressRing value={totalCount > 0 ? (matchedCount / totalCount) * 100 : 0} size={48} label="Matched" />
            <div>
              <div style={{ fontFamily: M, fontSize: 12, color: '#fff', fontWeight: 700 }}>
                {matchedCount}/{totalCount} items matched
              </div>
              <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText }}>
                {totalCount - matchedCount} items require manual upload
              </div>
            </div>
          </div>
        )}
      </GlassPanel>

      {pbcResults.length > 0 && (
        <GlassPanel style={{ padding: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 100px 140px', gap: 8 }}>
              <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>#</span>
              <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>PBC ITEM</span>
              <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>STATUS</span>
              <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>EVIDENCE MATCH</span>
            </div>
          </div>
          {pbcResults.map((item, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '40px 1fr 100px 140px', gap: 8,
              padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.02)',
              borderLeft: item.matched ? `3px solid ${COLORS.green}40` : '3px solid rgba(255,255,255,0.05)',
            }}>
              <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>{i + 1}</span>
              <span style={{ fontFamily: F, fontSize: 10, color: '#fff' }}>{item.text}</span>
              <GlassPill color={item.matched ? COLORS.green : COLORS.amber}>
                {item.matched ? 'Matched' : 'Manual'}
              </GlassPill>
              <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                {item.primary ? `${item.primary.evidenceType} (${item.primary.controls.join(', ')})` : '—'}
              </span>
            </div>
          ))}
        </GlassPanel>
      )}
    </div>
  )
}

function WorkingPapersPanel({ workingPapers = [] }) {
  const [expanded, setExpanded] = useState(null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <GlassPanel>
        <SectionHeader
          title="Working Paper Templates"
          subtitle="Pre-populated from VOLT/WARD/AEE evidence — review and sign off"
        />
      </GlassPanel>

      {workingPapers.length === 0 && (
        <GlassPanel style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontFamily: F, fontSize: 12, color: COLORS.subtleText }}>
            Working paper auto-generation is not yet available for this engagement.
          </div>
        </GlassPanel>
      )}

      {workingPapers.map(wp => (
        <GlassPanel key={wp.control_id} style={{ padding: '10px 14px' }}>
          <div
            onClick={() => setExpanded(expanded === wp.control_id ? null : wp.control_id)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <div>
              <span style={{ fontFamily: M, fontSize: 11, color: COLORS.cyan, fontWeight: 600 }}>{wp.control_id}</span>
              <span style={{ fontFamily: F, fontSize: 11, color: '#fff', marginLeft: 8 }}>{wp.control_name}</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <GlassPill color={COLORS.subtleText}>{wp.template.population_count} events</GlassPill>
              <GlassPill color={(wp.template.volt_integrity || '').includes('INTACT') ? COLORS.green : COLORS.amber}>
                {(wp.template.volt_integrity || '').includes('INTACT') ? 'CHAIN ✓' : 'UNVERIFIED'}
              </GlassPill>
            </div>
          </div>

          {expanded === wp.control_id && (
            <div style={{ marginTop: 10, padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
              {wp.template.test_procedure.map((step, i) => (
                <div key={i} style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, padding: '2px 0' }}>
                  {step}
                </div>
              ))}
              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <div style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>SAMPLE SIZE</div>
                  <div style={{ fontFamily: M, fontSize: 11, color: '#fff' }}>{wp.template.sample_size}</div>
                </div>
                <div>
                  <div style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>WARD WITNESSED</div>
                  <div style={{ fontFamily: M, fontSize: 11, color: '#fff' }}>{wp.template.ward_witnessed}</div>
                </div>
              </div>
            </div>
          )}
        </GlassPanel>
      ))}
    </div>
  )
}

export default function AuditorPortal({
  engagement,
  stats = {},
  pbcResults = [],
  workingPapers = [],
  evidenceComponent,
  onUploadPbc,
}) {
  const [activeTab, setActiveTab] = useState('dashboard')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <AuditorBanner engagement={engagement} />

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none',
              fontFamily: M, fontSize: 10, fontWeight: activeTab === tab.id ? 700 : 500,
              color: activeTab === tab.id ? '#fff' : COLORS.subtleText,
              background: activeTab === tab.id ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.02)',
              cursor: 'pointer',
            }}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'dashboard' && (
          <EngagementDashboard engagement={engagement} stats={stats} />
        )}
        {activeTab === 'pbc' && (
          <PbcMatchPanel pbcResults={pbcResults} onUpload={onUploadPbc} />
        )}
        {activeTab === 'papers' && (
          <WorkingPapersPanel workingPapers={workingPapers} />
        )}
        {activeTab === 'evidence' && (
          evidenceComponent || (
            <GlassPanel style={{ textAlign: 'center', padding: 32 }}>
              <div style={{ fontFamily: F, fontSize: 12, color: COLORS.subtleText }}>
                Evidence Explorer is unavailable for this engagement.
              </div>
            </GlassPanel>
          )
        )}
      </div>
    </div>
  )
}

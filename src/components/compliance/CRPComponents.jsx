/**
 * CRP Components — Compliance Reports Premium Glass Redesign
 *
 * Tab structure: Posture | Frameworks | Reports | Evidence | Certification
 * All glass primitives imported from glass-primitives.jsx (single source of truth).
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import {
  GlassPanel,
  GlassPill,
  GlassTabBar,
  SectionHeader,
  ProgressRing,
  Sparkline,
  COLORS,
  STATUS_COLORS,
  PROTOCOL_COLORS,
  M,
  F,
} from './glass-primitives'

// ─── Empty State ─────────────────────────────────────────────────────────────

function EmptyGovernanceState({ title, message, icon = 'empty' }) {
  return (
    <div style={{
      backdropFilter: 'var(--glass-blur-strong)',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 12,
      padding: 32,
      textAlign: 'center',
      minHeight: 200,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{ fontSize: 32, opacity: 0.4 }}>○</div>
      <div style={{ fontFamily: F, fontSize: 14, fontWeight: 600, color: '#fff' }}>{title}</div>
      <div style={{ fontFamily: F, fontSize: 12, color: COLORS.subtleText, maxWidth: 400, lineHeight: 1.5 }}>
        {message}
      </div>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1: POSTURE DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════


export function PostureDashboard({ data = null }) {
  if (!data) {
    return (
      <EmptyGovernanceState
        title="No compliance data yet"
        message="Compliance posture will appear once governance events are recorded. Run a chat request, configure policies, or generate a compliance report to begin collecting evidence."
      />
    )
  }
  // overallScore is null when no compliance reports have been generated yet — that is
  // "not assessed", not a scored 0/"Weak". Never render it as a failing score.
  const notAssessed = data.overallScore == null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top row: Overall score + protocol status */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        {/* Overall Compliance Score */}
        <GlassPanel highlight={notAssessed ? undefined : (data.overallScore > 80 ? COLORS.green : COLORS.amber)}>
          <SectionHeader title="Compliance Posture" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {notAssessed ? (
              <div style={{
                width: 90, height: 90, borderRadius: '50%', flexShrink: 0,
                border: `2px dashed ${COLORS.subtleText}`, display: 'flex', alignItems: 'center',
                justifyContent: 'center',
              }}>
                <span style={{ fontFamily: M, fontSize: 22, fontWeight: 800, color: COLORS.subtleText }}>—</span>
              </div>
            ) : (
              <ProgressRing value={data.overallScore} size={90} strokeWidth={6} />
            )}
            <div>
              <div style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: notAssessed ? COLORS.subtleText : '#fff', marginBottom: 4 }}>
                {notAssessed ? 'No activity yet' : (data.overallScore >= 90 ? 'Strong' : data.overallScore >= 70 ? 'Moderate' : 'Weak')}
              </div>
              {notAssessed ? (
                <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, maxWidth: 160 }}>
                  Nothing to assess yet — no governed activity recorded
                </div>
              ) : (
                <>
                  <Sparkline data={data.trend} color={data.overallScore > 80 ? COLORS.green : COLORS.amber} width={80} height={24} />
                  <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 4 }}>
                    7-day trend
                  </div>
                </>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontFamily: M, fontSize: 9 }}>
            <span style={{ color: COLORS.subtleText }}>Last audit: <span style={{ color: '#fff', fontWeight: 600 }}>{data.lastAudit || 'never'}</span></span>
            <span style={{ color: COLORS.subtleText }}>Next: <span style={{ color: COLORS.amber, fontWeight: 600 }}>{data.nextAudit || '—'}</span></span>
          </div>
        </GlassPanel>

        {/* Protocol Health Grid */}
        <GlassPanel>
          <SectionHeader title="Protocol Health" subtitle="Governance stack status" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {Object.entries(data.protocols).map(([name, proto]) => (
              <GlassPanel key={name} hoverable style={{ padding: 12 }} highlight={PROTOCOL_COLORS[name]}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: proto.status === 'active' ? COLORS.green : COLORS.red,
                    boxShadow: proto.status === 'active' ? `0 0 8px ${COLORS.green}60` : 'none',
                  }} />
                  <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: PROTOCOL_COLORS[name] }}>{name}</span>
                </div>
                {name === 'AEE' && (
                  <>
                    <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#fff' }}>{proto.envelopes?.toLocaleString()}</div>
                    <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>envelopes • synced {proto.lastSync}</div>
                  </>
                )}
                {name === 'AOCL' && (
                  <>
                    <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#fff' }}>{proto.decisions?.toLocaleString()}</div>
                    <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>decisions • {proto.layersActive} layers active</div>
                  </>
                )}
                {name === 'VOLT' && (
                  <>
                    <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#fff' }}>{proto.runs?.toLocaleString()}</div>
                    <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>runs • {proto.integrity}% integrity</div>
                  </>
                )}
                {name === 'WARD' && (
                  <>
                    <div style={{ fontFamily: M, fontSize: 18, fontWeight: 800, color: '#fff' }}>{proto.witnesses?.toLocaleString()}</div>
                    <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                      witnesses • chain {proto.chainIntact ? <span style={{ color: COLORS.green }}>INTACT</span> : <span style={{ color: COLORS.red }}>BROKEN</span>}
                    </div>
                  </>
                )}
              </GlassPanel>
            ))}
          </div>
        </GlassPanel>
      </div>

      {/* Risk summary */}
      <GlassPanel>
        <SectionHeader title="Active Risks" subtitle={`${data.risks.length} items requiring attention`} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.risks.map((risk, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              borderRadius: 8, background: 'rgba(255,255,255,0.01)',
              borderLeft: `3px solid ${STATUS_COLORS[risk.severity === 'high' ? 'fail' : risk.severity === 'medium' ? 'warn' : 'pending']}`,
            }}>
              <GlassPill color={STATUS_COLORS[risk.severity === 'high' ? 'fail' : risk.severity === 'medium' ? 'warn' : 'pending']}>
                {risk.severity.toUpperCase()}
              </GlassPill>
              <span style={{ fontFamily: F, fontSize: 12, color: '#fff', flex: 1 }}>{risk.label}</span>
              {risk.protocol && (
                <GlassPill color={PROTOCOL_COLORS[risk.protocol]}>{risk.protocol}</GlassPill>
              )}
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2: FRAMEWORKS
// ═══════════════════════════════════════════════════════════════════════════════


export function FrameworksPanel({ frameworks = null }) {
  if (!frameworks || frameworks.length === 0) {
    return (
      <EmptyGovernanceState
        title="No framework coverage yet"
        message="Framework coverage (SOC 2, GDPR, HIPAA, ISO 27001, EU AI Act, ISO 42001, NIST AI RMF) will appear once compliance reports have been generated. Use the Reports tab to run your first assessment."
      />
    )
  }

  const [expanded, setExpanded] = useState(null)
  const hasAnyData = frameworks.some(f => f.coverage > 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader
        title="Regulatory Frameworks"
        subtitle={hasAnyData
          ? `${frameworks.length} frameworks tracked • ${frameworks.filter(f => f.status === 'compliant').length} compliant`
          : `${frameworks.length} frameworks available — generate a report to see coverage scores`}
      />

      {!hasAnyData && (
        <GlassPanel highlight={COLORS.cyan} style={{ textAlign: 'center', padding: 20 }}>
          <div style={{ fontFamily: M, fontSize: 12, color: '#fff', marginBottom: 4 }}>No compliance reports generated yet</div>
          <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText }}>
            Go to the Reports tab and generate a JSON report (free) to see framework coverage scores.
          </div>
        </GlassPanel>
      )}

      {frameworks.map((fw) => {
        const isExpanded = expanded === fw.id
        const statusColor = STATUS_COLORS[fw.status] || COLORS.white

        return (
          <GlassPanel
            key={fw.id}
            hoverable
            onClick={() => setExpanded(isExpanded ? null : fw.id)}
            highlight={isExpanded ? statusColor : undefined}
            style={{ padding: isExpanded ? 16 : 12 }}
          >
            {/* Framework header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <ProgressRing value={fw.coverage} size={52} strokeWidth={4} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>{fw.name}</span>
                  <GlassPill color={statusColor}>{fw.status.replace('_', ' ').toUpperCase()}</GlassPill>
                </div>
                <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>
                  {fw.controlsMet}/{fw.controlsTotal} controls met • Last audit: {fw.lastAudit}
                </div>
              </div>
              {/* Coverage bar */}
              <div style={{ width: 120 }}>
                <div style={{
                  height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: 3, width: `${fw.coverage}%`,
                    background: `linear-gradient(90deg, ${statusColor}, ${statusColor}80)`,
                    transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                  }} />
                </div>
              </div>
              <span style={{
                fontFamily: M, fontSize: 10, color: COLORS.subtleText,
                transform: `rotate(${isExpanded ? 180 : 0}deg)`,
                transition: 'transform 0.25s',
              }}>▼</span>
            </div>

            {/* Expanded sections */}
            {isExpanded && (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {fw.sections.map((sec) => {
                  const secColor = sec.coverage > 90 ? COLORS.green : sec.coverage >= 60 ? COLORS.amber : COLORS.red
                  return (
                    <div key={sec.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                      borderRadius: 8, background: 'rgba(255,255,255,0.01)',
                    }}>
                      <span style={{ fontFamily: M, fontSize: 10, color: COLORS.cyan, fontWeight: 600, minWidth: 80 }}>{sec.id}</span>
                      <span style={{ fontFamily: F, fontSize: 11, color: '#fff', flex: 1 }}>{sec.name}</span>
                      <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>{sec.met}/{sec.controls}</span>
                      <div style={{ width: 80 }}>
                        <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', borderRadius: 2, width: `${sec.coverage}%`,
                            background: secColor, transition: 'width 0.4s',
                          }} />
                        </div>
                      </div>
                      <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: secColor, minWidth: 32, textAlign: 'right' }}>{sec.coverage}%</span>
                    </div>
                  )
                })}
              </div>
            )}
          </GlassPanel>
        )
      })}
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3: REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

const FORMAT_NAMES = {
  json: 'JSON', soc2: 'SOC 2', hipaa: 'HIPAA', gdpr: 'GDPR', iso27001: 'ISO 27001', euAiAct: 'EU AI Act',
  iso42001: 'ISO 42001', nistAiRmf: 'NIST AI RMF',
}

const FREE_FORMATS = { json: true }

// AUD-WS-5: Assurance Pack export panel. Rendered in BOTH ReportsPanel
// branches: the export builds from live WARD/VOLT/audit evidence, so it must
// not disappear on orgs with no generated reports yet.
function AssurancePackPanel({
  onExportAssurancePack, exportingPack, packError, packSuccess,
  packFrom, packTo, onPackFromChange, onPackToChange,
}) {
  return (
    <GlassPanel>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, letterSpacing: 1.5, textTransform: 'uppercase' }}>Assurance Pack</div>
          <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, marginTop: 2 }}>
            Signed JSON bundle (WARD chain + VOLT bundles + audit events), independently verifiable with the included public key.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontFamily: M, fontSize: 9, color: COLORS.dimText, letterSpacing: 1, textTransform: 'uppercase' }}>Period</span>
            <input
              type="date"
              value={packFrom || ''}
              onChange={e => onPackFromChange?.(e.target.value)}
              aria-label="Assurance pack period start"
              style={{
                fontFamily: M, fontSize: 10, color: '#fff',
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, padding: '6px 8px', colorScheme: 'dark',
              }}
            />
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>to</span>
            <input
              type="date"
              value={packTo || ''}
              onChange={e => onPackToChange?.(e.target.value)}
              aria-label="Assurance pack period end"
              style={{
                fontFamily: M, fontSize: 10, color: '#fff',
                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8, padding: '6px 8px', colorScheme: 'dark',
              }}
            />
          </div>
          <GlassPanel
            hoverable={!exportingPack}
            onClick={exportingPack ? undefined : () => onExportAssurancePack?.()}
            highlight={exportingPack ? COLORS.cyan : undefined}
            style={{ padding: '8px 14px', cursor: exportingPack ? 'wait' : 'pointer' }}
          >
            <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: '#fff' }}>
              {exportingPack ? 'Building pack...' : 'Export Assurance Pack'}
            </span>
          </GlassPanel>
        </div>
      </div>
      {packError && (
        <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: `${COLORS.red}10`, border: `1px solid ${COLORS.red}20` }}>
          <span style={{ fontFamily: M, fontSize: 10, color: COLORS.red }}>{packError}</span>
        </div>
      )}
      {packSuccess && !packError && (
        <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: `${COLORS.green}10`, border: `1px solid ${COLORS.green}20` }}>
          <span style={{ fontFamily: M, fontSize: 10, color: COLORS.green }}>{packSuccess}</span>
        </div>
      )}
    </GlassPanel>
  )
}

export function ReportsPanel({
  reports = null,
  scheduledJobs = null,
  onGenerateReport,
  onDownloadReport,
  onCancelJob,
  generating,
  genError,
  genSuccess,
  licensed,
  onExportAssurancePack,
  exportingPack,
  packError,
  packSuccess,
  packFrom,
  packTo,
  onPackFromChange,
  onPackToChange,
}) {
  const reportsList = reports || []
  const jobsList = scheduledJobs || []

  if (!reports && !scheduledJobs) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <EmptyGovernanceState
          title="No reports generated yet"
          message="Generate your first compliance report using the controls below. Reports are built from server-side evidence (AEE envelopes, VOLT runs, WARD witnesses). JSON export is free; framework-specific reports require the AOCL Compliance Suite."
        />
        {/* Generate Report action bar — always shown even when no reports exist */}
        <GlassPanel>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, letterSpacing: 1.5, textTransform: 'uppercase' }}>Generate Report</div>
              <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, marginTop: 2 }}>
                {licensed ? 'Create a compliance report from server-side evidence' : 'JSON export is free. Premium formats require AOCL Compliance Suite.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <GlassPanel
                hoverable
                onClick={() => onGenerateReport?.('json')}
                highlight={generating === 'json' ? COLORS.cyan : undefined}
                style={{ padding: '8px 14px', cursor: 'pointer' }}
              >
                <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: '#fff' }}>
                  {generating === 'json' ? 'Generating...' : 'JSON'}
                </span>
                <GlassPill color={COLORS.green} style={{ marginLeft: 6 }}>FREE</GlassPill>
              </GlassPanel>
            </div>
          </div>
        </GlassPanel>
        {/* Export must be reachable before any report exists: it builds from
            live WARD/VOLT/audit evidence, not from report history. */}
        <AssurancePackPanel
          onExportAssurancePack={onExportAssurancePack}
          exportingPack={exportingPack}
          packError={packError}
          packSuccess={packSuccess}
          packFrom={packFrom}
          packTo={packTo}
          onPackFromChange={onPackFromChange}
          onPackToChange={onPackToChange}
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Generate Report action bar */}
      <GlassPanel>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, letterSpacing: 1.5, textTransform: 'uppercase' }}>Generate Report</div>
            <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, marginTop: 2 }}>
              {licensed ? 'Create a compliance report from server-side evidence' : 'JSON export is free. Premium formats require AOCL Compliance Suite.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {/* Always show JSON (free) first */}
            <GlassPanel
              hoverable
              onClick={() => onGenerateReport?.('json')}
              highlight={generating === 'json' ? COLORS.cyan : undefined}
              style={{ padding: '8px 14px', cursor: 'pointer' }}
            >
              <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: '#fff' }}>
                {generating === 'json' ? 'Generating...' : 'JSON'}
              </span>
              <GlassPill color={COLORS.green} style={{ marginLeft: 6 }}>FREE</GlassPill>
            </GlassPanel>
            {['soc2', 'gdpr', 'hipaa', 'iso27001', 'euAiAct', 'iso42001', 'nistAiRmf'].map(fmt => {
              const isLocked = !licensed
              return (
                <GlassPanel
                  key={fmt}
                  hoverable={!isLocked}
                  onClick={isLocked ? undefined : () => onGenerateReport?.(fmt)}
                  highlight={generating === fmt ? COLORS.cyan : undefined}
                  style={{
                    padding: '8px 14px',
                    cursor: isLocked ? 'not-allowed' : 'pointer',
                    opacity: isLocked ? 0.5 : 1,
                  }}
                >
                  <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: '#fff' }}>
                    {generating === fmt ? 'Generating...' : FORMAT_NAMES[fmt]}
                  </span>
                  {isLocked && <span style={{ fontFamily: M, fontSize: 9, color: COLORS.amber, marginLeft: 4 }}>🔒</span>}
                </GlassPanel>
              )
            })}
          </div>
        </div>
        {genError && (
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: `${COLORS.red}10`, border: `1px solid ${COLORS.red}20` }}>
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.red }}>{genError}</span>
          </div>
        )}
        {genSuccess && !genError && (
          <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: `${COLORS.green}10`, border: `1px solid ${COLORS.green}20` }}>
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.green }}>{genSuccess}</span>
          </div>
        )}
      </GlassPanel>

      {/* AUD-WS-5: Assurance Pack export — signed, self-contained JSON for external auditors */}
      <AssurancePackPanel
        onExportAssurancePack={onExportAssurancePack}
        exportingPack={exportingPack}
        packError={packError}
        packSuccess={packSuccess}
        packFrom={packFrom}
        packTo={packTo}
        onPackFromChange={onPackFromChange}
        onPackToChange={onPackToChange}
      />

      {/* Report History */}
      <GlassPanel>
        <SectionHeader title="Report History" subtitle={`${reportsList.length} reports generated`} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {reportsList.map((rpt) => {
            const statusColor = STATUS_COLORS[rpt.status] || COLORS.white
            return (
              <GlassPanel
                key={rpt.id}
                hoverable
                onClick={() => onDownloadReport?.(rpt)}
                style={{ padding: '10px 14px', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Format badge */}
                  <div style={{
                    minWidth: 70, padding: '4px 10px', borderRadius: 6, textAlign: 'center',
                    background: `${statusColor}10`, border: `1px solid ${statusColor}20`,
                    fontFamily: M, fontSize: 10, fontWeight: 700, color: statusColor,
                  }}>
                    {FORMAT_NAMES[rpt.format] || rpt.format}
                  </div>
                  {/* Score ring */}
                  <ProgressRing value={rpt.score} size={36} strokeWidth={3} />
                  {/* Details */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: F, fontSize: 12, color: '#fff', fontWeight: 600 }}>
                      {new Date(rpt.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginLeft: 8 }}>
                        {new Date(rpt.generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 2 }}>
                      {rpt.period} days • {rpt.traces.toLocaleString()} traces • {rpt.size}
                    </div>
                  </div>
                  {/* Status */}
                  <GlassPill color={statusColor}>{rpt.status.replace('_', ' ').toUpperCase()}</GlassPill>
                  {/* Download icon */}
                  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
              </GlassPanel>
            )
          })}
        </div>
      </GlassPanel>

      {/* Scheduled Jobs */}
      <GlassPanel>
        <SectionHeader
          title="Scheduled Reports"
          subtitle="Server-side automated generation"
          action={
            <GlassPill color={COLORS.green} style={{ fontSize: 10 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.green, boxShadow: `0 0 6px ${COLORS.green}60` }} />
              SERVER-SIDE
            </GlassPill>
          }
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {jobsList.map((job) => (
            <div key={job.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
              borderRadius: 8, background: 'rgba(255,255,255,0.01)',
            }}>
              <span style={{ fontFamily: M, fontSize: 11, fontWeight: 700, color: '#fff', minWidth: 70 }}>
                {FORMAT_NAMES[job.format]}
              </span>
              <GlassPill color={COLORS.purple}>{job.interval}</GlassPill>
              <div style={{ flex: 1, fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>
                Next: <span style={{ color: '#fff' }}>{new Date(job.nextRun).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                {job.lastRun && (
                  <span> • Last: {new Date(job.lastRun).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                )}
              </div>
              <GlassPill color={job.status === 'active' ? COLORS.green : COLORS.red}>
                {job.status.toUpperCase()}
              </GlassPill>
              <div
                onClick={(e) => { e.stopPropagation(); onCancelJob?.(job.id) }}
                style={{
                  padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                  fontFamily: M, fontSize: 9, color: COLORS.red, fontWeight: 600,
                  background: `${COLORS.red}10`, border: `1px solid ${COLORS.red}15`,
                }}
              >
                Cancel
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* CRP-AU-6: Roadmap features — honest about what's not yet implemented */}
      <GlassPanel style={{ opacity: 0.7 }}>
        <SectionHeader title="Coming Soon" subtitle="Features on the roadmap" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { label: 'PDF Export', desc: 'Auditor-ready PDF reports' },
            { label: 'Email Delivery', desc: 'Scheduled reports via email' },
            { label: 'Cloud Storage', desc: 'Auto-upload to S3/GCS' },
            { label: 'Rolling Bundles', desc: 'Evidence bundles during execution' },
          ].map(f => (
            <GlassPanel key={f.label} style={{ padding: '10px 14px', flex: '1 1 200px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: M, fontSize: 11, fontWeight: 600, color: '#fff' }}>{f.label}</span>
                <GlassPill color={COLORS.purple}>ROADMAP</GlassPill>
              </div>
              <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, marginTop: 4 }}>{f.desc}</div>
            </GlassPanel>
          ))}
        </div>
      </GlassPanel>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB 4: EVIDENCE EXPLORER
// ═══════════════════════════════════════════════════════════════════════════════

const EVIDENCE_TYPES = {
  'aocl.layer.complete': { label: 'AOCL Layer', color: PROTOCOL_COLORS.AOCL, icon: '◈' },
  'quox.chat.query': { label: 'Chat Query', color: '#38bdf8', icon: '◉' },
  'quox.chat.response': { label: 'Chat Response', color: '#06b6d4', icon: '◎' },
  'quox.tool.executed': { label: 'Tool Execution', color: '#f59e0b', icon: '⬡' },
  'volt.run.completed': { label: 'VOLT Run', color: PROTOCOL_COLORS.VOLT, icon: '▣' },
  'ward.witness': { label: 'WARD Witness', color: PROTOCOL_COLORS.WARD, icon: '◆' },
}


export function EvidenceExplorer({ data = null, onNavigate }) {
  if (!data) {
    return (
      <EmptyGovernanceState
        title="No evidence collected yet"
        message="AEE envelopes, VOLT runs, and WARD witnesses will appear here once governance events are recorded. Configure AOCL enforcement and run a chat request to generate your first evidence trail."
      />
    )
  }

  const [filter, setFilter] = useState('all')
  const [selectedEnvelope, setSelectedEnvelope] = useState(null)

  const filteredEnvelopes = filter === 'all'
    ? data.envelopes
    : data.envelopes.filter(e => e.intent.startsWith(filter))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Evidence summary cards — click to open standalone deep-dive views */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        {/* AEE Envelopes */}
        <GlassPanel highlight={PROTOCOL_COLORS.AEE} hoverable onClick={() => onNavigate?.('/evidence')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: PROTOCOL_COLORS.AEE }}>AEE</span>
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>Envelopes</span>
          </div>
          <div style={{ fontFamily: M, fontSize: 24, fontWeight: 800, color: '#fff' }}>
            {data.envelopes.length.toLocaleString()}
          </div>
          <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 4 }}>
            {data.envelopes.filter(e => e.wardWitnessed).length} WARD-witnessed
          </div>
        </GlassPanel>

        {/* VOLT Runs */}
        <GlassPanel highlight={PROTOCOL_COLORS.VOLT} hoverable onClick={() => onNavigate?.('/volt')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: PROTOCOL_COLORS.VOLT }}>VOLT</span>
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>Runs</span>
          </div>
          <div style={{ fontFamily: M, fontSize: 24, fontWeight: 800, color: '#fff' }}>
            {data.voltRuns.length.toLocaleString()}
          </div>
          <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 4 }}>
            {data.voltRuns.filter(r => r.integrityStatus === 'INTACT').length}/{data.voltRuns.length} chains intact
          </div>
        </GlassPanel>

        {/* WARD Chain */}
        <GlassPanel highlight={PROTOCOL_COLORS.WARD} hoverable onClick={() => onNavigate?.('/ward')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontFamily: M, fontSize: 12, fontWeight: 700, color: PROTOCOL_COLORS.WARD }}>WARD</span>
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>Witness Chain</span>
          </div>
          <div style={{ fontFamily: M, fontSize: 24, fontWeight: 800, color: '#fff' }}>
            {data.wardChain.totalEntries.toLocaleString()}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: data.wardChain.chainStatus === 'INTACT' ? COLORS.green : COLORS.red,
              boxShadow: `0 0 6px ${data.wardChain.chainStatus === 'INTACT' ? COLORS.green : COLORS.red}60`,
            }} />
            <span style={{ fontFamily: M, fontSize: 9, color: data.wardChain.chainStatus === 'INTACT' ? COLORS.green : COLORS.red, fontWeight: 600 }}>
              {data.wardChain.chainStatus}
            </span>
            <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
              • {data.wardChain.signedTips} signed tips
            </span>
          </div>
        </GlassPanel>
      </div>

      {/* WARD Source Breakdown */}
      <GlassPanel>
        <SectionHeader title="WARD Source Breakdown" />
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {Object.entries(data.wardChain.sourceBreakdown).map(([source, count]) => {
            const total = Object.values(data.wardChain.sourceBreakdown).reduce((a, b) => a + b, 0)
            const pct = Math.round((count / total) * 100)
            return (
              <div key={source} style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: PROTOCOL_COLORS[source] || '#fff' }}>{source}</span>
                  <span style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>{count.toLocaleString()} ({pct}%)</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 3, width: `${pct}%`,
                    background: PROTOCOL_COLORS[source] || '#fff',
                    transition: 'width 0.6s',
                  }} />
                </div>
              </div>
            )
          })}
        </div>
      </GlassPanel>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <GlassPanel
          hoverable onClick={() => setFilter('all')}
          style={{ padding: '6px 12px', cursor: 'pointer', ...(filter === 'all' ? { background: 'linear-gradient(145deg, rgba(168,85,247,0.12) 0%, rgba(56,189,248,0.04) 100%)' } : {}) }}
        >
          <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: filter === 'all' ? '#fff' : COLORS.subtleText }}>All</span>
        </GlassPanel>
        {Object.entries(EVIDENCE_TYPES).map(([key, type]) => (
          <GlassPanel
            key={key} hoverable onClick={() => setFilter(key.split('.').slice(0, 2).join('.'))}
            style={{ padding: '6px 12px', cursor: 'pointer', ...(filter === key.split('.').slice(0, 2).join('.') ? { background: `${type.color}10` } : {}) }}
          >
            <span style={{ fontFamily: M, fontSize: 10, fontWeight: 600, color: filter === key.split('.').slice(0, 2).join('.') ? type.color : COLORS.subtleText }}>
              {type.icon} {type.label}
            </span>
          </GlassPanel>
        ))}
      </div>

      {/* Envelope list */}
      <GlassPanel>
        <SectionHeader title="Evidence Timeline" subtitle={`${filteredEnvelopes.length} items`} />
        <div style={{ position: 'relative', paddingLeft: 24 }}>
          {/* Timeline line */}
          <div style={{ position: 'absolute', left: 10, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.06)' }} />

          {filteredEnvelopes.map((env, i) => {
            const type = EVIDENCE_TYPES[env.intent] || { label: env.intent, color: '#fff', icon: '•' }
            const isSelected = selectedEnvelope === env.id
            return (
              <div
                key={env.id}
                onClick={() => setSelectedEnvelope(isSelected ? null : env.id)}
                style={{
                  position: 'relative', marginBottom: 8, cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {/* Timeline dot */}
                <div style={{
                  position: 'absolute', left: -18, top: 12,
                  width: 8, height: 8, borderRadius: '50%',
                  background: type.color, opacity: 0.8,
                  boxShadow: `0 0 6px ${type.color}44`,
                }} />
                <div style={{ position: 'absolute', left: -10, top: 15, width: 10, height: 1, background: `${type.color}30` }} />

                <GlassPanel
                  style={{
                    padding: '8px 12px',
                    borderTopColor: isSelected ? `${type.color}40` : 'rgba(255,255,255,0.06)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <GlassPill color={type.color}>{type.icon} {type.label}</GlassPill>
                    <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                      {new Date(env.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>{env.from} → {env.to}</span>
                    {env.wardWitnessed && (
                      <GlassPill color={PROTOCOL_COLORS.WARD} style={{ fontSize: 8 }}>WARD ✓</GlassPill>
                    )}
                    {env.voltLinked && (
                      <GlassPill color={PROTOCOL_COLORS.VOLT} style={{ fontSize: 8 }}>VOLT ✓</GlassPill>
                    )}
                  </div>

                  {/* Expanded detail */}
                  {isSelected && (
                    <div style={{ marginTop: 8, padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
                        <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                          ID: <span style={{ color: COLORS.cyan }}>{env.id}</span>
                        </div>
                        <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                          Intent: <span style={{ color: '#fff' }}>{env.intent}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </GlassPanel>
              </div>
            )
          })}
        </div>
      </GlassPanel>
    </div>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB 5: CERTIFICATION TRACKER
// ═══════════════════════════════════════════════════════════════════════════════


export function CertificationTracker({ data = null }) {
  if (!data) {
    return (
      <EmptyGovernanceState
        title="No certifications yet"
        message="VOLT certification tiers (Bronze → Silver → Gold → Platinum) will appear once evidence bundles have been signed and attested. Complete a chat run to generate your first certifiable evidence bundle."
      />
    )
  }

  const currentIdx = data.tiers.findIndex(t => t.id === data.currentTier)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Tier progression */}
      <GlassPanel>
        <SectionHeader title="VOLT Certification Tiers" />

        {/* Visual tier track */}
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, marginBottom: 16 }}>
          {data.tiers.map((tier, i) => {
            const isCurrent = i === currentIdx
            const isAchieved = i <= currentIdx
            const metCount = tier.requirements.filter(r => r.met).length

            return (
              <div key={tier.id} style={{ flex: 1, position: 'relative' }}>
                {/* Connector line */}
                {i > 0 && (
                  <div style={{
                    position: 'absolute', left: -6, top: '50%', width: 14, height: 2, zIndex: 2,
                    background: isAchieved ? `${tier.color}60` : 'rgba(255,255,255,0.06)',
                  }} />
                )}

                <GlassPanel
                  highlight={isCurrent ? tier.color : undefined}
                  style={{
                    padding: 14, height: '100%',
                    opacity: isAchieved ? 1 : 0.5,
                    ...(isCurrent ? {
                      boxShadow: `0 0 30px ${tier.color}20, 0 5px 19px rgba(0,0,0,0.35), inset 0 1px 2px rgba(255,255,255,0.08)`,
                    } : {}),
                  }}
                >
                  <div style={{ textAlign: 'center', marginBottom: 10 }}>
                    <div style={{
                      fontSize: 28, color: tier.color,
                      opacity: isCurrent ? 1 : 0.5,
                      textShadow: isCurrent ? `0 0 16px ${tier.color}60` : 'none',
                    }}>
                      {tier.icon}
                    </div>
                    <div style={{ fontFamily: M, fontSize: 13, fontWeight: 700, color: tier.color, marginTop: 4 }}>{tier.name}</div>
                    <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 2 }}>{tier.type}</div>
                  </div>

                  {/* Requirements */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {tier.requirements.map((req, j) => (
                      <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, fontFamily: M }}>
                        <span style={{ color: req.met ? COLORS.green : COLORS.subtleText, fontSize: 11 }}>
                          {req.met ? '✓' : '○'}
                        </span>
                        <span style={{ color: req.met ? '#fff' : COLORS.subtleText }}>{req.label}</span>
                      </div>
                    ))}
                  </div>

                  {/* Progress indicator */}
                  <div style={{ marginTop: 8 }}>
                    <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 2,
                        width: `${(metCount / tier.requirements.length) * 100}%`,
                        background: tier.color,
                        transition: 'width 0.6s',
                      }} />
                    </div>
                    <div style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, textAlign: 'center', marginTop: 3 }}>
                      {metCount}/{tier.requirements.length}
                    </div>
                  </div>
                </GlassPanel>
              </div>
            )
          })}
        </div>

        {/* Current status badge */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: data.tiers[currentIdx]?.color, fontFamily: M }}>
            Your certification: {data.tiers[currentIdx]?.name}
          </span>
          <GlassPill color={PROTOCOL_COLORS.VOLT} style={{ fontSize: 10 }}>VOLT VERIFIED</GlassPill>
        </div>
      </GlassPanel>

      {/* Next tier requirements */}
      <GlassPanel>
        <SectionHeader title="Path to Next Tier" subtitle="Requirements for Platinum certification" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.nextRequirements.map((req, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px',
              borderRadius: 8, background: 'rgba(255,255,255,0.01)',
              borderLeft: `3px solid ${req.progress >= 100 ? COLORS.green : req.blocking ? COLORS.amber : 'rgba(255,255,255,0.1)'}`,
            }}>
              <span style={{ fontFamily: F, fontSize: 11, color: '#fff', flex: 1 }}>{req.label}</span>
              {req.blocking && <GlassPill color={COLORS.amber}>BLOCKING</GlassPill>}
              <div style={{ width: 100 }}>
                <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    width: `${req.progress}%`,
                    background: req.progress >= 100 ? COLORS.green : req.progress > 0 ? COLORS.cyan : 'rgba(255,255,255,0.1)',
                    transition: 'width 0.6s',
                  }} />
                </div>
              </div>
              <span style={{ fontFamily: M, fontSize: 10, fontWeight: 700, color: req.progress > 0 ? '#fff' : COLORS.subtleText, minWidth: 32, textAlign: 'right' }}>
                {req.progress}%
              </span>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* Certification history */}
      <GlassPanel>
        <SectionHeader title="Certification History" />
        <div style={{ position: 'relative', paddingLeft: 24 }}>
          <div style={{ position: 'absolute', left: 10, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.06)' }} />
          {data.certHistory.map((entry, i) => {
            const tier = data.tiers.find(t => t.id === entry.tier)
            return (
              <div key={i} style={{ position: 'relative', marginBottom: 10 }}>
                <div style={{
                  position: 'absolute', left: -18, top: 8,
                  width: 10, height: 10, borderRadius: '50%',
                  background: tier?.color || '#fff', opacity: 0.8,
                  boxShadow: `0 0 8px ${tier?.color || '#fff'}44`,
                }} />
                <div style={{ paddingLeft: 6 }}>
                  <div style={{ fontFamily: M, fontSize: 10, color: tier?.color || '#fff', fontWeight: 700 }}>
                    {tier?.icon} {tier?.name} — {entry.date}
                  </div>
                  <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, marginTop: 2 }}>{entry.event}</div>
                </div>
              </div>
            )
          })}
        </div>
      </GlassPanel>

      {/* Cross-link to full Certification view */}
      <GlassPanel hoverable onClick={() => window.location.hash = ''} style={{ textAlign: 'center', padding: 12, cursor: 'pointer' }}>
        <a href="/certification" style={{ fontFamily: M, fontSize: 11, color: COLORS.cyan, textDecoration: 'none' }}>
          Open full Certification Dashboard →
        </a>
      </GlassPanel>
    </div>
  )
}


// ════════════════════════════════════════════════���══════════════════════════════
// MAIN: COMPLIANCE COMMAND CENTER (Full-page orchestrator)
// ═══════════════════════════════════════════════════════════════════════════════

const CRP_TABS = [
  { id: 'posture', label: 'Posture', icon: '◈' },
  { id: 'frameworks', label: 'Frameworks', icon: '⬡' },
  { id: 'reports', label: 'Reports', icon: '▣' },
  { id: 'evidence', label: 'Evidence', icon: '◉' },
  { id: 'certification', label: 'Certification', icon: '★' },
]

/**
 * ComplianceCommandCenter — the top-level CRP page component.
 *
 * Wire up by passing real data from CRP-BE endpoints:
 * - postureData: from GET /compliance/stats + /ward/stats + /volt/stats
 * - frameworks: from generateComplianceReport() for each framework
 * - reports: from GET /compliance/reports (server-side history)
 * - evidenceData: from GET /compliance/envelopes + /volt/runs + /ward/stats
 * - certData: from VOLT certification assessment
 */
export function ComplianceCommandCenter({
  postureData,
  frameworks,
  reports,
  scheduledJobs,
  evidenceData,
  certData,
  onGenerateReport,
  onDownloadReport,
  onCancelJob,
}) {
  const [activeTab, setActiveTab] = useState('posture')

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      height: '100%', minHeight: 0,
    }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: F, fontSize: 20, fontWeight: 800, color: '#fff', margin: 0 }}>
            Compliance Command Center
          </h1>
          <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginTop: 2 }}>
            Governance stack • VOLT + WARD + AOCL + AEE
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <GlassPill color={COLORS.green}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: COLORS.green, boxShadow: `0 0 6px ${COLORS.green}60` }} />
            ALL PROTOCOLS ACTIVE
          </GlassPill>
        </div>
      </div>

      {/* Tab bar */}
      <GlassTabBar tabs={CRP_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Tab content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'posture' && <PostureDashboard data={postureData} />}
        {activeTab === 'frameworks' && <FrameworksPanel frameworks={frameworks} />}
        {activeTab === 'reports' && (
          <ReportsPanel
            reports={reports}
            scheduledJobs={scheduledJobs}
            onGenerateReport={onGenerateReport}
            onDownloadReport={onDownloadReport}
            onCancelJob={onCancelJob}
          />
        )}
        {activeTab === 'evidence' && <EvidenceExplorer data={evidenceData} />}
        {activeTab === 'certification' && <CertificationTracker data={certData} />}
      </div>
    </div>
  )
}

// Default export for easy lazy loading
export default ComplianceCommandCenter

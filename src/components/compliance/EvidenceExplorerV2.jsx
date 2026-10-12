/**
 * EvidenceExplorerV2 — Control-Anchored Evidence Navigator
 *
 * Dual-pane layout: framework tree (left) + evidence timeline (right).
 * Chain-of-custody view traces AEE → VOLT → WARD for each evidence item.
 * Deep-linked via URL search params.
 *
 * AUD-UX Phase 4
 */

import { useState, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  GlassPanel,
  GlassPill,
  SectionHeader,
  COLORS,
  PROTOCOL_COLORS,
  M,
  F,
} from './glass-primitives'

const FRAMEWORK_META = {
  soc2: { label: 'SOC 2', color: '#38bdf8' },
  hipaa: { label: 'HIPAA', color: '#30ff90' },
  gdpr: { label: 'GDPR', color: '#a855f7' },
  iso27001: { label: 'ISO 27001', color: '#06b6d4' },
  euAiAct: { label: 'EU AI Act', color: '#f59e0b' },
}

const DATE_PRESETS = [
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: 'all', label: 'All', days: null },
]

function FrameworkTree({
  frameworks = {},
  evidenceCounts = {},
  selectedFramework,
  selectedControl,
  onSelectControl,
  onToggleFramework,
  expandedFrameworks = {},
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 1, padding: '4px 8px' }}>
        FRAMEWORKS
      </div>
      {Object.entries(frameworks).map(([fwId, fw]) => {
        const expanded = expandedFrameworks[fwId]
        const meta = FRAMEWORK_META[fwId] || { label: fwId, color: '#fff' }
        const controls = fw.mapping ? Object.entries(fw.mapping) : []
        const totalEvidence = controls.reduce((sum, [ctrlId]) => sum + (evidenceCounts[`${fwId}:${ctrlId}`] || 0), 0)

        return (
          <div key={fwId}>
            <div
              onClick={() => onToggleFramework(fwId)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 8px', borderRadius: 4, cursor: 'pointer',
                background: selectedFramework === fwId ? 'rgba(168,85,247,0.08)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                  {expanded ? '▼' : '▶'}
                </span>
                <span style={{ fontFamily: M, fontSize: 10, color: meta.color, fontWeight: 600 }}>
                  {meta.label}
                </span>
              </div>
              <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                {totalEvidence}
              </span>
            </div>

            {expanded && controls.map(([ctrlId, ctrl]) => {
              const count = evidenceCounts[`${fwId}:${ctrlId}`] || 0
              const isSelected = selectedFramework === fwId && selectedControl === ctrlId
              const status = count > (ctrl.requiredTraceCount || 0) ? 'evidenced'
                : count > 0 ? 'partial' : 'gap'
              const statusColor = status === 'evidenced' ? COLORS.green
                : status === 'partial' ? COLORS.amber : COLORS.red

              return (
                <div
                  key={ctrlId}
                  onClick={() => onSelectControl(fwId, ctrlId)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '4px 8px 4px 24px', borderRadius: 4, cursor: 'pointer',
                    background: isSelected ? 'rgba(56,189,248,0.08)' : 'transparent',
                    borderLeft: isSelected ? `2px solid ${COLORS.cyan}` : '2px solid transparent',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: M, fontSize: 9, color: isSelected ? '#fff' : COLORS.subtleText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={{ color: statusColor, marginRight: 4 }}>
                        {status === 'evidenced' ? '●' : status === 'partial' ? '◐' : '○'}
                      </span>
                      {ctrlId}
                    </div>
                    <div style={{ fontFamily: F, fontSize: 8, color: COLORS.subtleText, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {ctrl.name}
                    </div>
                  </div>
                  <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginLeft: 4 }}>
                    {count}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function ChainOfCustody({ chain }) {
  if (!chain) return null

  const nodes = [
    chain.aee ? { label: 'AEE', id: chain.aee.id?.slice(0, 8), color: PROTOCOL_COLORS.AEE, detail: chain.aee.intent } : null,
    chain.volt ? { label: 'VOLT', id: chain.volt.run_id?.slice(0, 8), color: PROTOCOL_COLORS.VOLT, detail: chain.volt.integrity } : null,
    chain.ward ? { label: 'WARD', id: chain.ward.tip_id?.slice(0, 8), color: PROTOCOL_COLORS.WARD, detail: chain.ward.signed ? 'Signed' : 'Unsigned' } : null,
  ].filter(Boolean)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 0' }}>
      {nodes.map((node, i) => (
        <div key={node.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{
            padding: '4px 8px', borderRadius: 4,
            background: `${node.color}12`, border: `1px solid ${node.color}30`,
          }}>
            <div style={{ fontFamily: M, fontSize: 8, color: node.color, fontWeight: 700 }}>{node.label}</div>
            <div style={{ fontFamily: M, fontSize: 7, color: COLORS.subtleText }}>{node.id}</div>
          </div>
          {i < nodes.length - 1 && (
            <span style={{ fontFamily: M, fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>→</span>
          )}
        </div>
      ))}
    </div>
  )
}

function EvidenceTimeline({ items = [], onToggleChain, expandedChainId }) {
  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 24, opacity: 0.3, marginBottom: 8 }}>◉</div>
        <div style={{ fontFamily: F, fontSize: 12, color: COLORS.subtleText }}>
          Select a control from the framework tree to view linked evidence
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map(item => {
        const isExpanded = expandedChainId === item.id
        return (
          <GlassPanel key={item.id} style={{ padding: '8px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <GlassPill color={PROTOCOL_COLORS[item.protocol] || COLORS.cyan}>
                {item.protocol || 'AEE'}
              </GlassPill>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>
                  {item.intent || item.type || 'Event'}
                </div>
                <div style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText }}>
                  {item.ts ? new Date(item.ts).toLocaleString() : '—'}
                </div>
              </div>
              {item.wardWitnessed && (
                <GlassPill color={PROTOCOL_COLORS.WARD} style={{ fontSize: 7 }}>WARD ✓</GlassPill>
              )}
              <button
                onClick={() => onToggleChain(item.id)}
                style={{
                  fontFamily: M, fontSize: 8, color: COLORS.cyan,
                  background: 'none', border: 'none', cursor: 'pointer',
                }}
              >
                {isExpanded ? '▼ chain' : '▶ chain'}
              </button>
            </div>

            {isExpanded && (
              <ChainOfCustody chain={item.chain} />
            )}
          </GlassPanel>
        )
      })}
    </div>
  )
}

export default function EvidenceExplorerV2({
  frameworks = {},
  evidence = [],
  evidenceCounts = {},
  onNavigate,
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedFramework = searchParams.get('fw') || null
  const selectedControl = searchParams.get('ctrl') || null

  const [expandedFrameworks, setExpandedFrameworks] = useState({})
  const [expandedChainId, setExpandedChainId] = useState(null)
  const [dateRange, setDateRange] = useState('30d')
  const [frameworkFilter, setFrameworkFilter] = useState(null)

  const handleSelectControl = useCallback((fwId, ctrlId) => {
    setSearchParams(prev => {
      prev.set('fw', fwId)
      prev.set('ctrl', ctrlId)
      return prev
    }, { replace: true })
  }, [setSearchParams])

  const handleToggleFramework = useCallback((fwId) => {
    setExpandedFrameworks(prev => ({ ...prev, [fwId]: !prev[fwId] }))
  }, [])

  const handleToggleChain = useCallback((itemId) => {
    setExpandedChainId(prev => prev === itemId ? null : itemId)
  }, [])

  const filteredEvidence = useMemo(() => {
    let items = evidence

    if (selectedFramework && selectedControl) {
      items = items.filter(e =>
        e.frameworkControls?.some(fc => fc.framework === selectedFramework && fc.control === selectedControl)
      )
    }

    if (frameworkFilter) {
      items = items.filter(e =>
        e.frameworkControls?.some(fc => fc.framework === frameworkFilter)
      )
    }

    if (dateRange !== 'all') {
      const preset = DATE_PRESETS.find(p => p.id === dateRange)
      if (preset?.days) {
        const cutoff = new Date(Date.now() - preset.days * 86400000).toISOString()
        items = items.filter(e => e.ts && new Date(e.ts) >= new Date(cutoff))
      }
    }

    return items
  }, [evidence, selectedFramework, selectedControl, frameworkFilter, dateRange])

  const displayFrameworks = useMemo(() => {
    if (frameworkFilter) {
      const fw = frameworks[frameworkFilter]
      return fw ? { [frameworkFilter]: fw } : {}
    }
    return frameworks
  }, [frameworks, frameworkFilter])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>FRAMEWORK:</span>
        <button
          onClick={() => setFrameworkFilter(null)}
          style={{
            padding: '3px 8px', borderRadius: 4, border: 'none',
            fontFamily: M, fontSize: 9, color: !frameworkFilter ? '#fff' : COLORS.subtleText,
            background: !frameworkFilter ? 'rgba(168,85,247,0.12)' : 'transparent',
            cursor: 'pointer',
          }}
        >
          ALL
        </button>
        {Object.entries(FRAMEWORK_META).map(([id, meta]) => (
          <button
            key={id}
            onClick={() => setFrameworkFilter(frameworkFilter === id ? null : id)}
            style={{
              padding: '3px 8px', borderRadius: 4, border: 'none',
              fontFamily: M, fontSize: 9,
              color: frameworkFilter === id ? meta.color : COLORS.subtleText,
              background: frameworkFilter === id ? `${meta.color}12` : 'transparent',
              cursor: 'pointer',
            }}
          >
            {meta.label}
          </button>
        ))}

        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)', margin: '0 4px' }} />

        <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>PERIOD:</span>
        {DATE_PRESETS.map(p => (
          <button
            key={p.id}
            onClick={() => setDateRange(p.id)}
            style={{
              padding: '3px 8px', borderRadius: 4, border: 'none',
              fontFamily: M, fontSize: 9,
              color: dateRange === p.id ? '#fff' : COLORS.subtleText,
              background: dateRange === p.id ? 'rgba(56,189,248,0.12)' : 'transparent',
              cursor: 'pointer',
            }}
          >
            {p.label}
          </button>
        ))}

        <span style={{ marginLeft: 'auto', fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
          {filteredEvidence.length} items
        </span>
      </div>

      {/* Dual-pane layout */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '260px 1fr',
        gap: 10, flex: 1, minHeight: 0,
      }}>
        {/* Left pane: framework tree */}
        <GlassPanel style={{ padding: 8, overflowY: 'auto' }}>
          <FrameworkTree
            frameworks={displayFrameworks}
            evidenceCounts={evidenceCounts}
            selectedFramework={selectedFramework}
            selectedControl={selectedControl}
            onSelectControl={handleSelectControl}
            onToggleFramework={handleToggleFramework}
            expandedFrameworks={expandedFrameworks}
          />
        </GlassPanel>

        {/* Right pane: evidence timeline */}
        <GlassPanel style={{ padding: 10, overflowY: 'auto' }}>
          {selectedControl && (
            <SectionHeader
              title={`Evidence for ${selectedControl}`}
              subtitle={`${filteredEvidence.length} evidence items`}
            />
          )}
          <EvidenceTimeline
            items={filteredEvidence}
            onToggleChain={handleToggleChain}
            expandedChainId={expandedChainId}
          />
        </GlassPanel>
      </div>
    </div>
  )
}

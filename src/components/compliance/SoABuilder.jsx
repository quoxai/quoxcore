/**
 * SoA Builder — ISO 27001:2022 Statement of Applicability
 *
 * Grouped filterable table for 93 Annex A controls with inline editing,
 * tri-state applicability, progress header, bulk operations, and auto-save.
 *
 * AUD-UX Phase 1
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  GlassPanel,
  GlassPill,
  SectionHeader,
  ProgressRing,
  COLORS,
  M,
  F,
} from './glass-primitives'

const GROUP_NAMES = {
  'A.5': 'Organisational Controls',
  'A.6': 'People Controls',
  'A.7': 'Physical Controls',
  'A.8': 'Technological Controls',
}

const GROUPS = ['A.5', 'A.6', 'A.7', 'A.8']

const STATUS_OPTIONS = [
  { value: 'not_started', label: 'Not Started', color: 'rgba(255,255,255,0.3)' },
  { value: 'in_progress', label: 'In Progress', color: COLORS.cyan },
  { value: 'implemented', label: 'Implemented', color: COLORS.green },
  { value: 'verified', label: 'Verified', color: COLORS.purple },
  { value: 'gap', label: 'Gap', color: COLORS.red },
]

const APPLICABILITY_OPTIONS = [
  { value: 'yes', label: 'Yes', color: COLORS.green },
  { value: 'no', label: 'N/A', color: 'rgba(255,255,255,0.4)' },
  { value: 'inherited', label: 'Inherited', color: COLORS.cyan },
]

function ApplicabilityToggle({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {APPLICABILITY_OPTIONS.map(opt => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(active ? null : opt.value)}
            style={{
              padding: '3px 8px', borderRadius: 4, border: 'none',
              fontFamily: M, fontSize: 9, fontWeight: active ? 700 : 500,
              color: active ? '#fff' : 'rgba(255,255,255,0.5)',
              background: active ? `${opt.color}25` : 'transparent',
              borderBottom: active ? `2px solid ${opt.color}` : '2px solid transparent',
              cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function StatusDropdown({ value, onChange }) {
  const opt = STATUS_OPTIONS.find(o => o.value === value) || STATUS_OPTIONS[0]
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontFamily: M, fontSize: 9, fontWeight: 600,
        color: opt.color, background: 'rgba(0,0,0,0.3)',
        border: `1px solid ${opt.color}30`, borderRadius: 4,
        padding: '3px 6px', cursor: 'pointer', outline: 'none',
      }}
    >
      {STATUS_OPTIONS.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function InlineTextInput({ value, onChange, placeholder = '' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const ref = useRef(null)

  useEffect(() => { setDraft(value) }, [value])

  const commit = useCallback(() => {
    setEditing(false)
    if (draft !== value) onChange(draft)
  }, [draft, value, onChange])

  if (!editing) {
    return (
      <div
        onClick={() => { setEditing(true); setTimeout(() => ref.current?.focus(), 0) }}
        style={{
          fontFamily: F, fontSize: 10, color: value ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)',
          cursor: 'text', minHeight: 20, padding: '2px 4px', borderRadius: 3,
          border: '1px solid transparent',
        }}
        title="Click to edit"
      >
        {value || placeholder}
      </div>
    )
  }

  return (
    <textarea
      ref={ref}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Escape') { setDraft(value); setEditing(false) } }}
      rows={2}
      style={{
        width: '100%', fontFamily: F, fontSize: 10, color: '#fff',
        background: 'rgba(0,0,0,0.3)', border: `1px solid ${COLORS.cyan}40`,
        borderRadius: 3, padding: '3px 5px', outline: 'none', resize: 'vertical',
      }}
      placeholder={placeholder}
    />
  )
}

function ControlRow({ control, definition, onChange }) {
  const statusOpt = STATUS_OPTIONS.find(o => o.value === control.implementation_status) || STATUS_OPTIONS[0]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '65px 1fr 110px 100px 1fr',
        gap: 8, alignItems: 'center',
        padding: '6px 10px', borderRadius: 6,
        background: control.auto_detected ? 'rgba(56,189,248,0.03)' : 'transparent',
        borderLeft: control.applicable === 'yes'
          ? `3px solid ${COLORS.green}60`
          : control.applicable === 'no'
            ? '3px solid rgba(255,255,255,0.1)'
            : '3px solid transparent',
        transition: 'background 0.15s',
      }}
      role="row"
    >
      <div style={{ fontFamily: M, fontSize: 10, color: COLORS.cyan, fontWeight: 600 }}>
        {control.control_id}
      </div>

      <div>
        <div style={{ fontFamily: F, fontSize: 10, color: '#fff', fontWeight: 500, lineHeight: 1.3 }}>
          {definition.name}
        </div>
        {control.auto_detected && (
          <GlassPill color={COLORS.cyan} style={{ fontSize: 7, marginTop: 2 }}>AUTO-DETECTED</GlassPill>
        )}
      </div>

      <ApplicabilityToggle
        value={control.applicable}
        onChange={val => onChange({ ...control, applicable: val })}
      />

      <StatusDropdown
        value={control.implementation_status}
        onChange={val => onChange({ ...control, implementation_status: val })}
      />

      <InlineTextInput
        value={control.justification}
        onChange={val => onChange({ ...control, justification: val })}
        placeholder="Justification..."
      />
    </div>
  )
}

export default function SoABuilder({
  assessmentId,
  controls: initialControls = null,
  controlDefinitions = [],
  status: initialStatus = 'draft',
  onSave,
  onStatusChange,
  readOnly = false,
}) {
  const [controls, setControls] = useState(initialControls || [])
  const [status, setStatus] = useState(initialStatus)
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const [filterGroup, setFilterGroup] = useState(null)
  const [filterStatus, setFilterStatus] = useState(null)
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const saveTimer = useRef(null)

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])
  useEffect(() => { if (initialControls) setControls(initialControls) }, [initialControls])
  useEffect(() => { setStatus(initialStatus) }, [initialStatus])

  const debouncedSave = useCallback((updatedControls) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      onSave?.(updatedControls)
    }, 1000)
  }, [onSave])

  const handleControlChange = useCallback((updated) => {
    if (readOnly) return
    setControls(prev => {
      const next = prev.map(c => c.control_id === updated.control_id ? updated : c)
      debouncedSave(next)
      return next
    })
  }, [readOnly, debouncedSave])

  const toggleGroup = useCallback((group) => {
    setCollapsedGroups(prev => ({ ...prev, [group]: !prev[group] }))
  }, [])

  const defMap = useMemo(() => {
    const m = {}
    for (const d of controlDefinitions) m[d.id] = d
    return m
  }, [controlDefinitions])

  const filteredControls = useMemo(() => {
    return controls.filter(c => {
      const def = defMap[c.control_id]
      if (!def) return false
      if (filterGroup && def.group !== filterGroup) return false
      if (filterStatus === 'assessed' && c.applicable === null) return false
      if (filterStatus === 'pending' && c.applicable !== null) return false
      if (filterStatus === 'gap' && c.implementation_status !== 'gap') return false
      if (search) {
        const q = search.toLowerCase()
        if (!def.name.toLowerCase().includes(q) && !c.control_id.toLowerCase().includes(q) && !(c.justification || '').toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [controls, filterGroup, filterStatus, search, defMap])

  const stats = useMemo(() => {
    const total = controls.length
    const assessed = controls.filter(c => c.applicable !== null).length
    const applicable = controls.filter(c => c.applicable === 'yes').length
    const notApplicable = controls.filter(c => c.applicable === 'no').length
    const inherited = controls.filter(c => c.applicable === 'inherited').length
    const implemented = controls.filter(c => c.implementation_status === 'implemented' || c.implementation_status === 'verified').length
    const gaps = controls.filter(c => c.implementation_status === 'gap').length
    const autoDetected = controls.filter(c => c.auto_detected).length
    return { total, assessed, applicable, notApplicable, inherited, implemented, gaps, autoDetected }
  }, [controls])

  const handleBulkApplicable = useCallback((value) => {
    if (readOnly) return
    setControls(prev => {
      const next = prev.map(c => selectedIds.has(c.control_id) ? { ...c, applicable: value } : c)
      debouncedSave(next)
      return next
    })
    setSelectedIds(new Set())
  }, [selectedIds, readOnly, debouncedSave])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Progress header */}
      <GlassPanel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <ProgressRing value={stats.total > 0 ? (stats.assessed / stats.total) * 100 : 0} size={64} label="Assessed" />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontFamily: M, fontSize: 12, color: '#fff', fontWeight: 700 }}>
              {stats.assessed} / {stats.total} controls assessed
            </div>
            <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, marginTop: 4 }}>
              {stats.applicable} applicable · {stats.notApplicable} N/A · {stats.inherited} inherited · {stats.assessed === 0 ? `${stats.total} pending` : `${stats.total - stats.assessed} pending`}
            </div>
            <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, marginTop: 2 }}>
              {stats.implemented} implemented · {stats.gaps} gaps · {stats.autoDetected} auto-detected
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <GlassPill color={status === 'draft' ? COLORS.amber : status === 'review' ? COLORS.cyan : COLORS.green}>
              {status.toUpperCase()}
            </GlassPill>
            {!readOnly && status === 'draft' && (
              <GlassPill
                color={COLORS.cyan}
                style={{ cursor: 'pointer' }}
                onClick={() => { setStatus('review'); onStatusChange?.('review') }}
              >
                Submit for Review
              </GlassPill>
            )}
            {!readOnly && status === 'review' && (
              <GlassPill
                color={COLORS.green}
                style={{ cursor: 'pointer' }}
                onClick={() => { setStatus('approved'); onStatusChange?.('approved') }}
              >
                Approve
              </GlassPill>
            )}
          </div>
        </div>
      </GlassPanel>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {GROUPS.map(g => (
          <button
            key={g}
            onClick={() => setFilterGroup(filterGroup === g ? null : g)}
            style={{
              padding: '4px 10px', borderRadius: 5, border: 'none',
              fontFamily: M, fontSize: 9, fontWeight: filterGroup === g ? 700 : 500,
              color: filterGroup === g ? '#fff' : 'rgba(255,255,255,0.5)',
              background: filterGroup === g ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.03)',
              cursor: 'pointer',
            }}
          >
            {g} {GROUP_NAMES[g]}
          </button>
        ))}
        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)' }} />
        {['assessed', 'pending', 'gap'].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(filterStatus === s ? null : s)}
            style={{
              padding: '4px 8px', borderRadius: 5, border: 'none',
              fontFamily: M, fontSize: 9, fontWeight: filterStatus === s ? 700 : 500,
              color: filterStatus === s ? '#fff' : 'rgba(255,255,255,0.5)',
              background: filterStatus === s ? 'rgba(56,189,248,0.12)' : 'rgba(255,255,255,0.03)',
              cursor: 'pointer', textTransform: 'capitalize',
            }}
          >
            {s}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search controls..."
          style={{
            marginLeft: 'auto', fontFamily: M, fontSize: 10, color: '#fff',
            background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 5, padding: '5px 10px', outline: 'none', width: 180,
          }}
        />
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && !readOnly && (
        <GlassPanel style={{ padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>{selectedIds.size} selected</span>
            <button onClick={() => handleBulkApplicable('yes')} style={{ fontFamily: M, fontSize: 9, color: COLORS.green, background: 'none', border: 'none', cursor: 'pointer' }}>Mark Applicable</button>
            <button onClick={() => handleBulkApplicable('no')} style={{ fontFamily: M, fontSize: 9, color: 'rgba(255,255,255,0.5)', background: 'none', border: 'none', cursor: 'pointer' }}>Mark N/A</button>
            <button onClick={() => setSelectedIds(new Set())} style={{ fontFamily: M, fontSize: 9, color: COLORS.red, background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
          </div>
        </GlassPanel>
      )}

      {/* Grouped controls table */}
      {GROUPS.filter(g => !filterGroup || g === filterGroup).map(group => {
        const groupControls = filteredControls.filter(c => defMap[c.control_id]?.group === group)
        if (groupControls.length === 0 && filterGroup !== group) return null
        const collapsed = collapsedGroups[group]
        const groupAssessed = groupControls.filter(c => c.applicable !== null).length

        return (
          <GlassPanel key={group} style={{ padding: 0, overflow: 'hidden' }}>
            <div
              onClick={() => toggleGroup(group)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', cursor: 'pointer',
                borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.04)',
              }}
              role="button"
              aria-expanded={!collapsed}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 700 }}>
                  {collapsed ? '▶' : '▼'} {group} {GROUP_NAMES[group]}
                </span>
                <GlassPill color={COLORS.subtleText}>
                  {groupControls.length} controls
                </GlassPill>
              </div>
              <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>
                {groupAssessed}/{groupControls.length} assessed
              </div>
            </div>

            {!collapsed && (
              <div style={{ padding: '4px 4px 8px' }} role="grid" aria-rowcount={groupControls.length}>
                {/* Column header */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '65px 1fr 110px 100px 1fr',
                  gap: 8, padding: '4px 10px', marginBottom: 2,
                }}>
                  <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, letterSpacing: 1 }}>ID</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, letterSpacing: 1 }}>CONTROL</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, letterSpacing: 1 }}>APPLICABLE</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, letterSpacing: 1 }}>STATUS</span>
                  <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, letterSpacing: 1 }}>JUSTIFICATION</span>
                </div>

                {groupControls.map(ctrl => (
                  <ControlRow
                    key={ctrl.control_id}
                    control={ctrl}
                    definition={defMap[ctrl.control_id] || { id: ctrl.control_id, name: ctrl.control_id, group: '' }}
                    onChange={handleControlChange}
                  />
                ))}
              </div>
            )}
          </GlassPanel>
        )
      })}
    </div>
  )
}

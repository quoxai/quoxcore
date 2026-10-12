/**
 * PoliciesView — Governance Policy Command Center (GOV-QXFY)
 *
 * Fully quoxified: glass tabs, AUDITUS sidebar, status pills,
 * skeleton loaders, collapsible sidebar grid layout.
 *
 * Route: /policies
 * Data: policyStoreClient → collector /api/v1/policies
 */

import { useState, useEffect, useCallback } from 'react'
import { useWorkspace } from '../../contexts'
import { useAuth } from '../../contexts/AuthContext'
import {
  listPolicies,
  createPolicy,
  updatePolicy,
  deletePolicy,
  listTemplatePacks,
  checkTemplateConflicts,
  enableTemplatePack,
  POLICY_CATEGORIES,
  POLICY_EFFECTS,
} from '../../services/policyStoreClient'
import {
  listApprovalTemplates,
  createApprovalTemplate,
  updateApprovalTemplate,
  deleteApprovalTemplate,
} from '../../services/approvalTemplatesClient'
import {
  GlassPanel,
  GlassTabBar,
  GlassPill,
  GlassSkeleton,
  GlassError,
  COLORS,
  M,
  F,
} from '../../components/compliance/glass-primitives'
import { AgentChatSidebar } from '../../components/chat/AgentChatSidebar'
import GovernancePageLayout from '../../components/compliance/GovernancePageLayout'
import PolicyHistoryDrawer from '../../components/compliance/PolicyHistoryDrawer'

// ============================================================
// Constants
// ============================================================

const GOV_TABS = [
  { id: 'library', label: 'Library', icon: '◈' },
  { id: 'editor', label: 'Editor', icon: '✎' },
  { id: 'simulator', label: 'Simulator', icon: '▷' },
  { id: 'enforcement', label: 'Enforcement', icon: '◉' },
  { id: 'templates', label: 'Templates', icon: '⬡' },
  { id: 'approval-templates', label: 'Approval Templates', icon: '◎' },
]

const CATEGORY_COLORS = {
  safety: COLORS.red,
  execution: COLORS.cyan,
  governance: COLORS.purple,
  compliance: COLORS.amber,
}

const EFFECT_COLORS = {
  allow: COLORS.green,
  deny: COLORS.red,
  require_approval: COLORS.amber,
  redact: COLORS.purple,
  log_only: COLORS.cyan,
}

const EFFECT_LABELS = {
  allow: 'Allow',
  deny: 'Deny',
  require_approval: 'Approval',
  redact: 'Redact',
  log_only: 'Log Only',
}

// ============================================================
// SVG Icons (inline, no emoji, no currentColor)
// ============================================================

const ShieldIcon = ({ size = 16, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

const PlusIcon = ({ size = 14, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const TrashIcon = ({ size = 14, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
)

const EditIcon = ({ size = 14, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
)

const LockIcon = ({ size = 12, color = 'rgba(255,255,255,0.4)' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
  </svg>
)

const RefreshIcon = ({ size = 14, color = '#fff' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
  </svg>
)

// ============================================================
// Shared Micro-Components
// ============================================================

function CategoryBadge({ category }) {
  const color = CATEGORY_COLORS[category] || COLORS.dimText
  return (
    <span style={{
      fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
      color, textTransform: 'uppercase',
      padding: '2px 8px', borderRadius: 6,
      background: `${color}15`, border: `1px solid ${color}30`,
    }}>
      {category}
    </span>
  )
}

function EffectBadge({ effect }) {
  const color = EFFECT_COLORS[effect] || COLORS.dimText
  return (
    <span style={{
      fontFamily: M, fontSize: 9, fontWeight: 600,
      color, padding: '2px 8px', borderRadius: 6,
      background: `${color}15`, border: `1px solid ${color}30`,
    }}>
      {EFFECT_LABELS[effect] || effect}
    </span>
  )
}

function StatCard({ label, value, color = COLORS.white }) {
  return (
    <GlassPanel style={{ padding: '12px 16px', flex: 1, minWidth: 100 }}>
      <div style={{ fontFamily: M, fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
    </GlassPanel>
  )
}

function GlassBtn({ children, onClick, disabled, variant = 'default', style: extraStyle = {} }) {
  const variants = {
    default: { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)', color: '#fff' },
    primary: { bg: 'rgba(168,85,247,0.15)', border: 'rgba(168,85,247,0.3)', color: COLORS.purple },
    danger: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', color: COLORS.red },
    success: { bg: 'rgba(48,255,144,0.12)', border: 'rgba(48,255,144,0.3)', color: COLORS.green },
  }
  const v = variants[variant] || variants.default
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: M, fontSize: 11, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '6px 14px', borderRadius: 8, border: `1px solid ${v.border}`,
        background: v.bg, color: v.color, display: 'flex', alignItems: 'center', gap: 6,
        opacity: disabled ? 0.5 : 1, transition: 'all 0.2s ease', ...extraStyle,
      }}
    >
      {children}
    </button>
  )
}

function GlassToggle({ value, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        background: value ? `linear-gradient(145deg, ${COLORS.green}40, ${COLORS.green}20)` : 'rgba(255,255,255,0.08)',
        position: 'relative', transition: 'all 0.2s ease',
        boxShadow: value ? `0 0 8px ${COLORS.green}30` : 'none',
      }}
    >
      <div style={{
        width: 14, height: 14, borderRadius: '50%', position: 'absolute', top: 3,
        left: value ? 19 : 3, background: value ? COLORS.green : 'rgba(255,255,255,0.4)',
        transition: 'all 0.2s ease', boxShadow: value ? `0 0 6px ${COLORS.green}60` : 'none',
      }} />
    </button>
  )
}

function GlassSelect({ value, onChange, options, style: extraStyle = {} }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontFamily: M, fontSize: 11, color: '#fff', borderRadius: 8,
        padding: '6px 10px', border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(255,255,255,0.04)', cursor: 'pointer',
        ...extraStyle,
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value} style={{ background: 'rgba(255, 255, 255, 0.05)' }}>{o.label}</option>
      ))}
    </select>
  )
}

function GlassInput({ value, onChange, placeholder, style: extraStyle = {} }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        fontFamily: M, fontSize: 11, color: '#fff', borderRadius: 8,
        padding: '8px 12px', border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(255,255,255,0.04)', width: '100%',
        ...extraStyle,
      }}
    />
  )
}

function GlassTextarea({ value, onChange, placeholder, rows = 6, style: extraStyle = {} }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      spellCheck="false"
      style={{
        fontFamily: M, fontSize: 11, color: '#fff', borderRadius: 8,
        padding: '8px 12px', border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(255,255,255,0.04)', width: '100%', resize: 'vertical',
        ...extraStyle,
      }}
    />
  )
}

// ============================================================
// Tab 1: Policy Library
// ============================================================

function PolicyLibraryTab({ policies, loading, error, onRefresh, onEdit, onToggle, onDelete }) {
  const [filterCategory, setFilterCategory] = useState('all')
  const [filterEffect, setFilterEffect] = useState('all')
  const [historyPolicy, setHistoryPolicy] = useState(null)
  const onShowHistory = (p) => setHistoryPolicy((cur) => (cur?.id === p?.id ? null : p))

  const filtered = policies.filter(p => {
    if (filterCategory !== 'all' && p.category !== filterCategory) return false
    if (filterEffect !== 'all' && p.effect !== filterEffect) return false
    return true
  })

  const enabledCount = policies.filter(p => p.enabled).length
  const systemCount = policies.filter(p => p.is_system).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Stats row */}
      <div style={{ display: 'flex', gap: 8 }}>
        <StatCard label="Total Policies" value={policies.length} color={COLORS.white} />
        <StatCard label="Enabled" value={enabledCount} color={COLORS.green} />
        <StatCard label="System" value={systemCount} color={COLORS.cyan} />
        {POLICY_CATEGORIES.map(cat => (
          <StatCard key={cat} label={cat} value={policies.filter(p => p.category === cat).length} color={CATEGORY_COLORS[cat]} />
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <GlassSelect
          value={filterCategory}
          onChange={setFilterCategory}
          options={[{ value: 'all', label: 'All Categories' }, ...POLICY_CATEGORIES.map(c => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))]}
        />
        <GlassSelect
          value={filterEffect}
          onChange={setFilterEffect}
          options={[{ value: 'all', label: 'All Effects' }, ...POLICY_EFFECTS.map(e => ({ value: e, label: EFFECT_LABELS[e] || e }))]}
        />
        <div style={{ flex: 1 }} />
        <GlassBtn onClick={onRefresh} disabled={loading}>
          <RefreshIcon size={12} color="#fff" />
          {loading ? 'Loading...' : 'Refresh'}
        </GlassBtn>
      </div>

      {/* Error */}
      {error && (
        <GlassPanel highlight={COLORS.red} style={{ padding: 12 }}>
          <span style={{ fontFamily: M, fontSize: 11, color: COLORS.red }}>{error}</span>
        </GlassPanel>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <GlassPanel style={{ padding: 40, textAlign: 'center' }}>
          <ShieldIcon size={32} color="rgba(255,255,255,0.3)" />
          <div style={{ fontFamily: F, fontSize: 14, color: COLORS.dimText, marginTop: 12 }}>
            {policies.length === 0 ? 'No policies yet. Switch to the Editor tab to create one.' : 'No policies match the current filters.'}
          </div>
        </GlassPanel>
      )}

      {/* Policy cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 8 }}>
        {filtered.map(policy => (
          <GlassPanel key={policy.id} hoverable style={{ padding: 14 }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <ShieldIcon size={16} color={CATEGORY_COLORS[policy.category] || COLORS.dimText} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: '#fff' }}>{policy.name}</span>
                  {policy.is_system && <LockIcon size={11} />}
                </div>
                {policy.reason && (
                  <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {policy.reason}
                  </div>
                )}
              </div>
              <GlassToggle value={policy.enabled} onChange={(val) => onToggle(policy, val)} disabled={false} />
            </div>

            {/* Badges row */}
            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <CategoryBadge category={policy.category} />
              <EffectBadge effect={policy.effect} />
              <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                P{policy.priority}
              </span>
              {policy.version > 1 && (
                <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>v{policy.version}</span>
              )}
              {policy.framework_mapping?.length > 0 && (
                <span style={{ fontFamily: M, fontSize: 9, color: COLORS.cyan }}>
                  {policy.framework_mapping.length} framework{policy.framework_mapping.length > 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Actions row */}
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              {!policy.is_system && (
                <>
                  <GlassBtn onClick={() => onEdit(policy)} style={{ padding: '4px 10px' }}>
                    <EditIcon size={11} color="#fff" /> Edit
                  </GlassBtn>
                  <GlassBtn variant="danger" onClick={() => onDelete(policy)} style={{ padding: '4px 10px' }}>
                    <TrashIcon size={11} color={COLORS.red} /> Delete
                  </GlassBtn>
                </>
              )}
              <GlassBtn onClick={() => onShowHistory(policy)} style={{ padding: '4px 10px' }}>
                History
              </GlassBtn>
            </div>
          </GlassPanel>
        ))}
      </div>
      {historyPolicy && (
        <div style={{ marginTop: 16 }}>
          <PolicyHistoryDrawer
            policyId={historyPolicy.id}
            policyName={historyPolicy.name}
            onClose={() => onShowHistory(null)}
          />
        </div>
      )}
    </div>
  )
}

// ============================================================
// Tab 2: Policy Editor
// ============================================================

function PolicyEditorTab({ editingPolicy, onSave, onCancel }) {
  const [name, setName] = useState(editingPolicy?.name || '')
  const [category, setCategory] = useState(editingPolicy?.category || 'safety')
  const [effect, setEffect] = useState(editingPolicy?.effect || 'deny')
  const [priority, setPriority] = useState(editingPolicy?.priority ?? 100)
  const [reason, setReason] = useState(editingPolicy?.reason || '')
  const [conditionsJson, setConditionsJson] = useState(
    editingPolicy?.conditions
      ? JSON.stringify(editingPolicy.conditions, null, 2)
      : JSON.stringify({
          operator: 'AND',
          conditions: [{ field: 'query.text', operator: 'matches', value: '\\\\bpattern\\\\b' }]
        }, null, 2)
  )
  const [frameworkTags, setFrameworkTags] = useState(
    editingPolicy?.framework_mapping?.join(', ') || ''
  )
  const [auditRequired, setAuditRequired] = useState(editingPolicy?.audit_required ?? true)
  // R3.high: governance engine fields — must be included in save payload so policies
  // can wire as runtime gates (governance_kind + gate_position + approval_template_id).
  const [governanceKind, setGovernanceKind] = useState(editingPolicy?.governance_kind || 'runtime_gate')
  const [gatePosition, setGatePosition] = useState(editingPolicy?.gate_position || 'pre_node')
  const [approvalTemplateId, setApprovalTemplateId] = useState(editingPolicy?.approval_template_id || '')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setError(null)
    if (!name.trim()) { setError('Policy name is required'); return }

    let conditions
    try {
      conditions = JSON.parse(conditionsJson)
    } catch (e) {
      setError('Invalid conditions JSON: ' + e.message)
      return
    }

    const frameworks = frameworkTags.split(',').map(s => s.trim()).filter(Boolean)

    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        category,
        effect,
        priority: parseInt(priority, 10) || 100,
        reason: reason.trim(),
        conditions,
        framework_mapping: frameworks,
        audit_required: auditRequired,
        scope: editingPolicy?.scope || { agents: ['*'], teams: ['*'] },
        // R3.high: governance engine fields required for runtime gate wiring
        governance_kind: governanceKind,
        gate_position: gatePosition,
        ...(approvalTemplateId.trim() ? { approval_template_id: approvalTemplateId.trim() } : {}),
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 12, minHeight: 0 }}>
      {/* Form */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
        <GlassPanel style={{ padding: 16 }}>
          <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            {editingPolicy ? `Edit: ${editingPolicy.name}` : 'Create New Policy'}
          </div>

          {/* Name */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Name</label>
            <GlassInput value={name} onChange={setName} placeholder="e.g. Block PII to external LLMs" />
          </div>

          {/* Category + Effect row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Category</label>
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                {POLICY_CATEGORIES.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCategory(cat)}
                    style={{
                      fontFamily: M, fontSize: 10, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                      color: category === cat ? '#fff' : CATEGORY_COLORS[cat],
                      background: category === cat ? `linear-gradient(145deg, ${CATEGORY_COLORS[cat]}30, ${CATEGORY_COLORS[cat]}15)` : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${category === cat ? CATEGORY_COLORS[cat] + '50' : 'rgba(255,255,255,0.08)'}`,
                      boxShadow: category === cat ? `0 0 12px ${CATEGORY_COLORS[cat]}20` : 'none',
                      transition: 'all 0.2s ease', textTransform: 'capitalize',
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Effect picker — 5 tiles */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Effect</label>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              {POLICY_EFFECTS.map(eff => (
                <button
                  key={eff}
                  onClick={() => setEffect(eff)}
                  style={{
                    fontFamily: M, fontSize: 10, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                    color: effect === eff ? '#fff' : EFFECT_COLORS[eff],
                    background: effect === eff ? `linear-gradient(145deg, ${EFFECT_COLORS[eff]}30, ${EFFECT_COLORS[eff]}15)` : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${effect === eff ? EFFECT_COLORS[eff] + '50' : 'rgba(255,255,255,0.08)'}`,
                    boxShadow: effect === eff ? `0 0 12px ${EFFECT_COLORS[eff]}20` : 'none',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {EFFECT_LABELS[eff]}
                </button>
              ))}
            </div>
          </div>

          {/* Priority + Audit row */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-end' }}>
            <div style={{ width: 120 }}>
              <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Priority (0-1000)</label>
              <GlassInput value={String(priority)} onChange={v => setPriority(v)} placeholder="100" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <GlassToggle value={auditRequired} onChange={setAuditRequired} />
              <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>Audit Required</span>
            </div>
          </div>

          {/* Reason */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reason / Message</label>
            <GlassInput value={reason} onChange={setReason} placeholder="Shown when policy triggers" />
          </div>

          {/* R3.high: Governance engine fields */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Governance Kind</label>
              <select
                value={governanceKind}
                onChange={e => setGovernanceKind(e.target.value)}
                style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#fff', fontFamily: M, fontSize: 11, padding: '6px 8px', marginTop: 4 }}
              >
                <option value="runtime_gate">Runtime Gate</option>
                <option value="budget_gate">Budget Gate</option>
                <option value="data_egress">Data Egress</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Gate Position</label>
              <select
                value={gatePosition}
                onChange={e => setGatePosition(e.target.value)}
                style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#fff', fontFamily: M, fontSize: 11, padding: '6px 8px', marginTop: 4 }}
              >
                <option value="pre_node">Pre Node</option>
                <option value="pre_workflow">Pre Workflow</option>
                <option value="post_workflow">Post Workflow</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Approval Template ID (optional)</label>
            <GlassInput value={approvalTemplateId} onChange={setApprovalTemplateId} placeholder="Leave blank to use inline approvers" />
            <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginTop: 3 }}>If set, the template's approver roster overrides any inline approvers in the policy rules.</div>
          </div>

          {/* Framework tags */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>Framework Mapping (comma-separated)</label>
            <GlassInput value={frameworkTags} onChange={setFrameworkTags} placeholder="hipaa.164.312.a.1, gdpr.art.32.1.a" />
          </div>
        </GlassPanel>

        {/* Conditions JSON */}
        <GlassPanel style={{ padding: 16 }}>
          <label style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Conditions (JSON)
          </label>
          <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, marginBottom: 6 }}>
            Fields: query.text, agent.id, action.type, rate.queries_per_minute, rate.queries_per_hour, data.hasPII
          </div>
          <GlassTextarea value={conditionsJson} onChange={setConditionsJson} rows={10} />
        </GlassPanel>

        {/* Error + Actions */}
        {error && (
          <GlassPanel highlight={COLORS.red} style={{ padding: 10 }}>
            <span style={{ fontFamily: M, fontSize: 11, color: COLORS.red }}>{error}</span>
          </GlassPanel>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <GlassBtn onClick={onCancel}>Cancel</GlassBtn>
          <GlassBtn variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : editingPolicy ? 'Update Policy' : 'Create Policy'}
          </GlassBtn>
        </div>
      </div>

      {/* JSON Preview */}
      <div style={{ width: 320, minWidth: 0 }}>
        <GlassPanel style={{ padding: 12, height: '100%' }}>
          <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
            Preview
          </div>
          <pre style={{
            fontFamily: M, fontSize: 10, color: COLORS.dimText, margin: 0,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowY: 'auto', maxHeight: 500,
          }}>
            {JSON.stringify({
              name: name || '(untitled)',
              category, effect, priority: parseInt(priority) || 100,
              reason,
              conditions: (() => { try { return JSON.parse(conditionsJson) } catch { return '(invalid JSON)' } })(),
              framework_mapping: frameworkTags.split(',').map(s => s.trim()).filter(Boolean),
              audit_required: auditRequired,
              governance_kind: governanceKind,
              gate_position: gatePosition,
              ...(approvalTemplateId.trim() ? { approval_template_id: approvalTemplateId.trim() } : {}),
            }, null, 2)}
          </pre>
        </GlassPanel>
      </div>
    </div>
  )
}

// ============================================================
// Tab 3: Simulator (Placeholder)
// ============================================================

function SimulatorTab() {
  return (
    <GlassPanel style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>▷</div>
      <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Policy Simulator</div>
      <div style={{ fontFamily: M, fontSize: 11, color: COLORS.subtleText, maxWidth: 400, margin: '0 auto' }}>
        Build a request context (agent, action, resource) and see which policies would trigger.
        Toggle policies on/off to compare enforcement scenarios.
      </div>
      {/* GOV-TRUTH tail (#4): no ad-hoc policy simulation endpoint exists yet
          (checked services/collector/server.js — /traces/:identifier/simulate
          is a different feature, replaying an EXISTING trace, not building an
          arbitrary request context). Honest empty state, no delivery date
          implied — matches the Auditor Portal precedent. */}
      <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginTop: 16 }}>
        Not yet available. There is no fabricated preview data here — this feature has no backing endpoint yet.
      </div>
    </GlassPanel>
  )
}

// ============================================================
// Tab 4: Enforcement (Placeholder)
// ============================================================

function EnforcementTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <StatCard label="Evaluated Today" value="--" color={COLORS.cyan} />
        <StatCard label="Blocked" value="--" color={COLORS.red} />
        <StatCard label="Approvals" value="--" color={COLORS.amber} />
        <StatCard label="Dead Rules" value="--" color={COLORS.subtleText} />
      </div>
      <GlassPanel style={{ padding: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>◉</div>
        <div style={{ fontFamily: F, fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Enforcement Dashboard</div>
        <div style={{ fontFamily: M, fontSize: 11, color: COLORS.subtleText, maxWidth: 400, margin: '0 auto' }}>
          Real-time enforcement metrics, per-policy hit counts, stacked area charts by category,
          and dead policy detection. Requires GOV-2 event logging to be active.
        </div>
        {/* GOV-TRUTH tail (#4): aocl.policy.evaluated envelopes exist, but no
            endpoint aggregates them into hit-counts/dead-policy metrics yet
            (checked services/collector/server.js + lib/*PolicyEvaluator.js) —
            building that aggregation is real feature work, not a wiring fix.
            Honest empty state, no delivery date implied. */}
        <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginTop: 16 }}>
          Not yet available. There is no fabricated preview data here — this feature has no backing endpoint yet.
        </div>
      </GlassPanel>
    </div>
  )
}

// ============================================================
// Tab 5: Templates (Placeholder)
// ============================================================

function TemplatesTab({ orgId, onPackEnabled }) {
  const [packs, setPacks] = useState([])
  const [loading, setLoading] = useState(true)
  const [enabling, setEnabling] = useState(null)
  const [result, setResult] = useState(null)
  const [conflicts, setConflicts] = useState({})

  useEffect(() => {
    setLoading(true)
    listTemplatePacks()
      .then(data => setPacks(data?.data || []))
      .catch(() => setPacks([]))
      .finally(() => setLoading(false))
  }, [])

  const handleCheckConflicts = async (packId) => {
    try {
      const data = await checkTemplateConflicts(packId, orgId)
      setConflicts(prev => ({ ...prev, [packId]: data.conflicts || [] }))
    } catch { /* ignore */ }
  }

  const handleEnable = async (packId) => {
    setEnabling(packId)
    setResult(null)
    try {
      const data = await enableTemplatePack(packId, orgId, 'admin')
      setResult({ packId, ...data })
      onPackEnabled?.()
    } catch (err) {
      setResult({ packId, error: err.message })
    } finally {
      setEnabling(null)
    }
  }

  if (loading) {
    return <GlassPanel style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontFamily: M, fontSize: 11, color: COLORS.subtleText }}>Loading template packs...</div>
    </GlassPanel>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {result && (
        <GlassPanel highlight={result.error ? COLORS.red : COLORS.green} style={{ padding: 12 }}>
          <span style={{ fontFamily: M, fontSize: 11, color: result.error ? COLORS.red : COLORS.green }}>
            {result.error || `${result.packName}: ${result.created} created, ${result.skipped} skipped`}
          </span>
        </GlassPanel>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 8 }}>
        {packs.map(pack => {
          const packConflicts = conflicts[pack.id] || []
          return (
            <GlassPanel key={pack.id} hoverable highlight={pack.color} style={{ padding: 16 }}>
              <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: '#fff' }}>{pack.name}</div>
              <div style={{ fontFamily: M, fontSize: 11, color: COLORS.subtleText, marginTop: 4 }}>{pack.description}</div>
              <div style={{ fontFamily: M, fontSize: 10, color: pack.color, marginTop: 8 }}>{pack.policyCount} policies</div>

              {packConflicts.length > 0 && (
                <div style={{ fontFamily: M, fontSize: 10, color: COLORS.amber, marginTop: 6 }}>
                  {packConflicts.length} conflict{packConflicts.length > 1 ? 's' : ''}: {packConflicts.map(c => c.existingName).join(', ')}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <GlassBtn onClick={() => handleCheckConflicts(pack.id)} style={{ padding: '4px 10px' }}>
                  Check Conflicts
                </GlassBtn>
                <GlassBtn
                  variant="primary"
                  onClick={() => handleEnable(pack.id)}
                  disabled={enabling === pack.id}
                  style={{ padding: '4px 10px' }}
                >
                  <PlusIcon size={11} color={COLORS.purple} />
                  {enabling === pack.id ? 'Enabling...' : 'Enable Pack'}
                </GlassBtn>
              </div>
            </GlassPanel>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================
// Tab 6: Approval Templates — P8.C.4
// ============================================================

function ApprovalTemplateModal({ template, onSave, onCancel }) {
  const [name, setName] = useState(template?.name || '')
  const [approvers, setApprovers] = useState(template?.approvers?.join('\n') || '')
  const [escalationChain, setEscalationChain] = useState(template?.escalation_chain?.join('\n') || '')
  const [timeoutMs, setTimeoutMs] = useState(String(template?.timeout_ms ?? 86400000))
  const [threshold, setThreshold] = useState(String(template?.multi_party_threshold ?? 1))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const handleSave = async () => {
    setSaving(true)
    setErr(null)
    try {
      const approverList = approvers.split('\n').map(s => s.trim()).filter(Boolean)
      const escalationList = escalationChain.split('\n').map(s => s.trim()).filter(Boolean)
      if (!name.trim()) throw new Error('Name is required')
      if (approverList.length === 0) throw new Error('At least one approver is required')
      await onSave({
        name: name.trim(),
        approvers: approverList,
        escalation_chain: escalationList,
        timeout_ms: parseInt(timeoutMs) || 86400000,
        multi_party_threshold: parseInt(threshold) || 1,
      })
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <GlassPanel
        style={{ padding: 24, maxWidth: 480, width: '90%' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontFamily: F, fontSize: 14, fontWeight: 700, color: COLORS.amber, marginBottom: 16 }}>
          {template ? 'Edit Approval Template' : 'Add Approval Template'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Name</div>
            <GlassInput value={name} onChange={setName} placeholder="e.g. Finance Team Approval" />
          </div>
          <div>
            <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Approvers (one per line)</div>
            <GlassTextarea value={approvers} onChange={setApprovers} placeholder="cfo@example.com&#10;controller@example.com" rows={3} />
          </div>
          <div>
            <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Escalation Chain (one per line)</div>
            <GlassTextarea value={escalationChain} onChange={setEscalationChain} placeholder="vp@example.com" rows={2} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Timeout (ms)</div>
              <GlassInput value={timeoutMs} onChange={setTimeoutMs} placeholder="86400000" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Multi-party threshold</div>
              <GlassInput value={threshold} onChange={setThreshold} placeholder="1" />
            </div>
          </div>
        </div>

        {err && <div style={{ fontFamily: M, fontSize: 11, color: COLORS.red, marginTop: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <GlassBtn onClick={onCancel} disabled={saving}>Cancel</GlassBtn>
          <GlassBtn variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : template ? 'Update' : 'Create'}
          </GlassBtn>
        </div>
      </GlassPanel>
    </div>
  )
}

function ApprovalTemplatesTab({ orgId, authFetch }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [modalTemplate, setModalTemplate] = useState(undefined) // undefined=closed, null=new, obj=edit

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await listApprovalTemplates({ authFetch, orgId })
      setTemplates(result || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [orgId, authFetch])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  const handleSave = async (data) => {
    if (modalTemplate?.id) {
      await updateApprovalTemplate({ authFetch, orgId, id: modalTemplate.id, ...data })
    } else {
      await createApprovalTemplate({ authFetch, orgId, ...data })
    }
    setModalTemplate(undefined)
    fetchTemplates()
  }

  const handleDelete = async (tpl) => {
    if (!confirm(`Delete template "${tpl.name}"?`)) return
    try {
      await deleteApprovalTemplate({ authFetch, orgId, id: tpl.id })
      fetchTemplates()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontFamily: F, fontSize: 13, fontWeight: 700, color: COLORS.amber, flex: 1 }}>
          Approval Templates
        </div>
        <GlassBtn variant="primary" onClick={() => setModalTemplate(null)}>
          <PlusIcon size={12} color={COLORS.purple} /> Add Template
        </GlassBtn>
        <GlassBtn onClick={fetchTemplates} disabled={loading}>
          <RefreshIcon size={12} color="#fff" /> {loading ? 'Loading...' : 'Refresh'}
        </GlassBtn>
      </div>

      {error && <GlassError message={error} onRetry={fetchTemplates} />}

      {loading && !error && <GlassSkeleton height={120} />}

      {!loading && !error && templates.length === 0 && (
        <GlassPanel style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontFamily: M, fontSize: 12, color: COLORS.dimText }}>
            No approval templates yet. Create one to reuse multi-stakeholder rosters across policies.
          </div>
        </GlassPanel>
      )}

      {!loading && templates.map(tpl => (
        <GlassPanel key={tpl.id} style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: F, fontSize: 12, fontWeight: 700, color: COLORS.white, marginBottom: 4 }}>
                {tpl.name}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
                  {tpl.approvers?.length || 0} approvers
                </span>
                {(tpl.multi_party_threshold || 1) > 1 && (
                  <GlassPill color={COLORS.amber}>
                    {tpl.multi_party_threshold}-party
                  </GlassPill>
                )}
                {tpl.timeout_ms && (
                  <span style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
                    {Math.round(tpl.timeout_ms / 3600000)}h timeout
                  </span>
                )}
              </div>
              {tpl.approvers?.length > 0 && (
                <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginTop: 4 }}>
                  {tpl.approvers.join(', ')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <GlassBtn onClick={() => setModalTemplate(tpl)}>
                <EditIcon size={12} color="#fff" />
              </GlassBtn>
              <GlassBtn variant="danger" onClick={() => handleDelete(tpl)}>
                <TrashIcon size={12} color={COLORS.red} />
              </GlassBtn>
            </div>
          </div>
        </GlassPanel>
      ))}

      {modalTemplate !== undefined && (
        <ApprovalTemplateModal
          template={modalTemplate}
          onSave={handleSave}
          onCancel={() => setModalTemplate(undefined)}
        />
      )}
    </div>
  )
}

// ============================================================
// Delete Confirmation
// ============================================================

function DeleteConfirm({ policy, onConfirm, onCancel }) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <GlassPanel style={{ padding: 24, maxWidth: 400, width: '90%' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontFamily: F, fontSize: 15, fontWeight: 700, color: COLORS.red, marginBottom: 8 }}>
          Delete Policy
        </div>
        <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText, marginBottom: 16 }}>
          Delete <strong style={{ color: '#fff' }}>{policy.name}</strong>? This cannot be undone.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <GlassBtn onClick={onCancel}>Cancel</GlassBtn>
          <GlassBtn variant="danger" onClick={onConfirm}>
            <TrashIcon size={12} color={COLORS.red} /> Delete
          </GlassBtn>
        </div>
      </GlassPanel>
    </div>
  )
}

// ============================================================
// Main PoliciesView
// ============================================================

// AUDITUS context builder for the governance sidebar
async function buildGovernanceContext() {
  return {
    surface: 'governance-policies',
    pageContext: 'The user is on the Governance Policies page managing L3 policy enforcement rules. Help them create, edit, or understand policies across safety, execution, governance, and compliance categories.',
  }
}

const AUDITUS_SUGGESTIONS = [
  'What policies are currently enforced?',
  'Create a HIPAA PII blocking policy',
  'Explain how the condition evaluator works',
  'Which tools require approval?',
  'Show me the enforcement trace for the last blocked request',
]

export default function PoliciesView() {
  let orgId = '__default__'
  let authFetch = null
  try { const { currentOrg } = useWorkspace(); orgId = currentOrg?.id || '__default__' } catch { /* outside provider */ }
  try { const auth = useAuth(); authFetch = auth.authFetch } catch { /* outside provider */ }

  const [activeTab, setActiveTab] = useState('library')
  const [policies, setPolicies] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editingPolicy, setEditingPolicy] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const fetchPolicies = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await listPolicies(orgId, { force: true })
      setPolicies(result?.data || [])
    } catch (e) {
      setError(e.message)
      setPolicies([])
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => { fetchPolicies() }, [fetchPolicies])

  const handleCreateOrUpdate = async (policyData) => {
    if (editingPolicy) {
      await updatePolicy(editingPolicy.id, policyData)
    } else {
      await createPolicy({ ...policyData, org_id: orgId })
    }
    setEditingPolicy(null)
    setActiveTab('library')
    fetchPolicies()
  }

  const handleToggle = async (policy, enabled) => {
    try {
      await updatePolicy(policy.id, { enabled })
      fetchPolicies()
    } catch (e) {
      setError(e.message)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deletePolicy(deleteTarget.id)
      setDeleteTarget(null)
      fetchPolicies()
    } catch (e) {
      setError(e.message)
      setDeleteTarget(null)
    }
  }

  const handleEdit = (policy) => {
    setEditingPolicy(policy)
    setActiveTab('editor')
  }

  const enabledCount = policies.filter(p => p.enabled).length
  const denyCount = policies.filter(p => p.effect === 'deny' && p.enabled).length

  const statusPill = {
    label: loading ? 'LOADING' : `${enabledCount} ACTIVE`,
    color: loading ? COLORS.amber : enabledCount > 0 ? COLORS.green : COLORS.red,
  }

  const headerActions = (
    <>
      {denyCount > 0 && (
        <GlassPill color={COLORS.red}>
          {denyCount} DENY
        </GlassPill>
      )}
      <GlassBtn variant="primary" onClick={() => { setEditingPolicy(null); setActiveTab('editor') }}>
        <PlusIcon size={12} color={COLORS.purple} /> New Policy
      </GlassBtn>
    </>
  )

  return (
    <GovernancePageLayout
      protocol="AOCL"
      title="Governance Policy Center"
      subtitle="L3 Policy Gate — AOCL enforcement layer"
      statusPill={statusPill}
      actions={headerActions}
      crumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'Policies' }]}
    >
      {/* Tab bar */}
      <GlassTabBar tabs={GOV_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Main content + AUDITUS sidebar */}
      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: sidebarCollapsed ? '1fr 48px' : '1fr 300px',
        gap: 8,
      }}>
        {/* Tab content */}
        <div style={{ minHeight: 0, overflowY: 'auto' }}>
          {error && <GlassError message={error} onRetry={fetchPolicies} />}

          {loading && !error && <GlassSkeleton height={300} />}

          {!loading && !error && (
            <>
              {activeTab === 'library' && (
                <PolicyLibraryTab
                  policies={policies}
                  loading={loading}
                  error={error}
                  onRefresh={fetchPolicies}
                  onEdit={handleEdit}
                  onToggle={handleToggle}
                  onDelete={setDeleteTarget}
                />
              )}
              {activeTab === 'editor' && (
                <PolicyEditorTab
                  editingPolicy={editingPolicy}
                  onSave={handleCreateOrUpdate}
                  onCancel={() => { setEditingPolicy(null); setActiveTab('library') }}
                />
              )}
              {activeTab === 'simulator' && <SimulatorTab />}
              {activeTab === 'enforcement' && <EnforcementTab />}
              {activeTab === 'templates' && <TemplatesTab orgId={orgId} onPackEnabled={fetchPolicies} />}
              {activeTab === 'approval-templates' && <ApprovalTemplatesTab orgId={orgId} authFetch={authFetch} />}
            </>
          )}
        </div>

        {/* AUDITUS sidebar */}
        <AgentChatSidebar
          agentId="auditus"
          agentName="AUDITUS"
          agentColor="#06b6d4"
          agentRole="Governance"
          contextBuilder={buildGovernanceContext}
          suggestions={AUDITUS_SUGGESTIONS}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(c => !c)}
          sessionPrefix="AUDITUS_GOV"
        />
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <DeleteConfirm
          policy={deleteTarget}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </GovernancePageLayout>
  )
}

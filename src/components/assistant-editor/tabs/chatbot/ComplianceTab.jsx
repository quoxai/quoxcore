/**
 * ComplianceTab - QCX-6f
 *
 * Single admin pane for the QCX-6 compliance plumbing:
 *   - Risk tier badge + reasons + obligations (QCX-6d)
 *   - DPIA flag editor, toggling a flag triggers re-classification on save
 *   - Retention editor + "Run cleanup now" (QCX-6c)
 */

import { useMemo, useState } from 'react';

const TIER_LABEL = {
  prohibited:           'Prohibited',
  high_risk_annex_i:    'High-Risk (Annex I)',
  high_risk_annex_iii:  'High-Risk (Annex III)',
  gpai_systemic:        'GPAI (Systemic Risk)',
  gpai_standard:        'GPAI Model',
  limited_risk:         'Limited Risk',
  minimal_risk:         'Minimal Risk',
};
const TIER_COLOR = {
  prohibited:          '#ef4444',
  high_risk_annex_i:   '#ff6b35',
  high_risk_annex_iii: '#ff6b35',
  gpai_systemic:       '#f59e0b',
  gpai_standard:       '#00e5ff',
  limited_risk:        '#00e5ff',
  minimal_risk:        '#30ff90',
};

const DPIA_FLAGS = [
  { key: 'processes_phi',                   label: 'Processes PHI (Protected Health Information)' },
  { key: 'processes_biometrics',            label: 'Processes biometric data' },
  { key: 'processes_employment_decisions',  label: 'Influences employment decisions' },
  { key: 'processes_credit_decisions',      label: 'Influences credit / creditworthiness decisions' },
  { key: 'affects_education_access',        label: 'Affects access to education / vocational training' },
  { key: 'safety_component_regulated_product', label: 'Safety component of a regulated product (Annex I)' },
  { key: 'social_scoring_public_auth',      label: '⚠ Social scoring by a public authority (PROHIBITED)' },
  { key: 'subliminal_manipulation',         label: '⚠ Subliminal manipulation techniques (PROHIBITED)' },
];

function parseClassification(widget) {
  if (!widget) return null;
  const raw = widget.risk_classification_json;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

// The server-side classifier (services/auth/lib/widgetRiskClassifier.js) joins
// its reason/obligation copy with em dashes. House style forbids em dashes in
// UI copy, so sanitize on render rather than editing the shared server module.
function sanitizeCopy(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/\s*—\s*/g, ': ');
}

// The widgets table has no dedicated risk_classified_at column; `updated_at`
// is the closest available signal and is shared by every PATCH to this
// widget (retention, embed config, etc.), not just re-classification saves.
// Treated here as a best-effort "last touched" timestamp for the fold.
function formatClassifiedAt(value) {
  if (!value) return null;
  let d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    d = new Date(String(value).replace(' ', 'T') + 'Z');
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function ComplianceTab({ widget, orgId, authFetch, onWidgetChange }) {
  const seedClassification = useMemo(() => parseClassification(widget), [widget?.risk_classification_json]);
  const seedInputs = seedClassification?.inputs || {};

  const [inputs, setInputs] = useState(seedInputs);
  const [retentionDays, setRetentionDays] = useState(
    widget?.retention_days_override == null ? '' : String(widget.retention_days_override),
  );
  const [savingClass, setSavingClass] = useState(false);
  const [savingRet, setSavingRet] = useState(false);
  const [runningCleanup, setRunningCleanup] = useState(false);
  const [error, setError] = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  // QCX-6f/B6: the server re-classifies (tier + reasons + obligations) on
  // every save and returns the updated widget row. Track that response here
  // so the tier chip and flag list update immediately, without waiting for
  // the parent to reload the widget.
  const [classOverride, setClassOverride] = useState(null); // { tier, classification }
  const [classSaveState, setClassSaveState] = useState('idle'); // idle | saving | saved | error
  const [classSaveError, setClassSaveError] = useState(null);
  const [classifiedAt, setClassifiedAt] = useState(widget?.updated_at || null);

  const activeClassification = classOverride?.classification || seedClassification;
  const tier = classOverride?.tier || widget?.risk_tier || 'limited_risk';
  const tierLabel = TIER_LABEL[tier] || tier;
  const tierColor = TIER_COLOR[tier] || '#00e5ff';
  const requiresHipaa = !!activeClassification?.requires_hipaa;
  const classifiedAtLabel = formatClassifiedAt(classifiedAt);

  function toggleFlag(key, val) {
    setInputs(prev => ({ ...prev, [key]: val }));
    setClassSaveState('idle');
  }

  async function saveClassification() {
    if (savingClass) return;
    setSavingClass(true); setError(null); setStatusMsg(null);
    setClassSaveState('saving'); setClassSaveError(null);
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ risk_classification_inputs: inputs }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${resp.status})`);
      }
      const data = await resp.json().catch(() => ({}));
      const updatedWidget = data?.widget;
      if (updatedWidget && onWidgetChange) onWidgetChange(updatedWidget);
      const newClassification = parseClassification(updatedWidget);
      if (updatedWidget?.risk_tier && newClassification) {
        setClassOverride({ tier: updatedWidget.risk_tier, classification: newClassification });
      }
      setClassifiedAt(updatedWidget?.updated_at || new Date().toISOString());
      setClassSaveState('saved');
      setStatusMsg('Classification saved. Tier, reasons, and obligations below reflect the new save.');
    } catch (e) {
      setError(e.message || 'Save failed');
      setClassSaveState('error');
      setClassSaveError(e.message || 'Save failed');
    } finally { setSavingClass(false); }
  }

  async function saveRetention() {
    if (savingRet) return;
    const trimmed = retentionDays.trim();
    let val = null;
    if (trimmed.length > 0) {
      const n = parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n < 0) {
        setError('Retention must be a non-negative integer (or empty for none).');
        return;
      }
      val = n;
    }
    setSavingRet(true); setError(null); setStatusMsg(null);
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retention_days_override: val }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${resp.status})`);
      }
      try { const d = await resp.clone().json(); if (d?.widget && onWidgetChange) onWidgetChange(d.widget); } catch {}
      setStatusMsg(val == null ? 'Retention cleared (conversations are kept until deleted).' : `Retention set to ${val} days.`);
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally { setSavingRet(false); }
  }

  async function runCleanup() {
    if (runningCleanup) return;
    setRunningCleanup(true); setError(null); setStatusMsg(null);
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/retention/run`, {
        method: 'POST',
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Cleanup failed (${resp.status})`);
      }
      const data = await resp.json().catch(() => ({}));
      if (data?.skipped) {
        setStatusMsg('Cleanup skipped: no retention configured.');
      } else {
        const d = data?.deleted || {};
        setStatusMsg(`Cleanup ran: ${d.messages || 0} messages, ${d.conversations || 0} conversations removed.`);
      }
    } catch (e) {
      setError(e.message || 'Cleanup failed');
    } finally { setRunningCleanup(false); }
  }

  const cardStyle = {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  };
  const headStyle = {
    fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
    color: 'rgba(255, 255, 255, 0.72)', marginBottom: 8,
  };

  return (
    <div style={{ padding: 16, fontSize: 13 }}>
      {/* Risk tier card */}
      <div style={cardStyle}>
        <div style={headStyle}>EU AI Act risk classification</div>
        {classifiedAtLabel && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.72)', marginBottom: 8 }}>
            Last classified {classifiedAtLabel}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span
            data-tier={tier}
            style={{
              padding: '4px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700,
              background: `${tierColor}22`, color: tierColor, border: `1px solid ${tierColor}66`,
            }}
          >
            {tierLabel}
          </span>
          {requiresHipaa && (
            <span style={{
              padding: '4px 12px', borderRadius: 999, fontSize: 11, fontWeight: 700,
              background: 'rgba(239, 68, 68, 0.15)', color: '#fca5a5', border: '1px solid rgba(239, 68, 68, 0.4)',
            }}>HIPAA overlay</span>
          )}
        </div>
        {activeClassification?.reasons?.length > 0 && (
          <ul style={{ margin: '4px 0 8px', paddingLeft: 18, color: 'rgba(255,255,255,0.85)' }}>
            {activeClassification.reasons.map((r, i) => <li key={i}>{sanitizeCopy(r)}</li>)}
          </ul>
        )}
        {activeClassification?.obligations?.length > 0 && (
          <>
            <div style={{ ...headStyle, marginTop: 8 }}>Obligations</div>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>
              {activeClassification.obligations.map((o, i) => <li key={i}>{sanitizeCopy(o)}</li>)}
            </ul>
          </>
        )}
      </div>

      {/* DPIA flag editor */}
      <div style={cardStyle}>
        <div style={headStyle}>DPIA classification inputs</div>
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', margin: '0 0 10px' }}>
          Toggle the flags that describe what this widget actually does. The risk tier
          re-classifies on save (most-restrictive wins).
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {DPIA_FLAGS.map(f => (
            <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!!inputs[f.key]}
                onChange={(e) => toggleFlag(f.key, e.target.checked)}
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <button
            type="button"
            onClick={saveClassification}
            disabled={savingClass}
            style={{
              padding: '6px 14px', fontSize: 12, fontWeight: 600,
              background: 'var(--q-cyan, #00e5ff)', color: '#000', border: 0,
              borderRadius: 6, cursor: savingClass ? 'not-allowed' : 'pointer',
              opacity: savingClass ? 0.5 : 1, fontFamily: 'inherit',
            }}
          >
            {savingClass ? 'Saving…' : 'Save classification'}
          </button>
          {classSaveState === 'saving' && (
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.72)' }}>Saving…</span>
          )}
          {classSaveState === 'saved' && (
            <span style={{ fontSize: 11, color: '#86efac' }}>Saved just now</span>
          )}
          {classSaveState === 'error' && (
            <span style={{ fontSize: 11, color: '#fca5a5' }}>
              Save failed{classSaveError ? ` (${classSaveError})` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Retention */}
      <div style={cardStyle}>
        <div style={headStyle}>Conversation retention</div>
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', margin: '0 0 10px' }}>
          Conversations + messages older than this many days are pruned when cleanup runs.
          Empty = no retention period (conversations are kept until deleted). <code>0</code> = no retention enforced.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>Retention (days):</span>
            <input
              aria-label="Retention days"
              type="number"
              min="0"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              style={{
                width: 80, padding: '4px 8px', borderRadius: 4,
                background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
                color: 'inherit', fontFamily: 'inherit',
              }}
            />
          </label>
          <button
            type="button"
            onClick={saveRetention}
            disabled={savingRet}
            style={{
              padding: '4px 12px', fontSize: 11, fontWeight: 600,
              background: 'rgba(0, 229, 255, 0.1)', color: '#00e5ff',
              border: '1px solid rgba(0, 229, 255, 0.3)', borderRadius: 4,
              cursor: savingRet ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            }}
          >
            {savingRet ? 'Saving…' : 'Save retention'}
          </button>
          <button
            type="button"
            onClick={runCleanup}
            disabled={runningCleanup}
            style={{
              padding: '4px 12px', fontSize: 11, fontWeight: 600,
              background: 'rgba(239, 68, 68, 0.08)', color: '#fca5a5',
              border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: 4,
              cursor: runningCleanup ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
            }}
          >
            {runningCleanup ? 'Running…' : 'Run cleanup now'}
          </button>
        </div>
      </div>

      {error && <div style={{ ...cardStyle, color: '#fca5a5', borderColor: 'rgba(239,68,68,0.3)' }}>{error}</div>}
      {statusMsg && <div style={{ ...cardStyle, color: '#86efac', borderColor: 'rgba(34,197,94,0.3)' }}>{statusMsg}</div>}
    </div>
  );
}

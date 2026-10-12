/**
 * PluginLicenseNotice — shared "why is this locked" surface for governed
 * plugin views (LL-7 rollout).
 *
 * Extracted from GrafanaView, which was the first view migrated from the bare
 * `usePluginLicensed()` boolean (a generic "Activate Plugin - $X" CTA with no
 * reason) to `usePluginLicenseDiagnosis()`, which reports WHY a view is
 * blocked: no org in session, an org licence-slot cap reached, or genuinely
 * unlicensed. The CTA and its label depend on the cause — an org-slot problem
 * is a licence/allowance matter, not a purchase, so it should not say
 * "Activate".
 *
 * Callers own the gate: they call `usePluginLicenseDiagnosis(pluginId)`
 * themselves and decide whether to render this component, so this component
 * takes the resolved `diag` object as a prop rather than re-deriving it.
 *
 * @param {{
 *   diag: { licensed: boolean, code: string, title: string, detail: string,
 *           used?: number, cap?: number, orgId?: string },
 *   displayName: string,
 *   accentColor?: string,
 *   icon?: import('react').ReactNode,
 * }} props
 */

import { useNavigate } from 'react-router-dom'
import { PageLayout } from '../layout'

function DefaultIcon({ color }) {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.5" style={{ marginBottom: 16 }}>
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
    </svg>
  )
}

export default function PluginLicenseNotice({ diag, displayName, accentColor = '#f46800', icon }) {
  const navigate = useNavigate()

  // Report WHY, not a generic "Activate". The action depends on the cause:
  // an org-slot problem is a licence/allowance matter, not a purchase.
  const isOrgIssue = diag.code === 'no_org' || diag.code === 'org_cap' || diag.code === 'org_unassigned'
  const ctaLabel = diag.code === 'no_org' ? 'Switch organisation'
    : isOrgIssue ? 'Manage organisation licences'
    : diag.code === 'loading' ? null
    : 'Open plugin licensing'

  return (
    <PageLayout>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 480 }}>
          {icon || <DefaultIcon color={accentColor} />}
          <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>{displayName} {diag.code === 'loading' ? '' : 'is not active here'}</h2>
          <p style={{ color: accentColor, fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            {diag.title}
          </p>
          <p style={{ color: 'var(--ui-text-secondary)', fontSize: 14, marginBottom: 16, lineHeight: 1.5 }}>
            {diag.detail}
          </p>
          {(diag.used != null && diag.cap != null) && (
            <div style={{ marginBottom: 16, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
              Organisation slots: <strong style={{ color: diag.used >= diag.cap ? '#ff6b6b' : '#fff' }}>{diag.used}/{diag.cap}</strong> used
            </div>
          )}
          {ctaLabel && (
            <button onClick={() => navigate('/settings#plugins')} style={{
              padding: '10px 20px', borderRadius: 8, border: 'none', cursor: 'pointer',
              background: `${accentColor}26`, color: accentColor, fontWeight: 500, fontSize: 14
            }}>
              {ctaLabel}
            </button>
          )}
          <div style={{ marginTop: 18, fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>
            reason: {diag.code}{diag.orgId ? ` · org: ${diag.orgId}` : diag.code === 'no_org' ? ' · org: none' : ''}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}

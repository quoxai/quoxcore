/**
 * GovernancePageLayout — Unified glass shell for governance-adjacent pages.
 *
 * Wraps VOLT, WARD, Evidence, Certification, Policies to give them the
 * same header aesthetic + outer frame as the Compliance Command Center.
 *
 * Pages pass their own content as children; the layout provides:
 *   - Gradient title with protocol colour
 *   - Subtitle + status pill
 *   - Optional actions slot (right side)
 *   - Optional navigation crumbs back to /compliance
 *
 * This is the lightweight alternative to rewriting each view's CSS from
 * scratch. Over time, interior components can migrate to glass-primitives
 * piecemeal without breaking the outer page shell.
 *
 * GLV Stream (2026-04-18)
 */

import { Link } from 'react-router-dom'
import {
  GlassPanel,
  GlassPill,
  COLORS,
  PROTOCOL_COLORS,
  M,
  F,
} from './glass-primitives'

export default function GovernancePageLayout({
  protocol = null,            // 'VOLT' | 'WARD' | 'AEE' | 'AOCL' | null
  title,
  subtitle,
  statusPill = null,          // { label: 'ACTIVE', color: '#30ff90' }
  actions = null,             // right-side action buttons
  crumbs = null,              // array of { label, to } for breadcrumb path
  children,
}) {
  const accent = protocol ? PROTOCOL_COLORS[protocol] || COLORS.cyan : COLORS.cyan

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      height: '100%', minHeight: 0,
      padding: 0,
      background: `radial-gradient(circle at top right, ${accent}08 0%, transparent 70%)`,
    }}>
      {/* Page header — mirrors ComplianceView */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 0' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* Breadcrumbs */}
          {crumbs && crumbs.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>
              {crumbs.map((c, i) => (
                <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {c.to ? (
                    <Link to={c.to} style={{ color: COLORS.subtleText, textDecoration: 'none' }}>{c.label}</Link>
                  ) : (
                    <span style={{ color: '#fff' }}>{c.label}</span>
                  )}
                  {i < crumbs.length - 1 && <span style={{ opacity: 0.4 }}>/</span>}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h1 style={{
              fontFamily: F, fontSize: 20, fontWeight: 800, margin: 0,
              background: `linear-gradient(135deg, ${accent}, #fff)`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              {title}
            </h1>
            {protocol && (
              <span style={{ fontFamily: M, fontSize: 10, color: accent, letterSpacing: 1.5, fontWeight: 700 }}>
                {protocol}
              </span>
            )}
          </div>
          {subtitle && (
            <div style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText, marginTop: 2 }}>
              {subtitle}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {statusPill && (
            <GlassPill color={statusPill.color || COLORS.green}>
              {statusPill.icon !== false && (
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: statusPill.color || COLORS.green,
                  boxShadow: `0 0 6px ${statusPill.color || COLORS.green}60`,
                }} />
              )}
              {statusPill.label}
            </GlassPill>
          )}
          {actions}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {children}
      </div>
    </div>
  )
}

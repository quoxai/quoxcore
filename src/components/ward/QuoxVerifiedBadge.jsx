/**
 * LICENSE-LAUNCH LL-9i3 — Quox Verified badge.
 *
 * An ADDITIVE badge shown next to a WARD tip or a VOLT bundle. It reports one
 * thing only: whether the quox.ai control plane has countersigned this
 * evidence's digest (LL-9i1 /api/verified/countersign, recorded on the tip's
 * sink_ref as `quox-verified:<id>#<seq>` by the LL-9i2 WARD sink).
 *
 * HONESTY BOUNDARY (R5, in code): the badge NEVER speaks to local validity.
 * A locally-valid tip with no countersignature is still locally valid — the
 * absent copy says exactly that ("Local evidence intact") and carries none of
 * the words fake / invalid / untrusted / unverified. The countersignature is
 * an addition, never a gate, so its absence is not a failure.
 */

import { COLORS } from '../compliance/glass-primitives'

const ShieldCheckIcon = ({ color }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={color} strokeWidth="1.8" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
)

const ShieldDashIcon = ({ color }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={color} strokeWidth="1.8" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12h6" />
  </svg>
)

/**
 * Derive the badge's countersignature state from a tip/bundle's sink_ref and an
 * optional countersignature record.
 *
 * @param {string|null} sinkRef - a WARD tip sink_ref (may be comma-joined)
 * @param {{ signed_at?: string, policy_version?: string }|null} [record]
 * @returns {null | { signedAt?: string, policyVersion?: string }}
 *   null when no quox-verified countersignature is on record; otherwise an
 *   object (present state), carrying signed_at / policy_version when known.
 */
export function parseCountersignature(sinkRef, record = null) {
  const hasRef = typeof sinkRef === 'string'
    && sinkRef.split(',').some((r) => r.trim().startsWith('quox-verified:'))
  if (!hasRef && !record) return null
  return {
    signedAt: record?.signed_at || undefined,
    policyVersion: record?.policy_version || undefined,
  }
}

/**
 * @param {object} props
 * @param {null | { signedAt?: string, policyVersion?: string }} props.countersignature
 *   null/undefined => absent state; any object => present state.
 * @param {string} [props.className]
 */
export default function QuoxVerifiedBadge({ countersignature, className }) {
  const present = !!countersignature

  if (!present) {
    return (
      <span
        className={className}
        data-testid="quox-verified-badge"
        data-state="absent"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11, lineHeight: 1.4, color: COLORS.dimText,
          padding: '2px 8px', borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.10)',
          background: 'rgba(255,255,255,0.03)',
        }}
        title="Quox Verified countersignature"
      >
        <ShieldDashIcon color={COLORS.dimText} />
        Local evidence intact - no Quox countersignature on record.
      </span>
    )
  }

  const { signedAt, policyVersion } = countersignature
  const detailed = signedAt && policyVersion
  const text = detailed
    ? `Countersigned by Quox at ${signedAt} under policy ${policyVersion}`
    : 'Countersigned by Quox.'

  return (
    <span
      className={className}
      data-testid="quox-verified-badge"
      data-state="present"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11, lineHeight: 1.4, color: COLORS.green,
        padding: '2px 8px', borderRadius: 10,
        border: `1px solid ${COLORS.green}44`,
        background: `${COLORS.green}14`,
      }}
      title="Quox Verified countersignature"
    >
      <ShieldCheckIcon color={COLORS.green} />
      {text}
    </span>
  )
}

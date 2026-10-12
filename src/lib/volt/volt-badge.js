/**
 * VOLT Certification Badge Generator
 *
 * Produces embeddable SVG badges for certification tiers.
 * Badges include: tier name, shield icon, cert ID, expiry date.
 *
 * Usage:
 *   generateBadgeSVG({ tier: 'silver', cert_id: 'CERT_...', expires_at: '...' })
 */

import { CERT_TIERS, TIER_META } from './volt-certifier.js'

/**
 * Tier-specific badge colors
 */
const BADGE_COLORS = {
  [CERT_TIERS.BRONZE]: {
    bg: '#432818',
    border: '#CD7F32',
    text: '#CD7F32',
    shield: '#CD7F32',
    glow: 'rgba(205, 127, 50, 0.3)'
  },
  [CERT_TIERS.SILVER]: {
    bg: '#2a2a30',
    border: '#C0C0C0',
    text: '#C0C0C0',
    shield: '#C0C0C0',
    glow: 'rgba(192, 192, 192, 0.3)'
  },
  [CERT_TIERS.GOLD]: {
    bg: '#3a3010',
    border: '#FFD700',
    text: '#FFD700',
    shield: '#FFD700',
    glow: 'rgba(255, 215, 0, 0.3)'
  },
  [CERT_TIERS.PLATINUM]: {
    bg: '#2e2e32',
    border: '#E5E4E2',
    text: '#E5E4E2',
    shield: '#E5E4E2',
    glow: 'rgba(229, 228, 226, 0.3)'
  }
}

/**
 * Generate an embeddable SVG badge for a VOLT certification.
 *
 * @param {Object} options
 * @param {string} options.tier - Certification tier (bronze|silver|gold|platinum)
 * @param {string} [options.cert_id] - Certificate ID
 * @param {string} [options.expires_at] - Expiry date ISO string
 * @param {string} [options.run_id] - Run ID
 * @param {number} [options.width=240] - Badge width
 * @param {number} [options.height=80] - Badge height
 * @returns {string} SVG markup
 */
export function generateBadgeSVG(options) {
  const {
    tier,
    cert_id = '',
    expires_at = '',
    width = 240,
    height = 80
  } = options

  if (!tier || !TIER_META[tier]) {
    return generateNoBadgeSVG(width, height)
  }

  const meta = TIER_META[tier]
  const colors = BADGE_COLORS[tier]
  const shortId = cert_id ? cert_id.slice(0, 15) : ''
  const expiryDate = expires_at ? new Date(expires_at).toISOString().split('T')[0] : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="glow-${tier}">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" ry="8"
        fill="${colors.bg}" stroke="${colors.border}" stroke-width="1.5"/>
  <g transform="translate(16, ${height / 2})" filter="url(#glow-${tier})">
    <path d="M0,-16 L12,-10 L12,4 C12,12 0,18 0,18 C0,18 -12,12 -12,4 L-12,-10 Z"
          fill="none" stroke="${colors.shield}" stroke-width="1.5"/>
    <path d="M-4,1 L-1,4 L5,-2" fill="none" stroke="${colors.shield}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="38" y="22" font-family="system-ui, sans-serif" font-size="11" font-weight="700"
        fill="${colors.text}" letter-spacing="0.5">VOLT ${meta.label.toUpperCase()}</text>
  <text x="38" y="37" font-family="system-ui, sans-serif" font-size="10" fill="${colors.text}" opacity="0.8">${meta.name}</text>
  <text x="38" y="54" font-family="monospace" font-size="8" fill="${colors.text}" opacity="0.5">${shortId}</text>
  ${expiryDate ? `<text x="38" y="67" font-family="system-ui, sans-serif" font-size="8" fill="${colors.text}" opacity="0.4">Expires ${expiryDate}</text>` : ''}
</svg>`
}

/**
 * Generate a compact inline badge (shield-only, for headers/lists).
 */
export function generateBadgeInlineSVG(tier, size = 20) {
  if (!tier || !BADGE_COLORS[tier]) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
</svg>`
  }

  const colors = BADGE_COLORS[tier]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" fill="none" stroke="${colors.shield}" stroke-width="1.5"/>
  <path d="M9 12l2 2 4-4" fill="none" stroke="${colors.shield}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
}

/**
 * Placeholder badge when no tier achieved.
 */
function generateNoBadgeSVG(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" ry="8"
        fill="#1a1a1e" stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="4"/>
  <g transform="translate(16, ${height / 2})">
    <path d="M0,-16 L12,-10 L12,4 C12,12 0,18 0,18 C0,18 -12,12 -12,4 L-12,-10 Z"
          fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
  </g>
  <text x="38" y="30" font-family="system-ui, sans-serif" font-size="11" fill="rgba(255,255,255,0.3)">Not Certified</text>
  <text x="38" y="48" font-family="system-ui, sans-serif" font-size="9" fill="rgba(255,255,255,0.2)">Run certification to earn a tier</text>
</svg>`
}

/**
 * Convert an SVG string to a data URI for embedding in img tags.
 */
export function svgToDataUri(svgString) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`
}

/**
 * PluginCard Component
 *
 * Displays a plugin in the settings grid.
 * Consistent glassmorphic cards with:
 * - SVG icons (no emojis)
 * - Clear state distinction: active / inactive / locked
 * - "Open" link for plugins with view pages
 * - Activation celebration glow
 */

import React, { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getTierDisplayName, getTierColor, getStatusColor } from '../../services/pluginClient'
import { pluginHasSettings } from '../../services/pluginConfigStorage'
import { getPrimaryPathForPlugin } from '../../config/navRegistry'

// Fallback routes for plugins whose sidebar nav item is not tagged with a
// pluginId (so getPrimaryPathForPlugin can't find them) — plus the one
// plugin-name / nav-pluginId mismatch (mikrotik-routeros -> nav id 'routeros').
// The nav registry is the canonical source; these fill the untagged gaps.
// When adding a plugin page, tag its nav item with pluginId instead of adding
// a row here, then this map can shrink.
const PLUGIN_ROUTE_FALLBACK = {
  'cognitive-topology': '/topology',
  'codebase-mirror': '/codebase-mirror',
  'opsdeck': '/opsdeck',
  'prompts-library': '/prompts-library',
  'workflow-library': '/workflow-library',
  'files': '/files',
  'backup-restore': '/backup',
  'system-maintenance': '/system',
  'mikrotik-routeros': '/routeros',
  // Chief Team packs unlock chiefs consumed by the shared Agentic Teams
  // page (/teams-overview) rather than owning a dedicated route each.
  'chief-team-small': '/teams-overview',
  'chief-team-medium': '/teams-overview',
  'chief-team-enterprise': '/teams-overview',
}

// SVG icon paths keyed by plugin name
const PLUGIN_ICONS = {
  'advanced-memory':       { d: 'M12 4.5c-1.5-1.5-4-1.5-5.5 0s-1.5 4 0 5.5c-2 1-3 3.5-2 5.5s3.5 3 5.5 2c1.5 1.5 4 1.5 5.5 0s1.5-4 0-5.5c2-1 3-3.5 2-5.5s-3.5-3-5.5-2z M12 4.5v15 M6.5 10h11 M8 15h8', color: '#c084fc' },
  'quoxmind-pro':          { d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 8v4l3 3 M9 2h6 M12 6v2', color: '#a855f7' },
  'quoxmind-complete':     { d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M8 12l2 2 4-4 M12 2v2 M12 20v2 M2 12h2 M20 12h2', color: '#7c3aed' },
  'core-comms':            { d: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0', color: '#fbbf24' },
  'uptime-kuma':           { d: 'M22 12h-4l-3 9L9 3l-3 9H2', color: '#34d399' },
  'grafana':               { d: 'M18 20V10 M12 20V4 M6 20v-6', color: '#f97316' },
  'prometheus':            { d: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z', color: '#ef4444' },
  'proxmox':               { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z', color: '#60a5fa' },
  'quoxagent-fleet':       { d: 'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5', color: '#818cf8' },
  'bastion-fleet':         { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', color: '#f472b6' },
  'cognitive-topology':    { d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z', color: '#22d3ee' },
  'aocl-compliance-suite': { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8', color: '#a78bfa' },
  'aocl-developer-kit':    { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', color: '#fb923c' },
  'backup-restore':        { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8', color: '#6ee7b7' },
  'files':                 { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z', color: '#93c5fd' },
  'action-tracker':        { d: 'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11', color: '#fbbf24' },
  'opsdeck':               { d: 'M12 2L2 7l10 5 10-5-10-5z M12 22V12 M22 7v10 M2 7v10', color: '#818cf8' },
  'web-terminal':          { d: 'M4 17l6-6-6-6 M12 19h8', color: '#34d399' },
  'workflow-library':      { d: 'M12 6V2 M16.24 7.76l2.83-2.83 M18 12h4 M16.24 16.24l2.83 2.83 M12 18v4 M7.76 16.24l-2.83 2.83 M6 12H2 M7.76 7.76L4.93 4.93', color: '#a1a1aa' },
  'system-maintenance':    { d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z', color: '#71717a' },
  'advanced-voice':        { d: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8', color: '#f472b6' },
  'prompts-library':       { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z', color: '#fcd34d' },
  'codebase-mirror':       { d: 'M16 18l6-6-6-6 M8 6l-6 6 6 6', color: '#67e8f9' },
  'mikrotik-routeros':     { d: 'M5 12.55a11 11 0 0 1 14.08 0 M1.42 9a16 16 0 0 1 21.16 0 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01', color: '#4ade80' },
  'docker-fleet':          { d: 'M2 12h4v4H2v-4z M7 12h4v4H7v-4z M12 12h4v4h-4v-4z M7 7h4v4H7V7z M12 7h4v4h-4V7z M12 2h4v4h-4V2z M2 16c0 2 1.5 4 6 5s8 .5 12-1c2-.75 3-2 3-4', color: '#2496ed' },
  'linkedin':              { d: 'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z M2 9h4v12H2z M4 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z', color: '#0A66C2' },
  'facebook':              { d: 'M15 4h-2a5 5 0 0 0-5 5v3H6v4h2v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1h3z', color: '#1877F2' },
  'instagram':             { d: 'M4 4h16v16H4V4z M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M16.5 7.5h.01', color: '#E4405F' },
  'tiktok':                { d: 'M9 18V5l12-2v13 M9 18m-3,0a3,3 0 1,0 6,0a3,3 0 1,0 -6,0 M21 16m-3,0a3,3 0 1,0 6,0a3,3 0 1,0 -6,0', color: '#FE2C55' },
  'discord-pro':           { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z M8.5 11h.01 M15.5 11h.01', color: '#5865F2' },
  'decision-evidence':     { d: 'M9 11l3 3L22 4 M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11', color: '#f59e0b' },
  'github':                { d: 'M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22', color: '#e4e4e7' },
  'local-inference':       { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M7.5 4.21l4.5 2.6 4.5-2.6 M7.5 19.79V14.6L3 12 M21 12l-4.5 2.6v5.19 M3.27 6.96L12 12.01l8.73-5.05 M12 22.08V12', color: '#c084fc' },
  'wazuh':                 { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4', color: '#3cbceb' },
  'cogcore3d':             { d: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96L12 12.01l8.73-5.05 M12 22.08V12', color: '#8b5cf6' }
}

// Fallback icon
const DEFAULT_ICON = { d: 'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5', color: '#71717a' }

/**
 * LICENSE-LAUNCH LL-8: the glyph path + accent colour a card renders for a
 * plugin, exported so FreeClaimPanel's unlock cascade can draw the same
 * chip glyph instead of a generic fallback icon. Falls back to a manifest
 * accent colour, then the flat default, same order PluginCard itself uses.
 */
export function getPluginGlyph(name, accentColorFallback) {
  const icon = PLUGIN_ICONS[name] || DEFAULT_ICON
  return { glyphPath: icon.d, accent: icon.color || accentColorFallback || DEFAULT_ICON.color }
}

function PluginIcon({ name, size = 20, muted }) {
  const icon = PLUGIN_ICONS[name] || DEFAULT_ICON
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={muted ? '#52525b' : icon.color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      style={{ width: size, height: size, flexShrink: 0, transition: 'stroke 0.2s ease' }}>
      {icon.d.split(' M').map((segment, i) => (
        <path key={i} d={i === 0 ? segment : `M${segment}`} />
      ))}
    </svg>
  )
}

export default function PluginCard({ plugin, justActivated, onEnable, onDisable, onGetLicense, onClaimFree, onConfigure }) {
  const navigate = useNavigate()
  const cardRef = useRef(null)
  const tierColor = getTierColor(plugin.tier)
  const isLicensed = plugin.licensed
  const isEnabled = plugin.enabled
  // LICENSE-LAUNCH LL-8: "claimable" is a governed free plugin with no
  // entitlement yet, locked but with a same-session self-serve unlock
  // instead of a paid key, distinct from a plain paid "unlicensed" card.
  const isClaimable = Boolean(plugin.claimable)
  const hasSettings = pluginHasSettings(plugin.name)
  const pluginRoute = getPrimaryPathForPlugin(plugin.name) || PLUGIN_ROUTE_FALLBACK[plugin.name]
  // Manifest accentColor is the fallback BEFORE grey. PLUGIN_ICONS is a
  // hardcoded map, so any plugin not listed in it rendered with a grey rim and
  // no accent glow — visibly "not glassmorphic like the others" — even when
  // its manifest declared a colour. That made the icon map an undocumented
  // 14th point in the registration chain: a plugin could pass every DoD check
  // and still look broken. Reading the manifest fixes it for every future
  // plugin, not just the one that exposed it.
  const accentColor = PLUGIN_ICONS[plugin.name]?.color || plugin.accentColor || '#71717a'

  const handleToggle = (e) => {
    if (isClaimable) {
      onClaimFree?.(plugin.name)
    } else if (!plugin.licensed) {
      onGetLicense?.(plugin.name)
    } else if (plugin.enabled) {
      onDisable?.(plugin.name)
    } else {
      onEnable?.(plugin.name, cardRef.current)
    }
  }

  // Determine card state
  const stateClass = isLicensed
    ? (isEnabled ? 'pc--active' : 'pc--inactive')
    : (isClaimable ? 'pc--claimable' : 'pc--locked')

  const statusLabel = isLicensed
    ? (isEnabled ? 'Active' : 'Disabled')
    : isClaimable
      ? 'Claim free'
      : plugin.status === 'unknown'
        ? 'Unknown'
        : 'Locked'

  return (
    <div
      ref={cardRef}
      data-plugin-name={plugin.name}
      className={`pc ${stateClass} ${isClaimable ? 'qx-locked' : ''} ${justActivated ? 'pc--celebrating' : ''}`}
      style={{ '--pc-accent': accentColor }}
    >
      {/* Brand-color top rim (always on) */}
      <div className="pc__rim" />

      {/* Board-vision chip furniture: stub trace onto the board's bus rail
          (lit only when the chip is seated/on) and the accent bloom that
          gives the "on" state real depth instead of a flat box-shadow.
          Same convention as qx-chipcard (qx-components.css): first children,
          driven purely by --pc-accent + the pc--active/claimable state
          classes already required by the LL-8 acceptance test. */}
      <span className="pc__stub" />
      <span className="pc__bloom" />

      {/* Activation celebration glow overlay */}
      {justActivated && <div className="pc__celebration-glow" />}

      {/* NEW / BETA badge */}
      {plugin.badge && <span className="pc__badge">{plugin.badge}</span>}

      {/* Hover-revealed icon action buttons (top-right of card body) */}
      {(pluginRoute || hasSettings) && (
        <div className="pc__quick-actions">
          {plugin.infoUrl && (
            <a
              href={plugin.infoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pc__quick-btn"
              title="Learn more on quox.ai"
              onClick={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </a>
          )}
          {hasSettings && (
            <button
              className={`pc__quick-btn ${!isLicensed || !isEnabled ? 'pc__quick-btn--disabled' : ''}`}
              onClick={() => isLicensed && isEnabled && onConfigure?.(plugin.name)}
              title={!isLicensed ? 'Activate to configure' : !isEnabled ? 'Enable to configure' : 'Configure'}
              disabled={!isLicensed || !isEnabled}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          )}
          {pluginRoute && isLicensed && isEnabled && (
            <button
              className="pc__quick-btn"
              onClick={() => navigate(pluginRoute)}
              title={`Open ${plugin.displayName}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" y1="14" x2="21" y2="3"/>
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Hero: big icon tile + name/version/status */}
      <div className="pc__hero">
        <div className="pc__icon-tile">
          {/* LICENSE-LAUNCH LL-8: a claimable (free, unclaimed) card keeps
              its accent hue, faded via CSS rather than flattened to the
              paid-locked grey. "Locked but inviting", not "broken". */}
          <PluginIcon name={plugin.name} size={28} muted={!isLicensed && !isClaimable} />
          <span className={`pc__pulse pc__pulse--${plugin.status}`} />
        </div>
        <div className="pc__identity">
          <h3 className="pc__name">{plugin.displayName || plugin.name}</h3>
          <div className="pc__sub">
            <span className={`pc__status-pill pc__status-pill--${plugin.status}`}>
              <span className="pc__status-dot" />
              {statusLabel}
            </span>
            <span className="pc__version">v{plugin.version}</span>
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="pc__desc">{plugin.description}</p>

      {/* Footer strip: tier + price */}
      <div className="pc__footer-meta">
        <span
          className="pc__tier"
          style={{ '--tier-color': tierColor }}
        >
          {getTierDisplayName(plugin.tier)}
        </span>
        {plugin.priceDisplay && (
          <span className={`pc__price ${plugin.priceDisplay === 'Free' ? 'pc__price--free' : ''}`}>
            {plugin.priceDisplay}
          </span>
        )}
      </div>

      {/* Primary action — full-width CTA, with an Open Dashboard button
          above it when the plugin is live and exposes its own page. */}
      <div className="pc__cta-group">
        {pluginRoute && isLicensed && isEnabled && (
          <button
            className="pc__cta pc__cta--open"
            onClick={() => navigate(pluginRoute)}
            title={`Open ${plugin.displayName || plugin.name}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            Open Dashboard
          </button>
        )}
        {isClaimable ? (
          <button className="pc__cta pc__cta--claim" onClick={handleToggle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="8" width="18" height="4" /><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
              <path d="M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 12 8 12 8s2.5-5 4.5-5a2.5 2.5 0 0 1 0 5" />
            </svg>
            Claim Free
          </button>
        ) : !isLicensed ? (
          <button className="pc__cta pc__cta--activate" onClick={handleToggle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Activate Plugin
          </button>
        ) : isEnabled ? (
          <button className="pc__cta pc__cta--disable" onClick={handleToggle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
            </svg>
            Disable
          </button>
        ) : (
          <button className="pc__cta pc__cta--enable" onClick={handleToggle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21"/>
            </svg>
            Enable
          </button>
        )}
      </div>
    </div>
  )
}

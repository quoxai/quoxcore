import { tierMeta, statusMeta, statusColorVar, tierColorVar } from '../lib/colors.js';
import OctaGlyph from './OctaGlyph.jsx';

/**
 * Filled pill badges. Per the "instrument, not gloss" identity pass (owner
 * feedback 2026-07-25), these are now reserved for INTERACTIVE surfaces
 * only: the edit-mode status/tier menu triggers (StatusMenu/TierMenu), and
 * the StreamPage header's tier chip. Everywhere else read-mode status/tier
 * uses <StatusRead>/<TierRead>/<TierNotch> below (tinted text/glyph, no
 * pill background — "editable things look tactile, read-only things look
 * printed").
 */
export function StatusPill({ status, size = 'sm' }) {
  const meta = statusMeta(status);
  return (
    <span className={`qx-pill qx-pill--${size} qx-pill--${meta.variant}`}>{meta.label}</span>
  );
}

/** Tier chip, same variant palette as StatusPill so the two read together. */
export function TierChip({ tier }) {
  const meta = tierMeta(tier);
  return <span className={`qx-pill qx-pill--xs qx-pill--${meta.variant}`}>{meta.label}</span>;
}

/** Read-mode status: octahedron glyph + tinted plain text, no pill background. */
export function StatusRead({ status, size = 14, className = '' }) {
  const meta = statusMeta(status);
  const color = statusColorVar(status);
  return (
    <span className={`qxp-status-read ${className}`.trim()} style={{ color }}>
      <OctaGlyph status={status} size={size} />
      <span>{meta.label}</span>
    </span>
  );
}

/** Read-mode tier: tinted mono text. Used in tables/lists/palette rows —
 * cards use <TierNotch> instead (the notched corner). */
export function TierRead({ tier }) {
  const meta = tierMeta(tier);
  const color = tierColorVar(tier);
  return (
    <span className="qxp-mono" style={{ color }}>
      {meta.label}
    </span>
  );
}

/**
 * Read-mode assignee_scope (QUOXPLAN-P5): a plain mono chip, rendered ONLY
 * when the stream has a scope set — an unassigned stream shows nothing here
 * rather than an empty/placeholder chip.
 */
export function ScopeChip({ scope }) {
  if (!scope) return null;
  return <span className="qx-chip qx-chip--xs qxp-mono">{scope}</span>;
}

/** Notched top-right corner tier marker for cards — replaces the TierChip
 * pill everywhere except the StreamPage header and the edit-mode menu
 * trigger. Renders as a real element (not a pseudo-element) inside a
 * `position: relative` card so it composes cleanly with the card's own
 * ::before accent strip. */
export function TierNotch({ tier }) {
  const color = tierColorVar(tier);
  return (
    <span className="qxp-tier-notch" style={{ '--qxp-tier-color': color }} title={`Tier ${tier}`} aria-hidden="true">
      <span className="qxp-tier-notch__num">{tier}</span>
    </span>
  );
}

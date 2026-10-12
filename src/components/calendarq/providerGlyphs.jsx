/**
 * providerGlyphs — monochrome source-identity glyphs for Calendar-Q layer
 * toggles (AQ-9B design pass, UNIT 2). Mirrors the integrationIcons
 * inline-SVG pattern in src/components/integrations/IntegrationCard.jsx:
 * one inline <svg> per source. Deliberately monochrome (currentColor /
 * explicit rgba per the house icon rule) so brand marks sit quietly in the
 * glass UI — the LAYER COLOUR (layer.color) stays on the dot in
 * LayerSwitcher, these glyphs identify the SOURCE only.
 *
 * `provider`-kind layers are Google Calendar today — the only provider
 * implemented in services/collector/lib/calendarq/providers/google.js.
 * iCloud/CalDAV and Calendly glyphs are banked below for when those
 * providers ship; never claim a connection Calendar-Q cannot make yet.
 */

const glyphStyle = { color: 'rgba(255,255,255,0.82)', display: 'block' };

export function GoogleCalendarGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={glyphStyle} aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 2v4M16 2v4" />
      <path d="M12 14l1.5 1.5L16 13" />
    </svg>
  );
}

export function AppleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={glyphStyle} aria-hidden="true">
      <path d="M16.365 1.43c0 1.14-.468 2.064-1.236 2.766-.818.75-2.07 1.332-3.144 1.248-.144-1.08.414-2.22 1.146-2.916C13.95 1.77 15.39 1.08 16.365 1.43zM20.64 17.07c-.414.96-.906 1.878-1.572 2.73-.906 1.152-1.86 2.304-3.336 2.328-1.428.024-1.884-.846-3.516-.846-1.632 0-2.142.822-3.492.87-1.422.048-2.502-1.254-3.414-2.4-1.854-2.34-3.276-6.6-1.374-9.48.942-1.428 2.628-2.334 4.464-2.358 1.398-.024 2.718.936 3.516.936.798 0 2.388-1.158 4.026-.99.684.03 2.604.276 3.84 2.082-.096.06-2.292 1.332-2.268 3.978.024 3.162 2.772 4.218 2.802 4.23-.024.072-.438 1.5-1.44 2.92z" />
    </svg>
  );
}

export function CalendlyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={glyphStyle} aria-hidden="true">
      <circle cx="9" cy="12" r="6.2" />
      <circle cx="15" cy="12" r="6.2" opacity="0.55" />
    </svg>
  );
}

/** Internal-events layer: the same calendar glyph used on the Calendar-Q
 * toolbar (CalendarQView.jsx CalendarIcon), reproduced here so this module
 * stays a leaf (no import of the view). */
export function InternalEventsGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={glyphStyle} aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function TeamSchedulesGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={glyphStyle} aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

/** Workflow-cron layer: the exact refresh-cw glyph shape AppShell.jsx uses
 * for QLoop's nav icon, reproduced here in monochrome currentColor. */
export function WorkflowCronGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={glyphStyle} aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function GenericCalendarGlyph() {
  return <InternalEventsGlyph />;
}

function providerGlyphFromLabel(displayName, layerId) {
  const probe = `${displayName || ''} ${layerId || ''}`.toLowerCase();
  if (probe.includes('icloud') || probe.includes('apple') || probe.includes('caldav')) return <AppleGlyph />;
  if (probe.includes('calendly')) return <CalendlyGlyph />;
  // Only Google is a live provider today — default here is not a guess:
  // every provider-kind layer Calendar-Q can produce right now IS a Google
  // connection (services/collector/lib/calendarq/providers/google.js).
  return <GoogleCalendarGlyph />;
}

/** glyphForLayer(layer) -> JSX. Single entry point LayerSwitcher (and any
 * future consumer) calls to get the right source glyph for a CalendarLayerV1
 * record, keyed off its `kind`. */
export function glyphForLayer(layer) {
  if (!layer) return <GenericCalendarGlyph />;
  switch (layer.kind) {
    case 'provider':
      return providerGlyphFromLabel(layer.displayName, layer.layerId);
    case 'internal_events':
      return <InternalEventsGlyph />;
    case 'team_schedules':
      return <TeamSchedulesGlyph />;
    case 'workflow_cron':
      return <WorkflowCronGlyph />;
    default:
      return <GenericCalendarGlyph />;
  }
}

export default { glyphForLayer, GoogleCalendarGlyph, AppleGlyph, CalendlyGlyph, InternalEventsGlyph, TeamSchedulesGlyph, WorkflowCronGlyph };

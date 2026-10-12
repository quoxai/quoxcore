/**
 * occurrenceDisplay — shared Calendar-Q occurrence rendering helpers
 * (AQ-9B design pass, UNIT 1). Factored out of CalendarTab.jsx so
 * CalendarGrid.jsx's day-cell chips and overflow flyout reuse the exact
 * same join-url safety check, time formatting, and clash/occurrence card
 * rendering as the agenda list — one source of truth for the sanitization
 * boundary (audit fix 1), never a second copy of it.
 */
import { useState } from 'react';
import ContactChip from '../contactsq/ContactChip';

/** Audit fix 1 (defense in depth): joinUrl is sanitized server-side
 * (providers/google.js normalizeEvent), but every renderer refuses a
 * non-http(s) href independently rather than trusting the upstream value. */
export function isSafeJoinUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

export function formatTime(ts) {
  if (!ts) return 'unknown time';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'unknown time';
  }
}

/** Local date key (YYYY-MM-DD) for an occurrence, honouring its own IANA
 * timezone when present rather than assuming the browser's. */
export function localDateKey(startTs, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startTs));
  } catch {
    return new Date(startTs).toISOString().slice(0, 10);
  }
}

export function formatDateHeading(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function formatTimeRange(occ) {
  if (occ.allDay) return 'All day';
  const opts = { hour: '2-digit', minute: '2-digit' };
  try {
    const start = new Date(occ.startTs).toLocaleTimeString([], { ...opts, timeZone: occ.timezone || undefined });
    const end = new Date(occ.endTs).toLocaleTimeString([], { ...opts, timeZone: occ.timezone || undefined });
    return `${start} – ${end}`;
  } catch {
    return `${new Date(occ.startTs).toLocaleTimeString([], opts)} – ${new Date(occ.endTs).toLocaleTimeString([], opts)}`;
  }
}

/** ClashBadge — qx-severity marker that expands a one-line detail citing the
 * other occurrence(s) it clashes with and the coverage statement that
 * bounds the claim. */
export function ClashBadge({ clash, occurrenceByKey }) {
  const [open, setOpen] = useState(false);
  const others = clash.occurrenceKeys.map((k) => occurrenceByKey.get(k)?.title || k);
  return (
    <span className="qx-disclosure" data-testid="calendarq-clash-badge">
      <button
        type="button"
        className="qx-severity qx-severity--high"
        onClick={() => setOpen((v) => !v)}
        title="Possible double-booking — click for detail"
      >
        Clash
      </button>
      {open && (
        <div className="qx-hint qx-hint--sm" style={{ marginTop: 4 }}>
          Clashes with: {others.join(', ')}. Checked: {clash.windowCoverageStatement}
        </div>
      )}
    </span>
  );
}

export function OccurrenceCard({ occ, layer, clash, occurrenceByKey }) {
  return (
    <div
      className="qx-card qx-card--compact qx-row qx-row--apart"
      style={{ alignItems: 'flex-start', gap: 12 }}
      data-spoken={occ.spokenForm}
      data-testid="calendarq-occurrence-card"
    >
      <div className="qx-row qx-row--tight" style={{ alignItems: 'flex-start', minWidth: 0 }}>
        <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: layer?.color || '#999', marginTop: 5, flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, wordBreak: 'break-word' }}>{occ.title || '(untitled)'}</div>
          <div className="qx-hint qx-hint--sm" style={{ fontFamily: 'var(--qx-font-mono)' }}>{formatTimeRange(occ)}</div>
          {Array.isArray(occ.attendee_contacts) && occ.attendee_contacts.length > 0 && (
            <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap', marginTop: 4 }} data-testid="calendarq-attendee-contacts">
              {occ.attendee_contacts.map((c) => <ContactChip key={c.email_ref} contact={c} testId="calendarq-attendee-chip" />)}
            </div>
          )}
        </div>
      </div>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center', flexShrink: 0 }}>
        {occ.status === 'tentative' && <span className="qx-pill qx-pill--xs qx-pill--medium">Tentative</span>}
        {isSafeJoinUrl(occ.joinUrl) && (
          <a className="qx-btn qx-btn--sm qx-btn--ghost" href={occ.joinUrl} target="_blank" rel="noreferrer">Join</a>
        )}
        {clash && <ClashBadge clash={clash} occurrenceByKey={occurrenceByKey} />}
      </div>
    </div>
  );
}

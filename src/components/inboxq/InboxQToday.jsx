/**
 * InboxQToday — the InboxQ Overview. Rewritten in place per the InboxQ
 * layout audit's section C ("Redesigned Overview"): the old "Today" work
 * briefing (a 200-message sampled reading queue) taught the wrong product —
 * it answered "which message do I open next?" instead of "what is InboxQ
 * doing with my mail, and can I trust these numbers?". This is a management
 * overview: explained zones vs. real folders, honest stats, and a compact
 * activity footer. No message rows, no sampling, no reading queue.
 *
 * SCOPE (audit build plan, step 2): uses the EXISTING GET /zones aggregate
 * for the Stored messages stat and account.folders for Folders selected.
 * Action signals and Pending proposals need new/rescoped server queries
 * (audit section C's stats table, step 3) and are shown as explicitly
 * unavailable ("—") here rather than fabricated from data that doesn't
 * answer the question the label asks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './lib/api.js';
import {
  ZONES,
  ZONE_BTN_TINT,
  ZONES_VS_FOLDERS_TITLE,
  ZONES_VS_FOLDERS_INTRO,
  ZONES_EXPLAINER,
  FOLDERS_EXPLAINER,
  ZONES_VS_FOLDERS_EXAMPLE,
  ZONES_FOOTER_NOTE,
} from './shared.js';

// No durable per-user/org UI preference API exists yet for this ack (audit D:
// "if no durable preference API exists, session memory is an honest interim
// fallback"). sessionStorage means every new browser session sees the full
// disclosure once again, which is the honest failure mode here — never a
// silent account-level setting nobody asked for.
const DISCLOSURE_ACK_KEY = 'inboxq-zones-disclosure-ack-v1';

function readDisclosureAck() {
  try {
    return sessionStorage.getItem(DISCLOSURE_ACK_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDisclosureAck() {
  try {
    sessionStorage.setItem(DISCLOSURE_ACK_KEY, '1');
  } catch {
    /* session-only fallback; nothing durable to fail here */
  }
}

function formatReportWhen(report) {
  const iso = report?.structured?.generatedAt;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
  }
  return report?.reportDate || '';
}

const FolderGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

/** The "Zones and folders: what's the difference?" first-run disclosure
 * (audit D, verbatim copy). Open on a user's first connected Overview visit,
 * compact thereafter; always reachable via "How zones work". */
function ZonesVsFoldersDisclosure({ innerRef, open, onToggle, onAck }) {
  return (
    <details
      ref={innerRef}
      className="qx-disclosure"
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
      data-testid="inboxq-zones-disclosure"
    >
      <summary className="qx-disclosure__head">
        <span className="qx-disclosure__chev">▸</span> {ZONES_VS_FOLDERS_TITLE}
      </summary>
      <div className="qx-disclosure__body qx-stack qx-stack--tight">
        <p style={{ margin: 0 }}>{ZONES_VS_FOLDERS_INTRO}</p>
        <div>
          <strong>Zones · automatic triage</strong>
          <p style={{ margin: '4px 0 0' }}>{ZONES_EXPLAINER}</p>
        </div>
        <div>
          <strong>Folders · on your mail server</strong>
          <p style={{ margin: '4px 0 0' }}>{FOLDERS_EXPLAINER}</p>
        </div>
        <div>
          <strong>For example</strong>
          <p style={{ margin: '4px 0 0' }}>{ZONES_VS_FOLDERS_EXAMPLE}</p>
        </div>
        <p className="qx-hint qx-hint--sm" style={{ margin: 0 }}>{ZONES_FOOTER_NOTE}</p>
        <div>
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--primary"
            onClick={(e) => { e.preventDefault(); onAck(); }}
          >
            Got it
          </button>
        </div>
      </div>
    </details>
  );
}

/** One "Needs you" tile — Screened or "Unsure to check", given a left accent
 * so a real backlog reads as something to act on rather than a passive
 * stat. `unavailable` renders "—" for the count when the number itself is
 * not known yet (loading, errored, or filing is off); the Open action is
 * gated separately by `onOpen` being present so a message list can still be
 * opened, if there's somewhere to open, even while the count is loading. */
function NeedsYouTile({ label, value, unavailable, hint, actionLabel, onOpen, testId }) {
  return (
    <div className="qx-card qx-surface--backed qx-stack qx-stack--tight iq-needs-you-tile" data-testid={testId}>
      <div className="qx-row qx-row--apart" style={{ alignItems: 'baseline' }}>
        <span className="qx-section-title" style={{ margin: 0 }}>{label}</span>
        <span className="qx-stat__value" style={{ fontSize: 22 }}>{unavailable ? '—' : value}</span>
      </div>
      <span className="qx-hint qx-hint--sm">{hint}</span>
      {actionLabel && onOpen && (
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--primary"
          style={{ alignSelf: 'flex-start' }}
          onClick={onOpen}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** One "Mailbox at a glance" tile. `unavailable` renders "—" and a muted
 * subcopy explaining why, instead of a fabricated zero — an unwired stat and
 * a genuine zero must never look the same (audit C, "do not fabricate"). */
function OverviewStat({ label, value, sub, unavailable, actionLabel, onAction }) {
  return (
    <div className="qx-stat" data-testid={`inboxq-overview-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <span className="qx-stat__head">{label}</span>
      <span className="qx-stat__value">{unavailable ? '—' : value}</span>
      <span className="qx-stat__sub">{sub}</span>
      {actionLabel && onAction && (
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          style={{ alignSelf: 'flex-start', marginTop: 2 }}
          onClick={onAction}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** One "Your zones" explainer card — name, count, what lands here, how mail
 * gets here, and the one interactive control (Open {zone}). Audit D's
 * zone-card copy is used verbatim via shared.js's ZONES entries. */
function ZoneCard({ zone: z, count, onOpen }) {
  return (
    <article className="qx-card qx-surface--backed qx-stack qx-stack--tight" data-testid={`inboxq-zone-card-${z.key}`}>
      <div className="iq-zone-card__head">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: 15 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: z.color, flexShrink: 0 }} />
          {z.label}
        </h3>
        <span className="qx-hint qx-hint--sm">{count} stored messages</span>
      </div>
      <p style={{ margin: 0, fontSize: 14 }}>{z.description}</p>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-secondary)' }}>{z.howItWorks}</p>
      <button
        type="button"
        className="qx-btn qx-btn--sm qx-btn--tint"
        style={{ '--qx-btn-tint': ZONE_BTN_TINT[z.key] || z.color, alignSelf: 'flex-start' }}
        onClick={() => onOpen(z.key)}
      >
        Open {z.label} →
      </button>
    </article>
  );
}

export default function InboxQToday({
  accountId,
  mailboxLabel,
  folders = [],
  zoneCounts = {},
  proposalsCount = 0,
  report,
  lastSync,
  onOpenZone,
  onOpenAllMessages,
  onOpenFolder,
  onOpenReport,
  onOpenProposals,
  onOpenSettings,
}) {
  const [disclosureOpen, setDisclosureOpen] = useState(() => !readDisclosureAck());
  const disclosureRef = useRef(null);

  const ackDisclosure = useCallback(() => {
    setDisclosureOpen(false);
    writeDisclosureAck();
  }, []);

  const openDisclosure = useCallback(() => {
    setDisclosureOpen(true);
    disclosureRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Active-watches summary for the management-activity footer. Uses the
  // EXISTING listWatches wrapper (no new client method) — a genuine query
  // failure is shown as an error, never silently folded into "no watches".
  const [watchesCount, setWatchesCount] = useState(null);
  const [watchesError, setWatchesError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setWatchesCount(null);
    setWatchesError(false);
    api.listWatches({ activeOnly: true }, { force: true })
      .then((d) => { if (!cancelled) setWatchesCount((d?.watches || []).length); })
      .catch(() => { if (!cancelled) setWatchesError(true); });
    return () => { cancelled = true; };
  }, [accountId]);

  // "Needs you" — physical filing status (P3), so the Overview can surface
  // the "Unsure to check" folder count alongside the always-known Screened
  // zone count (owner requirement: nothing missed). A genuine query failure
  // or filing being off is shown honestly rather than folded into a zero.
  const [filingStatus, setFilingStatus] = useState(null);
  const [filingStatusError, setFilingStatusError] = useState(false);
  const [unsureCount, setUnsureCount] = useState(null);
  const [unsureCountError, setUnsureCountError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFilingStatus(null);
    setFilingStatusError(false);
    if (!accountId) return undefined;
    api.getFilingStatus(accountId)
      .then((d) => { if (!cancelled) setFilingStatus(d || null); })
      .catch(() => { if (!cancelled) setFilingStatusError(true); });
    return () => { cancelled = true; };
  }, [accountId]);

  const unsureFolder = filingStatus?.enabled ? (filingStatus?.folders?.unsure || null) : null;

  useEffect(() => {
    let cancelled = false;
    setUnsureCount(null);
    setUnsureCountError(false);
    if (!accountId || !unsureFolder) return undefined;
    api.listByFolder({ accountId, folder: unsureFolder }, { force: true })
      .then((d) => {
        if (cancelled) return;
        setUnsureCount(typeof d?.total === 'number' ? d.total : (d?.messages || []).length);
      })
      .catch(() => { if (!cancelled) setUnsureCountError(true); });
    return () => { cancelled = true; };
  }, [accountId, unsureFolder]);

  const zoneCountValues = Object.values(zoneCounts).map((n) => Number(n) || 0);
  const storedTotal = zoneCountValues.reduce((a, b) => a + b, 0);
  const unclassifiedCount = Number(zoneCounts.unclassified) || 0;
  const foldersCount = folders.length;

  const lastSyncLabel = lastSync
    ? `Last manual sync attempt: ${lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'Last manual sync attempt: unavailable';

  return (
    <div className="iq-overview qx-stack" data-testid="inboxq-today-panel">
      {/* (a) Overview header */}
      <div className="qx-stack qx-stack--tight" style={{ gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#fff' }}>Overview</h1>
        <span className="qx-hint qx-hint--sm">{mailboxLabel || 'Mailbox'}</span>
        <span>Manage how your mail is classified and filed.</span>
        <span className="qx-hint qx-hint--sm">{lastSyncLabel}</span>
      </div>

      {/* (a2) Needs you — Screened + Unsure to check, always the first thing
          shown after the header (owner requirement: nothing gets missed). */}
      <div className="qx-stack qx-stack--tight">
        <span className="qx-section-title" style={{ margin: 0 }}>Needs you</span>
        <div className="qx-grid-2 iq-needs-you-grid">
          <NeedsYouTile
            testId="inboxq-needs-you-screened"
            label="Screened"
            value={zoneCounts.screened ?? 0}
            hint="Suspected junk, cold outreach, and mail from senders you've blocked."
            actionLabel="Open Screened →"
            onOpen={() => onOpenZone('screened')}
          />
          <NeedsYouTile
            testId="inboxq-needs-you-unsure"
            label="Unsure to check"
            value={unsureCount}
            unavailable={!unsureFolder || unsureCountError || unsureCount == null}
            hint={
              !filingStatus?.enabled
                ? 'Turn on physical filing in Settings to see mail InboxQ was unsure about.'
                : unsureCountError
                  ? 'Could not load this count.'
                  : 'Mail InboxQ could not confidently classify; worth a quick look.'
            }
            actionLabel="Open folder →"
            onOpen={unsureFolder && onOpenFolder ? () => onOpenFolder(unsureFolder) : null}
          />
        </div>
      </div>

      {/* (b) First-run zones vs folders disclosure */}
      <ZonesVsFoldersDisclosure
        innerRef={disclosureRef}
        open={disclosureOpen}
        onToggle={setDisclosureOpen}
        onAck={ackDisclosure}
      />

      {/* (c) Mailbox at a glance */}
      <div className="qx-stack qx-stack--tight">
        <span className="qx-section-title" style={{ margin: 0 }}>Mailbox at a glance</span>
        {/* Two real stats only. The former "Action signals" and "Pending
            proposals" tiles were permanent "—" placeholders (unbuilt / unscoped)
            that made the Overview read as busy and half-broken (owner audit:
            "too busy for guidance to sink in"); proposals already surface in the
            activity footer below when there are any. */}
        <div className="qx-grid-2 iq-stats-grid">
          <OverviewStat
            label="Stored messages"
            value={storedTotal}
            sub="Mail stored in InboxQ."
            actionLabel="View mail →"
            onAction={onOpenAllMessages}
          />
          <OverviewStat
            label="Folders selected"
            value={foldersCount}
            sub="Selected for future syncs."
            actionLabel="Manage folders →"
            onAction={onOpenSettings}
          />
        </div>
        {unclassifiedCount > 0 && (
          <span className="qx-hint qx-hint--sm">
            {unclassifiedCount} stored message{unclassifiedCount === 1 ? '' : 's'} {unclassifiedCount === 1 ? 'is' : 'are'} not classified yet.
          </span>
        )}
        <span className="qx-hint qx-hint--sm">
          Counts cover mail stored in InboxQ, including mail imported from previously selected folders; they may differ from your mail server.
        </span>
      </div>

      {/* (d) Your zones */}
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <span className="qx-section-title" style={{ margin: 0 }}>Your zones</span>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={openDisclosure}>
            How zones work
          </button>
        </div>
        <span>InboxQ automatically classifies stored mail into these four zones. Changing a zone does not move mail between folders.</span>
        <div className="qx-grid-2 iq-zone-grid">
          {ZONES.map((z) => (
            <ZoneCard key={z.key} zone={z} count={zoneCounts[z.key] ?? 0} onOpen={onOpenZone} />
          ))}
        </div>
      </div>

      {/* (e) Folders selected for sync */}
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <span className="qx-section-title" style={{ margin: 0 }}>Folders selected for sync</span>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onOpenSettings}>
            Manage synced folders
          </button>
        </div>
        <span className="qx-hint qx-hint--sm">Real locations on your mail server.</span>
        {foldersCount === 0 ? (
          <span className="qx-hint qx-hint--sm">No folders selected yet.</span>
        ) : (
          <div className="qx-row qx-row--wrap" style={{ gap: 8 }}>
            {folders.slice(0, 5).map((f) => (
              <span key={f} className="qx-chip iq-folder-chip" title={f}>
                <FolderGlyph /> {f}
              </span>
            ))}
            {foldersCount > 5 && (
              <span className="qx-hint qx-hint--sm">+{foldersCount - 5} more</span>
            )}
          </div>
        )}
      </div>

      {/* (f) Management activity */}
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <span className="qx-hint qx-hint--sm">
            {report ? `Latest report: generated ${formatReportWhen(report) || 'recently'}.` : 'No report generated yet.'}
          </span>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onOpenReport}>Open report</button>
        </div>
        {watchesError ? (
          <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
            <span className="qx-hint qx-hint--sm">Could not check active watches.</span>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onOpenSettings}>Manage watches</button>
          </div>
        ) : watchesCount > 0 ? (
          <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
            <span className="qx-hint qx-hint--sm">{watchesCount} active watch{watchesCount === 1 ? '' : 'es'}.</span>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onOpenSettings}>Manage watches</button>
          </div>
        ) : null}
        {proposalsCount > 0 && (
          <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
            <span className="qx-hint qx-hint--sm">{proposalsCount} proposal{proposalsCount === 1 ? '' : 's'} awaiting a decision.</span>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onOpenProposals}>Review proposals</button>
          </div>
        )}
      </div>
    </div>
  );
}

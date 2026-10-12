/**
 * InboxQReport — renders the collector's structured daily-brief report
 * (`report.structured`, see services/collector/lib/inboxq/report.js) in the
 * QuoxSEO sectioned-data-view style: header + coverage, a summary strip of
 * navigable counts, then titled sections of concrete findings. No markdown
 * parsing, no distribution chart, no synthetic "time saved".
 *
 * FALLBACK: reports saved before `structured` existed only carry
 * `bodyMd`/`counts`. Those render through the existing MarkdownContent
 * renderer, clearly labeled as a legacy text report, inside the same backed
 * surface.
 *
 * Email-derived text (subjects, senders, snippets) is always rendered as
 * plain text here — never as HTML/markdown — matching the reader's own
 * safe-inbox handling.
 */
import MarkdownContent from '../ui/MarkdownContent.jsx';
import { ZONES, formatWhen } from './shared.js';

function formatGeneratedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** One finding row: sender, subject, date+time, current zone, snippet. Opens
 * the message directly in the reader on click — same row shape as Today. */
function ReportItemRow({ item, onOpen }) {
  const zoneMeta = ZONES.find((z) => z.key === item.zone);
  return (
    <div
      className="iq-mail-row"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item); } }}
    >
      <div className="qx-stack" style={{ gap: 2, width: '100%' }}>
        <div className="qx-row qx-row--apart" style={{ alignItems: 'baseline' }}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.fromName || item.fromAddr || 'Unknown sender'}
          </strong>
          <span className="qx-hint qx-hint--sm" style={{ flexShrink: 0 }}>{formatWhen(item.dateTs)}</span>
        </div>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.subject || '(no subject)'}
        </div>
        {zoneMeta && (
          <div className="qx-row qx-row--tight">
            <span className="qx-chip qx-chip--xs" style={{ borderColor: zoneMeta.color, color: zoneMeta.color }}>
              {zoneMeta.label}
            </span>
          </div>
        )}
        {item.snippet && (
          <p className="qx-hint qx-hint--sm" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.snippet}
          </p>
        )}
      </div>
    </div>
  );
}

/** One titled section. An empty section is one calm line, not zero cards;
 * "unavailable" (state !== 'available'/'empty') gets its own honest line
 * rather than being folded into "empty". */
function ReportSection({ section, onOpenMessage }) {
  const items = section.items || [];
  const total = section.total ?? items.length;
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <span className="qx-section-title" style={{ margin: 0 }}>{section.title}</span>
        {total > items.length && <span className="qx-hint qx-hint--sm">Showing {items.length} of {total}</span>}
      </div>
      {section.state === 'unavailable' ? (
        <span className="qx-hint qx-hint--sm">Not available in this report.</span>
      ) : items.length === 0 ? (
        <span className="qx-hint qx-hint--sm">Nothing in this section.</span>
      ) : (
        <div className="qx-stack" style={{ gap: 2 }}>
          {items.map((item) => <ReportItemRow key={item.id} item={item} onOpen={onOpenMessage} />)}
        </div>
      )}
    </div>
  );
}

export default function InboxQReport({ report, onOpenMessage, onGenerate, generating }) {
  if (!report) {
    return (
      <div className="qx-card qx-surface--backed qx-empty" data-testid="inboxq-report-panel">
        <div className="qx-empty__title">No report yet</div>
        <div className="qx-empty__body">Generate one to get a plain-language summary of what came in.</div>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" disabled={generating} onClick={onGenerate}>
          {generating ? 'Generating…' : 'Generate report'}
        </button>
      </div>
    );
  }

  const s = report.structured;

  // Legacy fallback: reports saved before report.structured existed.
  if (!s) {
    return (
      <div className="qx-card qx-surface--backed qx-stack qx-stack--tight" data-testid="inboxq-report-panel">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <span className="qx-section-title" style={{ margin: 0 }}>Daily report</span>
          {report.reportDate && <span className="qx-hint qx-hint--sm">{report.reportDate}</span>}
        </div>
        <div className="qx-banner qx-banner--info">
          Legacy text report: generated before structured data was available. Shown as plain text below.
        </div>
        {report.bodyMd
          ? <MarkdownContent compact>{report.bodyMd}</MarkdownContent>
          : <span className="qx-hint qx-hint--sm">This report has no readable content.</span>}
      </div>
    );
  }

  const coverage = s.coverage || {};
  const coverageComplete = coverage.complete !== false;

  return (
    <div className="qx-card qx-surface--backed qx-stack" data-testid="inboxq-report-panel">
      {/* Header */}
      <div className="qx-stack qx-stack--tight" style={{ gap: 4 }}>
        <div className="qx-row qx-row--apart" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <span className="qx-section-title" style={{ margin: 0 }}>
            {s.period?.label || 'Mailbox snapshot'}{s.mailbox?.label ? ` · ${s.mailbox.label}` : ''}
          </span>
          <span className="qx-hint qx-hint--sm">Generated {formatGeneratedAt(s.generatedAt)}</span>
        </div>
        {coverageComplete ? (
          <span className="qx-hint qx-hint--sm">{coverage.included ?? 0} messages reviewed.</span>
        ) : (
          <div className="qx-banner qx-banner--warn">
            In checked sample: {coverage.included ?? 0} of {coverage.totalStored ?? '?'} stored messages.
            This is not a whole-inbox all-clear.
          </div>
        )}
      </div>

      <div className="qx-divider" />

      {/* Summary strip */}
      {(s.summary || []).length > 0 && (
        <>
          <div className="qx-grid-auto" style={{ '--qx-grid-min': '180px' }}>
            {s.summary.map((stat) => (
              <div key={stat.id} className="qx-stat">
                <span className="qx-stat__head">{stat.label}</span>
                <span className="qx-stat__value">{stat.count}</span>
              </div>
            ))}
          </div>
          <div className="qx-divider" />
        </>
      )}

      {/* Sections */}
      <div className="qx-stack">
        {(s.sections || []).map((section) => (
          <ReportSection key={section.id} section={section} onOpenMessage={onOpenMessage} />
        ))}
      </div>
    </div>
  );
}

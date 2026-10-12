/**
 * InboxQMessageReader — full-body reader pane for InboxQ's master-detail
 * layout (see InboxQView.jsx / .qx-master-detail).
 *
 * Fetches the full message via api.getMessage (list rows only carry a
 * snippet) and renders bodyHtml sanitized through DOMPurify, falling back to
 * bodyText (line breaks preserved) when no HTML body was captured. Runs a
 * safe-inbox pass: remote images stay blocked (a remote image load is also a
 * read receipt) until the human clicks "Show remote content", inline
 * style url()s are stripped while blocked, and <script>/<iframe>/<object>/
 * <embed> are never allowed through regardless. Links always open in a new
 * tab without leaking a referrer or window handle.
 */
import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { api } from './lib/api.js';
import { useTextSize } from '../ui/TextSizeControl';
import ContactChip from '../contactsq/ContactChip';
import { usePluginLicensed } from '../../hooks/usePluginLicensed';
import { api as notesApi } from '../notesq/lib/api';
import { emailToNote } from '../notesq/lib/emailToNote';
import { ZONES, ZONE_BTN_TINT, FLAG_META, PHISH_META, authResultTone, formatFullWhen, formatBytes } from './shared.js';

const NoteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="M9 15h6" />
  </svg>
);

const BackIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
  </svg>
);
const PrevIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 15l-6-6-6 6" />
  </svg>
);
const NextIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
const BlockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M5.5 5.5l13 13" />
  </svg>
);
const EyeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" />
  </svg>
);
const PaperclipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/** Extension label for an attachment chip: the filename's own extension when
 * it has one, otherwise a best-effort guess from the MIME subtype. Never
 * invents a name — only ever derives from data already on the attachment. */
function extFromAttachment(a) {
  const filename = a?.filename || '';
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && dot < filename.length - 1) {
    const ext = filename.slice(dot + 1);
    if (ext.length <= 8) return ext.toUpperCase();
  }
  const subtype = (a?.contentType || '').split('/')[1] || '';
  return subtype.split(';')[0].toUpperCase() || 'FILE';
}

/** Plain-text fallback for HTML-only mail: runs the already-sanitized body
 * through a detached DOMParser, turning block-level closing tags and <br>
 * into line breaks before reading textContent, then collapsing runs of 3+
 * blank lines down to 2 so the result reads like a real message, not a
 * wall of whitespace. */
function htmlToPlainText(html) {
  if (!html) return '';
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  const text = doc.body ? (doc.body.textContent || '') : '';
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Sanitizes a captured message's bodyHtml. While `allowRemote` is false:
 * remote <img> elements are swapped for a small "[image blocked]" span
 * (::before doesn't render on replaced elements like <img>, so the
 * placeholder needs a real node), srcset is dropped, and any url(...) in an
 * inline style attribute is stripped. <iframe>/<object>/<embed>/<style>/
 * <form> are forbidden outright; DOMPurify's own defaults already strip
 * <script> and on* handlers. Every link gets target=_blank plus
 * rel="noopener noreferrer". Returns the sanitized HTML and how many images
 * it blocked, so the "Show remote content" prompt only appears when there's
 * actually something to reveal.
 */
function sanitizeMessageBody(rawHtml, { allowRemote }) {
  let blockedCount = 0;

  const afterSanitizeAttributes = (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (!allowRemote && node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (src && node.parentNode) {
        const placeholder = node.ownerDocument.createElement('span');
        placeholder.className = 'qx-chip qx-chip--xs iq-blocked-image';
        placeholder.textContent = '[image blocked]';
        node.parentNode.replaceChild(placeholder, node);
        blockedCount += 1;
        return;
      }
      node.removeAttribute('srcset');
    }
    if (!allowRemote && node.hasAttribute('style')) {
      node.setAttribute('style', node.getAttribute('style').replace(/url\([^)]*\)/gi, ''));
    }
  };

  DOMPurify.addHook('afterSanitizeAttributes', afterSanitizeAttributes);
  let html;
  try {
    html = DOMPurify.sanitize(rawHtml || '', {
      FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'style'],
      ADD_ATTR: ['target'],
    });
  } finally {
    // Synchronous call above, nothing else can interleave — safe to always
    // remove the hook we just added rather than leak it onto every other
    // DOMPurify.sanitize() call in the app (MemorySearchPanel, CodeSearch...).
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
  return { html, blockedCount };
}

/** Compact SPF/DKIM/DMARC chip, coloured by result via the shared tone map. */
function AuthChip({ label, result }) {
  return (
    <span className={`qx-pill qx-pill--xs qx-pill--${authResultTone(result)}`}>
      {label} {result || 'unknown'}
    </span>
  );
}

/** Reader security panel: surfaces the backend's SPF/DKIM/DMARC verdicts plus
 * display-name-spoof and punycode-domain signals, so a phishing attempt is
 * visible without hunting through raw headers. Clean mail (risk 0, everything
 * passed) collapses into a closed disclosure rather than shouting; anything
 * with a risk score gets an open, coloured banner instead, more prominent the
 * stronger the signal (see PHISH_META in shared.js). */
function SecurityPanel({ security, phishingRisk }) {
  if (!security) return null;
  const { spf, dkim, dmarc, displayNameSpoof, punycode } = security;
  const allPass = spf === 'pass' && dkim === 'pass' && dmarc === 'pass' && !displayNameSpoof && !punycode;
  const risk = phishingRisk || 0;
  const phishMeta = PHISH_META[risk];

  const warnings = [];
  if (displayNameSpoof) warnings.push('Sender name does not match the sending address.');
  if (punycode) warnings.push('Lookalike (internationalized) domain.');

  const chips = (
    <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
      <AuthChip label="SPF" result={spf} />
      <AuthChip label="DKIM" result={dkim} />
      <AuthChip label="DMARC" result={dmarc} />
    </div>
  );

  if (risk === 0 && allPass) {
    return (
      <details className="qx-disclosure iq-reader-security" data-testid="inboxq-security-panel">
        <summary className="qx-disclosure__head">
          <span className="qx-disclosure__chev">▸</span> Sender authentication: passed
        </summary>
        <div className="qx-disclosure__body">{chips}</div>
      </details>
    );
  }

  return (
    <div
      className={`qx-banner iq-reader-security ${risk === 2 ? 'qx-banner--error' : 'qx-banner--warn'}`}
      style={{ alignItems: 'flex-start' }}
      data-testid="inboxq-security-panel"
    >
      <div className="qx-stack qx-stack--tight" style={{ width: '100%' }}>
        <span className="qx-banner__title">
          {phishMeta ? phishMeta.label : 'Sender authentication'}
        </span>
        {chips}
        {warnings.map((w) => (
          <span key={w} className="qx-hint qx-hint--sm">{w}</span>
        ))}
      </div>
    </div>
  );
}

export default function InboxQMessageReader({
  message,
  backLabel,
  onBack,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onMove,
  onBlock,
  folders = [],
  onMoveToFolder,
  onTrustSender,
  onConfirmJunk,
}) {
  const notesLicensed = usePluginLicensed('notesq');
  // NotesQ-look (AQ-9E): the email body reads on the obsidian .qx-slate surface,
  // with a per-device text-size control that scales only the body (not chrome).
  const [zoom, textSizeControl] = useTextSize('quox.inboxq.textZoom');
  const [noteSave, setNoteSave] = useState({ state: 'idle' }); // idle | saving | saved {id, snippetOnly} | error {msg}
  useEffect(() => { setNoteSave({ state: 'idle' }); }, [message?.id]);
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [allowRemote, setAllowRemote] = useState(false);
  const [viewMode, setViewMode] = useState('text');
  const [fetchingBody, setFetchingBody] = useState(false);
  const [fetchBodyError, setFetchBodyError] = useState(null);
  const [folderPick, setFolderPick] = useState('');
  const [moving, setMoving] = useState(false);
  const [confirmingJunk, setConfirmingJunk] = useState(false);

  // Auto-fetches the body once per message id: getMessage first (list rows
  // only carry a snippet), and if that returns neither bodyHtml nor bodyText
  // (an older stored message, or one from before body capture existed), an
  // immediate on-demand fetch-body call — no manual "Fetch full message"
  // button, just a Retry surfaced below on failure.
  useEffect(() => {
    if (!message?.id) {
      setFull(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFull(null);
    setAllowRemote(false);
    setViewMode('text');
    setFetchingBody(false);
    setFetchBodyError(null);
    setFolderPick('');
    setMoving(false);
    setConfirmingJunk(false);

    api.getMessage(message.id)
      .then(async (d) => {
        if (cancelled) return;
        const msg = d?.message || null;
        setFull(msg);
        setLoading(false);
        if (msg && !msg.bodyHtml && !msg.bodyText) {
          setFetchingBody(true);
          try {
            const d2 = await api.fetchMessageBody(message.id);
            if (!cancelled) setFull(d2?.message || msg);
          } catch (e) {
            if (!cancelled) setFetchBodyError(e.message || 'Could not fetch the full message.');
          } finally {
            if (!cancelled) setFetchingBody(false);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message || 'Could not load this message.');
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [message?.id]);

  const handleConfirmJunkClick = async () => {
    if (!onConfirmJunk || !message) return;
    setConfirmingJunk(true);
    try {
      await onConfirmJunk(message);
    } finally {
      setConfirmingJunk(false);
    }
  };

  const handleMoveToFolderClick = async () => {
    if (!folderPick || !onMoveToFolder || !message) return;
    setMoving(true);
    try {
      await onMoveToFolder(message, folderPick);
    } finally {
      setMoving(false);
    }
  };

  const handleRetryFetchBody = () => {
    if (!message?.id) return;
    setFetchingBody(true);
    setFetchBodyError(null);
    api.fetchMessageBody(message.id)
      .then((d) => setFull(d?.message || null))
      .catch((e) => setFetchBodyError(e.message || 'Could not fetch the full message.'))
      .finally(() => setFetchingBody(false));
  };

  const { html: sanitizedHtml, blockedCount } = useMemo(() => {
    if (!full?.bodyHtml) return { html: '', blockedCount: 0 };
    return sanitizeMessageBody(full.bodyHtml, { allowRemote });
  }, [full?.bodyHtml, allowRemote]);

  // Plain text is the default view: prefer the captured bodyText, and only
  // derive from the sanitized HTML when no plain-text body was captured.
  const plainText = useMemo(() => {
    if (full?.bodyText) return full.bodyText;
    if (sanitizedHtml) return htmlToPlainText(sanitizedHtml);
    return '';
  }, [full?.bodyText, sanitizedHtml]);

  // The reader is only ever visible when data-detail-open="true" gates it
  // into the DOM (InboxQView.jsx) — there is no "nothing selected" state to
  // render here.
  if (!message) return null;

  const flags = message.flags || [];
  const initial = (message.fromName || message.fromAddr || '?').trim().charAt(0).toUpperCase() || '?';
  const zoneMeta = ZONES.find((z) => z.key === message.zone);
  const fullDate = formatFullWhen(message.dateTs);
  const hasBody = !!(full?.bodyHtml || full?.bodyText);
  const attachments = Array.isArray(full?.attachments) ? full.attachments : [];
  const attachmentCount = message.attachmentCount || 0;
  const showAttachments = full && (attachments.length > 0 || attachmentCount > 0);

  return (
    <div
      className="iq-reader qx-stack qx-stack--tight"
      data-testid="inboxq-message-reader"
      style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
    >
      {/* ── Header bar card: sender, subject, flags, security + reader tools.
           Split out from the body so the email itself sits on its own slate
           (NotesQ look: header card + body card). ─────────────────────────── */}
      <header className="qx-card qx-card--compact qx-stack qx-stack--tight iq-reader-bar">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onBack}>
            <BackIcon /> Back to {backLabel}
          </button>
          <div className="qx-row qx-row--tight">
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" disabled={!hasPrev} onClick={onPrev} title="Previous message">
              <PrevIcon /> Previous
            </button>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" disabled={!hasNext} onClick={onNext} title="Next message">
              Next <NextIcon />
            </button>
          </div>
        </div>

        <div className="qx-row qx-row--apart" style={{ alignItems: 'flex-start' }}>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span
              className="qx-avatar"
              aria-hidden="true"
              style={zoneMeta ? { background: `${zoneMeta.color}33`, color: zoneMeta.color } : undefined}
            >
              {initial}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{message.fromName || 'Unknown sender'}</div>
              <div className="qx-hint qx-hint--sm" style={{ wordBreak: 'break-all' }}>{message.fromAddr || 'No address on record'}</div>
              {(full?.sender_contact || message.sender_contact) && (
                <div style={{ marginTop: 4 }}><ContactChip contact={full?.sender_contact || message.sender_contact} testId="inboxq-sender-contact" /></div>
              )}
            </div>
          </div>
          <div className="qx-row qx-row--tight" style={{ flexShrink: 0, alignItems: 'center' }}>
            {zoneMeta && (
              <span className="qx-chip qx-chip--xs" style={{ borderColor: zoneMeta.color, color: '#fff' }}>
                {zoneMeta.label}
              </span>
            )}
            {notesLicensed && (
              noteSave.state === 'saved'
                ? <a className="qx-btn qx-btn--sm" href={`/notes?note=${encodeURIComponent(noteSave.id)}`} data-testid="inboxq-saved-note"><NoteIcon /> {noteSave.snippetOnly ? 'Saved (preview only)' : 'Saved'}: open note</a>
                : (
                  <button
                    type="button"
                    className="qx-btn qx-btn--sm"
                    disabled={noteSave.state === 'saving'}
                    onClick={async () => {
                      setNoteSave({ state: 'saving' });
                      try {
                        const n = emailToNote({ ...message, ...(full || {}) });
                        const r = await notesApi.createNote({ scope: 'user', markdown: n.markdown, properties: n.properties });
                        setNoteSave({ state: 'saved', id: r?.note?.id, snippetOnly: n.bodySource === 'snippet' });
                      } catch (e) {
                        setNoteSave({ state: 'error', msg: e?.message || 'save failed' });
                      }
                    }}
                    title={noteSave.state === 'error' ? `Could not save: ${noteSave.msg}. Click to retry.` : 'Save this email to your personal NotesQ notes'}
                  >
                    <NoteIcon /> {noteSave.state === 'saving' ? 'Saving...' : noteSave.state === 'error' ? 'Retry save to notes' : 'Save to notes'}
                  </button>
                )
            )}
            <button
              type="button"
              className="qx-btn qx-btn--danger qx-btn--lg"
              onClick={() => onBlock(message, 'sender')}
              title={`Block ${message.fromAddr || 'this sender'}: Quox screens this sender and moves their mail out of your flow. Not a mail-server rule.`}
            >
              <BlockIcon /> Block
            </button>
          </div>
        </div>

        <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 600, wordBreak: 'break-word' }}>
          {message.subject || '(no subject)'}
        </h2>

        <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
          {fullDate && <span className="qx-hint qx-hint--sm">{fullDate}</span>}
          {flags.map((f) => {
            const meta = FLAG_META[f];
            return meta
              ? (
                <span key={f} className="qx-chip" style={{ fontSize: 12, borderColor: meta.color, color: meta.color }} title={meta.title}>
                  {meta.glyph} {meta.label}
                </span>
              )
              : <span key={f} className="qx-chip qx-chip--xs">{f}</span>;
          })}
        </div>

        {showAttachments && (
          <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }} data-testid="inboxq-attachments">
            <PaperclipIcon />
            {attachments.length > 0 ? (
              attachments.map((a, i) => (
                <span
                  key={`${a.filename}-${i}`}
                  className="qx-chip iq-attachment-chip"
                  title="Attachment shown for visibility; preview and download are coming."
                >
                  <span className="iq-attachment-chip__name">{a.filename}</span>
                  <span> · {extFromAttachment(a)} · {formatBytes(a.size)}</span>
                </span>
              ))
            ) : (
              <span
                className="qx-chip iq-attachment-chip"
                title="Attachment shown for visibility; preview and download are coming."
              >
                {attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}

        {full?.security && (
          <SecurityPanel security={full.security} phishingRisk={full.phishingRisk ?? message.phishingRisk} />
        )}

        {/* Reader tools: plain/HTML mode switch (stays a plain .qx-seg — it is a
            mode, not a tint tool) and the per-device text-size control. */}
        <div className="qx-row qx-row--apart iq-reader-tools" style={{ alignItems: 'center' }}>
          <div className="qx-row qx-row--tight">
            {full?.bodyHtml && hasBody && (
              <div className="qx-seg">
                <button
                  type="button"
                  className={`qx-seg__btn${viewMode === 'text' ? ' qx-seg__btn--active' : ''}`}
                  onClick={() => setViewMode('text')}
                >
                  Plain text
                </button>
                <button
                  type="button"
                  className={`qx-seg__btn${viewMode === 'html' ? ' qx-seg__btn--active' : ''}`}
                  onClick={() => setViewMode('html')}
                >
                  HTML
                </button>
              </div>
            )}
          </div>
          {textSizeControl}
        </div>
      </header>

      {error && (
        <div className="qx-banner qx-banner--error" data-testid="inboxq-reader-error">
          Couldn't load this message: {error}
        </div>
      )}

      {/* ── Body slate card: the email itself on the obsidian surface, text
           scaled by the header's size control via --qx-text-zoom. ─────────── */}
      <div
        className="qx-card qx-card--compact qx-slate iq-reader-slate"
        style={{ '--qx-text-zoom': zoom }}
        data-testid="inboxq-reader-slate"
      >
        <div className="iq-reader-body" data-testid="inboxq-reader-body">
          {loading ? (
            <p className="qx-hint qx-hint--sm">{message.snippet || 'Loading message…'}</p>
          ) : fetchingBody ? (
            <p className="qx-hint qx-hint--sm">
              <span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" />
              Fetching full message…
            </p>
          ) : full ? (
            hasBody ? (
              <>
                {viewMode === 'html' && full.bodyHtml ? (
                  <>
                    {blockedCount > 0 && !allowRemote && (
                      <div className="qx-banner qx-banner--warn qx-row qx-row--apart" style={{ alignItems: 'center', marginBottom: 10 }}>
                        <span>Remote images are blocked to protect your privacy ({blockedCount} blocked).</span>
                        <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={() => setAllowRemote(true)}>
                          <EyeIcon /> Show remote content
                        </button>
                      </div>
                    )}
                    {/* Sanitized via DOMPurify + the safe-inbox hook above — never render full.bodyHtml directly. */}
                    <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
                  </>
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{plainText || 'No preview text available for this message.'}</div>
                )}
              </>
            ) : (
              <div className="qx-stack qx-stack--tight">
                <div className="qx-hint qx-hint--sm">
                  This message has no captured body text yet, only the subject line and metadata were stored.
                </div>
                {fetchBodyError && (
                  <div className="qx-banner qx-banner--error" data-testid="inboxq-fetch-body-error">
                    Couldn't fetch this message: {fetchBodyError}
                  </div>
                )}
                <div>
                  <button
                    type="button"
                    className="qx-btn qx-btn--sm qx-btn--ghost"
                    onClick={handleRetryFetchBody}
                    disabled={fetchingBody}
                  >
                    {fetchingBody ? 'Fetching…' : 'Retry'}
                  </button>
                </div>
              </div>
            )
          ) : !error ? (
            <p className="qx-hint qx-hint--sm">{message.snippet || 'No preview text available for this message.'}</p>
          ) : null}
        </div>
      </div>

      {/* ── Actions card ─────────────────────────────────────────────────── */}
      <div className="qx-card qx-card--compact qx-stack qx-stack--tight iq-reader-actions" data-testid="inboxq-message-actions">
        <span className="qx-section-title">Actions</span>
        <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
          <span className="qx-hint qx-hint--sm">Move to:</span>
          {ZONES.filter((z) => z.key !== message.zone).map((z) => (
            <button
              key={z.key}
              type="button"
              className="qx-btn qx-btn--sm qx-btn--tint"
              style={{ '--qx-btn-tint': ZONE_BTN_TINT[z.key] || z.color }}
              onClick={() => onMove(message, z.key)}
            >
              {z.label}
            </button>
          ))}
          {message.zone === 'screened' && onConfirmJunk && (
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--tint"
              style={{ '--qx-btn-tint': '#f59e0b' }}
              onClick={handleConfirmJunkClick}
              disabled={confirmingJunk}
              title="Confirm this message is junk and move it to your Junk folder."
            >
              {confirmingJunk ? 'Moving…' : 'Confirm junk'}
            </button>
          )}
          {onTrustSender && (
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--ghost"
              onClick={() => onTrustSender(message)}
              title={`Tell InboxQ ${message.fromAddr || 'this sender'} is not junk. Their mail moves back to Focus.`}
            >
              Trusted sender (not junk)
            </button>
          )}
        </div>
        <span className="qx-hint qx-hint--sm">
          Moving trains the filter so future mail from this sender learns from it. Filing to a folder and
          blocking both happen immediately, with an Undo.
        </span>

        {onMoveToFolder && (
          <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }} data-testid="inboxq-reader-move-folder">
            <span className="qx-hint qx-hint--sm">Move to folder:</span>
            <select
              className="qx-select"
              style={{ width: 'auto', minWidth: 160 }}
              value={folderPick}
              onChange={(e) => setFolderPick(e.target.value)}
              aria-label="Move to folder"
              disabled={folders.length === 0 || moving}
            >
              <option value="">{folders.length === 0 ? 'No synced folders' : 'Choose a folder…'}</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--ghost"
              onClick={handleMoveToFolderClick}
              disabled={!folderPick || moving}
            >
              {moving ? 'Moving…' : 'Move'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * InboxQView — InboxQ mounted as a native Quox dashboard view.
 *
 * Master-detail email-client layout: a command-strip Toolbar, a vertical
 * navigation column (Overview, then two clearly separated groups — the four
 * automatic Zones and the real Folders on the mail server — then Report,
 * Proposals, Settings), and one main pane that shows exactly one surface at
 * a time (the Overview, a zone's message list + full-area preview, the
 * report, proposals, or settings). Only one thing renders in the main pane
 * at once — no split list+detail columns and no horizontal zone tabs, so
 * the list and the preview both get the full width.
 *
 * v1 is read-first and proposal-only: Sync pulls and classifies new mail,
 * Report is a generated summary, and Proposals records a human decision
 * without moving or sending anything yet (see lib/inboxq/api.js's header
 * comment on the collector side). Single account/org in v1 — the account
 * selector is future-proofing for when an org connects more than one
 * mailbox.
 *
 * Layout: the route has no PageLayout wrapper, so `.iq-view`/`.iq-workspace`/
 * `.iq-body`/`.iq-nav`/`.iq-main` establish their own bounded height chain
 * (InboxQ layout audit, section B, 2026-09-26) and Overview/Report/Proposals/
 * Settings render inside one `.qx-scroll-pane` document scroller; the zone
 * message list + reader keep using the shared `.qx-master-detail` utility.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, clearApiCache } from './lib/api.js';
import InboxQLocked from './InboxQLocked.jsx';
import InboxQOnboarding from './InboxQOnboarding.jsx';
import InboxQMessageReader from './InboxQMessageReader.jsx';
import InboxQNewFolderModal from './InboxQNewFolderModal.jsx';
import InboxQToday from './InboxQToday.jsx';
import InboxQReport from './InboxQReport.jsx';
import InboxQChatSidebar from './InboxQChatSidebar.jsx';
import InboxQRulesPanel from './InboxQRules.jsx';
import InboxQFilingSection from './InboxQFilingSection.jsx';
import { ProposalCard } from './InboxQProposalPresentation.jsx';
import { usePluginLicensed, usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import LicenceGate from '../plugins/LicenceGate';
import { ZONES, ZONE_BTN_TINT, FLAG_META, PHISH_META, formatWhen, formatFullWhen } from './shared.js';
import './inboxq.css';

const GearIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const OverviewIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" />
  </svg>
);

const ReportIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
    <path d="M9 13h6M9 17h6" />
  </svg>
);

const ProposalsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);

/** Rules: a funnel, the standing auto-sort logic new mail passes through
 * before a human ever sees it (owner's "I can't control that in the app"
 * blocker). Deliberately distinct from the gear (Settings, account-level
 * config) and the check (Proposals, one-off human decisions). */
const RulesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 4h16l-6.5 8.5v6L10.5 21v-8.5z" />
  </svg>
);

/** Real mail-server folder icon — deliberately distinct from the zone dot,
 * so a folder row never reads as a fifth zone (audit A#2). */
const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);

/** Toolbar: what surface this is, which mailbox, and the actions that touch
 * the outside world (sync mail, generate the daily report, open settings). */
function Toolbar({ accounts, accountId, onAccountChange, onSync, syncing, syncProgress, onReclassify, reclassifying, onGenerateReport, generating, showSettings, onToggleSettings, lastSync }) {
  return (
    <div className="qx-card qx-card--bar qx-surface--backed qx-row qx-row--apart iq-toolbar">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: '#8fd6ff' }}>
          <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 6l10 7 10-7" />
        </svg>
        <strong>InboxQ</strong>
        <span className="qx-hint qx-hint--sm" title="What this surface is for">
          Triage your mailbox. Your filing, re-zoning and blocking happen immediately, with an undo.
        </span>
        {accounts.length > 0 && (
          <select
            className="qx-select qx-select--auto"
            aria-label="Mailbox"
            value={accountId || ''}
            onChange={(e) => onAccountChange(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.displayName || a.emailAddress}</option>
            ))}
          </select>
        )}
      </div>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        {syncing && syncProgress
          ? (
            <span className="qx-hint qx-hint--sm" data-testid="inboxq-sync-progress">
              importing… {Number(syncProgress.stored || 0).toLocaleString()} message{syncProgress.stored === 1 ? '' : 's'}
              {syncProgress.folders && syncProgress.folders.total
                ? ` · ${syncProgress.folders.backfilled}/${syncProgress.folders.total} folders`
                : ''}
            </span>
          )
          : (lastSync && <span className="qx-hint qx-hint--sm">synced {lastSync.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>)}
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          disabled={!accountId || syncing}
          onClick={onSync}
        >
          {syncing ? (<><span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" /> Syncing…</>) : 'Sync'}
        </button>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          disabled={!accountId || reclassifying}
          onClick={onReclassify}
          title="Re-sort this InboxQ view with the latest rules and what InboxQ has learned. It never moves or changes mail on your server."
        >
          {reclassifying ? (<><span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" /> Re-classifying…</>) : 'Re-classify'}
        </button>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--primary"
          disabled={!accountId || generating}
          onClick={onGenerateReport}
        >
          {generating ? (<><span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" /> Generating…</>) : 'Generate report'}
        </button>
        <button
          type="button"
          className={`qx-btn qx-btn--sm ${showSettings ? 'qx-btn--primary' : 'qx-btn--ghost'}`}
          onClick={onToggleSettings}
          aria-pressed={showSettings}
          title="InboxQ settings"
        >
          <GearIcon /> Settings
        </button>
      </div>
    </div>
  );
}

/** Left-hand navigation: Overview, then two clearly separated groups (audit
 * A#2/E) — the four automatic Zones and the real IMAP Folders this mailbox
 * syncs — then Report, Proposals and Settings. Renamed from FoldersNav:
 * zones are InboxQ classifications, not folders on the mail server, so they
 * no longer share one undifferentiated "folders" list or aria-label. Folder
 * rows are real buttons (owner's #1 pre-onboarding blocker): clicking one
 * opens that folder's stored messages, the same master-detail shape as a
 * zone. "Manage synced folders" stays the one control that changes WHICH
 * folders sync at all. */
function InboxQNav({ zones, zoneCounts, folders, folderTree, folderTreeLive, folderTreeLoading, folderTreeGmail, mainView, activeZone, activeFolder, proposalsCount, onSelectOverview, onSelectZone, onSelectFolder, onSelectReport, onSelectProposals, onSelectRules, onSelectSettings, onManageFolders, onNewFolder }) {
  // AQ-9E U4 (folder-first): the real folder tree is the PRIMARY surface. Use
  // the enriched tree (hierarchy + stored counts + coverage); fall back to the
  // flat watched list only until the tree loads. Zones become "lenses" below —
  // saved views over this real folder truth, never separate physical folders.
  const tree = Array.isArray(folderTree) && folderTree.length > 0
    ? folderTree
    : (folders || []).map((f) => ({ path: f, name: f, depth: 0, stored: 0, watched: true }));
  return (
    <nav
      className="qx-tabs qx-tabs--vert qx-surface--backed inboxq-folders iq-nav"
      aria-label="InboxQ navigation"
      data-testid="inboxq-folders-nav"
    >
      <button
        type="button"
        className={`qx-tab iq-nav-home${mainView === 'overview' ? ' qx-tab--active' : ''}`}
        onClick={onSelectOverview}
      >
        <OverviewIcon /> Overview
      </button>

      <div className="qx-divider" style={{ margin: '4px 2px' }} />

      <div className="iq-nav-group-label">
        {folderTreeGmail ? 'Labels · your Gmail labels' : 'Folders · your real mail server'}
        {folderTreeLoading && (
          <span className="qx-spinner qx-spinner--sm" style={{ marginLeft: 6 }} aria-label="Loading folders" />
        )}
        {!folderTreeLoading && folderTreeLive === false && (
          <span className="qx-chip qx-chip--xs" title="Could not reach the mail server just now; showing the last-known folders." style={{ marginLeft: 6 }}>last known</span>
        )}
      </div>
      <div className="iq-nav-group-hint">
        {folderTreeGmail
          ? 'Your real Gmail labels. Moving mail here relabels it in Gmail, so your other apps see it too.'
          : 'Real folders on your mail server. Moving mail here updates the server, so Apple Mail, Gmail and your other apps show it too.'}
      </div>
      {tree.length > 0 ? (
        tree.map((node) => {
          const active = mainView === 'folder' && activeFolder === node.path;
          return (
            <button
              key={node.path}
              type="button"
              className={`qx-tab iq-nav-folder-row${active ? ' qx-tab--active' : ''}`}
              onClick={() => onSelectFolder(node.path)}
              title={node.watched === false ? `${node.path} (not synced by InboxQ yet)` : node.path}
              aria-current={active ? 'true' : undefined}
              style={{ paddingLeft: 10 + (node.depth || 0) * 14 }}
              data-testid="inboxq-folder-tree-row"
            >
              <FolderIcon />
              <span className="iq-nav-folder-row__path">{node.name}</span>
              {node.watched === false && (
                <span className="qx-chip qx-chip--xs" title="Not synced by InboxQ yet">off</span>
              )}
              {node.stored > 0 && (
                <span className="qx-badge" aria-label={`${node.stored} stored`}>{node.stored}</span>
              )}
            </button>
          );
        })
      ) : (
        <div className="iq-nav-group-hint">
          {folderTreeGmail ? 'No labels yet. Sync to pull your Gmail labels.' : 'No folders yet. Sync to pull your mail server’s folders.'}
        </div>
      )}
      {/* Gmail: labels are created/managed in Gmail, not here — hide the
          folder-only controls so the labels view stays clean (v1). */}
      {!folderTreeGmail && (
        <>
          <button type="button" className="qx-tab" onClick={onManageFolders}>
            <span style={{ flex: 1, textAlign: 'left', fontSize: 12 }}>Manage synced folders</span>
          </button>
          <button type="button" className="qx-tab" onClick={onNewFolder}>
            <span style={{ flex: 1, textAlign: 'left', fontSize: 12 }}>+ New folder</span>
          </button>
        </>
      )}

      <div className="qx-divider" style={{ margin: '4px 2px' }} />

      <div className="iq-nav-group-label">Lenses · saved views, not folders</div>
      <div className="iq-nav-group-hint">Views over your real mail, grouped by how InboxQ triaged it. They filter, they do not move anything.</div>
      {zones.map((z) => {
        const active = mainView === 'zone' && activeZone === z.key;
        const count = zoneCounts[z.key] ?? 0;
        return (
          <button
            key={z.key}
            type="button"
            className={`qx-tab${active ? ' qx-tab--active' : ''}`}
            onClick={() => onSelectZone(z.key)}
            title={z.description}
          >
            <span
              aria-hidden="true"
              style={{ width: 8, height: 8, borderRadius: '50%', background: z.color, flexShrink: 0, boxShadow: active ? `0 0 8px ${z.color}` : 'none' }}
            />
            <span style={{ flex: 1, textAlign: 'left' }}>{z.label}</span>
            <span className="qx-badge" aria-label={`${count} stored messages`}>{count}</span>
          </button>
        );
      })}

      <div className="qx-divider" style={{ margin: '4px 2px' }} />

      <button
        type="button"
        className={`qx-tab${mainView === 'report' ? ' qx-tab--active' : ''}`}
        onClick={onSelectReport}
      >
        <ReportIcon /> <span style={{ flex: 1, textAlign: 'left' }}>Report</span>
      </button>
      <button
        type="button"
        className={`qx-tab${mainView === 'proposals' ? ' qx-tab--active' : ''}`}
        onClick={onSelectProposals}
      >
        <ProposalsIcon /> <span style={{ flex: 1, textAlign: 'left' }}>Proposals</span>
        {proposalsCount > 0 && <span className="qx-badge qx-badge--alert">{proposalsCount}</span>}
      </button>
      <button
        type="button"
        className={`qx-tab${mainView === 'rules' ? ' qx-tab--active' : ''}`}
        onClick={onSelectRules}
        title="See and control the auto-sort rules that file, screen, or block mail as it arrives"
      >
        <RulesIcon /> <span style={{ flex: 1, textAlign: 'left' }}>Rules</span>
      </button>
      <button
        type="button"
        className={`qx-tab${mainView === 'settings' ? ' qx-tab--active' : ''}`}
        onClick={onSelectSettings}
      >
        <GearIcon /> <span style={{ flex: 1, textAlign: 'left' }}>Settings</span>
      </button>
    </nav>
  );
}

/** Destination header for a folder-scoped message list — deliberately
 * un-zone-tinted (audit A#2: a folder must never read as a fifth zone) and
 * honest about what "N stored messages" means: mail InboxQ has synced from
 * this real mail-server folder, not a live IMAP count. */
function FolderHeader({ folder, count, total }) {
  const truncated = total > count;
  return (
    <div className="iq-folder-header" data-testid="inboxq-folder-header">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center', minWidth: 0 }}>
          <FolderIcon />
          <strong style={{ fontSize: 15, wordBreak: 'break-all' }}>{folder}</strong>
          <span className="qx-chip qx-chip--xs">IMAP folder</span>
        </div>
        <span className="qx-hint qx-hint--sm" style={{ flexShrink: 0 }}>
          {truncated ? `Showing ${count} of ${total} stored messages` : `${count} stored message${count === 1 ? '' : 's'}`}
        </span>
      </div>
      <span className="qx-hint qx-hint--sm">
        Stored mail from this mail-server folder; messages can belong to any zone.
      </span>
    </div>
  );
}

const BlockRowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M5.5 5.5l13 13" />
  </svg>
);

const PaperclipIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
  </svg>
);

/** Client-side CSV of the already-loaded blocked-senders list — no new API,
 * quotes/escapes the target so a comma or quote in an address can't corrupt
 * the row, and triggers a plain Blob download (no server round trip). */
function downloadBlockedSendersCsv(blocked) {
  const escapeCsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = 'type,target,blocked_at';
  const rows = blocked.map((b) => [b.type || 'sender', escapeCsv(b.target), b.blockedAt || ''].join(','));
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `inboxq-blocklist-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** One message row in the flat, backed list, laid out as an aligned column
 * grid (avatar / sender / subject+snippet / meta — see inboxq.css). Every
 * triage verb (move to another zone, propose filing, block) sits on the row
 * itself as a hover/focus-revealed action cluster, so the owner can act on
 * a message without opening it. Clicking the row body still opens the
 * reader beside it (wide) or in its place (narrow); the list itself stays
 * mounted so scroll position survives. */
function MessageRow({ message, selected, onOpen, onBlock, onMove, onFileToFolder, folders = [], onConfirmJunk, bulkChecked, onToggleBulk }) {
  const [fileOpen, setFileOpen] = useState(false);
  const [allFromSender, setAllFromSender] = useState(false);
  const flags = message.flags || [];
  const visibleFlags = flags.slice(0, 2);
  const extraFlagCount = flags.length - visibleFlags.length;
  const phishMeta = PHISH_META[message.phishingRisk];
  // AQ-9E U1: uid === null is the explicit "location not pinned" marker set by
  // an interactive move the server could not give a confirmed destination UID
  // for (no UIDPLUS/COPYUID). The row still points at the right message by
  // Message-ID (re-resolved on open), but its mailbox position is unverified —
  // surface that honestly rather than letting it look like any other row.
  const unresolvedLoc = message.uid === null;
  const initial = (message.fromName || message.fromAddr || '?').trim().charAt(0).toUpperCase() || '?';
  const unread = !message.seen;
  const zoneMeta = ZONES.find((z) => z.key === message.zone);
  const moveZones = ZONES.filter((z) => z.key !== message.zone);

  const open = () => onOpen(message);
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

  return (
    <div
      className="iq-mail-row"
      data-testid="inboxq-message-row"
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
    >
      <span className="iq-mail-row__select" onClick={(e) => e.stopPropagation()}>
        <label className="qx-checkbox">
          <input
            type="checkbox"
            checked={!!bulkChecked}
            onChange={() => onToggleBulk(message.id)}
            aria-label={`Select message from ${message.fromName || message.fromAddr || 'unknown sender'}`}
          />
          <span className="qx-checkbox__box" />
        </label>
      </span>
      <span className="iq-mail-row__avatar">
        <span
          className="qx-avatar qx-avatar--sm"
          aria-hidden="true"
          style={zoneMeta ? { background: `${zoneMeta.color}33`, color: zoneMeta.color } : undefined}
        >
          {initial}
        </span>
        {unread && <span className="qx-dot qx-dot--info qx-dot--sm" aria-hidden="true" />}
        {unread && <span className="sr-only">Unread</span>}
      </span>

      <div className="iq-mail-row__sender">
        <span className="iq-mail-row__name" style={{ fontWeight: unread ? 700 : 500 }}>
          {message.fromName || message.fromAddr || 'Unknown sender'}
        </span>
        {message.fromAddr && (
          <span className="iq-mail-row__addr qx-hint qx-hint--sm">{message.fromAddr}</span>
        )}
      </div>

      <div className="iq-mail-row__subject">
        <span className="iq-mail-row__subject-line">
          <span style={{ fontWeight: unread ? 600 : 400 }}>{message.subject || '(no subject)'}</span>
          {message.snippet && <span className="iq-mail-row__snippet"> · {message.snippet}</span>}
        </span>
        {(phishMeta || unresolvedLoc || visibleFlags.length > 0) && (
          <div className="iq-mail-row__flags">
            {phishMeta && (
              <span
                className={`qx-pill qx-pill--xs qx-pill--${phishMeta.tone}`}
                title={phishMeta.title}
                data-testid="inboxq-phish-badge"
              >
                {phishMeta.glyph}
              </span>
            )}
            {unresolvedLoc && (
              <span
                className="qx-pill qx-pill--xs qx-pill--warn"
                title="Location not pinned. This message was moved on the server, but Quox could not confirm its new mailbox UID, so its position is unverified. It re-resolves by Message-ID when you open it."
                data-testid="inboxq-unresolved-badge"
              >
                ⟳ location
              </span>
            )}
            {visibleFlags.map((f) => {
              const meta = FLAG_META[f];
              return meta
                ? (
                  <span key={f} className="qx-chip qx-chip--xs" style={{ borderColor: meta.color, color: meta.color }} title={meta.title}>
                    {meta.glyph} {meta.label}
                  </span>
                )
                : <span key={f} className="qx-chip qx-chip--xs">{f}</span>;
            })}
            {extraFlagCount > 0 && <span className="qx-chip qx-chip--xs">+{extraFlagCount}</span>}
          </div>
        )}
      </div>

      <div className="iq-mail-row__meta">
        {message.attachmentCount > 0 && (
          <span title="Has attachments" aria-hidden="true"><PaperclipIcon /></span>
        )}
        <span className="qx-hint qx-hint--sm">{formatWhen(message.dateTs)}</span>
      </div>

      <div className="iq-mail-row__acts" role="group" aria-label="Row actions">
        {moveZones.map((z) => (
          <button
            key={z.key}
            type="button"
            className="qx-btn qx-btn--sm qx-btn--tint"
            style={{ '--qx-btn-tint': ZONE_BTN_TINT[z.key] || z.color }}
            onClick={stop(() => onMove(message, z.key))}
            title={`Change zone to ${z.label}`}
          >
            {z.label}
          </button>
        ))}
        <span className="iq-mail-row__acts-sep" aria-hidden="true" />
        <div className="iq-file-wrap" style={{ position: 'relative' }}>
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--primary"
            onClick={stop(() => setFileOpen((o) => !o))}
            aria-haspopup="menu"
            aria-expanded={fileOpen}
            title="File to a folder (optionally all mail from this sender)"
          >
            File
          </button>
          {fileOpen && (
            <>
              {/* click-outside backdrop (below the menu, above the row) */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={stop(() => { setFileOpen(false); setAllFromSender(false); })} />
              <div className="qx-menu" role="menu" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 40, minWidth: 220, maxWidth: 'none', textAlign: 'left' }}>
                <div className="qx-menu__header">File to folder</div>
                {message.fromAddr && (
                  <label className="qx-menu__item" style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="qx-checkbox" checked={allFromSender} onChange={(e) => setAllFromSender(e.target.checked)} />
                    <span>All from {message.fromName || message.fromAddr}</span>
                  </label>
                )}
                <div className="qx-menu__sep" aria-hidden="true" />
                {folders.length === 0 ? (
                  <div className="qx-menu__item qx-hint qx-hint--sm">No folders yet. Create one first.</div>
                ) : folders.map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="qx-menu__item"
                    role="menuitem"
                    onClick={stop(() => { onFileToFolder(message, f, allFromSender); setFileOpen(false); setAllFromSender(false); })}
                  >
                    {f.replace(/^INBOX\./, '')}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {message.zone === 'screened' && onConfirmJunk && (
          <>
            <span className="iq-mail-row__acts-sep" aria-hidden="true" />
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--tint"
              style={{ '--qx-btn-tint': '#f59e0b' }}
              onClick={stop(() => onConfirmJunk(message))}
              title="Confirm this message is junk and move it to your Junk folder."
            >
              Confirm junk
            </button>
          </>
        )}
        <span className="iq-mail-row__acts-sep" aria-hidden="true" />
        {message.zone === 'screened' ? (
          // Already screened/in Spam: a red "Block" here looked pointless (the
          // mail is already out of the way). Blocking still earns its place as
          // the FUTURE-sender rule, so it stays but as a quiet "Block sender"
          // that is clearly distinct from "Confirm junk" (which moves THIS
          // message to the real Junk folder).
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--ghost"
            onClick={stop(() => onBlock(message, 'sender'))}
            title={`Block the sender${message.fromAddr ? ` ${message.fromAddr}` : ''}: stop their FUTURE mail. This message is already screened; use Confirm junk to move it to your Junk folder. Holds in Quox, not a mail-server rule.`}
          >
            <BlockRowIcon /> Block sender
          </button>
        ) : (
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--danger"
            onClick={stop(() => onBlock(message, 'sender'))}
            title={`Block the sender${message.fromAddr ? ` ${message.fromAddr}` : ''}: screen their current mail out of view and auto-screen anything they send in future. Holds in Quox, not a mail-server rule.`}
          >
            <BlockRowIcon /> Block
          </button>
        )}
      </div>
    </div>
  );
}

/** Compact bulk action bar (P1 manual sort): rendered above the message list
 * only once one or more rows are checked, one action — move the selected
 * messages to a real mail-server folder. The picker lists only this
 * account's own synced folders; an empty list disables the control rather
 * than pretending there's somewhere to move to. */
function BulkActionBar({ count, folders, folder, onFolderChange, onMove, moving, onClear, showConfirmJunk, onConfirmJunk, confirmingJunk }) {
  return (
    <div className="qx-card qx-surface--backed qx-row iq-bulk-bar" data-testid="inboxq-bulk-bar">
      <strong>{count} selected</strong>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <select
          className="qx-select iq-bulk-bar__folder-select"
          value={folder}
          onChange={(e) => onFolderChange(e.target.value)}
          aria-label="Move selected to folder"
          disabled={folders.length === 0 || moving}
        >
          <option value="">{folders.length === 0 ? 'No synced folders' : 'Move to folder…'}</option>
          {folders.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--primary"
          onClick={onMove}
          disabled={!folder || moving}
        >
          {moving ? 'Moving…' : 'Move'}
        </button>
        {showConfirmJunk && (
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--tint"
            style={{ '--qx-btn-tint': '#f59e0b' }}
            onClick={onConfirmJunk}
            disabled={confirmingJunk}
            title="Confirm the selected messages are junk and move them to your Junk folder."
          >
            {confirmingJunk ? 'Moving…' : 'Confirm junk'}
          </button>
        )}
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onClear} disabled={moving || confirmingJunk}>
          Clear
        </button>
      </div>
    </div>
  );
}

/** The Proposals panel: filing/blocking proposals awaiting a human decision,
 * one action-first backed card per proposal (no outer card around the queue). */
function ProposalsPanel({ proposals, onResolve, resolvingIds }) {
  return (
    <div className="qx-stack qx-stack--tight" data-testid="inboxq-proposals-panel">
      <span className="qx-section-title">Proposals</span>
      {proposals.length === 0 ? (
        <div className="qx-card qx-surface--backed qx-empty">
          <div className="qx-empty__title">Nothing awaiting a decision</div>
          <div className="qx-empty__body">Filing and blocking suggestions will land here for approval, nothing moves without you.</div>
        </div>
      ) : (
        <div className="qx-stack qx-stack--tight">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} busy={resolvingIds.has(p.id)} onResolve={onResolve} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Reads a watch's match object into one short, plain-language line. */
function describeMatch(match) {
  if (!match || typeof match !== 'object') return 'any message';
  const parts = [];
  if (match.from) parts.push(`from contains "${match.from}"`);
  if (match.subject) parts.push(`subject contains "${match.subject}"`);
  if (match.zone) parts.push(`zone is ${match.zone}`);
  return parts.length > 0 ? parts.join(' and ') : 'any message';
}

/** Blocked senders/domains for the current mailbox — the accumulated list of
 * block decisions with an Unblock action per entry. A thin editor over the
 * api client (listBlocked/unblock), never a cache: refetches on mount and
 * after every unblock so it always reflects server state, same shape as the
 * watches list above. */
function BlockedSendersSection({ accountId }) {
  const [blocked, setBlocked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unblockingTarget, setUnblockingTarget] = useState(null);

  const load = useCallback(() => {
    if (!accountId) { setBlocked([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    api.listBlocked({ accountId })
      .then((d) => setBlocked(d?.blocked || []))
      .catch((e) => setError(e.message || 'Could not load blocked senders.'))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const handleUnblock = useCallback(async (entry) => {
    setUnblockingTarget(entry.target);
    try {
      await api.unblock({ target: entry.target, type: entry.type, accountId });
      load();
    } catch {
      // the entry stays in the list; nothing changed server-side
    } finally {
      setUnblockingTarget(null);
    }
  }, [accountId, load]);

  // The list only grows, so render the 50 most recent entries rather than
  // every row the account has ever blocked; Export CSV still writes the
  // full `blocked` array below, never this capped view.
  const sortedBlocked = useMemo(() => {
    return [...blocked].sort((a, b) => {
      const aTime = a.blockedAt ? new Date(a.blockedAt).getTime() : -Infinity;
      const bTime = b.blockedAt ? new Date(b.blockedAt).getTime() : -Infinity;
      return bTime - aTime;
    });
  }, [blocked]);
  const visibleBlocked = sortedBlocked.slice(0, 50);
  const domainCount = useMemo(() => blocked.filter((b) => b.type === 'domain').length, [blocked]);
  const senderCount = blocked.length - domainCount;

  return (
    <div className="qx-card qx-stack qx-stack--tight" data-testid="inboxq-settings-blocked">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <span className="qx-section-title">Blocked senders</span>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          disabled={loading || blocked.length === 0}
          onClick={() => downloadBlockedSendersCsv(blocked)}
          title="Download the blocked senders list as a CSV file"
        >
          <DownloadIcon /> Export CSV
        </button>
      </div>
      <span className="qx-hint qx-hint--sm">
        Senders and domains screened out of the main flow. Unblock lets their mail back in.
      </span>
      {error && <div className="qx-banner qx-banner--error">{error}</div>}
      {!loading && blocked.length > 0 && (
        <div className="qx-grid-auto">
          <div className="qx-stat" data-testid="inboxq-blocked-stat-total">
            <span className="qx-stat__head">Total blocked</span>
            <span className="qx-stat__value">{blocked.length}</span>
          </div>
          <div className="qx-stat" data-testid="inboxq-blocked-stat-senders">
            <span className="qx-stat__head">Senders</span>
            <span className="qx-stat__value">{senderCount}</span>
          </div>
          <div className="qx-stat" data-testid="inboxq-blocked-stat-domains">
            <span className="qx-stat__head">Domains</span>
            <span className="qx-stat__value">{domainCount}</span>
          </div>
        </div>
      )}
      {loading ? (
        <div className="qx-skeleton" style={{ height: 60 }} />
      ) : blocked.length === 0 ? (
        <div className="qx-empty">
          <div className="qx-empty__title">Nothing blocked yet</div>
        </div>
      ) : (
        <div className="qx-stack qx-stack--tight">
          {blocked.length > 50 && (
            <span className="qx-hint qx-hint--sm">
              Showing 50 of {blocked.length}. Export CSV for the full list.
            </span>
          )}
          {visibleBlocked.map((b) => (
            <div key={`${b.type}:${b.target}`} className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <span className="qx-chip qx-chip--xs" style={{ marginRight: 6 }}>{b.type === 'domain' ? 'Domain' : 'Sender'}</span>
                <strong style={{ wordBreak: 'break-all' }}>{b.target}</strong>
                {b.blockedAt && (
                  <span className="qx-hint qx-hint--sm" style={{ marginLeft: 8 }}>
                    blocked {formatFullWhen(b.blockedAt)}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="qx-btn qx-btn--sm qx-btn--ghost"
                disabled={unblockingTarget === b.target}
                onClick={() => handleUnblock(b)}
              >
                {unblockingTarget === b.target ? 'Unblocking…' : 'Unblock'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings surface: background sync, awaited-mail watches, folder visibility.
 * Opened from the Toolbar's Settings button, replacing the main pane while
 * open (same "one surface at a time" shape as the rest of InboxQ, no modal).
 * Settings and watches are org/account-scoped server state; this panel is a
 * thin editor over the api client, never a cache. */
function SettingsPanel({ accountId, accounts, onClose }) {
  const activeAccount = useMemo(() => accounts.find((a) => a.id === accountId) || null, [accounts, accountId]);

  // Which settings tab is showing. The panel used to be one long scroll of
  // every section at once; tabs split it into focused pages with room for
  // plain-language explanations (owner: "settings page is long and so much
  // tiny text").
  const [settingsTab, setSettingsTab] = useState('sync');

  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncIntervalMin, setSyncIntervalMin] = useState(15);
  const [llmBudgetPerTick, setLlmBudgetPerTick] = useState(0);
  const [classifierModel, setClassifierModel] = useState(null);
  const [availableClassifierModels, setAvailableClassifierModels] = useState([]);

  const [watches, setWatches] = useState([]);
  const [watchesLoading, setWatchesLoading] = useState(true);
  const [watchLabel, setWatchLabel] = useState('');
  const [watchFrom, setWatchFrom] = useState('');
  const [watchSubject, setWatchSubject] = useState('');
  const [watchZone, setWatchZone] = useState('');
  const [creatingWatch, setCreatingWatch] = useState(false);
  const [watchError, setWatchError] = useState(null);
  const [togglingIds, setTogglingIds] = useState(() => new Set());

  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState(null);
  const [backfillError, setBackfillError] = useState(null);

  const [editingFolders, setEditingFolders] = useState(false);
  const [availableFolders, setAvailableFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState(null);
  const [selectedFolders, setSelectedFolders] = useState(() => new Set());
  const [savingFolders, setSavingFolders] = useState(false);
  const [foldersSaveError, setFoldersSaveError] = useState(null);
  const [savedFolders, setSavedFolders] = useState(null);
  const [foldersSavedAt, setFoldersSavedAt] = useState(null);

  // Reset the editor whenever the active account changes, so a stale
  // in-progress picker never gets saved onto the wrong mailbox.
  useEffect(() => {
    setEditingFolders(false);
    setAvailableFolders([]);
    setFoldersError(null);
    setFoldersSaveError(null);
    setSavedFolders(null);
    setFoldersSavedAt(null);
  }, [accountId]);

  const currentFolders = savedFolders || activeAccount?.folders || [];

  const handleStartEditFolders = useCallback(async () => {
    if (!accountId) return;
    setEditingFolders(true);
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const { folders: available } = await api.getAvailableFolders(accountId);
      const list = Array.isArray(available) && available.length ? available : currentFolders;
      setAvailableFolders(list);
      setSelectedFolders(new Set(currentFolders.length ? currentFolders : list.filter((f) => f.toUpperCase() === 'INBOX')));
    } catch (err) {
      setFoldersError(err.message || 'Could not list folders on the mail server.');
      setAvailableFolders(currentFolders);
      setSelectedFolders(new Set(currentFolders));
    } finally {
      setFoldersLoading(false);
    }
  }, [accountId, currentFolders]);

  const toggleFolderSelection = useCallback((folder) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }, []);

  const handleSaveFolders = useCallback(async () => {
    if (!accountId) return;
    setSavingFolders(true);
    setFoldersSaveError(null);
    try {
      const chosen = Array.from(selectedFolders);
      const { account: updated } = await api.updateAccountFolders(accountId, chosen);
      setSavedFolders(updated?.folders || chosen);
      setFoldersSavedAt(new Date());
      setEditingFolders(false);
    } catch (err) {
      setFoldersSaveError(err.message || 'Could not save your folder choices.');
    } finally {
      setSavingFolders(false);
    }
  }, [accountId, selectedFolders]);

  const loadSettings = useCallback(() => {
    setSettingsLoading(true);
    setSettingsError(null);
    api.getSettings({ force: true })
      .then((d) => {
        const s = d?.settings || {};
        setSettings(s);
        setSyncEnabled(!!s.syncEnabled);
        setSyncIntervalMin(s.syncIntervalMin || 15);
        setLlmBudgetPerTick(s.llmBudgetPerTick ?? 0);
        setClassifierModel(s.classifierModel ?? null);
        setAvailableClassifierModels(Array.isArray(s.availableClassifierModels) ? s.availableClassifierModels : []);
      })
      .catch((e) => setSettingsError(e.message || 'Could not load settings.'))
      .finally(() => setSettingsLoading(false));
  }, []);

  const loadWatches = useCallback(() => {
    setWatchesLoading(true);
    api.listWatches({}, { force: true })
      .then((d) => setWatches(d?.watches || []))
      .catch(() => { /* the empty state covers this */ })
      .finally(() => setWatchesLoading(false));
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { loadWatches(); }, [loadWatches]);

  const handleSaveSettings = useCallback(async (e) => {
    e.preventDefault();
    setSaving(true);
    setSettingsError(null);
    try {
      const { settings: s } = await api.updateSettings({
        syncEnabled,
        syncIntervalMin: Number(syncIntervalMin),
        llmBudgetPerTick: Number(llmBudgetPerTick),
        classifierModel: classifierModel || null,
      });
      setSettings(s);
      setSavedAt(new Date());
    } catch (err) {
      setSettingsError(err.message || 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }, [syncEnabled, syncIntervalMin, llmBudgetPerTick, classifierModel]);

  const handleCreateWatch = useCallback(async (e) => {
    e.preventDefault();
    if (!watchLabel.trim()) return;
    const match = {};
    if (watchFrom.trim()) match.from = watchFrom.trim();
    if (watchSubject.trim()) match.subject = watchSubject.trim();
    if (watchZone) match.zone = watchZone;
    if (Object.keys(match).length === 0) {
      setWatchError('Add at least one condition: from, subject, or zone.');
      return;
    }
    setCreatingWatch(true);
    setWatchError(null);
    try {
      await api.createWatch({ accountId: accountId || undefined, label: watchLabel.trim(), match });
      setWatchLabel('');
      setWatchFrom('');
      setWatchSubject('');
      setWatchZone('');
      loadWatches();
    } catch (err) {
      setWatchError(err.message || 'Could not create this watch.');
    } finally {
      setCreatingWatch(false);
    }
  }, [accountId, watchLabel, watchFrom, watchSubject, watchZone, loadWatches]);

  const handleBackfillBodies = useCallback(async () => {
    if (!accountId) return;
    setBackfilling(true);
    setBackfillError(null);
    try {
      const data = await api.backfillBodies({ accountId, limit: 50 });
      setBackfillResult({ backfilled: data?.backfilled ?? 0, remaining: data?.remaining ?? 0 });
    } catch (err) {
      setBackfillError(err.message || 'Could not load message bodies.');
    } finally {
      setBackfilling(false);
    }
  }, [accountId]);

  const handleToggleWatch = useCallback(async (watchId, active) => {
    setTogglingIds((prev) => new Set(prev).add(watchId));
    try {
      await api.setWatchActive(watchId, active);
      loadWatches();
    } catch {
      // the toggle stays as it was; nothing changed server-side
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(watchId);
        return next;
      });
    }
  }, [loadWatches]);

  return (
    <div className="qx-stack" data-testid="inboxq-settings-panel">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <span className="qx-section-title">InboxQ settings</span>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onClose}>Back to Overview</button>
      </div>

      {/* Split into tabs so each page is short, with a plain-language blurb
          up top instead of one long scroll of dense cards (owner request). */}
      <div className="qx-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          aria-selected={settingsTab === 'sync'}
          className={`qx-tab${settingsTab === 'sync' ? ' qx-tab--active' : ''}`}
          onClick={() => setSettingsTab('sync')}
        >
          Sync
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={settingsTab === 'folders'}
          className={`qx-tab${settingsTab === 'folders' ? ' qx-tab--active' : ''}`}
          onClick={() => setSettingsTab('folders')}
        >
          Folders
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={settingsTab === 'watches'}
          className={`qx-tab${settingsTab === 'watches' ? ' qx-tab--active' : ''}`}
          onClick={() => setSettingsTab('watches')}
        >
          Watches
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={settingsTab === 'blocked'}
          className={`qx-tab${settingsTab === 'blocked' ? ' qx-tab--active' : ''}`}
          onClick={() => setSettingsTab('blocked')}
        >
          Blocked
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={settingsTab === 'maintenance'}
          className={`qx-tab${settingsTab === 'maintenance' ? ' qx-tab--active' : ''}`}
          onClick={() => setSettingsTab('maintenance')}
        >
          Maintenance
        </button>
      </div>

      {settingsTab === 'sync' && (
      <>
      <p>
        Choose whether InboxQ checks this mailbox for you in the background, how often, and how
        much AI it may spend classifying each batch.
      </p>
      {/* Background sync — the toggle is a fixed-size switch (qx-toggle owns
          its own 42x24 box); the label text lives OUTSIDE it as a sibling in
          a row, never as a child, or the switch clips it down to 42px wide. */}
      <div className="qx-card qx-stack qx-stack--tight" data-testid="inboxq-settings-sync">
        <span className="qx-section-title">Background sync</span>
        {settingsError && <div className="qx-banner qx-banner--error">{settingsError}</div>}
        {settingsLoading ? (
          <div className="qx-skeleton" style={{ height: 80 }} />
        ) : (
          <form className="qx-stack qx-stack--tight" onSubmit={handleSaveSettings}>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <label className="qx-toggle">
                <input
                  type="checkbox"
                  checked={syncEnabled}
                  onChange={(e) => setSyncEnabled(e.target.checked)}
                  aria-label="Sync automatically in the background"
                />
                <span className="qx-toggle__track" />
              </label>
              <span>Sync automatically in the background</span>
            </div>

            <div className="qx-row qx-row--wrap" style={{ gap: 16 }}>
              <div className="qx-field">
                <label htmlFor="inboxq-sync-interval" className="qx-field__label" style={{ display: 'block', marginBottom: 4 }}>
                  How often
                </label>
                <select
                  id="inboxq-sync-interval"
                  className="qx-select"
                  value={syncIntervalMin}
                  onChange={(e) => setSyncIntervalMin(e.target.value)}
                >
                  <option value={5}>Every 5 minutes</option>
                  <option value={15}>Every 15 minutes</option>
                  <option value={30}>Every 30 minutes</option>
                  <option value={60}>Every hour</option>
                </select>
              </div>

              <div className="qx-field">
                <label htmlFor="inboxq-llm-budget" className="qx-field__label" style={{ display: 'block', marginBottom: 4 }}>
                  AI budget per sync (messages classified)
                </label>
                <input
                  id="inboxq-llm-budget"
                  type="number"
                  className="qx-input"
                  min={0}
                  step={1}
                  value={llmBudgetPerTick}
                  onChange={(e) => setLlmBudgetPerTick(e.target.value)}
                  style={{ maxWidth: 160 }}
                />
              </div>

              <div className="qx-field">
                <label htmlFor="inboxq-classifier-model" className="qx-field__label" style={{ display: 'block', marginBottom: 4 }}>
                  Classifier model
                </label>
                <select
                  id="inboxq-classifier-model"
                  className="qx-select"
                  value={classifierModel || ''}
                  onChange={(e) => setClassifierModel(e.target.value || null)}
                  style={{ minWidth: 220 }}
                >
                  <option value="">Deterministic only (no AI)</option>
                  {availableClassifierModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label || m.id}</option>
                  ))}
                </select>
              </div>
            </div>

            <span className="qx-hint qx-hint--sm">
              A cheaper classifier model lowers cost on large inboxes. AI only runs on ambiguous
              messages within the budget above (deterministic rules handle the rest), and
              "Deterministic only" turns AI classification off entirely.
            </span>

            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <button type="submit" className="qx-btn qx-btn--sm qx-btn--primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {savedAt && (
                <span className="qx-hint qx-hint--sm">
                  saved {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>

            <span className="qx-hint qx-hint--sm">
              Turning this on tells InboxQ you want it to keep syncing on its own. Background sync
              also needs a matching switch turned on for this Quox instance as a whole. If this is on
              but new mail is not showing up by itself, that instance-level switch is probably off;
              ask whoever runs this Quox instance to check it, or use the Sync button above meanwhile.
            </span>
          </form>
        )}
      </div>
      </>
      )}

      {settingsTab === 'folders' && (
      <>
      <p>
        Pick which mailbox folders InboxQ reads and files into. Only the folders you select here
        are synced.
      </p>
      {/* Synced folders: which mailboxes InboxQ pulls from. Changing this
          never syncs by itself; the user still triggers a sync separately. */}
      <div className="qx-card qx-stack qx-stack--tight" data-testid="inboxq-settings-folders">
        <span className="qx-section-title">Synced folders</span>

        {!editingFolders && (
          <>
            {currentFolders.length > 0 ? (
              <div className="qx-row qx-row--wrap" style={{ gap: 6 }}>
                {currentFolders.map((f) => (
                  <span key={f} className="qx-chip qx-chip--xs">{f}</span>
                ))}
              </div>
            ) : (
              <span className="qx-hint qx-hint--sm">No folders reported for this mailbox yet.</span>
            )}
            {foldersSavedAt && (
              <span className="qx-hint qx-hint--sm">
                saved {foldersSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            <div>
              <button
                type="button"
                className="qx-btn qx-btn--sm qx-btn--ghost"
                onClick={handleStartEditFolders}
                disabled={!accountId}
              >
                Change folders
              </button>
            </div>
          </>
        )}

        {editingFolders && (
          <div className="qx-card qx-surface--backed qx-stack qx-stack--tight">
            {foldersLoading ? (
              <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                <span className="qx-spinner qx-spinner--sm" aria-hidden="true" />
                <span className="qx-hint qx-hint--sm">Listing folders on the mail server, this can take a few seconds.</span>
              </div>
            ) : (
              <>
                {foldersError && <span className="qx-hint qx-hint--sm">{foldersError}</span>}
                <div className="qx-row qx-row--wrap" style={{ gap: 10 }}>
                  {availableFolders.map((f) => (
                    <label key={f} className="qx-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedFolders.has(f)}
                        onChange={() => toggleFolderSelection(f)}
                      />
                      <span className="qx-checkbox__box" />
                      {f}
                    </label>
                  ))}
                </div>
              </>
            )}

            {foldersSaveError && <div className="qx-banner qx-banner--error">{foldersSaveError}</div>}

            <div className="qx-row qx-row--tight">
              <button
                type="button"
                className="qx-btn qx-btn--sm qx-btn--primary"
                onClick={handleSaveFolders}
                disabled={savingFolders || foldersLoading}
              >
                {savingFolders ? 'Saving…' : 'Save folders'}
              </button>
              <button
                type="button"
                className="qx-btn qx-btn--sm qx-btn--ghost"
                onClick={() => setEditingFolders(false)}
                disabled={savingFolders}
              >
                Cancel
              </button>
            </div>
            <span className="qx-hint qx-hint--sm">
              Saving changes which folders InboxQ syncs; it does not trigger a sync by itself.
              Use the Sync button in the inbox, or turn on background sync above, to pull mail.
            </span>
          </div>
        )}
      </div>

      <InboxQFilingSection accountId={accountId} />
      </>
      )}

      {settingsTab === 'watches' && (
      <>
      <p>
        Tell InboxQ to flag mail you are waiting on, so it surfaces the moment it arrives.
      </p>
      {/* Awaited-mail watches */}
      <div className="qx-card qx-stack qx-stack--tight" data-testid="inboxq-settings-watches">
        <span className="qx-section-title">Awaited-mail watches</span>
        <span className="qx-hint qx-hint--sm">
          A watch flags messages that match, so mail you are waiting on does not quietly slip past.
        </span>

        {watchesLoading ? (
          <div className="qx-skeleton" style={{ height: 60 }} />
        ) : watches.length === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__title">No watches yet</div>
            <div className="qx-empty__body">Add one below.</div>
          </div>
        ) : (
          <div className="qx-stack qx-stack--tight">
            {watches.map((w) => {
              const busy = togglingIds.has(w.id);
              return (
                <div key={w.id} className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{w.label}</strong>{' '}
                    <span className="qx-hint qx-hint--sm">{describeMatch(w.match)}</span>
                    {typeof w.hitCount === 'number' && (
                      <span className="qx-chip qx-chip--xs" style={{ marginLeft: 6 }}>
                        {w.hitCount} hit{w.hitCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <label
                    className="qx-toggle"
                    style={{ cursor: busy ? 'wait' : 'pointer', flexShrink: 0 }}
                  >
                    <input
                      type="checkbox"
                      checked={!!w.active}
                      disabled={busy}
                      onChange={(e) => handleToggleWatch(w.id, e.target.checked)}
                      aria-label={`Active: ${w.label}`}
                    />
                    <span className="qx-toggle__track" />
                  </label>
                </div>
              );
            })}
          </div>
        )}

        <form
          className="qx-stack qx-stack--tight"
          onSubmit={handleCreateWatch}
          style={{ borderTop: '1px solid var(--qx-border, rgba(255,255,255,0.1))', paddingTop: 10, marginTop: 4 }}
        >
          <span className="qx-section-title" style={{ fontSize: 13 }}>Add a watch</span>
          {watchError && <div className="qx-banner qx-banner--error">{watchError}</div>}
          <div className="qx-row qx-row--wrap" style={{ gap: 10 }}>
            <input
              type="text"
              className="qx-input"
              placeholder="Label, e.g. Contract from Acme"
              value={watchLabel}
              onChange={(e) => setWatchLabel(e.target.value)}
              style={{ minWidth: 200, flex: 1 }}
              aria-label="Watch label"
            />
            <input
              type="text"
              className="qx-input"
              placeholder="From contains..."
              value={watchFrom}
              onChange={(e) => setWatchFrom(e.target.value)}
              style={{ minWidth: 160, flex: 1 }}
              aria-label="From contains"
            />
            <input
              type="text"
              className="qx-input"
              placeholder="Subject contains..."
              value={watchSubject}
              onChange={(e) => setWatchSubject(e.target.value)}
              style={{ minWidth: 160, flex: 1 }}
              aria-label="Subject contains"
            />
            <select className="qx-select" value={watchZone} onChange={(e) => setWatchZone(e.target.value)} aria-label="Zone">
              <option value="">Any zone</option>
              {ZONES.map((z) => <option key={z.key} value={z.key}>{z.label}</option>)}
            </select>
          </div>
          <div>
            <button type="submit" className="qx-btn qx-btn--sm qx-btn--primary" disabled={creatingWatch}>
              {creatingWatch ? 'Adding…' : 'Add watch'}
            </button>
          </div>
        </form>
      </div>
      </>
      )}

      {settingsTab === 'blocked' && (
      <>
      <p>
        Senders and domains you have screened out of the main flow. Unblock lets their mail back
        in.
      </p>
      <BlockedSendersSection accountId={accountId} />
      </>
      )}

      {settingsTab === 'maintenance' && (
      <>
      <p>
        One-off housekeeping: pull the full text of already-stored messages so search and reading
        have the whole body.
      </p>
      {/* P1c: on-demand fetch (in the reader) covers one message at a time;
          this is the bulk path for the messages ingested before body capture
          existed. */}
      <div className="qx-card qx-surface--backed qx-stack qx-stack--tight" data-testid="inboxq-settings-backfill">
        <span className="qx-section-title">Load message bodies for stored mail</span>
        <span className="qx-hint qx-hint--sm">
          Older stored messages may only have a subject and snippet. This fetches the full body for a
          batch of them from the mail server, oldest gaps first. Press again until none remain.
        </span>
        {backfillError && <div className="qx-banner qx-banner--error">{backfillError}</div>}
        {backfillResult && (
          <span className="qx-hint qx-hint--sm">
            Backfilled {backfillResult.backfilled}, {backfillResult.remaining} remaining.
          </span>
        )}
        <div>
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--primary"
            onClick={handleBackfillBodies}
            disabled={backfilling || !accountId || backfillResult?.remaining === 0}
          >
            {backfilling ? 'Loading…' : 'Load message bodies'}
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

function InboxQContent() {
  const [accounts, setAccounts] = useState([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountsError, setAccountsError] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [zone, setZone] = useState('focus');
  const [zoneCounts, setZoneCounts] = useState({});
  // AQ-9E U4 (folder-first): the real IMAP folder tree is the PRIMARY nav
  // surface; zones are demoted to lenses over it. folderTreeLive is false when
  // the tree is the last-known fallback (IMAP unreachable), surfaced honestly.
  const [folderTree, setFolderTree] = useState([]);
  const [folderTreeLive, setFolderTreeLive] = useState(true);
  const [folderTreeLoading, setFolderTreeLoading] = useState(false);
  // GMAIL: the tree is this account's labels, not server folders — the nav
  // labels the group and hides folder-only controls accordingly.
  const [folderTreeGmail, setFolderTreeGmail] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(null);
  // Folder-scoped browse (owner's #1 pre-onboarding blocker): a click on a
  // real IMAP folder in the nav loads that folder's stored messages via the
  // same search route the inbox_search agent tool uses, scoped to `folder`.
  const [folder, setFolder] = useState(null);
  const [folderMessages, setFolderMessages] = useState([]);
  const [folderMessagesLoading, setFolderMessagesLoading] = useState(false);
  const [folderMessagesError, setFolderMessagesError] = useState(null);
  const [folderTotal, setFolderTotal] = useState(0);
  const [report, setReport] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [syncing, setSyncing] = useState(false);
  // Live progress for the detached full sync (gap d): { stored, folders:{total,backfilled} }.
  const [syncProgress, setSyncProgress] = useState(null);
  // False once unmounted, so the sync poll loop stops touching state.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [reclassifying, setReclassifying] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [resolvingIds, setResolvingIds] = useState(() => new Set());
  const [lastSync, setLastSync] = useState(null);
  // What the main pane shows: 'overview' | 'zone' | 'report' | 'proposals' | 'settings'.
  // Opening a message no longer switches this — it stays 'zone' so the
  // folder rail keeps its active highlight while the reader is open (audit
  // B: opening mail used to lose the scanning context entirely).
  const [mainView, setMainView] = useState('overview');
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [toasts, setToasts] = useState([]);
  // Chat sidebar UX (design doc INBOXQ_AGENT_DESIGN.md section C): the
  // INBOXQ agent dock, open by default so "move all wordfence mail" is
  // reachable without a discovery step, collapsible to a 48px rail.
  const [inboxChatCollapsed, setInboxChatCollapsed] = useState(false);

  // P1 manual sort: multi-select + move-to-folder. selectedIds is keyed by
  // message id across whichever list (zone or folder) is currently active;
  // it's cleared whenever that active list changes context (see the effect
  // below) so a stale selection never targets rows that are no longer shown.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMoveFolder, setBulkMoveFolder] = useState('');
  const [bulkMoving, setBulkMoving] = useState(false);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  // P3 physical filing — Screened review to Junk (single + bulk).
  const [confirmingJunk, setConfirmingJunk] = useState(false);

  // AQ-9E U2: a toast can carry an optional action (e.g. Undo). Actionable
  // toasts linger longer (default 10s) so there's time to click; plain toasts
  // keep the original 5s. An action is { label, onClick } — onClick runs, then
  // the toast dismisses itself.
  const pushToast = useCallback(({ variant = 'info', message, action = null, ttl }) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, variant, message, action }]);
    const life = typeof ttl === 'number' ? ttl : (action ? 10000 : 5000);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), life);
  }, []);

  const loadAccounts = useCallback(({ force = false, selectNewest = false } = {}) => {
    let cancelled = false;
    setAccountsError(null);
    api.listAccounts({ force })
      .then((d) => {
        if (cancelled) return;
        const list = d?.accounts || [];
        setAccounts(list);
        setAccountId((prev) => {
          // selectNewest (used right after onboarding connects a mailbox)
          // always hops to the just-added account, so the handoff lands
          // the user straight in its triage view. Otherwise keep whatever
          // was already selected.
          if (selectNewest) return list[list.length - 1]?.id || null;
          return prev || list[0]?.id || null;
        });
      })
      .catch((e) => {
        // A fetch FAILURE is not the same as "0 accounts" — surfacing it as an
        // error (below) stops onboarding from masquerading over a 401/network
        // problem, which is indistinguishable to the user otherwise.
        if (!cancelled) setAccountsError(e?.message || 'Could not load mailboxes.');
      })
      .finally(() => { if (!cancelled) setAccountsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // Force a fresh accounts fetch on mount so the folder pickers (Rules, File,
  // Settings, bulk) always reflect the CURRENT server folder list. Without
  // force, a long-lived session keeps whatever folders were cached when the
  // mailbox was first connected (often just ["INBOX"], before folders were
  // discovered), so newly-synced or newly-created folders never appear.
  useEffect(() => loadAccounts({ force: true }), [loadAccounts]);

  // Landing pane: Overview, every time InboxQ opens or the mailbox changes.
  useEffect(() => {
    setMainView('overview');
    setSelectedMessage(null);
    setFolder(null);
    setFolderMessages([]);
    setSelectedIds(new Set());
    setBulkMoveFolder('');
  }, [accountId]);

  // Org switch must invalidate the (non-org-scoped) client cache and reload, or
  // a stale prior-org accounts result is reused and onboarding is shown even when
  // the newly-selected org has a mailbox. Mirrors memoryClient/toolRegistry etc.
  useEffect(() => {
    const onOrgSwitch = () => {
      clearApiCache();
      setAccounts([]);
      setAccountId(null);
      setAccountsLoaded(false);
      // Clear every per-account surface too, or a stale prior-org tree/messages/
      // counts can flash under the new workspace's mailbox before it loads.
      setFolderTree([]);
      setFolderMessages([]);
      setMessages([]);
      setZoneCounts({});
      setSelectedMessage(null);
      setFolder(null);
      loadAccounts({ force: true });
    };
    window.addEventListener('quox-org-switch', onOrgSwitch);
    return () => window.removeEventListener('quox-org-switch', onOrgSwitch);
  }, [loadAccounts]);

  const handleAccountConnected = useCallback(() => {
    loadAccounts({ force: true, selectNewest: true });
  }, [loadAccounts]);

  const loadZones = useCallback(() => {
    if (!accountId) return;
    api.listZones({ accountId }, { force: true })
      .then((d) => setZoneCounts(d?.zones || {}))
      .catch(() => { /* counts are cosmetic */ });
  }, [accountId]);

  const loadFolderTree = useCallback(() => {
    if (!accountId) return;
    setFolderTreeLoading(true);
    api.folderTree({ accountId }, { force: true })
      .then((d) => {
        setFolderTree(Array.isArray(d?.folders) ? d.folders : []);
        setFolderTreeLive(d?.live !== false);
        setFolderTreeGmail(Boolean(d?.gmail));
      })
      .catch(() => { /* nav falls back to the flat watched list */ })
      .finally(() => setFolderTreeLoading(false));
  }, [accountId]);

  const loadMessages = useCallback(() => {
    if (!accountId) return;
    setMessagesLoading(true);
    setMessagesError(null);
    api.listMessages({ accountId, zone, limit: 50 }, { force: true })
      .then((d) => {
        setMessages(d?.messages || []);
        if (d?.zones) setZoneCounts(d.zones);
      })
      .catch((e) => setMessagesError(e.message))
      .finally(() => setMessagesLoading(false));
  }, [accountId, zone]);

  const loadFolderMessages = useCallback(() => {
    if (!accountId || !folder) return;
    setFolderMessagesLoading(true);
    setFolderMessagesError(null);
    api.listByFolder({ accountId, folder, limit: 200 }, { force: true })
      .then((d) => {
        setFolderMessages(d?.messages || []);
        setFolderTotal(typeof d?.total === 'number' ? d.total : (d?.messages || []).length);
      })
      .catch((e) => setFolderMessagesError(e.message))
      .finally(() => setFolderMessagesLoading(false));
  }, [accountId, folder]);

  const loadReport = useCallback(() => {
    if (!accountId) return;
    api.getLatestReport(accountId, { force: true })
      .then((d) => setReport(d?.report || null))
      .catch(() => { /* the empty report state covers this */ });
  }, [accountId]);

  const loadProposals = useCallback(() => {
    // Store status for an open proposal is 'proposed' (not 'pending') — filtering
    // on 'pending' returned nothing, so proposals never showed in the dashboard.
    api.listProposals({ status: 'proposed' }, { force: true })
      .then((d) => setProposals(d?.proposals || []))
      .catch(() => { /* the empty state covers this */ });
  }, []);

  useEffect(() => { loadZones(); }, [loadZones]);
  useEffect(() => { loadFolderTree(); }, [loadFolderTree]);
  useEffect(() => { loadMessages(); }, [loadMessages]);
  useEffect(() => { if (folder) loadFolderMessages(); }, [folder, loadFolderMessages]);
  useEffect(() => { loadReport(); }, [loadReport]);
  useEffect(() => { loadProposals(); }, [loadProposals]);

  const handleSync = useCallback(async () => {
    if (!accountId) return;
    setSyncing(true);
    try {
      const data = await api.syncAccount(accountId);
      const reloadAll = () => { loadZones(); loadFolderTree(); loadMessages(); if (folder) loadFolderMessages(); loadAccounts(); };
      // FIX-2 (2026-10-07): the Sync button now runs the FULL pipeline on the
      // server — discover every folder, pull new mail, backfill the whole
      // mailbox, and reflect external deletes/moves/read-state — and it runs
      // DETACHED so the request returns at once ({started:true}) instead of
      // hanging. Be honest that it's working in the background, and reload a
      // couple of times to surface progress.
      if (data && data.started === false && data.status === 'already_syncing') {
        pushToast({ variant: 'info', message: 'A sync is already running for this mailbox.' });
        return;
      }
      if (data && data.started) {
        pushToast({ variant: 'success', message: 'Sync started. InboxQ is pulling your whole mailbox, discovering all your folders and reflecting changes from your other mail apps — this runs in the background and can take a little while.' });
        reloadAll();
        // gap d: poll REAL progress until the server reports the run finished,
        // instead of blind timed reloads. Keeps the button in "Syncing…" with a
        // live count so the owner can see it working ("I feel like it did
        // nothing"). Capped so a stuck run can never spin forever.
        const startedAt = Date.now();
        const MAX_MS = 4 * 60 * 1000;
        let ticks = 0;
        while (mountedRef.current && Date.now() - startedAt < MAX_MS) {
          await new Promise((r) => setTimeout(r, 3000));
          if (!mountedRef.current) break;
          let st = null;
          try { st = await api.syncStatus(accountId); } catch { /* transient; keep polling */ }
          if (!mountedRef.current) break;
          if (st) {
            setSyncProgress({ stored: st.stored || 0, folders: st.folders || null });
            if ((++ticks % 2) === 0) reloadAll(); // refresh the views ~every 6s
            if (!st.syncing) { reloadAll(); break; }
          }
        }
        if (mountedRef.current) {
          setSyncProgress(null);
          setLastSync(new Date());
        }
        return;
      }
      // Legacy / inline finished-summary shape (kept for back-compat).
      const folders = Array.isArray(data?.summary?.folders) ? data.summary.folders : [];
      const newCount = folders.reduce((s, f) => s + (Number(f?.new) || 0), 0);
      const failedCount = folders.filter((f) => f && f.failed).length;
      const skippedCount = folders.filter((f) => f && f.skipped).length;
      const okCount = folders.filter((f) => f && !f.failed && !f.skipped).length;
      if (okCount > 0) setLastSync(new Date());
      if (failedCount > 0) {
        pushToast({
          variant: 'error',
          message: okCount > 0
            ? `Synced with problems. ${newCount} new; ${failedCount} folder${failedCount === 1 ? '' : 's'} could not be reached.`
            : `Sync failed. ${failedCount} folder${failedCount === 1 ? '' : 's'} could not be reached, nothing was pulled.`,
        });
      } else if (okCount === 0 && skippedCount > 0) {
        pushToast({ variant: 'error', message: `Nothing synced. ${skippedCount} folder${skippedCount === 1 ? '' : 's'} are paused after repeated errors. Re-enable them in Settings, Folders.` });
      } else {
        pushToast({ variant: 'success', message: newCount > 0 ? `Synced. ${newCount} new message${newCount === 1 ? '' : 's'}.` : 'Synced. No new mail.' });
      }
      reloadAll();
    } catch (e) {
      const msg = e?.message || '';
      // "account not found" / 404 almost always means the selected mailbox is
      // not in the workspace this session is currently acting as (the mailbox
      // list and the sync resolved different workspaces). Say so plainly and
      // self-heal by reloading the mailbox list for the current workspace.
      if (/\b404\b/.test(msg) || /account not found/i.test(msg)) {
        pushToast({ variant: 'error', message: 'That mailbox is not in your current workspace. Check the workspace switcher in the top bar matches the mailbox you expect. Refreshing your mailbox list.' });
        loadAccounts({ force: true });
      } else {
        setMessagesError(msg || 'Sync failed.');
      }
    } finally {
      if (mountedRef.current) setSyncing(false);
    }
  }, [accountId, loadZones, loadFolderTree, loadMessages, folder, loadFolderMessages, pushToast, loadAccounts]);

  const handleReclassify = useCallback(async () => {
    if (!accountId) return;
    setReclassifying(true);
    try {
      await api.reclassify(accountId);
      loadZones();
      loadMessages();
      if (folder) loadFolderMessages();
      pushToast({ variant: 'success', message: 'Re-sorted your InboxQ view with the latest rules. Nothing on your mail server changed.' });
    } catch (e) {
      setMessagesError(e.message);
    } finally {
      setReclassifying(false);
    }
  }, [accountId, loadZones, loadMessages, folder, loadFolderMessages, pushToast]);

  const handleMove = useCallback(async (message, toZone) => {
    if (!message) return;
    try {
      await api.moveMessage(message.id, toZone);
      loadZones();
      loadMessages();
      if (folder) loadFolderMessages();
      const zoneLabel = ZONES.find((z) => z.key === toZone)?.label || toZone;
      pushToast({ variant: 'success', message: `Zone changed to ${zoneLabel}. Mail-server folder unchanged.` });
    } catch { /* the row stays; nothing destructive happened */ }
  }, [loadZones, loadMessages, folder, loadFolderMessages, pushToast]);

  const handleGenerateReport = useCallback(async () => {
    if (!accountId) return;
    setGenerating(true);
    try {
      const { report: r } = await api.generateReport(accountId);
      setReport(r);
    } catch { /* the report panel's empty state stays put */ } finally {
      setGenerating(false);
    }
  }, [accountId]);

  // Success/failure feedback matches what actually happened server-side: an
  // approved 'file' proposal now executes a real move (executed:true, moved
  // ids), while 'block'/'draft' stay decision-only (executed:false) — never
  // toast "Moved"/"Blocked" from an executed:false response (audit D5).
  const handleResolve = useCallback(async (proposalId, decision) => {
    setResolvingIds((prev) => new Set(prev).add(proposalId));
    try {
      const data = await api.resolveProposal(proposalId, decision);
      if (decision === 'approve') {
        if (data?.executed) {
          const n = Array.isArray(data.moved) ? data.moved.length : null;
          pushToast({ variant: 'success', message: n != null ? `Filed ${n} message${n === 1 ? '' : 's'}.` : 'Filing applied.' });
        } else {
          pushToast({ variant: 'success', message: 'Approved. Decision recorded; nothing was moved or sent automatically.' });
        }
      } else {
        pushToast({ variant: 'info', message: 'Decision recorded. Proposal denied.' });
      }
      loadProposals();
    } catch (err) {
      pushToast({
        variant: 'error',
        message: err?.body?.error || err.message || 'Could not record this decision.',
      });
    } finally {
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(proposalId);
        return next;
      });
    }
  }, [loadProposals, pushToast]);

  // Left-nav + row-click wiring for the single main-pane switch. Switching
  // list context always clears the bulk-move selection — it's keyed by
  // message id and the ids on screen are about to change.
  const handleSelectZone = useCallback((key) => {
    setZone(key);
    setMainView('zone');
    setSelectedMessage(null);
    setSelectedIds(new Set());
    setBulkMoveFolder('');
  }, []);

  const handleSelectFolder = useCallback((f) => {
    setFolder(f);
    setMainView('folder');
    setSelectedMessage(null);
    setSelectedIds(new Set());
    setBulkMoveFolder('');
  }, []);

  const handleOpenMessage = useCallback((message) => {
    setSelectedMessage(message);
  }, []);

  // Today and the report both surface messages that may not belong to the
  // currently-selected zone — hop the folder rail to the message's own zone
  // (so its list loads and the reader gets working Prev/Next) then open it.
  const handleOpenFromSummary = useCallback((message) => {
    if (!message) return;
    if (message.zone) setZone(message.zone);
    setMainView('zone');
    setSelectedMessage(message);
  }, []);

  const handleBackToZone = useCallback(() => {
    setSelectedMessage(null);
  }, []);

  const handleToggleSettings = useCallback(() => {
    setMainView((v) => (v === 'settings' ? 'overview' : 'settings'));
  }, []);

  // Moving from the reader trains the filter and the message leaves this
  // zone — return to the list rather than keep showing a stale reader.
  const handleMoveFromPreview = useCallback(async (message, toZone) => {
    await handleMove(message, toZone);
    setSelectedMessage(null);
  }, [handleMove]);

  // AQ-9E U1: block is NOT optimistic. The old path removed every matching row
  // from view BEFORE the network call and restored on failure, which made a
  // block that only half-landed (Quox re-zoned the mail but the Junk-folder
  // move failed, or no provider rule was installed) look like a clean sweep and
  // fed the owner's distrust ("confusing whether it's screening or actually
  // blocking at the other mail clients"). Now nothing is removed up front: we
  // call the server, then reflect exactly what it reports. The honest outcome
  // fields drive the feedback — screened = re-zoned in Quox, junkMoved/junkFailed
  // = the real Junk-folder move, providerRule === 'none' = holds in Quox only,
  // no rule at the mail provider — and the lists reload from server truth so
  // rows move or stay based on what actually happened. scope 'sender' matches
  // the exact fromAddr; scope 'domain' blocks every address at that domain.
  const handleBlockSender = useCallback(async (message, scope = 'sender') => {
    if (!message?.fromAddr || !accountId) return;
    const fromAddr = message.fromAddr;
    const domain = fromAddr.split('@')[1] || null;
    if (scope === 'domain' && !domain) return;
    const target = scope === 'domain' ? `@${domain}` : (message.fromName || fromAddr);

    try {
      const data = await api.blockSender({ fromAddr, accountId, scope });
      const screened = typeof data?.screened === 'number' ? data.screened : 0;
      const junkMoved = typeof data?.junkMoved === 'number' ? data.junkMoved : 0;
      const junkFailed = !!data?.junkFailed;
      const providerRule = data?.providerRule || 'none';

      // Primary outcome line, in order of certainty.
      let summary = screened > 0
        ? `Screened ${screened} message${screened === 1 ? '' : 's'} from ${target} in Quox.`
        : `Blocked ${target}. Future mail from them will be screened in Quox.`;
      if (junkMoved > 0) summary += ` Moved ${junkMoved} to your Junk folder.`;
      pushToast({
        variant: junkFailed ? 'error' : 'success',
        message: junkFailed
          ? `${summary} The Junk-folder move did not land, so those stay where they are.`
          : summary,
      });

      // The trust-critical clarification the owner called out: screening in Quox
      // is not a rule at the mail provider. Say so plainly whenever that's the case.
      if (providerRule === 'none') {
        pushToast({
          variant: 'info',
          message: 'This holds in Quox only. No block rule was added at your email provider yet, so your other mail apps are unaffected.',
        });
      }

      // Reflect server truth rather than guessing which rows to drop: re-zoned
      // mail leaves its old zone, Junk-moved mail leaves its folder.
      loadZones();
      loadMessages();
      if (folder) loadFolderMessages();
    } catch (err) {
      pushToast({
        variant: 'error',
        message: err?.body?.error || err.message || `Could not block mail from ${target}. Nothing was changed.`,
      });
    }
  }, [accountId, loadZones, loadMessages, folder, loadFolderMessages, pushToast]);

  // P1 manual sort — multi-select checkboxes: toggle one id, or clear the
  // whole set (Clear button, or after a bulk move resolves).
  const handleToggleBulkSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleClearBulkSelect = useCallback(() => {
    setSelectedIds(new Set());
    setBulkMoveFolder('');
  }, []);

  // Removes exactly the ids the server confirms moved from whichever local
  // lists currently hold them — never the whole selection, so a partial
  // failure leaves the failed rows in place (and still selected) rather than
  // silently disappearing them.
  const removeMovedIds = useCallback((movedIds) => {
    if (movedIds.size === 0) return;
    setMessages((prev) => prev.filter((m) => !movedIds.has(m.id)));
    setFolderMessages((prev) => prev.filter((m) => !movedIds.has(m.id)));
    setSelectedMessage((prev) => (prev && movedIds.has(prev.id) ? null : prev));
  }, []);

  // AQ-9E U2: undo one or more recorded moves (the Undo affordance on a move
  // success toast). Reverses each on the server (a real reverse IMAP move back
  // to the source folder), then reloads from server truth. Reports honestly how
  // many were actually put back rather than assuming success.
  const handleUndoMove = useCallback(async (moveIds) => {
    const ids = (Array.isArray(moveIds) ? moveIds : [moveIds]).filter(Boolean);
    if (ids.length === 0) return { undone: 0, total: 0 };
    let undone = 0;
    for (const moveId of ids) {
      try {
        const data = await api.undoMove({ moveId });
        if (data?.ok) undone += 1;
      } catch { /* a failed undo leaves that message where it is; counted as not-undone */ }
    }
    loadZones();
    loadMessages();
    if (folder) loadFolderMessages();
    if (undone === ids.length) {
      pushToast({ variant: 'success', message: undone === 1 ? 'Move undone, put back where it was.' : `Undid ${undone} moves.` });
    } else if (undone > 0) {
      pushToast({ variant: 'error', message: `Undid ${undone} of ${ids.length}; the rest could not be put back.` });
    } else {
      pushToast({ variant: 'error', message: 'Could not undo the move.' });
    }
    // Return the outcome so an undo affordance (e.g. the chat sidebar) can keep
    // its retry button when nothing was actually undone (#6).
    return { undone, total: ids.length };
  }, [loadZones, loadMessages, folder, loadFolderMessages, pushToast]);

  // After the sidebar agent acts on a direct command, pull the view back into
  // sync with the real mailbox so what the agent just did is visible at once.
  const refreshAfterAgent = useCallback(() => {
    loadZones();
    loadFolderTree();
    loadMessages();
    if (folder) loadFolderMessages();
  }, [loadZones, loadFolderTree, loadMessages, folder, loadFolderMessages]);

  // Screened review to Junk (P3 physical filing): only ever removes the ids
  // just sent, and only once the server confirms a positive `moved` count —
  // never optimistic, since confirmJunk is a real mail-server move. Shared by
  // the single-row action, the reader's action, and the bulk action bar.
  const handleConfirmJunk = useCallback(async (messageIds) => {
    if (!accountId || !Array.isArray(messageIds) || messageIds.length === 0) return;
    try {
      const data = await api.confirmJunk({ messageIds, accountId });
      const moved = typeof data?.moved === 'number' ? data.moved : (Array.isArray(data?.moved) ? data.moved.length : 0);
      // #11: only clear the ids that actually moved — keep any the server returned
      // in `failed` visible AND selected, so a partial failure is not hidden by
      // removing every requested row from the list.
      const failedIds = Array.isArray(data?.failed) ? data.failed : [];
      const failedSet = new Set(failedIds);
      const removedIds = messageIds.filter((id) => !failedSet.has(id));
      if (removedIds.length > 0) {
        const idSet = new Set(removedIds);
        removeMovedIds(idSet);
        setSelectedIds((prev) => {
          const next = new Set(prev);
          idSet.forEach((id) => next.delete(id));
          return next;
        });
      }
      if (failedIds.length > 0 && removedIds.length > 0) {
        pushToast({ variant: 'error', message: `Moved ${moved} to Junk. ${failedIds.length} could not be moved and stay where they are.` });
        loadZones();
      } else if (failedIds.length > 0) {
        pushToast({ variant: 'error', message: `Could not move ${failedIds.length} to Junk.` });
      } else {
        pushToast({ variant: 'success', message: `Moved ${moved} to Junk.` });
        loadZones();
      }
    } catch (err) {
      pushToast({ variant: 'error', message: err?.body?.error || err.message || 'Could not move to Junk.' });
    }
  }, [accountId, pushToast, loadZones, removeMovedIds]);

  const handleBulkConfirmJunk = useCallback(async () => {
    if (selectedIds.size === 0) return;
    setConfirmingJunk(true);
    try {
      await handleConfirmJunk(Array.from(selectedIds));
    } finally {
      setConfirmingJunk(false);
    }
  }, [selectedIds, handleConfirmJunk]);

  // Real move (P1 manual sort): only ever reports "Moved" for ids the
  // response confirms in `moved`; anything in `failed` stays exactly where
  // it was and is reported honestly rather than silently dropped.
  const handleBulkMove = useCallback(async () => {
    if (!accountId || !bulkMoveFolder || selectedIds.size === 0) return;
    const messageIds = Array.from(selectedIds);
    setBulkMoving(true);
    try {
      const data = await api.moveToFolder({ messageIds, folder: bulkMoveFolder, accountId });
      const moved = Array.isArray(data?.moved) ? data.moved : [];
      const failed = Array.isArray(data?.failed) ? data.failed : [];
      const movedSet = new Set(moved);
      removeMovedIds(movedSet);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        movedSet.forEach((id) => next.delete(id));
        return next;
      });
      if (moved.length > 0) {
        const undoIds = Array.isArray(data?.moves) ? data.moves.map((mv) => mv.id).filter(Boolean) : [];
        const bulkDest = bulkMoveFolder.replace(/^INBOX\./, '');
        pushToast({
          variant: 'success',
          message: `Moved ${moved.length} to ${bulkDest} on your mail server. Your other mail apps will show them too.`,
          action: undoIds.length ? { label: 'Undo', onClick: () => handleUndoMove(undoIds) } : null,
        });
        loadZones();
      }
      if (failed.length > 0) {
        pushToast({
          variant: 'error',
          message: `Could not move ${failed.length} message${failed.length === 1 ? '' : 's'}; it's still in the list.`,
        });
      }
      if (moved.length === 0 && failed.length === 0) {
        pushToast({ variant: 'error', message: 'Could not move the selected messages.' });
      }
      setBulkMoveFolder('');
    } catch (err) {
      pushToast({ variant: 'error', message: err?.body?.error || err.message || 'Could not move the selected messages.' });
    } finally {
      setBulkMoving(false);
    }
  }, [accountId, bulkMoveFolder, selectedIds, pushToast, loadZones, removeMovedIds, handleUndoMove]);

  // Single-message move from the reader (same route, one id). Returns
  // normally either way — the reader's own button owns its "Moving…" state.
  const handleMoveToFolder = useCallback(async (message, folderName) => {
    if (!accountId || !message || !folderName) return;
    try {
      const data = await api.moveToFolder({ messageIds: [message.id], folder: folderName, accountId });
      const moved = Array.isArray(data?.moved) ? data.moved : [];
      if (moved.includes(message.id)) {
        removeMovedIds(new Set(moved));
        const moveId = Array.isArray(data?.moves) ? data.moves.find((mv) => mv.messageId === message.id)?.id : null;
        const destLabel = folderName.replace(/^INBOX\./, '');
        pushToast({
          variant: 'success',
          message: `Moved to ${destLabel} on your mail server. Your other mail apps will show it too.`,
          action: moveId ? { label: 'Undo', onClick: () => handleUndoMove(moveId) } : null,
        });
        loadZones();
      } else {
        pushToast({ variant: 'error', message: 'Could not move this message.' });
      }
    } catch (err) {
      pushToast({ variant: 'error', message: err?.body?.error || err.message || 'Could not move this message.' });
    }
  }, [accountId, pushToast, loadZones, removeMovedIds, handleUndoMove]);

  // Row "File" flow (direct execute, no proposal). With allFromSender it files
  // EVERY stored message from this sender into the folder in one move, so the
  // owner can file one and watch them all go, with a single Undo for the batch.
  const handleFileToFolder = useCallback(async (message, folderName, allFromSender = false) => {
    if (!accountId || !message || !folderName) return;
    try {
      let messageIds = [message.id];
      let scopeTotal = 1;
      if (allFromSender && message.fromAddr) {
        const res = await api.searchMessages({ accountId, from: message.fromAddr, limit: 200 }, { force: true });
        const found = Array.isArray(res?.messages) ? res.messages : [];
        messageIds = found.map((m) => m.id);
        scopeTotal = typeof res?.total === 'number' ? res.total : messageIds.length;
        if (messageIds.length === 0) messageIds = [message.id];
      }
      const data = await api.moveToFolder({ messageIds, folder: folderName, accountId });
      const moved = Array.isArray(data?.moved) ? data.moved : [];
      if (moved.length > 0) {
        removeMovedIds(new Set(moved));
        const undoIds = Array.isArray(data?.moves) ? data.moves.map((mv) => mv.id).filter(Boolean) : [];
        const dest = folderName.replace(/^INBOX\./, '');
        const capNote = scopeTotal > moved.length ? ` (${moved.length} of ${scopeTotal}; file again for the rest)` : '';
        const serverNote = ' Now on your mail server, so your other mail apps show it too.';
        pushToast({
          variant: 'success',
          message: (allFromSender
            ? `Filed ${moved.length} from ${message.fromName || message.fromAddr} to ${dest}${capNote}.`
            : `Moved to ${dest}.`) + serverNote,
          action: undoIds.length ? { label: 'Undo', onClick: () => handleUndoMove(undoIds) } : null,
        });
        loadZones();
        loadMessages();
        if (folder) loadFolderMessages();
      } else {
        pushToast({ variant: 'error', message: 'Could not file these messages.' });
      }
    } catch (err) {
      pushToast({ variant: 'error', message: err?.body?.error || err.message || 'Could not file.' });
    }
  }, [accountId, pushToast, loadZones, loadMessages, folder, loadFolderMessages, removeMovedIds, handleUndoMove]);

  // Trusted sender (P1 manual sort): the "no it isn't junk" counterpart to
  // Block. Only removes the sender's mail from view once the server
  // confirms `ok` — an honest reflection of the classifier actually having
  // moved them back to Focus, not a hopeful optimistic removal.
  const handleTrustSender = useCallback(async (message) => {
    if (!message?.fromAddr || !accountId) return;
    const fromAddr = message.fromAddr;
    const label = message.fromName || fromAddr;
    try {
      const data = await api.trustSender({ fromAddr, accountId });
      if (data?.ok) {
        const matches = (m) => m.fromAddr === fromAddr;
        setMessages((prev) => prev.filter((m) => !matches(m)));
        setFolderMessages((prev) => prev.filter((m) => !matches(m)));
        setSelectedMessage((prev) => (prev && matches(prev) ? null : prev));
        pushToast({ variant: 'success', message: `Trusted ${label}, moved back to Focus.` });
        loadZones();
      } else {
        pushToast({ variant: 'error', message: `Could not mark ${label} as trusted.` });
      }
    } catch (err) {
      pushToast({ variant: 'error', message: err?.body?.error || err.message || `Could not mark ${label} as trusted.` });
    }
  }, [accountId, pushToast, loadZones]);

  const handleFolderCreated = useCallback((created) => {
    setShowNewFolderModal(false);
    // `created` is whatever api.createFolder's { folder } resolved to — a
    // path/name string in the common case, but treated defensively as it
    // could be an object ({id, name, imapPath}); never render "[object
    // Object]" in a toast the owner reads as confirmation.
    const label = typeof created === 'string'
      ? created
      : (created?.imapPath || created?.name || created?.id || 'folder');
    pushToast({ variant: 'success', message: `Created folder ${label}.` });
    loadAccounts({ force: true });
  }, [pushToast, loadAccounts]);

  // The list currently backing the master-detail pane: a zone's messages or
  // a clicked folder's stored messages, whichever main view is showing.
  const activeMessages = mainView === 'folder' ? folderMessages : messages;
  const activeMessagesLoading = mainView === 'folder' ? folderMessagesLoading : messagesLoading;
  const activeMessagesError = mainView === 'folder' ? folderMessagesError : messagesError;

  // Previous/Next inside the currently loaded list (audit B: a reliable
  // Back + Previous/Next for narrow widths where list and reader swap).
  const selectedIndex = useMemo(() => {
    if (!selectedMessage) return -1;
    return activeMessages.findIndex((m) => m.id === selectedMessage.id);
  }, [activeMessages, selectedMessage]);

  const handlePrevMessage = useCallback(() => {
    if (selectedIndex > 0) setSelectedMessage(activeMessages[selectedIndex - 1]);
  }, [selectedIndex, activeMessages]);

  const handleNextMessage = useCallback(() => {
    if (selectedIndex >= 0 && selectedIndex < activeMessages.length - 1) setSelectedMessage(activeMessages[selectedIndex + 1]);
  }, [selectedIndex, activeMessages]);

  const activeAccount = useMemo(() => accounts.find((a) => a.id === accountId) || null, [accounts, accountId]);
  // zone === null means "every stored message, no zone filter" — the
  // Overview's Stored messages stat jumps here (audit C: "omit zone, folder,
  // and flag filters"), reusing the existing zone list/reader pane rather
  // than a new destination.
  const activeZoneLabel = useMemo(() => (zone ? (ZONES.find((z) => z.key === zone)?.label || zone) : 'All stored mail'), [zone]);

  // Before the first mailbox load resolves, show a clear loading state rather
  // than the empty workspace shell (which reads as "broken" during the delay).
  if (!accountsLoaded) {
    return (
      <div className="qx-empty" style={{ margin: 'auto', textAlign: 'center' }} data-testid="inboxq-accounts-loading">
        <div className="qx-spinner" aria-hidden="true" />
        <div className="qx-empty__body" style={{ marginTop: 12 }}>Loading your mailboxes…</div>
      </div>
    );
  }

  // A load ERROR is distinct from an empty org: show it, with a retry, rather
  // than dropping the user into onboarding (which looks like "no mailboxes yet"
  // and hides a 401/network/org problem).
  if (accountsLoaded && accountsError && accounts.length === 0) {
    return (
      <div className="qx-empty" style={{ margin: 'auto', textAlign: 'center' }}>
        <div className="qx-empty__title">Couldn't load your mailboxes</div>
        <div className="qx-empty__body">{accountsError}</div>
        <button type="button" className="qx-btn qx-btn--sm" style={{ marginTop: 12 }} onClick={() => loadAccounts({ force: true })}>Retry</button>
      </div>
    );
  }

  if (accountsLoaded && accounts.length === 0) {
    return <InboxQOnboarding onConnected={handleAccountConnected} />;
  }

  return (
    <div className="qx-stack iq-workspace">
      <Toolbar
        accounts={accounts}
        accountId={accountId}
        onAccountChange={setAccountId}
        onSync={handleSync}
        syncing={syncing}
        syncProgress={syncProgress}
        onReclassify={handleReclassify}
        reclassifying={reclassifying}
        onGenerateReport={handleGenerateReport}
        generating={generating}
        showSettings={mainView === 'settings'}
        onToggleSettings={handleToggleSettings}
        lastSync={lastSync}
      />

      <div className="qx-row iq-body">
        <InboxQNav
          zones={ZONES}
          zoneCounts={zoneCounts}
          folders={activeAccount?.folders || []}
          folderTree={folderTree}
          folderTreeLive={folderTreeLive}
          folderTreeLoading={folderTreeLoading}
          folderTreeGmail={folderTreeGmail}
          mainView={mainView}
          activeZone={zone}
          activeFolder={folder}
          proposalsCount={proposals.length}
          onSelectOverview={() => setMainView('overview')}
          onSelectZone={handleSelectZone}
          onSelectFolder={handleSelectFolder}
          onSelectReport={() => setMainView('report')}
          onSelectProposals={() => setMainView('proposals')}
          onSelectRules={() => setMainView('rules')}
          onSelectSettings={handleToggleSettings}
          onManageFolders={() => setMainView('settings')}
          onNewFolder={() => setShowNewFolderModal(true)}
        />

        <div className="iq-main">
          {mainView === 'zone' || mainView === 'folder' ? (
            <div className="qx-stack qx-stack--tight" style={{ flex: '1 1 0', minHeight: 0 }}>
              {mainView === 'folder' && (
                <FolderHeader folder={folder} count={folderMessages.length} total={folderTotal} />
              )}
              {selectedIds.size > 0 && (
                <BulkActionBar
                  count={selectedIds.size}
                  folders={activeAccount?.folders || []}
                  folder={bulkMoveFolder}
                  onFolderChange={setBulkMoveFolder}
                  onMove={handleBulkMove}
                  moving={bulkMoving}
                  onClear={handleClearBulkSelect}
                  showConfirmJunk={mainView === 'zone' && zone === 'screened'}
                  onConfirmJunk={handleBulkConfirmJunk}
                  confirmingJunk={confirmingJunk}
                />
              )}
              <div className="qx-master-detail" data-detail-open={selectedMessage ? 'true' : 'false'}>
                <div className="qx-master-detail__list">
                  {activeMessagesLoading ? (
                    <div className="qx-skeleton" style={{ height: 200 }} />
                  ) : activeMessagesError ? (
                    <div className="qx-banner qx-banner--error">{activeMessagesError}</div>
                  ) : activeMessages.length === 0 ? (
                    <div className="qx-empty">
                      {mainView === 'folder' ? (
                        <>
                          <div className="qx-empty__title">No messages stored from this folder yet</div>
                          <div className="qx-empty__body">
                            Sync it from Settings &gt; Synced folders.
                          </div>
                          <button
                            type="button"
                            className="qx-btn qx-btn--sm qx-btn--ghost"
                            style={{ marginTop: 8 }}
                            onClick={() => setMainView('settings')}
                          >
                            Open settings
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="qx-empty__title">Nothing in {activeZoneLabel} yet</div>
                          <div className="qx-empty__body">
                            {activeAccount ? 'Sync to pull and classify new mail from this mailbox.' : 'Choose a mailbox above.'}
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div
                      className="qx-card qx-surface--backed qx-scroll-pane"
                      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                    >
                      {activeMessages.map((m) => (
                        <MessageRow
                          key={m.id}
                          message={m}
                          selected={selectedMessage?.id === m.id}
                          onOpen={handleOpenMessage}
                          onBlock={handleBlockSender}
                          onMove={handleMove}
                          onFileToFolder={handleFileToFolder}
                          folders={activeAccount?.folders || []}
                          onConfirmJunk={(msg) => handleConfirmJunk([msg.id])}
                          bulkChecked={selectedIds.has(m.id)}
                          onToggleBulk={handleToggleBulkSelect}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {selectedMessage && (
                  <div className="qx-master-detail__reader">
                    <InboxQMessageReader
                      message={selectedMessage}
                      backLabel={mainView === 'folder' ? folder : activeZoneLabel}
                      onBack={handleBackToZone}
                      onPrev={handlePrevMessage}
                      onNext={handleNextMessage}
                      hasPrev={selectedIndex > 0}
                      hasNext={selectedIndex >= 0 && selectedIndex < activeMessages.length - 1}
                      onMove={handleMoveFromPreview}
                      onBlock={handleBlockSender}
                      folders={activeAccount?.folders || []}
                      onMoveToFolder={handleMoveToFolder}
                      onTrustSender={handleTrustSender}
                      onConfirmJunk={(msg) => handleConfirmJunk([msg.id])}
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="qx-scroll-pane qx-surface--backed iq-doc-pane">
              <div className="qx-stack qx-stack--tight">
                {mainView === 'settings' && (
                  <SettingsPanel accountId={accountId} accounts={accounts} onClose={() => setMainView('overview')} />
                )}

                {mainView === 'overview' && (
                  <InboxQToday
                    accountId={accountId}
                    mailboxLabel={activeAccount?.displayName || activeAccount?.emailAddress}
                    folders={activeAccount?.folders || []}
                    zoneCounts={zoneCounts}
                    proposalsCount={proposals.length}
                    report={report}
                    lastSync={lastSync}
                    onOpenZone={handleSelectZone}
                    onOpenAllMessages={() => handleSelectZone(null)}
                    onOpenFolder={handleSelectFolder}
                    onOpenReport={() => setMainView('report')}
                    onOpenProposals={() => setMainView('proposals')}
                    onOpenSettings={() => setMainView('settings')}
                  />
                )}

                {mainView === 'report' && (
                  <InboxQReport
                    report={report}
                    onOpenMessage={handleOpenFromSummary}
                    onGenerate={handleGenerateReport}
                    generating={generating}
                  />
                )}

                {mainView === 'proposals' && (
                  <ProposalsPanel proposals={proposals} onResolve={handleResolve} resolvingIds={resolvingIds} />
                )}

                {mainView === 'rules' && (
                  <InboxQRulesPanel
                    accountId={accountId}
                    folders={activeAccount?.folders || []}
                    onClose={() => setMainView('overview')}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <div
          className="iq-chat-dock qx-surface--backed"
          data-collapsed={inboxChatCollapsed ? 'true' : 'false'}
          style={{ width: inboxChatCollapsed ? 48 : 340, flexShrink: 0 }}
        >
          <InboxQChatSidebar
            accountId={accountId}
            accountLabel={activeAccount?.displayName || activeAccount?.emailAddress}
            mainView={mainView}
            zone={zone}
            zoneCounts={zoneCounts}
            selectedMessage={selectedMessage}
            folders={activeAccount?.folders || []}
            onRefreshView={refreshAfterAgent}
            onUndoMove={handleUndoMove}
            collapsed={inboxChatCollapsed}
            onToggle={() => setInboxChatCollapsed((v) => !v)}
          />
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="qx-toast-stack" data-testid="inboxq-toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`qx-toast qx-toast--${t.variant}`}>
              <div className="qx-toast__body">
                <div className="qx-toast__msg">{t.message}</div>
              </div>
              {t.action && (
                <button
                  type="button"
                  className="qx-btn qx-btn--sm qx-btn--ghost"
                  data-testid="inboxq-toast-action"
                  onClick={() => {
                    setToasts((prev) => prev.filter((x) => x.id !== t.id));
                    t.action.onClick();
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                className="qx-toast__close"
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {showNewFolderModal && (
        <InboxQNewFolderModal
          accountId={accountId}
          onClose={() => setShowNewFolderModal(false)}
          onCreated={handleFolderCreated}
        />
      )}
    </div>
  );
}

export default function InboxQView() {
  // Same gating mechanism as every other paid plugin view (QuoxLensView/
  // usePluginLicensed). inboxq is governed since 2026-10-07.
  const licensed = usePluginLicensed('inboxq');
  const diag = usePluginLicenseDiagnosis('inboxq');

  if (!licensed) {
    // Governed since 2026-10-07: an org-seat problem is explained, not sold again.
    return <LicenceGate diag={diag} displayName="InboxQ" locked={<InboxQLocked />} />;
  }

  return (
    <div className="qx-view iq-view">
      <InboxQContent />
    </div>
  );
}

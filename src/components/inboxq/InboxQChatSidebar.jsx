/**
 * InboxQChatSidebar — thin AgentChatSidebar wrapper for the InboxQ agent (the
 * mailbox "Chief of Staff").
 *
 * The agent EXECUTES directly on the authenticated user's command (owner
 * 2026-10-02, feedback-direct-user-action-is-authorization): the user telling
 * it to file/block/re-zone IS the authorization, so there are no proposal cards
 * and no separate approval screen. After each assistant turn this therefore:
 *   (a) refreshes the inbox view, so it reflects what the agent just did (the
 *       owner's "it's not reflecting the inbox" complaint); and
 *   (b) diffs the recent-moves log and surfaces an Undo affordance for any move
 *       the turn created — the same read-the-authoritative-store pattern the old
 *       proposal-diff used, pointed at inboxq_moves instead of inboxq_proposals.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentChatSidebar } from '../chat/AgentChatSidebar';
import { api } from './lib/api.js';

const INBOXQ_SUGGESTIONS = [
  'What needs my attention right now?',
  'Move everything from wordfence to a Wordfence folder',
  'Junk this sender and block them',
  'Tidy up all the newsletters',
];

export function InboxQChatSidebar({
  accountId,
  accountLabel,
  mainView,
  zone,
  zoneCounts,
  selectedMessage,
  folders,
  onRefreshView,
  onUndoMove,
  collapsed,
  onToggle,
}) {
  // Moves already on record before a given chat turn — never re-attached to a
  // later turn as if this turn had created them.
  const seenMoveIdsRef = useRef(new Set());
  const [messageMoves, setMessageMoves] = useState({});

  // Seed the baseline of known moves when the active mailbox changes, so the
  // first turn only ever surfaces Undo for moves IT created, not history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!accountId) { seenMoveIdsRef.current = new Set(); return; }
      try {
        const res = await api.listMoves({ accountId, limit: 50 }, { force: true });
        if (!cancelled) seenMoveIdsRef.current = new Set(((res && res.moves) || []).map((m) => m.id));
      } catch { if (!cancelled) seenMoveIdsRef.current = new Set(); }
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  const handleAssistantMessage = useCallback(async (msg) => {
    // The agent has acted (or just answered). Reflect any change in the inbox
    // view immediately, then surface Undo for a move this turn created.
    onRefreshView?.();
    if (!accountId) return;
    let moves = [];
    try {
      const res = await api.listMoves({ accountId, limit: 20 }, { force: true });
      moves = (res && res.moves) || [];
    } catch { /* the Undo affordance is best-effort; the action still happened */ }
    const fresh = moves.filter((m) => !m.undone && !seenMoveIdsRef.current.has(m.id));
    if (fresh.length) {
      setMessageMoves((prev) => ({ ...prev, [msg.messageId]: fresh.map((m) => m.id) }));
    }
    seenMoveIdsRef.current = new Set(moves.map((m) => m.id));
  }, [accountId, onRefreshView]);

  const renderMessageAddon = useCallback((msg) => {
    const moveIds = messageMoves[msg.messageId];
    if (!moveIds || !moveIds.length) return null;
    return (
      <div className="inboxq-chat-undo">
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          data-testid="inboxq-chat-undo"
          onClick={async () => {
            // Only drop the Undo affordance when everything was actually undone;
            // if the reversal failed (or partly failed) keep it so the owner can
            // retry (#6). onUndoMove resolves { undone, total }.
            const r = await onUndoMove?.(moveIds);
            if (r && r.total > 0 && r.undone === r.total) {
              setMessageMoves((prev) => { const next = { ...prev }; delete next[msg.messageId]; return next; });
            }
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
          </svg>
          Undo {moveIds.length > 1 ? `${moveIds.length} moves` : 'move'}
        </button>
      </div>
    );
  }, [messageMoves, onUndoMove]);

  const contextBuilder = useCallback(async () => {
    const summary = [
      { label: 'Mailbox', value: accountId ? (accountLabel || accountId) : 'none selected' },
      { label: 'Current view', value: mainView === 'zone' ? `Zone: ${zone || 'all'}` : mainView },
      { label: 'Zone counts (focus/fyi/auto/screened)', value: `${zoneCounts?.focus ?? 0}/${zoneCounts?.fyi ?? 0}/${zoneCounts?.auto ?? 0}/${zoneCounts?.screened ?? 0}` },
    ];

    const evidence = [];
    if (selectedMessage) {
      evidence.push({
        label: `Selected message: ${selectedMessage.subject || '(no subject)'}`,
        text: `from ${selectedMessage.fromName || selectedMessage.fromAddr || 'unknown sender'}${selectedMessage.fromAddr ? ` <${selectedMessage.fromAddr}>` : ''} • zone ${selectedMessage.zone || 'unknown'}${Array.isArray(selectedMessage.flags) && selectedMessage.flags.length ? ` • flags: ${selectedMessage.flags.join(', ')}` : ''}`,
      });
    }
    if (Array.isArray(folders) && folders.length > 0) {
      evidence.push({ label: 'Folders synced for this mailbox', text: folders.join(', ') });
    }

    return {
      surface: 'inboxq',
      page: '/inboxq',
      panel: 'InboxQ',
      focus: selectedMessage
        ? { type: 'Message', label: selectedMessage.subject || '(no subject)', id: selectedMessage.id, detail: selectedMessage.fromAddr }
        : { type: 'InboxQ view', label: mainView === 'zone' ? `Zone: ${zone || 'all'}` : mainView },
      summary,
      evidenceTitle: 'InboxQ state',
      evidence,
      instructions: [
        'You are talking to the authenticated owner of this inbox. Their direct command IS the authorization: when they tell you to do something, DO it, do not make them approve their own request on another screen.',
        'Read tools (inbox_accounts, inbox_zones, inbox_search, inbox_get, inbox_folders, inbox_blocked, inbox_report_latest) are free and have no mail effect.',
        'Act with the execute tools: inbox_move (file into a folder), inbox_rezone (change triage zone), inbox_block (block a sender/domain and screen their mail), inbox_create_folder. Each runs immediately through the same path the dashboard buttons use and returns the real outcome.',
        'Before a batch action ("move all X", "block everything from Y"), call inbox_search first and quote its exact total back, then pass the SAME matchSpec unchanged to the execute tool so the server freezes the identical set.',
        'After acting, quote the real counts from the tool result and that an Undo is available; never claim more than the result confirms. A block holds inside Quox and screens future mail but installs no provider-side rule yet, so say it could still reach other mail clients.',
        'You have no tool to send, reply, delete, or mark mail read, and you do not offer to.',
        accountId
          ? `The active mailbox account id is ${accountId}; pass it as accountId to every inbox_* tool call without asking the user for it.`
          : 'No mailbox is selected yet; ask the user to connect or choose one before calling inbox_* tools.',
      ],
    };
  }, [accountId, accountLabel, mainView, zone, zoneCounts, selectedMessage, folders]);

  return (
    <AgentChatSidebar
      /* The dock wrapper in InboxQView already carries .qx-surface--backed
         (opaque undercoat), so the sidebar must not paint its own glass panel
         on top of it — same reasoning as InboxChatSidebar's panel={false}. */
      panel={false}
      agentId="inboxq"
      agentName="INBOXQ"
      agentColor="#38bdf8"
      agentRole="Inbox Chief of Staff"
      contextBuilder={contextBuilder}
      suggestions={INBOXQ_SUGGESTIONS}
      sessionPrefix={`INBOXQ_${accountId || 'NONE'}`}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask INBOXQ to find, file, or block..."
      emptyText="Ask INBOXQ about your inbox..."
      onAssistantMessage={handleAssistantMessage}
      renderMessageAddon={renderMessageAddon}
    />
  );
}

export default InboxQChatSidebar;

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { timecode, relativeTime } from '../lib/format.js';
import { NEXT_STEPS, estimateEnrichmentCost } from '../lib/nextSteps.js';
import { useEnrichments } from '../lib/enrichmentState.js';
import { useAsync } from '../lib/useAsync.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import EvidenceTrail from '../components/EvidenceTrail.jsx';
import RefreshControl from '../components/RefreshControl.jsx';
import ScoutChatSidebar from '../ScoutChatSidebar.jsx';

const fetchPending = (opts) => api.listProposals({ status: 'pending' }, opts);
const fetchApproved = (opts) => api.listProposals({ status: 'approved' }, opts);
const fetchRejected = (opts) => api.listProposals({ status: 'rejected' }, opts);

/**
 * SIGNAL-UX item 9: a proposal record only carries item_id/author/platform —
 * no title (see server/src/api/proposals.js's serializeProposal). Joins in
 * the item so the panel can say plainly which post it came from, same join
 * pattern as FeedView's sourceByLabel (cosmetic-only: a failed/slow lookup
 * degrades to the proposal's own author/platform fields, never blanks the
 * card). api.getItem() already caches per id, so re-render-triggered re-runs
 * of this hook cost nothing once every referenced item has loaded once.
 */
function useItemsByIds(ids) {
  const [itemsById, setItemsById] = useState(() => new Map());
  const key = ids.join(',');
  useEffect(() => {
    let cancelled = false;
    const missing = ids.filter((id) => id && !itemsById.has(id));
    if (missing.length === 0) return undefined;
    /* ONE request for all missing ids, not one per id. This loop was 18 of the 22 requests
       a cold Proposals load used to issue. A failure resolves to no join rather than an
       error: the origin line degrades to the proposal's own author/platform, which is the
       same cosmetic-only posture this hook always had. */
    api.listItemsByIds(missing)
      .then((res) => {
        if (cancelled) return;
        setItemsById((prev) => {
          const next = new Map(prev);
          for (const item of res?.items || []) next.set(item.id, item);
          return next;
        });
      })
      .catch(() => { /* cosmetic join only, never blank the card */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return itemsById;
}

/**
 * SIGNAL-REDESIGN 2026-09-18: full item (WITH segments) for expanded cards
 * only. The batched /items?ids= join above deliberately returns list-shaped
 * rows, which carry NO segments — the transcript panel read `item.segments`
 * off those rows and showed "No transcript recorded" for every proposal,
 * even when a 15-segment Whisper transcript existed. Fetch the detail shape
 * lazily, one GET /items/:id per card the FIRST time its details open
 * (api.getItem caches per id, so collapse/re-expand costs nothing).
 */
function useDetailedItems(expandedProposalIds, proposalsById) {
  const [detailed, setDetailed] = useState(() => new Map());
  const key = [...expandedProposalIds].join(',');
  useEffect(() => {
    let cancelled = false;
    for (const pid of expandedProposalIds) {
      const itemId = proposalsById.get(pid)?.item_id;
      if (!itemId || detailed.has(itemId)) continue;
      api.getItem(itemId)
        .then((item) => {
          if (cancelled || !item) return;
          setDetailed((prev) => new Map(prev).set(itemId, item));
        })
        .catch(() => { /* transcript panel shows its honest empty state */ });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return detailed;
}

/** "Source: X · Post: Y" — the plain-language answer to "which post did this
 * come from?" that the proposal card lacked before SIGNAL-UX item 9. Falls
 * back to the proposal's own author/platform while the item join is still
 * loading (or if it 404s), so the header is never blank. */
function ProposalOrigin({ proposal, item }) {
  const source = item?.source_label || proposal.author || proposal.platform || 'unknown source';
  const title = item?.title || null;
  return (
    <div className="qx-row qx-row--tight" style={{ alignItems: 'baseline' }}>
      <span className="qx-hint qx-hint--sm">Source: <strong>{source}</strong></span>
      {title && <span className="qx-hint qx-hint--sm">&middot; Post: <strong>{title}</strong></span>}
    </div>
  );
}

/** Kind tag using the coloured, larger .qx-kind utility (SIGNAL-UX item 8) —
 * each of stream/substream/skill/plugin-feature/alert/fyi (see
 * quox-signal/lib/analyse.js's triage prompt) gets its own hue. */
function KindTag({ kind }) {
  return <span className={`qx-kind qx-kind--${kind}`}>{kind}</span>;
}

/** One KPI tile on the stats strip (design-system .qx-stat). */
function Stat({ label, value, sub }) {
  return (
    <div className="qx-stat">
      <span className="qx-stat__head">{label}</span>
      <span className="qx-stat__value">{value}</span>
      {sub && <span className="qx-stat__sub">{sub}</span>}
    </div>
  );
}

/** Findings as FLAT sections separated by dividers. They used to render as
 * .qx-card--compact INSIDE the proposal's .qx-card — card-in-card glass,
 * which is exactly the "wall of panels where nothing visibly ends" the
 * owner called out (and rule 11 of the design system forbids). */
function ProposalFindings({ findings }) {
  return findings.map((p, i) => (
    <div key={i} className="qx-stack qx-stack--tight">
      {i > 0 && <div className="qx-divider qx-divider--dense" />}
      <div className="qx-row qx-row--apart">
        <KindTag kind={p.kind} />
        <span
          className="qx-hint qx-hint--sm"
          title="A model estimate, generated once and never cross-checked. Not a measured probability."
        >
          model est. {p.confidence}
        </span>
      </div>
      <strong>{p.title}</strong>
      <p className="qx-hint">{p.rationale}</p>
      {(p.evidence || []).map((e, j) => (
        <div key={j} className="qx-row qx-row--tight">
          <span className="qx-chip qx-chip--xs qx-mono">{e.t}</span>
          <span className="qx-hint">&ldquo;{e.quote}&rdquo;</span>
        </div>
      ))}
    </div>
  ));
}

/** Right-hand pane of the details split: the source item's transcript, or an
 * honest "not transcribed yet" hint rather than an empty box. Flat (no inner
 * card) — the proposal card provides the surface. */
function TranscriptPanel({ item }) {
  const segments = item?.segments || [];
  return (
    <div className="qx-stack qx-stack--tight" data-testid="proposal-transcript-panel">
      <span className="qx-section-title">Transcript</span>
      {segments.length === 0 ? (
        <span className="qx-hint qx-hint--sm">
          {item ? 'No transcript recorded for this item.' : 'Loading transcript…'}
        </span>
      ) : (
        <div className="qx-scroll-list qx-stack qx-stack--tight" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {segments.map((seg) => (
            <div className="qx-row qx-row--tight" key={seg.seq}>
              <span className="qx-chip qx-chip--xs qx-mono">{timecode(seg.start)}</span>
              <span>{seg.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The collapsed-by-default details region: findings + transcript in the
 * item-7 split, evidence trail below. One toggle governs the whole region —
 * this is what turns the old always-open "facebook wall" into a scannable
 * queue. The toggle keeps the historical signal-toggle-evidence-<id> testid:
 * it still gates the evidence-bundle fetch (EvidenceTrail mounts only after
 * first expand, exactly as before). */
function ProposalDetails({ proposal, item, expanded, everExpanded, onToggle, beside = null }) {
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        {beside}
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          aria-expanded={expanded}
          onClick={onToggle}
          data-testid={`signal-toggle-evidence-${proposal.id}`}
        >
          {expanded ? 'Hide details' : 'Details: findings, transcript, evidence'}
        </button>
      </div>
      {everExpanded && (
        <div
          data-testid="signal-proposal-panels"
          className="qx-stack"
          style={expanded ? undefined : { display: 'none' }}
        >
          <div className="qx-divider" />
          <div className="qx-split">
            <div className="qx-stack qx-stack--tight">
              <span className="qx-section-title">Findings</span>
              <ProposalFindings findings={proposal.proposals || []} />
            </div>
            <TranscriptPanel item={item} />
          </div>
          <div className="qx-divider" />
          <EvidenceTrail proposal={proposal} />
        </div>
      )}
    </div>
  );
}

/** SIGNAL-PIPELINE Discuss & update: the summary is the thing QuoxPlan will
 * receive, so after discussion it must be REVISABLE — up until handoff, when
 * the server makes the record immutable (409). Approved lane only: pending
 * proposals are being decided, not refined. */
function EditableSummary({ proposal, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  if (!editing) {
    return (
      <div className="qx-row qx-row--apart" style={{ alignItems: 'flex-start', gap: 8 }}>
        <p style={{ margin: 0, flex: 1 }}>{proposal.summary || <span className="qx-hint">No summary.</span>}</p>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          title="Update the summary before handing off (Discuss & update)"
          data-testid={`signal-edit-summary-${proposal.id}`}
          onClick={() => { setDraft(proposal.summary || ''); setErr(null); setEditing(true); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, marginRight: 6 }}>
            <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
          </svg>
          Edit
        </button>
      </div>
    );
  }
  return (
    <div className="qx-stack qx-stack--tight">
      <textarea
        className="qx-textarea"
        rows={4}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Proposal summary"
        data-testid={`signal-summary-draft-${proposal.id}`}
      />
      {err && <div className="qx-banner qx-banner--error">{err}</div>}
      <div className="qx-row qx-row--end qx-row--tight">
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--primary"
          disabled={busy || !draft.trim()}
          data-testid={`signal-save-summary-${proposal.id}`}
          onClick={async () => {
            setBusy(true); setErr(null);
            try {
              await api.updateProposal(proposal.id, { summary: draft.trim() });
              setEditing(false);
              onSaved?.();
            } catch (e) {
              setErr(e?.body?.error || e.message);
            } finally { setBusy(false); }
          }}
        >
          Save summary
        </button>
      </div>
    </div>
  );
}

/** Deepen research — OPTIONAL enrichment, available on any queued proposal.
 * Data-driven off the NEXT_STEPS registry (enrich steps only) so future
 * steps keep appearing without a view rewrite; the spend confirmation is
 * preserved (nothing spends silently). */
function DeepenButton({ proposal, allItems, detailItem, onEnriched }) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState(null);
  const step = NEXT_STEPS.find((st) => st.kind === 'enrich');
  if (!step) return null;
  const transcriptChars = (detailItem?.segments || []).reduce((n, sg) => n + (sg.text || '').length, 0);
  const estimate = estimateEnrichmentCost(transcriptChars, Math.min(5, Math.max(0, (allItems?.length || 1) - 1)));

  async function fire() {
    setErr(null); setConfirming(false); setRunning(true);
    try {
      const result = await step.run(proposal, { allItems });
      onEnriched?.(result);
    } catch (e) {
      setErr(e.message);
    } finally { setRunning(false); }
  }

  return (
    <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
      <button
        type="button"
        className="qx-btn qx-btn--sm qx-btn--ghost"
        title={step.description}
        disabled={running}
        data-testid={`signal-deepen-${proposal.id}`}
        onClick={() => (step.costs ? setConfirming(true) : fire())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, marginRight: 6 }}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35" /><path d="M11 8v6" /><path d="M8 11h6" /></svg>
        {running ? (<><span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" /> Deepening…</>) : 'Deepen research'}
      </button>
      {confirming && (
        <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span className="qx-hint qx-hint--sm">~${estimate.toFixed(3)}, appends only.</span>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--primary" onClick={fire} data-testid={`signal-deepen-${proposal.id}-confirm`}>Run it</button>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setConfirming(false)}>Cancel</button>
        </span>
      )}
      {err && <span className="qx-hint qx-hint--sm qx-hint--danger">{err}</span>}
    </div>
  );
}

/** Discuss & update, part one: point SCOUT at THIS proposal and open the chat. */
function DiscussButton({ proposal, onDiscuss }) {
  return (
    <button
      type="button"
      className="qx-btn qx-btn--sm qx-btn--ghost"
      title="Open SCOUT focused on this proposal — argue it out, improve the summary, then approve"
      data-testid={`signal-discuss-${proposal.id}`}
      onClick={() => onDiscuss(proposal)}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, marginRight: 6 }}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      Discuss & Improve
    </button>
  );
}

/** Shared card header: title-led (post title, falling back to author), with
 * platform + finding-kind chips and the proposal's age — so each card reads
 * as ONE bounded unit at a glance. */
function ProposalHeader({ proposal, item }) {
  const kinds = [...new Set((proposal.proposals || []).map((f) => f.kind).filter(Boolean))];
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'baseline' }}>
        <Link to={`/quoxsignal/items/${encodeURIComponent(proposal.item_id)}`} style={{ minWidth: 0 }}>
          <strong>{item?.title || proposal.author || proposal.platform || proposal.item_id}</strong>
        </Link>
        <div className="qx-row qx-row--tight" style={{ flexShrink: 0, alignItems: 'center' }}>
          {kinds.map((k) => <KindTag key={k} kind={k} />)}
          <span className="qx-chip qx-chip--xs">{proposal.platform}</span>
          {proposal.created_at && (
            <span className="qx-hint qx-hint--sm" title={proposal.created_at}>{relativeTime(proposal.created_at)}</span>
          )}
        </div>
      </div>
      <ProposalOrigin proposal={proposal} item={item} />
    </div>
  );
}

/**
 * The HITL surface: every pending proposal, its typed findings and their
 * verbatim evidence, with Approve/Reject wired to the existing decision
 * endpoint. Deciding a proposal only records the decision — it does not
 * wire a build step, so the UI says so plainly rather than implying a
 * downstream action that does not exist yet.
 *
 * Approved proposals get a second lane: approving and handing off
 * to QuoxPlan are deliberately separate acts, so an approved proposal is
 * fetched separately here rather than chained automatically off the
 * decision above.
 *
 * SIGNAL-REDESIGN 2026-09-18 (owner: "chaotic and messy... a facebook wall
 * of panels"): stats strip on top, search/kind/source filters, and each
 * card collapsed to header + summary + actions with a single Details
 * disclosure. Structure over sprawl; nothing was removed, it folded.
 */
export default function ProposalsView() {
  const { loading, error, data, retry, refreshing: pendingRefreshing, updatedAt: pendingUpdatedAt } =
    useAsync(fetchPending, []);
  const proposals = data?.proposals || [];
  const [decidingIds, setDecidingIds] = useState(() => new Set());
  const [scoutCollapsed, setScoutCollapsed] = useState(false);
  // Discuss & update: which proposal the SCOUT discussion is focused on.
  const [focusProposal, setFocusProposal] = useState(null);
  const discussProposal = useCallback((proposal) => {
    setFocusProposal(proposal);
    setScoutCollapsed(false);
  }, []);

  const {
    data: approvedData,
    retry: retryApproved,
    refreshing: approvedRefreshing,
    updatedAt: approvedUpdatedAt,
  } = useAsync(fetchApproved, []);
  const approvedProposals = approvedData?.proposals || [];

  // Stats-strip only: the rejected lane has no list UI (rejection is
  // terminal), but the count belongs on the scoreboard.
  const { data: rejectedData } = useAsync(fetchRejected, []);
  const rejectedCount = rejectedData?.proposals?.length ?? null;
  const handedOffCount = approvedProposals.filter((p) => p.handoff_state === 'submitted').length;
  // Deepened tile: proposals in the queue that already carry an enrichment
  // (server counts it as awaiting_discussion). Cosmetic; degrades to a dash.
  const [pipelineStats, setPipelineStats] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (typeof api.getStats !== 'function') return undefined;
    api.getStats().then((st) => { if (!cancelled) setPipelineStats(st); }).catch(() => {});
    return () => { cancelled = true; };
  }, [proposals.length, approvedProposals.length]);

  // SIGNAL-PERF: one Refresh control for the whole tab (both lanes share it), forcing both
  // lists past the cache. "Updated" shows the OLDER of the two timestamps, never the newer —
  // an honest "as of" must not claim the lane that hasn't refreshed yet is fresher than it is.
  const refreshTab = useCallback(() => {
    retry({ force: true, silent: true });
    retryApproved({ force: true, silent: true });
  }, [retry, retryApproved]);
  const tabRefreshing = pendingRefreshing || approvedRefreshing;
  const tabUpdatedAt = (() => {
    const times = [pendingUpdatedAt, approvedUpdatedAt].filter(Boolean);
    return times.length ? Math.min(...times) : null;
  })();

  // Item 9's source+title join both lanes share — one fetch set covers every
  // proposal on screen (pending + approved).
  const itemIds = [...proposals, ...approvedProposals, ...(rejectedData?.proposals || [])].map((p) => p.item_id);
  const itemsById = useItemsByIds(itemIds);

  const [handingOffIds, setHandingOffIds] = useState(() => new Set());

  /* Lanes, not one long page. Approved proposals used to sit in a section BELOW the whole
     pending queue, so with ten pending you never saw them and the approved work had
     nowhere to live. Approved is the lane you act from, so it gets equal billing.
     SIGNAL-PIPELINE: the lane lives in the URL (?lane=) so the pipeline bar's
     Proposals/Deepen/Discuss stations deep-link straight into it. */
  const [searchParams, setSearchParams] = useSearchParams();
  // SIGNAL-RETHINK (owner, 2026-09-18): Approved MEANS submitted to QuoxPlan.
  // Deepen and Discuss & Improve are optional verbs on any queued proposal,
  // not stations you must pass through. Two lanes: Queue (pending + approved
  // stragglers not yet on the roadmap) and Done (on roadmap / rejected).
  // Legacy ?lane=pending/approved deep links resolve to the queue.
  const lane = searchParams.get('lane') === 'done' ? 'done' : 'queue';
  const setLane = useCallback((next) => {
    const p = new URLSearchParams(searchParams);
    p.set('lane', next);
    setSearchParams(p, { replace: true });
  }, [searchParams, setSearchParams]);

  // SIGNAL-REDESIGN filters: free-text search + source + finding kind,
  // applied client-side to the active lane (both lists are small and already
  // in memory — a server round-trip per keystroke would be worse).
  const [filters, setFilters] = useState({ q: '', source: '', kind: '' });
  const rejectedProposals = rejectedData?.proposals || [];
  const queueProposals = useMemo(() => [
    ...proposals,
    ...approvedProposals.filter((p) => p.handoff_state !== 'submitted'),
  ], [proposals, approvedProposals]);
  const doneProposals = useMemo(() => [
    ...approvedProposals.filter((p) => p.handoff_state === 'submitted'),
    ...rejectedProposals,
  ], [approvedProposals, rejectedProposals]);
  const laneProposals = lane === 'queue' ? queueProposals : doneProposals;
  const sourceOptions = useMemo(() => {
    const s = new Set();
    for (const p of [...proposals, ...approvedProposals]) {
      const item = itemsById.get(p.item_id);
      s.add(item?.source_label || p.author || p.platform || 'unknown');
    }
    return [...s].sort();
  }, [proposals, approvedProposals, itemsById]);
  const kindOptions = useMemo(() => {
    const s = new Set();
    for (const p of [...proposals, ...approvedProposals]) {
      for (const f of p.proposals || []) if (f.kind) s.add(f.kind);
    }
    return [...s].sort();
  }, [proposals, approvedProposals]);
  const visibleProposals = useMemo(() => {
    const needle = filters.q.trim().toLowerCase();
    return laneProposals.filter((p) => {
      const item = itemsById.get(p.item_id);
      const source = item?.source_label || p.author || p.platform || 'unknown';
      if (filters.source && source !== filters.source) return false;
      if (filters.kind && !(p.proposals || []).some((f) => f.kind === filters.kind)) return false;
      if (needle) {
        const hay = [item?.title, p.summary, p.author, source, ...(p.proposals || []).map((f) => f.title)]
          .filter(Boolean).join('\n').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [laneProposals, filters, itemsById]);
  const hiddenByFilters = laneProposals.length - visibleProposals.length;

  /* SIGNAL-PERF: expandedIds is the current show/hide toggle state (removing an id hides its
     details panel). everExpandedIds only ever grows — it is what actually gates the
     evidence-bundle fetch (inside EvidenceTrail), the full-item/transcript fetch (below) and
     the enrichments fetch, so once a card has been opened once its data stays fetched/cached
     and collapsing + re-expanding never re-fires any request. */
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [everExpandedIds, setEverExpandedIds] = useState(() => new Set());
  const toggleExpanded = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setEverExpandedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // Full item (with transcript segments) per expanded card — see useDetailedItems.
  const proposalsById = useMemo(
    () => new Map([...proposals, ...approvedProposals].map((p) => [p.id, p])),
    [proposals, approvedProposals]
  );
  const detailedItems = useDetailedItems(everExpandedIds, proposalsById);
  const detailItemFor = useCallback(
    (proposal) => detailedItems.get(proposal.item_id) || itemsById.get(proposal.item_id),
    [detailedItems, itemsById]
  );

  /* Enrichment history only ever renders in the approved lane, so only an approved proposal's
     id being expanded is worth a listEnrichments call — expanding a pending card's details
     has no enrichment history to show and must not fire this request. */
  const approvedIdSet = useMemo(() => new Set(approvedProposals.map((p) => p.id)), [approvedProposals]);
  const enrichmentIds = useMemo(
    () => [...everExpandedIds].filter((id) => approvedIdSet.has(id)),
    [everExpandedIds, approvedIdSet]
  );
  const { append: appendEnrichment, forProposal: enrichmentsFor } = useEnrichments(enrichmentIds);
  // Keyed by proposal id -> the last handoff response (drafted payload, handoff_state,
  // handoff_ref, handoff_error). Overlaid on top of whatever the list fetch returned,
  // so a preview or submit updates the card immediately without waiting on a refetch.
  const [handoffResults, setHandoffResults] = useState(() => new Map());

  const runHandoff = useCallback(
    async (id, dryRun) => {
      setHandingOffIds((prev) => new Set(prev).add(id));
      try {
        const result = await api.handoffProposal(id, dryRun);
        setHandoffResults((prev) => new Map(prev).set(id, result));
        if (!dryRun && result?.handoff_state === 'submitted') retryApproved();
      } catch (e) {
        const result = e.body || { handoff_state: 'failed', handoff_error: e.message };
        setHandoffResults((prev) => new Map(prev).set(id, result));
      } finally {
        setHandingOffIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [retryApproved]
  );

  /* SIGNAL-RETHINK: "Approve to QuoxPlan" is ONE act. For a pending
     proposal it records the approval decision, then immediately drafts the
     roadmap entry (dry-run) for review; Submit writes it. For an approved
     straggler it goes straight to the draft. A cancel/abandon after the
     decision leaves an approved-unsubmitted proposal, which stays in the
     Queue with the same button — nothing is ever stranded off-screen. */
  const approveToPlan = useCallback(async (proposal) => {
    setDecidingIds((prev) => new Set(prev).add(proposal.id));
    try {
      if ((proposal.status ?? 'pending') === 'pending') {
        await api.decideProposal(proposal.id, 'approved');
      }
      await runHandoff(proposal.id, true);
      retry({ force: true, silent: true });
      retryApproved({ force: true, silent: true });
    } finally {
      setDecidingIds((prev) => {
        const next = new Set(prev);
        next.delete(proposal.id);
        return next;
      });
    }
  }, [runHandoff, retry, retryApproved]);

  const decide = useCallback(
    async (id, status) => {
      setDecidingIds((prev) => new Set(prev).add(id));
      try {
        await api.decideProposal(id, status);
        retry();
      } finally {
        setDecidingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [retry]
  );

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={6}>
      <div className="qx-row" style={{ alignItems: 'stretch', gap: 16 }}>
        <div className="qx-stack" style={{ flex: 1, minWidth: 0 }}>

          {/* Scoreboard: where the funnel stands, before any card. */}
          <div className="qx-card qx-card--compact" data-testid="signal-proposal-stats">
            <div className="qx-grid-4">
              <Stat label="Queue" value={queueProposals.length} sub="awaiting your call" />
              <Stat label="Deepened" value={pipelineStats?.proposals?.awaiting_discussion ?? '–'} sub="research added, not yet shipped" />
              <Stat label="On roadmap" value={handedOffCount} sub="approved into QuoxPlan" />
              <Stat label="Rejected" value={rejectedCount ?? '–'} sub="closed, kept for the record" />
            </div>
          </div>

          <div className="qx-row qx-row--apart">
            <div className="qx-tabs" role="tablist" aria-label="Proposal lanes">
              <button
                type="button"
                role="tab"
                aria-selected={lane === 'queue'}
                className={`qx-tab${lane === 'queue' ? ' qx-tab--active' : ''}`}
                onClick={() => setLane('queue')}
              >
                Queue <span className="qx-chip qx-chip--xs">{queueProposals.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={lane === 'done'}
                className={`qx-tab${lane === 'done' ? ' qx-tab--active' : ''}`}
                onClick={() => setLane('done')}
              >
                Done <span className="qx-chip qx-chip--xs">{doneProposals.length}</span>
              </button>
            </div>
            <RefreshControl onRefresh={refreshTab} loading={tabRefreshing} updatedAt={tabUpdatedAt} />
          </div>

          {/* Filters: search, source, finding kind. Client-side, instant.
              One glass bar, nowrap (same treatment as the Feed's filter
              strip — bare controls on the cinematic read as flat/messy). */}
          <div className="qx-card qx-card--bar">
          <div className="qx-row qx-row--tight" role="group" aria-label="Proposal filters" style={{ flexWrap: 'nowrap', alignItems: 'center', overflowX: 'auto' }}>
            <div className="qx-search-wrap" style={{ maxWidth: 260 }}>
              <span className="qx-search-wrap__icon" aria-hidden="true">⌕</span>
              <input
                type="text"
                className="qx-input"
                placeholder="Search title, summary, findings…"
                aria-label="Search proposals"
                value={filters.q}
                onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              />
            </div>
            <select
              className="qx-select qx-select--auto"
              aria-label="Filter by source"
              value={filters.source}
              onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))}
            >
              <option value="">All sources</option>
              {sourceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              className="qx-select qx-select--auto"
              aria-label="Filter by finding kind"
              value={filters.kind}
              onChange={(e) => setFilters((f) => ({ ...f, kind: e.target.value }))}
            >
              <option value="">All kinds</option>
              {kindOptions.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {hiddenByFilters > 0 && (
              <span className="qx-hint qx-hint--sm" style={{ whiteSpace: 'nowrap' }}>{hiddenByFilters} hidden by filters</span>
            )}
          </div>
          </div>

          {lane === 'queue' && (visibleProposals.length === 0 ? (
            <div className="qx-empty">
              <div className="qx-empty__title">
                {queueProposals.length === 0 ? 'Queue is clear' : 'Nothing in the queue matches these filters'}
              </div>
              {queueProposals.length === 0 && (
                <div className="qx-empty__body">
                  Analyse items in the feed and SCOUT drafts proposals here. Approve to QuoxPlan
                  is the final act; Deepen and Discuss &amp; Improve are optional before it.
                </div>
              )}
            </div>
          ) : (
            <div className="qx-stack">
              {visibleProposals.map((proposal) => {
                const busy = handingOffIds.has(proposal.id) || decidingIds.has(proposal.id);
                const item = itemsById.get(proposal.item_id);
                const detailItem = detailItemFor(proposal);
                const result = handoffResults.get(proposal.id);
                const payload = result?.payload;
                const handoffError = result?.handoff_error ?? proposal.handoff_error;
                const submittedNow = (result?.handoff_state ?? proposal.handoff_state) === 'submitted';

                return (
                  <div key={proposal.id} className="qx-card qx-stack qx-stack--compact" data-testid="signal-proposal-card">
                    <ProposalHeader proposal={proposal} item={item} />

                    <EditableSummary proposal={proposal} onSaved={refreshTab} />

                    <div className="qx-divider qx-divider--dense" />

                    {submittedNow ? (
                      <div className="qx-banner qx-banner--success">Approved into QuoxPlan{result?.handoff_ref ? `: ${result.handoff_ref}` : ''}</div>
                    ) : (
                      <>
                        {/* The verbs, in the owner's model: one terminal act
                            (Approve to QuoxPlan = decision + drafted entry +
                            submit), two OPTIONAL refinements before it. */}
                        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
                          <div className="qx-row qx-row--tight">
                            <DeepenButton proposal={proposal} allItems={[...itemsById.values()]} detailItem={detailItem} onEnriched={(entry) => appendEnrichment(proposal.id, entry)} />
                            <DiscussButton proposal={proposal} onDiscuss={discussProposal} />
                          </div>
                          <div className="qx-row qx-row--tight">
                            {(proposal.status ?? 'pending') === 'pending' && (
                              <button
                                type="button"
                                className="qx-btn qx-btn--ghost"
                                disabled={busy}
                                onClick={() => decide(proposal.id, 'rejected')}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, marginRight: 6 }}><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                                Reject
                              </button>
                            )}
                            <button
                              type="button"
                              className="qx-btn qx-btn--primary"
                              disabled={busy}
                              data-testid={`signal-approve-${proposal.id}`}
                              onClick={() => approveToPlan(proposal)}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, marginRight: 6 }}><path d="M9 12l2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
                              {busy ? (<><span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" /> Working…</>) : payload ? 'Redraft entry' : 'Approve to QuoxPlan'}
                            </button>
                          </div>
                        </div>

                        {payload && (
                          <div className="qx-stack qx-stack--tight" data-testid={`signal-handoff-preview-${proposal.id}`}>
                            <div className="qx-divider qx-divider--dense" />
                            <span className="qx-section-title">Drafted QuoxPlan entry — review, then submit</span>
                            <strong>{payload.name}</strong>
                            <span className="qx-hint qx-hint--sm">
                              tier {payload.tier} · tags: {(payload.tags || []).join(', ')} · effort: {payload.effort || 'unset'}
                            </span>
                            <p className="qx-hint" style={{ whiteSpace: 'pre-wrap' }}>{payload.summary}</p>
                            <div className="qx-row qx-row--end qx-row--tight">
                              <button
                                type="button"
                                className="qx-btn qx-btn--sm qx-btn--primary"
                                disabled={busy}
                                data-testid={`signal-submit-${proposal.id}`}
                                onClick={() => runHandoff(proposal.id, false)}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, marginRight: 6 }}><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></svg>
                                Submit to QuoxPlan
                              </button>
                            </div>
                          </div>
                        )}

                        {handoffError && <div className="qx-banner qx-banner--error">{handoffError}</div>}

                        {enrichmentsFor(proposal.id).map((e, i) => {
                          const body = e.body || e;
                          return (
                            <div key={e.id || body.at || i} className="qx-stack qx-stack--tight">
                              <div className="qx-divider qx-divider--dense" />
                              <span className="qx-section-title">Deepened research</span>
                              <span className="qx-hint qx-hint--sm">
                                {new Date(e.created_at || body.at).toLocaleString()}
                                {body.related?.length
                                  ? ` · drew on ${body.related.length} related item(s)`
                                  : ' · nothing related in the corpus'}
                              </span>
                              <p className="qx-hint" style={{ whiteSpace: 'pre-wrap' }}>{body.text}</p>
                            </div>
                          );
                        })}
                      </>
                    )}

                    <ProposalDetails
                      proposal={proposal}
                      item={detailItem}
                      expanded={expandedIds.has(proposal.id)}
                      everExpanded={everExpandedIds.has(proposal.id)}
                      onToggle={() => toggleExpanded(proposal.id)}
                    />
                  </div>
                );
              })}
            </div>
          ))}

          {lane === 'done' && (visibleProposals.length === 0 ? (
            <div className="qx-empty">
              <div className="qx-empty__title">Nothing finished yet</div>
              <div className="qx-empty__body">
                Approving a proposal into QuoxPlan, or rejecting one, files it here for the record.
              </div>
            </div>
          ) : (
            <div className="qx-stack">
              {visibleProposals.map((proposal) => {
                const item = itemsById.get(proposal.item_id);
                const rejected = proposal.status === 'rejected';
                return (
                  <div key={proposal.id} className="qx-card qx-stack qx-stack--compact" data-testid="signal-proposal-card">
                    <ProposalHeader proposal={proposal} item={item} />
                    {proposal.summary && <p style={{ margin: 0 }}>{proposal.summary}</p>}
                    {rejected ? (
                      <div className="qx-banner">Rejected{proposal.decided_by ? ` by ${proposal.decided_by}` : ''}{proposal.decided_at ? ` · ${relativeTime(proposal.decided_at)}` : ''}</div>
                    ) : (
                      <div className="qx-banner qx-banner--success">On the roadmap{proposal.handoff_ref ? `: ${proposal.handoff_ref}` : ''}</div>
                    )}
                    <ProposalDetails
                      proposal={proposal}
                      item={detailItemFor(proposal)}
                      expanded={expandedIds.has(proposal.id)}
                      everExpanded={everExpandedIds.has(proposal.id)}
                      onToggle={() => toggleExpanded(proposal.id)}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{ width: scoutCollapsed ? 48 : 320, flexShrink: 0 }}>
          <ScoutChatSidebar
            surface="proposals"
            proposals={queueProposals}
            focusProposal={focusProposal}
            collapsed={scoutCollapsed}
            onToggle={() => setScoutCollapsed((v) => !v)}
          />
        </div>
      </div>
    </AsyncBoundary>
  );
}

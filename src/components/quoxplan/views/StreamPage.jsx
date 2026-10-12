import { useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { relativeTime } from '../lib/format.js';
import { useEditMode } from '../context/EditModeContext.jsx';
import { useRoadmapCtx } from '../context/RoadmapContext.jsx';
import { toastApiError } from '../lib/toastBus.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import { StatusRead, TierChip, ScopeChip } from '../components/Chips.jsx';
import { StatusMenu, TierMenu, ScopeMenu } from '../components/EditableChips.jsx';
import InlineEdit from '../components/InlineEdit.jsx';
import TagEditor from '../components/TagEditor.jsx';
import PhaseEditor from '../components/PhaseEditor.jsx';
import NoteComposer from '../components/NoteComposer.jsx';
import DependencyEditor from '../components/DependencyEditor.jsx';
import PlanSection from '../components/PlanSection.jsx';
import ConfirmCompleteDialog from '../components/ConfirmCompleteDialog.jsx';
import ActionItemsCard from '../components/ActionItemsCard.jsx';

function PhaseChecklist({ phases }) {
  if (!phases || phases.length === 0) {
    return <span className="qx-hint">No phases recorded for this stream yet.</span>;
  }
  return (
    <ul className="qxp-phase-list">
      {phases.map((p) => (
        <li key={p.id} className="qxp-phase-list__item">
          <span className={`qxp-phase-check${p.status === 'DONE' ? ' qxp-phase-check--done' : ''}`}>
            {p.status === 'DONE' ? '✓' : ''}
          </span>
          <span style={{ opacity: p.status === 'DONE' ? 0.75 : 1 }}>{p.title}</span>
          {p.status === 'DONE' && p.done_at && (
            <span className="qx-hint qx-hint--sm">
              done <span className="qxp-mono">{relativeTime(p.done_at)}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function DependencyList({ title, items, emptyLabel }) {
  return (
    <div className="qx-stack qx-stack--tight">
      {title && <span className="qx-section-title">{title}</span>}
      {items.length === 0 && <span className="qx-hint qx-hint--sm">{emptyLabel}</span>}
      {items.map((d) => (
        <Link key={d.id} to={`/quoxplan/streams/${d.id}`} className="qx-row qx-row--apart" style={{ textDecoration: 'none' }}>
          <span className="qx-hint qx-hint--sm truncate" style={{ maxWidth: 180 }}>
            {d.name}
          </span>
          <StatusRead status={d.status} size={12} />
        </Link>
      ))}
    </div>
  );
}

function NotesTimeline({ notes }) {
  if (!notes || notes.length === 0) return <span className="qx-hint qx-hint--sm">No notes yet.</span>;
  return (
    <div className="qxp-notes-timeline">
      {notes.map((n) => (
        <div key={n.id} className="qxp-note">
          <div className="qx-row qx-row--apart">
            <strong style={{ fontSize: 'var(--m-text-sm)' }}>{n.author}</strong>
            <span className="qx-hint qx-hint--sm qxp-mono">{relativeTime(n.created_at)}</span>
          </div>
          <p style={{ margin: '4px 0 0', color: 'var(--m-text-secondary)' }}>{n.body}</p>
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({ events }) {
  if (!events || events.length === 0) return <span className="qx-hint qx-hint--sm">No activity recorded.</span>;
  return (
    <div className="qx-scroll-list qx-stack qx-stack--tight">
      {events.slice(0, 20).map((e) => (
        <div key={e.id} className="qx-row qx-row--apart">
          <span style={{ fontSize: 'var(--m-text-sm)' }}>
            {e.verb} <span className="qx-hint qx-hint--sm">by {e.actor}</span>
          </span>
          <span className="qx-hint qx-hint--sm qxp-mono">{relativeTime(e.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

export default function StreamPage() {
  const { streamId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { editMode } = useEditMode();
  const { scopeOptions } = useRoadmapCtx();
  const noteComposerRef = useRef(null);

  const { loading, error, data, retry } = useAsync(() => api.getStream(streamId), [streamId]);

  const backTarget = useMemo(() => {
    if (location.state?.from) return location.state.from;
    if (data?.stream?.roadmap_id) return `/quoxplan/${data.stream.roadmap_id}/board`;
    return '/quoxplan';
  }, [location.state, data]);

  return (
    <div className="qx-view qx-stack">
      <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" style={{ alignSelf: 'flex-start' }} onClick={() => navigate(backTarget)}>
        ← Back
      </button>

      <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={10}>
        {data && (
          <StreamDetail
            detail={data}
            editMode={editMode}
            scopeOptions={scopeOptions}
            onRefetch={retry}
            noteComposerRef={noteComposerRef}
          />
        )}
      </AsyncBoundary>
    </div>
  );
}

function StreamDetail({ detail, editMode, scopeOptions, onRefetch, noteComposerRef }) {
  const { stream, phases, plan, notes, events, depends_on: dependsOn, dependents } = detail;
  const [confirmingComplete, setConfirmingComplete] = useState(false);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);

  async function patch(fields, errorTitle = 'Update failed') {
    try {
      await api.patchStream(stream.id, fields);
      await onRefetch();
    } catch (err) {
      toastApiError(err, errorTitle);
    }
  }

  async function handleConfirmComplete() {
    setCompleteBusy(true);
    try {
      await api.patchStream(stream.id, { status: 'COMPLETE', confirm_owner: true });
      setConfirmingComplete(false);
      await onRefetch();
    } catch (err) {
      toastApiError(err, 'Could not mark complete');
    } finally {
      setCompleteBusy(false);
    }
  }

  function handleAddDependency(depId) {
    patch({ depends_on: [...(stream.depends_on || []), depId] }, 'Could not add dependency');
  }

  function handleRemoveDependency(depId) {
    patch({ depends_on: (stream.depends_on || []).filter((id) => id !== depId) }, 'Could not remove dependency');
  }

  async function handleAddNote(body) {
    setNoteBusy(true);
    try {
      await api.addNote(stream.id, body);
      await onRefetch();
    } catch (err) {
      toastApiError(err, 'Note failed to send');
      throw err;
    } finally {
      setNoteBusy(false);
    }
  }

  async function phaseMutate(fn, errorTitle) {
    try {
      await fn();
      await onRefetch();
    } catch (err) {
      toastApiError(err, errorTitle);
    }
  }

  return (
    <>
      <div className="qx-card">
        <div className="qx-stack qx-stack--tight">
          <div className="qx-row qx-row--apart">
            <div className="qx-row qx-row--tight" style={{ alignItems: 'baseline' }}>
              <span className="qx-hint qxp-mono">{stream.id}</span>
              {editMode ? (
                <InlineEdit
                  tag="h1"
                  style={{ margin: 0 }}
                  value={stream.name}
                  onSave={(name) => name && patch({ name }, 'Rename failed')}
                  placeholder="Stream name"
                />
              ) : (
                <h1 style={{ margin: 0 }}>{stream.name}</h1>
              )}
            </div>
            <div className="qx-row qx-row--tight">
              {editMode ? (
                <>
                  <TierMenu tier={stream.tier} onChange={(tier) => patch({ tier }, 'Tier update failed')} />
                  <StatusMenu
                    status={stream.status}
                    onChange={(status) => patch({ status }, 'Status update failed')}
                    onRequestComplete={() => setConfirmingComplete(true)}
                  />
                  {scopeOptions.length > 0 && (
                    <ScopeMenu
                      scope={stream.assignee_scope}
                      options={scopeOptions}
                      onChange={(assignee_scope) => patch({ assignee_scope }, 'Scope update failed')}
                    />
                  )}
                </>
              ) : (
                <>
                  <TierChip tier={stream.tier} />
                  <StatusRead status={stream.status} size={16} />
                  <ScopeChip scope={stream.assignee_scope} />
                </>
              )}
            </div>
          </div>

          {editMode ? (
            <InlineEdit
              multiline
              tag="p"
              style={{ margin: 0, color: 'var(--m-text-secondary)' }}
              value={stream.summary}
              onSave={(summary) => patch({ summary }, 'Summary update failed')}
              placeholder="Add a summary…"
            />
          ) : (
            stream.summary && <p style={{ margin: 0, color: 'var(--m-text-secondary)' }}>{stream.summary}</p>
          )}

          <div className="qx-row qx-row--wrap qx-row--tight">
            <span className="qx-chip qx-chip--xs">
              priority <span className="qxp-mono">{stream.priority}</span>
            </span>
            {editMode ? (
              <InlineEdit
                tag="span"
                className="qx-chip qx-chip--xs"
                value={stream.effort}
                onSave={(effort) => patch({ effort }, 'Effort update failed')}
                placeholder="effort label"
              />
            ) : (
              stream.effort && <span className="qx-chip qx-chip--xs qxp-mono">{stream.effort}</span>
            )}
            {editMode && (
              <InlineEdit
                tag="span"
                className="qx-chip qx-chip--xs"
                value={stream.effort_days != null ? `${stream.effort_days}d` : ''}
                onSave={(v) => {
                  const days = Number(v.replace(/[^0-9.]/g, ''));
                  if (Number.isFinite(days) && days > 0) patch({ effort_days: days }, 'Effort days update failed');
                }}
                placeholder="effort days"
              />
            )}
            {!editMode &&
              (stream.tags || []).map((t) => (
                <span key={t} className="qx-chip qx-chip--xs">
                  {t}
                </span>
              ))}
          </div>
          {editMode && (
            <TagEditor tags={stream.tags || []} onChange={(tags) => patch({ tags }, 'Tags update failed')} />
          )}
        </div>
      </div>

      <div className="qx-card">
        <h3 style={{ marginTop: 0 }}>Phases</h3>
        {editMode ? (
          <PhaseEditor
            phases={phases}
            onToggleDone={(p) =>
              phaseMutate(() => api.updatePhase(stream.id, p.id, { status: p.status === 'DONE' ? 'TODO' : 'DONE' }), 'Phase update failed')
            }
            onSetStatus={(p, status) => phaseMutate(() => api.updatePhase(stream.id, p.id, { status }), 'Phase update failed')}
            onRename={(p, title) => title && phaseMutate(() => api.updatePhase(stream.id, p.id, { title }), 'Phase rename failed')}
            onDelete={(p) => phaseMutate(() => api.deletePhase(stream.id, p.id), 'Phase delete failed')}
            onAdd={(title) => phaseMutate(() => api.addPhase(stream.id, title), 'Could not add phase')}
          />
        ) : (
          <PhaseChecklist phases={phases} />
        )}
      </div>

      <ActionItemsCard streamId={stream.id} editMode={editMode} />

      <div className="qxp-stream-layout">
        <PlanSection streamId={stream.id} plan={plan} editMode={editMode} onSaved={onRefetch} />

        <div className="qx-stack">
          <div className="qx-card qx-card--compact">
            <div className="qx-stack qx-stack--tight">
              <span className="qx-section-title">Blocked by</span>
              {editMode ? (
                <DependencyEditor
                  roadmapId={stream.roadmap_id}
                  streamId={stream.id}
                  items={dependsOn}
                  onAdd={handleAddDependency}
                  onRemove={handleRemoveDependency}
                />
              ) : (
                <DependencyList title={null} items={dependsOn} emptyLabel="No dependencies." />
              )}
            </div>
          </div>
          <div className="qx-card qx-card--compact">
            <DependencyList title="Blocks" items={dependents} emptyLabel="Nothing depends on this stream." />
          </div>
          <div className="qx-card qx-card--compact">
            <h4 style={{ marginTop: 0 }}>Notes</h4>
            {editMode && (
              <div style={{ marginBottom: 12 }}>
                <NoteComposer ref={noteComposerRef} onSubmit={handleAddNote} busy={noteBusy} />
              </div>
            )}
            <NotesTimeline notes={notes} />
          </div>
          <details className="qx-disclosure">
            <summary className="qx-disclosure__head">
              <span className="qx-disclosure__chev">▸</span>
              Activity ({events.length})
            </summary>
            <div className="qx-disclosure__body">
              <ActivityFeed events={events} />
            </div>
          </details>
        </div>
      </div>

      {confirmingComplete && (
        <ConfirmCompleteDialog
          streamName={stream.name}
          busy={completeBusy}
          onConfirm={handleConfirmComplete}
          onCancel={() => setConfirmingComplete(false)}
        />
      )}
    </>
  );
}

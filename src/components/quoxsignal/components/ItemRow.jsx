import { actionLabelFor, cardStatus, stagePillVariant } from '../lib/stage.js';
import { formatCost } from '../lib/cost.js';
import { formatDuration, relativeTime, splitTitle } from '../lib/format.js';
import Avatar from './Avatar.jsx';
import StageTrack from './StageTrack.jsx';
import ThumbnailCell from './ThumbnailCell.jsx';

/**
 * One list row, one primary action — the "one-card-one-button" UX carried
 * over from the standalone app's ItemCard.jsx, rebuilt as a `.qx-table` row
 * (the dashboard's own list primitive) instead of the bespoke `.qs-item-card`
 * CSS the standalone app used. `.qx-table__row--active` gives the keyboard
 * cursor its highlight for free — no bespoke CSS needed.
 *
 * The button's label and cost are implied entirely by the item's stage —
 * there is deliberately no row of checkboxes for the six-ish things that
 * could happen to an item. The button must also tell the truth about what
 * has actually happened server-side: requesting a stage (POST /stage) no
 * longer completes it, so idle/working/queued/failed are four distinct,
 * visibly different states — see lib/stage.js's cardStatus().
 *
 * SIGNAL-UX: the primary action stays a single button (six-checkbox rows
 * were explicitly rejected by the owner earlier), but View and Discard are
 * now reachable as a `.qx-row-actions` icon cluster next to it — hover-
 * revealed, same pattern the design system already defines, rather than
 * buried in a menu.
 */
export default function ItemRow({
  item, source, focused, selected, unread, discarded,
  onToggleSelect, onAdvance, onOpen, onDiscard, onUndiscard, advancing,
  // SIGNAL-PIPELINE alignment: false on single-stage station views, where a
  // stage cell per row repeats what the pipeline bar already states.
  showStage = true,
}) {
  const label = actionLabelFor(item.stage);
  const isTerminal = label === null;
  const status = cardStatus(item, { advancing });
  const disabled = status === 'working' || status === 'queued';

  function handleActionClick(e) {
    e.stopPropagation();
    if (disabled) return;
    if (isTerminal) {
      onOpen(item);
    } else {
      onAdvance(item);
    }
  }

  function handleDiscardClick(e) {
    e.stopPropagation();
    if (discarded) onUndiscard(item.id);
    else onDiscard(item.id);
  }

  function buttonText() {
    if (status === 'working' || status === 'queued') {
      // A worker owns the item right now — show motion, not a static label
      // (owner, 2026-09-19: "'workin...' could use a loading wheel").
      return (
        <>
          <span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" />
          {status === 'working' ? 'Working…' : 'Queued'}
        </>
      );
    }
    return isTerminal ? 'View' : `${label} · ${formatCost(item.duration_s)}`;
  }

  return (
    <tr
      className={`qx-table__row${focused ? ' qx-table__row--active' : ''}`}
      onClick={() => onOpen(item)}
      data-item-id={item.id}
      data-testid="signal-item-row"
    >
      <td onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="qx-checkbox"
          checked={Boolean(selected)}
          onChange={() => onToggleSelect(item)}
          aria-label={`Select ${item.title || item.id}`}
        />
      </td>
      <td>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          {/* Prefer the joined source record: the item serializer carries neither the
              avatar flag nor the monogram, so reading them off the item alone always
              rendered the "?" fallback. */}
          <Avatar
          platform={item?.platform}
            sourceId={source?.id || item.source_id}
            hasAvatar={source?.has_avatar ?? item.has_avatar}
            monogram={source?.monogram || item.monogram}
            monogramColor={source?.monogram_color || item.monogram_color}
            size="xs"
          />
          <span className="qx-mono">{item.source_label || item.platform}</span>
        </div>
      </td>
      <td>
        <ThumbnailCell itemId={item.id} hasThumbnail={item.has_thumbnail} platform={item.platform} />
      </td>
      <td>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          {unread && <span className="qx-dot qx-dot--info qx-dot--sm" aria-hidden="true" title="Unread" />}
          {(() => {
            /* Substance bold, hashtag tail demoted. The eye should land on the claim, not
               on a wall of tags that every row repeats. */
            const { head, tags } = splitTitle(item.title || item.id);
            return (
              <span>
                <strong>{head || item.id}</strong>
                {tags && (
                  <span style={{ color: 'rgba(255,255,255,0.55)', marginLeft: 6, fontWeight: 400 }}>{tags}</span>
                )}
              </span>
            );
          })()}
          {item.text_native && (
            /* Text arrived with the entry (JSON/web feed) — no ASR ran, no
               spend. Without this badge a CISA row reads as a transcription. */
            <span className="qx-pill qx-pill--xs" title="Text-native: the source supplied this text, no transcription ran" data-testid="signal-text-native-pill">
              TEXT
            </span>
          )}
        </div>
        {status === 'failed' && (
          <div className="qx-hint qx-hint--danger" role="alert">{item.stage_error}</div>
        )}
      </td>
      {showStage && <td><StageTrack stage={item.stage} /></td>}
      <td>{relativeTime(item.published_at || item.discovered_at)}</td>
      <td className="qx-num">{formatDuration(item.duration_s)}</td>
      <td onClick={(e) => e.stopPropagation()}>
        <div className="qx-row qx-row--tight qx-row--end" style={{ flexWrap: 'nowrap' }}>
          {/* opacity 1 override: the design system's 0.6 resting opacity made
              these 14px outline icons effectively invisible on the dark theme
              (SIGNAL-AUDIT 2026-09-18, owner could not find Discard at all). */}
          <div className="qx-row-actions" style={{ opacity: 1 }}>
            <button
              type="button"
              className="qx-row-action"
              title="View"
              aria-label={`View ${item.title || item.id}`}
              onClick={() => onOpen(item)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button
              type="button"
              className="qx-row-action"
              title={discarded ? 'Restore (undo discard)' : 'Not interested — discard from this view'}
              aria-label={discarded ? `Restore ${item.title || item.id}` : `Discard ${item.title || item.id}`}
              data-testid="signal-item-discard"
              onClick={handleDiscardClick}
            >
              {discarded ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 3v5h5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 8v13H3V8" />
                  <path d="M1 3h22v5H1z" />
                  <path d="M10 12h4" />
                </svg>
              )}
            </button>
          </div>
          <button
            type="button"
            className={`qx-btn qx-btn--sm${isTerminal ? ' qx-btn--ghost' : ' qx-btn--primary'}`}
            onClick={handleActionClick}
            disabled={disabled}
            data-testid="signal-item-action"
          >
            {buttonText()}
          </button>
        </div>
      </td>
    </tr>
  );
}

import { useState } from 'react';
import { isHealthBad, isStalePoll, healthLabel } from '../lib/health.js';
import { api } from '../lib/api.js';
import Avatar from './Avatar.jsx';
import AutonomyControl from './AutonomyControl.jsx';

/**
 * Source health must never be buried — a bad source (error, empty,
 * needs-cookies) gets a danger pill, not a quiet label next to everything
 * else. Rebuilt as a `.qx-table` row instead of the standalone app's
 * bespoke `.qs-source-row` CSS.
 *
 * SIGNAL-UX item 5: this row used to be read-only. It now owns editing the
 * label, changing autonomy (via AutonomyControl's raise-confirm), and
 * removing the source — the "manage what exists" half of the gap the owner
 * called out (adding was the other half, see AddSourceForm.jsx).
 */
export default function SourceRow({ source, onChanged }) {
  const bad = isHealthBad(source.health);
  /* "ok" alone is not trustworthy: a source can report healthy and silently never fire.
     A stale last_polled must not wear the same confident green as a working one. */
  const stale = !bad && isStalePoll(source.last_polled);
  const dotClass = bad ? 'qx-dot--offline' : stale ? 'qx-dot--idle' : source.health === 'ok' ? 'qx-dot--online' : 'qx-dot--idle';
  const pillClass = bad ? 'qx-pill--offline' : stale ? 'qx-pill--ghost' : source.health === 'ok' ? 'qx-pill--online' : 'qx-pill--ghost';

  const [editing, setEditing] = useState(false);
  const [labelInput, setLabelInput] = useState(source.label);
  const [busy, setBusy] = useState(false);

  async function saveLabel() {
    const next = labelInput.trim();
    if (!next || next === source.label) {
      setEditing(false);
      setLabelInput(source.label);
      return;
    }
    setBusy(true);
    try {
      await api.patchSource(source.id, { label: next });
      setEditing(false);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  async function patchAutonomy(patch) {
    await api.patchSource(source.id, patch);
    onChanged?.();
  }

  async function remove() {
    // eslint-disable-next-line no-alert -- a real confirm dialog, not a toast: unfollowing is easy to undo (follow again) but should never be one misclick.
    if (!window.confirm(`Stop following ${source.label}?`)) return;
    // Second question, separately: what happens to its feed items. Purge only
    // touches UNPROCESSED (discovered) items — transcripts, analyses and
    // proposals always survive server-side.
    // eslint-disable-next-line no-alert
    const purge = window.confirm(`Also remove ${source.label}'s unprocessed feed items?\n\nOK = remove them (transcribed/analysed items are kept)\nCancel = keep everything in the feed`);
    setBusy(true);
    try {
      await api.deleteSource(source.id, purge ? { purge: 'discovered' } : {});
      onChanged?.();
    } catch (err) {
      // The old handler swallowed this, so a failing delete looked like a
      // dead button (2026-09-18: every delete 500'd on a foreign key and
      // nobody saw an error). Never fail silently again.
      // eslint-disable-next-line no-alert
      window.alert(`Could not remove ${source.label}: ${err?.payload?.error || err?.message || 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="qx-table__row" data-source-id={source.id} data-testid="signal-source-row">
      <td><span className={`qx-dot ${dotClass}`} aria-hidden="true" /></td>
      <td>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <Avatar
          platform={source?.platform}
            sourceId={source.id}
            hasAvatar={source.has_avatar}
            monogram={source.monogram}
            monogramColor={source.monogram_color}
            size="sm"
          />
          {/* The label button is deliberately NOT .qx-row-action: that class is a fixed
              28px icon button, so a text label got squeezed to icon width and overflowed
              across the avatar. A label that opens an editor is a text affordance. */}
          {editing ? (
            <input
              type="text"
              className="qx-input qx-input--narrow"
              aria-label={`Edit label for ${source.label}`}
              value={labelInput}
              disabled={busy}
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveLabel();
                if (e.key === 'Escape') { setEditing(false); setLabelInput(source.label); }
              }}
              onBlur={saveLabel}
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--ghost qxs-source-label"
              title="Edit label"
              onClick={() => setEditing(true)}
            >
              <strong>{source.label}</strong>
            </button>
          )}
        </div>
      </td>
      <td className="qx-mono">{source.platform}</td>
      <td>{source.kind}</td>
      <td>
        <AutonomyControl source={source} onPatch={patchAutonomy} disabled={busy} />
      </td>
      <td>
        <span
          className={`qx-pill ${pillClass} qx-pill--xs`}
          title={stale
            ? `Reported ok, but not polled since ${source.last_polled || 'never'}. A source can report healthy and silently never fire, so this is not a confident green.`
            : `Health as last reported: ${source.health}`}
        >
          {healthLabel(source.health)}{stale ? ' · stale' : ''}
        </span>
        {source.health_hint && <div className="qx-hint qx-hint--sm">{source.health_hint}</div>}
      </td>
      <td>
        {/* SIGNAL-AUDIT 2026-09-18: was a ghost icon in a 0.6-opacity
            .qx-row-actions cluster — 14px dim strokes on the dark theme read
            as NO button at all (owner: "I don't see a delete button on
            sources tab"). Deleting a source is a deliberate management action
            on a roomy table row; it earns a real labelled button. */}
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          title={`Stop following ${source.label}`}
          aria-label={`Remove ${source.label}`}
          data-testid="signal-source-remove"
          disabled={busy}
          onClick={remove}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14, marginRight: 6 }}>
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
          Remove
        </button>
      </td>
    </tr>
  );
}

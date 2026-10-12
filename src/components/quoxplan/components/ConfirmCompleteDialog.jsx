import { useState } from 'react';

/**
 * Owner-gated confirmation for any status transition to COMPLETE — used by
 * both the Stream page status menu and Board drag-to-COMPLETE-column drops.
 * The API rejects COMPLETE with 403 unless `confirm_owner: true` is sent;
 * this dialog is what makes that explicit in the UI as well.
 */
export default function ConfirmCompleteDialog({ streamName, busy, onConfirm, onCancel }) {
  const [checked, setChecked] = useState(false);

  return (
    <div className="qx-modal-overlay" onClick={onCancel}>
      <div className="qx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qx-modal__header">
          <h3>Owner confirmation required</h3>
        </div>
        <div className="qx-modal__body qx-stack qx-stack--tight">
          <p style={{ margin: 0 }}>
            Marking <strong>{streamName}</strong> COMPLETE is an owner-gated action.
          </p>
          <label className="qx-checkbox">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span className="qx-checkbox__box" />
            I confirm this stream is genuinely complete
          </label>
        </div>
        <div className="qx-modal__actions">
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--primary"
            disabled={!checked || busy}
            onClick={() => onConfirm()}
          >
            {busy ? 'Saving…' : 'Mark COMPLETE'}
          </button>
        </div>
      </div>
    </div>
  );
}

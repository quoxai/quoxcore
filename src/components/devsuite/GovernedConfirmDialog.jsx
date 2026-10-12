/**
 * GovernedConfirmDialog — the product asking for consent in its own voice.
 *
 * BUNDLE POLISH D: releasing a slot, retiring a slot and halting a running loop
 * are all witnessed, governed acts. Each was asking through `window.confirm`,
 * which is OS chrome dropped into the middle of a product that spends the rest
 * of its time proving it is careful. The moment a user is asked to authorise
 * something irreversible is the worst possible moment to look like a browser
 * alert.
 *
 * Extracted from SlotsDeckPanel rather than copied into DevSessionsPanel. Two
 * dialogs asking the same question in two files is how the halt copy and the
 * release copy drift apart, and the whole point of these prompts is that they
 * restate, accurately, what is about to be witnessed.
 *
 * Props:
 *   title         what is about to happen, as a heading
 *   body          nodes explaining the consequence, including the witnessed part
 *   confirmLabel  the verb, not "OK" — the button should say what it does
 *   danger        true for destructive/irreversible acts (red confirm)
 *   busy          disables both buttons and shows progress on the confirm
 *   testIdPrefix  so existing suites keep their selectors (slot-confirm, etc.)
 */

export default function GovernedConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
  testIdPrefix = 'governed-confirm',
}) {
  return (
    <div className="qx-modal-overlay" onClick={onCancel} data-testid={`${testIdPrefix}-overlay`}>
      <div className="qx-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="qx-modal__header">
          <h3>{title}</h3>
        </div>
        <div className="qx-modal__body qx-stack qx-stack--tight">{body}</div>
        <div className="qx-modal__actions">
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--ghost"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${testIdPrefix}-cancel`}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`qx-btn qx-btn--sm ${danger ? 'qx-btn--danger' : 'qx-btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
            data-testid={`${testIdPrefix}-go`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

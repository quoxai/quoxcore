/** Visible hint for the email-style triage keys — j/k to move, Enter to advance, x to select. */
export default function KeyboardHint() {
  return (
    <div className="qx-row qx-row--tight" aria-label="Keyboard shortcuts">
      <span className="qx-hint qx-hint--sm">
        <span className="qx-kbd">j</span> <span className="qx-kbd">k</span> move
      </span>
      <span className="qx-hint qx-hint--sm">
        <span className="qx-kbd">Enter</span> advance stage
      </span>
      <span className="qx-hint qx-hint--sm">
        <span className="qx-kbd">x</span> select
      </span>
    </div>
  );
}

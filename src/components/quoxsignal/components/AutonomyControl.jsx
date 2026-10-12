import { useState } from 'react';
import { AUTONOMY_LEVELS, AUTONOMY_DESCRIPTIONS, isRaise } from '../lib/autonomy.js';

/**
 * The one control that decides whether a source spends money unattended.
 * Mirrors `signal autonomy <source> <level>` (bin/signal.js): lowering or
 * holding the level applies immediately, but raising it always shows what
 * the new level does — in plain language, before the PATCH goes out — and
 * requires a second click to confirm. Never a silent select-and-forget.
 */
export default function AutonomyControl({ source, onPatch, disabled }) {
  const [pendingLevel, setPendingLevel] = useState(null);
  const [saving, setSaving] = useState(false);

  function handleChange(e) {
    const level = e.target.value;
    if (level === source.autonomy_level) return;
    if (isRaise(source.autonomy_level, level)) {
      setPendingLevel(level);
    } else {
      apply(level);
    }
  }

  async function apply(level) {
    setSaving(true);
    try {
      await onPatch({ autonomy_level: level });
      setPendingLevel(null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="qx-stack qx-stack--tight" style={{ minWidth: 180 }}>
      <select
        className="qx-select qx-select--auto"
        aria-label={`Autonomy level for ${source.label}`}
        value={pendingLevel || source.autonomy_level}
        disabled={disabled || saving}
        onChange={handleChange}
      >
        {AUTONOMY_LEVELS.map((level) => (
          <option key={level} value={level}>{level}</option>
        ))}
      </select>

      {pendingLevel && (
        <div className="qx-banner qx-banner--warn qx-card--compact" role="alert">
          <div className="qx-stack qx-stack--tight">
            <strong>
              Raising {source.label} from {source.autonomy_level} to {pendingLevel}
            </strong>
            <span className="qx-hint qx-hint--sm">{AUTONOMY_DESCRIPTIONS[pendingLevel]}</span>
            <span className="qx-hint qx-hint--sm">This means the system spends money on this source without asking again.</span>
            <div className="qx-banner__actions">
              <button
                type="button"
                className="qx-btn qx-btn--sm qx-btn--danger"
                disabled={saving}
                data-testid="autonomy-confirm-raise"
                onClick={() => apply(pendingLevel)}
              >
                Confirm raise
              </button>
              <button
                type="button"
                className="qx-btn qx-btn--sm qx-btn--ghost"
                disabled={saving}
                onClick={() => setPendingLevel(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

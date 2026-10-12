import { useState } from 'react';
import { NEXT_STEPS, estimateEnrichmentCost } from '../lib/nextSteps.js';

/**
 * The next-step strip on an approved proposal.
 *
 * Renders whatever NEXT_STEPS declares, so adding a step later is a data change rather than
 * a change here. A step that costs money never fires on the first click: it shows the
 * estimate and asks, matching the rest of this surface where nothing spends silently.
 *
 * `handoffSlot` is passed through rather than reimplemented, because the preview-then-submit
 * flow already exists in the view and a second copy would drift from it.
 */
export default function NextStepStrip({ proposal, allItems, transcriptChars, onEnriched, handoffSlot }) {
  const [confirming, setConfirming] = useState(null);
  const [running, setRunning] = useState(null);
  const [error, setError] = useState(null);

  const relatedGuess = Math.min(5, Math.max(0, (allItems?.length || 1) - 1));
  const estimate = estimateEnrichmentCost(transcriptChars || 0, relatedGuess);

  async function fire(step) {
    setError(null);
    setConfirming(null);
    setRunning(step.id);
    try {
      const result = await step.run(proposal, { allItems });
      onEnriched?.(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="qx-stack qx-stack--tight">
      <span className="qx-section-title">Next steps</span>

      {NEXT_STEPS.map((step) => {
        if (step.kind === 'handoff') {
          return (
            <div key={step.id} className="qx-stack qx-stack--tight">
              <span className="qx-hint qx-hint--sm">{step.description}</span>
              {handoffSlot}
            </div>
          );
        }

        const busy = running === step.id;
        const asking = confirming === step.id;

        return (
          <div key={step.id} className="qx-stack qx-stack--tight">
            <div className="qx-row qx-row--apart">
              <span className="qx-hint qx-hint--sm">{step.description}</span>
              <button
                type="button"
                className="qx-btn qx-btn--sm"
                disabled={busy}
                onClick={() => (step.costs ? setConfirming(step.id) : fire(step))}
                data-testid={`signal-step-${step.id}`}
              >
                {busy ? 'Working…' : step.label}
              </button>
            </div>

            {asking && (
              <div className="qx-banner">
                <div className="qx-stack qx-stack--tight">
                  <span>
                    This spends money. Estimated <strong>${estimate.toFixed(3)}</strong> for one pass.
                    It appends to this proposal and never overwrites the original verdict.
                  </span>
                  <div className="qx-row qx-row--tight">
                    <button
                      type="button"
                      className="qx-btn qx-btn--sm qx-btn--primary"
                      onClick={() => fire(step)}
                      data-testid={`signal-step-${step.id}-confirm`}
                    >
                      Run it
                    </button>
                    <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {error && <div className="qx-banner qx-banner--error">{error}</div>}
    </div>
  );
}

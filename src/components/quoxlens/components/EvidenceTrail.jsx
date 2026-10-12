import { useMemo } from 'react';
import { buildEvidenceTrail } from '../lib/evidenceTrail.js';

// A stage that is missing gets a distinct, unmistakably-not-fine colour via
// an inline override of qx-trail__node's --qx-trail-color custom property —
// same technique as quoxsignal/components/EvidenceTrail.jsx, no CSS file
// edit needed here either.
const MISSING_COLOR = '#ef4444';
const TRAIL_MODIFIER = { aee: 'aee', ward: 'ward' };

/**
 * The evidence chain for one selected Lens finding: SOURCE (the swept
 * artifact) through AEE, VOLT, and WARD, plus the finding's own verbatim
 * evidence quote(s).
 *
 * Two callers, two honesty pictures:
 *  - `finding` + `scopeMeta` (unchanged): a finding read back from a
 *    findings-SCOPE file on disk. AEE/VOLT/WARD are genuinely missing for
 *    these — sweep.mjs has not been wired to call POST /apply — and render
 *    as MISSING, in red, with the word MISSING in the label.
 *  - `trail` (EVIDENCE-LIVE): a pre-built trail for a FRESHLY APPLIED
 *    verdict (see lib/evidenceTrail.js's buildAppliedEvidenceTrail). AEE and
 *    VOLT are now genuinely real for this case; WARD still renders MISSING
 *    honestly (see that function's own doc for the exact known gap).
 *
 * This component never hides a genuine gap and never renders a hopeful tick
 * for a stage that was never recorded — the hint text below is computed
 * from what actually came back, not hardcoded to one story.
 */
export default function EvidenceTrail({ finding, scopeMeta, trail: trailProp }) {
  const builtTrail = useMemo(() => buildEvidenceTrail(finding, scopeMeta), [finding, scopeMeta]);
  const trail = trailProp || builtTrail;

  if (!finding && !trailProp) {
    return (
      <div className="qx-empty" data-testid="qx-lens-evidence-empty">
        <div className="qx-empty__title">No finding selected</div>
        <div className="qx-empty__body">Pick a finding from the Findings tab to see its evidence chain.</div>
      </div>
    );
  }

  const stageFound = (key) => !!trail.stages.find((s) => s.key === key)?.found;
  const allWiredMissing = !stageFound('aee') && !stageFound('volt') && !stageFound('ward');
  const wardOnlyGap = stageFound('aee') && stageFound('volt') && !stageFound('ward');

  return (
    <div className="qx-stack qx-stack--tight" data-testid="qx-lens-evidence-trail">
      <span className="qx-section-title">Evidence trail</span>

      <div className="qx-trail">
        {trail.stages.map((stage, i) => {
          const modifier = stage.found ? TRAIL_MODIFIER[stage.key] : null;
          const className = ['qx-trail__node', modifier && `qx-trail__node--${modifier}`]
            .filter(Boolean)
            .join(' ');
          return (
            // eslint-disable-next-line react/no-array-index-key -- stage order is fixed/static
            <span key={stage.key}>
              {i > 0 && <span className="qx-trail__sep">&rsaquo;</span>}
              <span
                className={className}
                style={stage.found ? undefined : { '--qx-trail-color': MISSING_COLOR }}
                data-testid={`qx-lens-trail-node-${stage.key}`}
                data-found={stage.found}
                title={stage.detail || undefined}
              >
                {stage.found ? stage.label : `${stage.label}: MISSING`}
              </span>
            </span>
          );
        })}
      </div>

      {allWiredMissing && (
        <div className="qx-hint qx-hint--sm" data-testid="qx-lens-trail-hint-all-missing">
          AEE, VOLT and WARD are not yet wired for this finding — no envelope, bundle or receipt has
          ever been recorded for it. This is the true current state, not a loading gap.
        </div>
      )}
      {wardOnlyGap && (
        <div className="qx-hint qx-hint--sm" data-testid="qx-lens-trail-hint-ward-gap">
          AEE and VOLT are real for this verdict. WARD witnessing fires on write (the same hook
          every other envelope in this app uses) but this read view does not yet surface a receipt
          back for it — WARD renders MISSING honestly rather than claiming a witness it cannot show.
        </div>
      )}

      {trail.quotes.length > 0 && (
        <div className="qx-stack qx-stack--tight">
          {trail.quotes.map((q, i) => (
            // eslint-disable-next-line react/no-array-index-key -- quotes have no stable id
            <div className="qx-evidence" key={i}>
              <span className="qx-evidence__dot" />
              {q.at && (
                <>
                  <span className="qx-evidence__ts">{q.at}</span>
                  <span className="qx-evidence__sep">&middot;</span>
                </>
              )}
              <span className="qx-evidence__source">&ldquo;{q.quote}&rdquo;</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

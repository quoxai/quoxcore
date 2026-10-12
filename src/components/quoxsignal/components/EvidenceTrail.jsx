import { useEffect, useMemo, useState } from 'react';
import { fetchEvidenceBundle } from '../lib/evidenceApi.js';
import { proposalEvidenceCorr, buildEvidenceTrail, timestampedSourceUrl } from '../lib/evidenceTrail.js';
import { formatDuration } from '../lib/format.js';

// Only SOURCE-node colors already defined in qx-components.css get a
// modifier class; SOURCE/TRANSCRIPT reuse the base node's default color
// (there is no dedicated modifier for them, and the default reads fine as
// a generic "present" indicator).
const TRAIL_MODIFIER = { aee: 'aee', ward: 'ward' };
// A stage that is missing gets a distinct, unmistakably-not-fine color via
// an inline override of the qx-trail__node's own --qx-trail-color custom
// property — no CSS file edit needed (EvidenceTrail.jsx does not own
// qx-components.css).
const MISSING_COLOR = '#ef4444';

/**
 * The evidence trail for one proposal: the chain from the source post
 * through the transcript hash to the AEE envelope and the WARD receipt,
 * plus every evidence quote with its timestamp (and, where the platform
 * supports it, a link back to that timestamp in the original post).
 *
 * Honesty rule (non-negotiable, see SIGNAL-P4 brief): a stage that is
 * genuinely missing — e.g. no WARD receipt because witnessing was
 * unavailable — renders as MISSING, in its own distinct color, with the
 * word MISSING in the label. It is never hidden and never rendered as a
 * hopeful tick. A trail that looks complete when it is not is worse than
 * no trail.
 */
export default function EvidenceTrail({ proposal }) {
  const corr = proposal?.id ? proposalEvidenceCorr(proposal.id) : null;
  const [state, setState] = useState({ loading: !!corr, data: null });

  useEffect(() => {
    let cancelled = false;
    if (!corr) {
      setState({ loading: false, data: null });
      return undefined;
    }
    setState({ loading: true, data: null });
    fetchEvidenceBundle(corr).then((data) => {
      if (!cancelled) setState({ loading: false, data });
    });
    return () => {
      cancelled = true;
    };
  }, [corr]);

  const trail = useMemo(() => buildEvidenceTrail(proposal, state.data), [proposal, state.data]);

  if (!proposal) return null;

  return (
    <div className="qx-stack qx-stack--tight" data-testid="qx-evidence-trail">
      <div className="qx-row qx-row--apart">
        <span className="qx-section-title">Evidence trail</span>
        {state.loading && <span className="qx-hint qx-hint--sm">checking receipt&hellip;</span>}
      </div>

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
                data-testid={`qx-trail-node-${stage.key}`}
                data-found={stage.found}
                title={stage.detail || undefined}
              >
                {stage.found ? stage.label : `${stage.label}: MISSING`}
              </span>
            </span>
          );
        })}
      </div>

      {!corr && (
        <div className="qx-hint qx-hint--sm">
          No evidence receipt was recorded for this proposal (created before evidence bundling shipped, or this proposal has no id yet).
        </div>
      )}

      {corr && !state.loading && trail.quotes.length === 0 && (
        <div className="qx-hint qx-hint--sm">
          No evidence bundle was recorded for this proposal — the receipt above shows exactly which stage is missing.
        </div>
      )}

      {trail.quotes.length > 0 && (
        <div className="qx-stack qx-stack--tight">
          {trail.quotes.map((q, i) => {
            const link = timestampedSourceUrl(proposal?.url, proposal?.platform, q.timestamp);
            return (
              // eslint-disable-next-line react/no-array-index-key -- quotes have no stable id
              <div className="qx-evidence" key={i}>
                <span className="qx-evidence__dot" />
                <span className="qx-evidence__ts">{formatDuration(q.timestamp)}</span>
                <span className="qx-evidence__sep">&middot;</span>
                <span className="qx-evidence__source">&ldquo;{q.quote}&rdquo;</span>
                {link && (
                  <>
                    <span className="qx-evidence__sep">&middot;</span>
                    <a href={link} target="_blank" rel="noreferrer" className="qx-hint qx-hint--sm">
                      jump to {formatDuration(q.timestamp)}
                    </a>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

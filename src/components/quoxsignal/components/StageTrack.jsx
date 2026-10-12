import { STAGE_ORDER } from '../lib/stage.js';

/**
 * Position in the pipeline, not a status badge.
 *
 * WHY this replaces a coloured pill: three same-shape capsules distinguished only by hue
 * have no ordinal relationship to the eye, so a reader must already know the taxonomy to
 * read progress. Here fill level and position carry the meaning and colour only reinforces
 * it, which also means it survives greyscale and colour blindness.
 *
 * Each stage deliberately looks different: reached nodes are solid on the house gradient,
 * the current node is larger with a halo, the terminal stage is SQUARED rather than round so
 * "finished" is a different shape and not merely another colour, and unreached nodes are a
 * bare track. The "n of 3" is explicit because a reader otherwise cannot tell whether
 * analysed is the end or step two of four.
 */
export default function StageTrack({ stage, showLabel = true }) {
  const order = STAGE_ORDER;
  const idx = Math.max(0, order.indexOf(stage));
  const isTerminal = idx === order.length - 1;

  return (
    <span
      className="qx-stage-track"
      role="img"
      aria-label={`Stage ${idx + 1} of ${order.length}: ${stage}`}
      title={`${stage} — step ${idx + 1} of ${order.length}`}
      data-testid="signal-stage-track"
      data-stage={stage}
      data-step={`${idx + 1}/${order.length}`}
    >
      {order.map((name, i) => {
        const done = i < idx;
        const current = i === idx;
        let nodeCls = 'qx-stage-track__node';
        if (current && isTerminal) nodeCls += ' qx-stage-track__node--terminal';
        else if (current) nodeCls += ' qx-stage-track__node--current';
        else if (done) nodeCls += ' qx-stage-track__node--done';

        return (
          <span key={name} style={{ display: 'inline-flex', alignItems: 'center' }}>
            {i > 0 && (
              <span className={`qx-stage-track__bar${i <= idx ? ' qx-stage-track__bar--done' : ''}`} />
            )}
            <span className={nodeCls} />
          </span>
        );
      })}

      {showLabel && (
        <span className="qx-stage-track__label qx-stage-track__label--current">
          {stage} <span style={{ opacity: 0.6 }}>{idx + 1}/{order.length}</span>
        </span>
      )}
    </span>
  );
}

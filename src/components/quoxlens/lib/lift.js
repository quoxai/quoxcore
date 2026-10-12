/**
 * Pure formatting for a Lens's measured lift (span-level F1, lens minus
 * baseline, from eval/lenses/results/<id>-<model>.json's `lift.span.f1`).
 *
 * Kept side-effect free and separate from LensCard.jsx so the "never round a
 * loss into a win" rule is unit-testable without React. This is the exact
 * seam the honesty requirement lives in: a Lens that currently loses to
 * baseline (negative lift) must render as a loss, in red, with its real
 * sign — never clamped to zero, never dropped, never presented as
 * inconclusive-and-therefore-quietly-fine.
 */

/**
 * @param {number|null|undefined} f1 - lift.span.f1 from an eval result, or
 *   null/undefined when no eval has been run yet.
 * @returns {{ percent: number, label: string, direction: 'up'|'down'|'flat' } | null}
 *   null means "no measured lift to show" — callers must render that as an
 *   absence, not as a zero.
 */
export function formatLift(f1) {
  if (typeof f1 !== 'number' || Number.isNaN(f1)) return null;
  const percent = Math.round(f1 * 1000) / 10; // one decimal place, e.g. -9.8
  const direction = percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat';
  const sign = percent > 0 ? '+' : '';
  return { percent, label: `${sign}${percent}%`, direction };
}

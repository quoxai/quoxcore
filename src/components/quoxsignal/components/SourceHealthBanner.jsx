import { Link } from 'react-router-dom';
import { unhealthySources } from '../lib/health.js';

/**
 * The Feed's admission that it may not be showing you everything.
 *
 * WHY on the Feed and not just in Sources: a broken source and a source with nothing new to
 * say produce the same Feed, a calm list. Calm reads as "nothing happened" when it can mean
 * "I stopped looking". The Sources tab already reports health correctly per row, but nobody
 * opens it at the moment it matters, because the symptom of a dead source is that nothing
 * prompts you to.
 *
 * Deliberately NOT an error banner. Broken and quiet are separated and worded differently:
 * a stale poll may be a small account that genuinely posted nothing, and crying error at
 * that would train the user to ignore the strip. It stays a single quiet line with a route
 * into Sources, where the per-source detail already lives, rather than duplicating it here.
 */
export default function SourceHealthBanner({ sources }) {
  const { bad, stale } = unhealthySources(sources || []);
  if (bad.length === 0 && stale.length === 0) return null;

  const parts = [];
  if (bad.length) parts.push(`${bad.length} source${bad.length === 1 ? '' : 's'} failing`);
  if (stale.length) parts.push(`${stale.length} not polled recently`);

  return (
    <div
      className={`qx-banner${bad.length ? ' qx-banner--warn' : ''}`}
      data-testid="signal-source-health-banner"
    >
      <div className="qx-row qx-row--apart qx-row--wrap">
        <span>
          {parts.join(', ')}. This feed may be missing content.
        </span>
        <Link className="qx-btn qx-btn--sm qx-btn--ghost" to="/quoxsignal/sources">
          Check sources
        </Link>
      </div>
    </div>
  );
}

/**
 * GlassToolCallCard — QCX-5c
 *
 * Compact card showing a tool invocation in progress. State cycles
 * running → ok/error; the status chip label + colour update in place.
 * A collapsible "Details" section reveals full input/result JSON for
 * inspection (admins, debugging).
 *
 * Input/result are rendered through React children so HTML special
 * chars are auto-escaped.
 */

import { useState } from 'react';
import './glass-chat.css';

const STATE_LABELS = {
  running: 'Looking that up…',
  ok: 'Done',
  error: 'Error',
};

function oneLineInput(input) {
  if (!input || typeof input !== 'object') return '';
  try {
    const entries = Object.entries(input);
    if (entries.length === 0) return '';
    const parts = entries.slice(0, 3).map(([k, v]) => {
      const val = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v ?? '');
      return `${k}: ${val}`;
    });
    const joined = parts.join(', ');
    return joined.length > 80 ? joined.slice(0, 79) + '…' : joined;
  } catch { return ''; }
}

export function GlassToolCallCard({ name, state, input, result, error }) {
  const [expanded, setExpanded] = useState(false);
  const safeState = ['ok', 'error'].includes(state) ? state : 'running';
  const label = safeState === 'error' && error
    ? `Error: ${error}`
    : STATE_LABELS[safeState];
  const summary = oneLineInput(input);
  const hasDetails = !!input || !!result;

  return (
    <div className="gtc" data-state={safeState} data-tool={name}>
      <div className="gtc__head">
        <span className="gtc__name">{name}</span>
        <span className="gtc__status">{label}</span>
      </div>
      {summary && <div className="gtc__summary">{summary}</div>}
      {hasDetails && (
        <>
          <button
            type="button"
            className="gtc__toggle"
            aria-expanded={expanded ? 'true' : 'false'}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide details' : 'Show details'}
          </button>
          {expanded && (
            <pre className="gtc__details">
              {input != null && `Input:\n${JSON.stringify(input, null, 2)}\n\n`}
              {result != null && `Result:\n${JSON.stringify(result, null, 2)}`}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/**
 * GlassCitationCard — QCX-5c
 *
 * One-per-chunk citation card. Shows source + section path, confidence
 * badge, pinned marker, and an optional collapsible excerpt. Source
 * label is a link when the URL is safe (http/https/mailto///).
 */

import { useState } from 'react';
import { isSafeUrl } from './_urlGuard';
import { GlassConfidenceBadge } from './GlassConfidenceBadge';
import './glass-chat.css';

export function GlassCitationCard({ source, section, score, pinned = false, excerpt }) {
  const [expanded, setExpanded] = useState(false);
  const pinnedAttr = pinned ? { 'data-pinned': 'true' } : {};

  const sourceNode = isSafeUrl(source) ? (
    <a className="gcc__src-link" href={source} target="_blank" rel="noopener noreferrer">
      {source}
    </a>
  ) : (
    <span className="gcc__src-text">{source}</span>
  );

  return (
    <div className="gcc" {...pinnedAttr}>
      <div className="gcc__head">
        {pinned && <span className="gcc__pin" aria-label="Pinned source">★</span>}
        {sourceNode}
        {section && <span className="gcc__section">› {section}</span>}
        <GlassConfidenceBadge score={score} />
      </div>
      {excerpt && (
        <>
          <button
            type="button"
            className="gcc__toggle"
            aria-expanded={expanded ? 'true' : 'false'}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide excerpt' : 'Show excerpt'}
          </button>
          {expanded && <div className="gcc__excerpt">{excerpt}</div>}
        </>
      )}
    </div>
  );
}

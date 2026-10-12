/**
 * GlassCitationBadge — QCX-5c
 *
 * Compact inline citation chip: "[1]". Becomes an external link when a
 * safe URL is supplied, a button when onClick is supplied (e.g. scroll
 * to a card below), or a plain span otherwise. Optional confidence prop
 * colours the chip.
 */

import { isSafeUrl } from './_urlGuard';
import './glass-chat.css';

function tierFor(score) {
  if (typeof score !== 'number' || !isFinite(score) || score < 0 || score > 1) return null;
  if (score >= 0.70) return 'high';
  if (score >= 0.40) return 'med';
  return 'low';
}

export function GlassCitationBadge({ index, url, confidence, onClick, title }) {
  const tier = tierFor(confidence);
  const label = `[${index}]`;
  const className = `gc-cite${tier ? ` gc-cite--${tier}` : ''}`;
  const tierAttr = tier ? { 'data-tier': tier } : {};

  if (isSafeUrl(url)) {
    return (
      <a
        className={className}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        {...tierAttr}
      >
        {label}
      </a>
    );
  }
  if (typeof onClick === 'function') {
    return (
      <button type="button" className={className} onClick={onClick} title={title} {...tierAttr}>
        {label}
      </button>
    );
  }
  return (
    <span className={className} title={title} {...tierAttr}>
      {label}
    </span>
  );
}

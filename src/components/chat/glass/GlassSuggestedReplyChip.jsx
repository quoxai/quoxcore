/**
 * GlassSuggestedReplyChip — QCX-5d
 *
 * Quick-reply chip shown under short assistant replies. onClick receives
 * the label so the consumer can stuff it into the composer.
 */

import './glass-chat.css';

export function GlassSuggestedReplyChip({ label, onClick, disabled = false }) {
  return (
    <button
      type="button"
      className="gsr"
      disabled={disabled}
      onClick={() => { if (!disabled && typeof onClick === 'function') onClick(label); }}
    >
      {label}
    </button>
  );
}

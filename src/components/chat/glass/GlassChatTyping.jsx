/**
 * GlassChatTyping — QCX-5b
 *
 * 3-dot pulse typing indicator. Kept in the DOM when visible=false so
 * callers can toggle without unmount flicker.
 */

import './glass-chat.css';

export function GlassChatTyping({ visible = true, label = 'Assistant is typing' }) {
  const hidden = !visible;
  return (
    <span
      className={`gct${hidden ? ' gct--hidden' : ''}`}
      role="status"
      aria-label={label}
      aria-hidden={hidden ? 'true' : undefined}
    >
      <span className="gct__dot" />
      <span className="gct__dot" />
      <span className="gct__dot" />
    </span>
  );
}

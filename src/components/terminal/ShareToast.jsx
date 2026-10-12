/**
 * ShareToast — Brief clipboard confirmation toast for workspace share links.
 *
 * Fixed bottom-center overlay, auto-dismisses after 2s with fade-out.
 * Follows terminal UI conventions (JetBrains Mono, dark theme).
 */

import { useEffect, useState } from 'react';
import './ShareToast.css';

export default function ShareToast({ visible, message, onDone }) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!visible) { setFading(false); return; }

    const fadeTimer = setTimeout(() => setFading(true), 1600);
    const doneTimer = setTimeout(() => onDone(), 2000);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [visible, onDone]);

  if (!visible) return null;

  return (
    <div className={`share-toast qx-toast qx-toast--success ${fading ? 'share-toast--fading' : ''}`}>
      <svg className="qx-toast__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <div className="qx-toast__body">
        <div className="qx-toast__msg">{message || 'Share link copied to clipboard'}</div>
      </div>
    </div>
  );
}

/**
 * SessionRecoveryBanner — Shows recoverable detached terminal sessions
 *
 * Slides down below the terminal header when detached sessions are found
 * on the server. Each session can be reconnected individually.
 */

import { useState, useEffect } from 'react';
import './session-recovery-banner.css';

function formatTimeRemaining(ms) {
  if (ms <= 0) return 'expired';
  const mins = Math.ceil(ms / 60000);
  return mins === 1 ? '1 min left' : `${mins} min left`;
}

function formatSessionLabel(session) {
  if (session.mode === 'ssh' && session.hostId) {
    return `SSH → ${session.hostId}`;
  }
  return 'Local shell';
}

export default function SessionRecoveryBanner({ matches, onReconnect, onDismiss }) {
  const [dismissed, setDismissed] = useState(false);

  // Auto-dismiss when no matches remain
  useEffect(() => {
    if (matches.length === 0) setDismissed(true);
  }, [matches.length]);

  if (dismissed || matches.length === 0) return null;

  const handleDismiss = () => {
    setDismissed(true);
    if (onDismiss) onDismiss();
  };

  return (
    <div className="qx-banner qx-banner--success session-recovery-banner" role="status">
      <svg className="qx-banner__icon session-recovery-banner__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
      <span className="session-recovery-banner__text">
        {matches.length} previous session{matches.length !== 1 ? 's' : ''} available
      </span>
      <div className="session-recovery-banner__sessions">
        {matches.map(({ session, paneId }) => (
          <button
            key={session.sessionId}
            className="session-recovery-banner__reconnect-btn"
            onClick={() => onReconnect(paneId, session.sessionId)}
            title={`Reconnect to ${formatSessionLabel(session)}`}
          >
            {formatSessionLabel(session)}
            <span className="session-recovery-banner__time">
              {formatTimeRemaining(session.gracePeriodRemainingMs)}
            </span>
          </button>
        ))}
      </div>
      <button
        className="session-recovery-banner__dismiss"
        onClick={handleDismiss}
        title="Dismiss"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

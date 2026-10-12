/**
 * ErrorNotificationBar — slides up from terminal pane bottom when an error is detected.
 *
 * Props:
 *   error   — { errorType, errorLine, suggestion } from detectTerminalError
 *   onAction — (action: 'explain' | 'fix', error) => void
 *   onDismiss — () => void
 *   mode    — current terminal mode (audit hides Fix button)
 */

import './ErrorNotificationBar.css';

export default function ErrorNotificationBar({ error, onAction, onDismiss, mode }) {
  if (!error) return null;

  const isAudit = mode === 'audit';
  const truncatedLine = error.errorLine.length > 60
    ? error.errorLine.substring(0, 57) + '...'
    : error.errorLine;

  return (
    <div className="error-notification-bar" role="alert">
      <div className="error-notification-bar__actions">
        <button
          className="error-notification-bar__btn error-notification-bar__btn--explain"
          onClick={() => onAction('explain', error)}
        >
          ? Explain
        </button>
        {!isAudit && (
          <button
            className="error-notification-bar__btn error-notification-bar__btn--fix"
            onClick={() => onAction('fix', error)}
          >
            Fix
          </button>
        )}
      </div>
      <div className="error-notification-bar__content">
        <span className="error-notification-bar__type">{error.errorType.replace(/_/g, ' ')}</span>
        <span className="error-notification-bar__line" title={error.errorLine}>{truncatedLine}</span>
      </div>
      <button
        className="error-notification-bar__btn error-notification-bar__btn--dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        &#x2715;
      </button>
    </div>
  );
}

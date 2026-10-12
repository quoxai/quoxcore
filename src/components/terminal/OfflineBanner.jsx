/**
 * OfflineBanner — Amber warning bar when network is offline
 *
 * Slides down below the terminal header. Returns null when online.
 */

import './OfflineBanner.css';

export default function OfflineBanner({ isOffline }) {
  if (!isOffline) return null;

  return (
    <div className="qx-banner qx-banner--warn offline-banner" role="alert">
      <svg className="qx-banner__icon offline-banner__icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
      <span className="offline-banner__text">
        Network offline. Sessions will reconnect automatically
      </span>
    </div>
  );
}

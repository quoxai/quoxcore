/**
 * SnapshotViewer — Read-only terminal snapshot viewer
 *
 * Renders a shared workspace snapshot: layout + buffered terminal output.
 * No live connections — just static output replay via xterm.js.
 *
 * Route: /terminal/share/:shareId
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getSnapshot } from '../../services/snapshotClient';
import './snapshot-viewer.css';

/**
 * Minimal xterm renderer — writes pre-captured output into a terminal div.
 * Uses @xterm/xterm from the existing dependency.
 */
function SnapshotPane({ mode, hostId, output }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: '#0a0a0a',
        foreground: '#d4d4d8',
        cursor: 'transparent',
      },
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    try { fitAddon.fit(); } catch { /* best effort */ }
    if (output) {
      term.write(output);
    }
    termRef.current = term;

    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, [output]);

  return (
    <div className="snapshot-pane">
      <div className="snapshot-pane__header">
        <span className="snapshot-pane__mode">{mode === 'ssh' ? 'SSH' : 'Local'}</span>
        {hostId && <span className="snapshot-pane__host">{hostId}</span>}
        {!output && <span className="snapshot-pane__empty">No output captured</span>}
      </div>
      <div className="snapshot-pane__terminal" ref={containerRef} />
    </div>
  );
}

/**
 * Format relative time (e.g., "2 hours ago")
 */
function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function SnapshotViewer() {
  const { shareId } = useParams();
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!shareId) return;
    setLoading(true);
    getSnapshot(shareId)
      .then(data => {
        if (!data) {
          setError('Snapshot not found or expired');
        } else {
          setSnapshot(data);
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [shareId]);

  const handleCopyLink = useCallback(() => {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  }, []);

  if (loading) {
    return (
      <div className="snapshot-viewer snapshot-viewer--loading">
        <div className="snapshot-viewer__spinner" />
        <p>Loading snapshot...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="snapshot-viewer snapshot-viewer--error">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <h2>{error}</h2>
        <p>This share link may have expired or been deleted.</p>
        <Link to="/terminal" className="snapshot-viewer__back-link">
          Open Terminal
        </Link>
      </div>
    );
  }

  return (
    <div className="snapshot-viewer">
      <div className="snapshot-viewer__header">
        <div className="snapshot-viewer__title-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          <h1>{snapshot.title}</h1>
          <span className="snapshot-viewer__meta">
            {timeAgo(snapshot.createdAt)} &middot; {snapshot.layout} &middot; {snapshot.panes.length} pane{snapshot.panes.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="snapshot-viewer__actions">
          <button className="snapshot-viewer__btn" onClick={handleCopyLink} title="Copy share link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy Link
          </button>
          <Link to="/terminal" className="snapshot-viewer__btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            Open Terminal
          </Link>
        </div>
      </div>

      <div className="snapshot-viewer__body" data-layout={snapshot.layout}>
        {snapshot.panes.map((pane, i) => (
          <SnapshotPane
            key={i}
            mode={pane.mode}
            hostId={pane.hostId}
            output={pane.output}
          />
        ))}
      </div>

      <div className="snapshot-viewer__footer">
        <span className="snapshot-viewer__badge">READ-ONLY SNAPSHOT</span>
        <span className="snapshot-viewer__expires">
          Expires {new Date(snapshot.expiresAt).toLocaleString()}
        </span>
      </div>
    </div>
  );
}

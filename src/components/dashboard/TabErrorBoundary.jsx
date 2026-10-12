/**
 * TabErrorBoundary — recover a dashboard tab whose lazy chunk failed to load.
 *
 * Why: the heavy embed tabs (Qortex, Cognitive Core) are React.lazy chunks.
 * If a chunk request fails — a stale chunk hash after a redeploy while the
 * page stayed open, or the collector/network flapping mid-fetch — React.lazy
 * throws and, with no boundary, the tab renders blank forever (owner: "not
 * sure some are loading at all"). This catches that and offers a reload so the
 * failure is recoverable instead of a dead panel.
 */
import { Component } from 'react';

export default class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    // Surface it; a chunk-load failure is worth a console line, not silence.
    // eslint-disable-next-line no-console
    console.error(`[dashboard tab: ${this.props.label || 'embed'}] failed to load`, error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="dash-embed-loading" style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
          <span>{this.props.label || 'This tab'} could not load.</span>
          <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
            The app may have updated in the background, or a service was briefly unavailable.
          </span>
          <button type="button" className="qx-btn qx-btn--sm" onClick={() => window.location.reload()}>
            Reload dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

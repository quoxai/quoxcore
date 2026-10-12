import { useState } from 'react';
import { api } from '../lib/api.js';
import { ACCOUNT_PLATFORMS, accountUrlFor } from '../lib/sourcePlatforms.js';

const MODES = { account: 'account', feed: 'feed' };

/**
 * SIGNAL-UX item 5: before this, there was no way to add a source from the
 * UI at all — only `signal follow` on the CLI. Two modes, matching the
 * owner's brief verbatim: "handle plus platform, or a feed URL". Posts to
 * the same POST /sources the CLI's `signal follow` ultimately hits (see
 * server/src/api/sources.js).
 */
export default function AddSourceForm({ onAdded }) {
  const [mode, setMode] = useState(MODES.account);
  const [platform, setPlatform] = useState(ACCOUNT_PLATFORMS[0]);
  const [handle, setHandle] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [feedPlatform, setFeedPlatform] = useState('rss');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const accountUrl = mode === MODES.account ? accountUrlFor(platform, handle) : null;
  const canSubmit = mode === MODES.account ? Boolean(accountUrl) : feedUrl.trim().length > 0;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = mode === MODES.account
        ? { url: accountUrl, platform, kind: 'account', handle: handle.replace(/^@/, ''), label: label || undefined }
        : { url: feedUrl.trim(), platform: feedPlatform, kind: 'feed', label: label || undefined };
      await api.createSource(payload);
      setHandle('');
      setFeedUrl('');
      setLabel('');
      onAdded?.();
    } catch (err) {
      setError(err.body?.error || err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="qx-card qx-card--compact qx-stack qx-stack--tight" onSubmit={handleSubmit} data-testid="add-source-form">
      <div className="qx-row qx-row--apart">
        <span className="qx-section-title">Add source</span>
        <div className="qx-seg">
          <button
            type="button"
            className={`qx-seg__btn${mode === MODES.account ? ' qx-seg__btn--active' : ''}`}
            onClick={() => setMode(MODES.account)}
          >
            Handle + platform
          </button>
          <button
            type="button"
            className={`qx-seg__btn${mode === MODES.feed ? ' qx-seg__btn--active' : ''}`}
            onClick={() => setMode(MODES.feed)}
          >
            Feed URL
          </button>
        </div>
      </div>

      {mode === MODES.account ? (
        <div className="qx-row qx-row--tight qx-row--wrap">
          <select
            className="qx-select qx-select--auto"
            aria-label="Platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {ACCOUNT_PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input
            type="text"
            className="qx-input qx-input--grow"
            placeholder="@handle"
            aria-label="Handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
          <input
            type="text"
            className="qx-input qx-input--grow"
            placeholder="Label (optional)"
            aria-label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      ) : (
        <div className="qx-stack qx-stack--tight">
          <span className="qx-hint qx-hint--sm">
            YouTube channels also go here for now — paste the channel or /feeds/videos.xml URL; the dashboard cannot yet resolve a bare @handle to a channel id.
          </span>
          <div className="qx-row qx-row--tight qx-row--wrap">
            <input
              type="text"
              className="qx-input qx-input--mono qx-input--grow"
              placeholder="https://example.com/feed.xml"
              aria-label="Feed URL"
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
            />
            <select
              className="qx-select qx-select--auto"
              aria-label="Feed platform"
              value={feedPlatform}
              onChange={(e) => setFeedPlatform(e.target.value)}
            >
              <option value="rss">rss</option>
              <option value="podcast">podcast</option>
              <option value="youtube">youtube</option>
            </select>
            <input
              type="text"
              className="qx-input qx-input--grow"
              placeholder="Label (optional)"
              aria-label="Label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
        </div>
      )}

      {error && <div className="qx-banner qx-banner--error">{error}</div>}

      <div className="qx-row qx-row--end">
        <button type="submit" className="qx-btn qx-btn--sm qx-btn--primary" disabled={!canSubmit || submitting}>
          {submitting ? 'Following…' : 'Follow source'}
        </button>
      </div>
    </form>
  );
}

/**
 * ConnectionsTab — connection status from /status, and the BYO connect flow.
 *
 * The connect flow is two human steps before any OAuth happens: a human
 * creates a `google_calendar` vault credential (client id/secret), then
 * completes the Google consent screen Calendar-Q's own /oauth/start builds.
 * This tab surfaces the real state of both steps rather than pretending a
 * one-click connect exists yet.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../../contexts/AuthContext';
import { useVaultCredentials } from '../../../hooks/useVaultCredentials';
import { getStatus, oauthStart } from '../../../services/calendarQService';

function formatWatermark(ts) {
  if (!ts) return 'never synced';
  try {
    return new Date(ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  } catch {
    return 'never synced';
  }
}

export default function ConnectionsTab() {
  const { authFetch } = useAuth();
  const { credentials, loading: credentialsLoading } = useVaultCredentials({ type: 'google_calendar' });
  // /oauth/callback is a direct browser redirect to the collector (see
  // lib/calendarq/api.js's documented known limitation: a plain navigation
  // can't carry our bearer token), so it does not normally land back in this
  // SPA. If a future phase ever does bounce back here with these query
  // params, or a human pastes the callback's own `nextStep` into the URL,
  // show it verbatim rather than inventing a different message.
  const [searchParams] = useSearchParams();
  const callbackNextStep = searchParams.get('nextStep');
  const callbackConnected = searchParams.get('connected');

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [consentUrl, setConsentUrl] = useState(null);
  const [consentError, setConsentError] = useState(null);
  const [startingConsent, setStartingConsent] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getStatus(authFetch)
      .then(setStatus)
      .catch((e) => setError(e.message || 'Could not load Calendar-Q connection status.'))
      .finally(() => setLoading(false));
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const credential = credentials?.[0] || null;

  const handleStartConsent = useCallback(async () => {
    if (!credential) return;
    setStartingConsent(true);
    setConsentError(null);
    try {
      const res = await oauthStart(authFetch, { credentialId: credential.id || credential.credential_id });
      setConsentUrl(res.consentUrl);
    } catch (e) {
      setConsentError(e.message || 'Could not start the Google consent flow.');
    } finally {
      setStartingConsent(false);
    }
  }, [authFetch, credential]);

  if (loading) {
    return (
      <div className="qx-stack qx-stack--tight" data-testid="calendarq-connections-loading">
        <div className="qx-skeleton" style={{ height: 80 }} />
        <div className="qx-skeleton" style={{ height: 120 }} />
      </div>
    );
  }

  if (error) {
    return <div className="qx-banner qx-banner--error" data-testid="calendarq-connections-error">{error}</div>;
  }

  const connections = status?.connections || [];

  return (
    <div className="qx-stack qx-stack--tight" data-testid="calendarq-connections-tab">
      {callbackConnected === 'false' && callbackNextStep && (
        <div className="qx-banner qx-banner--warn" data-testid="calendarq-oauth-callback-nextstep">{callbackNextStep}</div>
      )}

      <div className="qx-card qx-stack qx-stack--tight">
        <span className="qx-section-title">Connections</span>
        {connections.length === 0 ? (
          <div className="qx-empty">
            <div className="qx-empty__title">No calendar connected yet</div>
            <div className="qx-empty__body">Connect a provider calendar below. Team schedules and workflow cron are already included in your agenda with no connection required.</div>
          </div>
        ) : (
          <table className="qx-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Resource</th>
                <th>Status</th>
                <th>Last synced</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.connectionId}>
                  <td>{c.provider}</td>
                  <td>{c.resourceId}</td>
                  <td>
                    <span className={`qx-pill qx-pill--xs ${c.status === 'connected' ? 'qx-pill--online' : 'qx-pill--ghost'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td>{formatWatermark(c.latestWatermarkTs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span className="qx-hint qx-hint--sm">{status?.layerCount ?? 0} layer{(status?.layerCount ?? 0) === 1 ? '' : 's'} registered for this org.</span>
      </div>

      <div className="qx-card qx-stack qx-stack--tight" data-testid="calendarq-connect-card">
        <span className="qx-section-title">Connect a calendar</span>
        <span className="qx-hint qx-hint--sm">
          Google is the only provider wired up today. Two steps, both explicit:
        </span>
        <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li className="qx-hint qx-hint--sm">
            A human with vault write access creates a <code className="qx-code">google_calendar</code> credential
            (OAuth client id + secret) in Settings, Vault, Credentials.
          </li>
          <li className="qx-hint qx-hint--sm">
            Once that credential exists, start the Google consent flow below.
          </li>
        </ol>

        {credentialsLoading ? (
          <div className="qx-skeleton" style={{ height: 36 }} />
        ) : !credential ? (
          <div className="qx-empty">
            <div className="qx-empty__title">No google_calendar credential yet</div>
            <div className="qx-empty__body">Create one in Settings, Vault, Credentials before Calendar-Q can start the consent flow.</div>
          </div>
        ) : consentUrl ? (
          <a className="qx-btn qx-btn--primary" href={consentUrl} target="_blank" rel="noreferrer">
            Continue to Google consent
          </a>
        ) : (
          <div className="qx-stack qx-stack--tight">
            {consentError && <div className="qx-banner qx-banner--error">{consentError}</div>}
            <button type="button" className="qx-btn qx-btn--primary" onClick={handleStartConsent} disabled={startingConsent}>
              {startingConsent ? 'Starting…' : 'Start Google consent'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

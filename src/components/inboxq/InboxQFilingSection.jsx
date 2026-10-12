/**
 * InboxQFilingSection — P3 "physical filing" settings card.
 *
 * Zones (Focus/FYI/Auto/Screened) are InboxQ's own classification and never
 * move mail on the server (see shared.js's ZONES_EXPLAINER). Physical filing
 * is the opt-in step that turns a zone into a real IMAP folder move, so the
 * tidiness also shows up in any other mail client. This card is a thin
 * editor over the api client (getFilingStatus/previewFiling/enableFiling/
 * disableFiling), never a cache: it reloads status after every enable/
 * disable so it always reflects server state, same shape as the other
 * SettingsPanel sections in InboxQView.jsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';

const FOLDER_LABELS = {
  fyi: 'FYI',
  auto: 'Auto',
  screened: 'Screened',
  unsure: 'Unsure to check',
};

function planLine(item) {
  const label = FOLDER_LABELS[item?.target] || item?.target || 'a folder';
  const n = Number(item?.count) || 0;
  return `${n} message${n === 1 ? '' : 's'} would move to InboxQ/${label}`;
}

export default function InboxQFilingSection({ accountId }) {
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState(null);

  const [previewPlan, setPreviewPlan] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const [applyToExisting, setApplyToExisting] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [enableResult, setEnableResult] = useState(null);
  const [enableError, setEnableError] = useState(null);

  const [disabling, setDisabling] = useState(false);
  const [disableError, setDisableError] = useState(null);

  const loadStatus = useCallback(() => {
    if (!accountId) {
      setStatus(null);
      setStatusLoading(false);
      return;
    }
    setStatusLoading(true);
    setStatusError(null);
    api.getFilingStatus(accountId)
      .then((d) => setStatus(d || null))
      .catch((e) => setStatusError(e.message || 'Could not load filing status.'))
      .finally(() => setStatusLoading(false));
  }, [accountId]);

  // Reset per-account editor state whenever the mailbox changes, so a stale
  // preview or result from a different mailbox never appears to describe
  // the newly-selected one.
  useEffect(() => {
    setPreviewPlan(null);
    setPreviewError(null);
    setApplyToExisting(false);
    setEnableResult(null);
    setEnableError(null);
    setDisableError(null);
    loadStatus();
  }, [accountId, loadStatus]);

  const handlePreview = useCallback(async () => {
    if (!accountId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const data = await api.previewFiling({ accountId });
      setPreviewPlan(data || null);
    } catch (err) {
      setPreviewError(err.message || 'Could not preview what would move.');
    } finally {
      setPreviewLoading(false);
    }
  }, [accountId]);

  const handleEnable = useCallback(async () => {
    if (!accountId) return;
    setEnabling(true);
    setEnableError(null);
    setEnableResult(null);
    try {
      const data = await api.enableFiling({ accountId, applyToExisting });
      setEnableResult(data || null);
      loadStatus();
    } catch (err) {
      setEnableError(err.message || 'Could not turn on physical filing.');
    } finally {
      setEnabling(false);
    }
  }, [accountId, applyToExisting, loadStatus]);

  const handleDisable = useCallback(async () => {
    if (!accountId) return;
    setDisabling(true);
    setDisableError(null);
    try {
      await api.disableFiling({ accountId });
      setEnableResult(null);
      loadStatus();
    } catch (err) {
      setDisableError(err.message || 'Could not turn off physical filing.');
    } finally {
      setDisabling(false);
    }
  }, [accountId, loadStatus]);

  const enabled = !!status?.enabled;
  const folders = status?.folders || {};
  const folderEntries = Object.entries(folders).filter(([, path]) => !!path);

  return (
    <div className="qx-card qx-surface--backed qx-stack qx-stack--tight" data-testid="inboxq-settings-filing">
      <span className="qx-section-title">Physical filing</span>
      <span className="qx-hint qx-hint--sm">
        InboxQ can file your mail into real folders on your mail server, so the tidiness shows in every
        mail app. Focus stays in your inbox. Uncertain mail goes to "Unsure to check". Screened mail goes
        to a review folder you can confirm as junk. Nothing moves until you turn this on, and it never
        runs when you first connect.
      </span>

      {statusError && <div className="qx-banner qx-banner--error">{statusError}</div>}

      {statusLoading ? (
        <div className="qx-skeleton" style={{ height: 60 }} />
      ) : (
        <>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span className={`qx-chip qx-chip--xs${enabled ? ' qx-chip--active' : ''}`}>{enabled ? 'On' : 'Off'}</span>
            <span className="qx-hint qx-hint--sm">
              {enabled ? 'Physical filing is on for this mailbox.' : 'Physical filing is off for this mailbox.'}
            </span>
          </div>

          {enabled && folderEntries.length > 0 && (
            <div className="qx-row qx-row--wrap" style={{ gap: 6 }}>
              {folderEntries.map(([key, path]) => (
                <span key={key} className="qx-chip qx-chip--xs" title={path}>
                  {FOLDER_LABELS[key] || key}: {path}
                </span>
              ))}
            </div>
          )}

          {!enabled && (
            <div className="qx-stack qx-stack--tight">
              {previewError && <div className="qx-banner qx-banner--error">{previewError}</div>}
              <div>
                <button
                  type="button"
                  className="qx-btn qx-btn--sm qx-btn--ghost"
                  onClick={handlePreview}
                  disabled={previewLoading || !accountId}
                >
                  {previewLoading ? 'Checking…' : 'Preview what would move'}
                </button>
              </div>
              {previewPlan && (
                Array.isArray(previewPlan.plan) && previewPlan.plan.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="inboxq-filing-preview-plan">
                    {previewPlan.plan.map((item) => (
                      <li key={item.target} className="qx-hint qx-hint--sm">{planLine(item)}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="qx-hint qx-hint--sm">Nothing would move right now.</span>
                )
              )}

              <label className="qx-checkbox">
                <input
                  type="checkbox"
                  checked={applyToExisting}
                  onChange={(e) => setApplyToExisting(e.target.checked)}
                />
                <span className="qx-checkbox__box" />
                Also move my existing mail now
              </label>

              {enableError && <div className="qx-banner qx-banner--error">{enableError}</div>}

              <div>
                <button
                  type="button"
                  className="qx-btn qx-btn--sm qx-btn--primary"
                  onClick={handleEnable}
                  disabled={enabling || !accountId}
                >
                  {enabling ? 'Turning on…' : 'Turn on physical filing'}
                </button>
              </div>
            </div>
          )}

          {enabled && (
            <div className="qx-stack qx-stack--tight">
              {disableError && <div className="qx-banner qx-banner--error">{disableError}</div>}
              <div>
                <button
                  type="button"
                  className="qx-btn qx-btn--sm qx-btn--ghost"
                  onClick={handleDisable}
                  disabled={disabling}
                >
                  {disabling ? 'Turning off…' : 'Turn off physical filing'}
                </button>
              </div>
              <span className="qx-hint qx-hint--sm">
                Turning this off later leaves already-moved mail where it is.
              </span>
            </div>
          )}

          {enableResult && (
            <div className="qx-banner qx-banner--success" data-testid="inboxq-filing-enable-result">
              <span>
                {typeof enableResult.created === 'number' && `Created ${enableResult.created} folder${enableResult.created === 1 ? '' : 's'}. `}
                {typeof enableResult.moved === 'number' && `Moved ${enableResult.moved} message${enableResult.moved === 1 ? '' : 's'}. `}
                {typeof enableResult.failed === 'number' && enableResult.failed > 0 && `${enableResult.failed} could not be moved.`}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

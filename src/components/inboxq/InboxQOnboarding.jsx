/**
 * InboxQOnboarding: the first-run connect flow InboxQ shows when an org has
 * no mailbox yet, replacing the old dead-end "connect it in Settings" empty
 * state. Mirrors the tone of quoxsignal/components/OnboardingWizard.jsx: a
 * short hero, what-you-get, a numbered walk-through, then the one action that
 * matters, using the SAME shared CredentialPicker every other integration-backed
 * plugin uses (allowCreate handles both "pick an existing email account" and
 * "add a new one", so there is a single control, not a picker plus a button).
 *
 * Connect flow: pick or add an 'smtp' vault credential -> InboxQ creates an
 * account from it (emailAddress is derived server-side, INBOX-only, no sync
 * yet) -> a "choose how to process" step where the user picks which folders
 * to sync and whether to sync once now or manually later -> onConnected() so
 * the caller reloads accounts and drops the user into triage. New mailboxes
 * are created in the org the user is currently viewing.
 *
 * Safety: connecting a mailbox never pulls mail by itself. Nothing is synced
 * until the user explicitly chooses to, in the configure step below or later
 * from Settings.
 */
import { useCallback, useEffect, useState } from 'react';
import CredentialPicker from '../integrations/CredentialPicker.jsx';
import IntegrationModal from '../integrations/IntegrationModal.jsx';
import { createIntegration } from '../../services/integrationsClient';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { api } from './lib/api.js';

const WHAT_YOU_GET = [
  { title: 'Zones', body: 'Every message lands in Focus, FYI, Auto or Screened, so the inbox tells you what matters first.' },
  { title: 'Daily tidy-up', body: 'A plain-language report of what came in and what it means, generated on demand.' },
  { title: 'Awaited-mail watches', body: 'Flags on messages that carry an action or a deadline, so nothing quietly slips past.' },
  { title: 'Approve before act', body: 'Filing and blocking are proposals you decide. Nothing moves or sends without you.' },
];

const STEPS = [
  { n: 1, title: 'Connect your mailbox', body: 'Add an IMAP account, or reuse one already in your vault.' },
  { n: 2, title: 'InboxQ syncs and triages', body: 'A first sync pulls recent mail and classifies it into zones.' },
  { n: 3, title: 'Review your zones and daily report', body: 'Come back here any time to triage, sync again, or generate a report.' },
];

const MailIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M2 6l10 7 10-7" />
  </svg>
);

export default function InboxQOnboarding({ onConnected }) {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;

  const [selectedCredentialId, setSelectedCredentialId] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Step 2: the account exists (INBOX-only, unsynced) and the user chooses
  // which folders to sync and when, before ever entering triage.
  const [step, setStep] = useState('connect'); // 'connect' | 'configure'
  const [account, setAccount] = useState(null);
  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState(null);
  const [selectedFolders, setSelectedFolders] = useState(() => new Set(['INBOX']));
  const [syncMode, setSyncMode] = useState('manual'); // 'manual' | 'once'
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState(null);

  const handleConnect = useCallback(async (credentialId) => {
    if (!credentialId) return;
    setConnecting(true);
    setError(null);
    try {
      const { account: acct } = await api.createAccount({ credentialId });
      // No sync here: the account lands INBOX-only and unsynced until the
      // user chooses folders and a sync mode in the configure step.
      setAccount(acct);
      setStep('configure');
    } catch (e) {
      setError(e.message || 'Could not connect this mailbox.');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleSelect = useCallback((cred) => {
    setSelectedCredentialId(cred.id);
    handleConnect(cred.id);
  }, [handleConnect]);

  const handleModalSave = useCallback(async (data) => {
    const saved = await createIntegration(data);
    if (!saved?.success) {
      throw new Error(saved?.error || 'Failed to save credential');
    }
    setModalOpen(false);
    setSelectedCredentialId(saved.id);
    await handleConnect(saved.id);
  }, [handleConnect]);

  const loadFolders = useCallback(async (accountId) => {
    setFoldersLoading(true);
    setFoldersError(null);
    try {
      const { folders: available } = await api.getAvailableFolders(accountId);
      const list = Array.isArray(available) && available.length ? available : ['INBOX'];
      setFolders(list);
      const inboxLike = list.filter((f) => f.toUpperCase() === 'INBOX');
      setSelectedFolders(new Set(inboxLike.length ? inboxLike : ['INBOX']));
    } catch {
      setFoldersError('Could not list folders on the mail server, continuing with INBOX only.');
      setFolders(['INBOX']);
      setSelectedFolders(new Set(['INBOX']));
    } finally {
      setFoldersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === 'configure' && account?.id) {
      loadFolders(account.id);
    }
  }, [step, account, loadFolders]);

  const toggleFolder = useCallback((folder) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }, []);

  const handleFinish = useCallback(async () => {
    if (!account?.id) return;
    setFinishing(true);
    setFinishError(null);
    try {
      const chosen = Array.from(selectedFolders);
      await api.updateAccountFolders(account.id, chosen.length ? chosen : ['INBOX']);
      if (syncMode === 'once') {
        await api.syncAccount(account.id);
      }
      onConnected?.();
    } catch (e) {
      setFinishError(e.message || 'Could not save your folder choices.');
    } finally {
      setFinishing(false);
    }
  }, [account, selectedFolders, syncMode, onConnected]);

  if (step === 'configure') {
    return (
      <div className="qx-stack" style={{ maxWidth: 640, margin: '0 auto', padding: '24px 0' }}>
        <div className="qx-card qx-surface--backed qx-stack qx-stack--tight" data-testid="inboxq-onboarding-configure">
          <span className="qx-section-title" style={{ fontSize: 18 }}>Mailbox connected: choose how to process it</span>
          <p className="qx-hint">
            InboxQ reads your mail to triage it. It never sends, deletes, or moves anything unless
            you explicitly Block or approve a filing. Classification is a Quox overlay; your real
            folders are untouched.
          </p>

          {/* Folder picker */}
          <div className="qx-stack qx-stack--tight">
            <span className="qx-section-title" style={{ fontSize: 13 }}>Folders to sync</span>
            {foldersLoading ? (
              <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                <span className="qx-spinner qx-spinner--sm" aria-hidden="true" />
                <span className="qx-hint qx-hint--sm">Listing folders on the mail server, this can take a few seconds.</span>
              </div>
            ) : (
              <>
                {foldersError && <span className="qx-hint qx-hint--sm">{foldersError}</span>}
                <div className="qx-row qx-row--wrap" style={{ gap: 10 }}>
                  {folders.map((f) => (
                    <label key={f} className="qx-checkbox">
                      <input
                        type="checkbox"
                        checked={selectedFolders.has(f)}
                        onChange={() => toggleFolder(f)}
                      />
                      <span className="qx-checkbox__box" />
                      {f}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Sync mode: manual is the safe default, nothing pulls automatically. */}
          <div className="qx-stack qx-stack--tight">
            <span className="qx-section-title" style={{ fontSize: 13 }}>When to sync</span>
            <label className="qx-checkbox">
              <input
                type="radio"
                name="inboxq-sync-mode"
                checked={syncMode === 'manual'}
                onChange={() => setSyncMode('manual')}
              />
              <span className="qx-checkbox__box" />
              Manual only, sync when I want (recommended)
            </label>
            <label className="qx-checkbox">
              <input
                type="radio"
                name="inboxq-sync-mode"
                checked={syncMode === 'once'}
                onChange={() => setSyncMode('once')}
              />
              <span className="qx-checkbox__box" />
              Sync selected folders once now
            </label>
            <span className="qx-hint qx-hint--sm">
              Scheduled background sync can be turned on later, in Settings.
            </span>
          </div>

          {finishError && <div className="qx-banner qx-banner--error">{finishError}</div>}

          <div>
            <button
              type="button"
              className="qx-btn qx-btn--sm qx-btn--primary"
              onClick={handleFinish}
              disabled={finishing || foldersLoading}
            >
              {finishing ? 'Saving…' : 'Continue to inbox'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="qx-stack" style={{ maxWidth: 860, margin: '0 auto', padding: '24px 0' }}>
      {/* Hero */}
      <div className="qx-card qx-stack qx-stack--tight" style={{ alignItems: 'center', textAlign: 'center', padding: '32px 24px' }}>
        <div className="qx-empty__icon" style={{ color: '#8fd6ff' }}>
          <MailIcon />
        </div>
        <span className="qx-section-title" style={{ fontSize: 18 }}>Connect a mailbox</span>
        <p className="qx-hint" style={{ maxWidth: 520 }}>
          InboxQ triages your mail into zones, writes you a daily tidy-up, and flags what needs you.
          Nothing is ever sent, moved, or blocked without your approval.
        </p>
      </div>

      {/* What you get */}
      <div className="qx-grid-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {WHAT_YOU_GET.map((item) => (
          <div key={item.title} className="qx-card qx-card--compact qx-stack qx-stack--tight">
            <strong>{item.title}</strong>
            <span className="qx-hint qx-hint--sm">{item.body}</span>
          </div>
        ))}
      </div>

      {/* 3-step strip */}
      <div className="qx-card qx-stack qx-stack--tight">
        <span className="qx-section-title">How it works</span>
        <div className="qx-row qx-row--wrap" style={{ gap: 20 }}>
          {STEPS.map((s) => (
            <div key={s.n} className="qx-row qx-row--tight" style={{ alignItems: 'flex-start', flex: '1 1 220px', minWidth: 200 }}>
              <span className="qx-pill qx-pill--xs qx-pill--ghost" style={{ flexShrink: 0 }}>{s.n}</span>
              <div className="qx-stack qx-stack--tight" style={{ gap: 2 }}>
                <strong style={{ fontSize: 13 }}>{s.title}</strong>
                <span className="qx-hint qx-hint--sm">{s.body}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Connect: a single control. allowCreate puts "add a new mailbox" inside
          the picker, so there is no confusing separate button. */}
      <div className="qx-card qx-stack qx-stack--tight">
        <span className="qx-section-title">Choose or add an email account</span>
        <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
          <CredentialPicker
            type="smtp"
            orgId={orgId}
            value={selectedCredentialId}
            onSelect={handleSelect}
            allowCreate
            showHealth
            onAddNew={() => setModalOpen(true)}
            placeholder="Choose or add an email account..."
          />
          {connecting && (
            <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <span className="qx-spinner qx-spinner--sm" aria-hidden="true" /> Connecting…
            </span>
          )}
        </div>

        {error && (
          <div className="qx-banner qx-banner--error">Could not connect: {error}</div>
        )}

        <span className="qx-hint qx-hint--sm">
          Your credentials are stored encrypted in the vault; InboxQ only reads mail and proposes actions.
          A new mailbox is added to the org you are viewing now.
        </span>
      </div>

      <IntegrationModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleModalSave}
        presetType="smtp"
      />
    </div>
  );
}

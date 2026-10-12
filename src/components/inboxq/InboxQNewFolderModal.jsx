/**
 * InboxQNewFolderModal — P1 manual sort: create a real IMAP folder on the
 * mail server for the active account. Deliberately minimal: one field, one
 * write (api.createFolder), the caller decides what "created" means for the
 * rest of the view (refreshing the account/folder list, toasting).
 */
import { useState } from 'react';
import { api } from './lib/api.js';

export default function InboxQNewFolderModal({ accountId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !accountId) return;
    setCreating(true);
    setError(null);
    try {
      const data = await api.createFolder({ accountId, name: trimmed });
      onCreated(data?.folder || trimmed);
    } catch (err) {
      setError(err?.body?.error || err.message || 'Could not create this folder.');
      setCreating(false);
    }
  };

  return (
    <div className="qx-modal-overlay" role="dialog" aria-modal="true" aria-label="New folder" onClick={onClose}>
      <div
        className="qx-modal qx-surface--backed"
        style={{ maxWidth: 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="qx-modal__header">
          <h3>New folder</h3>
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onClose}>Close</button>
        </div>
        <form className="qx-modal__body" onSubmit={handleCreate}>
          <p className="qx-modal__desc">Creates a real folder on this mailbox's mail server.</p>
          {error && <div className="qx-banner qx-banner--error">{error}</div>}
          <input
            type="text"
            className="qx-input"
            placeholder="Folder name, e.g. Archive"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            aria-label="Folder name"
            disabled={creating}
          />
          <div className="qx-modal__actions">
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onClose} disabled={creating}>
              Cancel
            </button>
            <button type="submit" className="qx-btn qx-btn--sm qx-btn--primary" disabled={creating || !name.trim()}>
              {creating ? 'Creating…' : 'Create folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

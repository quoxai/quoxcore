/**
 * VaultBulkActions — Bulk operations bar for vault credentials
 *
 * Shows when 1+ credentials are selected. Actions:
 * - Test All Selected
 * - Move to Folder (placeholder for Phase 7)
 * - Delete Selected
 * - Export (placeholder)
 * - Clear Selection
 */

import { useState, useCallback } from 'react';
import { csrfFetch } from '../../utils/csrfFetch';
import { VAULT_DELETE, VAULT_TEST } from '../../config/apiPaths';
import './vault.css';

const TestIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
);

const TrashIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
);

const FolderIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
);

const DownloadIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);

const XIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

export default function VaultBulkActions({
    selectedIds,
    orgId,
    resolveOrgId,
    onClearSelection,
    onDeleteSuccess,
    onTestComplete,
    showNotification,
}) {
    const [deleting, setDeleting] = useState(false);
    const [testing, setTesting] = useState(false);

    const count = selectedIds.size;

    const handleBulkDelete = useCallback(async () => {
        if (count === 0) return;
        if (!confirm(`Delete ${count} credential(s)? This cannot be undone.`)) return;

        setDeleting(true);
        let successCount = 0;
        let failCount = 0;

        for (const id of selectedIds) {
            try {
                const oid = resolveOrgId ? resolveOrgId(id) : orgId;
                const response = await csrfFetch(VAULT_DELETE(oid, id), {
                    method: 'DELETE'
                });
                if (response.ok) successCount++;
                else failCount++;
            } catch {
                failCount++;
            }
        }

        setDeleting(false);
        onDeleteSuccess(selectedIds);
        onClearSelection();

        if (failCount === 0) {
            showNotification(`Deleted ${successCount} credential(s)`, 'success');
        } else {
            showNotification(`Deleted ${successCount}, failed ${failCount}`, 'error');
        }
    }, [count, selectedIds, orgId, resolveOrgId, onDeleteSuccess, onClearSelection, showNotification]);

    const handleBulkTest = useCallback(async () => {
        if (count === 0) return;
        setTesting(true);
        let successCount = 0;
        let failCount = 0;

        for (const id of selectedIds) {
            try {
                const oid = resolveOrgId ? resolveOrgId(id) : orgId;
                const response = await csrfFetch(VAULT_TEST(oid, id), {
                    method: 'POST'
                });
                const data = await response.json();
                if (data.success) successCount++;
                else failCount++;
                onTestComplete(id, data.success ? 'success' : 'failed');
            } catch {
                failCount++;
            }
        }

        setTesting(false);
        showNotification(
            `Tested ${successCount + failCount}: ${successCount} passed, ${failCount} failed`,
            successCount > failCount ? 'success' : 'error'
        );
    }, [count, selectedIds, orgId, resolveOrgId, onTestComplete, showNotification]);

    if (count === 0) return null;

    return (
        <div className="vault-bulk-bar">
            <span className="vault-bulk-bar__count">{count} selected</span>
            <div className="vault-bulk-bar__actions">
                <button
                    className="vault-bulk-bar__btn"
                    onClick={handleBulkTest}
                    disabled={testing}
                >
                    <TestIcon /> {testing ? 'Testing...' : 'Test Selected'}
                </button>
                <button className="vault-bulk-bar__btn" disabled title="Coming in Phase 7">
                    <FolderIcon /> Move to Folder
                </button>
                <button className="vault-bulk-bar__btn" disabled title="Coming soon">
                    <DownloadIcon /> Export
                </button>
                <button
                    className="vault-bulk-bar__btn vault-bulk-bar__btn--danger"
                    onClick={handleBulkDelete}
                    disabled={deleting}
                >
                    <TrashIcon /> {deleting ? 'Deleting...' : 'Delete'}
                </button>
            </div>
            <button className="vault-bulk-bar__close" onClick={onClearSelection}>
                <XIcon /> Clear
            </button>
        </div>
    );
}

/**
 * VaultFoldersView — QuoxVault Folder Organization
 *
 * Folder management at /vault/folders.
 * Create, edit, delete credential folders. View credentials per folder.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import FolderTree from '../../components/vault/FolderTree';
import FolderModal from '../../components/vault/FolderModal';
import { csrfFetch } from '../../utils/csrfFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { VAULT_LIST, VAULT_FOLDERS, VAULT_FOLDER } from '../../config/apiPaths';
import '../../components/vault/vault.css';

const folderIcon = (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
);

const plusIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

export default function VaultFoldersView() {
    const navigate = useNavigate();
    const { currentOrg } = useWorkspace();
    const orgId = currentOrg?.id;

    const [folders, setFolders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedFolder, setSelectedFolder] = useState(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingFolder, setEditingFolder] = useState(null);
    const [folderCredentials, setFolderCredentials] = useState([]);
    const [credsLoading, setCredsLoading] = useState(false);

    const fetchFolders = useCallback(async () => {
        if (!orgId) { setLoading(false); return; }
        try {
            const res = await fetch(VAULT_FOLDERS(orgId), { credentials: 'include' });
            if (res.ok) {
                const data = await res.json();
                setFolders(data.folders || []);
            }
        } catch {
            // silently fail
        } finally {
            setLoading(false);
        }
    }, [orgId]);

    useEffect(() => { fetchFolders(); }, [fetchFolders]);

    // Fetch credentials for selected folder
    useEffect(() => {
        if (!selectedFolder || !orgId) {
            setFolderCredentials([]);
            return;
        }
        setCredsLoading(true);
        fetch(`${VAULT_LIST(orgId)}?folder_id=${selectedFolder.id}`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : { credentials: [] })
            .then(data => setFolderCredentials(data.credentials || []))
            .catch(() => setFolderCredentials([]))
            .finally(() => setCredsLoading(false));
    }, [selectedFolder, orgId]);

    const handleCreateFolder = async (data) => {
        const res = await csrfFetch(VAULT_FOLDERS(orgId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message || 'Failed to create folder');
        }
        fetchFolders();
    };

    const handleUpdateFolder = async (data) => {
        const res = await csrfFetch(VAULT_FOLDER(orgId, editingFolder.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message || 'Failed to update folder');
        }
        fetchFolders();
        if (selectedFolder?.id === editingFolder.id) {
            setSelectedFolder(null);
        }
    };

    const handleDeleteFolder = async (folder) => {
        if (!confirm(`Delete folder "${folder.name}"? Credentials will be moved to no folder.`)) return;
        try {
            await csrfFetch(VAULT_FOLDER(orgId, folder.id), { method: 'DELETE' });
            fetchFolders();
            if (selectedFolder?.id === folder.id) {
                setSelectedFolder(null);
            }
        } catch {
            // silently fail
        }
    };

    const handleEdit = (folder) => {
        setEditingFolder(folder);
        setModalOpen(true);
    };

    const handleNew = () => {
        setEditingFolder(null);
        setModalOpen(true);
    };

    if (loading) {
        return (
            <div className="vault-page">
                <div className="vault-page__header">
                    <div className="vault-page__title-row">
                        <span className="vault-page__icon">{folderIcon}</span>
                        <h1 className="vault-page__title">Credential Folders</h1>
                    </div>
                </div>
                <div className="vault-dashboard__loading">Loading folders...</div>
            </div>
        );
    }

    return (
        <div className="vault-page">
            <div className="vault-page__header">
                <div className="vault-page__title-row">
                    <span className="vault-page__icon">{folderIcon}</span>
                    <h1 className="vault-page__title">Credential Folders</h1>
                    <span className="vault-dashboard__badge">{folders.length} folders</span>
                </div>
                <div className="vault-page__actions">
                    <button className="vault-btn vault-btn--primary" onClick={handleNew}>
                        {plusIcon}
                        New Folder
                    </button>
                </div>
            </div>

            {folders.length === 0 ? (
                <div className="vault-placeholder">
                    <div className="vault-placeholder__icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                    </div>
                    <h2 className="vault-placeholder__title">No folders yet</h2>
                    <p className="vault-placeholder__text">
                        Organise your credentials into folders for easier management and access control.
                    </p>
                    <button className="vault-btn vault-btn--primary" onClick={handleNew}>
                        {plusIcon}
                        Create First Folder
                    </button>
                </div>
            ) : (
                <div className="vault-folders-layout">
                    {/* Folder tree panel */}
                    <div className="vault-folders-layout__tree">
                        <div className="vault-card">
                            <div className="vault-card__header">
                                <span className="vault-card__title">Folders</span>
                            </div>
                            <FolderTree
                                folders={folders}
                                selectedId={selectedFolder?.id}
                                onSelect={setSelectedFolder}
                                onEdit={handleEdit}
                                onDelete={handleDeleteFolder}
                            />
                        </div>
                    </div>

                    {/* Folder details panel */}
                    <div className="vault-folders-layout__detail">
                        {selectedFolder ? (
                            <div className="vault-card">
                                <div className="vault-card__header">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill={selectedFolder.color || '#6b7280'} stroke={selectedFolder.color || '#6b7280'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                    </svg>
                                    <span className="vault-card__title">{selectedFolder.name}</span>
                                    <span className="vault-card__badge">{folderCredentials.length} credentials</span>
                                </div>
                                {credsLoading ? (
                                    <div className="vault-empty-state">Loading...</div>
                                ) : folderCredentials.length === 0 ? (
                                    <div className="vault-empty-state">
                                        No credentials in this folder.
                                        <button
                                            className="vault-card__link"
                                            onClick={() => navigate('/vault/credentials')}
                                            style={{ marginLeft: 8 }}
                                        >
                                            Assign credentials
                                        </button>
                                    </div>
                                ) : (
                                    <div className="vault-folder-creds">
                                        {folderCredentials.map(cred => (
                                            <div key={cred.id} className="vault-folder-cred-row">
                                                <span className="vault-folder-cred-row__type">{cred.integration_type}</span>
                                                <span className="vault-folder-cred-row__label">{cred.label}</span>
                                                <span className="vault-folder-cred-row__preview">{cred.key_preview}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="vault-card">
                                <div className="vault-empty-state">
                                    Select a folder to view its credentials.
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <FolderModal
                isOpen={modalOpen}
                onClose={() => { setModalOpen(false); setEditingFolder(null); }}
                onSave={editingFolder ? handleUpdateFolder : handleCreateFolder}
                folder={editingFolder}
                folders={folders}
            />
        </div>
    );
}

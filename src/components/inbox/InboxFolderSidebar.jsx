/**
 * InboxFolderSidebar — Smart folder navigation for inbox
 *
 * Follows SettingsSidebar.jsx pattern: 240px sidebar, grouped items,
 * active indicator, icons, badge counts.
 */

import { useCallback } from 'react';
import { INBOX_FOLDERS, FOLDER_GROUPS } from './inboxFolders';
import './inbox-layout.css';

// Folder icons (14px inline SVGs)
const folderIcons = {
    inbox: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
        </svg>
    ),
    zap: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
    ),
    user: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
    ),
    check: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
        </svg>
    ),
    help: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
    ),
    target: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
        </svg>
    ),
    info: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
    ),
    star: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
    ),
    clock: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
    ),
    layers: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>
        </svg>
    ),
    archive: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>
        </svg>
    ),
};

export default function InboxFolderSidebar({ activeFolder, onFolderChange, folderCounts = {}, isOpen = false }) {
    const handleClick = useCallback((folderId) => {
        onFolderChange(folderId);
    }, [onFolderChange]);

    return (
        <nav className={`inbox-folder-sidebar${isOpen ? ' inbox-folder-sidebar--open' : ''}`} role="navigation" aria-label="Inbox folders">
            {FOLDER_GROUPS.map(group => {
                const foldersInGroup = INBOX_FOLDERS.filter(f => f.group === group.id);
                if (foldersInGroup.length === 0) return null;

                return (
                    <div key={group.id} className="inbox-folder-sidebar__group">
                        {group.label && (
                            <div className="inbox-folder-sidebar__group-label">{group.label}</div>
                        )}
                        {foldersInGroup.map(folder => {
                            const isActive = activeFolder === folder.id;
                            const count = folderCounts[folder.id] ?? 0;
                            const icon = folderIcons[folder.icon];

                            return (
                                <button
                                    key={folder.id}
                                    className={`inbox-folder-sidebar__item${isActive ? ' inbox-folder-sidebar__item--active' : ''}`}
                                    onClick={() => handleClick(folder.id)}
                                    aria-current={isActive ? 'true' : undefined}
                                >
                                    <span className="inbox-folder-sidebar__icon">{icon}</span>
                                    <span className="inbox-folder-sidebar__label">{folder.label}</span>
                                    {count > 0 && (
                                        <span className="inbox-folder-sidebar__badge">{count > 99 ? '99+' : count}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                );
            })}
        </nav>
    );
}

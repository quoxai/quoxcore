/**
 * FolderTree — Recursive folder tree for vault credential organization
 */

import { useMemo } from 'react';

const folderSvg = (color = '#6b7280') => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={color} stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
    </svg>
);

const editSvg = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
);

const trashSvg = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
);

function FolderNode({ folder, children, selectedId, onSelect, onEdit, onDelete, depth = 0 }) {
    const isSelected = selectedId === folder.id;

    return (
        <div className="folder-tree__node" style={{ paddingLeft: depth * 16 }}>
            <button
                className={`folder-tree__item ${isSelected ? 'folder-tree__item--selected' : ''}`}
                onClick={() => onSelect(folder)}
            >
                <span className="folder-tree__icon">{folderSvg(folder.color)}</span>
                <span className="folder-tree__name">{folder.name}</span>
                <span className="folder-tree__count">{folder.credential_count || 0}</span>
            </button>
            <div className="folder-tree__actions">
                <button className="folder-tree__action-btn" onClick={(e) => { e.stopPropagation(); onEdit(folder); }} title="Edit">
                    {editSvg}
                </button>
                <button className="folder-tree__action-btn folder-tree__action-btn--danger" onClick={(e) => { e.stopPropagation(); onDelete(folder); }} title="Delete">
                    {trashSvg}
                </button>
            </div>
            {children?.length > 0 && (
                <div className="folder-tree__children">
                    {children.map(child => (
                        <FolderNode
                            key={child.id}
                            folder={child}
                            children={child.children}
                            selectedId={selectedId}
                            onSelect={onSelect}
                            onEdit={onEdit}
                            onDelete={onDelete}
                            depth={depth + 1}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function FolderTree({ folders = [], selectedId, onSelect, onEdit, onDelete }) {
    // Build tree structure
    const tree = useMemo(() => {
        const map = {};
        const roots = [];

        // Index all folders
        for (const f of folders) {
            map[f.id] = { ...f, children: [] };
        }

        // Build parent-child relationships
        for (const f of folders) {
            if (f.parent_id && map[f.parent_id]) {
                map[f.parent_id].children.push(map[f.id]);
            } else {
                roots.push(map[f.id]);
            }
        }

        return roots;
    }, [folders]);

    if (!folders.length) {
        return (
            <div className="folder-tree__empty">
                No folders yet. Create one to organize your credentials.
            </div>
        );
    }

    return (
        <div className="folder-tree">
            {tree.map(folder => (
                <FolderNode
                    key={folder.id}
                    folder={folder}
                    children={folder.children}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    onEdit={onEdit}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
}

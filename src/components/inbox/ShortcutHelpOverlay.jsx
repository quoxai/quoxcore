/**
 * ShortcutHelpOverlay — Modal showing all inbox keyboard shortcuts
 *
 * Triggered by `?` key.
 */

import { useEffect } from 'react';

const SHORTCUT_GROUPS = [
    {
        title: 'Navigation',
        shortcuts: [
            { keys: ['j'], description: 'Next item' },
            { keys: ['k'], description: 'Previous item' },
            { keys: ['Enter'], description: 'Open focused item' },
            { keys: ['Esc'], description: 'Clear selection / close' },
        ]
    },
    {
        title: 'Actions',
        shortcuts: [
            { keys: ['s'], description: 'Star / unstar' },
            { keys: ['e'], description: 'Archive' },
            { keys: ['h'], description: 'Snooze' },
            { keys: ['#'], description: 'Delete' },
            { keys: ['x'], description: 'Select / deselect' },
        ]
    },
    {
        title: 'Approvals',
        shortcuts: [
            { keys: ['a'], description: 'Approve' },
            { keys: ['d'], description: 'Deny' },
        ]
    },
    {
        title: 'Other',
        shortcuts: [
            { keys: ['?'], description: 'Show this help' },
        ]
    }
];

export default function ShortcutHelpOverlay({ isOpen, onClose }) {
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e) => {
            if (e.key === 'Escape' || e.key === '?') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    return (
        <div className="shortcut-overlay" onClick={onClose}>
            <div className="shortcut-overlay__modal" onClick={(e) => e.stopPropagation()}>
                <div className="shortcut-overlay__header">
                    <h3>Keyboard Shortcuts</h3>
                    <button className="shortcut-overlay__close" onClick={onClose} aria-label="Close">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div className="shortcut-overlay__grid">
                    {SHORTCUT_GROUPS.map(group => (
                        <div key={group.title} className="shortcut-overlay__group">
                            <h4 className="shortcut-overlay__group-title">{group.title}</h4>
                            {group.shortcuts.map(shortcut => (
                                <div key={shortcut.keys.join('+')} className="shortcut-overlay__row">
                                    <span className="shortcut-overlay__keys">
                                        {shortcut.keys.map(key => (
                                            <kbd key={key} className="shortcut-overlay__kbd">{key}</kbd>
                                        ))}
                                    </span>
                                    <span className="shortcut-overlay__desc">{shortcut.description}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export { SHORTCUT_GROUPS };

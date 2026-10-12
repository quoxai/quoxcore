/**
 * FolderModal — Create/edit credential folder
 */

import { useState, useEffect } from 'react';
import Modal from '../ui/Modal';

const FOLDER_COLORS = [
    { value: '#6b7280', label: 'Gray' },
    { value: '#3b82f6', label: 'Blue' },
    { value: '#10b981', label: 'Green' },
    { value: '#f59e0b', label: 'Amber' },
    { value: '#ef4444', label: 'Red' },
    { value: '#8b5cf6', label: 'Purple' },
    { value: '#ec4899', label: 'Pink' },
    { value: '#06b6d4', label: 'Cyan' },
];

export default function FolderModal({ isOpen, onClose, onSave, folder, folders = [] }) {
    const [name, setName] = useState('');
    const [color, setColor] = useState('#6b7280');
    const [parentId, setParentId] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const isEdit = !!folder;

    useEffect(() => {
        if (folder) {
            setName(folder.name || '');
            setColor(folder.color || '#6b7280');
            setParentId(folder.parent_id || '');
        } else {
            setName('');
            setColor('#6b7280');
            setParentId('');
        }
        setError('');
    }, [folder, isOpen]);

    // Filter out this folder and its children from parent options to prevent cycles
    const parentOptions = folders.filter(f => {
        if (!folder) return true;
        if (f.id === folder.id) return false;
        // Simple cycle prevention: don't allow children of this folder
        let current = f;
        while (current?.parent_id) {
            if (current.parent_id === folder.id) return false;
            current = folders.find(p => p.id === current.parent_id);
        }
        return true;
    });

    const handleSave = async () => {
        if (!name.trim()) {
            setError('Folder name is required');
            return;
        }
        setSaving(true);
        setError('');
        try {
            await onSave({
                name: name.trim(),
                color,
                parent_id: parentId || null,
                icon: 'folder',
            });
            onClose();
        } catch (err) {
            setError(err.message || 'Failed to save folder');
        } finally {
            setSaving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose}>
            <Modal.Header>
                <h3 className="modal-title">{isEdit ? 'Edit Folder' : 'New Folder'}</h3>
            </Modal.Header>
            <Modal.Body>
                {error && <div className="vault-error">{error}</div>}
                <div className="vault-form-field">
                    <label className="vault-form-field__label">Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="e.g., Production, EU Region"
                        className="vault-form-field__input"
                        autoFocus
                    />
                </div>
                <div className="vault-form-field">
                    <label className="vault-form-field__label">Color</label>
                    <div className="vault-color-picker">
                        {FOLDER_COLORS.map(c => (
                            <button
                                key={c.value}
                                className={`vault-color-picker__swatch ${color === c.value ? 'vault-color-picker__swatch--active' : ''}`}
                                style={{ backgroundColor: c.value }}
                                onClick={() => setColor(c.value)}
                                title={c.label}
                            />
                        ))}
                    </div>
                </div>
                <div className="vault-form-field">
                    <label className="vault-form-field__label">Parent Folder</label>
                    <select
                        value={parentId}
                        onChange={e => setParentId(e.target.value)}
                        className="vault-form-field__select"
                    >
                        <option value="">None (root level)</option>
                        {parentOptions.map(f => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                    </select>
                </div>
            </Modal.Body>
            <Modal.Footer>
                <button className="vault-btn vault-btn--secondary" onClick={onClose} disabled={saving}>
                    Cancel
                </button>
                <button className="vault-btn vault-btn--primary" onClick={handleSave} disabled={saving || !name.trim()}>
                    {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Folder'}
                </button>
            </Modal.Footer>
        </Modal>
    );
}

/**
 * SnoozeMenu — Dropdown with snooze time presets
 *
 * Presets: 1 hour, 3 hours, Tomorrow 9am, Next week, Custom datetime
 */

import { useState, useRef, useEffect } from 'react';

/**
 * Compute snooze target dates
 */
export function getSnoozePresets() {
    const now = new Date();

    // 1 hour from now
    const oneHour = new Date(now.getTime() + 60 * 60 * 1000);

    // 3 hours from now
    const threeHours = new Date(now.getTime() + 3 * 60 * 60 * 1000);

    // Tomorrow at 9:00 AM
    const tomorrow9am = new Date(now);
    tomorrow9am.setDate(tomorrow9am.getDate() + 1);
    tomorrow9am.setHours(9, 0, 0, 0);

    // Next Monday at 9:00 AM
    const nextWeek = new Date(now);
    const daysUntilMonday = ((1 - nextWeek.getDay() + 7) % 7) || 7;
    nextWeek.setDate(nextWeek.getDate() + daysUntilMonday);
    nextWeek.setHours(9, 0, 0, 0);

    return [
        { label: '1 hour', value: oneHour.toISOString(), icon: '1h' },
        { label: '3 hours', value: threeHours.toISOString(), icon: '3h' },
        { label: 'Tomorrow 9am', value: tomorrow9am.toISOString(), icon: 'AM' },
        { label: 'Next week', value: nextWeek.toISOString(), icon: 'Wk' },
    ];
}

export default function SnoozeMenu({ onSnooze, onClose }) {
    const [showCustom, setShowCustom] = useState(false);
    const [customDate, setCustomDate] = useState('');
    const [customTime, setCustomTime] = useState('09:00');
    const menuRef = useRef(null);

    const presets = getSnoozePresets();

    // Close on click outside
    useEffect(() => {
        function handleClickOutside(e) {
            if (menuRef.current && !menuRef.current.contains(e.target)) {
                onClose?.();
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    const [customError, setCustomError] = useState('');

    const handleCustomSubmit = () => {
        if (!customDate) return;
        // Parse date/time components explicitly to avoid cross-browser timezone issues
        const [year, month, day] = customDate.split('-').map(Number);
        const [hours, minutes] = (customTime || '09:00').split(':').map(Number);
        const dateTime = new Date(year, month - 1, day, hours, minutes, 0);
        if (dateTime > new Date()) {
            setCustomError('');
            onSnooze(dateTime.toISOString());
        } else {
            setCustomError('Pick a time in the future');
        }
    };

    return (
        <div className="snooze-menu" ref={menuRef}>
            <div className="snooze-menu__header">Snooze until</div>
            {presets.map(preset => (
                <button
                    key={preset.label}
                    className="snooze-menu__item"
                    onClick={() => onSnooze(preset.value)}
                >
                    <span className="snooze-menu__item-icon">{preset.icon}</span>
                    <span>{preset.label}</span>
                </button>
            ))}
            <div className="snooze-menu__divider" />
            {!showCustom ? (
                <button className="snooze-menu__item" onClick={() => setShowCustom(true)}>
                    <span className="snooze-menu__item-icon">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                        </svg>
                    </span>
                    <span>Custom...</span>
                </button>
            ) : (
                <div className="snooze-menu__custom">
                    <input
                        type="date"
                        value={customDate}
                        onChange={(e) => setCustomDate(e.target.value)}
                        min={new Date().toISOString().split('T')[0]}
                        className="snooze-menu__input"
                    />
                    <input
                        type="time"
                        value={customTime}
                        onChange={(e) => setCustomTime(e.target.value)}
                        className="snooze-menu__input"
                    />
                    <button className="snooze-menu__submit" onClick={handleCustomSubmit} disabled={!customDate}>
                        Set
                    </button>
                    {customError && <div className="snooze-menu__error">{customError}</div>}
                </div>
            )}
        </div>
    );
}

/**
 * ScheduleEditModal - Human-first schedule editor
 *
 * Features:
 * - Frequency picker (primary interaction — large preset buttons)
 * - Time picker (hour/minute dropdowns for daily/weekdays/weekly/monthly)
 * - Day-of-week / day-of-month selectors
 * - Human-readable summary (prominent green text)
 * - Timezone selector
 * - Active/Paused toggle
 * - Advanced: custom cron expression (collapsible, hidden by default)
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Input } from '../ui/Input';
import { cronToHuman } from '../../services/cronHelper';

// Icons
const ScheduleIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
    </svg>
);

// Frequency options with their base cron templates
const FREQUENCIES = [
    { id: 'every15', label: 'Every 15 min', expression: '*/15 * * * *', needsTime: false },
    { id: 'hourly',  label: 'Every hour',   expression: '0 * * * *',    needsTime: false },
    { id: 'daily',   label: 'Daily',        expression: '0 9 * * *',    needsTime: true },
    { id: 'weekdays',label: 'Weekdays',     expression: '0 8 * * 1-5',  needsTime: true },
    { id: 'weekly',  label: 'Weekly',        expression: '0 9 * * 1',    needsTime: true, needsDow: true },
    { id: 'monthly', label: 'Monthly',       expression: '0 9 1 * *',    needsTime: true, needsDom: true },
];

const DAYS_OF_WEEK = [
    { value: 0, short: 'Sun' },
    { value: 1, short: 'Mon' },
    { value: 2, short: 'Tue' },
    { value: 3, short: 'Wed' },
    { value: 4, short: 'Thu' },
    { value: 5, short: 'Fri' },
    { value: 6, short: 'Sat' },
];

// Common timezones (sorted)
const COMMON_TIMEZONES = (() => {
    try {
        return Intl.supportedValuesOf('timeZone');
    } catch {
        return [
            'UTC',
            'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
            'Europe/London', 'Europe/Paris', 'Europe/Berlin',
            'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
            'Australia/Sydney', 'Pacific/Auckland',
        ];
    }
})();

/**
 * Parse a cron expression into { frequencyId, hour, minute, dow, dom }.
 * Returns null for frequencyId if no preset matches.
 */
function parseCron(expr) {
    if (!expr) return { frequencyId: null, hour: 9, minute: 0, dow: 1, dom: 1 };
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5) return { frequencyId: null, hour: 9, minute: 0, dow: 1, dom: 1 };

    const [min, hour, dom, , dow] = parts;

    // Try to match a frequency
    if (min === '*/15' && hour === '*') return { frequencyId: 'every15', hour: 0, minute: 0, dow: 1, dom: 1 };
    if (min === '0' && hour === '*') return { frequencyId: 'hourly', hour: 0, minute: 0, dow: 1, dom: 1 };
    if (dow === '1-5' && dom === '*') return { frequencyId: 'weekdays', hour: parseInt(hour) || 0, minute: parseInt(min) || 0, dow: 1, dom: 1 };
    if (dom !== '*' && dow === '*') return { frequencyId: 'monthly', hour: parseInt(hour) || 0, minute: parseInt(min) || 0, dow: 1, dom: parseInt(dom) || 1 };
    if (dow !== '*' && dom === '*') {
        const dowVal = parseInt(dow);
        if (!isNaN(dowVal)) return { frequencyId: 'weekly', hour: parseInt(hour) || 0, minute: parseInt(min) || 0, dow: dowVal, dom: 1 };
    }
    if (dow === '*' && dom === '*' && hour !== '*') return { frequencyId: 'daily', hour: parseInt(hour) || 0, minute: parseInt(min) || 0, dow: 1, dom: 1 };

    return { frequencyId: null, hour: parseInt(hour) || 0, minute: parseInt(min) || 0, dow: 1, dom: 1 };
}

/**
 * Build a cron expression from structured values.
 */
function buildCron(frequencyId, hour, minute, dow, dom) {
    const hh = String(hour);
    const mm = String(minute);
    switch (frequencyId) {
        case 'every15':  return '*/15 * * * *';
        case 'hourly':   return '0 * * * *';
        case 'daily':    return `${mm} ${hh} * * *`;
        case 'weekdays': return `${mm} ${hh} * * 1-5`;
        case 'weekly':   return `${mm} ${hh} * * ${dow}`;
        case 'monthly':  return `${mm} ${hh} ${dom} * *`;
        default:         return '';
    }
}

export default function ScheduleEditModal({
    isOpen,
    onClose,
    onSubmit,
    schedule = null,
    loading = false
}) {
    const [expression, setExpression] = useState('');
    const [timezone, setTimezone] = useState('UTC');
    const [paused, setPaused] = useState(false);
    const [errors, setErrors] = useState({});
    const [showAdvanced, setShowAdvanced] = useState(false);

    // Structured state for the visual picker
    const [frequencyId, setFrequencyId] = useState(null);
    const [hour, setHour] = useState(9);
    const [minute, setMinute] = useState(0);
    const [dow, setDow] = useState(1);  // day of week (0-6)
    const [dom, setDom] = useState(1);  // day of month (1-28)

    // Reset form when modal opens
    useEffect(() => {
        if (isOpen && schedule) {
            const expr = schedule.expression || '';
            setExpression(expr);
            setTimezone(schedule.timezone || 'UTC');
            setPaused(!schedule.active);
            setErrors({});

            // Parse into structured values
            const parsed = parseCron(expr);
            setFrequencyId(parsed.frequencyId);
            setHour(parsed.hour);
            setMinute(parsed.minute);
            setDow(parsed.dow);
            setDom(parsed.dom);

            // If expression doesn't match any preset, show advanced by default
            setShowAdvanced(parsed.frequencyId === null && expr.trim().length > 0);
        }
    }, [isOpen, schedule?.workflowId, schedule?.nodeId]);

    // When structured values change, rebuild the cron expression
    const updateFromPicker = useCallback((newFreqId, newHour, newMinute, newDow, newDom) => {
        const cron = buildCron(newFreqId, newHour, newMinute, newDow, newDom);
        if (cron) {
            setExpression(cron);
            if (errors.expression) setErrors(prev => ({ ...prev, expression: null }));
        }
    }, [errors.expression]);

    const handleFrequencyChange = (id) => {
        setFrequencyId(id);
        // When switching to a frequency that has a preset, use its default time if currently 0
        const freq = FREQUENCIES.find(f => f.id === id);
        if (freq) {
            const parsed = parseCron(freq.expression);
            const newHour = freq.needsTime ? hour : parsed.hour;
            const newMinute = freq.needsTime ? minute : parsed.minute;
            updateFromPicker(id, newHour, newMinute, dow, dom);
        }
    };

    const handleHourChange = (h) => {
        setHour(h);
        updateFromPicker(frequencyId, h, minute, dow, dom);
    };

    const handleMinuteChange = (m) => {
        setMinute(m);
        updateFromPicker(frequencyId, hour, m, dow, dom);
    };

    const handleDowChange = (d) => {
        setDow(d);
        updateFromPicker(frequencyId, hour, minute, d, dom);
    };

    const handleDomChange = (d) => {
        setDom(d);
        updateFromPicker(frequencyId, hour, minute, dow, d);
    };

    // When advanced cron input changes, try to re-parse into structured values
    const handleAdvancedCronChange = (value) => {
        setExpression(value);
        if (errors.expression) setErrors(prev => ({ ...prev, expression: null }));
        const parsed = parseCron(value);
        if (parsed.frequencyId) {
            setFrequencyId(parsed.frequencyId);
            setHour(parsed.hour);
            setMinute(parsed.minute);
            setDow(parsed.dow);
            setDom(parsed.dom);
        } else {
            setFrequencyId(null);
        }
    };

    // Current frequency config
    const currentFreq = FREQUENCIES.find(f => f.id === frequencyId);

    // Live preview
    const humanPreview = useMemo(() => {
        if (!expression.trim()) return '';
        return cronToHuman(expression);
    }, [expression]);

    const validate = () => {
        const newErrors = {};
        if (!expression.trim()) {
            newErrors.expression = 'Please select a schedule frequency';
        } else {
            const parts = expression.trim().split(/\s+/);
            if (parts.length < 5 || parts.length > 6) {
                newErrors.expression = 'Invalid cron expression';
            }
        }
        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!validate()) return;

        try {
            await onSubmit({
                workflowId: schedule.workflowId,
                nodeId: schedule.nodeId,
                expression: expression.trim(),
                timezone,
                paused,
            });
        } catch (err) {
            setErrors({ submit: err.message || 'Failed to save changes' });
        }
    };

    const handleClose = () => {
        if (!loading) onClose();
    };

    // Generate hour options (0-23)
    const hourOptions = Array.from({ length: 24 }, (_, i) => i);
    // Generate minute options (0, 5, 10, ... 55)
    const minuteOptions = Array.from({ length: 12 }, (_, i) => i * 5);

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            size="md"
            closeOnOverlay={!loading}
            closeOnEscape={!loading}
        >
            <Modal.Header
                title="Edit Schedule"
                description={schedule ? `${schedule.workflowId}:${schedule.nodeId}` : 'Update schedule configuration'}
                icon={<ScheduleIcon />}
                onClose={!loading ? handleClose : undefined}
            />

            <form onSubmit={handleSubmit}>
                <Modal.Body>
                    {errors.submit && (
                        <div style={{
                            padding: '0.75rem 1rem',
                            background: 'rgba(239, 68, 68, 0.08)',
                            borderRadius: '8px',
                            borderLeft: '3px solid var(--color-danger, #ef4444)',
                            fontSize: '0.8rem',
                            color: 'var(--color-danger, #ef4444)',
                            marginBottom: '1rem'
                        }}>
                            {errors.submit}
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                        {/* 1. Frequency Selector — primary interaction */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label">Schedule Frequency</label>
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(3, 1fr)',
                                gap: '0.5rem',
                            }}>
                                {FREQUENCIES.map(freq => (
                                    <button
                                        key={freq.id}
                                        type="button"
                                        onClick={() => handleFrequencyChange(freq.id)}
                                        disabled={loading}
                                        style={{
                                            padding: '0.625rem 0.75rem',
                                            borderRadius: '8px',
                                            border: frequencyId === freq.id
                                                ? '2px solid var(--color-primary, #6366f1)'
                                                : '1px solid rgba(255, 255, 255, 0.1)',
                                            background: frequencyId === freq.id
                                                ? 'rgba(99, 102, 241, 0.12)'
                                                : 'rgba(255, 255, 255, 0.03)',
                                            color: frequencyId === freq.id
                                                ? 'var(--color-primary, #818cf8)'
                                                : 'var(--text-secondary, #ccc)',
                                            cursor: loading ? 'not-allowed' : 'pointer',
                                            fontSize: '0.85rem',
                                            fontWeight: frequencyId === freq.id ? 600 : 400,
                                            transition: 'all 0.15s ease',
                                            textAlign: 'center',
                                        }}
                                    >
                                        {freq.label}
                                    </button>
                                ))}
                            </div>
                            {errors.expression && !showAdvanced && (
                                <span className="agent-config-field__error" style={{ marginTop: '0.5rem' }}>
                                    {errors.expression}
                                </span>
                            )}
                        </div>

                        {/* 2. Time Picker — shown for daily/weekdays/weekly/monthly */}
                        {currentFreq?.needsTime && (
                            <div className="agent-config-field">
                                <label className="agent-config-field__label">Time</label>
                                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    <select
                                        value={hour}
                                        onChange={(e) => handleHourChange(parseInt(e.target.value))}
                                        disabled={loading}
                                        className="agent-config-select"
                                        style={{ width: 80 }}
                                    >
                                        {hourOptions.map(h => (
                                            <option key={h} value={h}>{String(h).padStart(2, '0')}</option>
                                        ))}
                                    </select>
                                    <span style={{ color: 'var(--text-muted, #666)', fontSize: '1.1rem', fontWeight: 600 }}>:</span>
                                    <select
                                        value={minute}
                                        onChange={(e) => handleMinuteChange(parseInt(e.target.value))}
                                        disabled={loading}
                                        className="agent-config-select"
                                        style={{ width: 80 }}
                                    >
                                        {minuteOptions.map(m => (
                                            <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        )}

                        {/* Day-of-week selector for Weekly */}
                        {currentFreq?.needsDow && (
                            <div className="agent-config-field">
                                <label className="agent-config-field__label">Day of Week</label>
                                <div style={{ display: 'flex', gap: '0.375rem' }}>
                                    {DAYS_OF_WEEK.map(d => (
                                        <button
                                            key={d.value}
                                            type="button"
                                            onClick={() => handleDowChange(d.value)}
                                            disabled={loading}
                                            style={{
                                                flex: 1,
                                                padding: '0.5rem 0',
                                                borderRadius: '6px',
                                                border: dow === d.value
                                                    ? '2px solid var(--color-primary, #6366f1)'
                                                    : '1px solid rgba(255, 255, 255, 0.1)',
                                                background: dow === d.value
                                                    ? 'rgba(99, 102, 241, 0.12)'
                                                    : 'rgba(255, 255, 255, 0.03)',
                                                color: dow === d.value
                                                    ? 'var(--color-primary, #818cf8)'
                                                    : 'var(--text-secondary, #ccc)',
                                                cursor: loading ? 'not-allowed' : 'pointer',
                                                fontSize: '0.8rem',
                                                fontWeight: dow === d.value ? 600 : 400,
                                                transition: 'all 0.15s ease',
                                                textAlign: 'center',
                                            }}
                                        >
                                            {d.short}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Day-of-month selector for Monthly */}
                        {currentFreq?.needsDom && (
                            <div className="agent-config-field">
                                <label className="agent-config-field__label">Day of Month</label>
                                <select
                                    value={dom}
                                    onChange={(e) => handleDomChange(parseInt(e.target.value))}
                                    disabled={loading}
                                    className="agent-config-select"
                                    style={{ width: 100 }}
                                >
                                    {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                                        <option key={d} value={d}>{d}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* 3. Human-readable summary */}
                        {humanPreview && (
                            <div style={{
                                padding: '0.75rem 1rem',
                                background: 'rgba(34, 197, 94, 0.08)',
                                borderRadius: '8px',
                                border: '1px solid rgba(34, 197, 94, 0.15)',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                            }}>
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--color-success, #22c55e)" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                </svg>
                                <span style={{
                                    fontSize: '0.95rem',
                                    fontWeight: 600,
                                    color: 'var(--color-success, #22c55e)',
                                }}>
                                    {humanPreview}
                                </span>
                            </div>
                        )}

                        {/* 4. Timezone */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label" htmlFor="sched-timezone">
                                Timezone
                            </label>
                            <select
                                id="sched-timezone"
                                value={timezone}
                                onChange={(e) => setTimezone(e.target.value)}
                                disabled={loading}
                                className="agent-config-select"
                            >
                                {COMMON_TIMEZONES.map(tz => (
                                    <option key={tz} value={tz}>{tz}</option>
                                ))}
                            </select>
                        </div>

                        {/* 5. Active/Paused toggle */}
                        <div className="agent-config-field">
                            <label className="agent-config-field__label">Status</label>
                            <div style={{
                                display: 'flex', alignItems: 'center', gap: '0.75rem',
                                padding: '0.75rem 1rem',
                                background: 'rgba(255, 255, 255, 0.03)',
                                borderRadius: '8px',
                                border: '1px solid rgba(255, 255, 255, 0.06)'
                            }}>
                                <button
                                    type="button"
                                    onClick={() => setPaused(!paused)}
                                    disabled={loading}
                                    style={{
                                        width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                                        background: paused ? 'var(--text-muted, #555)' : 'var(--color-success, #22c55e)',
                                        position: 'relative', transition: 'background 0.2s',
                                    }}
                                >
                                    <span style={{
                                        position: 'absolute', top: 3, left: paused ? 3 : 21,
                                        width: 16, height: 16, borderRadius: '50%', background: '#fff',
                                        transition: 'left 0.2s',
                                    }} />
                                </button>
                                <span style={{
                                    fontSize: '0.85rem',
                                    color: paused ? 'var(--color-warning, #f59e0b)' : 'var(--color-success, #22c55e)',
                                    fontWeight: 500,
                                }}>
                                    {paused ? 'Paused' : 'Active'}
                                </span>
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #666)' }}>
                                    {paused ? 'Schedule will not fire until resumed' : 'Schedule is running on cron'}
                                </span>
                            </div>
                        </div>

                        {/* 6. Advanced: Custom cron expression (collapsible) */}
                        <div>
                            <button
                                type="button"
                                onClick={() => setShowAdvanced(!showAdvanced)}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--text-muted, #888)',
                                    cursor: 'pointer',
                                    fontSize: '0.8rem',
                                    padding: '0.25rem 0',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.375rem',
                                }}
                            >
                                <svg
                                    viewBox="0 0 24 24" width="12" height="12"
                                    fill="none" stroke="currentColor" strokeWidth="2"
                                    style={{ transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                                >
                                    <polyline points="9 18 15 12 9 6" />
                                </svg>
                                {showAdvanced ? 'Hide custom cron expression' : 'Use custom cron expression'}
                            </button>
                            {showAdvanced && (
                                <div className="agent-config-field" style={{ marginTop: '0.5rem' }}>
                                    <Input
                                        id="sched-expression"
                                        value={expression}
                                        onChange={(e) => handleAdvancedCronChange(e.target.value)}
                                        placeholder="0 9 * * *"
                                        mono
                                        error={!!errors.expression}
                                        disabled={loading}
                                    />
                                    {errors.expression && (
                                        <span className="agent-config-field__error">{errors.expression}</span>
                                    )}
                                    <span className="agent-config-field__hint" style={{ color: 'var(--text-muted, #666)' }}>
                                        Standard 5-field cron: minute hour day-of-month month day-of-week
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </Modal.Body>

                <Modal.Footer>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={handleClose}
                        disabled={loading}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        loading={loading}
                        style={{ marginLeft: 'auto' }}
                    >
                        {loading ? 'Saving...' : 'Save Changes'}
                    </Button>
                </Modal.Footer>
            </form>
        </Modal>
    );
}

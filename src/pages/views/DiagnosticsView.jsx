/**
 * DiagnosticsView - Browser Storage Diagnostics
 *
 * Inspect and manage QuoxCORE's browser-side storage:
 * - localStorage key browser (quox_* and maestro_* keys)
 * - IndexedDB / AEE envelope health
 * - Storage usage with visual bar
 * - Export/import memory backup
 * - Legacy key migration (maestro_* → quox_*)
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { PageSection, PageCard } from '../../components/layout';
import { getAEEDiagnostics, subscribeToAEEStatus, resetAEEStatus } from '../../services/aeeStatusService';
import './views.css';

function getByteSize(str) {
    return new Blob([str]).size;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getQuoxMemoryData() {
    const items = [];
    let totalSize = 0;

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('quox_') || key.startsWith('maestro_'))) {
            const value = localStorage.getItem(key) || '';
            const size = getByteSize(key) + getByteSize(value);
            totalSize += size;

            items.push({
                key,
                value,
                size,
                preview: value.length > 200 ? value.substring(0, 200) + '...' : value
            });
        }
    }

    items.sort((a, b) => a.key.localeCompare(b.key));
    return { items, totalSize };
}

function getTotalLocalStorageUsage() {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
            const value = localStorage.getItem(key) || '';
            total += getByteSize(key) + getByteSize(value);
        }
    }
    return total;
}

function StorageBar({ used, limit, label }) {
    const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
    const color = pct > 90 ? '#f87171' : pct > 70 ? '#fbbf24' : '#4ade80';

    return (
        <div className="diag-storage-bar">
            <div className="diag-storage-bar__label">
                <span>{label}</span>
                <span>{formatBytes(used)} / {formatBytes(limit)}</span>
            </div>
            <div className="diag-storage-bar__track">
                <div className="diag-storage-bar__fill" style={{ width: `${pct}%`, background: color }} />
            </div>
            <div className="diag-storage-bar__pct">{pct.toFixed(1)}%</div>
        </div>
    );
}

function DiagnosticsView() {
    const [memoryData, setMemoryData] = useState({ items: [], totalSize: 0 });
    const [totalUsage, setTotalUsage] = useState(0);
    const [lastRefresh, setLastRefresh] = useState(new Date());
    const [importStatus, setImportStatus] = useState(null);
    const [migrationStatus, setMigrationStatus] = useState(null);
    const [indexedDBData, setIndexedDBData] = useState(null);
    const [aeeStatus, setAeeStatus] = useState({ healthy: null });
    const fileInputRef = useRef(null);

    useEffect(() => {
        const unsubscribe = subscribeToAEEStatus(setAeeStatus);
        return unsubscribe;
    }, []);

    const loadIndexedDBData = async () => {
        try {
            const diag = await getAEEDiagnostics();
            setIndexedDBData(diag);
        } catch (err) {
            setIndexedDBData({ error: err.message });
        }
    };

    useEffect(() => { loadIndexedDBData(); }, []);

    const loadData = () => {
        setMemoryData(getQuoxMemoryData());
        setTotalUsage(getTotalLocalStorageUsage());
        setLastRefresh(new Date());
        setImportStatus(null);
    };

    useEffect(() => { loadData(); }, []);

    const handleExport = () => {
        const exportData = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('quox_')) {
                try {
                    exportData[key] = JSON.parse(localStorage.getItem(key) || 'null');
                } catch {
                    exportData[key] = localStorage.getItem(key);
                }
            }
        }

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quoxcore-memory-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const handleImport = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target?.result);
                let importCount = 0;

                for (const [key, value] of Object.entries(data)) {
                    if (key.startsWith('quox_')) {
                        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
                        localStorage.setItem(key, stringValue);
                        importCount++;
                    }
                }

                setImportStatus({ success: true, message: `Imported ${importCount} keys successfully.` });
                loadData();
            } catch (err) {
                setImportStatus({ success: false, message: `Import failed: ${err.message}` });
            }
        };
        reader.onerror = () => {
            setImportStatus({ success: false, message: 'Failed to read file.' });
        };
        reader.readAsText(file);

        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const handleMigration = (deleteOld = false) => {
        try {
            const maestroKeys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('maestro_')) {
                    maestroKeys.push(key);
                }
            }

            if (maestroKeys.length === 0) {
                setMigrationStatus({ success: false, message: 'No maestro_* keys found to migrate.' });
                return;
            }

            let migratedCount = 0;
            let skippedCount = 0;

            for (const oldKey of maestroKeys) {
                const newKey = oldKey.replace('maestro_', 'quox_');
                const value = localStorage.getItem(oldKey);
                const existingValue = localStorage.getItem(newKey);
                if (existingValue && existingValue.length > 10) {
                    skippedCount++;
                    continue;
                }
                localStorage.setItem(newKey, value);
                migratedCount++;
                if (deleteOld) {
                    localStorage.removeItem(oldKey);
                }
            }

            const message = deleteOld
                ? `Migrated ${migratedCount} keys from maestro_* to quox_* and removed old keys.`
                : `Copied ${migratedCount} keys from maestro_* to quox_*. Old keys preserved.`;
            const skippedMsg = skippedCount > 0 ? ` Skipped ${skippedCount} keys (quox_* already had data).` : '';

            setMigrationStatus({ success: true, message: message + skippedMsg });
            loadData();
        } catch (err) {
            setMigrationStatus({ success: false, message: `Migration failed: ${err.message}` });
        }
    };

    const maestroKeyCount = useMemo(() => {
        let count = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('maestro_')) count++;
        }
        return count;
    }, [lastRefresh]);

    // localStorage limit is typically 5MB but we attempt to detect via StorageEstimate
    const storageLimitBytes = 5 * 1024 * 1024;

    // Health summary
    const healthItems = useMemo(() => {
        const items = [];
        if (aeeStatus.healthy === true) items.push({ label: 'AEE', status: 'ok' });
        else if (aeeStatus.healthy === false) items.push({ label: 'AEE', status: 'error' });
        else items.push({ label: 'AEE', status: 'unknown' });

        if (indexedDBData?.indexedDBAvailable) items.push({ label: 'IndexedDB', status: 'ok' });
        else items.push({ label: 'IndexedDB', status: 'error' });

        const usagePct = (totalUsage / storageLimitBytes) * 100;
        if (usagePct > 90) items.push({ label: 'localStorage', status: 'error' });
        else if (usagePct > 70) items.push({ label: 'localStorage', status: 'warning' });
        else items.push({ label: 'localStorage', status: 'ok' });

        if (maestroKeyCount > 0) items.push({ label: 'Legacy Keys', status: 'warning' });

        return items;
    }, [aeeStatus, indexedDBData, totalUsage, storageLimitBytes, maestroKeyCount]);

    return (
        <div className="diagnostics-view view-page">
            {/* Page Header */}
            <div className="diag-header">
                <div className="diag-header__left">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth="1.5" style={{ flexShrink: 0 }}>
                        <circle cx="12" cy="12" r="10" stroke="rgba(167, 139, 250, 0.8)" />
                        <line x1="12" y1="8" x2="12" y2="12" stroke="rgba(167, 139, 250, 0.8)" />
                        <line x1="12" y1="16" x2="12.01" y2="16" stroke="rgba(167, 139, 250, 0.8)" />
                    </svg>
                    <div>
                        <h2 className="diag-header__title">Browser Storage Diagnostics</h2>
                        <p className="diag-header__desc">Inspect localStorage keys, IndexedDB health, and AEE envelope status</p>
                    </div>
                </div>
                <div className="diag-header__right">
                    <span className="diag-header__time">
                        Updated {lastRefresh.toLocaleTimeString()}
                    </span>
                </div>
            </div>

            {/* Health Summary Bar */}
            <div className="diag-health-bar">
                {healthItems.map(item => (
                    <div key={item.label} className={`diag-health-item diag-health-item--${item.status}`}>
                        <span className={`diag-health-dot diag-health-dot--${item.status}`} />
                        {item.label}
                    </div>
                ))}
            </div>

            {/* Action Bar */}
            <div className="diag-actions">
                <button className="diag-btn diag-btn--primary" onClick={loadData}>
                    ↻ Refresh
                </button>
                <button className="diag-btn diag-btn--success" onClick={handleExport}>
                    ↓ Export Memory
                </button>
                <button className="diag-btn" onClick={() => fileInputRef.current?.click()}>
                    ↑ Import Memory
                </button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    style={{ display: 'none' }}
                    onChange={handleImport}
                />
            </div>

            {/* Status Messages */}
            {importStatus && (
                <div className={`diag-status ${importStatus.success ? 'diag-status--success' : 'diag-status--error'}`}>
                    {importStatus.message}
                </div>
            )}
            {migrationStatus && (
                <div className={`diag-status ${migrationStatus.success ? 'diag-status--success' : 'diag-status--error'}`}>
                    {migrationStatus.message}
                </div>
            )}

            {/* Stats Grid */}
            <div className="diag-stats">
                <div className="diag-stat-card">
                    <div className="diag-stat-card__label">QuoxCORE Keys</div>
                    <div className="diag-stat-card__value">{memoryData.items.length}</div>
                </div>
                <div className="diag-stat-card">
                    <div className="diag-stat-card__label">QuoxCORE Size</div>
                    <div className="diag-stat-card__value">{formatBytes(memoryData.totalSize)}</div>
                </div>
                <div className="diag-stat-card">
                    <div className="diag-stat-card__label">Total localStorage</div>
                    <div className="diag-stat-card__value">{formatBytes(totalUsage)}</div>
                </div>
                <div className="diag-stat-card">
                    <StorageBar used={totalUsage} limit={storageLimitBytes} label="Storage Usage" />
                </div>
            </div>

            {/* Migration Box — only if legacy keys exist */}
            {maestroKeyCount > 0 && (
                <div className="diag-danger-zone">
                    <div className="diag-danger-zone__header">
                        <span>⚠</span> Legacy Data: {maestroKeyCount} maestro_* keys
                    </div>
                    <p className="diag-danger-zone__desc">
                        Old <code>maestro_*</code> keys from before the rebrand. The app now uses <code>quox_*</code> keys. Migrate to restore your memory.
                    </p>
                    <div className="diag-danger-zone__actions">
                        <button className="diag-btn diag-btn--warning" onClick={() => handleMigration(false)}>
                            Migrate (Keep Old)
                        </button>
                        <button className="diag-btn diag-btn--danger" onClick={() => handleMigration(true)}>
                            Migrate + Delete Old
                        </button>
                    </div>
                </div>
            )}

            {/* IndexedDB / AEE Status */}
            <PageSection title="IndexedDB (AEE Storage)" badge={aeeStatus.healthy === true ? 'Healthy' : aeeStatus.healthy === false ? 'Failed' : 'Unknown'}>
                <div className="diag-section-body">
                    <div className="diag-stats">
                        <div className="diag-stat-card">
                            <div className="diag-stat-card__label">IndexedDB Available</div>
                            <div className="diag-stat-card__value" style={{ fontSize: 18, color: indexedDBData?.indexedDBAvailable ? '#4ade80' : '#f87171' }}>
                                {indexedDBData?.indexedDBAvailable ? 'Yes' : 'No'}
                            </div>
                        </div>
                        <div className="diag-stat-card">
                            <div className="diag-stat-card__label">AEE Status</div>
                            <div className="diag-stat-card__value" style={{ fontSize: 18, color: aeeStatus.healthy === true ? '#4ade80' : aeeStatus.healthy === false ? '#f87171' : '#fbbf24' }}>
                                {aeeStatus.healthy === true ? 'Healthy' : aeeStatus.healthy === false ? 'Failed' : 'Unknown'}
                            </div>
                        </div>
                        <div className="diag-stat-card">
                            <div className="diag-stat-card__label">Envelopes Stored</div>
                            <div className="diag-stat-card__value">
                                {indexedDBData?.dbStats?.totalEnvelopes ?? '—'}
                            </div>
                        </div>
                        <div className="diag-stat-card">
                            <div className="diag-stat-card__label">Conversations</div>
                            <div className="diag-stat-card__value">
                                {indexedDBData?.dbStats?.conversations ?? '—'}
                            </div>
                        </div>
                    </div>

                    {indexedDBData?.storageEstimate && !indexedDBData.storageEstimate.error && (
                        <div className="diag-info-box">
                            <div className="diag-info-box__label">Browser Storage Usage</div>
                            <div className="diag-info-box__value">
                                {(indexedDBData.storageEstimate.usage / 1024 / 1024).toFixed(2)} MB used
                                of {(indexedDBData.storageEstimate.quota / 1024 / 1024 / 1024).toFixed(1)} GB
                                ({indexedDBData.storageEstimate.usagePercent})
                            </div>
                        </div>
                    )}

                    {aeeStatus.lastError && (
                        <div className="diag-error-box">
                            <div className="diag-error-box__label">Last Error</div>
                            <div className="diag-error-box__value">
                                {aeeStatus.lastError}
                                {aeeStatus.consecutiveErrors > 1 && ` (${aeeStatus.consecutiveErrors} consecutive failures)`}
                            </div>
                        </div>
                    )}

                    {indexedDBData?.dbStats?.error && (
                        <div className="diag-error-box">
                            <div className="diag-error-box__label">Database Error</div>
                            <div className="diag-error-box__value">{indexedDBData.dbStats.error}</div>
                        </div>
                    )}

                    {indexedDBData?.recommendations?.length > 0 && (
                        <div className="diag-warning-box">
                            <div className="diag-warning-box__label">Recommendations</div>
                            <ul className="diag-warning-box__list">
                                {indexedDBData.recommendations.map((rec, i) => (
                                    <li key={i}>{rec}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <div className="diag-actions" style={{ marginTop: 16 }}>
                        <button className="diag-btn diag-btn--primary" onClick={loadIndexedDBData}>
                            ↻ Refresh IndexedDB
                        </button>
                        {aeeStatus.lastError && (
                            <button className="diag-btn diag-btn--warning" onClick={resetAEEStatus}>
                                Clear Error State
                            </button>
                        )}
                    </div>

                    <div className="diag-session-stats">
                        Session: {aeeStatus.writeCount} writes, {aeeStatus.errorCount} errors
                    </div>
                </div>
            </PageSection>

            {/* Keys Table */}
            <PageSection title="localStorage Keys" badge={`${memoryData.items.length} keys`}>
                {memoryData.items.length === 0 ? (
                    <div className="diag-empty">
                        <p>No quox_* or maestro_* keys found in localStorage.</p>
                        <p className="diag-empty__hint">
                            Memory data will appear here once QuoxCORE starts storing data.
                        </p>
                    </div>
                ) : (
                    <div style={{ overflowX: 'auto' }}>
                        <table className="diag-table">
                            <thead>
                                <tr>
                                    <th className="diag-table__th">Key</th>
                                    <th className="diag-table__th">Size</th>
                                    <th className="diag-table__th">Preview</th>
                                </tr>
                            </thead>
                            <tbody>
                                {memoryData.items.map((item) => (
                                    <tr key={item.key}>
                                        <td className="diag-table__td diag-table__key">{item.key}</td>
                                        <td className="diag-table__td diag-table__size">{formatBytes(item.size)}</td>
                                        <td className="diag-table__td diag-table__preview">{item.preview}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </PageSection>
        </div>
    );
}

export default DiagnosticsView;

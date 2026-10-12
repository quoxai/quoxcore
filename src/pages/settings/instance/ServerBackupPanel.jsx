/**
 * ServerBackupPanel - G2d slice 3, the instance-admin SERVER-WIDE lane.
 *
 * This is the operator surface for "back up / restore THIS BOX": every org,
 * every store, one archive. It is NOT the per-org tenant lane (that one lives
 * in the signed system-maintenance plugin and is scoped to a single org).
 *
 * Every route it calls is services/auth/routes/admin-backups.js:
 *   GET  /api/admin/backups                    readonly   list archives
 *   GET  /api/admin/backups/status             readonly   runner + receipts
 *   GET  /api/admin/backups/restore-status     readonly   restore engine + receipts
 *   POST /api/admin/backups {mode}             admin      dispatch a backup
 *   GET  /api/admin/backups/:id/download       admin      stream an archive
 *   POST /api/admin/backups/:id/restore        superadmin dry run / real restore
 *
 * Three rules this panel is built around, each of which has cost someone a
 * bad afternoon somewhere:
 *
 * 1. A 2xx on dispatch means QUEUED, never "backed up". The panel says so in
 *    words and then goes looking for the receipt rather than declaring done.
 * 2. Browser timers are not background jobs. Polling runs ONLY while a job
 *    this panel started is outstanding, it is capped, and when the cap is hit
 *    the panel says it stopped looking instead of implying nothing happened.
 * 3. An unconfigured runner is a first-class state, not an error toast. When
 *    BACKUP_RUNNER_HOST is unset the server answers 503 with the exact knob
 *    and the runbook, and that is what the operator is shown.
 *
 * Restore is the most destructive verb in the product, so the UI enforces the
 * same two-key posture the API does: a dry run first, then a typed RESTORE.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { csrfFetch } from '../../../utils/csrfFetch';
import { useInstanceAdmin } from '../../../hooks/useInstanceAdmin.js';
import { fieldsetStyle, legendStyle, inputStyle, saveButtonStyle }
    from './instancePanelStyles.jsx';

const AUTH_API = '/api';
const BACKUPS_API = `${AUTH_API}/admin/backups`;

// Poll only while a job this panel dispatched is outstanding, and stop after
// five minutes rather than running a timer for the life of the tab.
const POLL_INTERVAL_MS = 15000;
const MAX_POLLS = 20;

const RUNBOOK_PATH = 'docs/RESTORE_RUNBOOK.md';

// ── small helpers ──────────────────────────────────────────────────────────

async function readJson(res) {
    try { return await res.json(); } catch { return null; }
}

// Surface the server's own words. A generic "something went wrong" here would
// hide the one sentence the operator actually needs.
function serverMessage(data, status, fallback) {
    if (data && typeof data === 'object') {
        if (typeof data.message === 'string' && data.message) return data.message;
        if (typeof data.error === 'string' && data.error) return data.error;
    }
    return `${fallback} (HTTP ${status})`;
}

function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '-';
    if (n === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return `${parseFloat((n / Math.pow(1024, i)).toFixed(2))} ${units[i]}`;
}

// Receipts arrive as epoch milliseconds from the collector and as ISO strings
// from the runner, so both are accepted and anything else reads as unknown.
function receiptTime(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    const raw = entry.created_at ?? entry.createdAt ?? entry.finished_at ?? entry.timestamp;
    if (raw == null) return 0;
    if (typeof raw === 'number') return raw;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
}

function formatTime(value) {
    const t = receiptTime({ created_at: value });
    return t ? new Date(t).toLocaleString() : '-';
}

function newestReceiptTime(receipts) {
    if (!Array.isArray(receipts) || receipts.length === 0) return 0;
    return receipts.reduce((max, r) => Math.max(max, receiptTime(r)), 0);
}

function shortHash(value) {
    if (typeof value !== 'string' || !value) return '-';
    return `${value.replace(/^sha256:/, '').slice(0, 12)}…`;
}

// ── shared bits of chrome ──────────────────────────────────────────────────

const cellStyle = { padding: '8px 6px', verticalAlign: 'middle', fontSize: 13 };

const ghostButtonStyle = {
    background: 'transparent', color: 'inherit',
    border: '1px solid rgba(255,255,255,0.22)',
    borderRadius: 6, padding: '6px 12px', fontSize: 12,
    cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
};

const dangerButtonStyle = (disabled) => ({
    background: '#dc2626', color: '#fff', border: 'none',
    borderRadius: 6, padding: '10px 20px', fontWeight: 600, fontSize: 13,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
});

function ErrorLine({ children }) {
    if (!children) return null;
    return (
        <p style={{ color: '#f87171', fontSize: 13, margin: '8px 0 0', whiteSpace: 'pre-wrap' }} role="alert">
            {children}
        </p>
    );
}

function DescRow({ label, value }) {
    return (
        <div style={{ display: 'flex', gap: 16, padding: '4px 0' }}>
            <dt style={{ flex: '0 0 160px', opacity: 0.7, fontSize: 13 }}>{label}</dt>
            <dd style={{ margin: 0, fontSize: 13 }}>{value}</dd>
        </div>
    );
}

function RawDetails({ summary, value }) {
    if (value == null) return null;
    return (
        <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, opacity: 0.7 }}>{summary}</summary>
            <pre style={{
                background: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 6,
                fontSize: 12, overflow: 'auto', marginTop: 8, maxHeight: 320,
            }}>
                {JSON.stringify(value, null, 2)}
            </pre>
        </details>
    );
}

function ReceiptsTable({ receipts, error, emptyMessage }) {
    if (error) {
        // Half the board could not be read. Saying so beats a clean, wrong table.
        return <ErrorLine>{`Receipts could not be read: ${error}`}</ErrorLine>;
    }
    if (!Array.isArray(receipts) || receipts.length === 0) {
        return <p style={{ opacity: 0.6, fontSize: 13, margin: '8px 0 0' }}>{emptyMessage}</p>;
    }
    return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
                <tr style={{ textAlign: 'left', opacity: 0.7, fontSize: 12 }}>
                    <th style={cellStyle}>When</th>
                    <th style={cellStyle}>Result</th>
                    <th style={cellStyle}>Archive</th>
                    <th style={cellStyle}>Size</th>
                    <th style={cellStyle}>Took</th>
                </tr>
            </thead>
            <tbody>
                {receipts.map((r, i) => (
                    <tr key={`${r.archive_id || 'receipt'}-${receiptTime(r) || i}`}
                        style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                        <td style={cellStyle}>{receiptTime(r) ? new Date(receiptTime(r)).toLocaleString() : '-'}</td>
                        <td style={cellStyle}>{r.result || r.status || '-'}</td>
                        <td style={{ ...cellStyle, fontFamily: 'monospace' }}>{r.archive_id || '-'}</td>
                        <td style={cellStyle}>
                            {r.archive_size_bytes != null ? formatBytes(r.archive_size_bytes) : '-'}
                        </td>
                        <td style={cellStyle}>
                            {r.duration_seconds != null ? `${r.duration_seconds}s` : '-'}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

// ── the panel ──────────────────────────────────────────────────────────────

export default function ServerBackupPanel() {
    const { role, loading: roleLoading } = useInstanceAdmin();
    const canWrite = role === 'admin' || role === 'superadmin';
    const isSuperadmin = role === 'superadmin';

    const [loading, setLoading] = useState(true);
    const [notConfigured, setNotConfigured] = useState(null);

    const [status, setStatus] = useState(null);
    const [statusError, setStatusError] = useState(null);

    const [archives, setArchives] = useState([]);
    const [archivesError, setArchivesError] = useState(null);

    const [restoreStatus, setRestoreStatus] = useState(null);
    const [restoreStatusError, setRestoreStatusError] = useState(null);

    const [createBusy, setCreateBusy] = useState(null);
    const [createNote, setCreateNote] = useState(null);
    const [createError, setCreateError] = useState(null);

    const [copiedHash, setCopiedHash] = useState(null);

    const [selectedArchive, setSelectedArchive] = useState('');
    const [dryRunBusy, setDryRunBusy] = useState(false);
    const [dryRunResult, setDryRunResult] = useState(null);
    const [restoreError, setRestoreError] = useState(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [confirmText, setConfirmText] = useState('');
    const [restoreBusy, setRestoreBusy] = useState(false);
    const [restoreNote, setRestoreNote] = useState(null);

    // { kind: 'backup' | 'restore', startedAt, baseline } while a job this
    // panel dispatched is still outstanding. null the rest of the time.
    const [watch, setWatch] = useState(null);
    const [watchNote, setWatchNote] = useState(null);
    const pollsRef = useRef(0);

    const loadStatus = useCallback(async () => {
        try {
            const res = await fetch(`${BACKUPS_API}/status`, { credentials: 'include' });
            const data = await readJson(res);
            if (res.status === 503 && data && data.error === 'backup_runner_not_configured') {
                setNotConfigured(data.message || 'No backup runner host is configured on this instance.');
                setStatus(null);
                setStatusError(null);
                return null;
            }
            setNotConfigured(null);
            if (!res.ok) {
                // The 4xx/5xx body still carries whatever receipts were readable.
                setStatus(data && typeof data === 'object' ? data : null);
                setStatusError(serverMessage(data, res.status, 'Runner status failed'));
                return data;
            }
            setStatus(data);
            setStatusError(null);
            return data;
        } catch (err) {
            setStatusError(err.message);
            return null;
        }
    }, []);

    const loadArchives = useCallback(async () => {
        try {
            const res = await fetch(BACKUPS_API, { credentials: 'include' });
            const data = await readJson(res);
            if (res.status === 503 && data && data.error === 'backup_runner_not_configured') {
                setNotConfigured(data.message || 'No backup runner host is configured on this instance.');
                setArchives([]);
                setArchivesError(null);
                return null;
            }
            if (!res.ok) {
                setArchivesError(serverMessage(data, res.status, 'Archive list failed'));
                return null;
            }
            setArchives(Array.isArray(data && data.archives) ? data.archives : []);
            setArchivesError(null);
            return data;
        } catch (err) {
            setArchivesError(err.message);
            return null;
        }
    }, []);

    const loadRestoreStatus = useCallback(async () => {
        try {
            const res = await fetch(`${BACKUPS_API}/restore-status`, { credentials: 'include' });
            const data = await readJson(res);
            if (res.status === 503 && data && data.error === 'backup_runner_not_configured') {
                setNotConfigured(data.message || 'No backup runner host is configured on this instance.');
                return null;
            }
            if (!res.ok) {
                setRestoreStatus(data && typeof data === 'object' ? data : null);
                setRestoreStatusError(serverMessage(data, res.status, 'Restore status failed'));
                return data;
            }
            setRestoreStatus(data);
            setRestoreStatusError(null);
            return data;
        } catch (err) {
            setRestoreStatusError(err.message);
            return null;
        }
    }, []);

    const refreshAll = useCallback(async () => {
        setLoading(true);
        await Promise.all([loadStatus(), loadArchives()]);
        setLoading(false);
    }, [loadStatus, loadArchives]);

    useEffect(() => {
        if (roleLoading || !role) return;
        refreshAll();
    }, [roleLoading, role, refreshAll]);

    // Bounded poll. Runs only while `watch` is set, stops on a receipt newer
    // than the dispatch, and gives up out loud after MAX_POLLS.
    useEffect(() => {
        if (!watch) return undefined;
        pollsRef.current = 0;

        const tick = async () => {
            pollsRef.current += 1;
            if (watch.kind === 'restore') {
                const data = await loadRestoreStatus();
                if (data && newestReceiptTime(data.receipts) > watch.baseline) {
                    setWatch(null);
                    setWatchNote('A restore receipt landed. The outcome is in Restore status below.');
                    return;
                }
            } else {
                const data = await loadStatus();
                if (data && newestReceiptTime(data.receipts) > watch.baseline) {
                    setWatch(null);
                    setWatchNote('A backup receipt landed. The result is in the receipts table below.');
                    await loadArchives();
                    return;
                }
            }
            if (pollsRef.current >= MAX_POLLS) {
                setWatch(null);
                setWatchNote('Stopped checking after five minutes with no new receipt. '
                    + 'The job may still be running on the host. Use Refresh to look again.');
            }
        };

        const id = setInterval(tick, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [watch, loadStatus, loadArchives, loadRestoreStatus]);

    const startBackup = async (mode) => {
        setCreateBusy(mode);
        setCreateNote(null);
        setCreateError(null);
        setWatchNote(null);
        try {
            // Baseline from a FRESH read, not from state: "newer than the
            // receipt I happen to be showing" is how a stale receipt gets
            // mistaken for the job that was just dispatched.
            const before = await loadStatus();
            const baseline = newestReceiptTime(before && before.receipts);
            const res = await csrfFetch(BACKUPS_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode }),
            });
            const data = await readJson(res);
            if (!res.ok) throw new Error(serverMessage(data, res.status, 'Backup dispatch failed'));
            setCreateNote({
                mode,
                host: (data && data.runner_host) || 'the runner host',
                note: (data && data.note) || null,
            });
            setWatch({ kind: 'backup', startedAt: Date.now(), baseline });
        } catch (err) {
            setCreateError(err.message);
        } finally {
            setCreateBusy(null);
        }
    };

    const copyHash = (value, id) => {
        if (!value) return;
        const full = String(value).replace(/^sha256:/, '');
        navigator.clipboard.writeText(full).then(() => {
            setCopiedHash(id);
            setTimeout(() => setCopiedHash(null), 2000);
        }).catch(() => {});
    };

    const runDryRun = async () => {
        if (!selectedArchive) return;
        setDryRunBusy(true);
        setRestoreError(null);
        setDryRunResult(null);
        setRestoreNote(null);
        setWatchNote(null);
        try {
            const before = await loadRestoreStatus();
            const baseline = newestReceiptTime(before && before.receipts);
            // dry_run is left absent on purpose: the engine's own default is a
            // dry run, and asserting a posture the operator did not state is
            // how a real restore eventually happens by accident.
            const res = await csrfFetch(`${BACKUPS_API}/${encodeURIComponent(selectedArchive)}/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await readJson(res);
            if (!res.ok) throw new Error(serverMessage(data, res.status, 'Dry run dispatch failed'));
            setDryRunResult({ archiveId: selectedArchive, response: data });
            setWatch({ kind: 'restore', startedAt: Date.now(), baseline });
            await loadRestoreStatus();
        } catch (err) {
            setRestoreError(err.message);
        } finally {
            setDryRunBusy(false);
        }
    };

    const runRestore = async () => {
        if (!selectedArchive || confirmText !== 'RESTORE') return;
        setRestoreBusy(true);
        setRestoreError(null);
        setWatchNote(null);
        try {
            const before = await loadRestoreStatus();
            const baseline = newestReceiptTime(before && before.receipts);
            const res = await csrfFetch(`${BACKUPS_API}/${encodeURIComponent(selectedArchive)}/restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dry_run: false, confirm: 'RESTORE' }),
            });
            const data = await readJson(res);
            if (!res.ok) throw new Error(serverMessage(data, res.status, 'Restore dispatch failed'));
            setRestoreNote({
                archiveId: selectedArchive,
                note: (data && data.note) || null,
                response: data,
            });
            setConfirmOpen(false);
            setConfirmText('');
            setWatch({ kind: 'restore', startedAt: Date.now(), baseline });
            await loadRestoreStatus();
        } catch (err) {
            setRestoreError(err.message);
        } finally {
            setRestoreBusy(false);
        }
    };

    // ── render ─────────────────────────────────────────────────────────────

    if (roleLoading) {
        return <div style={{ padding: 24, opacity: 0.6 }}>Loading server backups…</div>;
    }

    if (!role) {
        return (
            <div style={{ padding: 24, maxWidth: 720 }}>
                <h2 style={{ marginTop: 0 }}>Server Backups</h2>
                <p style={{ opacity: 0.7 }}>
                    Server-wide backups are restricted to instance admins.
                </p>
            </div>
        );
    }

    const intro = (
        <>
            <h2 style={{ marginTop: 0 }}>Server Backups</h2>
            <p style={{ opacity: 0.7, marginBottom: 24 }}>
                Backups run on the host through the governed runner, not in this
                browser. One archive covers the whole instance: every org, every
                store. The per-org backup surface is a separate, narrower lane.
            </p>
        </>
    );

    if (notConfigured) {
        return (
            <div style={{ padding: 24, maxWidth: 720 }}>
                {intro}
                <fieldset style={fieldsetStyle}>
                    <legend style={legendStyle}>No runner configured</legend>
                    <p style={{ fontSize: 13, margin: 0, whiteSpace: 'pre-wrap' }}>{notConfigured}</p>
                    <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 0 }}>
                        Set <code>BACKUP_RUNNER_HOST</code> to the host id of a registered
                        dev server whose verified profile enables <code>dev.backup</code>,
                        and <code>dev.restore</code> as well if you want restores from here.
                        The full procedure is in <code>{RUNBOOK_PATH}</code>.
                    </p>
                    <p style={{ fontSize: 13, opacity: 0.75, marginBottom: 0 }}>
                        Nothing on this page is disabled by a UI flag. The server refuses
                        these calls until a runner exists, so this is what it told us.
                    </p>
                    <button type="button" onClick={refreshAll} style={{ ...ghostButtonStyle, marginTop: 12 }}>
                        Check again
                    </button>
                </fieldset>
            </div>
        );
    }

    const runner = (status && status.runner) || null;
    const runnerHost = (status && status.runner_host) || null;
    const running = runner && (runner.running === true || runner.in_progress === true);
    const receipts = status && status.receipts;
    const latestReceipt = Array.isArray(receipts) && receipts.length
        ? receipts.reduce((best, r) => (receiptTime(r) > receiptTime(best) ? r : best), receipts[0])
        : null;

    return (
        <div style={{ padding: 24, maxWidth: 860 }}>
            {intro}

            {/* ── Status ─────────────────────────────────────────────────── */}
            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Runner</legend>

                {loading && !status ? (
                    <p style={{ opacity: 0.6, fontSize: 13 }}>Loading runner status…</p>
                ) : (
                    <dl style={{ margin: 0 }}>
                        <DescRow label="Runner host" value={runnerHost || 'unknown'} />
                        <DescRow label="Live state" value={
                            statusError
                                ? 'Could not be read'
                                : running ? 'Running a job now' : 'Idle'
                        } />
                        <DescRow label="Last backup" value={
                            latestReceipt
                                ? `${latestReceipt.result || latestReceipt.status || 'unknown'} at `
                                  + `${formatTime(latestReceipt.created_at)}`
                                  + (latestReceipt.archive_size_bytes != null
                                      ? `, ${formatBytes(latestReceipt.archive_size_bytes)}` : '')
                                  + (latestReceipt.archive_id ? `, ${latestReceipt.archive_id}` : '')
                                : 'No receipt recorded yet'
                        } />
                    </dl>
                )}

                <ErrorLine>{statusError}</ErrorLine>

                {watch && (
                    <p style={{ fontSize: 13, color: '#38bdf8', marginBottom: 0 }} aria-live="polite">
                        Checking every 15 seconds for the receipt of the {watch.kind} this
                        page dispatched. Checking stops after five minutes.
                    </p>
                )}
                {watchNote && (
                    <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 0 }} aria-live="polite">{watchNote}</p>
                )}

                <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button type="button" onClick={refreshAll} style={ghostButtonStyle} disabled={loading}>
                        {loading ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <span style={{ fontSize: 12, opacity: 0.55 }}>
                        This page does not poll in the background. Refresh to re-read.
                    </span>
                </div>

                <RawDetails summary="Raw runner response" value={runner} />

                <h3 style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 0' }}>Recent backup receipts</h3>
                <ReceiptsTable
                    receipts={receipts}
                    error={status && status.receipts_error}
                    emptyMessage="No backup receipts recorded yet." />
            </fieldset>

            {/* ── Create ─────────────────────────────────────────────────── */}
            {canWrite && (
                <fieldset style={fieldsetStyle}>
                    <legend style={legendStyle}>Create a backup</legend>

                    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                        <div style={{ flex: '1 1 300px' }}>
                            <button type="button" onClick={() => startBackup('full')}
                                disabled={!!createBusy} style={saveButtonStyle(createBusy === 'full')}>
                                {createBusy === 'full' ? 'Dispatching…' : 'Full backup'}
                            </button>
                            <p style={{ fontSize: 12, opacity: 0.7, margin: '8px 0 0' }}>
                                Everything the engine knows about: databases, secrets,
                                uploads and the supporting repos. Slow and large.
                            </p>
                        </div>
                        <div style={{ flex: '1 1 300px' }}>
                            <button type="button" onClick={() => startBackup('quick')}
                                disabled={!!createBusy} style={{ ...ghostButtonStyle, padding: '10px 22px', fontSize: 13 }}>
                                {createBusy === 'quick' ? 'Dispatching…' : 'Quick backup'}
                            </button>
                            <p style={{ fontSize: 12, opacity: 0.7, margin: '8px 0 0' }}>
                                Databases and secrets only. Faster, smaller, and enough to
                                bring the platform back with its data.
                            </p>
                        </div>
                    </div>

                    {createNote && (
                        <div style={{
                            marginTop: 16, padding: 12, borderRadius: 6,
                            background: 'rgba(56, 189, 248, 0.08)',
                            border: '1px solid rgba(56, 189, 248, 0.3)',
                        }} aria-live="polite">
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                                {createNote.mode === 'quick' ? 'Quick' : 'Full'} backup queued on {createNote.host}.
                            </p>
                            <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.85 }}>
                                Queued is not backed up. This is the dispatch acknowledgement
                                only. The backup is real when a receipt says so.
                            </p>
                            {createNote.note && (
                                <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.7 }}>{createNote.note}</p>
                            )}
                        </div>
                    )}
                    <ErrorLine>{createError}</ErrorLine>
                </fieldset>
            )}

            {/* ── Archives ───────────────────────────────────────────────── */}
            <fieldset style={fieldsetStyle}>
                <legend style={legendStyle}>Archives ({archives.length})</legend>

                <ErrorLine>{archivesError}</ErrorLine>

                {archives.length === 0 && !archivesError ? (
                    <p style={{ opacity: 0.6, fontSize: 13 }}>
                        No archives registered on the runner host.
                    </p>
                ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ textAlign: 'left', opacity: 0.7, fontSize: 12 }}>
                                <th style={cellStyle}>Archive</th>
                                <th style={cellStyle}>Created</th>
                                <th style={cellStyle}>Size</th>
                                <th style={cellStyle}>SHA-256</th>
                                {canWrite && <th style={cellStyle} aria-label="actions" />}
                            </tr>
                        </thead>
                        <tbody>
                            {archives.map((a) => (
                                <tr key={a.id} style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                    <td style={{ ...cellStyle, fontFamily: 'monospace' }}>{a.id}</td>
                                    <td style={cellStyle}>{formatTime(a.created_at)}</td>
                                    <td style={cellStyle}>{formatBytes(a.size_bytes)}</td>
                                    <td style={cellStyle}>
                                        {a.sha256 ? (
                                            <button type="button"
                                                onClick={() => copyHash(a.sha256, a.id)}
                                                title="Click to copy the full digest"
                                                style={{
                                                    background: 'transparent', border: 'none', padding: 0,
                                                    color: 'inherit', fontFamily: 'monospace', fontSize: 12,
                                                    cursor: 'pointer', textDecoration: 'underline dotted',
                                                }}>
                                                {copiedHash === a.id ? 'Copied' : shortHash(a.sha256)}
                                            </button>
                                        ) : '-'}
                                    </td>
                                    {canWrite && (
                                        <td style={{ ...cellStyle, textAlign: 'right' }}>
                                            <a href={`${BACKUPS_API}/${encodeURIComponent(a.id)}/download`}
                                                target="_blank" rel="noreferrer"
                                                style={ghostButtonStyle}>Download</a>
                                        </td>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}

                {canWrite && archives.length > 0 && (
                    <p style={{ fontSize: 12, opacity: 0.6, margin: '12px 0 0' }}>
                        A download streams the archive from this node. Hash what lands on
                        your disk and compare it against the SHA-256 above before trusting
                        the copy. If the runner refuses, the new tab shows its reason.
                    </p>
                )}
            </fieldset>

            {/* ── Restore ────────────────────────────────────────────────── */}
            {isSuperadmin && (
                <fieldset style={{ ...fieldsetStyle, borderColor: 'rgba(248, 113, 113, 0.4)' }}>
                    <legend style={{ ...legendStyle, color: '#f87171' }}>Restore this instance</legend>

                    <p style={{ fontSize: 13, opacity: 0.85, marginTop: 0 }}>
                        A restore overwrites this instance from the archive, for every org.
                        Anything created since the archive was written is lost, and services
                        restart while it runs. Validate first, always.
                    </p>

                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                        <div>
                            <label htmlFor="restoreArchive" style={{
                                display: 'block', marginBottom: 6, fontSize: 13,
                                fontWeight: 500, color: 'rgba(255,255,255,0.85)',
                            }}>
                                Archive
                            </label>
                            <select id="restoreArchive" style={{ ...inputStyle, maxWidth: 320 }}
                                value={selectedArchive}
                                onChange={(e) => {
                                    setSelectedArchive(e.target.value);
                                    setDryRunResult(null);
                                    setRestoreNote(null);
                                    setRestoreError(null);
                                }}>
                                <option value="">Select an archive…</option>
                                {archives.map((a) => (
                                    <option key={a.id} value={a.id}>
                                        {a.id} ({formatBytes(a.size_bytes)})
                                    </option>
                                ))}
                            </select>
                        </div>

                        <button type="button" onClick={runDryRun}
                            disabled={!selectedArchive || dryRunBusy}
                            style={{
                                ...ghostButtonStyle, padding: '10px 18px', fontSize: 13,
                                opacity: (!selectedArchive || dryRunBusy) ? 0.5 : 1,
                                cursor: (!selectedArchive || dryRunBusy) ? 'not-allowed' : 'pointer',
                            }}>
                            {dryRunBusy ? 'Validating…' : 'Validate (dry run)'}
                        </button>

                        <button type="button" onClick={() => setConfirmOpen(true)}
                            disabled={!dryRunResult || dryRunResult.archiveId !== selectedArchive}
                            style={dangerButtonStyle(!dryRunResult || dryRunResult.archiveId !== selectedArchive)}>
                            Restore now
                        </button>
                    </div>

                    {!dryRunResult && (
                        <p style={{ fontSize: 12, opacity: 0.6, margin: '10px 0 0' }}>
                            Restore now stays locked until a dry run has been dispatched for
                            the selected archive.
                        </p>
                    )}

                    {dryRunResult && dryRunResult.archiveId === selectedArchive && (
                        <div style={{ marginTop: 16 }} aria-live="polite">
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                                Dry run dispatched for {dryRunResult.archiveId}. Nothing was written.
                            </p>
                            <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.85 }}>
                                Dispatched is not finished. Read the dry run outcome in
                                Restore status below before you restore for real.
                            </p>
                            <RawDetails summary="Raw dry run response" value={dryRunResult.response} />
                        </div>
                    )}

                    {restoreNote && (
                        <div style={{
                            marginTop: 16, padding: 12, borderRadius: 6,
                            background: 'rgba(248, 113, 113, 0.08)',
                            border: '1px solid rgba(248, 113, 113, 0.35)',
                        }} aria-live="polite">
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                                Live restore dispatched for {restoreNote.archiveId}.
                            </p>
                            <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.85 }}>
                                Dispatched, not finished. The outcome lands in Restore status below.
                            </p>
                            {restoreNote.note && (
                                <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.7 }}>{restoreNote.note}</p>
                            )}
                            <RawDetails summary="Raw restore response" value={restoreNote.response} />
                        </div>
                    )}

                    <ErrorLine>{restoreError}</ErrorLine>

                    <h3 style={{ fontSize: 13, fontWeight: 600, margin: '20px 0 0' }}>Restore status</h3>
                    <div style={{ marginTop: 8 }}>
                        <button type="button" onClick={loadRestoreStatus} style={ghostButtonStyle}>
                            Read restore status
                        </button>
                    </div>
                    {restoreStatus && (
                        <>
                            <dl style={{ margin: '12px 0 0' }}>
                                <DescRow label="Restore engine" value={
                                    restoreStatus.runner && restoreStatus.runner.running
                                        ? 'Running now' : 'Idle'
                                } />
                            </dl>
                            <RawDetails summary="Raw restore engine response" value={restoreStatus.runner} />
                            <ReceiptsTable
                                receipts={restoreStatus.receipts}
                                error={restoreStatus.receipts_error}
                                emptyMessage="No restore receipts recorded yet." />
                        </>
                    )}
                    <ErrorLine>{restoreStatusError}</ErrorLine>
                </fieldset>
            )}

            {confirmOpen && (
                <ConfirmRestoreDialog
                    archiveId={selectedArchive}
                    value={confirmText}
                    onChange={setConfirmText}
                    busy={restoreBusy}
                    error={restoreError}
                    onCancel={() => { setConfirmOpen(false); setConfirmText(''); }}
                    onConfirm={runRestore} />
            )}
        </div>
    );
}

// ── confirm dialog ─────────────────────────────────────────────────────────

/**
 * The second key. A click alone cannot start a live restore: the operator has
 * to type the word, which is the same literal the API demands as `confirm`.
 */
function ConfirmRestoreDialog({ archiveId, value, onChange, busy, error, onCancel, onConfirm }) {
    const ready = value === 'RESTORE';
    return (
        <div role="dialog" aria-modal="true" aria-label="Confirm restore"
            style={{
                position: 'fixed', inset: 0, zIndex: 3000,
                background: 'rgba(0,0,0,0.65)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 24,
            }}>
            <div style={{
                background: 'var(--m-bg-base, rgba(20,20,26,0.98))',
                border: '1px solid rgba(248, 113, 113, 0.5)',
                borderRadius: 'var(--qx-radius, 20px)',
                padding: 24, maxWidth: 520, width: '100%',
                boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
            }}>
                <h3 style={{ margin: 0, color: '#f87171', fontSize: 16 }}>Restore over this instance</h3>
                <p style={{ fontSize: 13, marginTop: 12 }}>
                    You are about to restore <code>{archiveId}</code> over this instance.
                </p>
                <ul style={{ fontSize: 13, opacity: 0.9, paddingLeft: 20, margin: '0 0 12px' }}>
                    <li>Data for every org is replaced by the contents of the archive.</li>
                    <li>Anything created after the archive was written is lost.</li>
                    <li>Services restart during the restore, so the platform goes down.</li>
                    <li>This cannot be undone from here.</li>
                </ul>
                <label htmlFor="restoreConfirm" style={{
                    display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 500,
                }}>
                    Type RESTORE to confirm
                </label>
                <input id="restoreConfirm" type="text" autoComplete="off"
                    style={{ ...inputStyle, maxWidth: '100%', fontFamily: 'monospace' }}
                    value={value} onChange={(e) => onChange(e.target.value)} />

                <ErrorLine>{error}</ErrorLine>

                <div style={{ display: 'flex', gap: 12, marginTop: 20, justifyContent: 'flex-end' }}>
                    <button type="button" onClick={onCancel} style={ghostButtonStyle} disabled={busy}>
                        Cancel
                    </button>
                    <button type="button" onClick={onConfirm} disabled={!ready || busy}
                        style={dangerButtonStyle(!ready || busy)}>
                        {busy ? 'Dispatching…' : 'Restore now'}
                    </button>
                </div>
            </div>
        </div>
    );
}

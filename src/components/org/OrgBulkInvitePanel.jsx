/**
 * OrgBulkInvitePanel — ET-3 Phase D.
 *
 * Team tier+. Paste or drop a CSV (or any .csv file), preview rows,
 * dry-run for a validation report, then execute. Server emits
 * team.member.invited events per created invite.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import {
    parseCsvPreview,
    submitBulkInvite,
    MAX_BULK_INVITE_ROWS,
} from '../../services/bulkInviteClient';

const UploadIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
);

const CSV_TEMPLATE = [
    'email,role,team',
    'alice@corp.io,viewer,',
    'bob@corp.io,builder,engineering',
].join('\n');

export default function OrgBulkInvitePanel({ orgId, isAdmin = false }) {
    const { authFetch } = useAuth();
    const fileRef = useRef(null);
    const [csv, setCsv] = useState('');
    const [preview, setPreview] = useState({ rows: [], error: null });
    const [report, setReport]   = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const updateCsv = useCallback((text) => {
        setCsv(text);
        setReport(null);
        setError(null);
        setPreview(text ? parseCsvPreview(text) : { rows: [], error: null });
    }, []);

    const onFile = (file) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => updateCsv(String(reader.result || ''));
        reader.readAsText(file);
    };

    const onPaste = (e) => updateCsv(e.target.value);

    const handleDryRun = async () => {
        if (!csv.trim()) { setError('Paste or drop a CSV first'); return; }
        if (preview.error) { setError(preview.error); return; }
        setBusy(true); setError(null);
        try {
            setReport(await submitBulkInvite(orgId, { csv, dryRun: true }, authFetch));
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
    };

    const handleExecute = async () => {
        if (!report || report.valid.length === 0) {
            setError('Run a dry-run first, and ensure at least one valid row');
            return;
        }
        if (!window.confirm(`Send ${report.valid.length} invite${report.valid.length === 1 ? '' : 's'}? Each recipient receives an email.`)) return;
        setBusy(true); setError(null);
        try {
            const out = await submitBulkInvite(orgId, { csv, dryRun: false }, authFetch);
            setReport(out);
        } catch (err) { setError(err.message); }
        finally { setBusy(false); }
    };

    const headerHint = useMemo(() => {
        if (!preview.rows.length) return null;
        return `${preview.rows.length} row${preview.rows.length === 1 ? '' : 's'} parsed (max ${MAX_BULK_INVITE_ROWS})`;
    }, [preview.rows]);

    return (
        <div className="qx-card org-bulk-panel">
            <div className="org-bulk-panel__head">
                <span className="org-bulk-panel__icon"><UploadIcon /></span>
                <div className="org-bulk-panel__title-group">
                    <h3 className="org-bulk-panel__title">Bulk Invite</h3>
                    <p className="org-bulk-panel__sub">Invite up to {MAX_BULK_INVITE_ROWS} members at once from a CSV.</p>
                </div>
            </div>

            {error && <div className="org-bulk-panel__error">{error}</div>}

            {isAdmin && (
                <>
                    <div className="org-bulk-panel__tools">
                        <Button size="sm" variant="ghost"
                            onClick={() => fileRef.current?.click()}>Upload CSV</Button>
                        <input
                            ref={fileRef}
                            type="file"
                            accept=".csv,text/csv"
                            style={{ display: 'none' }}
                            onChange={e => onFile(e.target.files?.[0])}
                        />
                        <Button size="sm" variant="ghost" onClick={() => updateCsv(CSV_TEMPLATE)}>
                            Load template
                        </Button>
                        {csv && (
                            <Button size="sm" variant="ghost" onClick={() => updateCsv('')}>Clear</Button>
                        )}
                    </div>
                    <textarea
                        className="org-bulk-panel__textarea"
                        value={csv}
                        onChange={onPaste}
                        placeholder="Paste CSV here — first line is the header.&#10;Columns: email (required), role, team."
                        rows={8}
                    />
                    {preview.error && <div className="org-bulk-panel__hint-error">{preview.error}</div>}
                    {headerHint && <div className="org-bulk-panel__hint">{headerHint}</div>}

                    <div className="org-bulk-panel__actions">
                        <Button size="sm" variant="ghost" onClick={handleDryRun}
                            disabled={!csv.trim() || !!preview.error} loading={busy && !report}>
                            Dry-run
                        </Button>
                        <Button size="sm" variant="primary" onClick={handleExecute}
                            disabled={!report || !report.valid?.length} loading={busy && !!report}>
                            Send invites
                        </Button>
                    </div>
                </>
            )}

            {report && (
                <div className="org-bulk-panel__report">
                    <div className="org-bulk-panel__report-head">
                        {report.dry_run
                            ? <span className="org-bulk-panel__report-label is-dry">Dry-run report</span>
                            : <span className="org-bulk-panel__report-label is-sent">
                                Sent {report.created} invite{report.created === 1 ? '' : 's'}
                              </span>}
                        <div className="org-bulk-panel__report-counts">
                            <span className="org-bulk-panel__chip is-valid">{report.valid?.length || 0} valid</span>
                            <span className="org-bulk-panel__chip is-err">{report.errors?.length || 0} errors</span>
                        </div>
                    </div>
                    {report.errors?.length > 0 && (
                        <ul className="org-bulk-panel__error-list">
                            {report.errors.map((e, i) => (
                                <li key={i}>
                                    <code>line {e.line}</code>
                                    <span>{e.email || '—'}</span>
                                    <span className="org-bulk-panel__error-reason">{e.reason}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

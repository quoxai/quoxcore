/**
 * N8nImportDialog - Import a legacy n8n workflow export into QuoxFlow
 *
 * N8N-ERADICATE: this dialog is the one surviving n8n capability in the
 * product — a one-off migration of an old n8n workflow JSON export into a
 * real, working QuoxFlow workflow. It does NOT connect to a live n8n
 * instance; it hits the same `POST /api/workflows/import-n8n` endpoint the
 * `import_n8n_workflow` agent tool already calls (services/collector/lib/agentTools.js),
 * via `importN8nWorkflow()` in src/services/quoxflowClient.js.
 *
 * Paste JSON or upload a .json file, submit, and see an honest result:
 * node count converted, any "requires credentials" / unsupported-node
 * warnings surfaced verbatim, and — on success — a link to open the
 * imported workflow in the builder. Partial/failed imports show the real
 * error, not a papered-over success message.
 */

import { useState, useRef, useCallback } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Textarea } from '../ui/Input';
import { importN8nWorkflow } from '../../services/quoxflowClient';

const ImportIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);

const WarningIcon = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
);

/**
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {function} props.onClose
 * @param {function} [props.onOpenWorkflow] - (workflowId) => void — navigate to the builder for the imported workflow
 */
export default function N8nImportDialog({ isOpen, onClose, onOpenWorkflow }) {
    const [jsonText, setJsonText] = useState('');
    const [fileName, setFileName] = useState('');
    const [parseError, setParseError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState(null); // { success, workflow, warnings, errorMessage, errorDetails }
    const fileInputRef = useRef(null);

    const reset = useCallback(() => {
        setJsonText('');
        setFileName('');
        setParseError(null);
        setResult(null);
        setSubmitting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    const handleClose = useCallback(() => {
        if (submitting) return;
        reset();
        onClose?.();
    }, [submitting, reset, onClose]);

    const handleFileSelect = useCallback(async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setParseError(null);
        setResult(null);
        try {
            const text = await file.text();
            setJsonText(text);
            setFileName(file.name);
        } catch (err) {
            setParseError(`Could not read file: ${err.message || err}`);
        }
    }, []);

    const handleSubmit = useCallback(async (e) => {
        e?.preventDefault?.();
        setParseError(null);
        setResult(null);

        let parsed;
        try {
            parsed = JSON.parse(jsonText);
        } catch (err) {
            setParseError(`Invalid JSON: ${err.message || err}`);
            return;
        }

        if (!parsed || typeof parsed !== 'object' || !parsed.nodes) {
            setParseError('This does not look like an n8n workflow export — expected a "nodes" array at the top level.');
            return;
        }

        setSubmitting(true);
        try {
            const res = await importN8nWorkflow(parsed);
            const data = res?.data || {};
            if (res?.success) {
                setResult({
                    success: true,
                    workflow: data.workflow || null,
                    warnings: data.warnings || res.warnings || [],
                });
            } else {
                setResult({
                    success: false,
                    errorMessage: res?.error?.message || 'Import failed',
                    errorDetails: res?.error?.details || [],
                    warnings: data.warnings || res?.warnings || [],
                });
            }
        } catch (err) {
            // Network / parse-level failure (not a converter-reported failure)
            setResult({
                success: false,
                errorMessage: err?.message || 'Import failed — could not reach QuoxFlow.',
                errorDetails: [],
                warnings: [],
            });
        } finally {
            setSubmitting(false);
        }
    }, [jsonText]);

    const handleOpenWorkflow = useCallback(() => {
        if (result?.workflow?.id) {
            onOpenWorkflow?.(result.workflow.id);
        }
        reset();
        onClose?.();
    }, [result, onOpenWorkflow, reset, onClose]);

    const nodeCount = result?.workflow?.nodes?.length ?? result?.workflow?.definition?.nodes?.length ?? 0;

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            size="lg"
            closeOnOverlay={!submitting}
            closeOnEscape={!submitting}
        >
            <Modal.Header
                title="Import from n8n"
                description="Paste an n8n workflow export or upload its .json file to convert it into a QuoxFlow workflow"
                icon={<ImportIcon />}
                onClose={!submitting ? handleClose : undefined}
            />

            <form onSubmit={handleSubmit}>
                <Modal.Body>
                    {!result && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="n8n-import-file">
                                    Upload .json file
                                </label>
                                <input
                                    ref={fileInputRef}
                                    id="n8n-import-file"
                                    type="file"
                                    accept=".json,application/json"
                                    onChange={handleFileSelect}
                                    disabled={submitting}
                                />
                                {fileName && (
                                    <span className="agent-config-field__hint">Loaded: {fileName}</span>
                                )}
                            </div>

                            <div className="agent-config-field">
                                <label className="agent-config-field__label" htmlFor="n8n-import-json">
                                    Or paste workflow JSON
                                </label>
                                <Textarea
                                    id="n8n-import-json"
                                    value={jsonText}
                                    onChange={(e) => { setJsonText(e.target.value); setFileName(''); }}
                                    placeholder='{"name": "My n8n workflow", "nodes": [...], "connections": {...}}'
                                    rows={12}
                                    mono
                                    disabled={submitting}
                                />
                            </div>

                            {parseError && (
                                <div style={{
                                    padding: '0.75rem 1rem',
                                    background: 'rgba(239, 68, 68, 0.08)',
                                    borderRadius: '8px',
                                    borderLeft: '3px solid var(--color-danger, #ef4444)',
                                    fontSize: '0.8rem',
                                    color: 'var(--color-danger, #ef4444)'
                                }}>
                                    {parseError}
                                </div>
                            )}
                        </div>
                    )}

                    {result && result.success && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div style={{
                                padding: '0.75rem 1rem',
                                background: 'rgba(34, 197, 94, 0.08)',
                                borderRadius: '8px',
                                borderLeft: '3px solid var(--color-success, #22c55e)',
                                fontSize: '0.85rem',
                                color: 'var(--color-success, #22c55e)'
                            }}>
                                Imported "{result.workflow?.name || 'workflow'}" — {nodeCount} node{nodeCount === 1 ? '' : 's'} converted.
                            </div>

                            {result.warnings?.length > 0 && (
                                <div className="agent-config-field">
                                    <label className="agent-config-field__label">
                                        Warnings ({result.warnings.length})
                                    </label>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: 220, overflowY: 'auto' }}>
                                        {result.warnings.map((w, i) => (
                                            <div key={i} style={{
                                                display: 'flex',
                                                gap: '0.5rem',
                                                alignItems: 'flex-start',
                                                padding: '0.5rem 0.75rem',
                                                background: 'rgba(255, 176, 48, 0.08)',
                                                borderRadius: '6px',
                                                fontSize: '0.78rem',
                                                color: 'var(--ui-amber, #ffb030)'
                                            }}>
                                                <span style={{ marginTop: 1, flexShrink: 0 }}><WarningIcon /></span>
                                                <span>
                                                    <strong>{w.nodeName || w.nodeId || 'Workflow'}:</strong> {w.message}
                                                    {w.suggestion ? ` — ${w.suggestion}` : ''}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                    <span className="agent-config-field__hint">
                                        These usually mean a node needs credentials configured before it will run — this is expected, not a bug.
                                    </span>
                                </div>
                            )}
                        </div>
                    )}

                    {result && !result.success && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div style={{
                                padding: '0.75rem 1rem',
                                background: 'rgba(239, 68, 68, 0.08)',
                                borderRadius: '8px',
                                borderLeft: '3px solid var(--color-danger, #ef4444)',
                                fontSize: '0.85rem',
                                color: 'var(--color-danger, #ef4444)'
                            }}>
                                {result.errorMessage}
                            </div>

                            {result.errorDetails?.length > 0 && (
                                <div className="agent-config-field">
                                    <label className="agent-config-field__label">Details</label>
                                    <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                                        {result.errorDetails.map((d, i) => (
                                            <li key={i}>{typeof d === 'string' ? d : d.message || JSON.stringify(d)}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {result.warnings?.length > 0 && (
                                <div className="agent-config-field">
                                    <label className="agent-config-field__label">
                                        Warnings ({result.warnings.length})
                                    </label>
                                    <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.78rem', color: 'var(--ui-amber, #ffb030)' }}>
                                        {result.warnings.map((w, i) => (
                                            <li key={i}>{w.nodeName || w.nodeId || 'Workflow'}: {w.message}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                </Modal.Body>

                <Modal.Footer>
                    {!result && (
                        <>
                            <Button type="button" variant="ghost" onClick={handleClose} disabled={submitting}>
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                variant="primary"
                                loading={submitting}
                                disabled={!jsonText.trim()}
                                style={{ marginLeft: 'auto' }}
                            >
                                {submitting ? 'Importing...' : 'Import'}
                            </Button>
                        </>
                    )}

                    {result && result.success && (
                        <>
                            <Button type="button" variant="ghost" onClick={reset}>
                                Import Another
                            </Button>
                            <Button type="button" variant="ghost" onClick={handleClose}>
                                Close
                            </Button>
                            {result.workflow?.id && (
                                <Button type="button" variant="primary" onClick={handleOpenWorkflow} style={{ marginLeft: 'auto' }}>
                                    Open in Builder
                                </Button>
                            )}
                        </>
                    )}

                    {result && !result.success && (
                        <>
                            <Button type="button" variant="ghost" onClick={reset} style={{ marginLeft: 'auto' }}>
                                Try Again
                            </Button>
                            <Button type="button" variant="secondary" onClick={handleClose}>
                                Close
                            </Button>
                        </>
                    )}
                </Modal.Footer>
            </form>
        </Modal>
    );
}

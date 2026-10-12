/**
 * Brain2ConnectSource — the real source-connect flow (BRAIN2-PRODUCT Phase C).
 *
 * Replaces the "Add a source" stub's blind `putSource(type, {enabled:true})`
 * call with a per-connector form, per docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md
 * "connect, don't configure": the user never edits a `.env`, they fill in
 * exactly what the connector needs and nothing else.
 *
 * Connector behaviour:
 *   - 'oauth' (notion; gdrive not   — GET /api/orgs/:orgId/connect/providers
 *      wired up yet)                  (auth service, BRAIN2-OAUTH-NOTION)
 *                                    tells us whether THIS deployment has an
 *                                    OAuth app configured for this provider.
 *                                    Not configured: disabled button + an
 *                                    honest banner naming what's missing.
 *                                    Configured: a real Connect button that
 *                                    full-page-navigates the browser to
 *                                    GET /api/orgs/:orgId/connect/:provider/start
 *                                    (a 302 redirect flow — no token ever
 *                                    touches this component). No provider
 *                                    entry at all (e.g. gdrive, not yet
 *                                    registered) falls back to the same
 *                                    "not configured" state rather than
 *                                    pretending otherwise.
 *   - 'internal' (conversation/    — one-click Connect. `transcript` is a
 *      fleet) + transcript           `host` connector by catalog but gets the
 *                                    same one-click treatment here, plus an
 *                                    optional session-path override (blank =
 *                                    server default ~/.claude).
 *   - 'host' + requiresConfig       — folder connect: a required path input
 *      (git/docs/obsidian)            + optional display name.
 *
 * Server-authoritative: on success we hand the updated source row back to
 * the caller via onConnected() — no optimistic fabrication of counts/status.
 * Composed entirely from `.qx-*` (qx-modal, qx-field, qx-input, qx-banner,
 * qx-btn) — no bespoke CSS.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { putSource, getConnectProviders, connectStartUrl } from '../../services/brain2FeedClient';

function connectModeFor(source) {
    if (!source) return 'internal';
    if (source.connector === 'oauth') return 'oauth';
    if (source.connector === 'internal' || source.sourceType === 'transcript') return 'internal';
    return 'folder';
}

export default function Brain2ConnectSource({ source, onClose, onConnected }) {
    const { authFetch, user } = useAuth();
    const orgId = user?.org_id || null;

    const [path, setPath] = useState('');
    const [name, setName] = useState('');
    const [pathError, setPathError] = useState(null);
    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [consented, setConsented] = useState(false);

    // OAuth provider-configured state (BRAIN2-OAUTH-NOTION): null while
    // loading, then true/false/undefined (undefined = no provider entry at
    // all yet, e.g. gdrive — treated the same as "not configured").
    const [oauthConfigured, setOauthConfigured] = useState(null);
    const [oauthCheckError, setOauthCheckError] = useState(null);

    const mode = connectModeFor(source);

    useEffect(() => {
        if (mode !== 'oauth' || !source || !orgId) return;
        let cancelled = false;
        setOauthConfigured(null);
        setOauthCheckError(null);
        getConnectProviders(orgId, authFetch)
            .then((providers) => {
                if (cancelled) return;
                const entry = providers.find((p) => p.provider === source.sourceType);
                setOauthConfigured(!!entry?.configured);
            })
            .catch((err) => {
                if (cancelled) return;
                setOauthConfigured(false);
                setOauthCheckError(err?.message || 'Failed to check connect status');
            });
        return () => { cancelled = true; };
    }, [mode, source, orgId, authFetch]);

    if (!source) return null;

    const isSensitive = source.sensitivity === 'pii' || source.sensitivity === 'evidence';
    const isTranscript = source.sourceType === 'transcript';

    function handleOauthConnect() {
        if (!orgId || !oauthConfigured) return;
        window.location.href = connectStartUrl(orgId, source.sourceType, window.location.pathname + window.location.search);
    }

    async function handleSubmit() {
        if (mode === 'oauth' || submitting) return;
        if (isSensitive && !consented) return;
        setError(null);

        const patch = { enabled: true };

        if (mode === 'folder') {
            const trimmed = path.trim();
            if (!trimmed) {
                setPathError('Folder path is required');
                return;
            }
            const config = { path: trimmed };
            if (name.trim()) config.name = name.trim();
            patch.config = config;
        } else if (isTranscript) {
            const trimmed = path.trim();
            if (trimmed) patch.config = { path: trimmed };
        }

        setPathError(null);
        setSubmitting(true);
        try {
            const updated = await putSource({ authFetch }, source.sourceType, patch);
            onConnected?.(updated);
        } catch (err) {
            setError(err?.message || `Failed to connect ${source.name}`);
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <div className="qx-modal-overlay" onClick={onClose}>
            <div
                className="qx-modal"
                onClick={e => e.stopPropagation()}
                style={{ maxWidth: 480 }}
                data-testid="brain2-connect-modal"
            >
                <div className="qx-modal__header">
                    <h2>Connect {source.name}</h2>
                    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onClose}>✕</button>
                </div>

                <div className="qx-modal__body qx-stack qx-stack--tight">
                    <p className="qx-modal__desc">{source.description}</p>

                    {mode === 'oauth' && oauthConfigured === null && (
                        <div className="qx-banner qx-banner--info">Checking connect status…</div>
                    )}

                    {mode === 'oauth' && oauthConfigured === false && (
                        <div className="qx-banner qx-banner--info">
                            This deployment has no {source.name} OAuth app configured yet. An administrator must set the client credentials before anyone can connect.
                            {oauthCheckError && <> ({oauthCheckError})</>}
                        </div>
                    )}

                    {mode === 'oauth' && oauthConfigured === true && (
                        <p className="qx-modal__desc" style={{ margin: 0 }}>
                            You'll be sent to {source.name} to sign in and choose what to share. Nothing is read until you approve.
                        </p>
                    )}

                    {mode === 'folder' && (
                        <div className="qx-stack qx-stack--tight">
                            <div className="qx-field">
                                <label className="qx-field__label qx-field__label--required">Folder path</label>
                                <input
                                    type="text"
                                    className="qx-input qx-input--mono"
                                    placeholder="/home/you/notes"
                                    value={path}
                                    onChange={e => { setPath(e.target.value); setPathError(null); }}
                                    disabled={submitting}
                                    aria-label="Folder path"
                                />
                                {pathError && <span className="qx-field__error">{pathError}</span>}
                            </div>
                            <div className="qx-field">
                                <label className="qx-field__label">Name (optional)</label>
                                <input
                                    type="text"
                                    className="qx-input"
                                    placeholder={source.name}
                                    value={name}
                                    onChange={e => setName(e.target.value)}
                                    disabled={submitting}
                                    aria-label="Source name"
                                />
                            </div>
                        </div>
                    )}

                    {mode === 'internal' && isTranscript && (
                        <div className="qx-field">
                            <label className="qx-field__label">Session path (optional)</label>
                            <input
                                type="text"
                                className="qx-input qx-input--mono"
                                placeholder="~/.claude (server default)"
                                value={path}
                                onChange={e => setPath(e.target.value)}
                                disabled={submitting}
                                aria-label="Session path"
                            />
                            <span className="qx-field__hint">Leave blank to use the server default.</span>
                        </div>
                    )}

                    {mode === 'internal' && !isTranscript && (
                        <p className="qx-modal__desc" style={{ margin: 0 }}>
                            Nothing to configure — Qortex already has access to this data.
                        </p>
                    )}

                    {isSensitive && (
                        <label className="qx-banner qx-banner--warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                className="qx-checkbox"
                                checked={consented}
                                onChange={e => setConsented(e.target.checked)}
                                aria-label="Consent to add this data to your brain"
                                style={{ marginTop: 2 }}
                            />
                            <span>
                                {source.sensitivity === 'pii'
                                    ? 'This source contains personal data. '
                                    : 'This source contains governance evidence. '}
                                It will be indexed into your brain and readable by your agents. Add it?
                            </span>
                        </label>
                    )}

                    {error && <div className="qx-banner qx-banner--error">{error}</div>}

                    <div className="qx-modal__actions">
                        <button type="button" className="qx-btn qx-btn--ghost" onClick={onClose}>Cancel</button>
                        {mode === 'oauth' ? (
                            <button
                                type="button"
                                className="qx-btn qx-btn--primary"
                                onClick={handleOauthConnect}
                                disabled={!oauthConfigured || !orgId}
                                title={oauthConfigured ? `Connect ${source.name}` : `${source.name} OAuth app not configured on this deployment`}
                            >
                                Connect
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="qx-btn qx-btn--primary"
                                onClick={handleSubmit}
                                disabled={submitting || (isSensitive && !consented)}
                            >
                                {submitting ? 'Connecting…' : 'Connect'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

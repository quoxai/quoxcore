/**
 * DeployPowerRepoSteps — repo-branch step content for DeployPowerWizard.
 *
 * Renders three steps within the wizard:
 *   repo_notice  — show repo-clone notice with caveats
 *   repo_env     — env var collection form
 *   repo_build   — live build log stream + state transitions
 *
 * The parent (DeployPowerWizard) owns the step state machine and calls
 * callbacks (onStartBuild, onBuildSuccess, onBuildFailed, onCancel).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import BuildLogStream from './BuildLogStream';
import { deployRepo, getBuildStatus, cancelRepoDeploy, updateRepoDeploy } from '../../services/powersClient';

export function RepoNoticeStep({ repoUrl, repoRef, onRepoRefChange }) {
    const match = repoUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
    const shortName = match ? `${match[1]}/${match[2]}` : repoUrl;

    return (
        <div className="wizard-step">
            <div className="wizard-server-banner" style={{ background: 'rgba(99,102,241,0.08)', borderColor: 'rgba(99,102,241,0.25)' }}>
                <strong style={{ color: '#818cf8' }}>{shortName}</strong>
                <br />
                <span style={{ fontSize: '0.8rem' }}>
                    Quox will clone this repo and run it inside a sandboxed container.
                    Building takes 1&ndash;3 minutes for most Node/Python repos.
                    If the repo ships its own Dockerfile it will be used; otherwise Quox
                    auto-generates one.
                </span>
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted, #888)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--text-secondary, #aaa)', display: 'block', marginBottom: 4 }}>Caveats</strong>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>200&nbsp;MB clone cap — large repos will be rejected</li>
                    <li>pnpm <code>catalog:</code> syntax is not supported in MVP</li>
                    <li>Container runs with <code>--read-only --user 65534</code> for safety</li>
                    <li>Build logs are retained for 1&nbsp;000 lines per tool</li>
                </ul>
            </div>
            {/* D2: Optional commit SHA pin */}
            <div className="wizard-field">
                <label className="wizard-label" style={{ fontSize: '0.8rem' }}>
                    Pin to commit SHA (optional)
                </label>
                <input
                    type="text"
                    className="qx-input"
                    placeholder="HEAD (default) or a commit SHA e.g. abc1234"
                    value={repoRef || ''}
                    onChange={e => onRepoRefChange && onRepoRefChange(e.target.value)}
                    style={{ fontSize: '0.82rem', fontFamily: 'monospace' }}
                />
                <span className="wizard-hint" style={{ fontSize: '0.75rem' }}>
                    Leave blank to track HEAD. Specify a full or short SHA to pin to an exact commit.
                </span>
            </div>
        </div>
    );
}

export function RepoEnvStep({ envVars, onEnvVarsChange }) {
    function addRow() {
        onEnvVarsChange([...envVars, { key: '', value: '' }]);
    }

    function removeRow(idx) {
        onEnvVarsChange(envVars.filter((_, i) => i !== idx));
    }

    function updateRow(idx, field, val) {
        const next = envVars.map((ev, i) => i === idx ? { ...ev, [field]: val } : ev);
        onEnvVarsChange(next);
    }

    return (
        <div className="wizard-step">
            <div className="wizard-hint" style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #aaa)', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, padding: '8px 12px' }}>
                We&apos;ll inject these as environment variables when starting the container. They&apos;re encrypted at rest using AES-256-GCM. Many MCP repos work without any env vars.
            </div>

            {envVars.length > 0 && (
                <div className="repo-env-table">
                    {envVars.map((ev, idx) => (
                        <div key={idx} className="repo-env-row">
                            <input
                                type="text"
                                className="qx-input repo-env-key"
                                placeholder="KEY"
                                value={ev.key}
                                onChange={e => updateRow(idx, 'key', e.target.value)}
                                aria-label={`env var key ${idx + 1}`}
                            />
                            <input
                                type="password"
                                className="qx-input repo-env-val"
                                placeholder="value"
                                value={ev.value}
                                onChange={e => updateRow(idx, 'value', e.target.value)}
                                aria-label={`env var value ${idx + 1}`}
                            />
                            <button
                                type="button"
                                className="qx-btn qx-btn--ghost repo-env-remove"
                                onClick={() => removeRow(idx)}
                                title="Remove"
                                aria-label="Remove env var"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <button
                type="button"
                className="qx-btn qx-btn--ghost"
                style={{ alignSelf: 'flex-start', fontSize: '0.8rem' }}
                onClick={addRow}
            >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 5 }}>
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add row
            </button>
        </div>
    );
}

const POLL_INTERVAL_MS = 1500;

export function RepoBuildStep({ orgId, repoUrl, envVars, toolDefId, onSuccess, onFailed }) {
    const [buildState, setBuildState] = useState('pending');
    const [logs, setLogs] = useState([]);
    const [elapsedSec, setElapsedSec] = useState(0);
    const [failedReason, setFailedReason] = useState(null);
    const [cancelling, setCancelling] = useState(false);
    const [cancelError, setCancelError] = useState(null);
    const startTimeRef = useRef(Date.now());
    const pollTimerRef = useRef(null);
    const elapsedTimerRef = useRef(null);
    const activeRef = useRef(true);

    const poll = useCallback(async () => {
        if (!activeRef.current) return;
        try {
            const data = await getBuildStatus(orgId, toolDefId);
            if (!activeRef.current) return;
            setBuildState(data.build_state);
            if (Array.isArray(data.logs)) setLogs(data.logs);
            if (data.build_failed_reason) setFailedReason(data.build_failed_reason);

            if (data.build_state === 'built') {
                clearInterval(pollTimerRef.current);
                clearInterval(elapsedTimerRef.current);
                onSuccess({ toolDefId });
            } else if (data.build_state === 'failed') {
                clearInterval(pollTimerRef.current);
                clearInterval(elapsedTimerRef.current);
                onFailed({ reason: data.build_failed_reason || 'Build failed.' });
            }
        } catch (_err) {
            // Network hiccup — keep polling
        }
    }, [orgId, toolDefId, onSuccess, onFailed]);

    useEffect(() => {
        activeRef.current = true;
        startTimeRef.current = Date.now();

        // Elapsed timer
        elapsedTimerRef.current = setInterval(() => {
            setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
        }, 1000);

        // Poll immediately, then on interval
        poll();
        pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);

        return () => {
            activeRef.current = false;
            clearInterval(pollTimerRef.current);
            clearInterval(elapsedTimerRef.current);
        };
    }, [poll]);

    async function handleCancel() {
        setCancelling(true);
        setCancelError(null);
        try {
            await cancelRepoDeploy(orgId, toolDefId);
            onFailed({ reason: 'Build cancelled by user.' });
        } catch (err) {
            setCancelError(err.message || 'Cancel failed.');
            setCancelling(false);
        }
    }

    return (
        <div className="wizard-step">
            <BuildLogStream
                logs={logs}
                buildState={buildState}
                elapsedSec={elapsedSec}
            />

            {buildState === 'failed' && (
                <>
                    {failedReason && (
                        <div className="wizard-error-inline">{failedReason}</div>
                    )}
                    {cancelError && (
                        <div className="wizard-error-inline">{cancelError}</div>
                    )}
                    <button
                        type="button"
                        className="qx-btn qx-btn--ghost"
                        onClick={handleCancel}
                        disabled={cancelling}
                        style={{ alignSelf: 'flex-start' }}
                    >
                        {cancelling ? 'Discarding…' : 'Cancel & Discard'}
                    </button>
                </>
            )}
        </div>
    );
}

/**
 * Initiator component — calls deployRepo on mount and transitions to RepoBuildStep.
 * This separates the "submit" action from the "polling" action.
 * D1: Calls onDuplicate({ existing, actions }) when 409 already_installed is returned.
 * D2: Accepts optional repoRef (commit SHA or HEAD).
 * D1: Accepts optional forceSuffix for deploying as a duplicate with a different slug.
 */
export function RepoInitiateStep({ orgId, repoUrl, envVars, repoRef, forceSuffix, onReady, onError, onDuplicate }) {
    const [status, setStatus] = useState('initiating'); // initiating | error
    const [errorMsg, setErrorMsg] = useState(null);
    const calledRef = useRef(false);

    useEffect(() => {
        if (calledRef.current) return;
        calledRef.current = true;

        const payload = { repo_url: repoUrl, env_vars: envVars };
        if (repoRef && repoRef.trim() && repoRef.trim() !== 'HEAD') {
            payload.repo_ref = repoRef.trim();
        }
        if (forceSuffix) {
            payload.force_suffix = forceSuffix;
        }

        deployRepo(orgId, payload)
            .then(data => {
                setStatus('done');
                onReady({ toolDefId: data.tool_def_id });
            })
            .catch(err => {
                // D1: Handle 409 already_installed — offer update / duplicate options
                if (err.response?.status === 409 && err.response?.body?.error === 'already_installed') {
                    if (onDuplicate) {
                        onDuplicate({
                            existing: err.response.body.existing,
                            actions: err.response.body.actions,
                            message: err.response.body.message,
                        });
                        return;
                    }
                }
                setStatus('error');
                const msg = err.response?.body?.message || err.message || 'Could not initiate build.';
                setErrorMsg(msg);
                onError(msg);
            });
    }, [orgId, repoUrl, envVars, repoRef, forceSuffix, onReady, onError, onDuplicate]);

    if (status === 'initiating') {
        return (
            <div className="wizard-step" style={{ alignItems: 'center', gap: 12 }}>
                <span className="wizard-spinner" />
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, #aaa)' }}>
                    Initiating build&hellip;
                </span>
            </div>
        );
    }

    if (status === 'error') {
        return (
            <div className="wizard-step">
                <div className="wizard-error-inline">{errorMsg}</div>
            </div>
        );
    }

    return null;
}

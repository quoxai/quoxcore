/**
 * TOOLSMITH Slice B — Script Forge Editor
 *
 * Three-column layout:
 *   LEFT:   file tree (5 canonical files)
 *   CENTER: Monaco editor (language per file type)
 *   RIGHT:  Toolsmith chat sidebar + live analyser preview
 *
 * Draft persistence:
 *   - First save mints a ULID and sets ?draft_id= in URL via replaceState
 *   - Subsequent saves PUT /api/toolsmith/drafts/:id (debounced 1500ms)
 *   - Resume: /tools/add?type=script-forge&draft_id=<ulid> fetches + hydrates
 *
 * Chat (Slice 3b):
 *   - POST /collector/chat with selected_agent: 'toolsmith'
 *   - Conversation history held in component state (resets on reload — by design)
 *   - No server-side conversation persistence (deferred to future slice)
 *
 * Live preview (Slice 3b):
 *   - Debounced 1500ms analyse call to /collector/api/internal/toolsmith/analyse
 *   - Only fires when active file is script.py
 *
 * Validate-on-save (Slice 3b):
 *   - After autosave, calls /collector/api/internal/toolsmith/validate
 *   - Status bar shows Saved · Valid / N warnings / N errors
 */

import { useState, useEffect, useRef, useCallback, Suspense, lazy, forwardRef, useImperativeHandle } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ToolsmithChatSidebar } from './ToolsmithChatSidebar';
import { ProposedPatchChip } from './ProposedPatchChip';
import { DiffSection } from './DiffSection';
import { LiveAnalysisSection } from './LiveAnalysisSection';
import { DevShell, TerminalDock } from '../devshell';

// Lazy-load Monaco to avoid bloating the main bundle
const MonacoEditor = lazy(() => import('@monaco-editor/react'));

// ── Constants ─────────────────────────────────────────────────────────────────

const FILES = ['script.py', 'tool.json', 'tests.json', 'requirements.txt', 'README.md'];

const FILE_LANGUAGE = {
    'script.py':      'python',
    'tool.json':      'json',
    'tests.json':     'json',
    'requirements.txt': 'plaintext',
    'README.md':      'markdown',
};

/** Initial stubs for a fresh draft. */
const INITIAL_FILES = {
    'script.py': [
        'def quox_tool_main(inputs: dict) -> dict:',
        '    """TODO: implement."""',
        '    return {}',
        '',
    ].join('\n'),
    'tool.json': JSON.stringify({
        id: '',
        name: '',
        description: '',
        inputs_schema: {},
        outputs_schema: {},
        permissions: {
            network: false,
            filesystem: false,
            secrets: [],
            subprocess: false,
            approval_required: false,
        },
        edition: 'experimental',
        deterministic: true,
    }, null, 2),
    'tests.json': JSON.stringify({ tests: [] }, null, 2),
    'requirements.txt': '',
    'README.md': '# <Tool Name>\n\nDescribe what this tool does.\n',
};

/** Monotonic ULID-compatible ID (browser-safe, no crypto dep). */
function mintUlid() {
    const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const now = Date.now();
    let id = '';
    let t = now;
    for (let i = 9; i >= 0; i--) {
        id = chars[t % 32] + id;
        t = Math.floor(t / 32);
    }
    for (let i = 0; i < 16; i++) {
        id += chars[Math.floor(Math.random() * 32)];
    }
    return id;
}

const TOOLSMITH_ORANGE = '#f97316';
const SAVE_DEBOUNCE_MS = 1500;

// ── Sub-components ────────────────────────────────────────────────────────────

function FileTree({ files, active, onSelect }) {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {FILES.map(name => {
                const isActive = name === active;
                return (
                    <button
                        key={name}
                        onClick={() => onSelect(name)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '7px 10px',
                            borderRadius: 6,
                            border: 'none',
                            background: isActive
                                ? 'rgba(249,115,22,0.15)'
                                : 'transparent',
                            color: isActive ? TOOLSMITH_ORANGE : 'rgba(255,255,255,0.75)',
                            cursor: 'pointer',
                            fontSize: 13,
                            fontFamily: 'monospace',
                            textAlign: 'left',
                            width: '100%',
                            outline: isActive ? `1px solid rgba(249,115,22,0.35)` : 'none',
                        }}
                    >
                        <FileIcon name={name} active={isActive} />
                        {name}
                    </button>
                );
            })}
        </div>
    );
}

function FileIcon({ name, active }) {
    const color = active ? TOOLSMITH_ORANGE : 'rgba(255,255,255,0.4)';
    if (name.endsWith('.py')) {
        return (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
            </svg>
        );
    }
    if (name.endsWith('.json')) {
        return (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
            </svg>
        );
    }
    if (name === 'README.md') {
        return (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
            </svg>
        );
    }
    // requirements.txt
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
    );
}

/**
 * SaveStatus + validation state combined status bar element.
 * Hovering the validation badge shows the full error/warning list.
 */
function SaveStatus({ status, validationState }) {
    let text = '';
    let color = 'rgba(255,255,255,0.4)';

    if (status === 'saving') { text = 'Saving…'; color = TOOLSMITH_ORANGE; }
    else if (status === 'saved') { text = 'Saved'; color = '#22c55e'; }
    else if (status === 'unsaved') { text = 'Unsaved'; color = 'rgba(255,255,255,0.4)'; }
    else if (status === 'error') { text = 'Save failed'; color = '#ef4444'; }

    if (!text) return null;

    // Validation badge next to save status
    let validBadge = null;
    if (validationState && (status === 'saved' || status === 'error')) {
        const { errors = [], warnings = [] } = validationState;
        let badgeText = '';
        let badgeColor = '#22c55e';
        let tooltip = '';

        if (errors.length > 0) {
            badgeText = `${errors.length} error${errors.length === 1 ? '' : 's'}`;
            badgeColor = '#ef4444';
            tooltip = errors.join('\n');
        } else if (warnings.length > 0) {
            badgeText = `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
            badgeColor = '#f59e0b';
            tooltip = warnings.join('\n');
        } else {
            badgeText = 'Valid';
            badgeColor = '#22c55e';
            tooltip = 'No errors or warnings';
        }

        validBadge = (
            <span
                title={tooltip}
                style={{
                    fontSize: 11,
                    color: badgeColor,
                    marginLeft: 4,
                    cursor: 'default',
                    userSelect: 'none',
                }}
            >
                · {badgeText}
            </span>
        );
    }

    return (
        <span style={{ fontSize: 12, color, marginLeft: 8, display: 'flex', alignItems: 'center' }}>
            {text}
            {validBadge}
        </span>
    );
}

// ── AnalyserPanel ─────────────────────────────────────────────────────────────

/**
 * Read-only permission indicator chip.
 */
function PermissionChip({ label, implied }) {
    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            padding: '2px 7px',
            borderRadius: 4,
            background: implied ? 'rgba(249,115,22,0.15)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${implied ? 'rgba(249,115,22,0.4)' : 'rgba(255,255,255,0.1)'}`,
            color: implied ? TOOLSMITH_ORANGE : 'rgba(255,255,255,0.3)',
        }}>
            {label}
        </span>
    );
}

export function AnalyserPanel({ result, lastAnalysedAt, activeFile }) {
    // If not on script.py, show a notice
    if (activeFile !== 'script.py') {
        return (
            <div style={{
                padding: '10px 12px',
                fontSize: 11,
                color: 'rgba(255,255,255,0.4)',
                lineHeight: 1.5,
            }}>
                Analyser runs on <span style={{ color: TOOLSMITH_ORANGE, fontFamily: 'monospace' }}>script.py</span> — switch files to see live preview.
            </div>
        );
    }

    if (!result) {
        return (
            <div style={{ padding: '10px 12px', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
                Waiting for first edit…
            </div>
        );
    }

    const { flags = [], suggestedPermissions = {} } = result;
    const { network, filesystem, secrets, subprocess, approval_required } = suggestedPermissions;
    const secretsList = Array.isArray(secrets) ? secrets : [];

    return (
        <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>

            {/* Flags */}
            {flags.length === 0 ? (
                <div style={{
                    fontSize: 11,
                    color: '#22c55e',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Clean — no dangerous patterns detected
                </div>
            ) : (
                <div>
                    <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: 'rgba(255,255,255,0.35)',
                        marginBottom: 5,
                    }}>
                        Flags
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                        <tbody>
                            {flags.map((flag, i) => (
                                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                    <td style={{ padding: '3px 4px', color: '#ef4444', fontFamily: 'monospace' }}>
                                        {flag.pattern}
                                    </td>
                                    <td style={{ padding: '3px 4px', color: 'rgba(255,255,255,0.4)', textAlign: 'right' }}>
                                        L{flag.line}
                                    </td>
                                    <td style={{ padding: '3px 4px', color: 'rgba(255,255,255,0.5)', paddingLeft: 6, maxWidth: 90, wordBreak: 'break-word' }}>
                                        {flag.suggestion}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Permissions (implied, read-only) */}
            <div>
                <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.35)',
                    marginBottom: 5,
                }}>
                    Implied permissions
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    <PermissionChip label="Network" implied={!!network} />
                    <PermissionChip label="Filesystem" implied={!!filesystem} />
                    <PermissionChip label="Subprocess" implied={!!subprocess} />
                    <PermissionChip label="Approval" implied={!!approval_required} />
                    {secretsList.length > 0 && (
                        <PermissionChip label={`Secrets (${secretsList.length})`} implied={true} />
                    )}
                </div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)', marginTop: 4 }}>
                    Read-only — edit permissions in tool.json
                </div>
            </div>

            {/* Last analysed timestamp */}
            {lastAnalysedAt && (
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>
                    Last analysed {Math.round((Date.now() - lastAnalysedAt) / 1000)}s ago
                </div>
            )}
        </div>
    );
}

// ── Main Component ────────────────────────────────────────────────────────────

const ScriptForgeView = forwardRef(function ScriptForgeView({ onNameChange, onSaveStatusChange } = {}, ref) {
    const { authFetch, user } = useAuth();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();

    const [files, setFiles] = useState({ ...INITIAL_FILES });
    const [activeFile, setActiveFile] = useState('script.py');
    // Mint the draftId at mount so it never transitions null → ulid mid-session.
    // The chat sidebar's sessionPrefix is derived from draftId; if draftId flipped
    // during the first save, ChatEngine's storageKey would change and wipe the
    // conversation (regression FIX-1a-5: Apply destroys chat message).
    const [draftId, setDraftId] = useState(() => searchParams.get('draft_id') || mintUlid());
    const [saveStatus, setSaveStatus] = useState('unsaved');
    const [loading, setLoading] = useState(!!searchParams.get('draft_id'));

    // Validation state (shown beside save status)
    const [validationState, setValidationState] = useState(null);

    // Analyser state
    const [analyserResult, setAnalyserResult] = useState(null);
    const [lastAnalysedAt, setLastAnalysedAt] = useState(null);

    // Right panel tab: 'chat' | 'preview' — kept for legacy Slice 3b tests
    // but superseded by rightRailSection for Slice 5 section logic
    const [rightTab, setRightTab] = useState('chat');

    // Slice 5 — pending patch from Toolsmith + section state
    const [pendingPatch, setPendingPatch] = useState(null);
    const [appliedMessageIds, setAppliedMessageIds] = useState(new Set());
    const [autoApply, setAutoApply] = useState(false);
    // rightRailSection: 'chat' | 'diff' | 'live' (controlled externally via ToolsmithChatSidebar)
    const [rightRailSection, setRightRailSection] = useState('chat');

    // Pipeline state (Test / Install / Assign)
    const [testResult, setTestResult] = useState(null);        // last test run result
    const [testRunning, setTestRunning] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [installedToolId, setInstalledToolId] = useState(null); // set after successful install
    const [pipelineError, setPipelineError] = useState(null);

    // Terminal dock collapsed state — persisted in localStorage
    const [terminalCollapsed, setTerminalCollapsed] = useState(
        () => localStorage.getItem('toolsmith-terminal-dock-collapsed') === 'true'
    );

    // Persist terminal dock collapsed state
    useEffect(() => {
        localStorage.setItem('toolsmith-terminal-dock-collapsed', String(terminalCollapsed));
    }, [terminalCollapsed]);

    // Chat sidebar ref for sending failure turn
    const chatSendRef = useRef(null);

    const debounceRef = useRef(null);
    const analyserDebounceRef = useRef(null);
    const draftIdRef = useRef(draftId);
    draftIdRef.current = draftId;

    // Keep a ref to files so saveToServer always uses latest
    const filesRef = useRef(files);
    filesRef.current = files;

    // ── Notify parent when tool.json:name changes ─────────────────────────────

    useEffect(() => {
        if (!onNameChange) return;
        try {
            const parsed = JSON.parse(files['tool.json'] || '{}');
            onNameChange(parsed.name || '');
        } catch { /* malformed JSON — skip */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files['tool.json'], onNameChange]);

    // ── Notify parent when save status changes ────────────────────────────────

    useEffect(() => {
        onSaveStatusChange?.(saveStatus);
    }, [saveStatus, onSaveStatusChange]);

    // ── Bug J fix #1: Sync draft_id to URL on mount ───────────────────────────
    // The draftId is minted at component mount (useState initializer). If the URL
    // lacks ?draft_id= (fresh session before first debounced save fires), sync it
    // immediately so React Router tab-switches can restore it on remount.
    useEffect(() => {
        const url = new URL(window.location.href);
        if (!url.searchParams.get('draft_id')) {
            url.searchParams.set('draft_id', draftIdRef.current);
            window.history.replaceState({}, '', url.toString());
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Load draft on mount if draft_id is in URL ─────────────────────────────

    useEffect(() => {
        const id = searchParams.get('draft_id');
        if (!id) return;

        setLoading(true);
        authFetch(`/api/toolsmith/drafts/${id}`)
            .then(r => r.json())
            .then(data => {
                if (data && data.files) {
                    setFiles(data.files);
                    setSaveStatus('saved');
                }
            })
            .catch(() => {
                // Draft not found or network error — fall through with defaults
            })
            .finally(() => setLoading(false));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Save + validate to server ─────────────────────────────────────────────

    const validateFiles = useCallback(async (currentFiles) => {
        try {
            const resp = await authFetch('/collector/api/internal/toolsmith/validate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: currentFiles }),
            });
            if (resp.ok) {
                const data = await resp.json();
                setValidationState({ errors: data.errors || [], warnings: data.warnings || [] });
            }
        } catch {
            // Validation is best-effort — don't surface network errors
        }
    }, [authFetch]);

    const saveToServer = useCallback(async (currentFiles) => {
        setSaveStatus('saving');
        try {
            const id = draftIdRef.current;
            // On the first save, sync the URL so reload preserves the draft.
            // The id itself was minted at mount (see useState initializer above)
            // so the chat sidebar's sessionPrefix never changes mid-session.
            const url = new URL(window.location.href);
            if (url.searchParams.get('draft_id') !== id) {
                url.searchParams.set('draft_id', id);
                window.history.replaceState({}, '', url.toString());
            }

            const resp = await authFetch(`/api/toolsmith/drafts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: currentFiles }),
            });

            if (resp.ok) {
                setSaveStatus('saved');
                // Validate after successful save
                validateFiles(currentFiles);
            } else {
                setSaveStatus('error');
            }
        } catch {
            setSaveStatus('error');
        }
    }, [authFetch, validateFiles]);

    // ── Expose imperative handle to parent (ToolAddView top-bar) ─────────────

    useImperativeHandle(ref, () => ({
        saveNow: () => saveToServer(filesRef.current),
        getName: () => {
            try {
                const parsed = JSON.parse(filesRef.current['tool.json'] || '{}');
                return parsed.name || '';
            } catch { return ''; }
        },
        setName: (newName) => {
            setFiles(prev => {
                let parsed = {};
                try { parsed = JSON.parse(prev['tool.json'] || '{}'); } catch { /* */ }
                parsed.name = newName;
                return { ...prev, 'tool.json': JSON.stringify(parsed, null, 2) };
            });
        },
        getSaveStatus: () => saveStatus,
    }), [saveToServer, saveStatus]);

    // ── Analyser call for script.py ───────────────────────────────────────────

    const runAnalyser = useCallback(async (scriptPy) => {
        try {
            const resp = await authFetch('/collector/api/internal/toolsmith/analyse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scriptPy }),
            });
            if (resp.ok) {
                const data = await resp.json();
                setAnalyserResult(data);
                setLastAnalysedAt(Date.now());
            }
        } catch {
            // Analyser is best-effort
        }
    }, [authFetch]);

    // ── Debounced save + analyse on file change ───────────────────────────────

    const handleEditorChange = useCallback((value) => {
        const updated = { ...filesRef.current, [activeFile]: value ?? '' };
        setFiles(updated);
        setSaveStatus('unsaved');

        // Debounced save
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            saveToServer(updated);
        }, SAVE_DEBOUNCE_MS);

        // Debounced analyser (script.py only)
        if (activeFile === 'script.py') {
            if (analyserDebounceRef.current) clearTimeout(analyserDebounceRef.current);
            analyserDebounceRef.current = setTimeout(() => {
                runAnalyser(value ?? '');
            }, SAVE_DEBOUNCE_MS);
        }
    }, [activeFile, saveToServer, runAnalyser]);

    useEffect(() => {
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            if (analyserDebounceRef.current) clearTimeout(analyserDebounceRef.current);
        };
    }, []);

    // ── Bug J fix #2: Flush debounced save on unmount ────────────────────────
    // When the user switches tabs (unmount) before the 1500ms debounce fires,
    // we flush the save synchronously so the draft survives the unmount.
    // The fetch continues in-flight after unmount — acceptable.
    useEffect(() => {
        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
                saveToServer(filesRef.current);
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [saveToServer]);

    // ── Bug J fix #3: beforeunload guard when unsaved ─────────────────────────
    // Attaches the browser's native "Leave site?" dialog when there are unsaved
    // changes. Only attached when dirty (saveStatus === 'unsaved' or 'saving')
    // to avoid polluting every page.
    useEffect(() => {
        if (saveStatus !== 'unsaved' && saveStatus !== 'saving') return;
        const handleBeforeUnload = (e) => {
            e.preventDefault();
            e.returnValue = '';
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [saveStatus]);

    // ── Pipeline: Test ────────────────────────────────────────────────────────

    const handleTest = useCallback(async () => {
        if (testRunning) return;
        setTestRunning(true);
        setPipelineError(null);
        setTestResult(null);

        const currentFiles = filesRef.current;

        // Infer permissions from the analyser result if available
        const permissions = analyserResult?.suggestedPermissions || {
            network: false,
            filesystem: false,
            secrets: [],
            subprocess: false,
            approval_required: false,
        };

        try {
            const resp = await authFetch('/collector/api/internal/toolsmith/sandbox/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    scriptContent: currentFiles['script.py'] || '',
                    inputsJson: {},
                    permissions,
                    profile: 'restricted',
                    walltimeMs: 30000,
                }),
            });

            const data = await resp.json();

            if (!resp.ok) {
                const err = data.error || `Test run failed (${resp.status})`;
                setPipelineError(err);
                setTestResult({ exitCode: -1, error: err });
            } else {
                setTestResult(data);

                // Capability 10: If test failed, send failure context as a chat turn to Toolsmith
                if (data.exitCode !== 0 && chatSendRef.current) {
                    const stderrTail = (data.stderr || '').slice(-500);
                    const stdoutTail = (data.stdout || '').slice(-200);
                    chatSendRef.current.send(
                        `The last test run failed. exitCode=${data.exitCode}, stderr: ${stderrTail || '(empty)'}, stdout: ${stdoutTail || '(empty)'}. Explain what went wrong and propose a fix.`
                    );
                }
            }
        } catch (err) {
            const msg = `Network error — test run unavailable: ${err.message}`;
            setPipelineError(msg);
            setTestResult({ exitCode: -1, error: msg });
        } finally {
            setTestRunning(false);
        }
    }, [testRunning, analyserResult, authFetch]);

    // ── Pipeline: Install ─────────────────────────────────────────────────────

    const handleInstall = useCallback(async () => {
        if (installing || !testResult || testResult.exitCode !== 0) return;
        setInstalling(true);
        setPipelineError(null);

        const orgId = user?.org_id;
        if (!orgId) {
            setPipelineError('Cannot install: org ID not available. Please reload.');
            setInstalling(false);
            return;
        }

        try {
            const resp = await authFetch(`/api/orgs/${orgId}/tool-library/from-toolsmith`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ draftId: draftIdRef.current || undefined }),
            });

            const data = await resp.json();

            if (!resp.ok) {
                const err = data.message || data.error || `Install failed (${resp.status})`;
                setPipelineError(err);
            } else {
                setInstalledToolId(data.toolId);
                // Show a brief success toast via console (toast system varies by project)
                console.info(`[ScriptForgeView] Installed as ${data.toolName} (${data.toolId})`);
            }
        } catch (err) {
            setPipelineError(`Network error — install unavailable: ${err.message}`);
        } finally {
            setInstalling(false);
        }
    }, [installing, testResult, user, authFetch]);

    // ── Pipeline: Assign ──────────────────────────────────────────────────────

    const handleAssign = useCallback(() => {
        if (!installedToolId) return;
        // Navigate to the existing P4 Agent-Tool Matrix UI
        navigate(`/tools/assign?toolId=${encodeURIComponent(installedToolId)}`);
    }, [installedToolId, navigate]);

    // ── Slice 5 — Proposed patch handlers ────────────────────────────────────

    const applyPatch = useCallback((patch) => {
        if (!patch || !Array.isArray(patch.patches)) return;
        setFiles(prev => {
            const updated = { ...prev };
            for (const p of patch.patches) {
                if (p && p.path && typeof p.newText === 'string') {
                    updated[p.path] = p.newText;
                }
            }
            return updated;
        });
        // Trigger debounced save with latest files
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            saveToServer({ ...filesRef.current });
        }, 0);
        setPendingPatch(null);
        setRightRailSection('chat');
    }, [saveToServer]);

    const discardPatch = useCallback(() => {
        setPendingPatch(null);
    }, []);

    const handleAssistantMessage = useCallback((msg) => {
        if (!msg.proposedPatch) return;
        if (autoApply) {
            // Track message ID as applied before calling applyPatch (which clears pendingPatch)
            if (msg.messageId) {
                setAppliedMessageIds(prev => new Set(prev).add(msg.messageId));
            }
            applyPatch(msg.proposedPatch);
        } else {
            setPendingPatch(msg.proposedPatch);
            setRightRailSection('diff');
        }
    }, [autoApply, applyPatch]);

    const handleProposedPatchAction = useCallback((action, proposedPatch, messageId) => {
        if (action === 'show') {
            setPendingPatch(proposedPatch);
            setRightRailSection('diff');
        } else if (action === 'apply') {
            if (messageId) setAppliedMessageIds(prev => new Set(prev).add(messageId));
            applyPatch(proposedPatch);
        } else if (action === 'discard') {
            discardPatch();
        }
    }, [applyPatch, discardPatch]);

    // Memoise the addon renderer so AgentChatSidebar gets a stable function
    // identity across re-renders. Fresh closures here used to be a suspected
    // cause of the chat-message-disappears-on-Apply regression (FIX-1a-5).
    const renderMessageAddon = useCallback((msg) => {
        if (!msg.proposedPatch) return null;
        const alreadyApplied = !!(msg.messageId && appliedMessageIds.has(msg.messageId));
        return (
            <ProposedPatchChip
                proposedPatch={msg.proposedPatch}
                agentColor={TOOLSMITH_ORANGE}
                onShow={() => handleProposedPatchAction('show', msg.proposedPatch, msg.messageId)}
                onApply={() => handleProposedPatchAction('apply', msg.proposedPatch, msg.messageId)}
                onDiscard={() => handleProposedPatchAction('discard', msg.proposedPatch, msg.messageId)}
                alreadyApplied={alreadyApplied}
            />
        );
    }, [appliedMessageIds, handleProposedPatchAction]);

    // ── Render ────────────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <span className="qx-spinner qx-spinner--sm" />
                <span style={{ marginLeft: 8, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>Loading draft&hellip;</span>
            </div>
        );
    }

    const editorLanguage = FILE_LANGUAGE[activeFile] || 'plaintext';
    const editorValue = files[activeFile] ?? '';

    return (
        <DevShell
            agentId="toolsmith"
            storageKey="toolsmith-devshell-sizes"
            fileTree={
                <div style={{
                    padding: '12px 8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    height: '100%',
                    boxSizing: 'border-box',
                }}>
                    <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: 'rgba(255,255,255,0.35)',
                        textTransform: 'uppercase',
                        marginBottom: 6,
                        paddingLeft: 10,
                        flexShrink: 0,
                    }}>
                        Files
                    </div>
                    <FileTree files={files} active={activeFile} onSelect={setActiveFile} />
                </div>
            }
            editor={
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
                    {/* Editor tab bar */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        borderBottom: '1px solid rgba(255,255,255,0.08)',
                        padding: '0 16px',
                        height: 36,
                        flexShrink: 0,
                        background: 'rgba(0,0,0,0.15)',
                    }}>
                        <span style={{ fontSize: 13, color: TOOLSMITH_ORANGE, fontFamily: 'monospace', fontWeight: 600 }}>
                            {activeFile}
                        </span>
                        <SaveStatus status={saveStatus} validationState={validationState} />
                    </div>

                    {/* Monaco */}
                    <div style={{ flex: 1, minHeight: 0 }}>
                        <Suspense fallback={
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                                <span className="qx-spinner qx-spinner--sm" />
                            </div>
                        }>
                            <MonacoEditor
                                height="100%"
                                language={editorLanguage}
                                value={editorValue}
                                onChange={handleEditorChange}
                                theme="vs-dark"
                                options={{
                                    fontSize: 13,
                                    minimap: { enabled: false },
                                    scrollBeyondLastLine: false,
                                    wordWrap: 'on',
                                    tabSize: 4,
                                    padding: { top: 12, bottom: 12 },
                                    renderLineHighlight: 'line',
                                }}
                            />
                        </Suspense>
                    </div>
                </div>
            }
            rightRail={
                <ToolsmithChatSidebar
                    draftId={draftId}
                    activeFile={activeFile}
                    files={Object.keys(files).map(name => ({ name }))}
                    validationState={validationState}
                    chatHandleRef={chatSendRef}
                    activeSection={rightRailSection}
                    onSectionChange={setRightRailSection}
                    onAssistantMessage={handleAssistantMessage}
                    autoApply={autoApply}
                    onAutoApplyChange={setAutoApply}
                    renderMessageAddon={renderMessageAddon}
                    extraSections={[
                        {
                            id: 'diff',
                            label: 'Diff',
                            icon: (
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                            ),
                            badge: pendingPatch ? pendingPatch.patches.length : null,
                            content: (
                                <DiffSection
                                    pendingPatch={pendingPatch}
                                    files={files}
                                    onApply={() => applyPatch(pendingPatch)}
                                    onDiscard={discardPatch}
                                    agentColor={TOOLSMITH_ORANGE}
                                />
                            ),
                        },
                        {
                            id: 'live',
                            label: 'Analyse',
                            icon: (
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                            ),
                            content: (
                                <LiveAnalysisSection
                                    result={analyserResult}
                                    lastAnalysedAt={lastAnalysedAt}
                                    activeFile={activeFile}
                                />
                            ),
                        },
                    ]}
                />
            }
            pipelineBar={
                <div style={{
                    padding: '10px 12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                }}>
                    <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        color: 'rgba(255,255,255,0.35)',
                        textTransform: 'uppercase',
                    }}>
                        Pipeline
                    </div>

                    {/* Pipeline buttons */}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {/* Test button — always enabled */}
                        <button
                            onClick={handleTest}
                            disabled={testRunning}
                            title="Run script in sandbox"
                            style={{
                                padding: 0,
                                paddingTop: 5,
                                paddingBottom: 5,
                                paddingLeft: 10,
                                paddingRight: 10,
                                borderRadius: 5,
                                border: `1px solid ${testRunning ? 'rgba(255,255,255,0.08)' : 'rgba(249,115,22,0.4)'}`,
                                background: testRunning ? 'rgba(255,255,255,0.04)' : 'rgba(249,115,22,0.12)',
                                color: testRunning ? 'rgba(255,255,255,0.3)' : TOOLSMITH_ORANGE,
                                fontSize: 12,
                                cursor: testRunning ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                            }}
                        >
                            <PipelineIcon label="Test" active={!testRunning} />
                            {testRunning ? 'Running…' : 'Test'}
                        </button>

                        {/* Install button — enabled only if last test passed */}
                        <button
                            onClick={handleInstall}
                            disabled={installing || !testResult || testResult.exitCode !== 0}
                            title={!testResult || testResult.exitCode !== 0 ? 'Run a successful test first' : 'Install to org tool library'}
                            style={{
                                padding: 0,
                                paddingTop: 5,
                                paddingBottom: 5,
                                paddingLeft: 10,
                                paddingRight: 10,
                                borderRadius: 5,
                                border: `1px solid ${(!testResult || testResult.exitCode !== 0 || installing) ? 'rgba(255,255,255,0.1)' : 'rgba(34,197,94,0.4)'}`,
                                background: (!testResult || testResult.exitCode !== 0 || installing) ? 'rgba(255,255,255,0.04)' : 'rgba(34,197,94,0.12)',
                                color: (!testResult || testResult.exitCode !== 0 || installing) ? 'rgba(255,255,255,0.3)' : '#22c55e',
                                fontSize: 12,
                                cursor: (!testResult || testResult.exitCode !== 0 || installing) ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                            }}
                        >
                            <PipelineIcon label="Install" active={!!(testResult && testResult.exitCode === 0 && !installing)} />
                            {installing ? 'Installing…' : installedToolId ? 'Reinstall' : 'Install'}
                        </button>

                        {/* Assign button — enabled only after install */}
                        <button
                            onClick={handleAssign}
                            disabled={!installedToolId}
                            title={!installedToolId ? 'Install first to enable assignment' : 'Assign to agent in tool matrix'}
                            style={{
                                padding: 0,
                                paddingTop: 5,
                                paddingBottom: 5,
                                paddingLeft: 10,
                                paddingRight: 10,
                                borderRadius: 5,
                                border: `1px solid ${!installedToolId ? 'rgba(255,255,255,0.1)' : 'rgba(147,197,253,0.4)'}`,
                                background: !installedToolId ? 'rgba(255,255,255,0.04)' : 'rgba(147,197,253,0.12)',
                                color: !installedToolId ? 'rgba(255,255,255,0.3)' : '#93c5fd',
                                fontSize: 12,
                                cursor: !installedToolId ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                            }}
                        >
                            <PipelineIcon label="Assign" active={!!installedToolId} />
                            Assign
                        </button>
                    </div>

                    {/* Pipeline error */}
                    {pipelineError && (
                        <div style={{ fontSize: 11, color: '#ef4444', marginTop: 2 }}>
                            {pipelineError}
                        </div>
                    )}

                </div>
            }
            bottomDock={
                <TerminalDock
                    agentColor={TOOLSMITH_ORANGE}
                    result={testResult}
                    collapsed={terminalCollapsed}
                    onToggleCollapsed={() => setTerminalCollapsed(c => !c)}
                    onClear={() => setTestResult(null)}
                />
            }
        />
    );
});

export default ScriptForgeView;

function PipelineIcon({ label, active = false }) {
    const color = active
        ? (label === 'Test' ? TOOLSMITH_ORANGE : label === 'Install' ? '#22c55e' : '#93c5fd')
        : 'rgba(255,255,255,0.3)';
    if (label === 'Test') {
        return (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
                <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
        );
    }
    if (label === 'Install') {
        return (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
        );
    }
    // Assign
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
    );
}

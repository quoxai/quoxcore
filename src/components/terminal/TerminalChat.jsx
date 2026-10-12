/**
 * TerminalChat - QuoxCode AI Chat Panel for Terminal Workspace
 *
 * Collapsible overlay chat panel that floats alongside terminal panes.
 * Uses ChatEngine render prop for full AEE/AOCL audit trail, auth chain,
 * memory context, Smart Router bypass, and conversation persistence.
 *
 * Phase 2: Mode-aware prompting + terminal output context.
 * Phase 3: "Run in Terminal" buttons on shell code blocks.
 *
 * The contextBuilder fetches the focused pane's terminal output from the collector
 * and composes it with the selected mode policy block. Shell code blocks in AI
 * responses get Run buttons that inject commands into the active PTY session.
 *
 * Props:
 *   workspaceId: string      — scopes ChatEngine session per workspace tab
 *   isOpen: boolean          — visibility
 *   onClose: () => void      — toggle callback
 *   sessionId: string|null   — focused pane's terminal session ID (for output context)
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatEngine } from '../chat/ChatEngine';
import { ChatInput } from '../chat/input/ChatInput';
import { GlassChatPanel } from '../chat/glass';
import { useAuth } from '../../contexts/AuthContext';
import { useSettings } from '../../hooks/useSettings';
import { getConfiguredProviders, getModelsForProvider, getDefaultModel } from '../../services/llmService';
import { TERMINAL_MODES, DEFAULT_MODE, loadMode, saveMode } from '../../config/terminalModes';
import { buildTerminalContext } from '../../services/terminalContextBuilder';
import { execInTerminal } from '../../services/terminalExecService';
import RunnableCodeBlock from './RunnableCodeBlock';
import FileChangeCard from './FileChangeCard';
import { FileChangeGroupProvider } from './FileChangeGroup';
import TerminalExecConfirmModal from './TerminalExecConfirmModal';
import { parseFileBlock } from '../../services/terminalFileService';
import SuggestionChips from './SuggestionChips';
import { generateSuggestionChips } from '../../utils/suggestionChipGenerator';
import { recordErrorResolution } from '../../services/terminalMemoryBridge';
import useMemoryActivity from '../../hooks/useMemoryActivity';
import MemoryActivityFeed from './MemoryActivityFeed';
import './TerminalChat.css';

// ── Static markdown components (no terminal context needed) ───────────

const staticMdComponents = {
    strong: ({ children }) => <strong>{children}</strong>,
    em: ({ children }) => <em>{children}</em>,
    code: ({ children, className }) => <code className={className}>{children}</code>,
    h1: ({ children }) => <strong style={{ fontSize: '1.1em' }}>{children}</strong>,
    h2: ({ children }) => <strong style={{ fontSize: '1.05em' }}>{children}</strong>,
    h3: ({ children }) => <strong>{children}</strong>,
    ul: ({ children }) => <ul>{children}</ul>,
    ol: ({ children }) => <ol>{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({ children }) => <table className="terminal-chat__table">{children}</table>,
    th: ({ children }) => <th>{children}</th>,
    td: ({ children }) => <td>{children}</td>,
};

// ── Model selector helpers (consolidated into single key) ────────────

import { queueSync } from '../../services/serverSyncQueue';

const CONSOLIDATED_MODELS_KEY = 'quox-terminal-chat-models';
const OLD_MODEL_PREFIX = 'quox-terminal-chat-model-';

let _terminalModels = null;

function getTerminalModels() {
    if (_terminalModels) return _terminalModels;
    try {
        const raw = localStorage.getItem(CONSOLIDATED_MODELS_KEY);
        if (raw) { _terminalModels = JSON.parse(raw); return _terminalModels; }
    } catch { /* fall through */ }

    // Migrate from old per-workspace keys
    _terminalModels = {};
    let migrated = false;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(OLD_MODEL_PREFIX)) {
            const wsId = key.slice(OLD_MODEL_PREFIX.length);
            try {
                _terminalModels[wsId] = JSON.parse(localStorage.getItem(key));
                migrated = true;
            } catch { /* skip */ }
            toRemove.push(key);
        }
    }
    if (migrated) {
        toRemove.forEach(k => localStorage.removeItem(k));
        saveTerminalModels();
        console.log('[TerminalChat] Migrated model selections to consolidated storage');
    }
    return _terminalModels;
}

function saveTerminalModels() {
    try {
        localStorage.setItem(CONSOLIDATED_MODELS_KEY, JSON.stringify(_terminalModels));
        queueSync('terminalChatModels', _terminalModels);
    } catch { /* quota */ }
}

function loadModelSelection(workspaceId) {
    return getTerminalModels()[workspaceId] || null;
}

function saveModelSelection(workspaceId, selection) {
    const models = getTerminalModels();
    models[workspaceId] = selection;
    _terminalModels = models;
    saveTerminalModels();
}

// ── Component ────────────────────────────────────────────────────────

export default function TerminalChat({ workspaceId, paneId, isOpen, onClose, sessionId, chatSendRef, pendingErrorRef }) {
    const { authFetch } = useAuth();
    const [providers, setProviders] = useState([]);
    const [selectedProvider, setSelectedProvider] = useState(null);
    const [selectedModel, setSelectedModel] = useState(null);

    // Mode state (persisted per workspace)
    const [selectedMode, setSelectedMode] = useState(() => loadMode(workspaceId));

    // Load saved model selection
    useEffect(() => {
        const saved = loadModelSelection(workspaceId);
        if (saved) {
            setSelectedProvider(saved.provider);
            setSelectedModel(saved.model);
        }
    }, [workspaceId]);

    // Reload mode when workspace changes
    useEffect(() => {
        setSelectedMode(loadMode(workspaceId));
    }, [workspaceId]);

    // Load providers
    useEffect(() => {
        getConfiguredProviders().then(p => {
            setProviders(p);
            if (!selectedProvider && p.length > 0) {
                const first = p[0];
                setSelectedProvider(first.id);
                setSelectedModel(getDefaultModel(first.id));
            }
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleModelChange = useCallback((e) => {
        const value = e.target.value;
        const [provider, model] = value.split('::');
        setSelectedProvider(provider);
        setSelectedModel(model);
        saveModelSelection(workspaceId, { provider, model });
    }, [workspaceId]);

    const handleModeChange = useCallback((mode) => {
        setSelectedMode(mode);
        saveMode(workspaceId, mode);
    }, [workspaceId]);

    // Build model options from configured providers
    const modelOptions = useMemo(() => {
        const opts = [];
        for (const provider of providers) {
            if (!provider.configured && !provider.fallback) continue;
            const models = getModelsForProvider(provider.id);
            for (const model of models) {
                opts.push({
                    value: `${provider.id}::${model.id}`,
                    label: model.name,
                    group: provider.name
                });
            }
        }
        return opts;
    }, [providers]);

    const selectedValue = selectedProvider && selectedModel ? `${selectedProvider}::${selectedModel}` : '';

    // Context builder: fetches terminal output + composes with mode policy
    const contextBuilder = useCallback(async (query) => {
        return buildTerminalContext(query, sessionId, selectedMode);
    }, [sessionId, selectedMode]);

    // Exec confirmation state (for WARN/REQUIRE_APPROVAL commands)
    const [execConfirm, setExecConfirm] = useState(null);

    const handleExecRequest = useCallback((command, validation) => {
        setExecConfirm({ command, validation });
    }, []);

    const handleExecConfirm = useCallback(async () => {
        if (!execConfirm) return;
        await execInTerminal(sessionId, execConfirm.command, authFetch);
        setExecConfirm(null);
    }, [sessionId, execConfirm, authFetch]);

    const handleExecCancel = useCallback(() => {
        setExecConfirm(null);
    }, []);

    if (!isOpen) return null;

    return (
        <ChatEngine
            agent="quoxcode"
            contextBuilder={contextBuilder}
            sessionPrefix={`TERMCHAT_${workspaceId}_${paneId}`}
            enableSmartRouter={true}
            enableMemory={true}
            llmProvider={selectedProvider}
            llmModel={selectedModel}
        >
            {(chatState) => (
                <>
                    <TerminalChatUI
                        chatState={chatState}
                        onClose={onClose}
                        modelOptions={modelOptions}
                        selectedValue={selectedValue}
                        onModelChange={handleModelChange}
                        selectedMode={selectedMode}
                        onModeChange={handleModeChange}
                        sessionId={sessionId}
                        authFetch={authFetch}
                        onExecRequest={handleExecRequest}
                        chatSendRef={chatSendRef}
                        pendingErrorRef={pendingErrorRef}
                        workspaceId={workspaceId}
                    />
                    <TerminalExecConfirmModal
                        isOpen={!!execConfirm}
                        onClose={handleExecCancel}
                        command={execConfirm?.command}
                        validation={execConfirm?.validation}
                        onConfirm={handleExecConfirm}
                    />
                </>
            )}
        </ChatEngine>
    );
}

// ── Inner UI (separated so ChatEngine render prop stays clean) ────────

function TerminalChatUI({ chatState, onClose, modelOptions, selectedValue, onModelChange, selectedMode, onModeChange, sessionId, authFetch, onExecRequest, chatSendRef, pendingErrorRef, workspaceId }) {
    const { messages, isProcessing, halState, error, chatStatus, sendMessage, abortMessage, clearConversation } = chatState;
    const { getSetting } = useSettings();
    const useGlassChat = getSetting('useGlassChat', false);

    // Memory activity feed
    const memoryActivity = useMemoryActivity(workspaceId);

    // Expose sendMessage to parent via ref (for error notification → chat flow)
    useEffect(() => {
        if (chatSendRef) chatSendRef.current = sendMessage;
        return () => { if (chatSendRef) chatSendRef.current = null; };
    }, [chatSendRef, sendMessage]);

    // Extract last assistant message text as a stable string to avoid re-render loops.
    // Using the raw object reference caused cascading useMemo/useEffect invalidation
    // when ChatEngine recreated the messages array (same text, new object).
    const lastAssistantText = useMemo(() => {
        if (messages.length === 0) return null;
        const last = messages[messages.length - 1];
        return last.role === 'assistant' ? last.text : null;
    }, [messages]);

    // Record error→resolution pair when AI responds to a pending error
    useEffect(() => {
        if (lastAssistantText && pendingErrorRef?.current) {
            recordErrorResolution(pendingErrorRef.current, lastAssistantText, null);
            pendingErrorRef.current = null;
        }
    }, [lastAssistantText]);
    // Compute chips based on content only — NOT isProcessing.
    // Visibility is handled by CSS transition (hidden class) instead.
    const suggestionChips = useMemo(() => {
        if (!lastAssistantText || selectedMode === 'audit') return [];
        return generateSuggestionChips(lastAssistantText, { mode: selectedMode });
    }, [lastAssistantText, selectedMode]);

    // Hold previous chips during processing so the component stays MOUNTED.
    // Without this, clicking a chip → new user msg → lastAssistantText=null →
    // suggestionChips=[] → component unmounts → flicker on remount.
    const prevChipsRef = useRef([]);
    const displayChips = useMemo(() => {
        if (suggestionChips.length > 0) {
            prevChipsRef.current = suggestionChips;
            return suggestionChips;
        }
        // During processing, return stale chips (CSS hides them anyway)
        if (isProcessing) return prevChipsRef.current;
        // Not processing and no chips — clear stale
        prevChipsRef.current = [];
        return [];
    }, [suggestionChips, isProcessing]);

    // Build markdown components with terminal-aware pre
    const mdComponents = useMemo(() => ({
        ...staticMdComponents,
        pre: (props) => {
            // Extract language string from the code child element
            const codeChild = Array.isArray(props.children) ? props.children[0] : props.children;
            const className = codeChild?.props?.className || '';
            const langMatch = className.match(/language-(.*)/);
            const language = langMatch ? langMatch[1] : '';

            // File change blocks → FileChangeCard
            const codeText = typeof codeChild?.props?.children === 'string'
                ? codeChild.props.children
                : String(codeChild?.props?.children || '');
            const parsed = parseFileBlock(language, codeText);
            if (parsed) {
                return (
                    <FileChangeCard
                        filePath={parsed.filePath}
                        action={parsed.action}
                        content={parsed.content}
                        meta={parsed.meta}
                        targetPath={parsed.targetPath}
                        sessionId={sessionId}
                        mode={selectedMode}
                        authFetch={authFetch}
                    />
                );
            }

            // Shell commands → RunnableCodeBlock (existing)
            return (
                <RunnableCodeBlock
                    {...props}
                    sessionId={sessionId}
                    mode={selectedMode}
                    authFetch={authFetch}
                    onExecRequest={onExecRequest}
                />
            );
        },
    }), [sessionId, selectedMode, authFetch, onExecRequest]);

    const ChatMd = useCallback(({ children }) => (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {children || ''}
        </ReactMarkdown>
    ), [mdComponents]);

    return (
        <div className="terminal-chat">
            {/* Header */}
            <div className="terminal-chat__header">
                <div className="terminal-chat__header-left">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    <span className="terminal-chat__header-title">QuoxCode</span>
                    {halState === 'thinking' && (
                        <span className="terminal-chat__status-dot terminal-chat__status-dot--thinking" />
                    )}
                </div>
                <div className="terminal-chat__header-right">
                    <button className="terminal-chat__header-btn" onClick={clearConversation} title="Clear chat">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                    </button>
                    <button className="terminal-chat__header-btn" onClick={onClose} title="Close chat">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Mode selector + Model selector */}
            <div className="terminal-chat__model-bar">
                <div className="terminal-chat__mode-row">
                    {Object.values(TERMINAL_MODES).map(mode => (
                        <button
                            key={mode.id}
                            className={`terminal-chat__mode-btn ${selectedMode === mode.id ? 'terminal-chat__mode-btn--active' : ''}`}
                            onClick={() => onModeChange(mode.id)}
                            title={mode.description}
                            data-mode={mode.id}
                            style={selectedMode === mode.id ? { borderColor: mode.color, color: mode.color } : undefined}
                        >
                            {mode.label}
                        </button>
                    ))}
                </div>
                <select
                    className="terminal-chat__model-select"
                    value={selectedValue}
                    onChange={onModelChange}
                >
                    {modelOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
            </div>

            {/* Messages */}
            <div className="terminal-chat__messages">
                {/* Auth status warning */}
                {chatStatus.checked && !chatStatus.ready && (
                    <div className="terminal-chat__auth-warning">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>
                            {chatStatus.debug?.cli_reason === 'expired'
                                ? `CLI token expired. Re-authenticate in Settings Terminal.`
                                : chatStatus.error || 'Claude is not connected. Sign in above, or add an API key in Settings.'}
                        </span>
                        {chatStatus.debug && (
                            <span title={JSON.stringify(chatStatus.debug)} style={{ opacity: 0.5, fontSize: '0.85em', marginLeft: '6px' }}>
                                [{chatStatus.debug.cli_reason || '?'}]
                            </span>
                        )}
                    </div>
                )}

                {messages.length === 0 && (
                    <div className="terminal-chat__empty">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.2 }}>
                            <polyline points="4 17 10 11 4 5" />
                            <line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                        <p>Ask QuoxCode about errors, get command suggestions, or debug your terminal output.</p>
                    </div>
                )}

                {messages.map((msg, idx) => (
                    <div key={msg.envelopeId || msg.messageId || idx} className={`terminal-chat__message terminal-chat__message--${msg.role}`}>
                        <div className={`terminal-chat__bubble ${msg.pending ? 'terminal-chat__bubble--pending' : ''}`}>
                            {msg.role === 'assistant' ? (
                                <FileChangeGroupProvider mode={selectedMode} sessionId={sessionId}>
                                    <ChatMd>{msg.text}</ChatMd>
                                </FileChangeGroupProvider>
                            ) : (
                                <span>{msg.text}</span>
                            )}
                        </div>
                        {msg.role === 'assistant' && msg.routedResponse && (
                            <div className="terminal-chat__meta">instant</div>
                        )}
                        {msg.role === 'assistant' && msg.memoryUsed && (
                            <div className="terminal-chat__meta">memory</div>
                        )}
                    </div>
                ))}

                {displayChips.length > 0 && (
                    <SuggestionChips chips={displayChips} onChipClick={sendMessage} hidden={isProcessing} />
                )}

                {isProcessing && (
                    <div className="terminal-chat__processing">Thinking...</div>
                )}
            </div>

            {/* Memory Activity Feed */}
            <MemoryActivityFeed
                events={memoryActivity.events}
                isCollapsed={memoryActivity.isCollapsed}
                toggleCollapsed={memoryActivity.toggleCollapsed}
                eventCount={memoryActivity.eventCount}
                clearEvents={memoryActivity.clearEvents}
            />

            {/* Input — reuses ChatInput component */}
            <div className="terminal-chat__input-area">
                <ChatInput
                    onSend={sendMessage}
                    onStop={abortMessage}
                    placeholder="Ask QuoxCode..."
                    isProcessing={isProcessing}
                    enableVoice={true}
                    voiceKeyboard={false}
                    enableFileUpload={false}
                    className="terminal-chat__chat-input"
                    maxRows={6}
                    hints={false}
                />
                {error && (
                    <div className="terminal-chat__error">
                        {typeof error === 'string' ? error : 'Connection error'}
                    </div>
                )}
            </div>
        </div>
    );
}

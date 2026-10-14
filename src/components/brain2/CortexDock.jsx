/**
 * CortexDock - brain-scoped chat dock for the Qortex page ("Cortex").
 *
 * Self-contained wrapper around the shared ChatEngine (see
 * src/components/chat/ChatEngine.jsx). Modelled on ArchivistView's embed
 * (src/pages/views/ArchivistView.jsx ~line 402): mounts ChatEngine via its
 * render prop, renders a compact message list + composer, and layers in
 * Cortex-specific "cited notes" chips per assistant message by polling
 * GET /collector/api/brain/citations/:sessionId after each turn.
 *
 * Server-side is the source of truth for chat + citations: nothing here is
 * persisted to localStorage/IndexedDB. Citation state lives only in this
 * component's React state and is rebuilt from the server on demand.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatEngine } from '../chat/ChatEngine';
import { cortexSessionPrefix } from './lib/cortexScope';
import './CortexDock.css';

// Confirmed against ChatEngine.jsx: the render-prop `children(chatState)` call
// (~line 1473) receives an object built at the `chatState = useMemo(...)`
// block (~line 1430) with these fields: messages, isProcessing, halState,
// currentText, audioData, isMuted, error, dbPersistError, messageQueue,
// sessionId, currentCorr, assistantConfig, dbConversationId, chatStatus,
// sendMessage, abortMessage, speakText, stopAudio, clearConversation,
// toggleMute, setError. There is no dedicated "streaming" flag; `isProcessing`
// is the in-flight indicator. `sessionId` is the server-assigned session id,
// set via `setSessionId(data.session_id)` at ChatEngine.jsx ~line 1007.
// Assistant messages (added ~line 1077) use { role, text, messageId, ... } —
// display text is `message.text || message.content || ''`, matching the
// `ChatMessage` helper in ArchivistView.jsx.

export const CITATIONS_PATH = (sessionId) => `/collector/api/brain/citations/${encodeURIComponent(sessionId)}`;

function CloseIcon() {
    return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
        </svg>
    );
}

function SendIcon() {
    return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" />
        </svg>
    );
}

function BrainIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2a3.5 3.5 0 00-3.5 3.5v.6A3 3 0 004 9v1.5a3 3 0 00-1 5.6V17a3.5 3.5 0 003.5 3.5H8" />
            <path d="M14.5 2a3.5 3.5 0 013.5 3.5v.6A3 3 0 0120 9v1.5a3 3 0 011 5.6V17a3.5 3.5 0 01-3.5 3.5H16" />
            <path d="M9.5 2v18M14.5 2v18" />
        </svg>
    );
}

function UserIcon() {
    return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
        </svg>
    );
}

function NoteChipIcon() {
    return (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" />
        </svg>
    );
}

function WarnIcon() {
    return (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
    );
}

/** basename('/foo/bar/baz.md') -> 'baz.md'; tolerant of missing/blank input. */
function basename(relPath) {
    if (!relPath) return null;
    const parts = String(relPath).split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
}

// Inline [K1] / [B1] / [R1] tokens (also grouped, "[B1, B2]") in assistant
// text become small chips linked to the cited note. Only handles present in
// the turn's citation record are linked; unknown tokens stay as plain text.
const CITE_GROUP_RE = /\[([KBR]\d+(?:\s*[,;]\s*[KBR]\d+)*)\]/g;

function withCiteChips(children, byHandle, onSelect) {
    if (!byHandle || byHandle.size === 0) return children;
    const walk = (node, keyBase) => {
        if (typeof node !== 'string') return node;
        const out = [];
        let last = 0;
        let m;
        CITE_GROUP_RE.lastIndex = 0;
        while ((m = CITE_GROUP_RE.exec(node)) !== null) {
            const handles = m[1].split(/\s*[,;]\s*/);
            if (!handles.every((h) => byHandle.has(h))) continue;
            if (m.index > last) out.push(node.slice(last, m.index));
            handles.forEach((h) => {
                const c = byHandle.get(h);
                out.push(
                    <button
                        key={`${keyBase}-${m.index}-${h}`}
                        type="button"
                        className="cortex-inline-cite"
                        title={c.title || basename(c.relPath) || h}
                        onClick={() => onSelect?.(c.noteId, { charStart: c.charStart, charEnd: c.charEnd })}
                    >{h}</button>
                );
            });
            last = m.index + m[0].length;
        }
        if (out.length === 0) return node;
        if (last < node.length) out.push(node.slice(last));
        return out;
    };
    return Array.isArray(children)
        ? children.map((ch, i) => walk(ch, i))
        : walk(children, 0);
}

export function citeComponents(record, onSelect) {
    const byHandle = new Map();
    for (const c of record?.citations || []) if (c.handle && c.cited === true) byHandle.set(c.handle, c);
    if (byHandle.size === 0) return undefined;
    const wrap = (Tag) => function CiteWrapped({ node, children, ...props }) { // eslint-disable-line no-unused-vars
        return <Tag {...props}>{withCiteChips(children, byHandle, onSelect)}</Tag>;
    };
    return { p: wrap('p'), li: wrap('li'), td: wrap('td') };
}

export function CitedNotesRow({ record, onCitationSelect }) {
    if (!record) return null;

    if (record.status === 'unavailable') {
        return (
            <div className="cortex-cite-row cortex-cite-row--warn">
                <WarnIcon />
                <span>
                    Knowledge brain unreachable — this answer is NOT grounded.
                    {record.reason ? ` (${record.reason})` : ''}
                </span>
            </div>
        );
    }

    if (record.status === 'empty') {
        return (
            <div className="cortex-cite-row cortex-cite-row--muted">
                Searched your brain — no matching notes.
            </div>
        );
    }

    if (record.status !== 'hits' || !record.citations?.length) {
        return null;
    }

    const flagged = record.citations.filter((c) => c.cited === true);
    // Honest grounding: "grounded" only when the answer actually cited a note.
    // Once finalized with zero cited, say so instead of listing every
    // retrieved note under a grounded label. While still live (not finalized)
    // cited flags do not exist yet, so show the retrieved set neutrally.
    const finalized = record.finalized !== false;
    const retrieved = record.citations.length;
    const shown = flagged.length > 0 ? flagged : (finalized ? [] : record.citations);
    // Cited != supported. "supported" is reserved for the opt-in semantic
    // entailment check. A lexical-only pass is "overlap": the citing sentence
    // shares the passage's words, NOT checked for meaning.
    // supported is null/absent when the collector could not check it.
    const supportMeasured = flagged.some((c) => c.supported === true || c.supported === false);
    const supportedCount = flagged.filter((c) => c.supported === true).length;
    const overlapCount = flagged.filter((c) => c.overlap === true).length;
    // Unchecked (claim cap or evicted passage) is NOT unsupported: no verdict was reached.
    const uncheckedCount = flagged.filter((c) => c.unchecked).length;
    // Fabricated: the answer cited a handle that was never retrieved. Counted, never ignored.
    const fabricatedCount = flagged.filter((c) => c.fabricated).length;
    const fabricatedLabel = fabricatedCount > 0
        ? <span className="cortex-cite-fabricated" title="The answer cites a source handle that was never retrieved for this turn. It is counted as unsupported."> · fabricated {fabricatedCount}</span>
        : null;

    if (flagged.length === 0 && finalized) {
        return (
            <div className="cortex-cite-row cortex-cite-row--ungrounded">
                <span className="cortex-cite-ungrounded">
                    retrieved {retrieved}, cited 0
                </span>
            </div>
        );
    }

    return (
        <div className="cortex-cite-row">
            <span className="cortex-cite-grounded">
                {flagged.length > 0
                    ? <><NoteChipIcon /> cited {shown.length} note{shown.length === 1 ? '' : 's'}{fabricatedLabel}{supportMeasured
                        ? <>
                            {supportedCount > 0 && <span title="A model checked that the cited passage supports this sentence."> · supported {supportedCount} (checked)</span>}
                            {overlapCount > 0 && <span title="The sentence citing the note shares the passage's words; not checked for meaning."> · overlap {overlapCount} (words match, not checked for meaning)</span>}
                            {supportedCount === 0 && overlapCount === 0 && uncheckedCount === 0 && <span title="Neither a meaning check nor enough shared wording found support."> · supported 0</span>}
                            {uncheckedCount > 0 && <span title="Not checked (too many claims in one answer, or the passage text was no longer held). This is not a verdict of unsupported."> · unchecked {uncheckedCount}</span>}
                        </>
                        : (uncheckedCount > 0 ? <span title="Not checked (too many claims in one answer, or the passage text was no longer held). This is not a verdict of unsupported."> · unchecked {uncheckedCount}</span> : null)}</>
                    : <>retrieved {retrieved}, checking citations</>}
            </span>
            <div className="cortex-cite-chips">
                {shown.map((c, i) => (
                    <button
                        key={c.noteId || `${c.index}-${i}`}
                        type="button"
                        className={`cortex-cite-chip${c.supported === false && c.overlap !== true && !c.unchecked ? ' cortex-cite-chip--unsupported' : ''}`}
                        title={`${c.supported === false && c.overlap !== true && !c.unchecked ? '(cited, but the sentence shares little wording with this note) ' : ''}${c.snippet || c.title || c.relPath || ''}`}
                        onClick={() => onCitationSelect?.(c.noteId, { charStart: c.charStart, charEnd: c.charEnd })}
                    >
                        <NoteChipIcon />
                        <span>{c.title || basename(c.relPath) || 'Note'}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

export default function CortexDock({ orgId, userId, authFetch, onCitationSelect, onCitedNotesChange, onClose, onActivityChange, seedDraft, suggestions }) {
    const [draft, setDraft] = useState('');
    // "Ask about this note" (NoteReader) seeds the composer with a contextual
    // opener. Apply each distinct seed once so the user can still edit or clear
    // it afterwards — we never clobber their own typing on unrelated renders.
    const lastSeedRef = useRef('');
    useEffect(() => {
        if (seedDraft && seedDraft !== lastSeedRef.current) {
            lastSeedRef.current = seedDraft;
            setDraft(seedDraft);
        }
    }, [seedDraft]);
    // Citation records keyed by assistant messageId -> { status, citations?, reason?, finalized }
    const [citationsByMessage, setCitationsByMessage] = useState({});

    const sessionIdRef = useRef(null);
    // BRAIN2-W5 128: browser-stored conversation is keyed by org + user.
    const sessionPrefix = cortexSessionPrefix(orgId, userId);
    const listRef = useRef(null);

    const applyCitationData = useCallback((messageId, data) => {
        const status = data?.status || 'not_searched';
        if (status === 'not_searched') {
            setCitationsByMessage((prev) => ({ ...prev, [messageId]: { status: 'not_searched' } }));
            onCitedNotesChange?.(new Set());
            return;
        }
        if (status === 'unavailable') {
            setCitationsByMessage((prev) => ({ ...prev, [messageId]: { status: 'unavailable', reason: data.reason } }));
            onCitedNotesChange?.(new Set());
            return;
        }
        if (status === 'empty') {
            setCitationsByMessage((prev) => ({ ...prev, [messageId]: { status: 'empty' } }));
            onCitedNotesChange?.(new Set());
            return;
        }
        // 'hits'
        const citations = Array.isArray(data.citations) ? data.citations : [];
        setCitationsByMessage((prev) => ({
            ...prev,
            [messageId]: { status: 'hits', citations, finalized: data.finalized !== false }
        }));
        const flagged = citations.filter((c) => c.cited === true);
        const citedIds = (flagged.length > 0 ? flagged : (data.finalized === false ? citations : []))
            .map((c) => c.noteId)
            .filter(Boolean);
        onCitedNotesChange?.(new Set(citedIds));
    }, [onCitedNotesChange]);

    const fetchCitations = useCallback(async (sessionId, messageId) => {
        if (!authFetch || !sessionId) return;
        try {
            const res = await authFetch(CITATIONS_PATH(sessionId));
            if (res.status === 404) {
                setCitationsByMessage((prev) => ({ ...prev, [messageId]: { status: 'not_searched' } }));
                return;
            }
            if (!res.ok) {
                setCitationsByMessage((prev) => ({ ...prev, [messageId]: { status: 'unavailable', reason: `HTTP ${res.status}` } }));
                onCitedNotesChange?.(new Set());
                return;
            }
            const data = await res.json().catch(() => null);
            if (!data) {
                setCitationsByMessage((prev) => ({ ...prev, [messageId]: { status: 'unavailable', reason: 'bad response' } }));
                onCitedNotesChange?.(new Set());
                return;
            }
            applyCitationData(messageId, data);
            // RACE: pre-finalize hits are fine to show; re-fetch once to upgrade
            // to the finalized cited set. Never throw on a failed re-fetch.
            if (data.finalized === false) {
                setTimeout(async () => {
                    try {
                        const res2 = await authFetch(CITATIONS_PATH(sessionId));
                        if (res2.ok) {
                            const data2 = await res2.json().catch(() => null);
                            if (data2) applyCitationData(messageId, data2);
                        }
                    } catch { /* keep the pre-finalize result */ }
                }, 1500);
            }
        } catch {
            // Never throw on a failed fetch — treat as not_searched so we don't
            // falsely claim the answer is ungrounded due to a network hiccup.
            setCitationsByMessage((prev) => ({ ...prev, [messageId]: { status: 'not_searched' } }));
        }
    }, [authFetch, applyCitationData, onCitedNotesChange]);

    const handleAssistantMessage = useCallback((msg) => {
        const messageId = msg?.messageId;
        if (!messageId) return;
        // sessionId is set on ChatEngine state slightly before onAssistantMessage
        // fires, but state flushes are async — poll the ref briefly rather than
        // assuming it is already current.
        let attempts = 0;
        const tryFetch = () => {
            const sid = sessionIdRef.current;
            if (sid) {
                fetchCitations(sid, messageId);
                return;
            }
            attempts += 1;
            if (attempts < 6) {
                setTimeout(tryFetch, 150);
            }
        };
        tryFetch();
    }, [fetchCitations]);

    return (
        <ChatEngine
            key={sessionPrefix}
            agent="cortex"
            sessionPrefix={sessionPrefix}
            orgId={orgId}
            authFetch={authFetch}
            enableMemory
            enableSmartRouter
            onAssistantMessage={handleAssistantMessage}
        >
            {(chatState) => {
                const { messages, isProcessing, sessionId, sendMessage, error } = chatState;
                sessionIdRef.current = sessionId || sessionIdRef.current;

                return (
                    <CortexDockBody
                        messages={messages}
                        isProcessing={isProcessing}
                        error={error}
                        sendMessage={sendMessage}
                        draft={draft}
                        setDraft={setDraft}
                        citationsByMessage={citationsByMessage}
                        onCitationSelect={onCitationSelect}
                        onClose={onClose}
                        listRef={listRef}
                        onActivityChange={onActivityChange}
                        suggestions={suggestions}
                    />
                );
            }}
        </ChatEngine>
    );
}

function CortexDockBody({
    messages,
    isProcessing,
    error,
    sendMessage,
    draft,
    setDraft,
    citationsByMessage,
    onCitationSelect,
    onClose,
    listRef,
    onActivityChange,
    suggestions
}) {
    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages, isProcessing, listRef]);

    // Report REAL activity phase derived from turn state (isProcessing).
    // 'searching' while a turn is in flight; 'answering' for a short hold on
    // the true->false edge (turn just finished); 'idle' otherwise.
    const wasProcessingRef = useRef(false);
    useEffect(() => {
        let idleTimer;
        if (isProcessing) {
            onActivityChange?.('searching');
        } else if (wasProcessingRef.current) {
            // true -> false edge: a turn just finished.
            onActivityChange?.('answering');
            idleTimer = setTimeout(() => {
                onActivityChange?.('idle');
            }, 2500);
        }
        wasProcessingRef.current = isProcessing;
        return () => {
            if (idleTimer) clearTimeout(idleTimer);
        };
    }, [isProcessing, onActivityChange]);

    const handleSend = useCallback(() => {
        const text = draft.trim();
        if (!text) return;
        sendMessage(text);
        setDraft('');
    }, [draft, sendMessage, setDraft]);

    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    return (
        <div className="cortex-dock">
            <div className="cortex-dock-header">
                <div className="cortex-dock-title">
                    <BrainIcon />
                    <span>Qortex · your brain</span>
                </div>
                <button
                    type="button"
                    className="cortex-dock-close"
                    onClick={() => onClose?.()}
                    title="Close Cortex"
                >
                    <CloseIcon />
                </button>
            </div>

            <div className="cortex-dock-messages" ref={listRef}>
                {messages.length === 0 ? (
                    <div className="cortex-dock-empty">
                        <BrainIcon />
                        <p>Ask Qortex anything about what is in your brain.</p>
                        {Array.isArray(suggestions) && suggestions.slice(0, 3).map((sg) => (
                            <button
                                key={sg.question}
                                type="button"
                                className="qx-btn qx-btn--ghost qx-btn--sm"
                                title={`${sg.reason} (${sg.source})`}
                                disabled={isProcessing}
                                onClick={() => sendMessage(sg.question)}
                            >
                                <NoteChipIcon />
                                {sg.question}
                            </button>
                        ))}
                    </div>
                ) : (
                    messages.map((msg, i) => {
                        const isUser = msg.role === 'user';
                        const content = msg.text || msg.content || '';
                        const citeRecord = !isUser && msg.messageId ? citationsByMessage[msg.messageId] : null;
                        return (
                            <div key={msg.messageId || i} className={`cortex-msg ${isUser ? 'cortex-msg--user' : 'cortex-msg--assistant'}`}>
                                <div className="cortex-msg-avatar">
                                    {isUser ? <UserIcon /> : <BrainIcon />}
                                </div>
                                <div className="cortex-msg-body">
                                    {isUser ? (
                                        <div className="cortex-msg-text">{content}</div>
                                    ) : (
                                        <div className="cortex-msg-text cortex-msg-text--markdown">
                                            <ReactMarkdown
                                                remarkPlugins={[remarkGfm]}
                                                components={citeComponents(citeRecord, onCitationSelect)}
                                            >{content}</ReactMarkdown>
                                        </div>
                                    )}
                                    {citeRecord && (
                                        <CitedNotesRow record={citeRecord} onCitationSelect={onCitationSelect} />
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
                {isProcessing && (
                    <div className="cortex-msg cortex-msg--assistant">
                        <div className="cortex-msg-avatar"><BrainIcon /></div>
                        <div className="cortex-msg-body">
                            <div className="cortex-typing">
                                <span></span><span></span><span></span>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {error && (
                <div className="cortex-dock-error">{error}</div>
            )}

            <div className="cortex-dock-composer">
                <textarea
                    className="cortex-dock-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask Qortex about your brain..."
                    rows={1}
                />
                <button
                    type="button"
                    className="cortex-dock-send"
                    onClick={handleSend}
                    disabled={!draft.trim()}
                    title="Send"
                >
                    <SendIcon />
                </button>
            </div>
        </div>
    );
}

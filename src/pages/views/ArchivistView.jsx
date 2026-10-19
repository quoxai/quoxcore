/**
 * ArchivistView - ARCHIVIST File Chat Interface
 *
 * Uses the shared ChatEngine for core functionality, adding:
 * - Folder scope selection
 * - CodexVisualizer (ARCHIVIST's unique visualizer)
 * - Quick skills (summarize, analyze, extract)
 * - File citation support
 *
 * This approach ensures consistent behavior with HomeView while
 * adding ARCHIVIST-specific features.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useOutletContext, useNavigate, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatEngine, ChatInput, VisualizerSection, CitationBlock, GlassChatPanel } from '../../components/chat';
import CodexVisualizer from '../../components/visualizations/themes/CodexVisualizer';
import { getAgentSuggestions } from '../../config/agentRegistry';
import { resolveAssistantIdentity } from '../../services/assistantIdentity';
import {
    listFiles,
    getFolderTree,
    getFile,
    formatFileSize,
    getStorageUsage,
    syncMetadata,
    checkServerHealth
} from '../../services/fileStorage';
import {
    buildFolderContext,
    searchFolderFiles,
    generateGroundedPrompt,
    canUseSemanticSearch
} from '../../services/scopedChatService';
import { isPremiumFilesAvailable, getRecentlyAccessedFiles } from '../../services/fileMemoryBridge';
import {
    FILE_SKILLS,
    isFileOpsAvailable,
    executeSkill
} from '../../services/fileOpsAgent';
import './views.css';
import './archivist-view.css';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'

/**
 * Build ARCHIVIST context for a specific folder scope
 * This is passed to ChatEngine as the contextBuilder
 */
async function buildArchivistFolderContext(query, folderPath = '/') {
    try {
        // Ensure metadata is synced from server before listing
        await syncMetadata().catch(err => console.warn('[ARCHIVIST] Sync failed:', err));

        const files = listFiles({ folderPath, recursive: true });
        const folderTree = getFolderTree();
        const usage = getStorageUsage();

        // No files? Return basic guidance
        if (files.length === 0) {
            return `## CRITICAL: FILE-GROUNDED MODE

You are ARCHIVIST in FILE-ONLY mode. You MUST:
1. ONLY work with files uploaded to the QuoxCORE Files page
2. NEVER search SSH hosts, remote servers, or paths like /home/, /var/, /opt/
3. Tell the user to upload files first before you can help
4. NEVER make up or invent file contents

### CURRENT SCOPE: ${folderPath === '/' ? 'All Files' : folderPath}

**Status:** No files in this scope.

The user needs to upload files via the Files page first. Once they do, you can:
- Read and analyze file contents
- Summarize documents
- Compare files
- Extract structured data
- Search across files

**RESPOND TO THE USER:** "I don't have any files in the current scope. Please upload files through the **Files** page, then I can help you analyze them."`;
        }

        // Build file inventory
        const fileList = files.map(f => ({
            id: f.id,
            name: f.name,
            type: f.type,
            size: formatFileSize(f.size),
            folder: f.folderPath || '/',
            category: f.category
        }));

        // Search for relevant content if query is substantive
        let searchContext = '';
        if (query && query.length > 3) {
            try {
                const searchResults = await searchFolderFiles(query, folderPath, {
                    recursive: true,
                    limit: 5
                });

                if (searchResults.length > 0) {
                    const searchType = canUseSemanticSearch() ? 'semantic+keyword' : 'keyword';
                    searchContext = `
### Search Results (${searchType} match for "${query}")
${searchResults.map((r, i) => `[${i + 1}] **${r.file.name}** (score: ${(r.score * 100).toFixed(0)}%)
   ${r.snippet ? `> ${r.snippet.substring(0, 150)}...` : ''}`).join('\n\n')}
`;
                }
            } catch (err) {
                console.warn('[ARCHIVIST] Search failed:', err);
            }
        }

        // Get file content for top matches
        let fileContentSection = '';
        const queryLower = query.toLowerCase();
        const relevantFiles = files
            .filter(f => queryLower.includes(f.name.toLowerCase()) || f.category !== 'image')
            .slice(0, 2);

        for (const file of relevantFiles) {
            if (file.category === 'image') continue;
            try {
                const fullFile = getFile(file.id);
                if (fullFile?.data) {
                    const base64Content = fullFile.data.includes(',')
                        ? fullFile.data.split(',')[1]
                        : fullFile.data;
                    if (base64Content) {
                        const decoded = atob(base64Content);
                        const truncated = decoded.length > 6000
                            ? decoded.substring(0, 6000) + '\n...[truncated]'
                            : decoded;
                        fileContentSection += `
### File Content: ${file.name}
\`\`\`
${truncated}
\`\`\`
`;
                    }
                }
            } catch {
                // Skip files that can't be decoded
            }
        }

        // Build comprehensive context
        const premiumStatus = isPremiumFilesAvailable()
            ? 'Semantic search enabled'
            : 'Keyword search only (upgrade for semantic)';

        return `## CRITICAL: FILE-GROUNDED MODE

**YOU MUST FOLLOW THESE RULES:**
1. Your ONLY source of information is the files listed below in the FILE INVENTORY
2. NEVER use web search, internet lookups, SSH hosts, or external sources
3. If the answer is NOT in the provided files, say "I don't see that in the scoped files"
4. ALWAYS cite sources using [filename] when referencing file content
5. NEVER make up or hallucinate file contents
6. Do NOT search remote servers, /home/, /var/, or any filesystem paths

---

## ARCHIVIST - File Operations Specialist

You are ARCHIVIST, analyzing files in scope: **${folderPath === '/' ? 'All Files' : folderPath}**

### Storage Overview
- **Files in Scope:** ${files.length}
- **Storage Used:** ${formatFileSize(usage.used)} / ${formatFileSize(usage.limit)}
- **Search:** ${premiumStatus}

### Files Available
| # | File | Folder | Type | Size |
|---|------|--------|------|------|
${fileList.slice(0, 30).map((f, i) => `| ${i + 1} | ${f.name} | ${f.folder} | ${f.category} | ${f.size} |`).join('\n')}
${files.length > 30 ? `\n*...and ${files.length - 30} more files*` : ''}
${searchContext}${fileContentSection}
### Your Capabilities
- **Summarize** - Extract key points from documents
- **Compare** - Find differences between files
- **Extract** - Pull structured data to JSON
- **Analyze** - Deep content analysis
- **Search** - Find information across all files in scope

### RULES
- Cite sources using [filename] when quoting content
- ONLY reference files listed above
- If asked about a file not in scope, say "I don't see that file in the current scope"
- NEVER mention server paths like /home/<user> or /root
- You access QuoxCORE Files page content ONLY (browser localStorage)`;

    } catch (err) {
        console.warn('[ArchivistView] Context build failed:', err);
        return '';
    }
}

/**
 * Message component with citation support
 */
function ChatMessage({ message, onCitationClick }) {
    const isUser = message.role === 'user';
    const content = message.text || message.content || '';
    const assistantData = resolveAssistantIdentity(message.assistant, { fallbackId: 'archivist' });

    return (
        <div className={`av-message ${isUser ? 'user' : 'assistant'} ${message.pending ? 'pending' : ''}`}>
            <div className="av-message-avatar">
                {isUser ? (
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                    </svg>
                ) : (
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                    </svg>
                )}
            </div>
            <div className="av-message-content">
                {!isUser && (
                    <div className="av-message-header">
                        <span className="av-message-sender">{assistantData.name || 'ARCHIVIST'}</span>
                        {/* Agent attribution badge */}
                        {message.assistant && (
                            <span
                                className={`message-badge message-badge--agent message-badge--agent-${message.assistant}`}
                                title={`Answered by ${(assistantData.name || message.assistant).toUpperCase()}`}
                            >
                                {(assistantData.name || message.assistant).toUpperCase()}
                            </span>
                        )}
                        {message.memoryUsed && (
                            <span className="av-message-badge" title="Memory context used">M</span>
                        )}
                        {message.routedResponse && (
                            <span className="av-message-badge fast" title="Fast response">F</span>
                        )}
                    </div>
                )}
                {message.citations?.length > 0 ? (
                    <CitationBlock
                        text={content}
                        citations={message.citations}
                        onCitationClick={onCitationClick}
                    />
                ) : isUser ? (
                    <div className="av-message-text">{content}</div>
                ) : (
                    <div className="av-message-text">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {content}
                        </ReactMarkdown>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * File preview modal
 */
function FilePreviewModal({ file, onClose }) {
    const [content, setContent] = useState(null);

    useEffect(() => {
        if (file) {
            const fileData = getFile(file.id);
            if (fileData?.data) {
                if (file.category === 'image') {
                    setContent({ type: 'image', data: fileData.data });
                } else {
                    try {
                        const base64 = fileData.data.includes(',')
                            ? fileData.data.split(',')[1]
                            : fileData.data;
                        const text = atob(base64);
                        setContent({ type: 'text', data: text });
                    } catch {
                        setContent({ type: 'error', data: 'Unable to decode file' });
                    }
                }
            } else {
                setContent({ type: 'error', data: 'File not found' });
            }
        }
    }, [file]);

    if (!file) return null;

    return (
        <div className="av-preview-overlay" onClick={onClose}>
            <div className="av-preview-modal" onClick={e => e.stopPropagation()}>
                <div className="av-preview-header">
                    <h3>{file.name}</h3>
                    <button onClick={onClose}>
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
                <div className="av-preview-body">
                    {content?.type === 'image' ? (
                        <img src={content.data} alt={file.name} />
                    ) : content?.type === 'text' ? (
                        <pre>{content.data}</pre>
                    ) : (
                        <p>{content?.data || 'Loading...'}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Main ArchivistView Component
 */
function ArchivistView() {
    const { setHalState } = useOutletContext() || { setHalState: () => {} };
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();

    // Folder scope from URL
    const folderParam = searchParams.get('folder');
    let initialFolder = '/';
    try {
        initialFolder = folderParam ? decodeURIComponent(folderParam) : '/';
        if (!initialFolder?.trim()) initialFolder = '/';
    } catch {
        initialFolder = '/';
    }

    const [currentFolder, setCurrentFolder] = useState(initialFolder);
    const [showScopeSelector, setShowScopeSelector] = useState(false);
    const [previewFile, setPreviewFile] = useState(null);

    // File data
    const [scopedFiles, setScopedFiles] = useState([]);
    const [folderTree, setFolderTree] = useState(null);
    const [storageUsage, setStorageUsage] = useState(null);

    // Refs
    const chatContainerRef = useRef(null);

    // Load folder data when scope changes
    useEffect(() => {
        try {
            setScopedFiles(listFiles({ folderPath: currentFolder, recursive: true }));
            setFolderTree(getFolderTree());
            setStorageUsage(getStorageUsage());
        } catch (err) {
            console.warn('[ArchivistView] Failed to load folder data:', err);
            setScopedFiles([]);
        }
    }, [currentFolder]);

    // Context builder for ChatEngine - scoped to current folder
    const contextBuilder = useCallback(async (query) => {
        return buildArchivistFolderContext(query, currentFolder);
    }, [currentFolder]);

    // Handle citation click
    const handleCitationClick = (citation) => {
        const file = scopedFiles.find(f => f.id === citation.id) || citation;
        setPreviewFile(file);
    };

    // Change folder scope
    const changeScope = (path) => {
        const newPath = path || '/';
        setCurrentFolder(newPath);
        setShowScopeSelector(false);
        navigate(`/archivist?folder=${encodeURIComponent(newPath)}`, { replace: true });
    };

    // Flatten folder tree
    const flattenFolders = (node, depth = 0, result = []) => {
        if (!node) return result;
        result.push({
            path: node.path || '/',
            name: node.name || 'Root',
            depth,
            fileCount: node.fileCount || 0
        });
        if (node.children) {
            node.children.forEach(child => flattenFolders(child, depth + 1, result));
        }
        return result;
    };

    const folders = folderTree
        ? flattenFolders(folderTree)
        : [{ path: '/', name: 'All Files', depth: 0, fileCount: scopedFiles.length }];

    return (
        <>
        <LLMAuthBanner />
        <ChatEngine
            agent="archivist"
            contextBuilder={contextBuilder}
            sessionPrefix="ARCHIVIST"
            onStateChange={setHalState}
            enableSmartRouter={true}
            enableMemory={true}
        >
            {({
                messages,
                isProcessing,
                halState,
                audioData,
                isMuted,
                error,
                assistantConfig,
                sendMessage,
                abortMessage,
                stopAudio,
                clearConversation,
                toggleMute
            }) => (
                <div className="archivist-view view-page">
                    {/* Main Chat Area */}
                    <div className="av-main">
                        {/* Header */}
                        <div className="av-header">
                            <div className="av-header-left">
                                <button
                                    className="av-back-btn"
                                    onClick={() => navigate('/files')}
                                    title="Back to Files"
                                >
                                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M19 12H5M12 19l-7-7 7-7"/>
                                    </svg>
                                </button>
                                <div className="av-header-title">
                                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                                    </svg>
                                    <span>ARCHIVIST</span>
                                </div>
                            </div>

                            <div className="av-header-right">
                                <button
                                    className={`av-action-btn ${isMuted ? 'muted' : ''}`}
                                    onClick={toggleMute}
                                    title={isMuted ? 'Unmute' : 'Mute'}
                                >
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        {isMuted ? (
                                            <><path d="M11 5L6 9H2v6h4l5 5V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></>
                                        ) : (
                                            <><path d="M11 5L6 9H2v6h4l5 5V5z"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></>
                                        )}
                                    </svg>
                                </button>
                                <button
                                    className="av-action-btn"
                                    onClick={clearConversation}
                                    title="Clear chat"
                                >
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                                    </svg>
                                </button>
                            </div>
                        </div>

                        {/* Scope Banner */}
                        <div className="av-scope-banner">
                            <div className="av-scope-info">
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                                </svg>
                                <div className="av-scope-text">
                                    <span className="av-scope-label">Current Scope</span>
                                    <span className="av-scope-path">
                                        {currentFolder === '/' ? 'All Files' : currentFolder}
                                    </span>
                                </div>
                                <span className="av-scope-count">
                                    {scopedFiles.length} file{scopedFiles.length !== 1 ? 's' : ''}
                                </span>
                            </div>
                            <button
                                className="av-scope-change-btn"
                                onClick={() => setShowScopeSelector(!showScopeSelector)}
                            >
                                Change Scope
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M6 9l6 6 6-6"/>
                                </svg>
                            </button>
                            {showScopeSelector && (
                                <div className="av-scope-dropdown">
                                    {folders.map(f => (
                                        <button
                                            key={f.path}
                                            className={f.path === currentFolder ? 'active' : ''}
                                            onClick={() => changeScope(f.path)}
                                            style={{ paddingLeft: `${12 + f.depth * 16}px` }}
                                        >
                                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                                            </svg>
                                            {f.path === '/' ? 'All Files' : f.name}
                                            <span className="folder-count">({f.fileCount})</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Chat Messages */}
                        <div className="av-chat" ref={chatContainerRef}>
                            {messages.length === 0 ? (
                                <div className="av-welcome">
                                    <div className="av-welcome-icon">
                                        <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                                        </svg>
                                    </div>
                                    <h2>ARCHIVIST</h2>
                                    <p>
                                        {scopedFiles.length > 0
                                            ? `I have access to ${scopedFiles.length} file${scopedFiles.length !== 1 ? 's' : ''} in ${currentFolder === '/' ? 'your storage' : currentFolder}. Ask me anything about them.`
                                            : 'Upload some files to start chatting about them.'}
                                    </p>
                                    {scopedFiles.length > 0 && (
                                        <div className="av-suggestions">
                                            {getAgentSuggestions('archivist', 3).map((suggestion, i) => (
                                                <button key={i} onClick={() => sendMessage(suggestion)}>
                                                    {suggestion}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                messages.map((msg, i) => (
                                    <ChatMessage
                                        key={i}
                                        message={msg}
                                        onCitationClick={handleCitationClick}
                                    />
                                ))
                            )}

                            {isProcessing && (
                                <div className="av-message assistant">
                                    <div className="av-message-avatar">
                                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                                        </svg>
                                    </div>
                                    <div className="av-message-content">
                                        <div className="av-typing">
                                            <span></span><span></span><span></span>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Input Area - Using shared ChatInput with voice support */}
                        <ChatInput
                            onSend={sendMessage}
                            onStop={abortMessage}
                            placeholder={scopedFiles.length > 0
                                ? 'Ask ARCHIVIST about your files...'
                                : 'Upload files to start chatting'}
                            isProcessing={isProcessing}
                            disabled={scopedFiles.length === 0}
                            enableVoice={true}
                            enableFileUpload={false}
                            className="av-chat-input"
                        />
                    </div>

                    {/* Right Sidebar */}
                    <div className="av-sidebar">
                        {/* Visualizer - Using shared VisualizerSection with voice */}
                        <VisualizerSection
                            agent="archivist"
                            state={halState}
                            audioData={audioData}
                            showStatus={true}
                            showVoice={true}
                            onVoiceTranscription={sendMessage}
                            storageKey="archivist-visualizer-collapsed"
                            className="av-visualizer-section"
                        />

                        {/* Stop button when speaking */}
                        {halState === 'speaking' && (
                            <div className="av-stop-section">
                                <button className="av-stop-btn" onClick={stopAudio}>
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <rect x="6" y="6" width="12" height="12"/>
                                    </svg>
                                    Stop Audio
                                </button>
                            </div>
                        )}

                        {/* Quick Skills */}
                        <div className="av-sidebar-section">
                            <h4>Quick Skills</h4>
                            <div className="av-skills">
                                <button
                                    onClick={() => sendMessage('Summarize the files in this folder')}
                                    disabled={scopedFiles.length === 0 || isProcessing}
                                >
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                                    </svg>
                                    Summarize
                                </button>
                                <button
                                    onClick={() => sendMessage('Analyze the key themes and topics in these files')}
                                    disabled={scopedFiles.length === 0 || isProcessing}
                                >
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                                    </svg>
                                    Analyze
                                </button>
                                <button
                                    onClick={() => sendMessage('Extract key data points from these files as JSON')}
                                    disabled={scopedFiles.length === 0 || isProcessing}
                                >
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                                    </svg>
                                    Extract
                                </button>
                            </div>
                        </div>

                        {/* Storage Info */}
                        <div className="av-sidebar-section">
                            <h4>Storage</h4>
                            {storageUsage && (
                                <div className="av-storage">
                                    <div className="av-storage-bar">
                                        <div
                                            className="av-storage-fill"
                                            style={{ width: `${Math.min(storageUsage.percent || 0, 100)}%` }}
                                        />
                                    </div>
                                    <span>
                                        {formatFileSize(storageUsage.used)} / {formatFileSize(storageUsage.limit)}
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Premium Notice */}
                        {!isPremiumFilesAvailable() && (
                            <div className="av-premium-notice">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="none"/>
                                </svg>
                                <span>Semantic search requires Advanced Memory</span>
                            </div>
                        )}
                    </div>

                    {/* File Preview Modal */}
                    {previewFile && (
                        <FilePreviewModal
                            file={previewFile}
                            onClose={() => setPreviewFile(null)}
                        />
                    )}
                </div>
            )}
        </ChatEngine>
        </>
    );
}

export default ArchivistView;

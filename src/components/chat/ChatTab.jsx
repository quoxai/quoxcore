/**
 * ChatTab - Per-tab chat conversation component
 *
 * Extracted from HomeView. Each tab manages its own:
 * - Conversation history (localStorage per tabId)
 * - sendMessage / Smart Router / tool execution
 * - AEE envelopes and AOCL layer tracking
 * - Message rendering, input area, streaming
 * - File uploads
 *
 * The parent (HomeView) manages voice I/O, BroadcastChannel, and the sidebar.
 */

import { useState, useRef, useEffect, useCallback, useImperativeHandle, forwardRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import MarkdownContent from '../ui/MarkdownContent';
import RichObjectCard from './RichObjectCard';
import { assistants } from '../../config/assistants';
import { getChief } from '../../config/chiefs';
import { MODEL_CATALOG } from '../../config/modelCatalog';
import FailoverBadge, { formatFailoverTitle } from './FailoverBadge.jsx';
import { loadUserEntities, buildRuntimeAssistantConfig, getRuntimeAssistantConfig, getAssistant } from '../../services/entityRegistry';
import { getAgentSuggestions } from '../../config/agentRegistry';
import { getMemoryManager, formatContextForPrompt } from '../../services/memoryManager';
import { generateLightContext } from '../../services/quoxContext';
import { routeQuery, canRouteQuery } from '../../services/quoxRouter';
import {
    prefixedUlid,
    createChatQuery,
    createChatResponse,
    createError,
    createLayerEvent,
    createRunEvent
} from '../../lib/aee';
import { storeEnvelopeSafe } from '../../services/aeeStatusService';
import { registerAI, unregisterAI } from '../../services/activeAIRegistry';
import { checkPolicy } from '../../services/layers';
import { enforceL8Response } from '../../services/layers/aoclEnforcer';
import { useAdvancedMode } from '../../services/uiSettings';
import { detectToolInvocation, executeAgentTool } from '../../services/agentDelegator';
import { ChatFileUpload } from '../hal/ChatFileUpload';
import { LayerStackMini, LayerStackModal } from '../layers';
import { CHAT_TAB_MESSAGES_PREFIX } from '../../config/chatConfig';
import ImageCard from './ImageCard';
import ImageLightbox from './ImageLightbox';
import { ThinkingDisplay } from './ThinkingDisplay';
import { MessageTrace } from './MessageTrace';
import { GlassChatPanel } from './glass';
import { useSettings } from '../../hooks/useSettings';
import { getEffectiveEvidenceLevel } from '../../services/decisionEvidenceService';
import { usePluginLicensed } from '../../hooks/usePluginLicensed';
import { api as notesApi } from '../notesq/lib/api';
import { chatToNote } from '../notesq/lib/chatToNote';
import { createMessageService } from '../../services/messageService';
import { useMuteState, useVoiceSettings } from '../../hooks/useVoiceSettings';
import { preprocessForTTS } from '../../services/ttsPreprocessor';
import { getAgentVoice, getAgentSynthetic, getTTSModel } from '../../services/voiceSettings';
import { attachSyntheticEffect } from '../../services/syntheticVoice';
import { formatExecutionTitle } from '../../services/llmProvenance';
import { DEFAULT_LLM_CONFIG } from '../../services/llmService';
import { buildExecutionTracePayload, resolveExecutionPlan } from '../../services/executionPlanResolver';
import { isLlmPolicyLocked } from '../../services/llmPolicy';
import { shouldSendResolvedLlmSelection } from '../../services/llmRoutingPayload';
import { getCollectorResponseStep } from '../../services/chatRequestTelemetry';
import { getCollectorUnavailableStatus, getSessionExpiredStatus, normalizeLlmStatusPayload } from '../../services/llmStatus';
import { useAoclLayerSteps } from '../../hooks/useAoclLayerSteps';
import PromptPicker from '../prompts/PromptPicker';
import { listPrompts } from '../../services/promptsClient';
import PromoteConversationCTA from './PromoteConversationCTA';
import { analyseFromHistory } from '../../services/conversationPromote';

const API_BASE = '/webhook';

// Markdown renderer — uses shared MarkdownContent component
const ChatMd = ({ children }) => <MarkdownContent>{children}</MarkdownContent>;

/** Format token count for display (1234 -> "1.2k") */
function formatTokenCount(count) {
    if (!count || count === 0) return '0';
    if (count < 1000) return count.toString();
    if (count < 10000) return (count / 1000).toFixed(1) + 'k';
    return Math.round(count / 1000) + 'k';
}

/** Format tool execution result for chat display */
function formatToolResultForChat(toolId, result) {
    if (!result.success) return `Tool execution failed: ${result.error || 'Unknown error'}`;
    const data = result.data;
    switch (toolId) {
        case 'org_stats':
            return `**Organization Statistics:**\n- Users: ${data.users}\n- Teams: ${data.teams}\n- Conversations: ${data.conversations}`;
        case 'health_probe': {
            const healthResults = (data.results || [])
                .map(r => `- ${r.url}: ${r.ok ? 'OK' : 'FAILED'} (${r.latency}ms)`)
                .join('\n');
            return `**Health Check:**\n${healthResults}\n\nHealthy: ${data.healthy}/${data.total}`;
        }
        default:
            return `Tool ${toolId} result: ${JSON.stringify(data, null, 2)}`;
    }
}

/** Storage key helpers */
function messagesKey(tabId) { return `${CHAT_TAB_MESSAGES_PREFIX}${tabId}-messages`; }
function reactionsKey(tabId) { return `${CHAT_TAB_MESSAGES_PREFIX}${tabId}-reactions`; }

function loadTabMessages(tabId) {
    try {
        const raw = localStorage.getItem(messagesKey(tabId));
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
}

function saveTabMessages(tabId, messages) {
    try {
        localStorage.setItem(messagesKey(tabId), JSON.stringify(messages));
    } catch { /* quota exceeded */ }
}

function formatExecutionBadge(execution) {
    if (!execution?.provider || !execution?.model) return null;
    const providerConfig = MODEL_CATALOG[execution.provider];
    const providerName = providerConfig?.name || execution.provider;
    const modelName = providerConfig?.models?.find(mod => mod.id === execution.model)?.name || execution.model;
    return `${providerName} · ${modelName}`;
}

// LLM-FAILOVER: resolveProviderModelLabel / formatFailoverBadge /
// formatFailoverTitle moved to ./FailoverBadge.jsx (imported above) so the
// ChatEngine surfaces render the same badge instead of showing nothing.

function getAssistantDisplayName(assistantId, fallbackName = null) {
    if (!assistantId) return fallbackName || 'QuoxCORE';
    const assistant = getAssistant(assistantId);
    const runtime = assistant ? buildRuntimeAssistantConfig(assistant) : null;
    return runtime?.name || assistants[assistantId]?.name || fallbackName || assistantId;
}

/**
 * ChatTab component
 *
 * Exposes `sendMessage` via ref for voice I/O integration from parent.
 */
const ChatTab = forwardRef(function ChatTab({
    tabId,
    assistantId,
    initialMessages = null,
    initialCorrelationId = null,
    isActive,
    onTabUpdate,
    onHalStateChange,
    authFetch,
    orgId,
    user,
    currentOrg,
    isAuthenticated,
    llmProvider,
    llmModel,
    credentialId,
    executionPlan: executionPlanProp = null,
    routingPolicy,
    llmStatus,
    additionalContext = null,
}, ref) {
    const advancedMode = useAdvancedMode();
    const navigate = useNavigate();

    // Mounted guard — prevents state updates after unmount (e.g. when switching browser tabs
    // during a long-running API call). Without this, React throws when sendMessage's async
    // continuation tries to setState on an unmounted component.
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // Resolve assistant config (core, plugin/chief, or scope)
    const isCoreAssistant = !!assistants[assistantId];
    const coreAssistantData = isCoreAssistant ? getRuntimeAssistantConfig(assistantId) : null;

    // Check if this is a plugin agent from the chiefs registry (agentic team packs)
    const chiefId = assistantId.startsWith('chief-') ? assistantId.slice(6) : null;
    const chiefData = chiefId ? getChief(chiefId) : null;
    const isPluginAssistant = !!chiefData;

    const [scopeAssistantData, setScopeAssistantData] = useState(null);

    // Build assistant data: core > plugin (chief) > scope > fallback to CommanderQ
    const currentAssistantData = isCoreAssistant
        ? (coreAssistantData || assistants.quox)
        : isPluginAssistant
        ? {
            name: chiefData.name,
            shortName: chiefData.shortName || chiefData.name.charAt(0),
            systemPrompt: chiefData.systemPrompt || '',
            specialty: chiefData.specialty || chiefData.description,
            voice: null,
            color: { primary: chiefData.color || '#1e293b' },
            role: chiefData.role || 'specialist',
            level: chiefData.level ?? 1,
            llm: chiefData.llm,
            llmPolicy: chiefData.llmPolicy,
        }
        : (scopeAssistantData || assistants.quox);
    const voiceMode = currentAssistantData.voice || 'jarvis';
    const chatUnavailable = llmStatus?.ready === false;
    const chatUnavailableMessage = llmStatus?.recommendation || 'Chat service unavailable. Ensure the collector service is running before starting chat.';
    const executionPlan = executionPlanProp || resolveExecutionPlan({
        userSelection: {
            provider: llmProvider,
            model: llmModel,
            credentialId,
        },
        assistantRecommendation: currentAssistantData?.llm,
        specialistLock: isLlmPolicyLocked(currentAssistantData?.llmPolicy) ? currentAssistantData?.llm : null,
        systemDefault: DEFAULT_LLM_CONFIG,
    });
    const sendResolvedSelection = shouldSendResolvedLlmSelection(executionPlan);

    // Load scope/user assistant persona (skip if core or plugin)
    useEffect(() => {
        if (isCoreAssistant || isPluginAssistant || !orgId || !authFetch) {
            setScopeAssistantData(null);
            return;
        }
        let cancelled = false;
        loadUserEntities(orgId, authFetch).then(entities => {
            if (cancelled) return;
            const entity = entities.find(e => e.id === assistantId);
            if (entity) {
                setScopeAssistantData(buildRuntimeAssistantConfig(entity));
            }
        });
        return () => { cancelled = true; };
    }, [assistantId, isCoreAssistant, isPluginAssistant, orgId, authFetch]);

    // Per-tab state
    const [conversationHistory, setConversationHistory] = useState(() => {
        if (initialMessages) return initialMessages;
        return loadTabMessages(tabId);
    });
    const [sessionId, setSessionId] = useState(null);
    // AQ-9D P4: answers saved to NotesQ this session (key -> note id) for the Open note link.
    const notesLicensed = usePluginLicensed('notesq');
    const [savedNoteIds, setSavedNoteIds] = useState({});
    const [currentCorr, setCurrentCorr] = useState(initialCorrelationId);
    const [inputText, setInputText] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);

    // Register/unregister in the global AI activity registry
    useEffect(() => {
        const registryId = `chattab-${tabId}`;
        if (isProcessing) {
            registerAI(registryId, {
                type: 'chat',
                agent: assistantId,
                label: `Chat with ${assistantId}`,
            });
        } else {
            unregisterAI(registryId);
        }
        return () => unregisterAI(registryId);
    }, [isProcessing, tabId, assistantId]);

    const [halState, setHalState] = useState('idle');
    const [currentText, setCurrentText] = useState('');
    const [thinkingTime, setThinkingTime] = useState(0);
    const [error, setError] = useState(null);
    const [pendingFileUploads, setPendingFileUploads] = useState([]);
    const [messageQueue, setMessageQueue] = useState([]);
    const [showLayerModal, setShowLayerModal] = useState(false);
    const [lightbox, setLightbox] = useState(null); // { images, index }
    const [thinkingSteps, setThinkingSteps] = useState([]);
    // AOCL-DISPATCH-B2: subscribe to server-emitted aocl.layer.* envelopes
    // for the current correlation. Replaces the old client-side emitStep()
    // speculation (POLICY/ROUTER/MEMORY/VERIFY) with real layer events.
    const aoclLayerSteps = useAoclLayerSteps(currentCorr, isProcessing);
    const [actionToast, setActionToast] = useState(null);
    const actionToastTimer = useRef(null);
    const { getSetting, updateSetting } = useSettings();

    // Slash-menu / PromptPicker state
    const [slashPrompts, setSlashPrompts] = useState([]);
    const [showPromptPicker, setShowPromptPicker] = useState(false);
    const [slashQuery, setSlashQuery] = useState('');
    const showThinking = getSetting('showThinking', true);
    const useGlassChat = getSetting('useGlassChat', false);

    const showToast = useCallback((message) => {
        if (actionToastTimer.current) clearTimeout(actionToastTimer.current);
        setActionToast(message);
        actionToastTimer.current = setTimeout(() => setActionToast(null), 2000);
    }, []);

    const recheckChatAvailability = useCallback(async () => {
        try {
            const response = await fetch('/collector/chat/status', {
                signal: AbortSignal.timeout(5000),
            });
            if (response.status === 401 || response.status === 403) {
                // Stale session, not a dead collector — don't mislabel it.
                return getSessionExpiredStatus(`HTTP ${response.status}`);
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return normalizeLlmStatusPayload(await response.json());
        } catch (err) {
            return getCollectorUnavailableStatus(err.message);
        }
    }, []);

    const copyConversation = useCallback(() => {
        if (conversationHistory.length === 0) return;
        const lines = conversationHistory.map(msg => {
            const sender = msg.role === 'user' ? 'You' : getAssistantDisplayName(msg.assistant, currentAssistantData.name || 'CommanderQ');
            return `**${sender}:**\n${msg.text}`;
        });
        const text = lines.join('\n\n---\n\n');
        navigator.clipboard.writeText(text);
        showToast(`Conversation copied (${conversationHistory.length} messages)`);
    }, [conversationHistory, currentAssistantData, showToast]);

    // Voice TTS — only speaks when enabled AND not muted
    const { settings: voiceSettings } = useVoiceSettings();
    const voiceEnabled = voiceSettings.enabled;
    const { muted: isMuted } = useMuteState();
    const currentAudioRef = useRef(null);
    const currentAudioUrlRef = useRef(null);

    const speakText = useCallback(async (text) => {
        if (!text || !voiceEnabled || isMuted) return;
        try {
            const processed = preprocessForTTS(text);
            if (!processed) return;

            setHalState('speaking');

            // Resolve per-agent voice and model from voice settings
            const agentVoice = getAgentVoice(assistantId || 'quox');
            const ttsModel = getTTSModel();
            const response = await fetch(`${API_BASE}/speak`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: processed,
                    voice_id: agentVoice.voiceId,
                    model_id: ttsModel.id,
                    voice_mode: voiceMode, // legacy fallback
                })
            });

            if (!response.ok) {
                console.warn('[ChatTab TTS] Speak failed:', response.status);
                // Surface TTS errors to the user
                let errorMsg = 'Voice unavailable';
                try {
                    const errData = await response.json();
                    const detail = errData.details || errData.error || '';
                    if (detail.includes('quota_exceeded') || detail.includes('credits')) {
                        errorMsg = 'ElevenLabs credits exhausted — voice paused';
                    } else if (response.status === 401 || response.status === 403) {
                        errorMsg = 'ElevenLabs API key invalid';
                    } else if (response.status === 503) {
                        errorMsg = 'Voice API key not configured';
                    } else if (detail) {
                        errorMsg = `Voice error: ${detail.substring(0, 80)}`;
                    }
                } catch { /* response wasn't JSON */ }
                showToast(errorMsg);
                setHalState('idle');
                return;
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            // Clean up previous audio
            if (currentAudioRef.current) {
                currentAudioRef.current.pause();
                currentAudioRef.current = null;
            }
            if (currentAudioUrlRef.current) {
                URL.revokeObjectURL(currentAudioUrlRef.current);
            }

            const audio = new Audio(audioUrl);
            currentAudioRef.current = audio;
            currentAudioUrlRef.current = audioUrl;
            // VOICE-P1: Synthetic effect (falls back to dry playback if Web Audio
            // is unavailable or the context will not start).
            const detachEffect = getAgentSynthetic(assistantId || 'quox')
                ? await attachSyntheticEffect(audio)
                : () => {};

            audio.onended = () => {
                detachEffect();
                URL.revokeObjectURL(audioUrl);
                currentAudioRef.current = null;
                currentAudioUrlRef.current = null;
                if (mountedRef.current) setHalState('idle');
            };
            audio.onerror = () => {
                detachEffect();
                URL.revokeObjectURL(audioUrl);
                currentAudioRef.current = null;
                currentAudioUrlRef.current = null;
                if (mountedRef.current) setHalState('idle');
            };
            audio.play().catch(() => {
                // Autoplay blocked — silently fall back
                if (mountedRef.current) setHalState('idle');
            });
        } catch (err) {
            console.warn('[ChatTab TTS] Error:', err.message);
            showToast('Voice error — check console');
            if (mountedRef.current) setHalState('idle');
        }
    }, [voiceEnabled, isMuted, voiceMode, assistantId, showToast]);

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            if (currentAudioRef.current) {
                currentAudioRef.current.pause();
                currentAudioRef.current = null;
            }
            if (currentAudioUrlRef.current) {
                URL.revokeObjectURL(currentAudioUrlRef.current);
                currentAudioUrlRef.current = null;
            }
        };
    }, []);

    // Reactions
    const [messageReactions, setMessageReactions] = useState(() => {
        try {
            const raw = localStorage.getItem(reactionsKey(tabId));
            if (raw) return JSON.parse(raw);
        } catch { /* ignore */ }
        return {};
    });

    // Refs
    const lastQueryEnvelopeRef = useRef(null);
    const messageQueueRef = useRef([]);
    const chatContainerRef = useRef(null);
    const textareaRef = useRef(null);

    // Server-side message persistence (best-effort, non-blocking)
    const dbConversationIdRef = useRef(null);
    const messageService = useMemo(() => {
        if (authFetch && orgId) {
            try { return createMessageService(authFetch, orgId); }
            catch { return null; }
        }
        return null;
    }, [authFetch, orgId]);

    const persistMessageToServer = useCallback(async (msg) => {
        if (!messageService) return;
        try {
            // Create conversation on first message
            if (!dbConversationIdRef.current) {
                const result = await messageService.createConversation({
                    agent_id: assistantId || 'quox',
                    scope_type: 'chat_tab',
                    scope_id: tabId,
                    correlation_id: currentCorr || undefined,
                });
                dbConversationIdRef.current = result.conversation?.id;
            }
            if (!dbConversationIdRef.current) return;

            await messageService.addMessage(dbConversationIdRef.current, {
                role: msg.role || 'user',
                content: msg.text || '',
                sender_type: msg.role === 'user' ? 'human' : 'agent',
                sender_id: msg.role === 'user' ? undefined : (msg.assistant || assistantId),
                sender_name: msg.role === 'user' ? undefined : (currentAssistantData?.name || assistantId),
                aee_envelope_id: msg.envelopeId || undefined,
                correlation_id: currentCorr || undefined,
                model: msg.model || undefined,
                tokens_in: msg.tokens?.in || undefined,
                tokens_out: msg.tokens?.out || undefined,
            });
        } catch (err) {
            // Best-effort — don't break chat UX
            console.warn('[ChatTab] Server persist failed:', err.message);
        }
    }, [messageService, assistantId, tabId, currentCorr, currentAssistantData?.name]);

    // Persist conversation to localStorage + server
    const prevHistoryLenRef = useRef(0);
    useEffect(() => {
        if (conversationHistory.length > 0) {
            saveTabMessages(tabId, conversationHistory);

            // Persist new messages to server (skip pending messages)
            const newCount = conversationHistory.length - prevHistoryLenRef.current;
            if (newCount > 0) {
                const newMessages = conversationHistory.slice(-newCount);
                for (const msg of newMessages) {
                    if (!msg.pending) {
                        persistMessageToServer(msg);
                    }
                }
            }
        }
        prevHistoryLenRef.current = conversationHistory.length;
    }, [tabId, conversationHistory, persistMessageToServer]);

    // Persist reactions
    useEffect(() => {
        if (Object.keys(messageReactions).length > 0) {
            try { localStorage.setItem(reactionsKey(tabId), JSON.stringify(messageReactions)); } catch { /* */ }
        }
    }, [tabId, messageReactions]);

    // Notify parent of halState changes
    useEffect(() => {
        if (isActive) onHalStateChange?.(halState);
    }, [halState, isActive, onHalStateChange]);

    // Thinking timer
    useEffect(() => {
        let interval;
        if (halState === 'thinking') {
            setThinkingTime(0);
            interval = setInterval(() => setThinkingTime(t => t + 1), 1000);
        }
        return () => clearInterval(interval);
    }, [halState]);

    // Auto-scroll
    useEffect(() => {
        if (chatContainerRef.current && isActive) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [conversationHistory, currentText, isActive]);

    // Auto-resize textarea
    const adjustTextareaHeight = useCallback(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
        }
    }, []);

    useEffect(() => { adjustTextareaHeight(); }, [inputText, adjustTextareaHeight]);

    // Load slash-eligible prompts on mount (when authFetch is available)
    useEffect(() => {
        if (!authFetch) return;
        listPrompts({ authFetch })
            .then(all => setSlashPrompts(all.filter(p => (p.deploy_targets || []).includes('slash'))))
            .catch(() => {}); // non-fatal
    }, [authFetch]);

    // Handle quox:prompt-insert events from PromptsLibraryView "Send to chat" button
    useEffect(() => {
        if (!isActive) return;
        const handler = (e) => {
            const { body } = e.detail || {};
            if (body) {
                setInputText(body);
                setTimeout(() => textareaRef.current?.focus(), 0);
            }
        };
        document.addEventListener('quox:prompt-insert', handler);
        return () => document.removeEventListener('quox:prompt-insert', handler);
    }, [isActive]);

    // Keyboard: Enter to send
    useEffect(() => {
        if (!isActive) return;
        const handleKeyDown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey && document.activeElement === textareaRef.current) {
                const liveValue = textareaRef.current?.value || '';
                if (!liveValue.trim()) return;
                e.preventDefault();
                textareaRef.current?.form?.requestSubmit();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isActive]);

    // Process queue
    const processNextInQueue = useCallback(() => {
        if (messageQueueRef.current.length > 0 && !isProcessing) {
            const next = messageQueueRef.current.shift();
            setMessageQueue([...messageQueueRef.current]);
            sendMessage(next, { bypassRouter: false });
        }
    }, [isProcessing]);

    // Smart Router
    const trySmartRouter = async (text, corr) => {
        if (conversationHistory.length >= 2) return { handled: false };
        if (canRouteQuery(text)) {
            try {
                const result = await routeQuery(text, {
                    currentAssistant: assistantId,
                    sessionId,
                    voiceMode,
                    corr,
                });
                if (result.handled) {
                    return { handled: true, response: result.response, pattern: result.pattern };
                }
            } catch (err) {
                console.warn('[SmartRouter] Error:', err);
            }
        }
        return { handled: false };
    };

    // Thinking step emitter — fires at real pipeline stages
    const stepIdRef = useRef(0);
    const abortControllerRef = useRef(null);
    const emitStep = useCallback((agent, message, stage) => {
        if (!showThinking) return;
        const id = `step_${++stepIdRef.current}`;
        setThinkingSteps(prev => [...prev, { id, agent, message, stage, elapsed: null, ts: Date.now() }]);
    }, [showThinking]);

    // Main send message function
    const sendMessage = async (text, options = {}) => {
        if (!text.trim()) return;

        if (chatUnavailable) {
            const liveStatus = await recheckChatAvailability();
            if (liveStatus?.ready !== true) {
                const liveMessage = liveStatus?.recommendation || chatUnavailableMessage;
                setError(liveMessage);
                setCurrentText(liveMessage);
                setHalState('error');
                setTimeout(() => { if (mountedRef.current) setHalState('idle'); }, 3000);
                return;
            }
        }

        // Queue if busy
        if (isProcessing) {
            messageQueueRef.current.push(text);
            setMessageQueue([...messageQueueRef.current]);
            setConversationHistory(prev => [...prev.slice(-14), { role: 'user', text, pending: true }]);
            return;
        }

        setIsProcessing(true);
        setHalState('thinking');
        setCurrentText(`Processing: "${text}"`);
        setThinkingSteps([]);
        stepIdRef.current = 0;
        // AOCL-DISPATCH-B4: waterfall is now purely server-driven. Removed the
        // client-side emitStep('QuoxCORE', 'Received query') — L0 INGRESS
        // serves the same purpose and comes from the real runPipeline.

        // AEE correlation — AOCL-DISPATCH-B7: revert B5's per-turn corr.
        // Per-turn corr broke Activity Log grouping (each turn appeared as
        // a separate "conversation", so Continue Conversation only
        // resumed one exchange instead of the whole chat). Back to one
        // corr per conversation; per-message trace now scopes by turn
        // TIMESTAMP WINDOW (turnStart/turnEnd stored on each message).
        let convCorr = currentCorr;
        if (!convCorr) {
            convCorr = prefixedUlid('CONV');
            setCurrentCorr(convCorr);
        }
        const turnStart = new Date().toISOString();

        // AEE query envelope
        const queryEnvelope = createChatQuery(text, {
            corr: convCorr,
            user: 'human.user',
            agent: `agent.${assistantId}`,
        });
        lastQueryEnvelopeRef.current = queryEnvelope;
        storeEnvelopeSafe(queryEnvelope, 'AEE query envelope');

        setConversationHistory(prev => [...prev.slice(-14), { role: 'user', text, envelopeId: queryEnvelope.id }]);

        // AOCL: Run start + L0
        const runStartTime = Date.now();
        storeEnvelopeSafe(createRunEvent('start', {
            query: text,
            agent: assistantId,
            ...buildExecutionTracePayload(executionPlan)
        }, convCorr), 'AOCL Run start');
        storeEnvelopeSafe(createLayerEvent('L0', 'start', {
            rawQuery: text,
            agent: assistantId,
            ...buildExecutionTracePayload(executionPlan)
        }, convCorr), 'AOCL L0 start');
        storeEnvelopeSafe(createLayerEvent('L0', 'complete', {
            normalizedQuery: text.trim(),
            queryLength: text.length,
            ...buildExecutionTracePayload(executionPlan)
        }, convCorr), 'AOCL L0 complete');

        // L3 Policy Gate — no client-side emitStep; the server emits the real
        // aocl.layer.L3.complete envelope which useAoclLayerSteps picks up.
        const policyResult = await checkPolicy(text, { agent: assistantId, corr: convCorr });
        if (!policyResult.allowed) {
            const rejectMsg = policyResult.reason || 'Request blocked by policy';
            // SEC-FIX-3: distinguish require_approval from outright deny.
            const isApprovalGate = policyResult.requiresApproval === true;
            const uiPrefix = isApprovalGate ? 'Approval required' : 'Policy check failed';
            const uiText = `${uiPrefix}: ${rejectMsg}${isApprovalGate && policyResult.policyName ? ` (policy: ${policyResult.policyName})` : ''}`;
            setCurrentText(rejectMsg);
            setConversationHistory(prev => [...prev.slice(-14), {
                role: 'assistant',
                text: uiText,
                assistant: assistantId,
                corr: convCorr,
                turnStart, turnEnd: new Date().toISOString(),
                policyRejected: true,
                requiresApproval: isApprovalGate,
                policyId: policyResult.policyId,
                policyName: policyResult.policyName,
            }]);
            storeEnvelopeSafe(createRunEvent('complete', {
                success: false,
                rejectedBy: isApprovalGate ? 'policy:approval_required' : 'policy',
                reason: rejectMsg,
                policyId: policyResult.policyId,
                totalDuration_ms: Date.now() - runStartTime,
            }, convCorr), 'AOCL Run complete (policy reject)');
            setHalState('idle');
            setIsProcessing(false);
            processNextInQueue();
            return;
        }

        const startTime = Date.now();

        // Smart Router — server emits aocl.layer.L2.complete; client-side
        // step suppressed so the visualiser shows real execution.
        const routerResult = options.bypassRouter ? { handled: false } : await trySmartRouter(text, convCorr);
        if (routerResult.handled) {
            storeEnvelopeSafe(createLayerEvent('L9', 'start', { agent: assistantId, source: 'smart-router' }, convCorr), 'AOCL L9 start (router)');
            setCurrentText(routerResult.response);
            setConversationHistory(prev => [...prev.slice(-14), {
                role: 'assistant', text: routerResult.response, assistant: assistantId,
                corr: convCorr,
                turnStart, turnEnd: new Date().toISOString(),
                routedResponse: true, routerPattern: routerResult.pattern, originalQuery: text
            }]);
            if (lastQueryEnvelopeRef.current) {
                const routerEnv = createChatResponse(lastQueryEnvelopeRef.current, routerResult.response, { source: 'smart-router', pattern: routerResult.pattern, duration: Date.now() - startTime });
                storeEnvelopeSafe(routerEnv, 'AEE response envelope (router)');
            }
            storeEnvelopeSafe(createLayerEvent('L9', 'complete', { responseLength: routerResult.response?.length || 0, source: 'smart-router', pattern: routerResult.pattern }, convCorr), 'AOCL L9 complete (router)');
            storeEnvelopeSafe(createRunEvent('complete', { success: true, handledBy: 'smart-router', pattern: routerResult.pattern, totalDuration_ms: Date.now() - runStartTime }, convCorr), 'AOCL Run complete (router)');
            setHalState('idle');
            setIsProcessing(false);
            onTabUpdate?.(tabId, { lastMessageAt: new Date().toISOString(), correlationId: convCorr });
            processNextInQueue();
            return;
        }

        // Agent tool execution
        if (isAuthenticated && currentOrg?.id) {
            const toolDetection = detectToolInvocation(text);
            if (toolDetection.shouldExecute) {
                storeEnvelopeSafe(createLayerEvent('L7', 'start', { target: 'agent-tool', agent: toolDetection.agentId, tool: toolDetection.toolId }, convCorr), 'AOCL L7 start (tool)');
                try {
                    const toolResult = await executeAgentTool(toolDetection.toolId, toolDetection.params, toolDetection.agentId, { orgId: currentOrg.id, authFetch });
                    const agentName = (toolDetection.agentId || 'tool').toUpperCase();
                    const responseText = toolResult.success
                        ? `[${agentName}] ${formatToolResultForChat(toolDetection.toolId, toolResult)}`
                        : `[${agentName}] Tool execution failed: ${toolResult.error || 'Unknown error'}`;
                    setCurrentText(responseText);

                    // Build richContent for interactive cards on specific tool results
                    let richContent = null;
                    if (toolDetection.toolId === 'orchestrate_objective' && toolResult.success) {
                        richContent = {
                            type: toolResult.status === 'running' ? 'objective_progress'
                                : toolResult.status === 'decomposed' ? 'objective_plan'
                                : toolResult.status === 'completed' ? 'objective_complete'
                                : 'objective_created',
                            objectiveId: toolResult.objective_id,
                            title: toolResult.title,
                            status: toolResult.status,
                            taskCount: toolResult.task_count,
                            completedTasks: toolResult.completed_tasks || 0,
                            teamId: toolResult.team_id,
                            links: toolResult.links,
                            advisory: toolResult.advisory,
                            tasks: toolResult.tasks || [],
                        };
                    } else if (toolDetection.toolId === 'save_as_workflow' && toolResult.success) {
                        richContent = {
                            type: 'workflow_saved',
                            templateId: toolResult.template_id,
                            title: toolResult.name || toolDetection.params?.name,
                            scheduled: toolResult.scheduled,
                            cronHuman: toolResult.cron_human,
                            links: toolResult.links,
                        };
                    }

                    setConversationHistory(prev => [...prev.slice(-14), { role: 'assistant', text: responseText, assistant: toolDetection.agentId || assistantId, corr: convCorr, turnStart, turnEnd: new Date().toISOString(), toolExecuted: true, toolId: toolDetection.toolId, richContent }]);
                    storeEnvelopeSafe(createLayerEvent('L7', 'complete', { target: 'agent-tool', tool: toolDetection.toolId, success: toolResult.success }, convCorr), 'AOCL L7 complete (tool)');
                    storeEnvelopeSafe(createRunEvent('complete', { success: toolResult.success, handledBy: 'agent-tool', tool: toolDetection.toolId, agent: toolDetection.agentId, totalDuration_ms: Date.now() - runStartTime }, convCorr), 'AOCL Run complete (tool)');
                    setHalState('idle');
                    setIsProcessing(false);
                    onTabUpdate?.(tabId, { lastMessageAt: new Date().toISOString(), correlationId: convCorr });
                    processNextInQueue();
                    return;
                } catch (toolErr) {
                    console.error('[Tool] Execution error:', toolErr);
                }
            }
        }

        // L5 Context Retrieval — server emits aocl.layer.L5.complete via the
        // runPipeline L5 runner; client-side emitStep removed.
        const contextStartTime = Date.now();
        storeEnvelopeSafe(createLayerEvent('L5', 'start', { query: text }, convCorr), 'AOCL L5 start');

        const memoryManager = getMemoryManager();
        const relevantMemory = await memoryManager.getContext(text, { agent: assistantId });
        const formattedMemory = formatContextForPrompt(relevantMemory);
        const memoryUsed = relevantMemory?.learned?.preferences?.length > 0 || relevantMemory?.hybridResults?.length > 0;
        const memoryItemCount = (relevantMemory?.learned?.preferences?.length || 0) + (relevantMemory?.hybridResults?.length || 0);

        // MEM-INJECT Phase 3: the collector now injects self-knowledge
        // server-side UNCONDITIONALLY (see services/collector/lib/
        // quoxSelfKnowledgeImplant.js), so the client no longer needs to
        // guess via isQuoxQuery(text) whether to assemble the heavier
        // "rich" context. Always send the lean, always-on light context —
        // the server merges it, and an empty value here is backward
        // compatible with clients that send nothing.
        let quoxContext = '';
        try {
            quoxContext = await generateLightContext();
        } catch { /* */ }

        const assistantSystemPrompt = currentAssistantData.systemPrompt || '';

        storeEnvelopeSafe(createLayerEvent('L5', 'complete', { memoryUsed, memoryItemCount, hasQuoxContext: !!quoxContext, duration_ms: Date.now() - contextStartTime }, convCorr), 'AOCL L5 complete');

        // MEMORY detail (client-side — the server doesn't know the item
        // count at envelope emission time, so this extra row is still useful).

        // L7 Delegate + L6 Shape
        const delegateStartTime = Date.now();
        storeEnvelopeSafe(createLayerEvent('L7', 'start', {
            agent: assistantId,
            promptLength: text.length,
            ...buildExecutionTracePayload(executionPlan)
        }, convCorr), 'AOCL L7 start');
        storeEnvelopeSafe(createLayerEvent('L6', 'start', { agent: assistantId, hasAssistantPrompt: !!assistantSystemPrompt, hasQuoxContext: !!quoxContext }, convCorr), 'AOCL L6 start');

        const fullSystemPrompt = [assistantSystemPrompt, quoxContext, additionalContext].filter(Boolean).join('\n\n');
        storeEnvelopeSafe(createLayerEvent('L6', 'complete', { systemPromptLength: fullSystemPrompt.length, hasSystemPrompt: !!fullSystemPrompt, contextInjected: true }, convCorr), 'AOCL L6 complete');

        // AOCL-DISPATCH-B4: removed client-side emitStep for "Calling model" —
        // L7 DELEGATE envelope comes from the server with real model + duration.
        let abortController = null;
        try {
            abortController = new AbortController();
            abortControllerRef.current = abortController;
            const timeoutId = setTimeout(() => abortController.abort('timeout'), 200000);

            const response = await fetch('/collector/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: abortController.signal,
                body: JSON.stringify({
                    prompt: text,
                    // AOCL-DISPATCH-B3: send the client corr as session_id so the
                    // server's aoclCtx.corr matches what the frontend polls via
                    // /aee/conversation/:corr. Previously sent `sessionId` which
                    // was null on the first turn → server generated its own
                    // SESSION_xxx, corrs diverged, waterfall polled the wrong id.
                    session_id: sessionId || convCorr,
                    voice_mode: voiceMode,
                    selected_agent: assistantId,
                    quox_context: quoxContext,
                    memory_context: formattedMemory,
                    conversation_history: conversationHistory.length > 0
                        ? conversationHistory.slice(-10).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: (m.text || m.content || '').slice(0, 800) }))
                        : undefined,
                    system_prompt: fullSystemPrompt || undefined,
                    org_id: currentOrg?.id || undefined,
                    user_id: user?.id || undefined,
                    provider: sendResolvedSelection ? (executionPlan.provider || undefined) : undefined,
                    model: sendResolvedSelection ? (executionPlan.model || undefined) : undefined,
                    credential_id: credentialId || undefined,
                    decision_evidence_level: await getEffectiveEvidenceLevel(assistantId) || undefined,
                })
            });

            clearTimeout(timeoutId);
            abortControllerRef.current = null;

            // If cancelled between fetch completing and processing, bail out
            if (abortController.signal.aborted) throw new DOMException('User cancelled', 'AbortError');

            let data;
            if (!response.ok) {
                const contentType = response.headers.get('content-type') || '';
                data = !contentType.includes('application/json')
                    ? { success: false, error: `Server error (${response.status}). The request may have timed out.`, result: null }
                    : await response.json();
            } else {
                data = await response.json();
            }

            // Guard: if component unmounted during the fetch, bail out.
            // This prevents "setState on unmounted component" crashes when the user
            // switches browser tabs or closes a chat tab during a long API call.
            if (!mountedRef.current) return;

            // LLM-FAILOVER P1: on total failure the error body carries the
            // failover attempt chain. Surface the last error class and any
            // cooldown window in the existing error banner.
            if (!response.ok) {
                const failedOver = data?.execution?.failover || data?.failover;
                const attempted = failedOver?.attempted;
                if (Array.isArray(attempted) && attempted.length > 0) {
                    const last = attempted[attempted.length - 1];
                    const reason = String(last?.error_class || last?.reason || 'provider error').replace(/_/g, ' ');
                    let banner = `All providers failed: ${reason}`;
                    const cooldown = attempted.map(a => a?.cooldown_until).filter(Boolean).sort().pop();
                    if (cooldown) {
                        const cooldownDate = new Date(cooldown);
                        if (!Number.isNaN(cooldownDate.getTime())) {
                            banner += `, retries after ${cooldownDate.toISOString().slice(11, 16)} UTC`;
                        }
                    }
                    setError(banner);
                }
            }

            if (data.session_id) {
                setSessionId(data.session_id);
                onTabUpdate?.(tabId, { sessionId: data.session_id });
            }

            storeEnvelopeSafe(createLayerEvent('L7', 'complete', {
                success: !!data.result,
                hasError: !!data.error,
                duration_ms: Date.now() - delegateStartTime,
                cost_usd: data.cost_usd || 0,
                ...buildExecutionTracePayload(executionPlan, {
                    provider: data.execution?.provider || data.provider || executionPlan.provider || null,
                    model: data.execution?.model || data.model || executionPlan.model || null,
                    source: data.execution?.source || executionPlan.source,
                    credentialId: data.execution?.credential_id ?? null,
                    credentialLabel: data.execution?.credential_label || null,
                    credentialProvider: data.execution?.credential_provider || null,
                    target: data.execution?.provider || data.provider || executionPlan.provider || 'llm'
                })
            }, convCorr), 'AOCL L7 complete');

            // AOCL-DISPATCH-B4: L7 server envelope carries response metadata;
            // no client-side telemetry step.

            const responseExecution = {
                ...buildExecutionTracePayload(executionPlan, {
                    provider: data.execution?.provider || data.provider || executionPlan.provider || null,
                    model: data.execution?.model || data.model || executionPlan.model || null,
                    source: data.execution?.source || executionPlan.source,
                    credentialId: data.execution?.credential_id ?? null,
                    credentialLabel: data.execution?.credential_label || null,
                    credentialProvider: data.execution?.credential_provider || null,
                    target: data.execution?.provider || data.provider || executionPlan.provider || 'llm'
                }),
                ...(data.execution || {}),
            };

            // L8 Verify + Enforce — server emits aocl.layer.L8.complete; no
            // client-side emitStep.
            const l8Result = await enforceL8Response(data.result || data.error, { query: text, agent: assistantId, corr: convCorr, hasRAG: memoryUsed });

            // Guard again after the second async boundary
            if (!mountedRef.current) return;

            // L9 Assemble
            const assembleStartTime = Date.now();
            storeEnvelopeSafe(createLayerEvent('L9', 'start', { agent: assistantId }, convCorr), 'AOCL L9 start');

            let responseText = l8Result.valid
                ? ((data.result != null && data.result !== '') ? data.result
                    : (data.error != null && data.error !== '') ? data.error
                    : 'No response received.')
                : l8Result.response;
            if (l8Result.valid && !data.success && data.hint) {
                responseText += `\n\n> **Hint:** ${data.hint}`;
            }
            setCurrentText(responseText);

            const responseEnvelope = lastQueryEnvelopeRef.current
                ? createChatResponse(lastQueryEnvelopeRef.current, responseText, { memoryUsed, duration: Date.now() - startTime, cost: data.cost_usd || 0 })
                : null;
            if (responseEnvelope) storeEnvelopeSafe(responseEnvelope, 'AEE response envelope');

            const tokensIn = data.tokens_in || data.input_tokens || 0;
            const tokensOut = data.tokens_out || data.output_tokens || 0;

            setConversationHistory(prev => [...prev.slice(-14), {
                role: 'assistant', text: responseText, assistant: assistantId,
                corr: convCorr,
                turnStart, turnEnd: new Date().toISOString(),
                memoryUsed, envelopeId: responseEnvelope?.id,
                tokens_in: tokensIn, tokens_out: tokensOut,
                images: data.images || undefined,
                richContent: data.richContent || undefined,
                decisionEvidenceLevel: data.decision_evidence_level || undefined,
                execution: responseExecution,
            }]);

            storeEnvelopeSafe(createLayerEvent('L9', 'complete', { responseLength: responseText.length, duration_ms: Date.now() - assembleStartTime }, convCorr), 'AOCL L9 complete');
            storeEnvelopeSafe(createRunEvent('complete', {
                success: true,
                handledBy: data.execution?.provider || data.provider || executionPlan.provider || 'llm',
                totalDuration_ms: Date.now() - runStartTime,
                memoryUsed,
                cost_usd: data.cost_usd || 0,
                ...buildExecutionTracePayload(executionPlan, {
                    provider: data.execution?.provider || data.provider || executionPlan.provider || null,
                    model: data.execution?.model || data.model || executionPlan.model || null,
                    source: data.execution?.source || executionPlan.source,
                    credentialId: data.execution?.credential_id ?? null,
                    credentialLabel: data.execution?.credential_label || null,
                    credentialProvider: data.execution?.credential_provider || null
                })
            }, convCorr), 'AOCL Run complete');

            memoryManager.processInteraction({ query: text, response: responseText, agent: assistantId, duration: Date.now() - startTime, cost: data.cost_usd || 0 });

            setIsProcessing(false);
            onTabUpdate?.(tabId, {
                lastMessageAt: new Date().toISOString(),
                correlationId: convCorr,
                lastExecution: responseExecution,
            });
            processNextInQueue();

            // TTS: speak the response only if voice is enabled and not muted.
            // Previously this hardcoded a 200-char substring which defeated the
            // user's verbosity setting (Quiet 150 / Normal 500 / Verbose 1000).
            // Now we pass the full response to preprocessForTTS and let the
            // verbosity-aware truncator in ttsPreprocessor do the right thing.
            // Exception: in Quiet mode, prefer the backend's voice_summary since
            // it's purpose-built to be brief.
            if (voiceEnabled && !isMuted) {
                const verbosityKey = voiceSettings.verbosity || 'normal';
                const textToSpeak = verbosityKey === 'quiet' && data.voice_summary
                    ? data.voice_summary
                    : responseText;
                if (textToSpeak) {
                    speakText(textToSpeak);
                } else {
                    setHalState('idle');
                }
            } else {
                setHalState('idle');
            }
        } catch (err) {
            abortControllerRef.current = null;

            // Don't update state if unmounted
            if (!mountedRef.current) return;

            // User-initiated cancel — auditable event, clean exit
            const isUserCancel = err.name === 'AbortError' && abortController?.signal?.reason === 'user_cancel';
            if (isUserCancel) {
                console.log('[ChatTab] Request cancelled by user');

                const cancelDuration = Date.now() - runStartTime;

                // AEE: Log cancellation as a proper event (job started → cancelled)
                storeEnvelopeSafe(createLayerEvent('L7', 'reject', {
                    error: 'User cancelled request',
                    reason: 'user_cancel',
                    duration_ms: cancelDuration,
                    prompt_preview: text.slice(0, 100),
                    ...buildExecutionTracePayload(executionPlan)
                }, convCorr), 'AOCL L7 cancel');

                storeEnvelopeSafe(createRunEvent('error', {
                    error: 'User cancelled request',
                    reason: 'user_cancel',
                    totalDuration_ms: cancelDuration,
                    handledBy: executionPlan.provider || 'llm',
                    ...buildExecutionTracePayload(executionPlan)
                }, convCorr), 'AOCL Run cancelled');

                if (lastQueryEnvelopeRef.current) {
                    storeEnvelopeSafe(createError(lastQueryEnvelopeRef.current, {
                        code: 'USER_CANCELLED',
                        message: `Request cancelled by user after ${Math.round(cancelDuration / 1000)}s`
                    }), 'AEE cancel envelope');
                }

                setCurrentText('');
                setHalState('idle');
                setConversationHistory(prev => [...prev, { role: 'assistant', text: '*Request cancelled.*', cancelled: true }]);
                setIsProcessing(false);
                processNextInQueue();
                return;
            }

            console.error('Chat error:', err);
            const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
            const errorMsg = isTimeout
                ? 'Request timed out (3 minutes). Try again or simplify your query.'
                : 'Connection error. Please check the backend.';
            setCurrentText(errorMsg);
            setHalState('error');

            storeEnvelopeSafe(createLayerEvent('L7', 'reject', {
                error: err.message || 'Connection error',
                duration_ms: Date.now() - delegateStartTime,
                ...buildExecutionTracePayload(executionPlan)
            }, convCorr), 'AOCL L7 reject');
            storeEnvelopeSafe(createRunEvent('error', {
                error: err.message || 'Connection error',
                totalDuration_ms: Date.now() - runStartTime,
                handledBy: executionPlan.provider || 'llm',
                ...buildExecutionTracePayload(executionPlan)
            }, convCorr), 'AOCL Run error');
            if (lastQueryEnvelopeRef.current) {
                storeEnvelopeSafe(createError(lastQueryEnvelopeRef.current, { code: 'CONNECTION_ERROR', message: err.message || errorMsg }), 'AEE error envelope');
            }

            setIsProcessing(false);
            processNextInQueue();
            setTimeout(() => { if (mountedRef.current) setHalState('idle'); }, 3000);
        }
    };

    // Insert a system marker message (e.g., model switch notification)
    const insertSystemMessage = useCallback((text) => {
        setConversationHistory(prev => [...prev, { role: 'system', text, ts: Date.now() }]);
    }, []);

    // Expose sendMessage + insertSystemMessage to parent (for voice I/O, model switching)
    useImperativeHandle(ref, () => ({
        sendMessage: (text, options) => sendMessage(text, options || {}),
        insertSystemMessage,
    }), [sendMessage, insertSystemMessage]);

    const handleSubmit = (e) => {
        e?.preventDefault?.();
        if (inputText.trim() || pendingFileUploads.length > 0) {
            const messageText = inputText.trim() || (pendingFileUploads.length > 0 ? `[Attached ${pendingFileUploads.length} file(s)]` : '');
            sendMessage(messageText);
            setInputText('');
            setPendingFileUploads([]);
            if (textareaRef.current) textareaRef.current.style.height = 'auto';
        }
    };

    const handleQuickAction = (prompt) => sendMessage(prompt);

    const askClaudeInstead = useCallback((originalQuery) => {
        sendMessage(originalQuery, { bypassRouter: true });
    }, []);

    const handleReaction = async (messageKey, reactionType) => {
        const currentReactions = messageReactions[messageKey] || {};
        const isActiveReaction = currentReactions[reactionType];
        let newReactions = { ...currentReactions };
        if (reactionType === 'thumbsUp' || reactionType === 'thumbsDown') {
            if (reactionType === 'thumbsUp') delete newReactions.thumbsDown;
            else delete newReactions.thumbsUp;
        }
        if (isActiveReaction) delete newReactions[reactionType];
        else newReactions[reactionType] = true;
        setMessageReactions(prev => ({ ...prev, [messageKey]: Object.keys(newReactions).length > 0 ? newReactions : undefined }));
        if (!isActiveReaction) {
            showToast(reactionType === 'thumbsUp' ? 'Feedback recorded — thanks!' : 'Feedback recorded');
        }
    };

    // Don't render heavy content when not active
    if (!isActive) {
        return <div className="chat-tab-content chat-tab-content--hidden" />;
    }

    return (
        <div className="chat-tab-content">
            {/* Messages */}
            <div className="chatgpt-layout__messages" ref={chatContainerRef}>
                <div className="chatgpt-layout__messages-inner">
                    {/* Minimal welcome — agent name and greeting (panels are in edge strip) */}
                    {conversationHistory.length === 0 && (
                        <div className="cw-inline-welcome">
                            <div className="cw-inline-welcome__avatar" style={{ '--cw-accent': currentAssistantData?.color?.primary || currentAssistantData?.color || '#38bdf8' }}>
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{
                                    stroke: currentAssistantData?.color?.primary || currentAssistantData?.color || '#38bdf8',
                                    strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.7,
                                }}>
                                    <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
                                </svg>
                            </div>
                            <h2 className="cw-inline-welcome__name">{currentAssistantData?.name || 'QuoxCORE'}</h2>
                            <p className="cw-inline-welcome__hint">
                                Ask anything, or use the panel buttons on the left for quick actions
                            </p>
                        </div>
                    )}
                    {conversationHistory.length === 0 ? null : (
                        <>
                            {conversationHistory.map((msg, i) => (
                                msg.role === 'system' ? (
                                    <div key={i} className="message-row message-row--system">
                                        <div className="system-marker">
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="6 9 12 15 18 9"/>
                                            </svg>
                                            <span>{msg.text}</span>
                                        </div>
                                    </div>
                                ) :
                                <div key={i} className="message-row-wrap" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                <div className={`message-row message-row--${msg.role} ${msg.pending ? 'message-row--pending' : ''}`}>
                                    <div className="message-avatar">
                                        {msg.role === 'user' ? (
                                            <div className="avatar avatar--user">
                                                {user?.picture ? (
                                                    <img src={user.picture} alt="" className="avatar__img" />
                                                ) : user?.name ? (
                                                    <span className="avatar__initials">{user.name.charAt(0).toUpperCase()}</span>
                                                ) : (
                                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                                                    </svg>
                                                )}
                                            </div>
                                        ) : (
                                            <div className={`avatar avatar--assistant avatar--${msg.assistant || 'quox'}`}>
                                                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <circle cx="12" cy="12" r="10"/>
                                                    <circle cx="12" cy="12" r="3"/>
                                                </svg>
                                            </div>
                                        )}
                                    </div>
                                    <div className="message-content">
                                        <div className="message-header">
                                            <span className="message-sender">
                                                {msg.role === 'user' ? (msg.pending ? 'You (queued)' : 'You') : getAssistantDisplayName(msg.assistant, currentAssistantData.name || 'QuoxCORE')}
                                            </span>
                                            {msg.role === 'assistant' && msg.assistant && (
                                                <span className={`message-badge message-badge--agent message-badge--agent-${msg.assistant}`} title={`Answered by ${getAssistantDisplayName(msg.assistant, msg.assistant).toUpperCase()}`}>
                                                    {getAssistantDisplayName(msg.assistant, currentAssistantData.name || msg.assistant).toUpperCase()}
                                                </span>
                                            )}
                                            {msg.memoryUsed && (
                                                <span className="message-badge message-badge--memory" title="Memory context active">
                                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
                                                </span>
                                            )}
                                            {msg.decisionEvidenceLevel && msg.decisionEvidenceLevel !== 'none' && (
                                                <span className="message-badge message-badge--evidence" title={`Decision evidence: ${msg.decisionEvidenceLevel}`} style={{ color: 'rgba(217, 119, 6, 0.85)', fontSize: '0.65rem', fontWeight: 600 }}>
                                                    &#9878; {msg.decisionEvidenceLevel.charAt(0).toUpperCase() + msg.decisionEvidenceLevel.slice(1)}
                                                </span>
                                            )}
                                            {msg.routedResponse && (
                                                <span className="message-badge message-badge--fast" title={`Fast response (pattern: ${msg.routerPattern})`}>
                                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                                                </span>
                                            )}
                                            {msg.execution && formatExecutionBadge(msg.execution) && (
                                                <span
                                                    className="message-badge message-badge--execution"
                                                    title={formatExecutionTitle(msg.execution)}
                                                >
                                                    {formatExecutionBadge(msg.execution)}
                                                </span>
                                            )}
                                            {/* LLM-FAILOVER P2 (UX audit A3b): badge deep-links to the
                                                Execution Policy settings section via the ?section= param
                                                added in A3a (SettingsLayout resolves it like a hash). */}
                                            <FailoverBadge
                                                execution={msg.execution}
                                                onOpenSettings={() => navigate('/settings?section=org/execution')}
                                            />
                                        </div>
                                        <ChatMd>{msg.text}</ChatMd>
                                        {msg.images && msg.images.length > 0 && (
                                            <ImageCard
                                                images={msg.images}
                                                onOpen={(imgs, idx) => setLightbox({ images: imgs, index: idx })}
                                            />
                                        )}
                                        {msg.richContent && (
                                            <RichObjectCard
                                                data={msg.richContent}
                                                authFetch={authFetch}
                                            />
                                        )}
                                        {msg.role === 'assistant' && (
                                            <div className="message-actions">
                                                {(msg.tokens_in > 0 || msg.tokens_out > 0) && (
                                                    <span className="message-tokens" title={`Input: ${msg.tokens_in || 0} | Output: ${msg.tokens_out || 0} tokens`}>
                                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
                                                        <span className="tokens-in">{formatTokenCount(msg.tokens_in)}</span>
                                                        <span className="tokens-separator">/</span>
                                                        <span className="tokens-out">{formatTokenCount(msg.tokens_out)}</span>
                                                    </span>
                                                )}
                                                {msg.routedResponse && msg.originalQuery && (
                                                    <button className="action-btn-small action-btn-claude" title="Ask Claude instead" onClick={() => askClaudeInstead(msg.originalQuery)} disabled={isProcessing}>
                                                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
                                                        Ask Claude
                                                    </button>
                                                )}
                                                <button className="action-btn-small" title="Copy response" onClick={() => { navigator.clipboard.writeText(msg.text); showToast('Response copied to clipboard'); }}>
                                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                                </button>
                                                {notesLicensed && (
                                                    <button
                                                        className="action-btn-small"
                                                        title="Save this answer to your notes"
                                                        data-testid="chat-save-to-notes"
                                                        onClick={async () => {
                                                            const question = [...conversationHistory.slice(0, i)].reverse().find((m) => m.role === 'user')?.text;
                                                            const n = chatToNote({ answer: msg.text, question, agentName: getAssistantDisplayName(assistantId) });
                                                            try {
                                                                const r = await notesApi.createNote({ scope: 'user', markdown: n.markdown, properties: n.properties });
                                                                showToast(`Saved to your notes: ${n.title}`);
                                                                if (r?.note?.id) setSavedNoteIds((prev) => ({ ...prev, [msg.envelopeId || `msg-${i}`]: r.note.id }));
                                                            } catch (e) {
                                                                showToast(`Could not save to notes: ${e?.message || 'error'}`);
                                                            }
                                                        }}
                                                    >
                                                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>
                                                    </button>
                                                )}
                                                {savedNoteIds[msg.envelopeId || `msg-${i}`] && (
                                                    <a className="action-btn-small" href={`/notes?note=${encodeURIComponent(savedNoteIds[msg.envelopeId || `msg-${i}`])}`} title="Open the saved note" data-testid="chat-open-saved-note">Open note</a>
                                                )}
                                                <span className="message-actions__separator" />
                                                <button className={`action-btn-small action-btn-reaction ${messageReactions[msg.envelopeId || `msg-${i}`]?.thumbsUp ? 'action-btn-reaction--active action-btn-reaction--positive' : ''}`} title="Good response" onClick={() => handleReaction(msg.envelopeId || `msg-${i}`, 'thumbsUp')}>
                                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>
                                                </button>
                                                <button className={`action-btn-small action-btn-reaction ${messageReactions[msg.envelopeId || `msg-${i}`]?.thumbsDown ? 'action-btn-reaction--active action-btn-reaction--negative' : ''}`} title="Poor response" onClick={() => handleReaction(msg.envelopeId || `msg-${i}`, 'thumbsDown')}>
                                                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17"/></svg>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                {/* AOCL-DISPATCH-B12: trace BELOW the message row, not
                                    inside it. Was rendering as a flex sibling of avatar +
                                    content, splitting horizontal space 50/50. Now wraps
                                    the row + trace in a column-direction container so the
                                    trace stacks beneath. */}
                                {msg.role === 'assistant' && msg.corr && (
                                    <MessageTrace corr={msg.corr} turnStart={msg.turnStart} turnEnd={msg.turnEnd} />
                                )}
                                </div>
                            ))}

                            {/* AOCL-DISPATCH-B5: live thinking waterfall is visible
                                ONLY during processing. Once done, the per-message
                                <MessageTrace> takes over and persists the trace. */}
                            {showThinking && isProcessing && (
                                <ThinkingDisplay
                                    steps={[...thinkingSteps, ...aoclLayerSteps].sort((a, b) => (a.ts || 0) - (b.ts || 0))}
                                    isActive={isProcessing}
                                />
                            )}

                            {halState !== 'idle' && currentText && !(showThinking && halState === 'thinking' && (thinkingSteps.length > 0 || aoclLayerSteps.length > 0)) && (
                                <div className={`message-row message-row--assistant message-row--${halState}`}>
                                    <div className="message-avatar">
                                        <div className={`avatar avatar--assistant avatar--${assistantId} ${halState === 'thinking' ? 'avatar--thinking' : ''}`}>
                                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <circle cx="12" cy="12" r="10"/>
                                                <circle cx="12" cy="12" r="3"/>
                                            </svg>
                                        </div>
                                    </div>
                                    <div className="message-content">
                                        <div className="message-header">
                                            <span className="message-sender">{currentAssistantData.name || 'QuoxCORE'}</span>
                                            <span className={`message-badge message-badge--agent message-badge--agent-${assistantId}`}>
                                                {(currentAssistantData.name || assistantId).toUpperCase()}
                                            </span>
                                            {halState === 'thinking' && (
                                                <span className="message-badge message-badge--thinking">{thinkingTime}s</span>
                                            )}
                                            {advancedMode && currentCorr && isProcessing && (
                                                <LayerStackMini corr={currentCorr} isProcessing={isProcessing} onClick={() => setShowLayerModal(true)} />
                                            )}
                                        </div>
                                        {halState === 'thinking' ? (
                                            <div className="message-text">
                                                <span className="thinking-dots"><span></span><span></span><span></span></span>
                                            </div>
                                        ) : (
                                            <ChatMd>{currentText}</ChatMd>
                                        )}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* Queue indicator */}
            {messageQueue.length > 0 && (
                <div className="chatgpt-layout__queue">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
                    <span>{messageQueue.length} message{messageQueue.length > 1 ? 's' : ''} queued</span>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="chatgpt-layout__error">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    <span>{error}</span>
                    <button onClick={() => setError(null)}>Dismiss</button>
                </div>
            )}

            {/* Action toast */}
            {actionToast && (
                <div className="action-toast">{actionToast}</div>
            )}

            {/* LLM-FAILOVER P2 (UX audit A1): degraded-but-working strip. The
                primary provider is cooling down and a fallback carries chat;
                say so instead of locking anything. */}
            {!chatUnavailable && llmStatus?.degraded && (
                <div className="chatgpt-layout__degraded-strip" style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 12px', margin: '0 12px 6px', borderRadius: 8,
                    border: '1px solid var(--status-amber-muted, #d9a44166)',
                    background: 'var(--status-amber-bg, #d9a4411a)',
                    color: 'var(--status-amber, #d9a441)', fontSize: 12,
                }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="M4 4l5 5" /></svg>
                    <span>
                        Running on fallback{llmStatus?.fallbackHint?.provider ? ` (${llmStatus.fallbackHint.provider}${llmStatus.fallbackHint.model ? `/${llmStatus.fallbackHint.model}` : ''})` : ''}.
                        {' '}Primary {String(llmStatus?.degradedReason || 'unavailable').replace(/_/g, ' ')}{llmStatus?.degradedUntil ? `, expected back ${new Date(llmStatus.degradedUntil).toISOString().slice(11, 16)} UTC` : ''}.
                    </span>
                </div>
            )}
            {/* Input Area */}
            <div className="chatgpt-layout__input-area">
                <form className="chatgpt-layout__input-form" onSubmit={handleSubmit}>
                    <div className="input-container">
                        <ChatFileUpload
                            disabled={chatUnavailable}
                            chatId={sessionId}
                            onFilesSelected={(files) => setPendingFileUploads(prev => [...prev, ...files])}
                            onFileUploaded={(file) => console.log('[FileUpload] File uploaded:', file.name)}
                        />
                        <textarea
                            ref={textareaRef}
                            value={inputText}
                            onChange={(e) => {
                                const val = e.target.value;
                                setInputText(val);
                                // Slash-menu: detect '/' at the very start of input
                                if (val.startsWith('/') && slashPrompts.length > 0) {
                                    setSlashQuery(val.slice(1));
                                    setShowPromptPicker(true);
                                } else {
                                    setShowPromptPicker(false);
                                    setSlashQuery('');
                                }
                            }}
                            placeholder={chatUnavailable ? chatUnavailableMessage : isProcessing ? "Type to queue a follow-up..." : pendingFileUploads.length > 0 ? `${pendingFileUploads.length} file(s) attached` : `Message ${currentAssistantData.name || 'QuoxCORE'}...`}
                            className={`chat-textarea ${isProcessing ? 'chat-textarea--processing' : ''} ${pendingFileUploads.length > 0 ? 'chat-textarea--has-files' : ''}`}
                            rows="1"
                        />
                        {showPromptPicker && (
                            <PromptPicker
                                query={slashQuery}
                                prompts={slashPrompts}
                                onSelect={(body) => {
                                    setInputText(body);
                                    setShowPromptPicker(false);
                                    setSlashQuery('');
                                    setTimeout(() => textareaRef.current?.focus(), 0);
                                }}
                                onClose={() => {
                                    setShowPromptPicker(false);
                                    setSlashQuery('');
                                }}
                            />
                        )}
                        {isProcessing && !inputText.trim() ? (
                            <button
                                type="button"
                                onClick={() => abortControllerRef.current?.abort('user_cancel')}
                                className="send-button send-button--stop"
                                title="Stop generating"
                            >
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="#ff6050" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                            </button>
                        ) : (
                            <button
                                type="submit"
                                disabled={chatUnavailable || (!inputText.trim() && pendingFileUploads.length === 0)}
                                className={`send-button ${isProcessing ? 'send-button--queue' : ''}`}
                                title={chatUnavailable ? chatUnavailableMessage : isProcessing ? "Message will be queued" : "Send message (Enter)"}
                            >
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                            </button>
                        )}
                    </div>
                    <div className="input-hints">
                        <span><kbd>Enter</kbd> send</span>
                        <span><kbd>Shift+Enter</kbd> new line</span>
                        <span><kbd>Space</kbd> voice (when not typing)</span>
                        {conversationHistory.length > 0 && (
                            <button
                                type="button"
                                className="thinking-toggle"
                                onClick={copyConversation}
                                title="Copy entire conversation to clipboard"
                            >
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                </svg>
                                Copy chat
                            </button>
                        )}
                        <button
                            type="button"
                            role="switch"
                            aria-checked={showThinking}
                            className={`thinking-switch ${showThinking ? 'thinking-switch--on' : ''}`}
                            onClick={() => updateSetting('showThinking', !showThinking)}
                            title={showThinking ? 'Hide thinking steps' : 'Show thinking steps'}
                        >
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
                                <line x1="9" y1="21" x2="15" y2="21"/>
                            </svg>
                            <span className="thinking-switch__label">Thinking</span>
                            <span className="thinking-switch__track" aria-hidden="true">
                                <span className="thinking-switch__knob" />
                            </span>
                        </button>
                    </div>
                </form>
                {/* P10.I-2 — Promote-this-conversation CTA strip.
                    Shown when the thread has 4+ messages (enough context to promote). */}
                {conversationHistory.length >= 4 && currentCorr && (
                    <PromoteConversationCTA
                        corrId={currentCorr}
                        recommendation={analyseFromHistory(conversationHistory)}
                        conversationHistory={conversationHistory}
                    />
                )}
            </div>

            {/* AOCL Modal */}
            {showLayerModal && currentCorr && (
                <LayerStackModal corr={currentCorr} isProcessing={isProcessing} onClose={() => setShowLayerModal(false)} />
            )}
            {lightbox && (
                <ImageLightbox
                    images={lightbox.images}
                    index={lightbox.index}
                    onClose={() => setLightbox(null)}
                    onChange={(idx) => setLightbox(prev => ({ ...prev, index: idx }))}
                />
            )}
        </div>
    );
});

export default ChatTab;

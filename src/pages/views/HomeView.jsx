/**
 * HomeView - Multi-Tab Chat Workspace (Command Page)
 *
 * Thin orchestration shell managing:
 * - Chat tab workspace (useChatWorkspace hook)
 * - Voice I/O (shared across tabs)
 * - BroadcastChannel for visualizer popup sync
 * - Chat service status check
 * - Right sidebar (visualizer, controls)
 * - Cross-page deep linking (location.state, URL params, Activity continue)
 *
 * Per-tab chat logic lives in ChatTab component.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useOutletContext, useLocation, useNavigate } from 'react-router-dom';
import { VisualizerSection, ChatTabBar, ChatTab, GlassChatPanel, AdvisorHealthBanner } from '../../components/chat';
import AssistantPicker from '../../components/chat/AssistantPicker';
import ModelSelector from '../../components/chat/ModelSelector';
import CredentialPicker from '../../components/integrations/CredentialPicker';
import AgentIdentityCard from '../../components/chat/AgentIdentityCard';
import AgentEdgePanels from '../../components/chat/AgentEdgePanels';
import { assistants } from '../../config/assistants';
import { getChief } from '../../config/chiefs';
import { MODEL_CATALOG } from '../../config/modelCatalog';
import { useMuteState, useTTS } from '../../hooks/useVoiceSettings';
import useVoiceCapture from '../../hooks/useVoiceCapture';
import { VoiceCaptureOverlay } from '../../components/voice/VoiceCaptureOverlay';
import useChatWorkspace from '../../hooks/useChatWorkspace';
import { CHAT_CONTINUE_KEY, CHAT_LIMITS } from '../../config/chatConfig';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useHealth } from '../../contexts/HealthContext';
import { queueSync } from '../../services/serverSyncQueue';
import { DEFAULT_LLM_CONFIG } from '../../services/llmService';
import { getRuntimeAssistantConfig, loadUserEntities } from '../../services/entityRegistry';
import { formatExecutionTitle, getEffectiveCredentialLabel, getProvenanceSourceLabel } from '../../services/llmProvenance';
import { resolveExecutionPlan } from '../../services/executionPlanResolver';
import { getLlmPolicyDescription, isLlmPolicyLocked } from '../../services/llmPolicy';
import { getCapabilityPolicyContext } from '../../services/llmCapabilityPolicy';
import { useLlmRoutingPolicy } from '../../hooks/useLlmRoutingPolicy';
import { useLlmCapabilityPreferences } from '../../hooks/useLlmCapabilityPreferences';
import { getCapabilityPreference, saveLlmCapabilityPreferences, mergeCapabilityPreference } from '../../services/llmCapabilityPreferencesClient';
import useLLMStatus from '../../hooks/useLLMStatus';
import { getScopeObjectIdFromNavigationState, resolveScopeAssistantEntity } from '../../services/scopeAssistantRouting';
import './views.css';
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'
import GoalLane from '../../components/automation/GoalLane'
import SuggestionPanel from '../../components/automation/SuggestionPanel'

const API_BASE = '/webhook';

function HomeView() {
    const { halState, setHalState } = useOutletContext() || { halState: 'idle', setHalState: () => {} };
    const location = useLocation();
    const navigate = useNavigate();

    // Auth context
    const { authFetch, isAuthenticated, user } = useAuth();
    const { currentOrg } = useWorkspace();
    const llmRoutingPolicy = useLlmRoutingPolicy(authFetch, currentOrg?.id);
    const llmCapabilityPreferences = useLlmCapabilityPreferences(authFetch, currentOrg?.id);
    const llmStatus = useLLMStatus();

    // Chat workspace (tab management)
    const {
        tabs, activeTabId, activeTab, tabCount, canAddTab, tabWarning,
        addTab, addTabEvictingOldest, removeTab, setActiveTab, renameTab, updateTab, openOrFocusAssistant,
    } = useChatWorkspace();

    // Voice settings (shared across tabs)
    const activeAssistantId = activeTab?.assistantId || 'quox';
    const activeChiefId = activeAssistantId?.startsWith('chief-') ? activeAssistantId.slice(6) : null;
    const activeChief = activeChiefId ? getChief(activeChiefId) : null;
    const activeAssistantRuntimeConfig = assistants[activeAssistantId]
        ? getRuntimeAssistantConfig(activeAssistantId)
        : activeChief
        ? {
            id: `chief-${activeChief.id}`,
            name: activeChief.name,
            shortName: activeChief.shortName || activeChief.name.charAt(0),
            specialty: activeChief.specialty || activeChief.description,
            voice: null,
            color: { primary: activeChief.color || '#1e293b' },
            role: activeChief.role || 'specialist',
            level: activeChief.level ?? 1,
            llm: activeChief.llm,
            llmPolicy: activeChief.llmPolicy,
        }
        : null;
    const { muted: isMuted, toggle: toggleMute } = useMuteState();
    const { voiceConfig, preprocess: preprocessText, shouldSpeak } = useTTS(activeAssistantId);

    // LLM provider/model selection (defaults from active agent's llm config)
    const activeAssistantLlm = activeAssistantRuntimeConfig?.llm;
    const activeAssistantLlmPolicy = activeAssistantRuntimeConfig?.llmPolicy;
    const activePolicyContext = getCapabilityPolicyContext({
        assistantId: activeAssistantId,
        assistantConfig: activeAssistantRuntimeConfig,
        isChief: !!activeChief,
    }, llmRoutingPolicy.policy);
    const activeCapabilityPreference = getCapabilityPreference(llmCapabilityPreferences, activePolicyContext.capability);
    const toolbarDefaultLlm = isLlmPolicyLocked(activeAssistantLlmPolicy)
        ? (activeAssistantLlm || DEFAULT_LLM_CONFIG)
        : (activeCapabilityPreference || activePolicyContext.policyDefault || activeAssistantLlm || DEFAULT_LLM_CONFIG);
    const [llmProvider, setLlmProvider] = useState(toolbarDefaultLlm.provider || DEFAULT_LLM_CONFIG.provider);
    const [llmModel, setLlmModel] = useState(toolbarDefaultLlm.model || DEFAULT_LLM_CONFIG.model);
    const [credentialId, setCredentialId] = useState(null);
    const [credentialMeta, setCredentialMeta] = useState(null);

    // Reset to agent defaults when switching assistants
    useEffect(() => {
        setLlmProvider(toolbarDefaultLlm.provider || DEFAULT_LLM_CONFIG.provider);
        setLlmModel(toolbarDefaultLlm.model || DEFAULT_LLM_CONFIG.model);
        setCredentialId(null);
        setCredentialMeta(null);
    }, [activeAssistantId, toolbarDefaultLlm.provider, toolbarDefaultLlm.model]);

    useEffect(() => {
        if (isLlmPolicyLocked(activeAssistantLlmPolicy) || !activeCapabilityPreference || credentialId) return;
        const policyProvider = activePolicyContext.policyDefault?.provider || DEFAULT_LLM_CONFIG.provider;
        const policyModel = activePolicyContext.policyDefault?.model || DEFAULT_LLM_CONFIG.model;
        const stillOnPolicyBaseline = llmProvider === policyProvider && llmModel === policyModel;
        if (stillOnPolicyBaseline) {
            setLlmProvider(activeCapabilityPreference.provider || policyProvider);
            setLlmModel(activeCapabilityPreference.model || policyModel);
        }
    }, [
        activeAssistantLlmPolicy,
        activeCapabilityPreference?.provider,
        activeCapabilityPreference?.model,
        activePolicyContext.policyDefault?.provider,
        activePolicyContext.policyDefault?.model,
        credentialId,
        llmProvider,
        llmModel,
    ]);

    // Reset credential when switching providers (different vault type)
    const currentVaultType = MODEL_CATALOG[llmProvider]?.vaultType;
    useEffect(() => {
        setCredentialId(null);
        setCredentialMeta(null);
    }, [currentVaultType]);

    const activeExecutionPlan = resolveExecutionPlan({
        userSelection: {
            provider: llmProvider,
            model: llmModel,
            credentialId,
        },
        capability: activePolicyContext.capability,
        capabilityLabel: activePolicyContext.capabilityLabel,
        policyLabel: activePolicyContext.policyLabel,
        policyEnabled: activePolicyContext.policyEnabled,
        policyEnforcement: activePolicyContext.policyEnforcement,
        capabilityAllowUserOverride: activePolicyContext.allowUserOverride,
        personalPreference: activeCapabilityPreference,
        policyDefault: activePolicyContext.policyDefault,
        credentialMeta,
        assistantRecommendation: activeAssistantLlm,
        specialistLock: isLlmPolicyLocked(activeAssistantLlmPolicy) ? activeAssistantLlm : null,
        systemDefault: activePolicyContext.systemDefault || DEFAULT_LLM_CONFIG,
    });
    const resolvedProviderConfig = MODEL_CATALOG[activeExecutionPlan.provider] || {};
    const resolvedProviderName = resolvedProviderConfig.name || activeExecutionPlan.provider;
    const resolvedModelName = resolvedProviderConfig.models?.find(mod => mod.id === activeExecutionPlan.model)?.name || activeExecutionPlan.model;
    const effectiveModelSource = getProvenanceSourceLabel(activeExecutionPlan.source);
    const effectiveCredentialLabel = getEffectiveCredentialLabel({ credentialId, credentialMeta });
    const lastExecution = activeTab?.lastExecution || null;
    const lastExecutedProviderConfig = lastExecution?.provider ? (MODEL_CATALOG[lastExecution.provider] || {}) : {};
    const lastExecutedProviderName = lastExecution?.provider ? (lastExecutedProviderConfig.name || lastExecution.provider) : null;
    const lastExecutedModelName = lastExecution?.model
        ? (lastExecutedProviderConfig.models?.find(mod => mod.id === lastExecution.model)?.name || lastExecution.model)
        : null;
    const executionDiffersFromPlan = !!(
        lastExecution?.provider
        && lastExecution?.model
        && (
            lastExecution.provider !== activeExecutionPlan.provider
            || lastExecution.model !== activeExecutionPlan.model
        )
    );
    const displayedCredentialLabel = lastExecution
        ? (lastExecution.credential_label || (lastExecution.credential_id ? 'Selected vault key' : 'Environment/default auth'))
        : effectiveCredentialLabel;

    // Voice capture (push-to-talk) — pipeline owned by useVoiceCapture hook
    const activeTabRef = useRef(null); // ref to active ChatTab for voice sendMessage
    const voice = useVoiceCapture({
        onTranscript: (text) => {
            // FND_..front-door F12: do NOT console.log the transcript — it is user speech content
            // (privacy) and shipped as unconditional prod noise. Keep only the drop diagnostic.
            const ref = activeTabRef.current;
            if (ref?.sendMessage) {
                ref.sendMessage(text);
            } else {
                console.warn('[voice→chat] transcript DROPPED — no active tab ref');
            }
        },
    });
    const isListening = voice.phase === 'listening' || voice.phase === 'requesting-mic';
    const audioData = null; // legacy broadcast payload; overlay is now primary visual

    // New tab assistant picker state
    const [showNewTabPicker, setShowNewTabPicker] = useState(false);

    // BroadcastChannel for visualizer popup sync
    // Use refs to avoid stale closures in the onmessage handler
    const visualizerChannelRef = useRef(null);
    const latestHalStateRef = useRef(halState);
    const latestAssistantIdRef = useRef(activeAssistantId);
    const latestAudioDataRef = useRef(audioData);
    useEffect(() => { latestHalStateRef.current = halState; }, [halState]);
    useEffect(() => { latestAssistantIdRef.current = activeAssistantId; }, [activeAssistantId]);
    useEffect(() => { latestAudioDataRef.current = audioData; }, [audioData]);

    useEffect(() => {
        try {
            visualizerChannelRef.current = new BroadcastChannel('quox-visualizer-sync');
        } catch (e) {
            console.warn('[HomeView] BroadcastChannel not supported:', e);
            return;
        }
        visualizerChannelRef.current.onmessage = (event) => {
            const { type, payload } = event.data || {};
            switch (type) {
                case 'request-state':
                    visualizerChannelRef.current?.postMessage({
                        type: 'state',
                        payload: {
                            halState: latestHalStateRef.current,
                            assistantId: latestAssistantIdRef.current,
                            audioData: latestAudioDataRef.current,
                            isMuted,
                        }
                    });
                    break;
                case 'voice-message':
                    if (payload?.text && activeTabRef.current?.sendMessage) {
                        activeTabRef.current.sendMessage(payload.text);
                    }
                    break;
                case 'popup-state':
                    // Popup is recording — update halState so sidebar visualizer shows it
                    if (payload?.state === 'listening') {
                        setHalState('listening');
                    }
                    break;
            }
        };
        return () => { visualizerChannelRef.current?.close(); };
    }, []);

    // Broadcast state changes to popup
    useEffect(() => {
        visualizerChannelRef.current?.postMessage({
            type: 'state',
            payload: { halState, assistantId: activeAssistantId, audioData, isMuted }
        });
    }, [halState, activeAssistantId, audioData, isMuted]);

    // Cross-page deep linking: location.state.assistant or ?assistant= URL param
    useEffect(() => {
        const stateAssistant = location.state?.assistant;
        const paramAssistant = new URLSearchParams(location.search).get('assistant');
        const targetAssistant = stateAssistant || paramAssistant;
        const scopeObjectId = getScopeObjectIdFromNavigationState(location.state);

        if (targetAssistant) {
            openOrFocusAssistant(targetAssistant);
            // Clear state to prevent re-triggering
            try { window.history.replaceState({}, '', '/'); } catch { /* */ }
            return;
        }

        if (!scopeObjectId || !currentOrg?.id || !authFetch) {
            return;
        }

        let cancelled = false;
        loadUserEntities(currentOrg.id, authFetch)
            .then((entities) => {
                if (cancelled) return;
                const scopeAssistant = resolveScopeAssistantEntity(entities, scopeObjectId);
                if (scopeAssistant?.id) {
                    openOrFocusAssistant(scopeAssistant.id);
                    try { window.history.replaceState({}, '', '/'); } catch { /* */ }
                }
            })
            .catch(() => {});

        return () => {
            cancelled = true;
        };
    }, [location.state, location.search, openOrFocusAssistant, currentOrg?.id, authFetch]);

    // Continue conversation from Activity page.
    // AOCL-DISPATCH-B17: previous fixes (B11→B14) addressed the loop and
    // the bulk-write of phantom tab messages, but the user still hit
    // "Tab limit reached" because B12-era phantoms in localStorage have
    // stored messages and survived B14's prune. Two-part fix:
    //   1. addTabEvictingOldest is atomic — it always succeeds even
    //      with corrupted state (no setState chaining race).
    //   2. lastMessageAt is set on the new tab immediately after the
    //      message bulk-write, so the next pruneOrphanTabs run keeps it.
    const [continueError, setContinueError] = useState(null);
    const consumedCorrRef = useRef(null);

    useEffect(() => {
        const stateConv = location.state?.continueConversation;
        const statePayload = stateConv?._continuePayload;
        const lsPending = localStorage.getItem(CHAT_CONTINUE_KEY);

        if (!statePayload && !lsPending) return;

        // Consume both sources atomically BEFORE any work that could fail
        if (lsPending) localStorage.removeItem(CHAT_CONTINUE_KEY);
        if (stateConv) {
            try { window.history.replaceState({}, '', '/'); } catch { /* */ }
        }

        let payload = statePayload;
        if (!payload && lsPending) {
            try { payload = JSON.parse(lsPending); } catch (err) {
                console.error('[HomeView] Failed to parse pending continue:', err);
                return;
            }
        }

        // Defensive: if we already consumed this exact corr (e.g. effect
        // re-fires due to React StrictMode double-invoke), no-op.
        const corrKey = payload?.corr || JSON.stringify(payload?.messages?.[0] || null);
        if (consumedCorrRef.current === corrKey) return;
        consumedCorrRef.current = corrKey;

        const { messages, assistantId } = payload || {};
        if (!messages || messages.length === 0) {
            console.warn('[HomeView] Continue payload had no messages', payload);
            setContinueError({ kind: 'no_messages' });
            return;
        }

        const newTabId = addTabEvictingOldest(assistantId || 'quox');
        if (!newTabId) {
            // Should never happen — addTabEvictingOldest is unconditional.
            console.warn('[HomeView] addTabEvictingOldest returned null');
            setContinueError({ kind: 'tab_limit', messages, assistantId });
            return;
        }
        try {
            localStorage.setItem(`quox-chat-tab-${newTabId}-messages`, JSON.stringify(messages));
        } catch (err) {
            console.error('[HomeView] Failed to write continued messages:', err);
        }
        // Mark the tab as real so pruneOrphanTabs preserves it on next load.
        const lastTs = messages[messages.length - 1]?.ts || new Date().toISOString();
        updateTab(newTabId, { lastMessageAt: lastTs });
    }, [location.state, location.pathname, addTabEvictingOldest, updateTab]);

    // Auto-dismiss continue errors after 8s
    useEffect(() => {
        if (!continueError) return;
        const t = setTimeout(() => setContinueError(null), 8000);
        return () => clearTimeout(t);
    }, [continueError]);

    // Sync assistantId to localStorage for other pages
    useEffect(() => {
        if (activeAssistantId) {
            localStorage.setItem('quox-assistant', activeAssistantId);
            queueSync('defaultAssistant', activeAssistantId);
        }
    }, [activeAssistantId]);

    // Keyboard: Space for push-to-talk.
    // Fires immediately on keydown (no repeat, no input focused, or textarea empty).
    // Everything else lives in useVoiceCapture.
    useEffect(() => {
        const isTypeableActive = () => {
            const el = document.activeElement;
            if (!el) return false;
            if (el.tagName === 'INPUT') return true;
            if (el.tagName === 'TEXTAREA') return (el.value || '').trim() !== '';
            if (el.isContentEditable) return true;
            return false;
        };

        const onKeyDown = (e) => {
            if (e.code === 'Escape' && voice.phase !== 'idle') {
                e.preventDefault();
                voice.cancel();
                return;
            }
            if (e.code !== 'Space' || e.repeat) return;
            if (voice.phase !== 'idle') return;
            if (isTypeableActive()) return;
            e.preventDefault();
            voice.start();
        };
        const onKeyUp = (e) => {
            if (e.code !== 'Space') return;
            if (voice.phase !== 'listening' && voice.phase !== 'requesting-mic') return;
            e.preventDefault();
            voice.stop();
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [voice.phase, voice.start, voice.stop, voice.cancel]);

    // Keep AppShell halState roughly in sync with voice phase so the sidebar
    // visualizer reacts to listening/transcribing states. When the overlay
    // returns to idle (done/cancelled/error cleared), release halState so the
    // chat's own state can drive it again.
    useEffect(() => {
        if (voice.phase === 'listening' || voice.phase === 'requesting-mic') setHalState('listening');
        else if (voice.phase === 'transcribing') setHalState('thinking');
        else if (voice.phase === 'error') setHalState('error');
        else if (voice.phase === 'idle' || voice.phase === 'cancelled' || voice.phase === 'done') {
            // don't force idle mid-chat — only clear if we're not thinking/speaking from a reply
            setHalState((cur) => (cur === 'listening' || cur === 'error' ? 'idle' : cur));
        }
    }, [voice.phase, setHalState]);

    // Handle halState changes from active ChatTab
    const handleTabHalStateChange = useCallback((state) => {
        setHalState(state);
    }, [setHalState]);

    // Handle new tab creation with assistant picker
    const handleNewTab = useCallback((assistantId) => {
        addTab(assistantId || 'quox');
        setShowNewTabPicker(false);
    }, [addTab]);

    return (
        <div className="chatgpt-layout">
            {/* AOCL-DISPATCH-B11: surface Continue Conversation failures
                so the user can see what went wrong instead of getting a
                silent no-op. */}
            {continueError && (
                <div className="continue-error-toast" role="alert" style={{
                    position: 'fixed', top: 16, right: 16, zIndex: 1000,
                    padding: '12px 16px', borderRadius: 8,
                    background: 'rgba(239, 68, 68, 0.95)', color: '#fff',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                    maxWidth: 380, fontSize: 13, lineHeight: 1.4,
                }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        Couldn't continue conversation
                    </div>
                    <div style={{ opacity: 0.95 }}>
                        {continueError.kind === 'tab_limit'
                            ? `Tab limit reached (${CHAT_LIMITS.MAX_TABS}). Close an existing tab and click Continue again.`
                            : continueError.kind === 'no_messages'
                                ? 'This conversation has no resumable content (e.g. failed before any envelope was emitted).'
                                : 'See console for details.'}
                    </div>
                    <button
                        onClick={() => setContinueError(null)}
                        style={{
                            marginTop: 8, padding: '4px 10px', borderRadius: 4,
                            background: 'rgba(255,255,255,0.2)', color: '#fff',
                            border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer',
                            fontSize: 12,
                        }}
                    >Dismiss</button>
                </div>
            )}
            <VoiceCaptureOverlay
                phase={voice.phase}
                durationMs={voice.durationMs}
                level={voice.level}
                transcript={voice.transcript}
                errorMessage={voice.errorMessage}
                getAnalyserData={voice.getAnalyserData}
                onCancel={voice.cancel}
                assistantName={activeAssistantRuntimeConfig?.name || 'Quox'}
            />
            <main className="chatgpt-layout__main">
                <LLMAuthBanner status={llmStatus} />

                {/* P10.I-1: Goal Lane — in-flight automation threads band */}
                <GoalLane />

                {/* QMH-5/3 — surface QuoxPredict advisor health to the user
                    when the system signals low confidence on similar work. */}
                <AdvisorHealthBanner authFetch={authFetch} />

                {/* Tab bar */}
                <ChatTabBar
                    tabs={tabs}
                    activeTabId={activeTabId}
                    onSwitch={setActiveTab}
                    onClose={removeTab}
                    onAdd={() => handleNewTab('quox')}
                    onRename={renameTab}
                    canAdd={canAddTab}
                    warning={tabWarning}
                />

                {/* New tab assistant picker (shows when + is clicked) */}
                {showNewTabPicker && (
                    <div className="chat-assistant-bar chat-assistant-bar--new">
                        <span className="chat-assistant-bar__label">New chat with:</span>
                        <AssistantPicker
                            value={null}
                            onChange={(id) => handleNewTab(id)}
                            orgId={currentOrg?.id}
                            authFetch={authFetch}
                            size="small"
                            placeholder="Choose assistant..."
                        />
                        <button
                            className="chat-assistant-bar__cancel"
                            onClick={() => setShowNewTabPicker(false)}
                            title="Cancel"
                        >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                )}

                {/* Active tab assistant selector (always visible, enables mid-chat switching) */}
                {!showNewTabPicker && (
                    <div className="chat-assistant-bar-wrap">
                        <div className="chat-assistant-bar">
                            <span className="chat-assistant-bar__label">Chatting with:</span>
                            <AssistantPicker
                                value={activeAssistantId}
                                onChange={(newId) => updateTab(activeTabId, { assistantId: newId })}
                                orgId={currentOrg?.id}
                                authFetch={authFetch}
                                size="small"
                            />
                            <ModelSelector
                                provider={llmProvider}
                                model={llmModel}
                                disabled={isLlmPolicyLocked(activeAssistantLlmPolicy)}
                                onChange={(p, m) => {
                                    setLlmProvider(p);
                                    setLlmModel(m);
                                    // Insert timeline marker in active chat
                                    const modelName = MODEL_CATALOG[p]?.models?.find(mod => mod.id === m)?.name || m;
                                    const providerName = MODEL_CATALOG[p]?.name || p;
                                    activeTabRef.current?.insertSystemMessage?.(`Model switched to ${modelName} (${providerName})`);
                                    // Persist as the personal default for this capability (same
                                    // store Settings > Execution Policy writes to,
                                    // ExecutionPolicySettings.jsx:854) so a manual toolbar pick
                                    // survives navigation instead of resetting on remount.
                                    // Skipped when the org policy doesn't allow a personal
                                    // override for this capability (fleet #309).
                                    if (currentOrg?.id && activePolicyContext.allowUserOverride !== false) {
                                        const nextPreferences = mergeCapabilityPreference(
                                            llmCapabilityPreferences.preferences,
                                            activePolicyContext.capability,
                                            p,
                                            m
                                        );
                                        saveLlmCapabilityPreferences(authFetch, currentOrg.id, nextPreferences)
                                            .then(() => llmCapabilityPreferences.refresh({ force: true }))
                                            .catch(err => console.warn('[HomeView] Failed to save model preference:', err.message));
                                    }
                                }}
                                defaultProvider={toolbarDefaultLlm.provider}
                                defaultModel={toolbarDefaultLlm.model}
                            />
                            {currentVaultType && (
                                <CredentialPicker
                                    type={currentVaultType}
                                    value={credentialId}
                                    onSelect={(cred) => {
                                        setCredentialId(cred?.id || null);
                                        setCredentialMeta(cred || null);
                                    }}
                                    compact
                                    placeholder="Default key"
                                />
                            )}
                        </div>
                        <div className="chat-assistant-bar__effective" aria-label="Effective model details">
                            <span className="chat-assistant-bar__effective-pill">
                                Planned: {resolvedModelName} via {resolvedProviderName}
                            </span>
                            {lastExecutedProviderName && lastExecutedModelName && (
                                <>
                                    <span className="chat-assistant-bar__effective-sep">•</span>
                                    <span
                                        className="chat-assistant-bar__effective-pill"
                                        title={formatExecutionTitle(lastExecution)}
                                    >
                                        Executed: {lastExecutedModelName} via {lastExecutedProviderName}
                                    </span>
                                </>
                            )}
                            <span className="chat-assistant-bar__effective-sep">•</span>
                            <span>
                                Source: {getProvenanceSourceLabel(lastExecution?.source || activeExecutionPlan.source)}
                            </span>
                            <span className="chat-assistant-bar__effective-sep">•</span>
                            <span>Credential: {displayedCredentialLabel}</span>
                            {activeExecutionPlan.source === 'policy_default' && activeExecutionPlan.policyLabel && (
                                <>
                                    <span className="chat-assistant-bar__effective-sep">•</span>
                                    <span title={`${activeExecutionPlan.policyLabel}${activeExecutionPlan.capabilityLabel ? ` (${activeExecutionPlan.capabilityLabel})` : ''}`}>
                                        Policy: {activeExecutionPlan.policyLabel}
                                    </span>
                                </>
                            )}
                            {executionDiffersFromPlan && (
                                <>
                                    <span className="chat-assistant-bar__effective-sep">•</span>
                                    <span title={formatExecutionTitle(lastExecution)}>
                                        Collector override active
                                    </span>
                                </>
                            )}
                            {isLlmPolicyLocked(activeAssistantLlmPolicy) && (
                                <>
                                    <span className="chat-assistant-bar__effective-sep">•</span>
                                    <span title={getLlmPolicyDescription(activeAssistantLlmPolicy)}>Policy: Specialist lock</span>
                                </>
                            )}
                        </div>
                    </div>
                )}

                {/* Chat tabs - each manages its own conversation */}
                {tabs.map(tab => (
                    <ChatTab
                        key={tab.id}
                        ref={tab.id === activeTabId ? activeTabRef : null}
                        tabId={tab.id}
                        assistantId={tab.assistantId}
                        isActive={tab.id === activeTabId}
                        onTabUpdate={updateTab}
                        onHalStateChange={handleTabHalStateChange}
                        authFetch={authFetch}
                        orgId={currentOrg?.id}
                        user={user}
                        currentOrg={currentOrg}
                        isAuthenticated={isAuthenticated}
                        llmProvider={activeExecutionPlan.provider}
                        llmModel={activeExecutionPlan.model}
                        credentialId={credentialId}
                        executionPlan={activeExecutionPlan}
                        routingPolicy={llmRoutingPolicy.policy}
                        llmStatus={llmStatus}
                    />
                ))}

                {/* Edge-mounted panel buttons (left edge of chat area) */}
                <AgentEdgePanels
                    assistantId={activeAssistantId}
                    onQuickAction={(text) => activeTabRef.current?.sendMessage?.(text)}
                />
            </main>

            {/* Right Sidebar */}
            <aside className="sidebar-redesign">
                {/* Visualizer (reflects active tab's assistant) */}
                <VisualizerSection
                    agent={activeAssistantId}
                    state={halState}
                    audioData={audioData}
                    showStatus={false}
                    showVoice={false}
                    storageKey="quox-visualizer-collapsed"
                />

                {/* Agent identity card */}
                <AgentIdentityCard
                    assistantId={activeAssistantId}
                    currentAssistantData={activeAssistantRuntimeConfig}
                />

                {/* P10.I-3: Quox Brain proactive suggestions */}
                <SuggestionPanel />

                {/* Controls */}
                <div className="sidebar-controls-clean">
                    {/* Mute Toggle */}
                    <button
                        className={`sidebar-mute-btn ${isMuted ? 'muted' : ''}`}
                        onClick={toggleMute}
                        title={isMuted ? 'Unmute voice responses' : 'Mute voice responses'}
                    >
                        {isMuted ? (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2m14 0v2c0 .46-.04.92-.13 1.36"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                            </svg>
                        ) : (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                            </svg>
                        )}
                        <span>{isMuted ? 'Muted' : 'Sound On'}</span>
                    </button>
                </div>

                {/* Action Buttons */}
                <div className="sidebar-actions">
                    <button className="sidebar-action sidebar-action--primary" onClick={() => handleNewTab('quox')}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        New Chat
                    </button>
                    <button className="sidebar-action sidebar-action--secondary" onClick={() => navigate('/activity')}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        Activity
                    </button>
                </div>
            </aside>

        </div>
    );
}

export default HomeView;

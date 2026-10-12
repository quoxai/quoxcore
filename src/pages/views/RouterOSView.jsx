/**
 * RouterOSView - MikroTik Router Management Dashboard
 *
 * Main dashboard view with:
 * - Tab bar: Dashboard / NETWATCH
 * - Router selector dropdown
 * - Dashboard panels for health, devices, DHCP, alerts, VPN
 * - NETWATCH AI chat for troubleshooting
 * - License gating (requires tier_b)
 * - Setup wizard for first-time configuration
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ChatEngine, ChatInput, VisualizerSection, GlassChatPanel } from '../../components/chat';
import {
    useRouterOSLicenseStatus,
    useRouterOSConfig,
    useRouterData,
    getRouters,
    buildNetwatchContext,
    storeConfig
} from '../../services/routerosClient';
import {
    RouterOSSetupWizard,
    ConnectionStatus,
    RouterHealthPanel,
    DeviceInventoryPanel,
    DHCPPanel,
    AlertsPanel,
    VPNPanel,
    QuickActionsPanel,
    DeviceDetailModal,
    LeaseActionModal,
    TroubleshootWizardModal
} from '../../components/routeros';
import { assistants } from '../../config/assistants';
import { getAgentSuggestions } from '../../config/agentRegistry';
import './RouterOSView.css';

// ============================================
// ICONS
// ============================================

const DashboardIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7"/>
        <rect x="14" y="3" width="7" height="7"/>
        <rect x="14" y="14" width="7" height="7"/>
        <rect x="3" y="14" width="7" height="7"/>
    </svg>
);

const NetwatchIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/>
        <circle cx="12" cy="12" r="6"/>
        <circle cx="12" cy="12" r="2"/>
    </svg>
);

const RouterIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="5" r="3"/>
        <circle cx="5" cy="19" r="3"/>
        <circle cx="19" cy="19" r="3"/>
        <path d="M12 8v4M8.5 14.5L12 12l3.5 2.5"/>
    </svg>
);

const ChevronDownIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="6 9 12 15 18 9"/>
    </svg>
);

const LockIcon = () => (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
);

const SettingsIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
);

// ============================================
// LICENSE PAYWALL
// ============================================

function LicensePaywall() {
    return (
        <div className="ros-paywall">
            <div className="ros-paywall__card">
                <div className="ros-paywall__icon">
                    <LockIcon />
                </div>
                <h2 className="ros-paywall__title">RouterOS Manager</h2>
                <p className="ros-paywall__subtitle">Pro Feature</p>
                <p className="ros-paywall__desc">
                    Intelligent MikroTik router management with plain English explanations,
                    device monitoring, DHCP management, and the NETWATCH AI assistant.
                </p>
                <div className="ros-paywall__features">
                    <div className="ros-paywall__feature">
                        <span className="ros-paywall__check">&#10003;</span>
                        Router health monitoring
                    </div>
                    <div className="ros-paywall__feature">
                        <span className="ros-paywall__check">&#10003;</span>
                        Connected device inventory
                    </div>
                    <div className="ros-paywall__feature">
                        <span className="ros-paywall__check">&#10003;</span>
                        DHCP lease management
                    </div>
                    <div className="ros-paywall__feature">
                        <span className="ros-paywall__check">&#10003;</span>
                        VPN tunnel status
                    </div>
                    <div className="ros-paywall__feature">
                        <span className="ros-paywall__check">&#10003;</span>
                        NETWATCH AI troubleshooting
                    </div>
                </div>
                <a href="https://quox.ai/pricing" className="ros-paywall__cta">
                    Upgrade to Pro - $35
                </a>
            </div>
        </div>
    );
}

// ============================================
// ROUTER SELECTOR
// ============================================

function RouterSelector({ routers, selectedId, onSelect }) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = routers.find(r => r.id === selectedId);

    return (
        <div className="ros-router-selector">
            <button
                className="ros-router-selector__trigger"
                onClick={() => setIsOpen(!isOpen)}
            >
                <RouterIcon />
                <span className="ros-router-selector__name">
                    {selected?.name || 'Select Router'}
                </span>
                <span className={`ros-router-selector__status ros-router-selector__status--${selected?.status || 'unknown'}`}>
                    {selected?.status || 'unknown'}
                </span>
                <ChevronDownIcon />
            </button>
            {isOpen && (
                <>
                    <div className="ros-router-selector__backdrop" onClick={() => setIsOpen(false)} />
                    <div className="ros-router-selector__dropdown">
                        {routers.map(router => (
                            <button
                                key={router.id}
                                className={`ros-router-selector__option ${router.id === selectedId ? 'ros-router-selector__option--selected' : ''}`}
                                onClick={() => {
                                    onSelect(router.id);
                                    setIsOpen(false);
                                }}
                            >
                                <div className="ros-router-selector__option-info">
                                    <span className="ros-router-selector__option-name">{router.name}</span>
                                    <span className="ros-router-selector__option-model">{router.model} - {router.ip}</span>
                                </div>
                                <span className={`ros-router-selector__status ros-router-selector__status--${router.status}`}>
                                    {router.status}
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

// ============================================
// DASHBOARD TAB
// ============================================

function DashboardTab({ routerData, loading, onAskNetwatch, onSelectDevice, onSelectLease, onStartTroubleshoot }) {
    if (loading) {
        return (
            <div className="ros-loading">
                <div className="ros-loading__spinner" />
                <p>Loading router data...</p>
            </div>
        );
    }

    if (!routerData?.router) {
        return (
            <div className="ros-empty">
                <RouterIcon />
                <p>No router data available</p>
            </div>
        );
    }

    return (
        <div className="ros-dashboard">
            {/* Top Row: Health + Quick Actions */}
            <div className="ros-dashboard__row ros-dashboard__row--top">
                <RouterHealthPanel
                    router={routerData.router}
                    health={routerData.router.health}
                />
                <QuickActionsPanel
                    onAskNetwatch={onAskNetwatch}
                    onStartTroubleshoot={onStartTroubleshoot}
                />
            </div>

            {/* Middle Row: Devices + DHCP */}
            <div className="ros-dashboard__row ros-dashboard__row--middle">
                <DeviceInventoryPanel
                    devices={routerData.devices}
                    onSelectDevice={onSelectDevice}
                />
                <DHCPPanel
                    leases={routerData.leases}
                    pools={routerData.pools}
                    onSelectLease={onSelectLease}
                />
            </div>

            {/* Bottom Row: Alerts + VPN */}
            <div className="ros-dashboard__row ros-dashboard__row--bottom">
                <AlertsPanel
                    alerts={routerData.alerts}
                    onAskNetwatch={onAskNetwatch}
                />
                <VPNPanel
                    tunnels={routerData.vpn}
                />
            </div>
        </div>
    );
}

// ============================================
// NETWATCH CHAT TAB
// ============================================

function ChatMessage({ message }) {
    const isUser = message.role === 'user';
    const content = message.text || message.content || '';
    const assistantData = assistants.netwatch || assistants.quox;

    return (
        <div className={`ros-msg ${isUser ? 'ros-msg--user' : 'ros-msg--assistant'}`}>
            <div className="ros-msg__avatar">
                {isUser ? (
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                    </svg>
                ) : (
                    <span style={{ color: assistantData?.color || '#10b981' }}>N</span>
                )}
            </div>
            <div className="ros-msg__content">{content}</div>
        </div>
    );
}

function NetwatchTab({ routerData, pendingQuery, onQueryConsumed, setHalState }) {
    const chatContainerRef = useRef(null);

    const contextBuilder = useCallback(async (query) => {
        return buildNetwatchContext(query, routerData);
    }, [routerData]);

    return (
        <ChatEngine
            agent="netwatch"
            contextBuilder={contextBuilder}
            sessionPrefix="NETWATCH"
            onStateChange={setHalState}
            enableMemory={true}
        >
            {({ messages, isProcessing, halState, audioData, isMuted, sendMessage, abortMessage, stopAudio, clearConversation, toggleMute }) => {
                // Consume pending query from dashboard
                if (pendingQuery && sendMessage) {
                    setTimeout(() => {
                        sendMessage(pendingQuery);
                        onQueryConsumed();
                    }, 100);
                }

                return (
                    <div className="ros-netwatch">
                        {/* Main Chat Area */}
                        <div className="ros-netwatch__main">
                            {/* Header */}
                            <div className="ros-netwatch__header">
                                <div className="ros-netwatch__header-left">
                                    <NetwatchIcon />
                                    <span>NETWATCH</span>
                                    <span className="ros-netwatch__subtitle">Network Assistant</span>
                                </div>
                                <div className="ros-netwatch__header-right">
                                    <button
                                        className={`ros-netwatch__action ${isMuted ? 'muted' : ''}`}
                                        onClick={toggleMute}
                                        title={isMuted ? 'Unmute' : 'Mute'}
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
                                    </button>
                                    <button
                                        className="ros-netwatch__action"
                                        onClick={clearConversation}
                                        title="Clear chat"
                                    >
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Messages */}
                            <div className="ros-netwatch__chat" ref={chatContainerRef}>
                                {messages.length === 0 ? (
                                    <div className="ros-netwatch__welcome">
                                        <div className="ros-netwatch__welcome-icon">
                                            <NetwatchIcon />
                                        </div>
                                        <h2>NETWATCH</h2>
                                        <p>Your network troubleshooting assistant. I can help explain what's happening on your network in plain English.</p>
                                        <div className="ros-netwatch__suggestions">
                                            <button onClick={() => sendMessage("What devices are on my network?")}>
                                                What devices are on my network?
                                            </button>
                                            <button onClick={() => sendMessage("Are there any IP conflicts?")}>
                                                Are there any IP conflicts?
                                            </button>
                                            <button onClick={() => sendMessage("Why is my internet slow?")}>
                                                Why is my internet slow?
                                            </button>
                                            <button onClick={() => sendMessage("Check my router's health")}>
                                                Check my router's health
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    messages.map((msg, i) => <ChatMessage key={i} message={msg} />)
                                )}
                                {isProcessing && (
                                    <div className="ros-msg ros-msg--assistant">
                                        <div className="ros-msg__avatar">
                                            <span style={{ color: '#10b981' }}>N</span>
                                        </div>
                                        <div className="ros-msg__content ros-msg__typing">
                                            <span></span><span></span><span></span>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Input */}
                            <ChatInput
                                onSend={sendMessage}
                                onStop={abortMessage}
                                placeholder="Ask NETWATCH about your network..."
                                isProcessing={isProcessing}
                                enableVoice={true}
                                className="ros-netwatch__input"
                            />
                        </div>

                        {/* Right Sidebar */}
                        <div className="ros-netwatch__sidebar">
                            <VisualizerSection
                                agent="netwatch"
                                state={halState}
                                audioData={audioData}
                                showStatus={true}
                                showVoice={true}
                                onVoiceTranscription={sendMessage}
                                storageKey="netwatch-visualizer-collapsed"
                            />

                            {halState === 'speaking' && (
                                <div className="ros-netwatch__stop">
                                    <button onClick={stopAudio}>
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="6" y="6" width="12" height="12"/>
                                        </svg>
                                        Stop Audio
                                    </button>
                                </div>
                            )}

                            <div className="ros-netwatch__section">
                                <h4>Quick Actions</h4>
                                <div className="ros-netwatch__actions">
                                    <button onClick={() => sendMessage('What devices are online right now?')} disabled={isProcessing}>
                                        Online Devices
                                    </button>
                                    <button onClick={() => sendMessage('Show me any network problems')} disabled={isProcessing}>
                                        Network Problems
                                    </button>
                                    <button onClick={() => sendMessage('How is my WiFi performing?')} disabled={isProcessing}>
                                        WiFi Performance
                                    </button>
                                    <button onClick={() => sendMessage('Give me a network health summary')} disabled={isProcessing}>
                                        Health Summary
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            }}
        </ChatEngine>
    );
}

// ============================================
// MAIN COMPONENT
// ============================================

export default function RouterOSView() {
    const { setHalState } = useOutletContext() || { setHalState: () => {} };
    const { currentOrg } = useWorkspace();
    const { licensed, loading: licenseLoading } = useRouterOSLicenseStatus();
    const { config, loading: configLoading, configured, saveConfig, clearConfig } = useRouterOSConfig(currentOrg?.id);

    // State
    const [routers, setRouters] = useState([]);
    const [selectedRouterId, setSelectedRouterId] = useState(null);
    const [activeTab, setActiveTab] = useState('dashboard');
    const [pendingQuery, setPendingQuery] = useState(null);
    const [showReconfigure, setShowReconfigure] = useState(false);

    // Modals
    const [selectedDevice, setSelectedDevice] = useState(null);
    const [selectedLease, setSelectedLease] = useState(null);
    const [showTroubleshoot, setShowTroubleshoot] = useState(false);

    // Load routers when configured
    useEffect(() => {
        if (configured) {
            getRouters().then(list => {
                setRouters(list);
                if (list.length > 0 && !selectedRouterId) {
                    setSelectedRouterId(list[0].id);
                }
            });
        }
    }, [configured]);

    // Get router data with auto-refresh
    const { data: routerData, loading, error, retryCount, refresh } = useRouterData(
        configured ? selectedRouterId : null,
        30000
    );

    // Handler for asking NETWATCH
    const handleAskNetwatch = useCallback((query) => {
        setPendingQuery(query);
        setActiveTab('netwatch');
    }, []);

    // Handler for troubleshoot wizard
    const handleStartTroubleshoot = useCallback((workflow) => {
        setShowTroubleshoot(true);
    }, []);

    // Handler for setup complete
    const handleSetupComplete = useCallback(async (newConfig) => {
        if (!currentOrg?.id) {
            console.error('[RouterOS] No organization context available — router config will NOT be persisted to the vault (localStorage cache only, password will not be saved).');
        }
        storeConfig({
            ...newConfig,
            configured: true,
            lastConnected: new Date().toISOString()
        }, currentOrg?.id);
        setShowReconfigure(false);
        // Reload to refresh config
        window.location.reload();
    }, [currentOrg?.id]);

    // Handler for reconfigure
    const handleReconfigure = useCallback(() => {
        setShowReconfigure(true);
    }, []);

    // Handler for cancel reconfigure
    const handleCancelReconfigure = useCallback(() => {
        setShowReconfigure(false);
    }, []);

    // Show loading while checking license/config
    if (licenseLoading || configLoading) {
        return (
            <div className="ros-view ros-view--loading">
                <div className="ros-loading">
                    <div className="ros-loading__spinner" />
                    <p>Loading...</p>
                </div>
            </div>
        );
    }

    // Show paywall if not licensed
    if (!licensed) {
        return (
            <div className="ros-view">
                <LicensePaywall />
            </div>
        );
    }

    // Show setup wizard if not configured or reconfiguring
    if (!configured || showReconfigure) {
        return (
            <div className="ros-view">
                {showReconfigure && (
                    <div className="ros-reconfigure-header">
                        <button onClick={handleCancelReconfigure} className="ros-reconfigure-cancel">
                            &larr; Back to Dashboard
                        </button>
                    </div>
                )}
                <RouterOSSetupWizard onComplete={handleSetupComplete} />
            </div>
        );
    }

    return (
        <div className="ros-view">
            {/* Connection Error Banner */}
            {error && (
                <ConnectionStatus
                    error={error}
                    retryCount={retryCount}
                    onRetry={refresh}
                    onSettings={handleReconfigure}
                />
            )}

            {/* Header */}
            <div className="ros-header">
                <div className="ros-header__left">
                    <h1 className="ros-header__title">
                        <RouterIcon />
                        RouterOS
                    </h1>
                    {routers.length > 0 && (
                        <RouterSelector
                            routers={routers}
                            selectedId={selectedRouterId}
                            onSelect={setSelectedRouterId}
                        />
                    )}
                </div>

                <div className="ros-header__right">
                    {/* Tab Switcher */}
                    <div className="ros-tabs">
                        <button
                            className={`ros-tab ${activeTab === 'dashboard' ? 'ros-tab--active' : ''}`}
                            onClick={() => setActiveTab('dashboard')}
                        >
                            <DashboardIcon />
                            <span>Dashboard</span>
                        </button>
                        <button
                            className={`ros-tab ${activeTab === 'netwatch' ? 'ros-tab--active' : ''}`}
                            onClick={() => setActiveTab('netwatch')}
                        >
                            <NetwatchIcon />
                            <span>NETWATCH</span>
                        </button>
                    </div>

                    {/* Settings Button */}
                    <button
                        className="ros-settings-btn"
                        onClick={handleReconfigure}
                        title="Router Settings"
                    >
                        <SettingsIcon />
                    </button>
                </div>
            </div>

            {/* Tab Content */}
            <div className="ros-content">
                {activeTab === 'dashboard' ? (
                    <DashboardTab
                        routerData={routerData}
                        loading={loading}
                        onAskNetwatch={handleAskNetwatch}
                        onSelectDevice={setSelectedDevice}
                        onSelectLease={setSelectedLease}
                        onStartTroubleshoot={handleStartTroubleshoot}
                    />
                ) : (
                    <NetwatchTab
                        routerData={routerData}
                        pendingQuery={pendingQuery}
                        onQueryConsumed={() => setPendingQuery(null)}
                        setHalState={setHalState}
                    />
                )}
            </div>

            {/* Modals */}
            {selectedDevice && (
                <DeviceDetailModal
                    device={selectedDevice}
                    routerId={selectedRouterId}
                    onClose={() => setSelectedDevice(null)}
                    onAskNetwatch={handleAskNetwatch}
                />
            )}

            {selectedLease && (
                <LeaseActionModal
                    lease={selectedLease}
                    routerId={selectedRouterId}
                    onClose={() => setSelectedLease(null)}
                />
            )}

            {showTroubleshoot && (
                <TroubleshootWizardModal
                    routerId={selectedRouterId}
                    routerData={routerData}
                    onClose={() => setShowTroubleshoot(false)}
                    onAskNetwatch={handleAskNetwatch}
                />
            )}
        </div>
    );
}

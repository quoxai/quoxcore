/**
 * QuickActionsPanel - Action Buttons
 *
 * Displays:
 * - Common quick action buttons
 * - Links to troubleshooting wizard
 * - Ask NETWATCH shortcuts
 */

import './routeros.css';

// Icons
const ZapIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
);

const ChatIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
);

const WifiIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
        <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
    </svg>
);

const TroubleshootIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.3-4.3"/>
        <path d="M11 8v6"/>
        <path d="M8 11h6"/>
    </svg>
);

const RefreshIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="23 4 23 10 17 10"/>
        <polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
);

const SpeedIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2v4"/>
        <path d="m4.93 4.93 2.83 2.83"/>
        <path d="M2 12h4"/>
        <path d="m4.93 19.07 2.83-2.83"/>
        <path d="M12 18v4"/>
        <path d="m16.24 16.24 2.83 2.83"/>
        <path d="M18 12h4"/>
        <path d="m16.24 7.76 2.83-2.83"/>
        <circle cx="12" cy="12" r="4"/>
    </svg>
);

export default function QuickActionsPanel({ onAskNetwatch, onStartTroubleshoot }) {
    return (
        <div className="ros-panel">
            <div className="ros-panel__header">
                <h3 className="ros-panel__title">
                    <ZapIcon />
                    Quick Actions
                </h3>
            </div>
            <div className="ros-panel__body">
                <div className="ros-actions__grid">
                    <button
                        className="ros-action"
                        onClick={() => onAskNetwatch("What devices are currently connected to my network?")}
                    >
                        <ChatIcon />
                        List Devices
                    </button>
                    <button
                        className="ros-action"
                        onClick={() => onAskNetwatch("Check my WiFi performance and suggest improvements")}
                    >
                        <WifiIcon />
                        Check WiFi
                    </button>
                    <button
                        className="ros-action"
                        onClick={() => onStartTroubleshoot?.('speed')}
                    >
                        <TroubleshootIcon />
                        Troubleshoot
                    </button>
                    <button
                        className="ros-action"
                        onClick={() => onAskNetwatch("Run a speed test and analyze my connection quality")}
                    >
                        <SpeedIcon />
                        Speed Test
                    </button>
                </div>
            </div>
        </div>
    );
}

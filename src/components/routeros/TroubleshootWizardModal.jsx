/**
 * TroubleshootWizardModal - Guided Diagnostic Flow
 *
 * Workflows:
 * - "My internet is slow" workflow
 * - "I can't connect" workflow
 * - Step-by-step progress
 * - Results with explanations
 */

import { useState } from 'react';
import './routeros.css';

// Icons
const WizardIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.3-4.3"/>
        <path d="M11 8v6"/>
        <path d="M8 11h6"/>
    </svg>
);

const CloseIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
);

const SpeedIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2v4"/>
        <path d="m4.93 4.93 2.83 2.83"/>
        <path d="M2 12h4"/>
        <path d="M12 18v4"/>
        <circle cx="12" cy="12" r="4"/>
    </svg>
);

const WifiOffIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9"/>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
    </svg>
);

const DeviceIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
);

const CheckIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="20 6 9 17 4 12"/>
    </svg>
);

const LoaderIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
);

const WORKFLOWS = {
    start: {
        title: 'What issue are you experiencing?',
        description: "Let's diagnose the problem step by step.",
        options: [
            { id: 'slow', icon: SpeedIcon, title: 'My internet is slow', desc: 'Websites load slowly, videos buffer' },
            { id: 'connect', icon: WifiOffIcon, title: "I can't connect", desc: 'Unable to connect to the internet' },
            { id: 'device', icon: DeviceIcon, title: 'Device not showing', desc: 'A device is not appearing on the network' }
        ]
    },
    slow: {
        steps: [
            { id: 'speedtest', title: 'Running speed test...', duration: 2000 },
            { id: 'checkload', title: 'Checking network load...', duration: 1500 },
            { id: 'analyze', title: 'Analyzing traffic patterns...', duration: 1800 }
        ],
        results: {
            title: 'Speed Analysis Complete',
            findings: [
                { status: 'warning', text: 'Download speed is 45% below expected' },
                { status: 'info', text: '3 devices are streaming video' },
                { status: 'good', text: 'No packet loss detected' }
            ],
            recommendation: 'Your Smart TV and 2 phones are currently streaming, using most of your bandwidth. Consider upgrading to a faster plan or pausing some streams.'
        }
    },
    connect: {
        steps: [
            { id: 'pinggateway', title: 'Checking gateway connection...', duration: 1500 },
            { id: 'dns', title: 'Testing DNS resolution...', duration: 1800 },
            { id: 'internet', title: 'Testing internet connectivity...', duration: 2000 }
        ],
        results: {
            title: 'Connection Test Complete',
            findings: [
                { status: 'good', text: 'Gateway is reachable' },
                { status: 'good', text: 'DNS is working' },
                { status: 'good', text: 'Internet connection active' }
            ],
            recommendation: 'Your router has a healthy connection to the internet. The issue may be with a specific device or application.'
        }
    },
    device: {
        steps: [
            { id: 'scan', title: 'Scanning network...', duration: 2000 },
            { id: 'arp', title: 'Checking ARP table...', duration: 1500 },
            { id: 'dhcp', title: 'Reviewing DHCP leases...', duration: 1200 }
        ],
        results: {
            title: 'Device Scan Complete',
            findings: [
                { status: 'info', text: '6 devices currently connected' },
                { status: 'info', text: 'DHCP pool has 108 addresses available' },
                { status: 'good', text: 'No IP conflicts detected' }
            ],
            recommendation: "All detected devices are listed in your device inventory. If your device isn't showing, try: 1) Restart the device, 2) Forget and reconnect to WiFi, 3) Check if the device is in airplane mode."
        }
    }
};

export default function TroubleshootWizardModal({ routerId, routerData, onClose, onAskNetwatch }) {
    const [currentStep, setCurrentStep] = useState('start');
    const [workflow, setWorkflow] = useState(null);
    const [stepIndex, setStepIndex] = useState(0);
    const [isRunning, setIsRunning] = useState(false);
    const [showResults, setShowResults] = useState(false);

    const handleSelectWorkflow = async (workflowId) => {
        const wf = WORKFLOWS[workflowId];
        if (!wf?.steps) return;

        setWorkflow(wf);
        setCurrentStep(workflowId);
        setIsRunning(true);
        setStepIndex(0);

        // Simulate running through steps
        for (let i = 0; i < wf.steps.length; i++) {
            setStepIndex(i);
            await new Promise(resolve => setTimeout(resolve, wf.steps[i].duration));
        }

        setIsRunning(false);
        setShowResults(true);
    };

    const handleAskNetwatch = () => {
        const wf = workflow;
        if (wf?.results) {
            onAskNetwatch(`I ran the troubleshoot wizard and got these results: ${wf.results.recommendation}. Can you help me fix this?`);
        }
        onClose();
    };

    const renderStart = () => (
        <div className="ros-wizard__content">
            <div className="ros-wizard__icon">
                <WizardIcon />
            </div>
            <h3 className="ros-wizard__title">{WORKFLOWS.start.title}</h3>
            <p className="ros-wizard__desc">{WORKFLOWS.start.description}</p>
            <div className="ros-wizard__options">
                {WORKFLOWS.start.options.map(option => (
                    <button
                        key={option.id}
                        className="ros-wizard__option"
                        onClick={() => handleSelectWorkflow(option.id)}
                    >
                        <div className="ros-wizard__option-icon">
                            <option.icon />
                        </div>
                        <div className="ros-wizard__option-text">
                            <div className="ros-wizard__option-title">{option.title}</div>
                            <div className="ros-wizard__option-desc">{option.desc}</div>
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );

    const renderRunning = () => (
        <div className="ros-wizard__content">
            {/* Progress Steps */}
            <div className="ros-wizard__steps">
                {workflow.steps.map((step, i) => (
                    <div
                        key={step.id}
                        className={`ros-wizard__step ${i < stepIndex ? 'completed' : ''} ${i === stepIndex ? 'active' : ''}`}
                    />
                ))}
            </div>

            <div className="ros-wizard__icon" style={{ animation: 'ros-spin 1s linear infinite' }}>
                <LoaderIcon />
            </div>
            <h3 className="ros-wizard__title">{workflow.steps[stepIndex]?.title}</h3>
            <p className="ros-wizard__desc">Please wait while we diagnose the issue...</p>
        </div>
    );

    const renderResults = () => (
        <div className="ros-wizard__content">
            {/* Progress Steps - All Complete */}
            <div className="ros-wizard__steps">
                {workflow.steps.map((step, i) => (
                    <div key={step.id} className="ros-wizard__step completed" />
                ))}
            </div>

            <div className="ros-wizard__icon" style={{ background: 'rgba(16, 185, 129, 0.2)' }}>
                <CheckIcon />
            </div>
            <h3 className="ros-wizard__title">{workflow.results.title}</h3>

            <div style={{ textAlign: 'left', marginTop: '24px' }}>
                {workflow.results.findings.map((finding, i) => (
                    <div key={i} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '12px 16px',
                        background: finding.status === 'warning' ? 'rgba(245, 158, 11, 0.1)' :
                                   finding.status === 'good' ? 'rgba(16, 185, 129, 0.1)' :
                                   'rgba(56, 189, 248, 0.1)',
                        borderRadius: '8px',
                        marginBottom: '8px',
                        color: 'var(--m-text-primary)',
                        fontSize: '14px'
                    }}>
                        <span style={{
                            color: finding.status === 'warning' ? '#f59e0b' :
                                   finding.status === 'good' ? '#10b981' : '#38bdf8',
                            fontSize: '18px'
                        }}>
                            {finding.status === 'warning' ? '!' : finding.status === 'good' ? '✓' : 'i'}
                        </span>
                        {finding.text}
                    </div>
                ))}

                <div style={{
                    marginTop: '20px',
                    padding: '16px',
                    background: 'rgba(16, 185, 129, 0.05)',
                    border: '1px solid rgba(16, 185, 129, 0.2)',
                    borderRadius: '12px'
                }}>
                    <div style={{
                        fontSize: '12px',
                        color: '#10b981',
                        fontWeight: '600',
                        textTransform: 'uppercase',
                        marginBottom: '8px'
                    }}>
                        Recommendation
                    </div>
                    <div style={{ color: 'var(--m-text-secondary)', lineHeight: '1.5' }}>
                        {workflow.results.recommendation}
                    </div>
                </div>
            </div>
        </div>
    );

    return (
        <div className="ros-modal">
            <div className="ros-modal__backdrop" onClick={onClose} />
            <div className="ros-modal__content" style={{ maxWidth: '600px' }}>
                <div className="ros-modal__header">
                    <h2 className="ros-modal__title">
                        <WizardIcon />
                        Troubleshoot
                    </h2>
                    <button className="ros-modal__close" onClick={onClose}>
                        <CloseIcon />
                    </button>
                </div>

                <div className="ros-modal__body">
                    {currentStep === 'start' && renderStart()}
                    {isRunning && renderRunning()}
                    {showResults && renderResults()}
                </div>

                {showResults && (
                    <div className="ros-modal__footer">
                        <button
                            className="ros-modal__btn"
                            onClick={() => {
                                setCurrentStep('start');
                                setWorkflow(null);
                                setShowResults(false);
                            }}
                        >
                            Start Over
                        </button>
                        <button
                            className="ros-modal__btn"
                            onClick={handleAskNetwatch}
                        >
                            Ask NETWATCH for Help
                        </button>
                        <button
                            className="ros-modal__btn ros-modal__btn--primary"
                            onClick={onClose}
                        >
                            Done
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

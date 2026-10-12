/**
 * RouterOS Setup Wizard
 *
 * Multi-step wizard for configuring MikroTik router API access.
 * Guides users through:
 * 1. Introduction
 * 2. Enable REST API instructions
 * 3. Create API user (optional)
 * 4. Enter credentials
 * 5. Test connection
 */

import { useState, useCallback } from 'react';
import { testConnection } from '../../services/routerosClient';
import './RouterOSSetupWizard.css';

// ============================================
// ICONS
// ============================================

const RouterIcon = () => (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="5" r="3"/>
        <circle cx="5" cy="19" r="3"/>
        <circle cx="19" cy="19" r="3"/>
        <path d="M12 8v4M8.5 14.5L12 12l3.5 2.5"/>
    </svg>
);

const CheckIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <polyline points="20 6 9 17 4 12"/>
    </svg>
);

const ArrowRightIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="5" y1="12" x2="19" y2="12"/>
        <polyline points="12 5 19 12 12 19"/>
    </svg>
);

const ArrowLeftIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="19" y1="12" x2="5" y2="12"/>
        <polyline points="12 19 5 12 12 5"/>
    </svg>
);

const TerminalIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="4 17 10 11 4 5"/>
        <line x1="12" y1="19" x2="20" y2="19"/>
    </svg>
);

const SettingsIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
);

const UserIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
    </svg>
);

const KeyIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
    </svg>
);

const SpinnerIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ros-wizard__spinner">
        <circle cx="12" cy="12" r="10" opacity="0.25"/>
        <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"/>
    </svg>
);

const AlertIcon = () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
);

const CopyIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
);

// ============================================
// STEP COMPONENTS
// ============================================

function StepIntro({ onNext }) {
    return (
        <div className="ros-wizard__step ros-wizard__step--intro">
            <div className="ros-wizard__icon">
                <RouterIcon />
            </div>
            <h2>RouterOS Manager</h2>
            <p className="ros-wizard__subtitle">
                Connect QUOX to your MikroTik router for real-time monitoring and AI-powered troubleshooting.
            </p>

            <div className="ros-wizard__features">
                <div className="ros-wizard__feature">
                    <CheckIcon />
                    <span>Real-time health monitoring</span>
                </div>
                <div className="ros-wizard__feature">
                    <CheckIcon />
                    <span>Connected device inventory</span>
                </div>
                <div className="ros-wizard__feature">
                    <CheckIcon />
                    <span>DHCP & VPN status</span>
                </div>
                <div className="ros-wizard__feature">
                    <CheckIcon />
                    <span>Plain English alerts</span>
                </div>
                <div className="ros-wizard__feature">
                    <CheckIcon />
                    <span>NETWATCH AI assistant</span>
                </div>
            </div>

            <div className="ros-wizard__requirements">
                <h4>Requirements</h4>
                <ul>
                    <li>MikroTik router running <strong>RouterOS 7.1</strong> or newer</li>
                    <li>REST API enabled on the router</li>
                    <li>Network access to the router from this device</li>
                </ul>
            </div>

            <button className="ros-wizard__btn ros-wizard__btn--primary" onClick={onNext}>
                Let's Get Started
                <ArrowRightIcon />
            </button>
        </div>
    );
}

function StepEnableAPI({ onNext, onBack }) {
    const [copiedCmd, setCopiedCmd] = useState(null);

    const copyCommand = useCallback((cmd, id) => {
        navigator.clipboard.writeText(cmd);
        setCopiedCmd(id);
        setTimeout(() => setCopiedCmd(null), 2000);
    }, []);

    return (
        <div className="ros-wizard__step ros-wizard__step--api">
            <div className="ros-wizard__step-header">
                <SettingsIcon />
                <h2>Enable REST API</h2>
            </div>
            <p>The REST API allows QUOX to communicate with your router. Here's how to enable it:</p>

            <div className="ros-wizard__methods">
                <div className="ros-wizard__method">
                    <h4>
                        <SettingsIcon />
                        Option A: Via Winbox or WebFig
                    </h4>
                    <ol>
                        <li>Open Winbox and connect to your router</li>
                        <li>Navigate to <strong>IP → Services</strong></li>
                        <li>Find <strong>www-ssl</strong> (HTTPS) and enable it</li>
                        <li>Default port is <strong>443</strong></li>
                    </ol>
                </div>

                <div className="ros-wizard__divider">or</div>

                <div className="ros-wizard__method">
                    <h4>
                        <TerminalIcon />
                        Option B: Via Terminal/SSH
                    </h4>

                    <div className="ros-wizard__version-label">RouterOS 7.x:</div>
                    <div className="ros-wizard__code">
                        <code>/ip/service/enable www-ssl</code>
                        <button
                            className="ros-wizard__copy"
                            onClick={() => copyCommand('/ip/service/enable www-ssl', 'ros7')}
                            title="Copy to clipboard"
                        >
                            {copiedCmd === 'ros7' ? <CheckIcon /> : <CopyIcon />}
                        </button>
                    </div>

                    <div className="ros-wizard__version-label">RouterOS 6.x:</div>
                    <div className="ros-wizard__code">
                        <code>/ip service enable www-ssl</code>
                        <button
                            className="ros-wizard__copy"
                            onClick={() => copyCommand('/ip service enable www-ssl', 'ros6')}
                            title="Copy to clipboard"
                        >
                            {copiedCmd === 'ros6' ? <CheckIcon /> : <CopyIcon />}
                        </button>
                    </div>
                </div>
            </div>

            <div className="ros-wizard__tip">
                <AlertIcon />
                <div>
                    <strong>Security Tip:</strong> We recommend using HTTPS (www-ssl) for encrypted communication.
                    HTTP is also supported but sends credentials in plain text.
                </div>
            </div>

            <div className="ros-wizard__actions">
                <button className="ros-wizard__btn ros-wizard__btn--secondary" onClick={onBack}>
                    <ArrowLeftIcon />
                    Back
                </button>
                <button className="ros-wizard__btn ros-wizard__btn--primary" onClick={onNext}>
                    I've Enabled the API
                    <ArrowRightIcon />
                </button>
            </div>
        </div>
    );
}

function StepCreateUser({ onNext, onBack }) {
    const [copiedCmd, setCopiedCmd] = useState(null);

    const copyCommand = useCallback((cmd, id) => {
        navigator.clipboard.writeText(cmd);
        setCopiedCmd(id);
        setTimeout(() => setCopiedCmd(null), 2000);
    }, []);

    return (
        <div className="ros-wizard__step ros-wizard__step--user">
            <div className="ros-wizard__step-header">
                <UserIcon />
                <h2>Create API User (Recommended)</h2>
            </div>
            <p>For security, we recommend creating a dedicated user for QUOX instead of using admin credentials.</p>

            <div className="ros-wizard__method">
                <h4>
                    <TerminalIcon />
                    Via Terminal/SSH
                </h4>

                <div className="ros-wizard__version-label">RouterOS 7.x:</div>
                <div className="ros-wizard__code ros-wizard__code--multi">
                    <code>/user add name=quox-api group=read password=YOUR_SECURE_PASSWORD</code>
                    <button
                        className="ros-wizard__copy"
                        onClick={() => copyCommand('/user add name=quox-api group=read password=YOUR_SECURE_PASSWORD', 'ros7')}
                        title="Copy to clipboard"
                    >
                        {copiedCmd === 'ros7' ? <CheckIcon /> : <CopyIcon />}
                    </button>
                </div>

                <div className="ros-wizard__version-label">RouterOS 6.x:</div>
                <div className="ros-wizard__code ros-wizard__code--multi">
                    <code>/user add name=quox-api group=read password=YOUR_SECURE_PASSWORD</code>
                    <button
                        className="ros-wizard__copy"
                        onClick={() => copyCommand('/user add name=quox-api group=read password=YOUR_SECURE_PASSWORD', 'ros6')}
                        title="Copy to clipboard"
                    >
                        {copiedCmd === 'ros6' ? <CheckIcon /> : <CopyIcon />}
                    </button>
                </div>

                <p className="ros-wizard__code-note">
                    Replace <code>YOUR_SECURE_PASSWORD</code> with a strong password.
                </p>
            </div>

            <div className="ros-wizard__info-box">
                <h4>User Groups</h4>
                <div className="ros-wizard__groups">
                    <div className="ros-wizard__group">
                        <strong>read</strong>
                        <span>Monitor only - can view but not change settings</span>
                    </div>
                    <div className="ros-wizard__group">
                        <strong>full</strong>
                        <span>Full access - can view and modify router settings</span>
                    </div>
                </div>
                <p>The <strong>read</strong> group is sufficient for monitoring. Use <strong>full</strong> only if you want QUOX to make changes.</p>
            </div>

            <div className="ros-wizard__actions">
                <button className="ros-wizard__btn ros-wizard__btn--secondary" onClick={onBack}>
                    <ArrowLeftIcon />
                    Back
                </button>
                <button className="ros-wizard__btn ros-wizard__btn--text" onClick={onNext}>
                    Skip - Use Existing User
                </button>
                <button className="ros-wizard__btn ros-wizard__btn--primary" onClick={onNext}>
                    Continue
                    <ArrowRightIcon />
                </button>
            </div>
        </div>
    );
}

function StepCredentials({ config, setConfig, onNext, onBack, error }) {
    const handleChange = (field, value) => {
        setConfig(prev => ({ ...prev, [field]: value }));
    };

    return (
        <div className="ros-wizard__step ros-wizard__step--credentials">
            <div className="ros-wizard__step-header">
                <KeyIcon />
                <h2>Router Credentials</h2>
            </div>
            <p>Enter the connection details for your MikroTik router.</p>

            {error && (
                <div className="ros-wizard__error">
                    <AlertIcon />
                    <span>{error}</span>
                </div>
            )}

            <div className="ros-wizard__form">
                <div className="ros-wizard__field">
                    <label>Router Address <span>*</span></label>
                    <input
                        type="text"
                        value={config.address || ''}
                        onChange={(e) => handleChange('address', e.target.value)}
                        placeholder="10.0.0.1"
                    />
                    <span className="ros-wizard__hint">IP address or hostname of your MikroTik router</span>
                </div>

                <div className="ros-wizard__row">
                    <div className="ros-wizard__field">
                        <label>Port</label>
                        <input
                            type="number"
                            value={config.port || 443}
                            onChange={(e) => handleChange('port', parseInt(e.target.value) || 443)}
                            placeholder="443"
                        />
                        <span className="ros-wizard__hint">Default: 443 (HTTPS) or 80 (HTTP)</span>
                    </div>

                    <div className="ros-wizard__field ros-wizard__field--checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={config.useSSL !== false}
                                onChange={(e) => handleChange('useSSL', e.target.checked)}
                            />
                            Use HTTPS (recommended)
                        </label>
                    </div>
                </div>

                <div className="ros-wizard__field">
                    <label>Username <span>*</span></label>
                    <input
                        type="text"
                        value={config.username || ''}
                        onChange={(e) => handleChange('username', e.target.value)}
                        placeholder="quox-api"
                    />
                </div>

                <div className="ros-wizard__field">
                    <label>Password <span>*</span></label>
                    <input
                        type="password"
                        value={config.password || ''}
                        onChange={(e) => handleChange('password', e.target.value)}
                        placeholder="Enter password"
                    />
                </div>

                <div className="ros-wizard__field">
                    <label>Display Name</label>
                    <input
                        type="text"
                        value={config.name || ''}
                        onChange={(e) => handleChange('name', e.target.value)}
                        placeholder="Main Router"
                    />
                    <span className="ros-wizard__hint">A friendly name for this router (shown in the dashboard)</span>
                </div>
            </div>

            <div className="ros-wizard__actions">
                <button className="ros-wizard__btn ros-wizard__btn--secondary" onClick={onBack}>
                    <ArrowLeftIcon />
                    Back
                </button>
                <button
                    className="ros-wizard__btn ros-wizard__btn--primary"
                    onClick={onNext}
                    disabled={!config.address || !config.username || !config.password}
                >
                    Test Connection
                    <ArrowRightIcon />
                </button>
            </div>
        </div>
    );
}

function StepTest({ config, testing, testResult, onTest, onBack, onComplete }) {
    return (
        <div className="ros-wizard__step ros-wizard__step--test">
            <div className="ros-wizard__step-header">
                <RouterIcon />
                <h2>Test Connection</h2>
            </div>

            {testing ? (
                <div className="ros-wizard__testing">
                    <SpinnerIcon />
                    <p>Connecting to {config.address}...</p>
                </div>
            ) : testResult?.success ? (
                <div className="ros-wizard__success">
                    <div className="ros-wizard__success-icon">
                        <CheckIcon />
                    </div>
                    <h3>Connection Successful!</h3>
                    <div className="ros-wizard__router-info">
                        <div className="ros-wizard__router-detail">
                            <span>Router</span>
                            <strong>{testResult.data.boardName}</strong>
                        </div>
                        <div className="ros-wizard__router-detail">
                            <span>RouterOS Version</span>
                            <strong>{testResult.data.version}</strong>
                        </div>
                        <div className="ros-wizard__router-detail">
                            <span>Uptime</span>
                            <strong>{testResult.data.uptime}</strong>
                        </div>
                        <div className="ros-wizard__router-detail">
                            <span>CPU Load</span>
                            <strong>{testResult.data.cpuLoad}%</strong>
                        </div>
                    </div>
                </div>
            ) : testResult ? (
                <div className="ros-wizard__failure">
                    <div className="ros-wizard__failure-icon">
                        <AlertIcon />
                    </div>
                    <h3>Connection Failed</h3>
                    <p className="ros-wizard__failure-msg">{testResult.error}</p>
                    {testResult.technical && testResult.technical !== testResult.error && (
                        <details className="ros-wizard__technical">
                            <summary>Technical Details</summary>
                            <code>{testResult.technical}</code>
                        </details>
                    )}

                    {/* Context-specific troubleshooting based on error code */}
                    {testResult.code === 'API_NOT_ENABLED' && (
                        <div className="ros-wizard__troubleshoot">
                            <h4>REST API Not Found</h4>
                            <p>The router responded but REST API isn't available. This usually means:</p>
                            <ul>
                                <li><strong>RouterOS version too old</strong> — REST API requires RouterOS 7.1 or newer</li>
                                <li><strong>Web service not enabled</strong> — The www or www-ssl service needs to be running</li>
                            </ul>
                            <div className="ros-wizard__fix-section">
                                <h5>Check your RouterOS version:</h5>
                                <div className="ros-wizard__code">
                                    <code>/system resource print</code>
                                </div>
                                <p className="ros-wizard__code-note">Look for <code>version</code> — must be 7.1 or higher</p>
                            </div>
                            <div className="ros-wizard__fix-section">
                                <h5>If version is 7.1+, enable the web service:</h5>
                                <div className="ros-wizard__version-label">RouterOS 7.x:</div>
                                <div className="ros-wizard__code">
                                    <code>/ip/service/enable www-ssl</code>
                                </div>
                                <div className="ros-wizard__version-label">RouterOS 6.x:</div>
                                <div className="ros-wizard__code">
                                    <code>/ip service enable www-ssl</code>
                                </div>
                            </div>
                        </div>
                    )}

                    {testResult.code === 'CERT_ERROR' && (
                        <div className="ros-wizard__troubleshoot">
                            <h4>SSL/TLS Connection Failed</h4>
                            <p>The router rejected the secure connection. Common causes:</p>
                            <ul>
                                <li><strong>www-ssl service not running</strong> — Enable it in IP → Services</li>
                                <li><strong>No SSL certificate configured</strong> — Router needs a certificate</li>
                                <li><strong>Older TLS version</strong> — Router may use outdated encryption</li>
                            </ul>
                            <div className="ros-wizard__fix-section">
                                <h5>Quick Fix: Try HTTP instead</h5>
                                <p>Go back and change your settings:</p>
                                <ul>
                                    <li>Uncheck <strong>"Use HTTPS"</strong></li>
                                    <li>Change port to <strong>80</strong></li>
                                </ul>
                            </div>
                            <div className="ros-wizard__fix-section">
                                <h5>Or enable www-ssl on your router:</h5>
                                <div className="ros-wizard__version-label">RouterOS 7.x:</div>
                                <div className="ros-wizard__code">
                                    <code>/ip/service/enable www-ssl</code>
                                </div>
                                <div className="ros-wizard__version-label">RouterOS 6.x:</div>
                                <div className="ros-wizard__code">
                                    <code>/ip service enable www-ssl</code>
                                </div>
                            </div>
                        </div>
                    )}

                    {testResult.code === 'ECONNREFUSED' && (
                        <div className="ros-wizard__troubleshoot">
                            <h4>Can't Reach Router</h4>
                            <p>No response from the router at this address.</p>
                            <ul>
                                <li>Double-check the IP address: <strong>{config.address}</strong></li>
                                <li>Make sure you're on the same network as the router</li>
                                <li>Try pinging the router: <code>ping {config.address}</code></li>
                                <li>Check if a firewall is blocking the connection</li>
                            </ul>
                        </div>
                    )}

                    {testResult.code === 'ETIMEDOUT' && (
                        <div className="ros-wizard__troubleshoot">
                            <h4>Connection Timed Out</h4>
                            <p>Router didn't respond in time.</p>
                            <ul>
                                <li>Verify you're on the same network as the router</li>
                                <li>Check if the router is powered on and accessible</li>
                                <li>Try accessing the router's web interface directly</li>
                            </ul>
                        </div>
                    )}

                    {testResult.status === 401 && (
                        <div className="ros-wizard__troubleshoot">
                            <h4>Authentication Failed</h4>
                            <p>The username or password is incorrect.</p>
                            <ul>
                                <li>Double-check your credentials</li>
                                <li>Try logging into the router's web interface with the same credentials</li>
                                <li>If using a new API user, verify it was created successfully</li>
                            </ul>
                        </div>
                    )}

                    {/* Generic fallback for unknown errors */}
                    {!testResult.code && testResult.status !== 401 && (
                        <div className="ros-wizard__troubleshoot">
                            <h4>Troubleshooting Tips</h4>
                            <ul>
                                <li>Verify the router IP address is correct</li>
                                <li>REST API requires <strong>RouterOS 7.1 or newer</strong></li>
                                <li>Enable www-ssl service: <code>/ip/service/enable www-ssl</code></li>
                                <li>If HTTPS fails, try HTTP (port 80)</li>
                            </ul>
                        </div>
                    )}
                </div>
            ) : (
                <div className="ros-wizard__ready">
                    <p>Ready to test connection to <strong>{config.address}</strong></p>
                    <div className="ros-wizard__config-summary">
                        <div><span>Address:</span> {config.address}:{config.port}</div>
                        <div><span>Protocol:</span> {config.useSSL !== false ? 'HTTPS' : 'HTTP'}</div>
                        <div><span>Username:</span> {config.username}</div>
                    </div>
                </div>
            )}

            <div className="ros-wizard__actions">
                <button className="ros-wizard__btn ros-wizard__btn--secondary" onClick={onBack}>
                    <ArrowLeftIcon />
                    Back
                </button>
                {testResult?.success ? (
                    <button className="ros-wizard__btn ros-wizard__btn--primary" onClick={onComplete}>
                        Save & Open Dashboard
                        <ArrowRightIcon />
                    </button>
                ) : (
                    <button
                        className="ros-wizard__btn ros-wizard__btn--primary"
                        onClick={onTest}
                        disabled={testing}
                    >
                        {testing ? (
                            <>
                                <SpinnerIcon />
                                Testing...
                            </>
                        ) : testResult ? (
                            'Try Again'
                        ) : (
                            'Test Connection'
                        )}
                    </button>
                )}
            </div>
        </div>
    );
}

// ============================================
// MAIN WIZARD COMPONENT
// ============================================

export default function RouterOSSetupWizard({ onComplete }) {
    const [step, setStep] = useState(0);
    const [config, setConfig] = useState({
        address: '',
        port: 443,
        useSSL: true,
        username: '',
        password: '',
        name: ''
    });
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState(null);
    const [error, setError] = useState(null);

    const steps = [
        { key: 'intro', label: 'Welcome' },
        { key: 'api', label: 'Enable API' },
        { key: 'user', label: 'Create User' },
        { key: 'credentials', label: 'Credentials' },
        { key: 'test', label: 'Connect' }
    ];

    const handleTest = useCallback(async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const result = await testConnection(config);
            setTestResult(result);
        } catch (err) {
            setTestResult({
                success: false,
                error: err.message || 'Connection test failed'
            });
        } finally {
            setTesting(false);
        }
    }, [config]);

    const handleComplete = useCallback(() => {
        onComplete({
            ...config,
            id: `router-${Date.now()}`,
            model: testResult?.data?.boardName,
            version: testResult?.data?.version
        });
    }, [config, testResult, onComplete]);

    const handleNext = useCallback(() => {
        setError(null);
        if (step === 3) {
            // Validate credentials before proceeding
            if (!config.address || !config.username || !config.password) {
                setError('Please fill in all required fields');
                return;
            }
        }
        setStep(s => Math.min(s + 1, steps.length - 1));
    }, [step, config, steps.length]);

    const handleBack = useCallback(() => {
        setError(null);
        setTestResult(null);
        setStep(s => Math.max(s - 1, 0));
    }, []);

    return (
        <div className="ros-wizard">
            {/* Progress indicator */}
            <div className="ros-wizard__progress">
                {steps.map((s, i) => (
                    <div
                        key={s.key}
                        className={`ros-wizard__progress-step ${i === step ? 'active' : ''} ${i < step ? 'complete' : ''}`}
                    >
                        <div className="ros-wizard__progress-dot">
                            {i < step ? <CheckIcon /> : i + 1}
                        </div>
                        <span>{s.label}</span>
                    </div>
                ))}
            </div>

            {/* Step content */}
            <div className="ros-wizard__content">
                {step === 0 && <StepIntro onNext={handleNext} />}
                {step === 1 && <StepEnableAPI onNext={handleNext} onBack={handleBack} />}
                {step === 2 && <StepCreateUser onNext={handleNext} onBack={handleBack} />}
                {step === 3 && (
                    <StepCredentials
                        config={config}
                        setConfig={setConfig}
                        onNext={handleNext}
                        onBack={handleBack}
                        error={error}
                    />
                )}
                {step === 4 && (
                    <StepTest
                        config={config}
                        testing={testing}
                        testResult={testResult}
                        onTest={handleTest}
                        onBack={handleBack}
                        onComplete={handleComplete}
                    />
                )}
            </div>
        </div>
    );
}

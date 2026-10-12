/**
 * Welcome Step - System check and introduction
 *
 * IMPORTANT:
 * - Core setup requires auth + database + qdrant.
 * - Tasks and QuoxFlow power Objectives, Mission Control, Agentic Teams,
 *   Workflow Builder, approvals, and policies.
 * The wizard should surface both, rather than pretending the smaller core
 * shell is the full platform.
 *
 * This step provides platform-specific guidance for getting Docker
 * services running, without auto-installing anything.
 *
 * Also offers "Restore from Backup" for disaster recovery on fresh instances.
 */

import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

// Detect user's platform for appropriate instructions
function detectPlatform() {
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('mac')) return 'macos'
    if (ua.includes('win')) return 'windows'
    if (ua.includes('linux')) {
        // Try to detect distro from user agent or assume generic Linux
        if (ua.includes('ubuntu')) return 'ubuntu'
        if (ua.includes('debian')) return 'debian'
        if (ua.includes('fedora')) return 'fedora'
        if (ua.includes('rhel') || ua.includes('centos')) return 'rhel'
        return 'linux'
    }
    return 'linux' // Default fallback
}

// Get platform-specific Docker install instructions
function getDockerInstallInfo(platform) {
    switch (platform) {
        case 'macos':
            return {
                name: 'macOS',
                instructions: 'Download and install Docker Desktop for Mac',
                link: 'https://docs.docker.com/desktop/install/mac-install/',
                linkText: 'Get Docker Desktop',
                command: null
            }
        case 'windows':
            return {
                name: 'Windows',
                instructions: 'Download and install Docker Desktop for Windows',
                link: 'https://docs.docker.com/desktop/install/windows-install/',
                linkText: 'Get Docker Desktop',
                command: null
            }
        case 'ubuntu':
        case 'debian':
            return {
                name: platform === 'ubuntu' ? 'Ubuntu' : 'Debian',
                instructions: 'Install Docker with:',
                command: 'curl -fsSL https://get.docker.com | sh',
                postCommand: 'sudo usermod -aG docker $USER && newgrp docker'
            }
        case 'fedora':
        case 'rhel':
            return {
                name: platform === 'fedora' ? 'Fedora' : 'RHEL/CentOS',
                instructions: 'Install Docker with:',
                command: 'sudo dnf install -y docker docker-compose && sudo systemctl enable --now docker',
                postCommand: 'sudo usermod -aG docker $USER && newgrp docker'
            }
        default:
            return {
                name: 'Linux',
                instructions: 'Install Docker with:',
                command: 'curl -fsSL https://get.docker.com | sh',
                postCommand: 'sudo usermod -aG docker $USER && newgrp docker',
                link: 'https://docs.docker.com/engine/install/',
                linkText: 'See all installation options'
            }
    }
}

export default function Welcome({ status, onNext, isFirst }) {
    const [checks, setChecks] = useState([
        { id: 'server', label: 'Auth Server', status: 'loading', required: true },
        { id: 'database', label: 'Database', status: 'loading', required: true },
        { id: 'qdrant', label: 'Vector Database (Qdrant)', status: 'loading', required: true },
        { id: 'tasks', label: 'Objectives Engine (Tasks)', status: 'loading', required: false },
        { id: 'quoxflow', label: 'Workflow Engine (QuoxFlow)', status: 'loading', required: false },
    ])
    const [allPassed, setAllPassed] = useState(false)
    const [hasExistingUser, setHasExistingUser] = useState(false)
    const [checking, setChecking] = useState(false)
    const [copied, setCopied] = useState(null) // Track which command was copied
    const [platform] = useState(detectPlatform())
    const [dockerInfo] = useState(getDockerInstallInfo(detectPlatform()))
    const [showDockerHelp, setShowDockerHelp] = useState(false)

    // Bootstrap restore state
    const [showRestore, setShowRestore] = useState(false)
    const [restoreStatus, setRestoreStatus] = useState(null) // null | 'checking' | 'uploading' | 'restoring' | 'success' | 'error'
    const [restoreProgress, setRestoreProgress] = useState(0)
    const [restoreResult, setRestoreResult] = useState(null)
    const [restoreError, setRestoreError] = useState(null)
    const [localArchives, setLocalArchives] = useState([])
    const [dragActive, setDragActive] = useState(false)
    const fileInputRef = useRef(null)

    useEffect(() => {
        runChecks()
    }, [])

    const runChecks = async () => {
        setChecking(true)
        const results = [...checks].map(c => ({ ...c, status: 'loading' }))
        setChecks(results)

        // Check auth server
        try {
            const res = await fetch('/api/setup/status')
            if (res.ok) {
                const data = await res.json()
                results[0] = { ...results[0], status: 'pass', detail: 'Connected' }
                results[1] = { ...results[1], status: data.hasAdmin !== undefined ? 'pass' : 'fail', detail: data.hasAdmin !== undefined ? 'Available' : 'Not responding' }

                // Check if there's an existing admin
                if (data.hasAdmin) {
                    setHasExistingUser(true)
                }
            } else {
                results[0] = { ...results[0], status: 'fail', detail: 'Not responding' }
                results[1] = { ...results[1], status: 'fail', detail: 'Unavailable' }
            }
        } catch {
            results[0] = { ...results[0], status: 'fail', detail: 'Connection failed' }
            results[1] = { ...results[1], status: 'fail', detail: 'Connection failed' }
        }

        // Check Qdrant (REQUIRED) - use proxy to avoid CORS and handle API key
        try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 3000)

            const res = await fetch('/qdrant/collections', {
                signal: controller.signal
            })
            clearTimeout(timeoutId)

            if (res.ok) {
                results[2] = { ...results[2], status: 'pass', detail: 'Running on :6333' }
            } else {
                results[2] = { ...results[2], status: 'fail', detail: 'Not running' }
            }
        } catch {
            results[2] = { ...results[2], status: 'fail', detail: 'Not running' }
        }

        // Check tasks service (feature-critical)
        try {
            const res = await fetch('/tasks/health', {
                signal: AbortSignal.timeout(3000)
            })
            if (res.ok) {
                results[3] = { ...results[3], status: 'pass', detail: 'Running on :3104' }
            } else {
                results[3] = { ...results[3], status: 'warn', detail: 'Not responding' }
            }
        } catch {
            results[3] = { ...results[3], status: 'warn', detail: 'Not running' }
        }

        // Check QuoxFlow workflow engine (feature-critical)
        try {
            const res = await fetch('/quoxflow/health', {
                signal: AbortSignal.timeout(3000)
            })
            if (res.ok) {
                results[4] = { ...results[4], status: 'pass', detail: 'Running on :3200' }
            } else {
                results[4] = { ...results[4], status: 'warn', detail: 'Not responding' }
            }
        } catch {
            results[4] = { ...results[4], status: 'warn', detail: 'Not running' }
        }

        setChecks(results)
        setChecking(false)

        const allServicesPass = results.every(r => !r.required || r.status === 'pass')
        setAllPassed(allServicesPass)

        // Show Docker help if Qdrant is down
        if (results[2].status === 'fail') {
            setShowDockerHelp(true)
        }
    }

    // Check for available local backup archives
    const checkBootstrapStatus = async () => {
        try {
            setRestoreStatus('checking')
            const res = await fetch('/api/setup/bootstrap-status')
            if (res.ok) {
                const data = await res.json()
                setLocalArchives(data.localArchives || [])
            }
            setRestoreStatus(null)
        } catch {
            setRestoreStatus(null)
        }
    }

    // Handle file upload for bootstrap restore
    const handleRestoreUpload = async (file) => {
        if (!file) return
        if (!file.name.endsWith('.tar.gz') && !file.name.endsWith('.tgz')) {
            setRestoreError('Please select a .tar.gz backup archive')
            return
        }

        setRestoreStatus('uploading')
        setRestoreProgress(0)
        setRestoreError(null)

        try {
            const formData = new FormData()
            formData.append('archive', file)

            const xhr = new XMLHttpRequest()
            xhr.open('POST', '/api/setup/bootstrap-restore')

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 90) // 90% for upload, 10% for processing
                    setRestoreProgress(pct)
                }
            }

            const result = await new Promise((resolve, reject) => {
                xhr.onload = () => {
                    setRestoreProgress(100)
                    try {
                        const data = JSON.parse(xhr.responseText)
                        if (xhr.status === 200 && data.success) resolve(data)
                        else reject(new Error(data.message || data.error || 'Restore failed'))
                    } catch {
                        reject(new Error(`Server returned ${xhr.status}`))
                    }
                }
                xhr.onerror = () => reject(new Error('Network error — check server connectivity'))
                xhr.send(formData)
            })

            setRestoreStatus('success')
            setRestoreResult(result)

            // Redirect to login after the auth service restarts
            setTimeout(() => {
                window.location.href = '/login'
            }, 5000)

        } catch (err) {
            setRestoreStatus('error')
            setRestoreError(err.message)
        }
    }

    // Restore from a local archive (already on the server filesystem)
    const handleRestoreLocal = async (archive) => {
        setRestoreStatus('restoring')
        setRestoreProgress(50)
        setRestoreError(null)

        try {
            const res = await fetch('/api/setup/bootstrap-restore-local', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ archivePath: archive.path })
            })
            const data = await res.json()
            setRestoreProgress(100)

            if (res.ok && data.success) {
                setRestoreStatus('success')
                setRestoreResult(data)
                setTimeout(() => { window.location.href = '/login' }, 5000)
            } else {
                throw new Error(data.message || data.error || 'Restore failed')
            }
        } catch (err) {
            setRestoreStatus('error')
            setRestoreError(err.message)
        }
    }

    // Drag and drop handlers
    const handleDragOver = (e) => { e.preventDefault(); setDragActive(true) }
    const handleDragLeave = () => setDragActive(false)
    const handleDrop = (e) => {
        e.preventDefault()
        setDragActive(false)
        if (e.dataTransfer.files?.[0]) handleRestoreUpload(e.dataTransfer.files[0])
    }

    const formatSize = (bytes) => {
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    const formatDate = (iso) => {
        const d = new Date(iso)
        const now = new Date()
        const diffMs = now - d
        const diffHrs = Math.floor(diffMs / 3600000)
        if (diffHrs < 1) return `${Math.floor(diffMs / 60000)} min ago`
        if (diffHrs < 24) return `${diffHrs}h ago`
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    const getIcon = (status) => {
        switch (status) {
            case 'pass': return '✓'
            case 'fail': return '✗'
            case 'warn': return '!'
            default: return '○'
        }
    }

    const handleCopyCommand = async (command, id) => {
        try {
            await navigator.clipboard.writeText(command)
            setCopied(id)
            setTimeout(() => setCopied(null), 2000)
        } catch {
            const textarea = document.createElement('textarea')
            textarea.value = command
            document.body.appendChild(textarea)
            textarea.select()
            document.execCommand('copy')
            document.body.removeChild(textarea)
            setCopied(id)
            setTimeout(() => setCopied(null), 2000)
        }
    }

    const hasFeatureServicesDown = checks.some(c => !c.required && c.status !== 'pass')
    const hasDockerServicesDown = checks.some(c => ['qdrant', 'tasks', 'quoxflow'].includes(c.id) && c.status !== 'pass')
    const hasAuthDown = checks.find(c => c.id === 'server')?.status === 'fail'

    // Command box component for reuse
    const CommandBox = ({ command, id }) => (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            background: 'rgba(0,0,0,0.3)',
            padding: '0.5rem 0.75rem',
            borderRadius: '6px',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            marginTop: '0.5rem'
        }}>
            <code style={{ flex: 1, color: '#fbbf24', wordBreak: 'break-all' }}>{command}</code>
            <button
                onClick={() => handleCopyCommand(command, id)}
                style={{
                    background: copied === id ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255,255,255,0.1)',
                    border: 'none',
                    color: copied === id ? '#22c55e' : 'rgba(255,255,255,0.7)',
                    padding: '0.25rem 0.5rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.7rem',
                    whiteSpace: 'nowrap'
                }}
            >
                {copied === id ? '✓' : 'Copy'}
            </button>
        </div>
    )

    return (
        <div className="setup-step">
            <h2>Welcome to QuoxCORE</h2>
            <p>
                Let's get your AI command center up and running. This wizard will guide you through
                the initial configuration in just a few minutes.
            </p>

            <div className="system-checks">
                <div style={{ marginBottom: '0.75rem', fontSize: '0.875rem', color: 'rgba(255,255,255,0.5)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>System Status</span>
                    <button
                        onClick={runChecks}
                        disabled={checking}
                        style={{
                            background: 'transparent',
                            border: '1px solid rgba(255,255,255,0.2)',
                            color: 'rgba(255,255,255,0.7)',
                            padding: '0.25rem 0.75rem',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            cursor: checking ? 'not-allowed' : 'pointer',
                            opacity: checking ? 0.5 : 1
                        }}
                    >
                        {checking ? 'Checking...' : 'Retry'}
                    </button>
                </div>
                {checks.map(check => (
                    <div key={check.id} className="check-item">
                        <span className={`check-icon ${check.status}`}>
                            {getIcon(check.status)}
                        </span>
                        <span className="check-label">
                            {check.label}
                            {check.required && <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>(Required)</span>}
                            {!check.required && <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>(Feature-critical)</span>}
                        </span>
                        <span className={`check-status ${check.status === 'fail' ? 'error' : ''}`} style={check.status === 'fail' ? { color: '#ef4444' } : {}}>
                            {check.detail || ''}
                        </span>
                    </div>
                ))}
            </div>

            {/* Auth Service Down - Different guidance */}
            {hasAuthDown && !hasDockerServicesDown && (
                <div className="info-box warning" style={{ marginBottom: '1rem' }}>
                    <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
                        Auth service is not running
                    </strong>
                    <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem' }}>
                        The QuoxCORE auth service needs to be started. Run from the project directory:
                    </p>
                    <CommandBox command="cd services/auth && npm run dev" id="auth" />
                    <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                        Or if using Docker: <code style={{ color: '#fbbf24' }}>docker compose up -d</code>
                    </p>
                </div>
            )}

            {/* Docker Services Down - Main guidance */}
            {hasDockerServicesDown && (
                <div className="info-box warning" style={{ marginBottom: '1rem' }}>
                    <strong style={{ display: 'block', marginBottom: '0.5rem' }}>
                        Platform services need to be started
                    </strong>
                    <p style={{ margin: '0 0 0.75rem', fontSize: '0.875rem' }}>
                        Qdrant, Tasks, and QuoxFlow are all expected in a healthy local stack. Start services with:
                    </p>
                    <CommandBox command="docker compose up -d" id="compose" />

                    <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)' }}>
                        Without <strong>Tasks</strong>, Objectives, Mission Control, and Agentic Teams will be degraded.
                        Without <strong>QuoxFlow</strong>, Workflow Builder, approvals, and policies will be degraded.
                    </p>

                    <p style={{ margin: '1rem 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
                        After starting, click <strong>Retry</strong> above to re-check.
                    </p>

                    {/* Collapsible Docker Help */}
                    <div style={{ marginTop: '1rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.75rem' }}>
                        <button
                            onClick={() => setShowDockerHelp(!showDockerHelp)}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'rgba(255,255,255,0.6)',
                                fontSize: '0.8rem',
                                cursor: 'pointer',
                                padding: 0,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem'
                            }}
                        >
                            <span style={{ transition: 'transform 0.2s', transform: showDockerHelp ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
                            {showDockerHelp ? 'Hide' : 'Show'} Docker installation help
                        </button>

                        {showDockerHelp && (
                            <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '6px' }}>
                                <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)' }}>
                                    <strong>Detected platform:</strong> {dockerInfo.name}
                                </p>

                                {dockerInfo.link && !dockerInfo.command && (
                                    <a
                                        href={dockerInfo.link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{
                                            display: 'inline-block',
                                            background: 'rgba(59, 130, 246, 0.2)',
                                            color: '#60a5fa',
                                            padding: '0.5rem 1rem',
                                            borderRadius: '6px',
                                            textDecoration: 'none',
                                            fontSize: '0.875rem',
                                            marginTop: '0.5rem'
                                        }}
                                    >
                                        {dockerInfo.linkText} →
                                    </a>
                                )}

                                {dockerInfo.command && (
                                    <>
                                        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>
                                            {dockerInfo.instructions}
                                        </p>
                                        <CommandBox command={dockerInfo.command} id="docker-install" />

                                        {dockerInfo.postCommand && (
                                            <>
                                                <p style={{ margin: '0.75rem 0 0.25rem', fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>
                                                    Then add your user to the docker group:
                                                </p>
                                                <CommandBox command={dockerInfo.postCommand} id="docker-group" />
                                            </>
                                        )}

                                        {dockerInfo.link && (
                                            <p style={{ margin: '0.75rem 0 0', fontSize: '0.75rem' }}>
                                                <a href={dockerInfo.link} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa' }}>
                                                    {dockerInfo.linkText} →
                                                </a>
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {allPassed && (
                <div className="info-box success">
                    Core setup services are running. Click Continue to proceed with setup.
                </div>
            )}

            {allPassed && hasFeatureServicesDown && (
                <div className="info-box warning" style={{ marginTop: '1rem' }}>
                    <strong>Core setup can continue, but platform features are degraded</strong>
                    <p style={{ margin: '0.5rem 0 0' }}>
                        Tasks powers Objectives, Mission Control, and Agentic Teams. QuoxFlow powers Workflows, approvals, and policies.
                        Start those services before you treat the install as fully healthy.
                    </p>
                </div>
            )}

            {hasExistingUser && (
                <div className="info-box" style={{ marginTop: '1rem' }}>
                    <strong>Existing account detected</strong>
                    <p style={{ margin: '0.5rem 0 0' }}>
                        An admin account already exists. You can{' '}
                        <Link to="/login" style={{ color: '#ff6b35' }}>go to login</Link>
                        {' '}or continue setup to reconfigure settings.
                    </p>
                </div>
            )}

            {/* Bootstrap Restore Section */}
            {allPassed && !hasExistingUser && !showRestore && (
                <div style={{
                    marginTop: '1.5rem',
                    padding: '1.25rem',
                    background: 'rgba(0, 0, 0, 0.2)',
                    borderRadius: '10px',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    textAlign: 'center'
                }}>
                    <p style={{
                        margin: '0 0 0.75rem',
                        fontSize: '0.875rem',
                        color: 'rgba(255, 255, 255, 0.5)'
                    }}>
                        Migrating from another instance?
                    </p>
                    <button
                        onClick={() => { setShowRestore(true); checkBootstrapStatus() }}
                        style={{
                            background: 'rgba(99, 102, 241, 0.12)',
                            border: '1px solid rgba(99, 102, 241, 0.3)',
                            color: 'rgba(255, 255, 255, 0.8)',
                            padding: '0.625rem 1.25rem',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontSize: '0.875rem',
                            transition: 'all 0.2s'
                        }}
                    >
                        ↻ Restore from Backup
                    </button>
                </div>
            )}

            {showRestore && allPassed && (
                <div style={{ marginTop: '1.5rem' }}>
                    {/* Restore header */}
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        marginBottom: '1rem'
                    }}>
                        <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#fff' }}>
                            Restore from Backup
                        </h3>
                        {restoreStatus !== 'uploading' && restoreStatus !== 'restoring' && restoreStatus !== 'success' && (
                            <button
                                onClick={() => { setShowRestore(false); setRestoreError(null); setRestoreStatus(null) }}
                                style={{
                                    background: 'none', border: 'none',
                                    color: 'rgba(255, 255, 255, 0.5)', cursor: 'pointer', fontSize: '0.8rem'
                                }}
                            >
                                Cancel
                            </button>
                        )}
                    </div>

                    {/* Success state */}
                    {restoreStatus === 'success' && restoreResult && (
                        <div className="info-box success" style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>✓</div>
                            <strong style={{ display: 'block', marginBottom: '0.5rem', fontSize: '1rem' }}>
                                Restore Complete
                            </strong>
                            <p style={{ margin: '0 0 0.5rem', fontSize: '0.875rem' }}>
                                {restoreResult.userCount} user account{restoreResult.userCount !== 1 ? 's' : ''} restored.
                                {restoreResult.restored?.length > 1 && (
                                    <> {restoreResult.restored.length} components recovered.</>
                                )}
                            </p>
                            {restoreResult.skipped?.length > 0 && (
                                <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>
                                    Skipped: {restoreResult.skipped.map(s => s.key).join(', ')}
                                </p>
                            )}
                            <p style={{ margin: '0.75rem 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)' }}>
                                Redirecting to login in a few seconds...
                            </p>
                            <div style={{
                                marginTop: '0.75rem', height: '3px', borderRadius: '2px',
                                background: 'rgba(34, 197, 94, 0.3)', overflow: 'hidden'
                            }}>
                                <div style={{
                                    height: '100%', width: '100%', background: '#22c55e',
                                    borderRadius: '2px',
                                    animation: 'restoreCountdown 5s linear forwards',
                                }} />
                            </div>
                        </div>
                    )}

                    {/* Error state */}
                    {restoreStatus === 'error' && (
                        <div className="info-box warning" style={{ marginBottom: '1rem' }}>
                            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>Restore failed</strong>
                            <p style={{ margin: 0, fontSize: '0.8rem' }}>{restoreError}</p>
                        </div>
                    )}

                    {/* Upload/progress states */}
                    {(restoreStatus === 'uploading' || restoreStatus === 'restoring') && (
                        <div style={{
                            padding: '2rem', textAlign: 'center',
                            background: 'rgba(0, 0, 0, 0.2)', borderRadius: '10px',
                            border: '1px solid rgba(255, 255, 255, 0.06)'
                        }}>
                            <div className="setup-spinner" style={{ margin: '0 auto 1rem' }} />
                            <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', color: 'rgba(255,255,255,0.8)' }}>
                                {restoreStatus === 'uploading' ? 'Uploading and restoring backup...' : 'Restoring from backup...'}
                            </p>
                            <div style={{
                                height: '6px', borderRadius: '3px',
                                background: 'rgba(255, 255, 255, 0.06)', overflow: 'hidden'
                            }}>
                                <div style={{
                                    height: '100%', width: `${restoreProgress}%`,
                                    background: 'linear-gradient(90deg, #6366f1, #a78bfa)',
                                    borderRadius: '3px',
                                    transition: 'width 0.3s ease'
                                }} />
                            </div>
                            <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>
                                {restoreProgress}%
                            </p>
                        </div>
                    )}

                    {/* File selection UI — shown when idle, checking, or after error */}
                    {(restoreStatus === null || restoreStatus === 'checking' || restoreStatus === 'error') && (
                        <>
                            {/* Local archives found on server */}
                            {localArchives.length > 0 && (
                                <div style={{ marginBottom: '1.25rem' }}>
                                    <p style={{
                                        margin: '0 0 0.75rem', fontSize: '0.8rem',
                                        color: 'rgba(255, 255, 255, 0.5)',
                                        textTransform: 'uppercase', letterSpacing: '0.05em'
                                    }}>
                                        Backups found on this server
                                    </p>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                        {localArchives.slice(0, 5).map((archive, idx) => (
                                            <button
                                                key={archive.name}
                                                onClick={() => handleRestoreLocal(archive)}
                                                style={{
                                                    display: 'flex', alignItems: 'center', gap: '0.75rem',
                                                    padding: '0.75rem 1rem',
                                                    background: idx === 0 ? 'rgba(99, 102, 241, 0.08)' : 'rgba(0, 0, 0, 0.2)',
                                                    border: idx === 0 ? '1px solid rgba(99, 102, 241, 0.25)' : '1px solid rgba(255, 255, 255, 0.06)',
                                                    borderRadius: '8px',
                                                    color: 'rgba(255, 255, 255, 0.8)',
                                                    cursor: 'pointer',
                                                    textAlign: 'left',
                                                    width: '100%',
                                                    transition: 'all 0.15s',
                                                    fontSize: '0.875rem'
                                                }}
                                                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(99, 102, 241, 0.12)'; e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.35)' }}
                                                onMouseLeave={e => {
                                                    e.currentTarget.style.background = idx === 0 ? 'rgba(99, 102, 241, 0.08)' : 'rgba(0, 0, 0, 0.2)'
                                                    e.currentTarget.style.borderColor = idx === 0 ? 'rgba(99, 102, 241, 0.25)' : 'rgba(255, 255, 255, 0.06)'
                                                }}
                                            >
                                                <span style={{ fontSize: '1.1rem', opacity: 0.7 }}>◉</span>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{
                                                        fontFamily: "'SF Mono', 'Cascadia Code', monospace",
                                                        fontSize: '0.8rem',
                                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                                                    }}>
                                                        {archive.name}
                                                    </div>
                                                    <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>
                                                        {formatSize(archive.size)} · {formatDate(archive.created)}
                                                        {idx === 0 && <span style={{ color: '#6366f1', marginLeft: '0.5rem' }}>Latest</span>}
                                                    </div>
                                                </div>
                                                <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>→</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Divider if local archives exist */}
                            {localArchives.length > 0 && (
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: '1rem',
                                    margin: '1rem 0', color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem'
                                }}>
                                    <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
                                    or upload an archive
                                    <div style={{ flex: 1, height: '1px', background: 'rgba(255,255,255,0.08)' }} />
                                </div>
                            )}

                            {/* Drag and drop zone */}
                            <div
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                                onClick={() => fileInputRef.current?.click()}
                                style={{
                                    padding: '2rem',
                                    textAlign: 'center',
                                    background: dragActive ? 'rgba(99, 102, 241, 0.08)' : 'rgba(0, 0, 0, 0.15)',
                                    border: `2px dashed ${dragActive ? 'rgba(99, 102, 241, 0.5)' : 'rgba(255, 255, 255, 0.1)'}`,
                                    borderRadius: '10px',
                                    cursor: 'pointer',
                                    transition: 'all 0.2s'
                                }}
                            >
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".tar.gz,.tgz"
                                    style={{ display: 'none' }}
                                    onChange={e => { if (e.target.files?.[0]) handleRestoreUpload(e.target.files[0]) }}
                                />
                                <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem', opacity: 0.5 }}>
                                    {dragActive ? '↓' : '⬆'}
                                </div>
                                <p style={{ margin: '0 0 0.25rem', fontSize: '0.875rem', color: 'rgba(255,255,255,0.7)' }}>
                                    {dragActive ? 'Drop archive here' : 'Drag and drop a backup archive'}
                                </p>
                                <p style={{ margin: 0, fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)' }}>
                                    or click to browse · .tar.gz up to 500 MB
                                </p>
                            </div>
                        </>
                    )}
                </div>
            )}

            <div className="setup-actions">
                {hasExistingUser ? (
                    <Link to="/login" className="btn btn-secondary">
                        Go to Login
                    </Link>
                ) : (
                    <div />
                )}
                <button
                    className="btn btn-primary"
                    onClick={() => onNext()}
                    disabled={!allPassed || restoreStatus === 'uploading' || restoreStatus === 'restoring'}
                    title={!allPassed ? 'All services must be running to continue' : ''}
                >
                    {showRestore ? 'Skip Restore → Fresh Setup' : 'Continue →'}
                </button>
            </div>
        </div>
    )
}

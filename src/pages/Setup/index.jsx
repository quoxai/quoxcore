/**
 * Setup Wizard - First-run configuration wizard
 *
 * Guides new users through initial QuoxCORE setup:
 * 1. Welcome & system check
 * 2. Create admin account
 * 3. Configure API keys
 * 4. Infrastructure settings
 * 5. Verify and complete
 */

import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Welcome from './steps/Welcome'
import AdminAccount from './steps/AdminAccount'
import ApiKeys from './steps/ApiKeys'
import Infrastructure from './steps/Infrastructure'
import Telemetry from './steps/Telemetry'
import Verify from './steps/Verify'
import { describeSetupStatusFailure } from '../../services/llmStatus'
import './Setup.css'

const STEPS = [
    { id: 'welcome', title: 'Welcome', component: Welcome },
    { id: 'admin', title: 'Admin Account', component: AdminAccount },
    { id: 'apikeys', title: 'API Keys', component: ApiKeys },
    { id: 'infrastructure', title: 'Infrastructure', component: Infrastructure },
    { id: 'telemetry', title: 'Telemetry', component: Telemetry },
    { id: 'verify', title: 'Verify', component: Verify },
]

export default function SetupWizard() {
    const navigate = useNavigate()
    const [searchParams] = useSearchParams()
    const forceSetup = searchParams.get('force') === 'true'
    const [currentStep, setCurrentStep] = useState(0)
    const [setupData, setSetupData] = useState({
        admin: null,
        apiKeys: {},
        infrastructure: {},
    })
    const [status, setStatus] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    // Check setup status on mount
    useEffect(() => {
        checkSetupStatus()
    }, [])

    const checkSetupStatus = async () => {
        try {
            const res = await fetch('/api/setup/status')
            if (!res.ok) throw new Error('Failed to check setup status')
            const data = await res.json()
            setStatus(data)
            const platformDegraded = data?.readiness?.fullPlatformReady === false

            // If setup is complete and the full platform is healthy, redirect to login.
            // If setup is complete but the platform is degraded, keep the user on Verify
            // so the install truth is visible instead of silently bouncing away.
            if (data.complete && !forceSetup && !platformDegraded) {
                navigate('/login')
                return
            }

            if (data.complete && platformDegraded) {
                setCurrentStep(STEPS.length - 1)
                return
            }

            // Skip to appropriate step based on status
            if (data.hasAdmin && !data.configComplete) {
                setCurrentStep(2) // Skip to API keys
            }
        } catch (err) {
            console.error('Setup status check failed:', err)
            setError(describeSetupStatusFailure(err))
        } finally {
            setLoading(false)
        }
    }

    const handleNext = (data) => {
        // Merge step data into setupData
        if (data) {
            setSetupData(prev => ({ ...prev, ...data }))
        }

        if (currentStep < STEPS.length - 1) {
            setCurrentStep(currentStep + 1)
        }
    }

    const handleBack = () => {
        if (currentStep > 0) {
            setCurrentStep(currentStep - 1)
        }
    }

    const handleComplete = () => {
        navigate('/login')
    }

    if (loading) {
        return (
            <div className="setup-container">
                <div className="setup-loading">
                    <div className="setup-spinner" />
                    <p>Checking system status...</p>
                </div>
            </div>
        )
    }

    if (error) {
        return (
            <div className="setup-container">
                <div className="setup-error">
                    <h2>{error?.title || 'Connection Error'}</h2>
                    <p>{error?.message || 'Failed to connect to server. Please ensure services are running.'}</p>
                    {error?.action && <p>{error.action}</p>}
                    {error?.detail && <p style={{ opacity: 0.7, fontSize: '0.9rem' }}>Detail: {error.detail}</p>}
                    <button onClick={() => window.location.reload()}>
                        Retry
                    </button>
                </div>
            </div>
        )
    }

    const CurrentStepComponent = STEPS[currentStep].component

    return (
        <div className="setup-container">
            <div className="setup-card">
                {/* Header */}
                <div className="setup-header">
                    <div className="setup-logo">
                        <img src="/logo-quox.png?v=3" alt="QuoxCORE — AI Orchestration Platform" className="setup-logo-img" />
                    </div>
                    <h1>Setup Wizard</h1>
                </div>

                {/* Progress */}
                <div className="setup-progress">
                    {STEPS.map((step, index) => (
                        <div
                            key={step.id}
                            className={`progress-step ${index === currentStep ? 'active' : ''} ${index < currentStep ? 'completed' : ''}`}
                        >
                            <div className="step-number">
                                {index < currentStep ? '✓' : index + 1}
                            </div>
                            <span className="step-title">{step.title}</span>
                        </div>
                    ))}
                </div>

                {/* Content */}
                <div className="setup-content">
                    <CurrentStepComponent
                        data={setupData}
                        status={status}
                        onNext={handleNext}
                        onBack={handleBack}
                        onComplete={handleComplete}
                        isFirst={currentStep === 0}
                        isLast={currentStep === STEPS.length - 1}
                    />
                </div>
            </div>
        </div>
    )
}

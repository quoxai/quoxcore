import { useState, useEffect } from 'react'
import { getMemoryManager } from '../../services/memoryManager'
import { Input, Select, RadioGroup } from '../ui/Input'
import Button from '../ui/Button'
import './memory.css'

export function MemoryWizard({ isOpen, onClose, onComplete }) {
  const [step, setStep] = useState(1)
  const [profile, setProfile] = useState({
    name: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    role: 'Infrastructure Admin',
    experience_level: 'advanced'
  })
  const [preferences, setPreferences] = useState({
    verbosity: 'concise',
    confirmDestructive: true,
    useEmojis: false,
    autoDelegate: true
  })

  const memoryManager = getMemoryManager()

  useEffect(() => {
    // Load existing profile if any
    const existing = memoryManager.getProfile()
    if (existing?.name) {
      setProfile(prev => ({ ...prev, ...existing }))
    }
  }, [])

  const handleComplete = () => {
    memoryManager.saveProfile({
      ...profile,
      preferences
    })
    onComplete?.()
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="memory-wizard-overlay" onClick={onClose}>
      <div className="memory-wizard" onClick={e => e.stopPropagation()}>
        <div className="wizard-header">
          <div className="wizard-icon">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><circle cx="12" cy="12" r="10"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <h2>Memory Setup</h2>
          <p className="wizard-subtitle">Help QuoxCORE remember you</p>
          <button className="wizard-close" onClick={onClose}>x</button>
        </div>

        <div className="wizard-progress">
          <div className={`progress-step ${step >= 1 ? 'active' : ''}`}>
            <span className="step-number">1</span>
            <span className="step-label">Identity</span>
          </div>
          <div className="progress-line" />
          <div className={`progress-step ${step >= 2 ? 'active' : ''}`}>
            <span className="step-number">2</span>
            <span className="step-label">Preferences</span>
          </div>
          <div className="progress-line" />
          <div className={`progress-step ${step >= 3 ? 'active' : ''}`}>
            <span className="step-number">3</span>
            <span className="step-label">Confirm</span>
          </div>
        </div>

        <div className="wizard-content">
          {step === 1 && (
            <div className="wizard-step">
              <h3>Tell me about yourself</h3>

              <div className="form-group">
                <label>What should I call you?</label>
                <input
                  type="text"
                  value={profile.name}
                  onChange={e => setProfile(p => ({ ...p, name: e.target.value }))}
                  placeholder="Your name"
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label>Your timezone</label>
                <select
                  value={profile.timezone}
                  onChange={e => setProfile(p => ({ ...p, timezone: e.target.value }))}
                >
                  <option value="America/Los_Angeles">Pacific (LA)</option>
                  <option value="America/Denver">Mountain (Denver)</option>
                  <option value="America/Chicago">Central (Chicago)</option>
                  <option value="America/New_York">Eastern (NY)</option>
                  <option value="Europe/London">London</option>
                  <option value="Europe/Paris">Paris</option>
                  <option value="Asia/Tokyo">Tokyo</option>
                  <option value="Australia/Sydney">Sydney</option>
                </select>
              </div>

              <div className="form-group">
                <label>Experience level</label>
                <div className="radio-group">
                  {['beginner', 'intermediate', 'advanced', 'expert'].map(level => (
                    <label key={level} className="radio-option">
                      <input
                        type="radio"
                        name="experience"
                        checked={profile.experience_level === level}
                        onChange={() => setProfile(p => ({ ...p, experience_level: level }))}
                      />
                      <span>{level.charAt(0).toUpperCase() + level.slice(1)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step">
              <h3>How should I communicate?</h3>

              <div className="form-group">
                <label>Response verbosity</label>
                <div className="radio-group">
                  {[
                    { value: 'minimal', label: 'Minimal', desc: 'Just the facts' },
                    { value: 'concise', label: 'Concise', desc: 'Brief but complete' },
                    { value: 'detailed', label: 'Detailed', desc: 'Full explanations' }
                  ].map(opt => (
                    <label key={opt.value} className="radio-option">
                      <input
                        type="radio"
                        name="verbosity"
                        checked={preferences.verbosity === opt.value}
                        onChange={() => setPreferences(p => ({ ...p, verbosity: opt.value }))}
                      />
                      <span>{opt.label}</span>
                      <small>{opt.desc}</small>
                    </label>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label>Safety preferences</label>
                <div className="checkbox-group">
                  <label className="checkbox-option">
                    <input
                      type="checkbox"
                      checked={preferences.confirmDestructive}
                      onChange={e => setPreferences(p => ({ ...p, confirmDestructive: e.target.checked }))}
                    />
                    <span>Confirm destructive operations</span>
                  </label>
                  <label className="checkbox-option">
                    <input
                      type="checkbox"
                      checked={preferences.autoDelegate}
                      onChange={e => setPreferences(p => ({ ...p, autoDelegate: e.target.checked }))}
                    />
                    <span>Auto-delegate to specialist agents</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="wizard-step">
              <h3>Review your settings</h3>

              <div className="review-section">
                <h4>Identity</h4>
                <div className="review-items">
                  <div className="review-item">
                    <span className="review-label">Name:</span>
                    <span className="review-value">{profile.name || 'Not set'}</span>
                  </div>
                  <div className="review-item">
                    <span className="review-label">Timezone:</span>
                    <span className="review-value">{profile.timezone}</span>
                  </div>
                  <div className="review-item">
                    <span className="review-label">Experience:</span>
                    <span className="review-value">{profile.experience_level}</span>
                  </div>
                </div>
              </div>

              <div className="review-section">
                <h4>Preferences</h4>
                <div className="review-items">
                  <div className="review-item">
                    <span className="review-label">Verbosity:</span>
                    <span className="review-value">{preferences.verbosity}</span>
                  </div>
                  <div className="review-item">
                    <span className="review-label">Confirm destructive:</span>
                    <span className="review-value">{preferences.confirmDestructive ? 'Yes' : 'No'}</span>
                  </div>
                  <div className="review-item">
                    <span className="review-label">Auto-delegate:</span>
                    <span className="review-value">{preferences.autoDelegate ? 'Yes' : 'No'}</span>
                  </div>
                </div>
              </div>

              <p className="wizard-note">
                You can change these settings anytime from the Settings view.
              </p>
            </div>
          )}
        </div>

        <div className="wizard-actions">
          {step > 1 && (
            <Button variant="secondary" onClick={() => setStep(s => s - 1)}>
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button variant="primary" onClick={() => setStep(s => s + 1)}>
              Next
            </Button>
          ) : (
            <Button variant="primary" onClick={handleComplete}>
              Complete Setup
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export default MemoryWizard

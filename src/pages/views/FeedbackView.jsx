/**
 * FeedbackView - User-facing feedback form page
 * Sends feedback to quox.ai via the feedback API
 */

import { useState, useRef, useEffect } from 'react'
import { submitFeedback } from '../../services/feedbackClient'

const TYPES = [
  { value: 'feedback', label: 'General Feedback' },
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'integration_request', label: 'Integration Request' },
]

export default function FeedbackView() {
  const [form, setForm] = useState({ type: 'feedback', message: '', name: '', email: '', website: '' })
  const [status, setStatus] = useState('idle') // idle | sending | success | error
  const [errorMsg, setErrorMsg] = useState('')
  const textareaRef = useRef(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (form.message.trim().length < 5) {
      setErrorMsg('Please provide at least 5 characters of feedback.')
      return
    }

    setStatus('sending')
    setErrorMsg('')

    try {
      await submitFeedback(form)
      setStatus('success')
      setForm({ type: 'feedback', message: '', name: '', email: '', website: '' })
    } catch (err) {
      setStatus('error')
      setErrorMsg(err.message || 'Failed to submit. Please try again.')
    }
  }

  const handleAnother = () => {
    setStatus('idle')
    setErrorMsg('')
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--ui-space-6, 1.5rem)' }}>
      <div style={{ marginBottom: 'var(--ui-space-6, 1.5rem)' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary, #e8eaed)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Send Feedback
        </h1>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary, #9aa0a6)', margin: '4px 0 0' }}>
          Share your thoughts, report bugs, or request features. We read every submission.
        </p>
      </div>

      {status === 'success' ? (
        <div style={{
          textAlign: 'center',
          padding: 'var(--ui-space-8, 2rem)',
          background: 'var(--bg-secondary, rgba(255,255,255,0.03))',
          borderRadius: 12,
          border: '1px solid var(--border-color, rgba(255,255,255,0.06))',
        }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <h3 style={{ color: 'var(--text-primary, #e8eaed)', margin: '0 0 8px' }}>Thank you</h3>
          <p style={{ color: 'var(--text-secondary, #9aa0a6)', fontSize: '0.8rem', margin: '0 0 16px' }}>
            Your feedback has been submitted. We read every submission.
          </p>
          <button
            onClick={handleAnother}
            style={{
              padding: '8px 20px',
              background: 'var(--hal-green, #22c55e)',
              color: '#000',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '0.8rem',
            }}
          >
            Submit Another
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4, 1rem)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary, #9aa0a6)' }}>Type</label>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              className="ui-input ui-select"
            >
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary, #9aa0a6)' }}>
              Message <span style={{ color: 'var(--ui-red, #ef4444)' }}>*</span>
            </label>
            <textarea
              ref={textareaRef}
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="What's on your mind? Found a bug? Have an idea?"
              rows={6}
              maxLength={5000}
              required
              className="ui-input ui-textarea"
              style={{ resize: 'vertical', minHeight: 120 }}
            />
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted, #5f6368)', textAlign: 'right' }}>
              {form.message.length} / 5000
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--ui-space-4, 1rem)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary, #9aa0a6)' }}>
                Name <span style={{ fontSize: '0.65rem', color: 'var(--text-muted, #5f6368)' }}>(optional)</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Your name"
                maxLength={255}
                className="ui-input"
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--text-secondary, #9aa0a6)' }}>
                Email <span style={{ fontSize: '0.65rem', color: 'var(--text-muted, #5f6368)' }}>(optional)</span>
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="you@example.com"
                maxLength={255}
                className="ui-input"
              />
            </div>
          </div>

          {/* Honeypot */}
          <div style={{ position: 'absolute', left: '-9999px', opacity: 0, height: 0, overflow: 'hidden' }} aria-hidden="true">
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
            />
          </div>

          {errorMsg && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              borderRadius: 8,
              fontSize: '0.75rem',
              color: '#ff6060',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {errorMsg}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--ui-space-3, 0.75rem)', marginTop: 8 }}>
            <button
              type="submit"
              disabled={status === 'sending'}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 20px',
                background: status === 'sending' ? 'rgba(255,255,255,0.05)' : 'var(--hal-green, #22c55e)',
                color: status === 'sending' ? 'var(--text-secondary)' : '#000',
                border: 'none',
                borderRadius: 8,
                cursor: status === 'sending' ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                fontSize: '0.8rem',
              }}
            >
              {status === 'sending' ? 'Sending...' : 'Submit Feedback'}
              {status !== 'sending' && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

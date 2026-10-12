/**
 * FeedbackModal - Floating feedback button + modal form
 * Accessible from any page via a persistent floating button in bottom-right
 */

import { useState, useRef, useEffect } from 'react'
import { submitFeedback } from '../../services/feedbackClient'
import './feedback.css'

const TYPES = [
  { value: 'feedback', label: 'General Feedback' },
  { value: 'bug', label: 'Bug Report' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'integration_request', label: 'Integration Request' },
]

export default function FeedbackModal({ isOpen: controlledOpen, onClose: controlledClose, hideFab = false }) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen
  const setOpen = controlledClose ? (v) => { if (!v) controlledClose(); else setInternalOpen(true); } : setInternalOpen
  const [form, setForm] = useState({ type: 'feedback', message: '', name: '', email: '', website: '' })
  const [status, setStatus] = useState('idle') // idle | sending | success | error
  const [errorMsg, setErrorMsg] = useState('')
  const textareaRef = useRef(null)

  useEffect(() => {
    if (open && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

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

  const handleClose = () => {
    setOpen(false)
    if (status === 'success') {
      setStatus('idle')
    }
  }

  const handleAnother = () => {
    setStatus('idle')
    setErrorMsg('')
  }

  return (
    <>
      {/* Floating button (hidden when used inline from header) */}
      {!hideFab && (
        <button
          className="feedback-fab"
          onClick={() => setOpen(true)}
          title="Send Feedback"
          aria-label="Send Feedback"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}

      {/* Modal overlay */}
      {open && (
        <div className="feedback-overlay" onClick={handleClose}>
          <div className="feedback-modal" onClick={(e) => e.stopPropagation()}>
            <div className="feedback-modal-header">
              <div className="feedback-modal-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                Send Feedback
              </div>
              <button className="feedback-modal-close" onClick={handleClose} aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {status === 'success' ? (
              <div className="feedback-success">
                <div className="feedback-success-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h3>Thank you</h3>
                <p>Your feedback has been submitted. We read every submission.</p>
                <div className="feedback-success-actions">
                  <button className="feedback-btn feedback-btn-secondary" onClick={handleAnother}>Submit Another</button>
                  <button className="feedback-btn feedback-btn-primary" onClick={handleClose}>Close</button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="feedback-form">
                <div className="feedback-field">
                  <label>Type</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm({ ...form, type: e.target.value })}
                  >
                    {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>

                <div className="feedback-field">
                  <label>Message <span className="feedback-required">*</span></label>
                  <textarea
                    ref={textareaRef}
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    placeholder="What's on your mind? Found a bug? Have an idea?"
                    rows={5}
                    maxLength={5000}
                    required
                  />
                  <div className="feedback-char-count">{form.message.length} / 5000</div>
                </div>

                <div className="feedback-field-row">
                  <div className="feedback-field">
                    <label>Name <span className="feedback-optional">(optional)</span></label>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="Your name"
                      maxLength={255}
                    />
                  </div>
                  <div className="feedback-field">
                    <label>Email <span className="feedback-optional">(optional)</span></label>
                    <input
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder="you@example.com"
                      maxLength={255}
                    />
                  </div>
                </div>

                {/* Honeypot - hidden from real users */}
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
                  <div className="feedback-error">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    {errorMsg}
                  </div>
                )}

                <div className="feedback-actions">
                  <button type="button" className="feedback-btn feedback-btn-secondary" onClick={handleClose}>Cancel</button>
                  <button type="submit" className="feedback-btn feedback-btn-primary" disabled={status === 'sending'}>
                    {status === 'sending' ? 'Sending...' : 'Submit'}
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
        </div>
      )}
    </>
  )
}

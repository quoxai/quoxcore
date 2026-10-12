/**
 * OnboardingWizard — Zero to working widget in 5 minutes
 * CW-8.9
 *
 * 4 steps: Name → Knowledge → Test → Deploy
 * Shows when user has no widgets and visits /quoxchat.
 */

import { useState, useMemo, useEffect } from 'react'
import { WIZARD_STEPS, canProceed } from '../../../../widget/onboardingUtils'
import { defaultEndpoint, generateEmbedCode } from '../../../../widget/settingsTabUtils'
import { firstIncompleteStep } from '../../../../widget/completionUtils'
import { existingGreeting, buildWizardPatch } from '../../../../widget/wizardPatch'

export default function OnboardingWizard({ onComplete, authFetch, orgId, existingWidget = null, completion = null }) {
  const initialStep = useMemo(() => completion && existingWidget ? firstIncompleteStep(completion, WIZARD_STEPS) : 0, [])
  const [step, setStep] = useState(initialStep)
  const [name, setName] = useState(existingWidget?.name || '')
  const [businessName, setBusinessName] = useState(existingWidget?.business_name || '')
  const [greeting, setGreeting] = useState(existingGreeting(existingWidget) || 'Hi! How can I help you today?')
  const [domain, setDomain] = useState(() => {
    if (!existingWidget) return ''
    const d = existingWidget.allowed_domains || (existingWidget.allowed_domains_json ? JSON.parse(existingWidget.allowed_domains_json) : [])
    return Array.isArray(d) ? (d[0] || '') : ''
  })
  const [widgetId, setWidgetId] = useState(existingWidget?.id || null)
  const [creating, setCreating] = useState(false)
  const [testQuery, setTestQuery] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [createError, setCreateError] = useState(null)

  const data = { name, greeting, domain, widgetId }
  const currentStep = WIZARD_STEPS[step]
  const canNext = canProceed(step, data)

  const handleCreate = async () => {
    if (!name.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      if (existingWidget) {
        // Only send what the admin changed (never overwrite the real greeting
        // or shrink allowed_domains silently).
        const patch = buildWizardPatch(existingWidget, { name, businessName, greeting, domain })
        if (Object.keys(patch).length > 0) {
          const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widgetId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (resp && resp.ok === false) {
            const body = await resp.json().catch(() => ({}))
            setCreateError(body.message || body.error || `Could not save your changes (HTTP ${resp.status}).`)
            setCreating(false)
            return
          }
        }
        setStep(1)
      } else {
        const resp = await authFetch(`/api/orgs/${orgId}/widgets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, greeting, domain, business_name: businessName.trim() }),
        })
        if (resp.ok) {
          const d = await resp.json()
          setWidgetId(d.widget?.id || d.id)
          setStep(1)
        } else {
          // Surface the failure instead of silently staying on step 0.
          const body = await resp.json().catch(() => ({}))
          setCreateError(body.message || body.error || `Could not create the widget (HTTP ${resp.status}).`)
        }
      }
    } catch (err) {
      setCreateError(err?.message || 'Could not create the widget. Check your connection and try again.')
    }
    setCreating(false)
  }

  // Persist the public endpoint once the embed code is shown, so the snippet
  // and the saved config agree (the server merges, other keys are kept).
  const endpoint = defaultEndpoint(null)
  useEffect(() => {
    if (step !== 3 || !widgetId || !endpoint) return
    authFetch(`/api/orgs/${orgId}/widgets/${widgetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embed_config_json: JSON.stringify({ endpoint }) }),
    }).catch(() => {})
  }, [step, widgetId]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleTest = async () => {
    if (!testQuery.trim()) return
    setTesting(true)
    setTestResult(null)
    try {
      const resp = await fetch('/collector/quoxchat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: testQuery, widget_id: widgetId || 'demo', visitor_id: 'onboarding' }),
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        const reason = body.message || body.error || (resp.status === 402 ? 'licence check failed' : 'request failed')
        setTestResult({ error: `Test failed (HTTP ${resp.status}: ${reason})` })
      } else {
        const d = await resp.json()
        setTestResult(d)
      }
    } catch (err) {
      setTestResult({ error: err?.message || 'Test failed. Check your connection and try again.' })
    }
    setTesting(false)
  }

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '20px 0' }}>
      {/* Wizard progress coherence (Fable audit P2): ONE progress vocabulary,
          driven purely by the wizard step index. The old segment bar +
          separate tick row mixed completion-item state with step state and
          disagreed with the "Step N" headline on the same screen. The
          duplicate "Switch to Advanced Mode" micro-link is gone too; the
          header ModeToggle is the single mode control. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 20 }}>
        {WIZARD_STEPS.map((s, i) => {
          const state = i < step ? 'done' : (i === step ? 'current' : 'upcoming')
          return (
            <div key={s.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, position: 'relative' }}>
              {i > 0 && (
                <div style={{ position: 'absolute', top: 11, right: '50%', width: '100%', height: 2, background: i <= step ? 'rgba(168,85,247,0.5)' : 'rgba(255,255,255,0.08)', zIndex: 0 }} />
              )}
              <div style={{
                width: 22, height: 22, borderRadius: '50%', zIndex: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                background: state === 'done' ? '#30ff90' : (state === 'current' ? 'linear-gradient(135deg, #a855f7, #38bdf8)' : 'rgba(255,255,255,0.08)'),
                color: state === 'done' ? '#000' : (state === 'current' ? '#fff' : 'rgba(255,255,255,0.7)'),
                border: state === 'current' ? '1px solid rgba(255,255,255,0.35)' : '1px solid transparent',
                transition: 'background 0.3s',
              }}>
                {state === 'done' ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                ) : (i + 1)}
              </div>
              <div style={{ fontSize: 10, fontWeight: state === 'current' ? 700 : 500, color: state === 'current' ? '#fff' : 'rgba(255,255,255,0.7)', textAlign: 'center' }}>
                {s.label}
              </div>
            </div>
          )
        })}
      </div>

      {/* Step header */}
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>{currentStep.icon}</div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff', margin: '0 0 4px' }}>
          Step {step + 1}: {currentStep.label}
        </h2>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.65)', margin: 0 }}>{currentStep.description}</p>
      </div>

      {/* Step content */}
      <div style={{ padding: 20, background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, marginBottom: 16 }}>
        {step === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Widget Name</label>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g., Support Assistant" maxLength={50} style={{ width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Greeting Message</label>
              <input value={greeting} onChange={e => setGreeting(e.target.value)} placeholder="Hi! How can I help?" style={{ width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Business name, as your visitors know it</label>
              <input value={businessName} onChange={e => setBusinessName(e.target.value)} placeholder="e.g., Acme Plumbing" maxLength={120} style={{ width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Website Domain</label>
              <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="e.g., acme.com" style={{ width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
          </div>
        )}

        {step === 1 && (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <p style={{ fontSize: 13, color: '#fff', marginBottom: 12 }}>
              Add training data to make your widget smart. You can upload files, crawl a URL, or add Q&A pairs.
            </p>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
              You can do this later in the Widget Room → Knowledge tab. Skip for now and add it later.
            </p>
          </div>
        )}

        {step === 2 && (
          <div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <input value={testQuery} onChange={e => setTestQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleTest()} placeholder="Ask your widget something..." style={{ flex: 1, padding: '10px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: 13, fontFamily: 'inherit' }} />
              <button onClick={handleTest} disabled={testing} style={{ padding: '8px 16px', fontSize: 12, fontWeight: 700, background: testing ? 'rgba(168,85,247,0.3)' : 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(56,189,248,0.08))', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 8, cursor: testing ? 'not-allowed' : 'pointer', color: '#fff', fontFamily: 'inherit' }}>
                {testing ? '...' : 'Ask'}
              </button>
            </div>
            {testResult && testResult.error && (
              <div style={{ padding: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, fontSize: 13, color: '#ef4444', lineHeight: 1.5 }}>
                {testResult.error}
              </div>
            )}
            {testResult && !testResult.error && (
              <div style={{ padding: 12, background: 'rgba(0,0,0,0.2)', borderRadius: 8, fontSize: 13, color: '#fff', lineHeight: 1.5 }}>
                {testResult.response?.slice(0, 300)}{testResult.response?.length > 300 ? '...' : ''}
                {testResult.sources?.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {testResult.sources.map((s, i) => (
                      <span key={i} style={{ padding: '1px 6px', fontSize: 9, borderRadius: 3, background: s.pinned ? 'rgba(168,85,247,0.15)' : 'rgba(56,189,248,0.15)', color: s.pinned ? '#a855f7' : '#38bdf8', fontWeight: 600 }}>
                        {s.pinned ? 'Pinned' : 'Retrieved'} · {s.source}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginBottom: 10 }}>
              Copy this code and paste it before {'</body>'} on your website:
            </div>
            <pre style={{ padding: 14, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, fontSize: 11, color: '#38bdf8', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0 }}>
              {generateEmbedCode({ widgetId: widgetId || 'wid_preview', endpoint })}
            </pre>
            <button onClick={() => navigator.clipboard?.writeText(generateEmbedCode({ widgetId: widgetId || 'wid_preview', endpoint }))} style={{ marginTop: 8, padding: '6px 14px', fontSize: 11, fontWeight: 600, background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 6, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit' }}>
              Copy Code
            </button>
            <div style={{ marginTop: 12, fontSize: 11, lineHeight: 1.5, color: '#f59e0b' }}>
              A new widget is a draft: it answers previews only, and visitors on your site see "not live yet" until you press <strong>Go live</strong> in the Widget Room header.
            </div>
            {/* Point new operators at the live-chat essentials before they
                leave the wizard: alert routing lives on the Availability tab,
                and handed-off visitors are answered from Rooms → QuoxChat. */}
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: 11, lineHeight: 1.5, color: 'rgba(255,255,255,0.7)', background: 'rgba(48,255,144,0.05)', border: '1px solid rgba(48,255,144,0.15)' }}>
              <strong style={{ color: '#30ff90' }}>Going live with humans?</strong>{' '}
              Set who gets emailed when a visitor asks for a person in the <strong>Availability</strong> tab (Alerts section),
              and reply to live handoffs from the header's live-conversation pill or Rooms → QuoxChat.
            </div>
          </div>
        )}
      </div>

      {createError && step === 0 && (
        <div style={{ padding: '8px 12px', borderRadius: 8, fontSize: 11, color: '#ef4444', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)' }}>
          {createError}
        </div>
      )}

      {/* Navigation, sticky at the bottom of the scrolling ancestor
          (.quoxchat-view or .wr-content, both overflow-y: auto) so Save &
          Continue never gets clipped by the panel fold on shorter viewports. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', bottom: 0, zIndex: 2, padding: '10px 0', marginTop: 8, background: 'rgba(10,10,18,0.92)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={() => step > 0 ? setStep(step - 1) : null} disabled={step === 0} style={{ padding: '8px 16px', fontSize: 12, fontWeight: 500, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, cursor: step === 0 ? 'not-allowed' : 'pointer', color: 'rgba(255,255,255,0.65)', fontFamily: 'inherit', opacity: step === 0 ? 0.3 : 1 }}>
          Back
        </button>
        <button onClick={() => step < 3 ? setStep(step + 1) : null} style={{ padding: '4px 12px', fontSize: 10, color: 'rgba(255,255,255,0.65)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}>
          {step < 3 ? 'Skip' : ''}
        </button>
        {step === 0 ? (
          <button onClick={handleCreate} disabled={!name.trim() || creating} style={{ padding: '8px 20px', fontSize: 12, fontWeight: 700, background: !name.trim() || creating ? 'rgba(48,255,144,0.3)' : '#30ff90', border: 'none', borderRadius: 8, cursor: !name.trim() || creating ? 'not-allowed' : 'pointer', color: '#000' }}>
            {creating ? 'Saving...' : (existingWidget ? 'Save & Continue' : 'Create Widget')}
          </button>
        ) : step < 3 ? (
          <button onClick={() => setStep(step + 1)} style={{ padding: '8px 20px', fontSize: 12, fontWeight: 700, background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(56,189,248,0.08))', border: '1px solid rgba(168,85,247,0.3)', borderRadius: 8, cursor: 'pointer', color: '#fff', fontFamily: 'inherit' }}>
            Next
          </button>
        ) : (
          <button onClick={() => onComplete?.(widgetId)} style={{ padding: '8px 20px', fontSize: 12, fontWeight: 700, background: '#30ff90', border: 'none', borderRadius: 8, cursor: 'pointer', color: '#000' }}>
            Open Widget Room
          </button>
        )}
      </div>
    </div>
  )
}

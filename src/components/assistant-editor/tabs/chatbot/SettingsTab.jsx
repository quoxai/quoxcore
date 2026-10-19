/**
 * SettingsTab — Widget Room settings: domains, embed code, LLM, security
 *
 * CW-8: The "Install" and "Configure" tab for widget deployment.
 */

import { useState, useEffect } from 'react'
import { defaultEndpoint, generateEmbedCode, generateWebComponentCode, buildCompatLlmConfig, THEME_PRESETS, applyPresetToOverrides, PLATFORM_GUIDES } from '../../../../widget/settingsTabUtils'
import { validateDomain } from '../../../../widget/widgetSecurity'
import { keySourceLabel } from './planGateMessage'
import WidgetDangerZone from './WidgetDangerZone'
import { diffEmbedConfig } from './embedConfigPatch'

const PRO_INPUT = { padding: '5px 8px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 5, color: '#fff', fontSize: 11, fontFamily: 'inherit', boxSizing: 'border-box' }

// The server deep-merges embed_config: a key that was stored and is now
// removed must be sent as an explicit null; a key that was never stored is
// simply left out.
function clearKey(next, stored, key) {
  if (stored && stored[key] != null) next[key] = null
  else delete next[key]
}

// Hosts a visitor's browser cannot reach: localhost, loopback, RFC1918 ranges.
export function isNonPublicEndpoint(value) {
  const v = String(value || '').trim()
  if (!v) return false // empty = same-origin, not a host problem
  let host
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase() } catch { return false }
  host = host.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

export default function SettingsTab({ widget, authFetch, orgId, onWidgetChange, onDeleted }) {
  const config = widget?.embed_config || JSON.parse(widget?.embed_config_json || '{}')
  const initDomains = widget?.allowed_domains || JSON.parse(widget?.allowed_domains_json || '["localhost"]')

  const [copyAnyway, setCopyAnyway] = useState(false)
  const [domains, setDomains] = useState(initDomains)
  const [newDomain, setNewDomain] = useState('')
  const [embedMode, setEmbedMode] = useState('script')
  const [endpoint, setEndpoint] = useState(() => defaultEndpoint(config.endpoint))
  const [theme, setTheme] = useState(config.theme || 'auto')
  const [presetKey, setPresetKey] = useState(null)
  const [llmProvider, setLlmProvider] = useState(config.llm_provider || 'auto')
  // OpenAI-compatible endpoint (embed_config.llm). The key is a vault
  // credential reference only, never typed into the widget config.
  const [compatBaseUrl, setCompatBaseUrl] = useState(config.llm?.base_url || '')
  const [compatModel, setCompatModel] = useState(config.llm?.model || '')
  const [compatVaultId, setCompatVaultId] = useState(config.llm?.api_key_ref?.vault_id || '')
  const [compatAllowPrivate, setCompatAllowPrivate] = useState(Boolean(config.llm?.allow_private_origin))
  // QCL-BACKEND-UX #128 — P1-1 LLM budget caps, admin-editable. Blank/0 means
  // "no cap" (unset), matching the safe-default-OFF backend contract in
  // services/auth/routes/widgets.js /usage/current — never write an enforced
  // zero-budget.
  const [monthlyRequestCap, setMonthlyRequestCap] = useState(
    config.llm_budget?.monthly_request_cap != null ? String(config.llm_budget.monthly_request_cap) : '',
  )
  const [visitorDailyRequestCap, setVisitorDailyRequestCap] = useState(
    config.llm_budget?.visitor_daily_request_cap != null ? String(config.llm_budget.visitor_daily_request_cap) : '',
  )
  // P7: monthly LLM spend budget (website_widgets.monthly_budget_cents, dollars in
  // the input) and what to do when it is reached. Enforced by the collector.
  const initBudgetCents = Number.isFinite(widget?.monthly_budget_cents) && widget.monthly_budget_cents > 0 ? widget.monthly_budget_cents : null
  const initBudgetAction = widget?.budget_action || 'downgrade'
  const [budgetDollars, setBudgetDollars] = useState(initBudgetCents !== null ? String(initBudgetCents / 100) : '')
  const [budgetAction, setBudgetAction] = useState(initBudgetAction)
  // QC-LINKS: curated site map, embed_config.site_links. Mirrors the server
  // filter in services/collector/routes/quoxchat.js (https:// only, title
  // required, 200 entries max) so invalid rows never round-trip to the API.
  const [siteLinks, setSiteLinks] = useState(
    Array.isArray(config.site_links) ? config.site_links.map(l => ({ title: l?.title || '', url: l?.url || '' })) : [],
  )
  // QUOXCHAT-BRUTALOOP: answer claim check (embed_config.grounding.verify_claims,
  // default ON). Visible here so the switch is never env-only.
  const [verifyClaims, setVerifyClaims] = useState(config?.grounding?.verify_claims !== false)
  // Verified streaming (default) holds the reply until the claim check passes;
  // 'live' shows text as it is written and can briefly show unverified claims.
  const [liveStream, setLiveStream] = useState(config?.grounding?.stream_mode === 'live')
  // P-V: proactive engagement rules (Professional), embed_config.proactive.
  // Mirrors services/collector/lib/quoxchatProactive.js (10 rules, 280-char
  // message, 1-600s delay, 1-10 shows per visitor); the collector re-validates.
  const [proactive, setProactive] = useState(
    Array.isArray(config.proactive)
      ? config.proactive.slice(0, 10).map(r => ({
        match: r?.match || '', message: r?.message || '',
        delay_seconds: r?.delay_seconds ?? 8, max_per_visitor: r?.max_per_visitor ?? 1,
      }))
      : [],
  )
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)
  // QCL-BACKEND-UX #131 — read-only "current usage this month" line, the
  // piece #128 deferred. Server-side is the source of truth (no local
  // computation from cached state); a failed/empty fetch just leaves this
  // null (line stays hidden) rather than showing a fake zero.
  const [usage, setUsage] = useState(null)

  const widgetId = widget?.id || 'wid_preview'
  const publicKey = widget?.public_key || widgetId

  useEffect(() => {
    if (!authFetch || !orgId || !widget?.id) return
    let cancelled = false
    authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/usage/current`)
      .then(r => (r && r.ok ? r.json() : null))
      .then(data => {
        if (cancelled) return
        setUsage(data && typeof data === 'object' && typeof data.requests === 'number' ? data : null)
      })
      .catch(() => { if (!cancelled) setUsage(null) })
    return () => { cancelled = true }
  }, [authFetch, orgId, widget?.id])

  // Blank or 0 -> undefined (unset/no-cap). Only a positive integer is written.
  const parseCap = (value) => {
    const n = parseInt(value, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }

  // QC-LINKS row validation, mirrors the server-side filter exactly.
  const isValidLinkTitle = (t) => typeof t === 'string' && t.trim().length > 0
  const isValidLinkUrl = (u) => typeof u === 'string' && /^https:\/\//i.test(u.trim())

  const addSiteLink = () => {
    if (siteLinks.length >= 200) return
    setSiteLinks([...siteLinks, { title: '', url: '' }])
  }
  const removeSiteLink = (idx) => setSiteLinks(siteLinks.filter((_, i) => i !== idx))
  const updateSiteLink = (idx, field, value) => setSiteLinks(siteLinks.map((l, i) => (i === idx ? { ...l, [field]: value } : l)))

  const isValidProactiveRow = (r) => typeof r.match === 'string' && r.match.trim().length > 0 && r.match.trim().length <= 200
    && typeof r.message === 'string' && r.message.trim().length > 0
  const addProactive = () => {
    if (proactive.length >= 10) return
    setProactive([...proactive, { match: '', message: '', delay_seconds: 8, max_per_visitor: 1 }])
  }
  const removeProactive = (idx) => setProactive(proactive.filter((_, i) => i !== idx))
  const updateProactive = (idx, field, value) => setProactive(proactive.map((r, i) => (i === idx ? { ...r, [field]: value } : r)))

  // Save settings to auth DB
  const saveSettings = async () => {
    if (!authFetch || !orgId || !widget?.id) return
    setSaving(true)
    setSaveMsg(null)
    try {
      // The server deep-merges embed_config, so a removed key is sent as an
      // explicit null (absent keys are kept, which is what stops two tabs
      // overwriting each other).
      const nextConfig = { ...config, theme, greeting: config.greeting, llm_provider: llmProvider, endpoint: endpoint.trim() || null }
      if (presetKey && THEME_PRESETS[presetKey]) {
        const pr = THEME_PRESETS[presetKey]
        nextConfig.accent_color = pr.accent
        nextConfig.style_overrides = applyPresetToOverrides(config.style_overrides, pr)
      }
      if (llmProvider === 'openai_compatible') {
        const built = buildCompatLlmConfig({ baseUrl: compatBaseUrl, model: compatModel, vaultId: compatVaultId, allowPrivate: compatAllowPrivate })
        if (!built.ok) {
          setSaveMsg({ type: 'error', text: built.error })
          setSaving(false)
          return
        }
        nextConfig.llm = built.config
      } else {
        clearKey(nextConfig, config, 'llm')
      }
      const llmBudget = {}
      const monthlyCap = parseCap(monthlyRequestCap)
      const visitorCap = parseCap(visitorDailyRequestCap)
      if (monthlyCap !== undefined) llmBudget.monthly_request_cap = monthlyCap
      if (visitorCap !== undefined) llmBudget.visitor_daily_request_cap = visitorCap
      if (Object.keys(llmBudget).length > 0) {
        nextConfig.llm_budget = llmBudget
      } else {
        clearKey(nextConfig, config, 'llm_budget')
      }
      // Only valid rows are written, exactly mirroring the server filter.
      const validSiteLinks = siteLinks
        .filter(l => isValidLinkTitle(l.title) && isValidLinkUrl(l.url))
        .slice(0, 200)
        .map(l => ({ title: l.title.trim().slice(0, 80), url: l.url.trim().slice(0, 200) }))
      if (validSiteLinks.length > 0) {
        nextConfig.site_links = validSiteLinks
      } else {
        clearKey(nextConfig, config, 'site_links')
      }
      const validProactive = proactive
        .filter(isValidProactiveRow)
        .slice(0, 10)
        .map(r => ({
          match: r.match.trim().slice(0, 200),
          message: r.message.trim().slice(0, 280),
          delay_seconds: Math.min(600, Math.max(1, parseInt(r.delay_seconds, 10) || 8)),
          max_per_visitor: Math.min(10, Math.max(1, parseInt(r.max_per_visitor, 10) || 1)),
        }))
      if (validProactive.length > 0) {
        nextConfig.proactive = validProactive
      } else {
        clearKey(nextConfig, config, 'proactive')
      }
      nextConfig.grounding = { ...(nextConfig.grounding || {}), verify_claims: verifyClaims, stream_mode: liveStream ? 'live' : 'verified' }
      const patch = {
        allowed_domains_json: JSON.stringify(domains),
        embed_config_json: JSON.stringify(diffEmbedConfig(config, nextConfig)),
      }
      // Budget fields are only sent when the operator changed them.
      const dollars = parseFloat(budgetDollars)
      const nextBudgetCents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null
      if (nextBudgetCents !== initBudgetCents) patch.monthly_budget_cents = nextBudgetCents
      if (budgetAction !== initBudgetAction) patch.budget_action = budgetAction
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (resp.ok) {
        try { const d = await resp.json(); if (d?.widget && onWidgetChange) onWidgetChange(d.widget) } catch {}
        setSaveMsg({ type: 'success', text: 'Settings saved' })
      } else {
        const err = await resp.json().catch(() => ({}))
        setSaveMsg({ type: 'error', text: err.error || 'Failed to save' })
      }
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 3000)
    }
  }

  // CW-SEC-1: embed code exposes public_key (rotation-safe), not internal widget.id.
  // Auth-side internal endpoints resolve by (id OR public_key) so persist-message /
  // knowledge-sources / allowed-domains / ensure-conversation all work either way.
  const embedConfig = { widgetId: publicKey, endpoint, theme, position: config.position || 'bottom-right', showBranding: false }
  const code = embedMode === 'script' ? generateEmbedCode(embedConfig) : generateWebComponentCode(embedConfig)

  const endpointNonPublic = isNonPublicEndpoint(endpoint)
  const copyBlocked = endpointNonPublic && !copyAnyway

  const handleCopy = () => {
    if (copyBlocked) return
    navigator.clipboard?.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const addDomain = () => {
    const d = newDomain.trim().toLowerCase()
    if (!d || domains.includes(d)) return
    setDomains([...domains, d])
    setNewDomain('')
  }

  const removeDomain = (d) => setDomains(domains.filter(x => x !== d))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* ── Embed Code ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Install Widget</div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', display: 'block', marginBottom: 4 }}>
            Your Core endpoint URL
          </label>
          <input
            value={endpoint} onChange={e => setEndpoint(e.target.value)}
            placeholder="https://your-core.com (or leave empty for same-origin)"
            style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.65)', display: 'block', marginTop: 3 }}>
            If Core has a public IP, use that. Behind NAT? Use Tailscale Funnel or Cloudflare Tunnel URL.
          </span>
        </div>

        {endpointNonPublic && (
          <div role="alert" data-testid="endpoint-warning" style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 6, fontSize: 11, lineHeight: 1.5, background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b' }}>
            This endpoint ({endpoint.trim()}) is a local or private address. Your visitors' browsers cannot reach it, so the widget will not load on your site. Set your public Core address in the "Your Core endpoint URL" field above.
            {' '}
            <button type="button" onClick={() => setCopyAnyway(v => !v)} style={{ background: 'none', border: 'none', padding: 0, color: '#f59e0b', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}>
              {copyAnyway ? 'Block copying again' : 'Copy anyway for local testing'}
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {[{ id: 'script', label: 'Script Tag' }, { id: 'component', label: 'Web Component' }].map(m => (
            <button key={m.id} onClick={() => setEmbedMode(m.id)} style={{
              padding: '5px 12px', fontSize: 11, fontWeight: embedMode === m.id ? 700 : 500,
              background: embedMode === m.id ? 'rgba(168,85,247,0.12)' : 'transparent',
              border: embedMode === m.id ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)',
              borderRadius: 6, cursor: 'pointer', color: embedMode === m.id ? '#fff' : 'rgba(255,255,255,0.65)', fontFamily: 'inherit',
            }}>{m.label}</button>
          ))}
        </div>

        <div style={{ position: 'relative' }}>
          <pre style={{
            padding: 14, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 8, fontSize: 11, color: '#38bdf8', fontFamily: "'JetBrains Mono', monospace",
            lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0, overflow: 'auto',
          }}>
            {code}
          </pre>
          <button onClick={handleCopy} disabled={copyBlocked} title={copyBlocked ? 'Set a public endpoint first' : undefined} style={{
            opacity: copyBlocked ? 0.5 : 1,
            position: 'absolute', top: 8, right: 8, padding: '4px 10px', fontSize: 10, fontWeight: 600,
            background: copied ? 'rgba(48,255,144,0.1)' : 'rgba(255,255,255,0.06)',
            border: `1px solid ${copied ? 'rgba(48,255,144,0.2)' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 5, cursor: copyBlocked ? 'not-allowed' : 'pointer', color: copied ? '#30ff90' : 'rgba(255,255,255,0.7)', fontFamily: 'inherit',
          }}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        {/* Preview link — opens the widget on a standalone demo page */}
        {publicKey && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <a
              href={`/quoxchat-demo.html?widget=${encodeURIComponent(publicKey)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', fontSize: 11, fontWeight: 600,
                background: 'rgba(168,85,247,0.08)',
                border: '1px solid rgba(168,85,247,0.25)',
                borderRadius: 6, color: '#a855f7',
                textDecoration: 'none', fontFamily: 'inherit',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
              Preview this widget on a demo page
            </a>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
              Opens a standalone page so you can share a live preview with stakeholders.
            </span>
          </div>
        )}

        {/* Platform guides */}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)', marginBottom: 6 }}>Platform Guides</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {Object.entries(PLATFORM_GUIDES).map(([key, guide]) => (
              <span key={key} title={guide.instructions} style={{
                padding: '3px 8px', fontSize: 9, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 4, color: 'rgba(255,255,255,0.65)', cursor: 'help',
              }}>{guide.label}</span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Domains ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Allowed Domains</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginBottom: 8 }}>
          The widget will only load on these domains. Use *.example.com for all subdomains.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {domains.map(d => (
            <div key={d} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
              background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: 6,
            }}>
              <span style={{ flex: 1, fontSize: 12, color: '#fff', fontFamily: "'JetBrains Mono', monospace" }}>
                {d}
                {d === 'localhost' && (
                  <>
                    {' '}
                    <span data-testid="localhost-tag" style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4, padding: '1px 6px', fontFamily: 'inherit' }}>testing</span>
                    <span data-testid="localhost-hint" style={{ display: 'block', fontSize: 10, color: 'rgba(255,255,255,0.65)', fontFamily: 'inherit', marginTop: 2 }}>
                      Added automatically so you can preview. Remove it before launch.
                    </span>
                  </>
                )}
              </span>
              <button aria-label={`Remove ${d}`} onClick={() => removeDomain(d)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={newDomain} onChange={e => setNewDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addDomain()}
            placeholder="acme.com or *.acme.com"
            style={{ flex: 1, padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit' }}
          />
          <button onClick={addDomain} style={{
            padding: '6px 14px', fontSize: 11, fontWeight: 600,
            background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)',
            borderRadius: 6, cursor: 'pointer', color: '#38bdf8', fontFamily: 'inherit',
          }}>Add</button>
        </div>
      </div>

      {/* ── Site links (QC-LINKS) ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Site links</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginBottom: 8 }}>
          Curated pages the assistant may link to when answering. The model only hands out links from this list, it never invents URLs.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {siteLinks.map((link, idx) => {
            const titleOk = isValidLinkTitle(link.title)
            const urlOk = isValidLinkUrl(link.url)
            const rowInvalid = !titleOk || !urlOk
            return (
              <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                  background: 'rgba(0,0,0,0.15)',
                  border: `1px solid ${rowInvalid ? 'rgba(239,68,68,0.35)' : 'rgba(255,255,255,0.04)'}`,
                  borderRadius: 6,
                }}>
                  <input
                    value={link.title}
                    onChange={e => updateSiteLink(idx, 'title', e.target.value)}
                    placeholder="Title"
                    maxLength={80}
                    style={{ width: 160, padding: '5px 8px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 5, color: '#fff', fontSize: 11, fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                  <input
                    value={link.url}
                    onChange={e => updateSiteLink(idx, 'url', e.target.value)}
                    placeholder="https://example.com/page"
                    maxLength={200}
                    style={{ flex: 1, padding: '5px 8px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 5, color: '#fff', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", boxSizing: 'border-box' }}
                  />
                  <button onClick={() => removeSiteLink(idx)} title="Remove link" style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    background: 'none', border: 'none', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', padding: 2,
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                  </button>
                </div>
                {rowInvalid && (
                  <span style={{ fontSize: 9, color: '#ef4444', paddingLeft: 10 }}>
                    {!titleOk ? 'Title required' : ''}{!titleOk && !urlOk ? ', ' : ''}{!urlOk ? 'URL must start with https://' : ''}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button onClick={addSiteLink} disabled={siteLinks.length >= 200} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', fontSize: 11, fontWeight: 600,
            background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)',
            borderRadius: 6, cursor: siteLinks.length >= 200 ? 'not-allowed' : 'pointer',
            opacity: siteLinks.length >= 200 ? 0.5 : 1,
            color: '#38bdf8', fontFamily: 'inherit',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            Add link
          </button>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{siteLinks.length}/200</span>
        </div>
      </div>

      {/* ── Answer claim check (QUOXCHAT-BRUTALOOP) ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Answer claim check</div>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.85)', cursor: 'pointer' }}>
          <input type="checkbox" data-testid="verify-claims-toggle" checked={verifyClaims} onChange={e => setVerifyClaims(e.target.checked)} />
          <span>
            Check every answer for claims your knowledge does not support (certifications, features, policies) and correct or remove them before the visitor sees them.
            Adds one small model call per answer. Recommended on.
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'rgba(255,255,255,0.85)', cursor: 'pointer', marginTop: 10 }}>
          <input type="checkbox" data-testid="live-stream-toggle" checked={liveStream} onChange={e => setLiveStream(e.target.checked)} />
          <span>
            Show answers live while they are written.
            Warning: live text appears before the claim check finishes, so a visitor can briefly see a claim that is then removed.
            Leave off (verified streaming) and visitors only ever see the checked answer, which appears after a short pause.
          </span>
        </label>
      </div>

      {/* ── Proactive greetings (P-V, Professional) ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Proactive greetings</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginBottom: 8 }}>
          Professional plan. Show a small greeting bubble after a delay on matching pages. It never opens the chat or takes focus,
          and each rule shows at most the set number of times per visitor. Match a path like /pricing, a glob like /docs/*,
          or a regular expression wrapped in slashes.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {proactive.map((rule, idx) => (
            <div key={idx} data-testid="proactive-row" style={{
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 10px',
              background: 'rgba(0,0,0,0.15)',
              border: `1px solid ${isValidProactiveRow(rule) ? 'rgba(255,255,255,0.04)' : 'rgba(239,68,68,0.35)'}`,
              borderRadius: 6,
            }}>
              <input aria-label={`Rule ${idx + 1} page match`} value={rule.match} maxLength={200}
                onChange={e => updateProactive(idx, 'match', e.target.value)} placeholder="/pricing"
                style={{ width: 150, ...PRO_INPUT, fontFamily: "'JetBrains Mono', monospace" }} />
              <input aria-label={`Rule ${idx + 1} message`} value={rule.message} maxLength={280}
                onChange={e => updateProactive(idx, 'message', e.target.value)} placeholder="Questions about plans? Ask me."
                style={{ flex: 1, minWidth: 180, ...PRO_INPUT }} />
              <input aria-label={`Rule ${idx + 1} delay seconds`} type="number" min="1" max="600" value={rule.delay_seconds}
                onChange={e => updateProactive(idx, 'delay_seconds', e.target.value)}
                style={{ width: 60, ...PRO_INPUT }} title="Delay in seconds" />
              <input aria-label={`Rule ${idx + 1} max shows per visitor`} type="number" min="1" max="10" value={rule.max_per_visitor}
                onChange={e => updateProactive(idx, 'max_per_visitor', e.target.value)}
                style={{ width: 52, ...PRO_INPUT }} title="Max shows per visitor" />
              <button onClick={() => removeProactive(idx)} title="Remove rule" aria-label={`Remove rule ${idx + 1}`} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', padding: 2,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button onClick={addProactive} disabled={proactive.length >= 10} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', fontSize: 11, fontWeight: 600,
            background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)',
            borderRadius: 6, cursor: proactive.length >= 10 ? 'not-allowed' : 'pointer',
            opacity: proactive.length >= 10 ? 0.5 : 1,
            color: '#38bdf8', fontFamily: 'inherit',
          }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
            Add rule
          </button>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{proactive.length}/10</span>
        </div>
      </div>

      {/* ── Theme ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Theme</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {Object.entries(THEME_PRESETS).map(([key, preset]) => (
            <button key={key} onClick={() => { setPresetKey(key); setTheme(preset.theme) }} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
              background: presetKey === key ? 'rgba(168,85,247,0.1)' : 'rgba(0,0,0,0.12)',
              border: presetKey === key ? '1px solid rgba(168,85,247,0.25)' : '1px solid rgba(255,255,255,0.04)',
              borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
            }}>
              <span style={{ width: 14, height: 14, borderRadius: '50%', background: preset.accent, flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: presetKey === key ? '#fff' : 'rgba(255,255,255,0.65)', fontWeight: presetKey === key ? 700 : 500 }}>
                {preset.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── LLM Provider ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>LLM Provider</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginBottom: 8 }}>
          Which model family answers visitor messages. Uses the org's API key for the chosen provider.
          Auto prefers OpenAI, then Anthropic, then Gemini when multiple keys are configured.
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { id: 'auto', label: 'Auto', hint: 'Pick based on available keys' },
            { id: 'openai', label: 'OpenAI', hint: 'gpt-4.1-mini · cost/perf sweet spot' },
            { id: 'anthropic', label: 'Anthropic', hint: 'Claude Haiku 4.5 · strong reasoning' },
            { id: 'gemini', label: 'Gemini', hint: 'gemini-2.5-flash · cheapest' },
            { id: 'openai_compatible', label: 'OpenAI-compatible', hint: 'Ollama, vLLM, or any compatible endpoint' },
          ].map(p => (
            <button
              key={p.id}
              onClick={() => setLlmProvider(p.id)}
              title={p.hint}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                padding: '8px 14px', minWidth: 120,
                background: llmProvider === p.id ? 'rgba(168,85,247,0.1)' : 'rgba(0,0,0,0.12)',
                border: llmProvider === p.id ? '1px solid rgba(168,85,247,0.25)' : '1px solid rgba(255,255,255,0.04)',
                borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 12, color: llmProvider === p.id ? '#fff' : 'rgba(255,255,255,0.8)', fontWeight: llmProvider === p.id ? 700 : 600 }}>
                {p.label}
              </span>
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>{p.hint}</span>
            </button>
          ))}
        </div>
        {llmProvider === 'openai_compatible' && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 520 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>Base URL (chat/completions is added for you)</span>
              <input aria-label="Base URL" value={compatBaseUrl} onChange={e => setCompatBaseUrl(e.target.value)} placeholder="http://10.0.0.5:11434/v1" style={{ ...PRO_INPUT, fontSize: 12, padding: '7px 10px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>Model name</span>
              <input aria-label="Model name" value={compatModel} onChange={e => setCompatModel(e.target.value)} placeholder="llama3.1:8b" style={{ ...PRO_INPUT, fontSize: 12, padding: '7px 10px' }} />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>API key (optional): vault credential ID</span>
              <input aria-label="Vault credential ID" value={compatVaultId} onChange={e => setCompatVaultId(e.target.value)} placeholder="Leave empty for Ollama and other key-less servers" style={{ ...PRO_INPUT, fontSize: 12, padding: '7px 10px' }} />
              <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>The key itself lives in the org vault and is never stored in the widget config.</span>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 10px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 8, cursor: 'pointer' }}>
              <input type="checkbox" aria-label="Allow private endpoint" checked={compatAllowPrivate} onChange={e => setCompatAllowPrivate(e.target.checked)} style={{ marginTop: 2 }} />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.8)' }}>
                <strong>Allow this private address</strong>
                <span style={{ display: 'block', fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 2 }}>
                  Turn on only for a server on your own network (for example Ollama or vLLM on a private IP).
                  This lets Quox's server connect to exactly that address and port for this widget. Anyone who can edit
                  this widget could then reach that machine through it, so allow only a host you trust. Needs an org admin to save.
                  Public endpoints do not need this.
                </span>
                {compatAllowPrivate && compatBaseUrl && (() => {
                  try { return <span style={{ display: 'block', fontSize: 10, color: '#fbbf24', marginTop: 4 }}>Allowed origin: {new URL(compatBaseUrl.trim()).origin}</span> } catch { return null }
                })()}
              </span>
            </label>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>
              Visitor messages go to this endpoint only. Failover to a cloud provider stays off unless you set an explicit failover order.
            </div>
          </div>
        )}
      </div>

      {/* ── Usage & budget (QCL-BACKEND-UX #128 / P1-1) ── */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Usage &amp; budget</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginBottom: 8 }}>
          Optional caps on LLM requests for this widget. Leave blank (or 0) for no cap, which
          matches today's behaviour exactly. Requests are counted per visitor turn.
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>
              Monthly request cap (org-wide, this widget)
            </span>
            <input
              type="number"
              min="0"
              step="1"
              aria-label="Monthly request cap"
              value={monthlyRequestCap}
              onChange={e => setMonthlyRequestCap(e.target.value)}
              placeholder="No cap"
              style={{ padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>
              Visitor daily request cap (per browser/session)
            </span>
            <input
              type="number"
              min="0"
              step="1"
              aria-label="Visitor daily request cap"
              value={visitorDailyRequestCap}
              onChange={e => setVisitorDailyRequestCap(e.target.value)}
              placeholder="No cap"
              style={{ padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>
              Monthly LLM budget (USD, estimated from token use)
            </span>
            <input
              type="number" min="0" step="0.01"
              aria-label="Monthly LLM budget"
              value={budgetDollars}
              onChange={e => setBudgetDollars(e.target.value)}
              placeholder="No budget"
              style={{ padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>
              When the budget is reached
            </span>
            <select
              aria-label="When the budget is reached"
              value={budgetAction}
              onChange={e => setBudgetAction(e.target.value)}
              style={{ padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' }}
            >
              <option value="downgrade">Keep answering on the cheapest model</option>
              <option value="continue">Keep answering (just tell me)</option>
              <option value="unavailable">Stop: show an unavailable message</option>
              <option value="message">Stop: ask visitors to try later</option>
              <option value="hide">Stop: hide the chat</option>
            </select>
          </label>
        </div>
        {/* QCL-BACKEND-UX #131 — deferred usage line #128 left out. Read-only;
            reuses the org-scoped usage endpoint (no separate fetch pattern). */}
        {usage && (
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', marginTop: 10 }}>
            Current usage this month: {usage.requests ?? 0} request{usage.requests === 1 ? '' : 's'} used
            {Number.isFinite(usage.caps?.monthly_requests) && usage.caps.monthly_requests > 0
              ? ` of ${usage.caps.monthly_requests} (${Math.max(0, usage.remaining?.monthly_requests ?? 0)} remaining)`
              : ' (no monthly cap set)'}
          </div>
        )}
        {usage?.budget && usage.budget.monthly_budget_cents > 0 && (
          <div style={{ fontSize: 10, marginTop: 6, color: usage.budget.exceeded ? '#ef4444' : 'rgba(255,255,255,0.55)', fontWeight: usage.budget.exceeded ? 700 : 400 }}>
            Estimated LLM spend this month: ${(usage.budget.spent_micro_usd / 1e6).toFixed(2)} of ${(usage.budget.monthly_budget_cents / 100).toFixed(2)}.
            {usage.budget.exceeded ? ` Budget reached: action is "${usage.budget.action}". Visitors are not shown any cost details.` : ''}
          </div>
        )}
        {usage && (
          <div style={{ fontSize: 10, marginTop: 6, color: usage.llm_key_source === 'instance_env' ? '#f59e0b' : 'rgba(255,255,255,0.55)' }}>
            {usage.llm_key_source
              ? <>Key source: {keySourceLabel(usage.llm_key_source)}</>
              : 'Key source: not known yet (shown after the first answered message this month).'}
            {' '}Answers can also be checked by a second provider (claim verifier) when one is configured.
          </div>
        )}
      </div>

      {/* Save button + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={saveSettings} disabled={saving} style={{
          padding: '8px 20px', fontSize: 12, fontWeight: 700,
          background: saving ? 'rgba(48,255,144,0.5)' : '#30ff90',
          border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', color: '#000',
        }}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        {saveMsg && (
          <span style={{ fontSize: 12, fontWeight: 600, color: saveMsg.type === 'success' ? '#30ff90' : '#ef4444' }}>
            {saveMsg.text}
          </span>
        )}
      </div>

      <WidgetDangerZone widget={widget} authFetch={authFetch} orgId={orgId} onWidgetChange={onWidgetChange} onDeleted={onDeleted} />
    </div>
  )
}

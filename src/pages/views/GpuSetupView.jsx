/**
 * GpuSetupView — QuoxGPU-guided GPU compute onboarding wizard.
 *
 * Takes a user from "what do you want to run?" → sized GPU → BYO/rented
 * compute → auto-enrolled node → live, governed fleet member. Guided track
 * (QuoxGPU narrates) + Advanced track (raw config for operators).
 *
 * Design spec: docs/STREAM_QUOXGPU_SETUP_WIZARD.md
 * Visual reference: docs/design/fable-gpu-setup.mock.html
 * P2 wires the real collector substrate (B1/B1b — QUOXGPU #149):
 *   - POST /api/v1/gpu/enroll/issue  → real single-use `qxg_` token (Provision step)
 *   - GET  /api/v1/gpu/nodes         → durable GPU fleet, polled on the Enroll step
 * If no real node has checked in (the common case in dev), the wizard offers
 * an explicitly-labelled PREVIEW walkthrough for steps 4-6 instead of faking
 * a real enrolment.
 *
 * Built with .qx-* globals only (see glass-design-system skill) — no per-view CSS.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { csrfFetch } from '../../utils/csrfFetch'
import { RunPodLogo, LambdaLogo, VastLogo } from './gpuProviderLogos'

// ─────────────────────────────────────────────────────────────────────────
// Static content (ported from docs/design/fable-gpu-setup.mock.html)
// ─────────────────────────────────────────────────────────────────────────

const STEPS = [
  { key: 'intent', n: '01', rail: 'Intent', title: 'What are you trying to run?' },
  { key: 'match', n: '02', rail: 'Match', title: 'QuoxGPU sized the hardware' },
  { key: 'provision', n: '03', rail: 'Provision', title: 'Provision compute' },
  { key: 'enroll', n: '04', rail: 'Enroll', title: 'Bringing the node online' },
  { key: 'verify', n: '05', rail: 'Verify', title: 'Node verified' },
  { key: 'governed', n: '06', rail: 'Governed', title: 'Joined your governed fleet' },
]

const INTENTS = {
  llama70b: { label: 'Llama-3.1 70B', sub: 'chat · 4-bit', vram: '48 GB+', mig: false, gpu: 'NVIDIA A100 80GB', backend: 'vLLM', model: 'Llama-3.1-70B-Instruct' },
  embed: { label: 'Embeddings at scale', sub: 'bge / e5', vram: '16 GB', mig: true, gpu: 'NVIDIA A100 · 1 MIG slice', backend: 'NIM', model: 'nv-embed-v2' },
  sdxl: { label: 'Image · SDXL', sub: 'diffusion', vram: '24 GB', mig: false, gpu: 'NVIDIA L40S 48GB', backend: 'llama.cpp', model: 'sdxl-1.0' },
  custom: { label: 'Bring my own', sub: 'custom model', vram: 'you choose', mig: false, gpu: '—', backend: 'auto-detect', model: '—' },
}

// Quox is the enabler/router, NOT a reseller — we never provision GPUs or
// touch payment/billing. BYO is the first-class, real-today path (we issue
// a real qxg_ token and the operator runs it on any box they already own or
// rent). The curated providers below are pure deep-links out to that
// provider's own console — the operator provisions + pays THEM directly,
// then returns and pastes the same token. No our-looking prices here.
// See docs/STREAM_QUOXGPU_SETUP_WIZARD.md → "Provisioning & payment model".
const PROVIDERS = {
  byo: { name: 'Bring your own box', sub: 'Any Linux host with an NVIDIA GPU, owned or rented', url: null },
  runpod: { name: 'RunPod', sub: 'Provision & pay on RunPod, then paste your token', url: 'https://www.runpod.io/console/deploy', Logo: RunPodLogo },
  lambda: { name: 'Lambda', sub: 'Provision & pay on Lambda, then paste your token', url: 'https://cloud.lambda.ai', Logo: LambdaLogo },
  vast: { name: 'Vast.ai', sub: 'Provision & pay on Vast.ai, then paste your token', url: 'https://cloud.vast.ai', Logo: VastLogo },
}
// Render order for the "Or rent one:" deep-link row (guided Match step).
const RENT_PROVIDER_KEYS = ['runpod', 'lambda', 'vast']

const NSTATE_LABELS = ['awaiting intent', 'spec locked', 'provider chosen', 'enrolling…', 'online · healthy', 'governed']

const RUNLOG_GUIDED = (it) => ([
  'handshake accepted · host id pinned',
  `GPU detected · ${it ? it.gpu : 'NVIDIA GPU'}`,
  'scanning inference backends',
  `${it ? it.backend : 'backend'} found · model loaded`,
  'first heartbeat green',
])

const RUNLOG_ADVANCED = (it) => ([
  'POST /api/v1/heartbeat · 200 · host pinned',
  `nvml.DeviceGetCount → ${it && it.mig ? '1 (MIG)' : '1'}`,
  'prober order: ollama→nim→llama.cpp→vllm',
  `${it ? it.backend : 'vllm'} · /v1/models · 200`,
  'cache warm · heartbeat cadence 30s',
])

// Real, externally-reachable collector base URL — mirrors
// MCPCredentialsPanel/ClaudeDesktopInstall/AgentFleetPanel's convention
// exactly (VITE_COLLECTOR_URL override, else protocol//hostname:9848).
function getCollectorBaseUrl() {
  if (typeof window === 'undefined') return 'http://localhost:9848'
  if (import.meta.env.VITE_COLLECTOR_URL) return import.meta.env.VITE_COLLECTOR_URL
  return `${window.location.protocol}//${window.location.hostname}:9848`
}
const COLLECTOR_URL = getCollectorBaseUrl()

// Mock fallbacks — ONLY ever rendered inside the explicitly-labelled
// PREVIEW walkthrough (no real node connected). The real token/digest/host
// come from POST /api/v1/gpu/enroll/issue and GET /api/v1/gpu/nodes. The
// Provision step always shows the real issued token (steps 4-6 are what the
// PREVIEW toggle mocks), so there's no mock-token constant here.
const MOCK_WARD_HASH = '7f3c…a91e'
const MOCK_HOST_ID = 'gpu-node-07'

const CMD_TEXT_ADVANCED = `curl -fsSL quox.ai/gpu | sudo bash -s -- --config ./config.yaml`

// ─────────────────────────────────────────────────────────────────────────
// Octahedron canvas — ported vertex/edge/rotation math from the mockup.
// Colour mapped from the mockup's bespoke green (--sig) to the dashboard's
// status-online token (#30ff90 / rgb 48,255,144) to stay on-palette.
// ─────────────────────────────────────────────────────────────────────────

const OCT_V = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const OCT_E = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [4, 3], [3, 5], [5, 2]]
const OCT_FACES = [[0, 2, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 2, 4], [1, 4, 3], [1, 3, 5], [1, 5, 2]]
const OCT_COLOR = '48,255,144'
const OCT_HILITE = '150,255,189'

function rotPoint(p, ax, ay) {
  const [x, y, z] = p
  const z1 = z * Math.cos(ax) - y * Math.sin(ax)
  const y1 = z * Math.sin(ax) + y * Math.cos(ax)
  const x2 = x * Math.cos(ay) - z1 * Math.sin(ay)
  const z2 = x * Math.sin(ay) + z1 * Math.cos(ay)
  return [x2, y1, z2]
}

function drawOctahedron(ctx, w, h, pr, t) {
  ctx.clearRect(0, 0, w, h)
  const cxp = w / 2
  const cyp = h / 2
  const R = Math.min(w, h) * 0.30
  const ax = 0.5 + Math.sin(t * 0.6) * 0.15
  const pts = OCT_V.map((p) => {
    const r = rotPoint(p, ax, t)
    return [cxp + r[0] * R, cyp + r[1] * R, r[2]]
  })

  const glow = ctx.createRadialGradient(cxp, cyp, 0, cxp, cyp, R * 2.4)
  glow.addColorStop(0, `rgba(${OCT_COLOR},${0.05 + pr * 0.16})`)
  glow.addColorStop(1, `rgba(${OCT_COLOR},0)`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, w, h)

  ctx.lineJoin = 'round'
  OCT_FACES.forEach((f) => {
    const depth = (pts[f[0]][2] + pts[f[1]][2] + pts[f[2]][2]) / 3
    ctx.beginPath()
    ctx.moveTo(pts[f[0]][0], pts[f[0]][1])
    ctx.lineTo(pts[f[1]][0], pts[f[1]][1])
    ctx.lineTo(pts[f[2]][0], pts[f[2]][1])
    ctx.closePath()
    const a = (0.04 + pr * 0.20) * (depth > 0 ? 1 : 0.4)
    ctx.fillStyle = `rgba(${OCT_COLOR},${a})`
    ctx.fill()
  })

  ctx.lineWidth = 1.4
  ctx.strokeStyle = `rgba(${OCT_COLOR},${0.28 + pr * 0.55})`
  ctx.shadowBlur = 8 + pr * 22
  ctx.shadowColor = `rgba(${OCT_COLOR},${0.4 * pr})`
  OCT_E.forEach((e) => {
    ctx.beginPath()
    ctx.moveTo(pts[e[0]][0], pts[e[0]][1])
    ctx.lineTo(pts[e[1]][0], pts[e[1]][1])
    ctx.stroke()
  })
  ctx.shadowBlur = 0

  pts.forEach((p) => {
    ctx.beginPath()
    ctx.arc(p[0], p[1], 2.2 + pr * 1.4, 0, Math.PI * 2)
    ctx.fillStyle = p[2] > 0 ? `rgba(${OCT_HILITE},${0.5 + pr * 0.5})` : `rgba(${OCT_COLOR},0.4)`
    ctx.fill()
  })

  if (pr > 0.3) {
    ctx.beginPath()
    ctx.arc(cxp, cyp, 2 + pr * 4, 0, Math.PI * 2)
    const cg = ctx.createRadialGradient(cxp, cyp, 0, cxp, cyp, 10 + pr * 10)
    cg.addColorStop(0, `rgba(${OCT_HILITE},${pr})`)
    cg.addColorStop(1, `rgba(${OCT_HILITE},0)`)
    ctx.fillStyle = cg
    ctx.fill()
  }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ))
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = () => setReduced(mq.matches)
    if (mq.addEventListener) mq.addEventListener('change', handler)
    else mq.addListener(handler)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
    }
  }, [])
  return reduced
}

function NodeCanvas({ progress, reduced }) {
  const canvasRef = useRef(null)
  const animRef = useRef({ progress: 0, target: progress, t: 0.5, raf: null })

  useEffect(() => { animRef.current.target = progress }, [progress])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    const s = animRef.current

    if (reduced) {
      s.progress = progress
      drawOctahedron(ctx, canvas.width, canvas.height, s.progress, s.t)
      return undefined
    }

    let mounted = true
    function frame() {
      if (!mounted) return
      s.progress += (s.target - s.progress) * 0.08
      s.t += 0.006
      drawOctahedron(ctx, canvas.width, canvas.height, s.progress, s.t)
      s.raf = requestAnimationFrame(frame)
    }
    s.raf = requestAnimationFrame(frame)
    return () => {
      mounted = false
      if (s.raf) cancelAnimationFrame(s.raf)
    }
  }, [reduced, progress])

  return (
    <div style={{ position: 'relative', height: 210 }}>
      <canvas ref={canvasRef} width={640} height={420} aria-hidden="true" style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Small presentational helpers (compose .qx-* only)
// ─────────────────────────────────────────────────────────────────────────

function GpuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="7" width="18" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7V4.5M12 7V4.5M17 7V4.5M7 19.5V17M12 19.5V17M17 19.5V17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function GuideSay({ children }) {
  return (
    <div className="qx-row qx-row--tight" style={{ alignItems: 'flex-start' }}>
      <div className="qx-avatar qx-avatar--sm qx-avatar--ring qx-avatar--circle" style={{ '--qx-avatar-ring': '#38bdf8' }}>Q</div>
      <div style={{ maxWidth: '60ch', fontSize: 14.5, color: '#fff', lineHeight: 1.5, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '12px 14px' }}>
        {children}
      </div>
    </div>
  )
}

function ActionsBar({ back, onBack, primaryLabel, ready, hint, onNext }) {
  return (
    <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 22, alignItems: 'center' }}>
      {back && <button type="button" className="qx-btn qx-btn--ghost" onClick={onBack}>Back</button>}
      <button type="button" className="qx-btn qx-btn--primary" disabled={!ready} onClick={onNext}>{primaryLabel}</button>
      {hint && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>{hint}</span>}
    </div>
  )
}

function RunLog({ rows, done, running }) {
  return (
    <div className="qx-stack qx-stack--tight" aria-live="polite">
      {rows.map((label, idx) => {
        const state = idx < done ? 'ok' : idx === running ? 'run' : 'pending'
        return (
          <div
            key={label}
            className="qx-row qx-row--tight"
            style={{ alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 13, color: state === 'pending' ? 'rgba(255,255,255,0.7)' : '#fff' }}
          >
            <span className={`qx-dot qx-dot--${state === 'ok' ? 'online' : state === 'run' ? 'loading' : 'idle'}`} />
            <span style={{ flex: 1 }}>{label}</span>
            {state === 'ok' && <span className="qx-pill qx-pill--online qx-pill--sm">ok</span>}
          </div>
        )
      })}
    </div>
  )
}

function ActiveBadge({ selected }) {
  return selected
    ? { borderColor: 'rgba(168,85,247,0.55)', background: 'linear-gradient(145deg, rgba(168,85,247,0.14), rgba(56,189,248,0.08))', boxShadow: '0 0 0 1px rgba(56,189,248,0.3)' }
    : undefined
}

// ─────────────────────────────────────────────────────────────────────────

export default function GpuSetupView() {
  const reduced = useReducedMotion()
  const navigate = useNavigate()

  const [mode, setMode] = useState('guided')
  const [step, setStep] = useState(0)
  const [maxReached, setMaxReached] = useState(0)
  const [intent, setIntent] = useState(null)
  const [provider, setProvider] = useState(null)
  const [runlogDone, setRunlogDone] = useState(0)
  const [runningRow, setRunningRow] = useState(-1)
  const [verifyReady, setVerifyReady] = useState(false)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(null)
  const copyTimerRef = useRef(null)

  // ── real B1/B1b wiring: enrollment token + fleet polling ──
  const [enrollToken, setEnrollToken] = useState(null)
  const [enrollExpiresAt, setEnrollExpiresAt] = useState(null)
  const [enrollIssuing, setEnrollIssuing] = useState(false)
  const [enrollError, setEnrollError] = useState(null)
  // host_ids known BEFORE this token was issued — a fresh node during
  // polling is one whose host_id isn't in this set.
  const [baselineHostIds, setBaselineHostIds] = useState(null)
  const [realNode, setRealNode] = useState(null)
  const [fleetCount, setFleetCount] = useState(null)
  const [pollError, setPollError] = useState(null)
  // Explicit opt-in to the labelled mock walkthrough for steps 4-6 when no
  // real GPU box is available in dev. Real data always wins when present.
  const [previewMode, setPreviewMode] = useState(false)

  const it = intent ? INTENTS[intent] : null
  const pv = provider ? PROVIDERS[provider] : null

  const goToStep = useCallback((i) => {
    if (i < 0 || i >= STEPS.length) return
    if (i > maxReached) return
    setStep(i)
  }, [maxReached])

  const advance = useCallback((i) => {
    if (i < 0 || i >= STEPS.length) return
    setMaxReached((m) => Math.max(m, i))
    setStep(i)
  }, [])

  const handleRestart = useCallback(() => {
    setIntent(null)
    setProvider(null)
    setStep(0)
    setMaxReached(0)
    setEnrollToken(null)
    setEnrollExpiresAt(null)
    setEnrollError(null)
    setBaselineHostIds(null)
    setRealNode(null)
    setFleetCount(null)
    setPollError(null)
    setPreviewMode(false)
  }, [])

  // Advanced track has no chips — default the first field so "Continue" is
  // always meaningful, same as the mockup's inline fallback.
  useEffect(() => {
    if (mode !== 'advanced') return
    if (step === 0 && !intent) setIntent('llama70b')
    if (step === 1 && !provider) setProvider('byo')
  }, [mode, step, intent, provider])

  // ── Provision step: issue a REAL single-use enrollment token ──
  // Reuses the exact convention InfraView/QlusterSettings use to call the
  // collector: same-origin `/collector/api/v1/...` fetch, csrfFetch for the
  // state-changing POST (adds X-CSRF-Token + credentials:'include').
  const issueEnrollToken = useCallback(async () => {
    setEnrollIssuing(true)
    setEnrollError(null)
    try {
      const res = await csrfFetch('/collector/api/v1/gpu/enroll/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        let detail = ''
        try { const b = await res.json(); detail = b?.error || b?.detail || '' } catch { /* ignore */ }
        setEnrollError(
          res.status === 401 || res.status === 403
            ? 'You need admin role on this box to generate a GPU enrolment token.'
            : `Could not generate an enrolment token (${res.status})${detail ? `: ${detail}` : ''}.`
        )
        return
      }
      const data = await res.json()
      setEnrollToken(data.enrollment_token)
      setEnrollExpiresAt(data.expires_at)
      // Snapshot the fleet at issue time so the Enroll step can tell which
      // node arrives BECAUSE of this token, vs. one that was already there.
      try {
        const nres = await fetch(`${window.location.origin}/collector/api/v1/gpu/nodes`)
        if (nres.ok) {
          const ndata = await nres.json()
          setBaselineHostIds(new Set((ndata.nodes || []).map((n) => n.host_id)))
        } else {
          setBaselineHostIds(new Set())
        }
      } catch {
        setBaselineHostIds(new Set())
      }
    } catch {
      setEnrollError('Could not reach the collector (network error). Is it running?')
    } finally {
      setEnrollIssuing(false)
    }
  }, [])

  useEffect(() => {
    if (step !== 2) return
    if (enrollToken || enrollIssuing) return
    issueEnrollToken()
  }, [step, enrollToken, enrollIssuing, issueEnrollToken])

  // ── Enroll step: REAL polling of GET /api/v1/gpu/nodes every ~3s ──
  // Looks for a node whose host_id wasn't in the pre-token baseline. No fake
  // completion: if nothing shows up, the UI stays in an honest waiting state.
  useEffect(() => {
    if (step !== 3 || previewMode || !baselineHostIds) return undefined
    let cancelled = false
    async function poll() {
      try {
        const res = await fetch(`${window.location.origin}/collector/api/v1/gpu/nodes`)
        if (!res.ok) { if (!cancelled) setPollError(`Fleet poll failed (HTTP ${res.status}).`); return }
        const data = await res.json()
        if (cancelled) return
        setPollError(null)
        setFleetCount(typeof data.count === 'number' ? data.count : (data.nodes || []).length)
        const fresh = (data.nodes || []).find((n) => !baselineHostIds.has(n.host_id))
        if (fresh) setRealNode(fresh)
      } catch {
        if (!cancelled) setPollError('Could not reach the collector (network error).')
      }
    }
    poll()
    const id = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [step, previewMode, baselineHostIds])

  useEffect(() => {
    if (step !== 3) { setRealNode(null); setPollError(null) }
  }, [step])

  // Enroll-step run-log animation — PREVIEW walkthrough only (UI timer, not
  // a background job). Only runs once the operator explicitly opts into
  // "Preview the rest (no node connected)".
  useEffect(() => {
    clearTimeout(timerRef.current)
    if (step !== 3 || !previewMode) {
      setRunlogDone(0)
      setRunningRow(-1)
      setVerifyReady(false)
      return undefined
    }
    const rows = mode === 'advanced' ? RUNLOG_ADVANCED(it) : RUNLOG_GUIDED(it)
    setRunlogDone(0)
    setVerifyReady(false)
    let i = 0
    let cancelled = false
    const tickMs = reduced ? 260 : 720
    function tick() {
      if (cancelled) return
      if (i > 0) setRunlogDone(i)
      if (i < rows.length) {
        setRunningRow(i)
        i += 1
        timerRef.current = setTimeout(tick, tickMs)
      } else {
        setRunningRow(-1)
        setVerifyReady(true)
      }
    }
    tick()
    return () => { cancelled = true; clearTimeout(timerRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, mode, reduced, previewMode])

  // Single source of truth for "can the operator move past Enroll" — real
  // node found (real path) or the mock run-log finished (preview path).
  const enrollReady = previewMode ? verifyReady : !!realNode

  const handleCopy = useCallback((text) => {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopied(false), 1200)
  }, [])

  useEffect(() => () => { clearTimeout(timerRef.current); clearTimeout(copyTimerRef.current) }, [])

  const progressTarget = step / (STEPS.length - 1)
  const nstateLabel = NSTATE_LABELS[step]

  // ── telemetry HUD ──
  const telRows = [
    { key: 'provider', label: 'Provider', value: '—' },
    { key: 'gpu', label: 'GPU', value: '—' },
    { key: 'vram', label: 'VRAM', value: '—' },
    { key: 'util', label: 'GPU Util', value: '—' },
    { key: 'temp', label: 'Temp', value: '—' },
    { key: 'backend', label: 'Backend', value: '—' },
    { key: 'model', label: 'Loaded Model', value: '—' },
  ]
  const setTel = (key, value) => { const r = telRows.find((row) => row.key === key); if (r) r.value = value }
  if (step >= 1 && it) { setTel('gpu', it.gpu); setTel('vram', it.vram) }
  if (step >= 2 && pv) { setTel('provider', pv.name) }
  if (step >= 3) { setTel('backend', `${it ? it.backend : '—'} · detected`) }
  if (step >= 4 && previewMode) {
    // PREVIEW walkthrough only — no live util/temp source exists yet.
    setTel('util', '63%'); setTel('temp', '61 °C'); setTel('model', it ? it.model : '—')
  } else if (step >= 4 && realNode) {
    setTel('gpu', realNode.gpu_summary?.names?.[0] || (it ? it.gpu : '—'))
    setTel('backend', (realNode.backends || []).map((b) => b.name).filter(Boolean).join(', ') || 'awaiting heartbeat')
    setTel('model', (realNode.loaded_models || [])[0]?.name || '—')
    // B3 (QUOXGPU #149) — fleet-level util/temp, durable on gpu_nodes
    // (util_pct/temp_c). null means genuinely unknown (no device reported a
    // real reading, or none has heartbeat yet) — show '—', never fabricate.
    setTel('util', typeof realNode.util_pct === 'number' ? `${Math.round(realNode.util_pct)}%` : '—')
    setTel('temp', typeof realNode.temp_c === 'number' ? `${Math.round(realNode.temp_c)} °C` : '—')
  }

  // ── guided stage ──
  function renderGuided() {
    if (step === 0) {
      return (
        <>
          <GuideSay>Tell me what you want to run and I&apos;ll size the hardware, find capacity, and wire it into your fleet. <b style={{ color: '#38bdf8' }}>You don&apos;t need to know what a GPU is.</b></GuideSay>
          <div className="qx-grid-2">
            {Object.entries(INTENTS).map(([key, v]) => (
              <button
                key={key}
                type="button"
                className="qx-action-card"
                aria-pressed={intent === key}
                style={ActiveBadge({ selected: intent === key })}
                onClick={() => setIntent(key)}
              >
                <span className="qx-action-card__icon"><GpuIcon /></span>
                <div className="qx-action-card__body">
                  <div className="qx-action-card__title">{v.label}</div>
                  <div className="qx-action-card__desc">{v.sub}</div>
                </div>
              </button>
            ))}
          </div>
          <ActionsBar primaryLabel="Size it up →" ready={!!intent} onNext={() => advance(1)} />
        </>
      )
    }
    if (step === 1) {
      return (
        <>
          <GuideSay>
            For <b style={{ color: '#38bdf8' }}>{it?.label}</b> you need about <span style={{ color: '#30ff90', fontFamily: 'var(--font-mono)' }}>{it?.vram}</span> of VRAM
            {it?.mig ? ': a single MIG slice of an A100 is enough and cheaper.' : '.'} Quox never provisions or bills GPUs: pick where the hardware comes from, same governance whichever you pick.
          </GuideSay>
          <button
            type="button"
            className="qx-action-card"
            aria-pressed={provider === 'byo'}
            style={ActiveBadge({ selected: provider === 'byo' })}
            onClick={() => setProvider('byo')}
          >
            <span className="qx-action-card__icon"><GpuIcon /></span>
            <div className="qx-action-card__body">
              <div className="qx-action-card__title">
                {PROVIDERS.byo.name}
                <span className="qx-pill qx-pill--purple qx-pill--sm" style={{ marginLeft: 8 }}>Recommended</span>
              </div>
              <div className="qx-action-card__desc">{PROVIDERS.byo.sub}</div>
            </div>
          </button>

          <div className="qx-section-title">Or rent one:</div>
          <div className="qx-grid-3">
            {RENT_PROVIDER_KEYS.map((key) => {
              const p = PROVIDERS[key]
              const Logo = p.Logo
              return (
                <a
                  key={key}
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="qx-action-card"
                  aria-pressed={provider === key}
                  style={{ ...ActiveBadge({ selected: provider === key }), textDecoration: 'none', flexDirection: 'column', alignItems: 'flex-start' }}
                  onClick={() => setProvider(key)}
                >
                  <span className="qx-action-card__icon" aria-label={p.name} title={p.name}><Logo /></span>
                  <div className="qx-action-card__body">
                    <div className="qx-action-card__title">{p.name} ↗</div>
                    <div className="qx-action-card__desc">{p.sub}</div>
                  </div>
                </a>
              )
            })}
          </div>
          <div style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.7)' }}>
            Opens the provider&apos;s console in a new tab · you provision &amp; pay them directly, no card details ever touch Quox. Typical rates are set by each provider, not us.
          </div>
          <ActionsBar back onBack={() => goToStep(0)} primaryLabel="Provision →" ready={!!provider} hint="no card details leave your Quox" onNext={() => advance(2)} />
        </>
      )
    }
    if (step === 2) {
      const cmdText = enrollToken
        ? `# enrol this node into your fleet\ncurl -fsSL quox.ai/gpu | sudo bash -s -- \\\n  --collector ${COLLECTOR_URL} \\\n  --enroll-token ${enrollToken} --bind 127.0.0.1`
        : null
      return (
        <>
          <GuideSay>
            Run this one-liner on your box (owned or rented). It installs the sensor, binds to loopback, and enrols into <b style={{ color: '#38bdf8' }}>your</b> collector with the scoped token I just generated. Same command wherever the box lives.
          </GuideSay>
          {enrollIssuing && (
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <span className="qx-dot qx-dot--loading" />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'rgba(255,255,255,0.8)' }}>Generating a single-use enrolment token…</span>
            </div>
          )}
          {enrollError && (
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#f87171' }}>{enrollError}</span>
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={issueEnrollToken}>Retry</button>
            </div>
          )}
          {cmdText && (
            <div className="qx-code-block" style={{ position: 'relative' }}>
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" style={{ position: 'absolute', top: 8, right: 8 }} onClick={() => handleCopy(cmdText)}>
                {copied ? 'copied' : 'copy'}
              </button>
              <div style={{ color: 'rgba(255,255,255,0.7)' }}># enrol this node into your fleet</div>
              <div>curl -fsSL <span style={{ color: '#38bdf8' }}>quox.ai/gpu</span> | sudo bash -s -- \</div>
              <div>&nbsp;&nbsp;--collector <span style={{ color: '#30ff90' }}>{COLLECTOR_URL}</span> \</div>
              <div>&nbsp;&nbsp;--enroll-token <span style={{ color: '#30ff90' }}>{enrollToken}</span> --bind 127.0.0.1</div>
            </div>
          )}
          <ActionsBar
            back
            onBack={() => goToStep(1)}
            primaryLabel="I ran it →"
            ready={!!enrollToken}
            hint={enrollExpiresAt ? `expires ${new Date(enrollExpiresAt).toLocaleTimeString()} · single use` : ''}
            onNext={() => advance(3)}
          />
        </>
      )
    }
    if (step === 3) {
      return (
        <>
          <GuideSay>
            {previewMode
              ? 'PREVIEW walkthrough: no real node connected. Watching a simulated enrolment run.'
              : 'Node is calling home. Polling your real GPU fleet every 3 seconds, no dashboards to refresh.'}
          </GuideSay>
          {previewMode ? (
            <RunLog rows={RUNLOG_GUIDED(it)} done={runlogDone} running={runningRow} />
          ) : (
            <div className="qx-stack qx-stack--tight">
              {pollError && <div style={{ fontSize: 12.5, color: '#f87171' }}>{pollError}</div>}
              {!realNode ? (
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                  <span className="qx-dot qx-dot--loading" />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>
                    Waiting for your node to check in…
                  </span>
                </div>
              ) : (
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                  <span className="qx-dot qx-dot--online" />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#fff', flex: 1 }}>
                    {realNode.host_id} checked in{realNode.gpu_summary?.names?.length ? ` · ${realNode.gpu_summary.names.join(', ')}` : ''}
                  </span>
                  <span className="qx-pill qx-pill--online qx-pill--sm">ok</span>
                </div>
              )}
              {!realNode && (
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPreviewMode(true)} style={{ alignSelf: 'flex-start' }}>
                  Preview the rest (no node connected) <span className="qx-pill qx-pill--warn qx-pill--sm" style={{ marginLeft: 6 }}>PREVIEW</span>
                </button>
              )}
            </div>
          )}
          <ActionsBar
            back
            onBack={() => goToStep(2)}
            primaryLabel={enrollReady ? 'Verify → healthy' : 'Verify →'}
            ready={enrollReady}
            hint={previewMode ? 'auto-advances when healthy' : 'polling live fleet · no fake success'}
            onNext={() => advance(4)}
          />
        </>
      )
    }
    if (step === 4) {
      if (previewMode || !realNode) {
        return (
          <>
            <GuideSay>
              <span className="qx-pill qx-pill--warn qx-pill--sm" style={{ marginRight: 8 }}>PREVIEW · mock data</span>
              Live and healthy. <b style={{ color: '#38bdf8' }}>{it ? it.gpu : 'Your GPU'}</b> is serving <span style={{ color: '#30ff90', fontFamily: 'var(--font-mono)' }}>{it ? it.model : 'your model'}</span> via {it ? it.backend : 'its backend'}, and every reading is now flowing into your evidence trail.
            </GuideSay>
            <div className="qx-action-card" style={{ cursor: 'default' }}>
              <span className="qx-action-card__icon">✓</span>
              <div className="qx-action-card__body">
                <div className="qx-action-card__title">GPU util 63% · 61°C · 48.2 GB / 80 GB</div>
                <div className="qx-action-card__desc">telemetry streaming · 5s cadence (preview)</div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                <div style={{ color: '#30ff90', fontWeight: 700 }}>online</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase' }}>healthy</div>
              </div>
            </div>
            <ActionsBar back onBack={() => goToStep(3)} primaryLabel="Hand to governance →" ready onNext={() => advance(5)} />
          </>
        )
      }
      const gpuName = realNode.gpu_summary?.names?.[0] || 'awaiting first heartbeat'
      const backendLabel = (realNode.backends || []).map((b) => b.name).filter(Boolean).join(', ') || 'detecting backend…'
      return (
        <>
          <GuideSay>
            Live. <b style={{ color: '#38bdf8' }}>{realNode.host_id}</b> checked in, backend: <span style={{ color: '#30ff90', fontFamily: 'var(--font-mono)' }}>{backendLabel}</span>. Every reading is now flowing into your evidence trail.
          </GuideSay>
          <div className="qx-action-card" style={{ cursor: 'default' }}>
            <span className="qx-action-card__icon">✓</span>
            <div className="qx-action-card__body">
              <div className="qx-action-card__title">{gpuName}</div>
              <div className="qx-action-card__desc">last seen {realNode.last_seen_at ? new Date(realNode.last_seen_at).toLocaleTimeString() : '—'}</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
              <div style={{ color: '#30ff90', fontWeight: 700 }}>{realNode.status || 'online'}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase' }}>{realNode.enrolled ? 'enrolled' : 'pending'}</div>
            </div>
          </div>
          <ActionsBar back onBack={() => goToStep(3)} primaryLabel="Hand to governance →" ready onNext={() => advance(5)} />
        </>
      )
    }
    if (previewMode || !realNode) {
      return (
        <>
          <GuideSay>
            <span className="qx-pill qx-pill--warn qx-pill--sm" style={{ marginRight: 8 }}>PREVIEW · mock data</span>
            Done. The node is a first-class member of your fleet, policy-governed, and its enrolment is <b style={{ color: '#38bdf8' }}>witnessed in WARD</b> so you can prove when it joined and on whose hardware.
          </GuideSay>
          <div className="qx-stack qx-stack--tight">
            <div className="qx-action-card" style={{ cursor: 'default' }}>
              <span className="qx-action-card__icon">◈</span>
              <div className="qx-action-card__body">
                <div className="qx-action-card__title">{MOCK_HOST_ID} · joined fleet</div>
                <div className="qx-action-card__desc">visible in <code className="qx-code">quox gpu ls</code> and the fleet map</div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                <div style={{ color: '#fff', fontWeight: 700 }}>{fleetCount ?? '—'}</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase' }}>nodes</div>
              </div>
            </div>
            <div className="qx-action-card" style={{ cursor: 'default' }}>
              <span className="qx-action-card__icon">🛡</span>
              <div className="qx-action-card__body">
                <div className="qx-action-card__title">
                  Policy applied · inference-only
                  <span className="qx-pill qx-pill--warn qx-pill--sm" style={{ marginLeft: 8 }}>PREVIEW · mock data</span>
                </div>
                <div className="qx-action-card__desc">WARD receipt {MOCK_WARD_HASH}</div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                <div style={{ color: '#30ff90', fontWeight: 700 }}>signed</div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase' }}>evidence</div>
              </div>
            </div>
            <div className="qx-trail">
              <span className="qx-trail__node qx-trail__node--aee">AEE</span>
              <span className="qx-trail__sep">→</span>
              <span className="qx-trail__node qx-trail__node--aocl">AOCL</span>
              <span className="qx-trail__sep">→</span>
              <span className="qx-trail__node qx-trail__node--volt">VOLT</span>
              <span className="qx-trail__sep">→</span>
              <span className="qx-trail__node qx-trail__node--ward">WARD</span>
            </div>
          </div>
          <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 22, alignItems: 'center' }}>
            <button type="button" className="qx-btn qx-btn--primary" onClick={() => navigate('/infra')}>View node in fleet →</button>
            <button type="button" className="qx-btn qx-btn--ghost" onClick={handleRestart}>Add another node</button>
            <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(4)}>Back</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>or connect a whole rack from a CSV</span>
          </div>
        </>
      )
    }
    return (
      <>
        <GuideSay>Done. <b style={{ color: '#38bdf8' }}>{realNode.host_id}</b> is a first-class member of your fleet, policy-governed, and its enrolment is <b style={{ color: '#38bdf8' }}>witnessed in WARD</b> so you can prove when it joined and on whose hardware.</GuideSay>
        <div className="qx-stack qx-stack--tight">
          <div className="qx-action-card" style={{ cursor: 'default' }}>
            <span className="qx-action-card__icon">◈</span>
            <div className="qx-action-card__body">
              <div className="qx-action-card__title">{realNode.host_id} · joined fleet</div>
              <div className="qx-action-card__desc">visible in <code className="qx-code">quox gpu ls</code> and the fleet map</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
              <div style={{ color: '#fff', fontWeight: 700 }}>{fleetCount ?? '—'}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase' }}>nodes</div>
            </div>
          </div>
          <div className="qx-action-card" style={{ cursor: 'default' }}>
            <span className="qx-action-card__icon">🛡</span>
            <div className="qx-action-card__body">
              <div className="qx-action-card__title">Enrolment witnessed · real WARD receipt</div>
              <div className="qx-action-card__desc">WARD digest {realNode.ward_digest || 'pending, awaiting witness'}</div>
            </div>
            <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
              <div style={{ color: '#30ff90', fontWeight: 700 }}>{realNode.ward_digest ? 'signed' : 'pending'}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase' }}>evidence</div>
            </div>
          </div>
          <div className="qx-trail">
            <span className="qx-trail__node qx-trail__node--aee">AEE</span>
            <span className="qx-trail__sep">→</span>
            <span className="qx-trail__node qx-trail__node--aocl">AOCL</span>
            <span className="qx-trail__sep">→</span>
            <span className="qx-trail__node qx-trail__node--volt">VOLT</span>
            <span className="qx-trail__sep">→</span>
            <span className="qx-trail__node qx-trail__node--ward">WARD</span>
          </div>
        </div>
        <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 22, alignItems: 'center' }}>
          <button type="button" className="qx-btn qx-btn--primary" onClick={() => navigate('/infra')}>View node in fleet →</button>
          <button type="button" className="qx-btn qx-btn--ghost" onClick={handleRestart}>Add another node</button>
          <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(4)}>Back</button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>or connect a whole rack from a CSV</span>
        </div>
      </>
    )
  }

  // ── advanced stage ──
  function renderAdvanced() {
    const advNote = (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '12px 14px' }}>
        advanced · QuoxGPU stays out of your way. Every field is yours to set; I only validate.
      </div>
    )
    if (step === 0) {
      return (
        <>
          {advNote}
          <div className="qx-field">
            <span className="qx-field__label">Workload profile</span>
            <select className="qx-select" value={intent || 'llama70b'} onChange={(e) => setIntent(e.target.value)}>
              {Object.entries(INTENTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div className="qx-grid-2">
            <div className="qx-field">
              <span className="qx-field__label">Min VRAM (GB)</span>
              <input className="qx-input" value={it ? (parseInt(it.vram, 10) || 48) : 48} readOnly />
            </div>
            <div className="qx-field">
              <span className="qx-field__label">MIG slice</span>
              <select className="qx-select" disabled value={it && it.mig ? 'yes' : 'no'} onChange={() => {}}>
                <option value={it && it.mig ? 'yes' : 'no'}>{it && it.mig ? 'yes · 1g.10gb' : 'no · full device'}</option>
              </select>
            </div>
          </div>
          <ActionsBar primaryLabel="Continue →" ready onNext={() => advance(1)} />
        </>
      )
    }
    if (step === 1) {
      return (
        <>
          {advNote}
          <div className="qx-field">
            <span className="qx-field__label">Capacity source</span>
            <select className="qx-select" value={provider || 'rent'} onChange={(e) => setProvider(e.target.value)}>
              {Object.entries(PROVIDERS).map(([k, p]) => <option key={k} value={k}>{p.name}</option>)}
            </select>
          </div>
          <div className="qx-grid-2">
            <div className="qx-field">
              <span className="qx-field__label">Region</span>
              <select className="qx-select" defaultValue="eu-central">
                <option value="eu-central">eu-central</option>
                <option value="us-east">us-east</option>
              </select>
            </div>
            <div className="qx-field">
              <span className="qx-field__label">Max $/hr</span>
              <input className="qx-input" defaultValue="2.00" />
            </div>
          </div>
          <ActionsBar back onBack={() => goToStep(0)} primaryLabel="Generate enrol →" ready onNext={() => advance(2)} />
        </>
      )
    }
    if (step === 2) {
      const cmdTextAdvanced = enrollToken ? CMD_TEXT_ADVANCED : null
      return (
        <>
          {advNote}
          {enrollIssuing && (
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <span className="qx-dot qx-dot--loading" />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'rgba(255,255,255,0.8)' }}>Generating a single-use enrolment token…</span>
            </div>
          )}
          {enrollError && (
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#f87171' }}>{enrollError}</span>
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={issueEnrollToken}>Retry</button>
            </div>
          )}
          {enrollToken && (
            <>
              <div className="qx-code-block">
                <div style={{ color: 'rgba(255,255,255,0.7)' }}># /etc/quoxgpu/config.yaml: emitted, not hand-written</div>
                <div><span style={{ color: '#38bdf8' }}>host_id</span>: <span style={{ color: 'rgba(255,255,255,0.7)' }}># auto-detected from hostname at enrol time</span></div>
                <div><span style={{ color: '#38bdf8' }}>collector_url</span>: <span style={{ color: '#30ff90' }}>{COLLECTOR_URL}</span></div>
                <div><span style={{ color: '#38bdf8' }}>bind_address</span>: <span style={{ color: '#30ff90' }}>127.0.0.1</span> &nbsp;<span style={{ color: 'rgba(255,255,255,0.7)' }}># loopback + token</span></div>
                <div><span style={{ color: '#38bdf8' }}>auth_token</span>: <span style={{ color: '#30ff90' }}>{enrollToken}</span></div>
                <div><span style={{ color: '#38bdf8' }}>heartbeat_interval_sec</span>: <span style={{ color: '#30ff90' }}>30</span></div>
                <div><span style={{ color: '#38bdf8' }}>sources</span>:</div>
                <div>&nbsp;&nbsp;- <span style={{ color: '#38bdf8' }}>url</span>: <span style={{ color: '#30ff90' }}>http://localhost:11434</span> <span style={{ color: 'rgba(255,255,255,0.7)' }}># auto-detect</span></div>
              </div>
              <div className="qx-code-block" style={{ marginTop: 12, position: 'relative' }}>
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" style={{ position: 'absolute', top: 8, right: 8 }} onClick={() => handleCopy(cmdTextAdvanced)}>
                  {copied ? 'copied' : 'copy'}
                </button>
                curl -fsSL <span style={{ color: '#38bdf8' }}>quox.ai/gpu</span> | sudo bash -s -- --config <span style={{ color: '#30ff90' }}>./config.yaml</span>
              </div>
            </>
          )}
          <ActionsBar back onBack={() => goToStep(1)} primaryLabel="Mark enrolled →" ready={!!enrollToken} hint={enrollExpiresAt ? `expires ${new Date(enrollExpiresAt).toLocaleTimeString()}` : ''} onNext={() => advance(3)} />
        </>
      )
    }
    if (step === 3) {
      return (
        <>
          {advNote}
          <GuideSay>
            {previewMode
              ? 'PREVIEW walkthrough: no real node connected. Streaming a simulated journal.'
              : 'Polling GET /api/v1/gpu/nodes every 3s for a node enrolled with the token above.'}
          </GuideSay>
          {previewMode ? (
            <RunLog rows={RUNLOG_ADVANCED(it)} done={runlogDone} running={runningRow} />
          ) : (
            <div className="qx-stack qx-stack--tight">
              {pollError && <div style={{ fontSize: 12.5, color: '#f87171' }}>{pollError}</div>}
              {!realNode ? (
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                  <span className="qx-dot qx-dot--loading" />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Waiting for your node to check in…</span>
                </div>
              ) : (
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                  <span className="qx-dot qx-dot--online" />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#fff', flex: 1 }}>
                    {realNode.host_id} checked in{realNode.gpu_summary?.names?.length ? ` · ${realNode.gpu_summary.names.join(', ')}` : ''}
                  </span>
                  <span className="qx-pill qx-pill--online qx-pill--sm">ok</span>
                </div>
              )}
              {!realNode && (
                <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPreviewMode(true)} style={{ alignSelf: 'flex-start' }}>
                  Preview the rest (no node connected) <span className="qx-pill qx-pill--warn qx-pill--sm" style={{ marginLeft: 6 }}>PREVIEW</span>
                </button>
              )}
            </div>
          )}
          <ActionsBar back onBack={() => goToStep(2)} primaryLabel={enrollReady ? 'Verify → healthy' : 'Verify →'} ready={enrollReady} hint={previewMode ? 'streaming journal' : 'polling live fleet · no fake success'} onNext={() => advance(4)} />
        </>
      )
    }
    if (step === 4) {
      if (previewMode || !realNode) {
        return (
          <>
            {advNote}
            <span className="qx-pill qx-pill--warn qx-pill--sm">PREVIEW · mock data</span>
            <div className="qx-code-block">
              <div style={{ color: 'rgba(255,255,255,0.7)' }}># GET /api/v1/gpus</div>
              <div>{'{ '}<span style={{ color: '#38bdf8' }}>&quot;index&quot;</span>:0, <span style={{ color: '#38bdf8' }}>&quot;name&quot;</span>:<span style={{ color: '#30ff90' }}>&quot;{it ? it.gpu : 'A100'}&quot;</span>,</div>
              <div>&nbsp;&nbsp;<span style={{ color: '#38bdf8' }}>&quot;vram_total_mb&quot;</span>:81920, <span style={{ color: '#38bdf8' }}>&quot;utilisation_pct&quot;</span>:63,</div>
              <div>&nbsp;&nbsp;<span style={{ color: '#38bdf8' }}>&quot;temperature_c&quot;</span>:61, <span style={{ color: '#38bdf8' }}>&quot;healthy&quot;</span>:<span style={{ color: '#30ff90' }}>true</span> {'}'}</div>
            </div>
            <ActionsBar back onBack={() => goToStep(3)} primaryLabel="Apply policy →" ready onNext={() => advance(5)} />
          </>
        )
      }
      return (
        <>
          {advNote}
          <div className="qx-code-block">
            <div style={{ color: 'rgba(255,255,255,0.7)' }}># GET /api/v1/gpu/nodes → {realNode.host_id}</div>
            <div>{'{ '}<span style={{ color: '#38bdf8' }}>&quot;host_id&quot;</span>:<span style={{ color: '#30ff90' }}>&quot;{realNode.host_id}&quot;</span>, <span style={{ color: '#38bdf8' }}>&quot;status&quot;</span>:<span style={{ color: '#30ff90' }}>&quot;{realNode.status || 'online'}&quot;</span>,</div>
            <div>&nbsp;&nbsp;<span style={{ color: '#38bdf8' }}>&quot;gpu_summary&quot;</span>:{'{ '}<span style={{ color: '#38bdf8' }}>&quot;names&quot;</span>:{JSON.stringify(realNode.gpu_summary?.names || [])}, <span style={{ color: '#38bdf8' }}>&quot;vram_total_mb&quot;</span>:{realNode.gpu_summary?.vram_total_mb ?? 0}{' }'},</div>
            <div>&nbsp;&nbsp;<span style={{ color: '#38bdf8' }}>&quot;enrolled&quot;</span>:<span style={{ color: '#30ff90' }}>{String(!!realNode.enrolled)}</span> {'}'}</div>
          </div>
          <ActionsBar back onBack={() => goToStep(3)} primaryLabel="Apply policy →" ready onNext={() => advance(5)} />
        </>
      )
    }
    if (previewMode || !realNode) {
      return (
        <>
          {advNote}
          <span className="qx-pill qx-pill--warn qx-pill--sm">PREVIEW · mock data</span>
          <div className="qx-code-block">
            <div style={{ color: 'rgba(255,255,255,0.7)' }}># WARD receipt · append-only</div>
            <div><span style={{ color: '#38bdf8' }}>event</span>: <span style={{ color: '#30ff90' }}>node.enrolled</span></div>
            <div><span style={{ color: '#38bdf8' }}>node</span>: <span style={{ color: '#30ff90' }}>{MOCK_HOST_ID}</span>&nbsp;&nbsp;<span style={{ color: '#38bdf8' }}>gpu</span>: <span style={{ color: '#30ff90' }}>{it ? it.gpu : 'A100'}</span></div>
            <div><span style={{ color: '#38bdf8' }}>policy</span>: <span style={{ color: '#30ff90' }}>inference-only</span></div>
            <div><span style={{ color: '#38bdf8' }}>digest</span>: <span style={{ color: '#30ff90' }}>{MOCK_WARD_HASH}</span> <span style={{ color: 'rgba(255,255,255,0.7)' }}># hash-chained</span></div>
          </div>
          <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 22, alignItems: 'center' }}>
            <button type="button" className="qx-btn qx-btn--primary" onClick={() => navigate('/infra')}>View node in fleet →</button>
            <button type="button" className="qx-btn qx-btn--ghost" onClick={handleRestart}>Enrol another</button>
            <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(4)}>Back</button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>CSV → batch enrol a rack</span>
          </div>
        </>
      )
    }
    return (
      <>
        {advNote}
        <div className="qx-code-block">
          <div style={{ color: 'rgba(255,255,255,0.7)' }}># WARD receipt · real digest from GET /api/v1/gpu/nodes</div>
          <div><span style={{ color: '#38bdf8' }}>event</span>: <span style={{ color: '#30ff90' }}>node.enrolled</span></div>
          <div><span style={{ color: '#38bdf8' }}>node</span>: <span style={{ color: '#30ff90' }}>{realNode.host_id}</span>&nbsp;&nbsp;<span style={{ color: '#38bdf8' }}>gpu</span>: <span style={{ color: '#30ff90' }}>{realNode.gpu_summary?.names?.[0] || 'awaiting heartbeat'}</span></div>
          <div><span style={{ color: '#38bdf8' }}>policy</span>: <span style={{ color: '#30ff90' }}>inference-only</span></div>
          <div><span style={{ color: '#38bdf8' }}>digest</span>: <span style={{ color: '#30ff90' }}>{realNode.ward_digest || 'pending, awaiting witness'}</span> <span style={{ color: 'rgba(255,255,255,0.7)' }}># hash-chained</span></div>
        </div>
        <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 22, alignItems: 'center' }}>
          <button type="button" className="qx-btn qx-btn--primary" onClick={() => navigate('/infra')}>View node in fleet →</button>
          <button type="button" className="qx-btn qx-btn--ghost" onClick={handleRestart}>Enrol another</button>
          <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(4)}>Back</button>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>CSV → batch enrol a rack</span>
        </div>
      </>
    )
  }

  return (
    <div className="qx-view qx-pad qx-stack">
      {/* header */}
      <div className="qx-row qx-row--apart">
        <div>
          <h1 style={{ fontSize: 19, fontWeight: 650, margin: 0, color: '#fff' }}>
            <span style={{ color: '#38bdf8' }}>QuoxGPU</span>
          </h1>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center', marginTop: 3 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.24em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)' }}>
              Quox Fleet Onboarding
            </div>
            <span className="qx-pill qx-pill--warn">PREVIEW · mock data</span>
          </div>
        </div>
        <div className="qx-seg" role="group" aria-label="Setup mode">
          <button type="button" className={`qx-seg__btn${mode === 'guided' ? ' qx-seg__btn--active' : ''}`} aria-pressed={mode === 'guided'} onClick={() => setMode('guided')}>Guided</button>
          <button type="button" className={`qx-seg__btn${mode === 'advanced' ? ' qx-seg__btn--active' : ''}`} aria-pressed={mode === 'advanced'} onClick={() => setMode('advanced')}>Advanced</button>
        </div>
      </div>

      {/* main grid: rail | stage | node */}
      <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0,1fr) 360px', gap: 16, alignItems: 'start' }}>

        {/* ── flight path rail ── */}
        <nav className="qx-card qx-stack qx-stack--tight" aria-label="Setup progress">
          <div className="qx-section-title">Flight Path</div>
          {STEPS.map((s, i) => {
            const state = i < step ? 'done' : i === step ? 'active' : 'upcoming'
            const clickable = i <= maxReached
            return (
              <button
                key={s.key}
                type="button"
                disabled={!clickable}
                aria-current={state === 'active' ? 'step' : undefined}
                onClick={() => goToStep(i)}
                className={`qx-row qx-row--tight glass-btn${state === 'active' ? ' glass-active' : ''}`}
                style={{
                  width: '100%',
                  justifyContent: 'flex-start',
                  alignItems: 'center',
                  height: 'auto',
                  minHeight: 'auto',
                  padding: '10px 12px',
                  cursor: clickable ? 'pointer' : 'default',
                  opacity: state === 'upcoming' ? 0.7 : 1,
                }}
              >
                <span className={`qx-dot qx-dot--${state === 'done' ? 'online' : state === 'active' ? 'loading' : 'idle'}`} />
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <b style={{ color: '#fff', fontSize: 13 }}>{s.rail}</b>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: state === 'active' ? '#38bdf8' : 'rgba(255,255,255,0.7)' }}>
                    {state === 'done' ? 'complete' : state === 'active' ? 'in progress' : 'pending'}
                  </span>
                </span>
              </button>
            )
          })}
        </nav>

        {/* ── stage ── */}
        <section className="qx-card qx-stack" style={{ minHeight: 480 }}>
          <div className="qx-row qx-row--apart">
            <div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '.2em', textTransform: 'uppercase', color: '#38bdf8' }}>
                Step {STEPS[step].n}
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 600, margin: '4px 0 0', color: '#fff' }}>{STEPS[step].title}</h2>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.7)', letterSpacing: '.08em' }}>
              STEP <b style={{ color: '#fff' }}>{STEPS[step].n}</b> / 06
            </span>
          </div>
          <div className="qx-divider qx-divider--dense" />
          {mode === 'advanced' ? renderAdvanced() : renderGuided()}
        </section>

        {/* ── node · live state ── */}
        <aside className="qx-card qx-stack qx-stack--tight" style={{ position: 'sticky', top: 16 }}>
          <div className="qx-section-title">Node · Live State</div>
          <NodeCanvas progress={progressTarget} reduced={reduced} />
          <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)' }}>
            {nstateLabel}
          </div>
          <div>
            {telRows.map((r) => (
              <div key={r.key} className="qx-stat-row">
                <span className="qx-stat-row__label" style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 10.5 }}>{r.label}</span>
                <span className="qx-stat-row__value" style={{ color: r.value === '—' ? 'rgba(255,255,255,0.7)' : '#fff' }}>{r.value}</span>
              </div>
            ))}
          </div>
          {step >= 5 && (
            <div className="qx-row qx-row--tight" style={{ border: '1px dashed rgba(48,255,144,0.35)', borderRadius: 10, padding: '11px 13px', alignItems: 'center' }}>
              <span className="qx-dot qx-dot--online" />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>
                {previewMode || !realNode ? (
                  <>PREVIEW · mock <b style={{ color: '#30ff90' }}>WARD</b> receipt <span style={{ color: '#fff' }}>{MOCK_WARD_HASH}</span></>
                ) : (
                  <>Enrolment witnessed · <b style={{ color: '#30ff90' }}>WARD</b> receipt <span style={{ color: '#fff' }}>{realNode.ward_digest || 'pending, awaiting witness'}</span></>
                )}
              </span>
            </div>
          )}
        </aside>
      </div>

      <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.12em', color: 'rgba(255,255,255,0.7)' }}>
        QUOXGPU ONBOARDING &nbsp;·&nbsp; <span className="qx-pill qx-pill--info qx-pill--sm">CONCEPT</span> &nbsp;·&nbsp; guided track for anyone, advanced track for operators
      </div>
    </div>
  )
}

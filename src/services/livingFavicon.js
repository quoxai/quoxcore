/**
 * Living favicon (DEVSUITE-GLYPH follow-on): the browser-tab Q carries a live
 * health dot, so an unhealthy stack is visible from any tab without opening
 * the dashboard. Tab-scoped UI only (no background-job semantics): it reads
 * the unauthenticated /collector/health, repaints the favicon canvas, and
 * pauses itself while the tab is hidden.
 */

const HEALTH_URL = '/collector/health'
const INTERVAL_MS = 60_000
const DOT = {
  healthy: '#4ade80',   // --m-success
  degraded: '#fbbf24',  // --m-warning
  down: '#f87171',      // --m-error
}

let baseImage = null
let lastState = null

function loadBase() {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = '/favicon.svg'
  })
}

function paint(state) {
  if (!baseImage || state === lastState) return
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.drawImage(baseImage, 0, 0, 64, 64)
  // Health dot, bottom-right, with a dark keyline so it reads on any theme.
  ctx.beginPath()
  ctx.arc(50, 50, 12, 0, Math.PI * 2)
  ctx.fillStyle = '#0b0f1a'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(50, 50, 9, 0, Math.PI * 2)
  ctx.fillStyle = DOT[state] || DOT.down
  ctx.fill()
  let link = document.querySelector('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }
  link.type = 'image/png'
  link.href = canvas.toDataURL('image/png')
  lastState = state
}

async function check() {
  let state = 'down'
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(4000) })
    if (res.ok) {
      const body = await res.json().catch(() => ({}))
      state = body.status === 'healthy' ? 'healthy' : 'degraded'
    }
  } catch {
    state = 'down'
  }
  paint(state)
}

export async function initLivingFavicon() {
  try {
    baseImage = await loadBase()
    if (!baseImage) return
    await check()
    setInterval(() => {
      if (!document.hidden) check()
    }, INTERVAL_MS)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check()
    })
  } catch {
    // A favicon must never break the app.
  }
}

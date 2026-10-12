/**
 * Error Capture Service
 * Captures unhandled errors and provides opt-in reporting.
 * Auto-send is opt-in via settings.
 */

import { submitErrorReport } from './feedbackClient'
import { queueSync } from './serverSyncQueue'

const SETTINGS_KEY = 'quox-settings'
const MAX_QUEUE = 20
const DEDUP_WINDOW_MS = 5000

let errorQueue = []
let listeners = []
let lastErrorKey = ''
let lastErrorTime = 0
let initialized = false

function getAutoSendSetting() {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return !!settings.autoSendErrorReports
  } catch {
    return false
  }
}

export function setAutoSendErrorReports(enabled) {
  try {
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    settings.autoSendErrorReports = enabled
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    queueSync('settings', settings)
  } catch { /* ignore */ }
}

export function getAutoSendErrorReportsEnabled() {
  return getAutoSendSetting()
}

function dedup(message) {
  const key = message?.substring(0, 100) || ''
  const now = Date.now()
  if (key === lastErrorKey && now - lastErrorTime < DEDUP_WINDOW_MS) return true
  lastErrorKey = key
  lastErrorTime = now
  return false
}

function captureError({ error_type, message, stack, component_stack, url, context }) {
  if (dedup(message)) return

  const entry = {
    id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    error_type,
    message: message?.substring(0, 2000) || 'Unknown error',
    stack: stack?.substring(0, 5000) || '',
    component_stack: component_stack?.substring(0, 3000) || '',
    url: url || window.location.href,
    context: context || '',
    timestamp: new Date().toISOString(),
    reported: false
  }

  errorQueue.push(entry)
  if (errorQueue.length > MAX_QUEUE) errorQueue.shift()

  // Notify listeners (for toast display)
  listeners.forEach(fn => fn(entry))

  // Auto-send if enabled
  if (getAutoSendSetting()) {
    sendReport(entry).catch(() => {})
  }
}

async function sendReport(entry, userDescription) {
  try {
    await submitErrorReport({
      error_type: entry.error_type,
      message: entry.message,
      stack: entry.stack,
      component_stack: entry.component_stack,
      url: entry.url,
      context: entry.context,
      user_description: userDescription || ''
    })
    entry.reported = true
  } catch (err) {
    console.warn('[ErrorCapture] Failed to send report:', err.message)
    throw err
  }
}

export function reportError(entryId, userDescription) {
  const entry = errorQueue.find(e => e.id === entryId)
  if (!entry) return Promise.reject(new Error('Error not found in queue'))
  return sendReport(entry, userDescription)
}

export function reportErrorDirect(errorData, userDescription) {
  const entry = {
    id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...errorData,
    timestamp: new Date().toISOString(),
    reported: false
  }
  return sendReport(entry, userDescription)
}

export function getErrorQueue() {
  return [...errorQueue]
}

export function clearErrorQueue() {
  errorQueue = []
}

export function onErrorCaptured(listener) {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter(fn => fn !== listener)
  }
}

export function dismissError(entryId) {
  errorQueue = errorQueue.filter(e => e.id !== entryId)
}

export function initErrorCapture() {
  if (initialized) return
  initialized = true

  // A stale lazy chunk after a redeploy: the loaded index.html references a
  // chunk hash that no longer exists on the server (new build = new hashes),
  // so import() 404s with "Failed to fetch dynamically imported module". The
  // remedy is to reload once and pull the fresh index.html + current hashes.
  // Guarded to one reload per 10s so a genuinely broken deploy still surfaces
  // instead of reload-looping.
  const CHUNK_RELOAD_KEY = 'quox-chunk-reload-at'
  const isDynamicImportError = (msg) => {
    if (!msg) return false
    const m = String(msg)
    return m.includes('Failed to fetch dynamically imported module')
      || m.includes('error loading dynamically imported module')
      || m.includes('Importing a module script failed')
      || m.includes('dynamically imported module')
  }
  const reloadForStaleChunk = () => {
    try {
      const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0)
      if (Date.now() - last < 10000) return false // already reloaded recently — real error, let it surface
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
      window.location.reload()
      return true
    } catch {
      return false
    }
  }

  // Vite emits this for its own dynamic-import preload helper. preventDefault()
  // stops it becoming an uncaught rejection; then we reload for the fresh build.
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    reloadForStaleChunk()
  })

  // Global unhandled JS errors
  window.addEventListener('error', (event) => {
    // ResizeObserver loop errors are benign — triggered by React Flow, canvas visualizers,
    // and any component that measures layout. Safe to suppress entirely.
    if (event.message?.includes('ResizeObserver')) return
    if (isDynamicImportError(event.message) && reloadForStaleChunk()) return
    captureError({
      error_type: 'unhandled_error',
      message: event.message || String(event.error),
      stack: event.error?.stack || `at ${event.filename}:${event.lineno}:${event.colno}`,
      url: event.filename || window.location.href,
      context: 'window.onerror'
    })
  })

  // Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = reason?.message || String(reason)
    if (isDynamicImportError(message) && reloadForStaleChunk()) return
    captureError({
      error_type: 'unhandled_rejection',
      message,
      stack: reason?.stack || '',
      url: window.location.href,
      context: 'unhandledrejection'
    })
  })

  // Hook into window.reportError for ErrorBoundary integration
  window.reportError = (errorData) => {
    captureError({
      error_type: 'react_error_boundary',
      message: errorData.error || 'React component error',
      stack: errorData.stack || '',
      component_stack: errorData.componentStack || '',
      url: errorData.url || window.location.href,
      context: 'ErrorBoundary'
    })
  }
}

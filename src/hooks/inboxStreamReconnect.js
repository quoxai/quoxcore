/**
 * inboxStreamReconnect - shared resilient EventSource wrapper for the inbox hooks.
 *
 * Why this exists (INBOX-LIVE, 2026-10-07): approvals "sometimes don't pop up
 * until I refresh". The SSE stream has no ids/replay, so anything emitted while
 * the connection is down is lost unless the client refetches on reopen. The old
 * code also never refreshed an expired access cookie before retrying, never
 * reconnected the multi-org streams at all, and could not see the server
 * keepalive (an SSE comment), so half-dead streams went undetected.
 *
 * Behaviour:
 *  - error -> close -> best-effort token refresh -> reconnect with capped
 *    exponential backoff + jitter
 *  - reconnect immediately on visibilitychange (visible) and `online`
 *  - onReopen fires on every open AFTER the first (caller refetches state)
 *  - watchdog: no event/ping for WATCHDOG_MS forces a reconnect
 *  - while disconnected, onPoll fires every POLL_MS; stops on reconnect
 */

export const BASE_RECONNECT_DELAY = 1000
export const MAX_RECONNECT_DELAY = 60000
export const WATCHDOG_MS = 60000
export const WATCHDOG_CHECK_MS = 10000
export const POLL_MS = 30000

export function createResilientStream({
  url,
  eventTypes = [],
  onEvent,
  onStatus,
  onReopen,
  onPoll,
  refreshAuth,
  autoReconnect = true,
  EventSourceImpl,
}) {
  let es = null
  let stopped = true
  let attempts = 0
  let hasOpened = false
  let isOpen = false
  let lastActivity = 0
  let reconnectTimer = null
  let pollTimer = null
  let watchdogTimer = null
  let listenersBound = false

  const ES = () => EventSourceImpl || globalThis.EventSource

  const setStatus = (connected, err) => {
    isOpen = connected
    onStatus?.(connected, err)
  }

  const clearReconnect = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }
  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }
  const startPoll = () => {
    if (pollTimer || !onPoll) return
    pollTimer = setInterval(() => {
      try { onPoll() } catch (e) { console.warn('[InboxStream] poll failed:', e) }
    }, POLL_MS)
  }
  const stopWatchdog = () => {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
  }
  const startWatchdog = () => {
    stopWatchdog()
    watchdogTimer = setInterval(() => {
      if (es && Date.now() - lastActivity > WATCHDOG_MS) {
        console.warn('[InboxStream] watchdog: no activity, forcing reconnect')
        handleDown('Stream stalled')
      }
    }, WATCHDOG_CHECK_MS)
  }

  const closeEs = () => {
    if (es) {
      const old = es
      es = null
      try { old.close() } catch { /* ignore */ }
    }
  }

  const open = () => {
    if (stopped) return
    closeEs()
    clearReconnect()
    let source
    try {
      source = new (ES())(url, { withCredentials: true })
    } catch (err) {
      setStatus(false, err.message)
      scheduleReconnect()
      return
    }
    es = source
    lastActivity = Date.now()

    source.onopen = () => {
      if (es !== source) return
      lastActivity = Date.now()
      attempts = 0
      stopPoll()
      setStatus(true, null)
      if (hasOpened) {
        try { onReopen?.() } catch (e) { console.warn('[InboxStream] onReopen failed:', e) }
      }
      hasOpened = true
    }
    source.onerror = () => {
      if (es !== source) return
      handleDown('Connection lost')
    }
    // `ping` + `connected` count as liveness for the watchdog.
    for (const t of ['connected', 'ping', ...eventTypes]) {
      source.addEventListener(t, (e) => {
        if (es !== source) return
        lastActivity = Date.now()
        if (t !== 'connected' && t !== 'ping') onEvent?.(t, e)
      })
    }
  }

  function scheduleReconnect() {
    if (stopped || !autoReconnect || reconnectTimer) return
    const base = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, attempts), MAX_RECONNECT_DELAY)
    // jitter: 50%-100% of the backoff so a fleet of tabs does not stampede
    const delay = Math.round(base * (0.5 + Math.random() * 0.5))
    attempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      reconnectNow()
    }, delay)
  }

  function handleDown(err) {
    closeEs()
    setStatus(false, err)
    startPoll()
    scheduleReconnect()
  }

  async function reconnectNow() {
    if (stopped) return
    clearReconnect()
    try { await refreshAuth?.() } catch { /* best effort */ }
    if (stopped) return
    open()
  }

  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (!isOpen) reconnectNow()
  }
  const onOnline = () => {
    if (!isOpen) reconnectNow()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      attempts = 0
      hasOpened = false
      open()
      startWatchdog()
      if (!listenersBound && typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('online', onOnline)
        listenersBound = true
      }
    },
    stop() {
      stopped = true
      clearReconnect()
      stopPoll()
      stopWatchdog()
      closeEs()
      if (listenersBound) {
        document.removeEventListener('visibilitychange', onVisible)
        window.removeEventListener('online', onOnline)
        listenersBound = false
      }
      isOpen = false
    },
    reconnect: reconnectNow,
    isOpen: () => isOpen,
  }
}

/**
 * Shared, refcounted inbox streams: one resilient EventSource per URL per tab,
 * fanned out to every subscriber (the shell's notification listener, the inbox
 * page's single-org or multi-org list). INBOX-LIVE (2026-10-07): the shell now
 * listens to EVERY org the user belongs to (it used to hear only currentOrg, so
 * approvals in any other org never toasted, chimed or notified); sharing keeps
 * that from doubling the per-tab stream count on the inbox page.
 *
 * subscriber: { onEvent(type, e), onStatus(connected, err), onReopen(), onPoll(),
 *               refreshAuth() }
 * Returns { stop, reconnect } for that subscriber only. The stream closes when
 * the last subscriber stops.
 */
const sharedStreams = new Map()

export function subscribeSharedStream({ url, eventTypes = [], EventSourceImpl, ...sub }) {
  let entry = sharedStreams.get(url)
  if (!entry) {
    const subs = new Set()
    const each = (fn) => {
      for (const s of [...subs]) {
        try { fn(s) } catch (e) { console.warn('[InboxStream] subscriber failed:', e) }
      }
    }
    entry = { subs, connected: false, err: null, stream: null }
    const e = entry
    e.stream = createResilientStream({
      url,
      eventTypes,
      EventSourceImpl,
      onEvent: (type, ev) => each(s => s.onEvent?.(type, ev)),
      onStatus: (connected, err) => {
        e.connected = connected
        e.err = err
        each(s => s.onStatus?.(connected, err))
      },
      onReopen: () => each(s => s.onReopen?.()),
      onPoll: () => each(s => s.onPoll?.()),
      // Any live subscriber's refresher will do; they all renew the same cookie.
      refreshAuth: () => {
        const s = [...subs].find(x => x.refreshAuth)
        return s ? s.refreshAuth() : undefined
      },
    })
    sharedStreams.set(url, entry)
    entry.subs.add(sub)
    entry.stream.start()
  } else {
    entry.subs.add(sub)
    if (entry.connected) {
      try { sub.onStatus?.(true, null) } catch { /* ignore */ }
    }
  }
  const mine = entry
  let active = true
  return {
    stop() {
      if (!active) return
      active = false
      mine.subs.delete(sub)
      if (mine.subs.size === 0 && sharedStreams.get(url) === mine) {
        sharedStreams.delete(url)
        mine.stream.stop()
      }
    },
    reconnect: () => mine.stream.reconnect(),
  }
}

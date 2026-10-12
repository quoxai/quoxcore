// captureDraft.js - BRAIN2-W8 client for the server-side capture draft.
// The draft is user content, so the server (org + user scoped) is the only
// store. No localStorage here. Saves are debounced; clear is immediate and
// cancels any pending save so a saved note cannot resurrect its own draft.

export const DRAFT_SAVE_DELAY_MS = 800

export function createDraftSync(client, { delayMs = DRAFT_SAVE_DELAY_MS, onError } = {}) {
  let timer = null
  let version = 0 // bumped by clear(); an in-flight save from an older version is discarded

  const report = (e) => { try { onError?.(e) } catch { /* noop */ } }

  return {
    /** Resolves to {title,text}|null; a failed or unsupported lookup resolves null. */
    async load() {
      if (typeof client?.getCaptureDraft !== 'function') return null
      try {
        const d = await client.getCaptureDraft()
        return d && (d.text || d.title) ? { title: d.title || '', text: d.text || '' } : null
      } catch (e) { report(e); return null }
    },
    schedule({ title = '', text = '' } = {}) {
      if (typeof client?.saveCaptureDraft !== 'function') return
      if (timer) clearTimeout(timer)
      const v = version
      timer = setTimeout(async () => {
        timer = null
        if (v !== version) return
        try { await client.saveCaptureDraft({ title, text }) } catch (e) { report(e) }
      }, delayMs)
    },
    async clear() {
      version += 1
      if (timer) { clearTimeout(timer); timer = null }
      if (typeof client?.clearCaptureDraft !== 'function') return
      try { await client.clearCaptureDraft() } catch (e) { report(e) }
    },
    cancel() { if (timer) { clearTimeout(timer); timer = null } }
  }
}

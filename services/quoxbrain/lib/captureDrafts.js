// captureDrafts.js - BRAIN2-W8 recoverable capture draft.
// One draft per (org, user). Org and user come from auth, never the body.
// GET /brain/capture/draft, PUT /brain/capture/draft {title,text}, DELETE.
import { getDatabase } from './db.js'

export const MAX_DRAFT_CHARS = 200000

export function getDraft(orgId, userId) {
  const row = getDatabase().prepare('SELECT title, text, updated_at FROM capture_drafts WHERE org_id = ? AND user_id = ?').get(orgId, userId)
  return row ? { title: row.title, text: row.text, updatedAt: row.updated_at } : null
}

export function saveDraft(orgId, userId, { title = '', text = '' } = {}) {
  const t = String(title || '').slice(0, 500)
  const x = String(text || '')
  if (!t.trim() && !x.trim()) return clearDraft(orgId, userId)
  getDatabase().prepare(`INSERT INTO capture_drafts (org_id, user_id, title, text, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(org_id, user_id) DO UPDATE SET title = excluded.title, text = excluded.text, updated_at = excluded.updated_at`)
    .run(orgId, userId, t, x, new Date().toISOString())
  return getDraft(orgId, userId)
}

export function clearDraft(orgId, userId) {
  getDatabase().prepare('DELETE FROM capture_drafts WHERE org_id = ? AND user_id = ?').run(orgId, userId)
  return null
}

export function registerCaptureDraftRoutes(app, { authenticate } = {}) {
  const guard = (req, res) => {
    if (!req.user_id || !req.org_id) { res.status(401).json({ error: 'unauthenticated' }); return false }
    return true
  }
  app.get('/brain/capture/draft', authenticate, (req, res) => {
    if (!guard(req, res)) return
    try { res.json({ draft: getDraft(req.org_id, req.user_id) }) } catch (e) { console.error('[Brain] draft get error:', e); res.status(500).json({ error: 'internal_error' }) }
  })
  app.put('/brain/capture/draft', authenticate, (req, res) => {
    if (!guard(req, res)) return
    const { title, text } = req.body || {}
    if ((title != null && typeof title !== 'string') || (text != null && typeof text !== 'string')) return res.status(400).json({ error: 'invalid_draft' })
    if ((text || '').length > MAX_DRAFT_CHARS) return res.status(413).json({ error: 'draft_too_large' })
    try { res.json({ draft: saveDraft(req.org_id, req.user_id, { title, text }) }) } catch (e) { console.error('[Brain] draft put error:', e); res.status(500).json({ error: 'internal_error' }) }
  })
  app.delete('/brain/capture/draft', authenticate, (req, res) => {
    if (!guard(req, res)) return
    try { clearDraft(req.org_id, req.user_id); res.json({ draft: null }) } catch (e) { console.error('[Brain] draft delete error:', e); res.status(500).json({ error: 'internal_error' }) }
  })
}

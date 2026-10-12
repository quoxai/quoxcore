/**
 * PromoteConversationCTA — Promote-this-conversation footer strip.
 *
 * STUDY-REV-2 P10.I-2
 *
 * Renders three save buttons below the chat composer:
 *   "Save as Objective" | "Save as Workflow" | "Save as Crystal"
 *
 * The button matching the `recommendation.primary` gets the qx-btn--primary
 * emphasis class; the other two get the ghost qx-btn style.
 *
 * Props:
 *   corrId           {string}  - AEE correlation ID for the conversation
 *   recommendation   {{ primary: string, confidence: number, alt: string[] }}
 *   conversationHistory {Array} - ChatTab's conversationHistory
 */
import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { createFromConversation } from '../../services/objectivesStore'
import { createDraftFromConversation } from '../../services/crystalStore'

// Icon set — inline SVG, never currentColor per project rule
const SaveIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
)

export default function PromoteConversationCTA({ corrId, recommendation, conversationHistory }) {
  const navigate = useNavigate()
  const { authFetch } = useAuth()
  const [saving, setSaving] = useState(null) // 'objective' | 'workflow' | 'crystal' | null

  const primary = recommendation?.primary || 'objective'

  const btnClass = (type) =>
    type === primary
      ? 'qx-btn qx-btn--primary qx-btn--sm'
      : 'qx-btn qx-btn--sm'

  const handleObjective = useCallback(async () => {
    if (saving) return
    setSaving('objective')
    try {
      const result = await createFromConversation(authFetch, corrId)
      navigate(`/objectives/${result.id}`)
    } catch (err) {
      console.error('[PromoteCTA] objective creation failed:', err)
    } finally {
      setSaving(null)
    }
  }, [authFetch, corrId, navigate, saving])

  const handleWorkflow = useCallback(async () => {
    if (saving) return
    setSaving('workflow')
    try {
      const result = await createFromConversation(authFetch, corrId)
      navigate(`/workflow-builder?fromObjective=${result.id}`)
    } catch (err) {
      console.error('[PromoteCTA] workflow creation failed:', err)
    } finally {
      setSaving(null)
    }
  }, [authFetch, corrId, navigate, saving])

  const handleCrystal = useCallback(async () => {
    if (saving) return
    setSaving('crystal')
    try {
      await createDraftFromConversation(corrId, { authFetch })
      navigate('/crystals/library')
    } catch (err) {
      console.error('[PromoteCTA] crystal draft creation failed:', err)
    } finally {
      setSaving(null)
    }
  }, [authFetch, corrId, navigate, saving])

  return (
    <div className="qx-row promote-cta" style={{ gap: '6px', padding: '4px 0', alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '11px', color: 'var(--text-muted, #8899a8)', marginRight: '4px', whiteSpace: 'nowrap' }}>
        Save as:
      </span>
      <button
        type="button"
        className={btnClass('objective')}
        onClick={handleObjective}
        disabled={!!saving}
        aria-label="Save as Objective"
      >
        <SaveIcon />
        {saving === 'objective' ? 'Saving…' : 'Save as Objective'}
      </button>
      <button
        type="button"
        className={btnClass('workflow')}
        onClick={handleWorkflow}
        disabled={!!saving}
        aria-label="Save as Workflow"
      >
        <SaveIcon />
        {saving === 'workflow' ? 'Saving…' : 'Save as Workflow'}
      </button>
      <button
        type="button"
        className={btnClass('crystal')}
        onClick={handleCrystal}
        disabled={!!saving}
        aria-label="Save as Crystal"
      >
        <SaveIcon />
        {saving === 'crystal' ? 'Saving…' : 'Save as Crystal'}
      </button>
    </div>
  )
}

/**
 * ScoutChatSidebar — thin AgentChatSidebar wrapper for the QuoxSignal surface.
 *
 * Follows the Quox convention set by ToolsmithChatSidebar.jsx: ~80-100
 * lines, contextBuilder only, pass-through collapsed/onToggle. SCOUT talks
 * through the shared ChatEngine/collector `/collector/chat` dispatch here
 * (agentId="scout") — the standalone app's own bespoke ScoutSidebar.jsx
 * (its own message state, its own POST /api/v1/chat call) is NOT ported;
 * this component replaces it entirely with the governed dashboard path.
 *
 * `surface` selects which shape of context to assemble — QuoxSignal has two
 * SCOUT mount points, same as the standalone app: the Proposals queue (a
 * batch of pending findings) and an item's detail page (one item's
 * transcript/triage/lens/proposal). Nothing else mounts SCOUT.
 */

import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'

const SCOUT_SUGGESTIONS = [
  'Explain why this item scored the way it did',
  'Argue against the current verdict',
  'What would re-running the lens on this item likely find?',
  'Draft a QuoxPlan stream entry from this proposal',
]

const stamp = (s) => {
  if (s === null || s === undefined) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function ScoutChatSidebar({
  surface,
  // surface === 'item-detail'
  item,
  lensData,
  proposal,
  // surface === 'proposals'
  proposals,
  // SIGNAL-PIPELINE Discuss & update: when a card's "Discuss" button focuses
  // one proposal, its full record leads the context so SCOUT argues about
  // THAT proposal rather than the queue in general.
  focusProposal,
  collapsed,
  onToggle,
}) {
  const contextBuilder = useCallback(async () => {
    if (surface === 'proposals') {
      const shape = (p) => ({
        id: p.id,
        item_id: p.item_id,
        author: p.author,
        platform: p.platform,
        status: p.status,
        summary: p.summary,
        findings: (p.proposals || []).map((f) => ({
          kind: f.kind, title: f.title, rationale: f.rationale, confidence: f.confidence, evidence: f.evidence,
        })),
      });
      return {
        surface: 'quoxsignal-proposals',
        page: '/quoxsignal?tab=proposals',
        panel: 'QuoxSignal — Proposals (HITL)',
        summary: focusProposal
          ? `Discussing one proposal: "${(focusProposal.summary || focusProposal.id).slice(0, 120)}"`
          : `${(proposals || []).length} proposal(s) in view`,
        focus: focusProposal ? `proposal ${focusProposal.id}` : undefined,
        evidence: {
          focused_proposal: focusProposal ? shape(focusProposal) : null,
          proposals: (proposals || []).map(shape),
        },
        instructions: focusProposal
          ? 'The reviewer is discussing ONE proposal before refining its summary and handing it off — the focused_proposal above. Interrogate it: strongest counter-argument, weakest evidence, what a sharper summary would say. Ground every claim in the evidence quotes provided — never invent findings.'
          : 'Help the reviewer decide pending SCOUT proposals. Ground every claim in the evidence quotes provided — never invent findings.',
      }
    }
    return {
      surface: 'quoxsignal-item-detail',
      page: item ? `/quoxsignal/items/${item.id}` : '/quoxsignal',
      panel: 'QuoxSignal — Item Detail',
      focus: item ? `${item.title || item.id} (stage: ${item.stage})` : 'no item loaded',
      evidence: {
        item: item ? { id: item.id, title: item.title, platform: item.platform, author: item.author, url: item.url, stage: item.stage } : null,
        transcript: (item?.segments || []).map((s) => ({ t: stamp(s.start), text: s.text })),
        triage: item?.triage ?? null,
        lens: lensData?.lenses?.[0] ?? null,
        proposal: proposal ?? null,
      },
      instructions: 'Answer grounded in the transcript/triage/lens/proposal evidence above. Say so plainly if the evidence does not support an answer.',
    }
  }, [surface, item, lensData, proposal, proposals, focusProposal])

  return (
    <AgentChatSidebar
      agentId="scout"
      agentName="SCOUT"
      agentColor="#38bdf8"
      agentRole="Signal Triage"
      contextBuilder={contextBuilder}
      suggestions={SCOUT_SUGGESTIONS}
      sessionPrefix={item ? `SCOUT_ITEM_${item.id}` : 'SCOUT_PROPOSALS'}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask SCOUT to explain, challenge, or draft from this item..."
    />
  )
}

export default ScoutChatSidebar

/**
 * SeerChatSidebar — thin AgentChatSidebar wrapper for the QuoxSEO surface.
 *
 * Mirrors src/components/quoxsignal/ScoutChatSidebar.jsx: a ~80-line wrapper
 * over the shared AgentChatSidebar (agentId="seer"). SEER answers only from
 * its own tools (quoxseo_summary, quoxseo_urls, quoxseo_changes,
 * quoxseo_verify), so the contextBuilder here only tells it which tab the
 * user is looking at, not a copy of the tab's data — the tools are the
 * source of truth, never the UI state.
 */

import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'

const SEER_SUGGESTIONS = [
  'Which pages are orphaned or not in the sitemap?',
  'What changed since the last crawl?',
  'Which indexable pages get impressions but no clicks?',
  'Is the witnessed history intact?',
]

export function SeerChatSidebar({ tab, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    return {
      surface: 'quoxseo-view',
      page: '/quoxseo',
      panel: `QuoxSEO — ${tab || 'overview'} tab`,
      instructions: 'Answer only from your quoxseo_summary/quoxseo_urls/quoxseo_changes/quoxseo_verify tool results. Never invent a metric, URL, or change. Advisory only, never recommend or perform a site change.',
    }
  }, [tab])

  return (
    <AgentChatSidebar
      agentId="seer"
      agentName="SEER"
      agentColor="#34d399"
      agentRole="SEO Intelligence"
      contextBuilder={contextBuilder}
      suggestions={SEER_SUGGESTIONS}
      sessionPrefix="SEER_QUOXSEO"
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask SEER about crawl health, search performance, or changes..."
    />
  )
}

export default SeerChatSidebar

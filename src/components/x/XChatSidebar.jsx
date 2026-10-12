/**
 * XChatSidebar — thin wrapper around AgentChatSidebar for the xtwitter
 * agent, following LinkedInChatSidebar's contextBuilder pattern (the one
 * clean piece of that plugin). X-PLUGIN P3.
 *
 * contextBuilder serialises the live budget + recent claims/posts to
 * markdown so the agent answers from real state, not guesses.
 *
 * NOTE: AgentChatSidebar provides its own glass panel — render bare, no
 * wrapper <aside> (glass-design-system, chat-sidebar rule 2026-07-29).
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Draft a post about our latest release',
  'How much of the posting budget is left?',
  'Draft a 3-post thread announcing the new feature',
  'What drafts are waiting for approval?',
  'Upload an image and attach it to a post',
  'Show my recently published posts',
]

// Pure black is the brand accent but is invisible on the dark cinematic —
// use X's off-white as the visible fallback (manifest keeps #000000).
const X_ACCENT_VISIBLE = '#E7E9EA'

export function XChatSidebar({ budget, claims, ledger, health, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const lines = [
      '## X (Twitter) Context',
      '',
    ]

    if (health?.ok) {
      lines.push(`- **Connection:** Active as @${health.account?.username || 'unknown'} (vault OAuth 1.0a valid)`)
    } else if (health) {
      lines.push(`- **Connection:** FAILING (${health.error || 'credentials invalid'})`)
    } else {
      lines.push('- **Connection:** Not verified this session')
    }

    if (budget) {
      lines.push('')
      lines.push('### Posting budget')
      lines.push(`- **Daily:** ${budget.dailyUsed ?? '?'} of ${budget.dailyLimit ?? '?'} used`)
      lines.push(`- **Monthly:** ${budget.monthlyUsed ?? '?'} of ${budget.monthlyLimit ?? '?'} used`)
    }

    const recentClaims = (claims || []).slice(0, 5)
    if (recentClaims.length > 0) {
      lines.push('')
      lines.push(`### Recent drafts (${recentClaims.length})`)
      recentClaims.forEach((c, i) => {
        const tweets = (c.tweet_ids || []).length
        lines.push(`${i + 1}. ${c.action} — ${c.status}${tweets ? ` (${tweets} tweet${tweets > 1 ? 's' : ''})` : ''} · inbox ${c.inbox_item_id}`)
      })
    } else {
      lines.push('')
      lines.push('### Recent drafts: none')
    }

    const recentPosts = (ledger || []).slice(0, 5)
    if (recentPosts.length > 0) {
      lines.push('')
      lines.push(`### Recently published (${recentPosts.length})`)
      recentPosts.forEach((p, i) => {
        lines.push(`${i + 1}. ${p.kind} ${p.tweet_id || ''} at ${p.posted_at}`)
      })
    }

    lines.push('')
    lines.push('You are HERALD, the Herald social suite voice, covering X (Twitter) as your first channel. You draft and you file for approval, you never publish. Every post goes through owner approval (x_post/x_thread file an Inbox card), so never claim something was published unless it appears in the ledger. Respect the posting budget. Helping write or tighten a post is your job; campaigns, image generation and scheduling belong to other plugins.')

    return lines.join('\n')
  }, [budget, claims, ledger, health])

  return (
    <AgentChatSidebar
      agentId="xtwitter"
      agentName="HERALD"
      agentColor={X_ACCENT_VISIBLE}
      agentRole="Herald social suite, X channel"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask HERALD about your X posting..."
      sessionPrefix="X_CHAT"
    />
  )
}

export default XChatSidebar

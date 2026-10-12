/**
 * FacebookChatSidebar — thin wrapper around AgentChatSidebar. FB-3, mirrors
 * src/components/linkedin/LinkedInChatSidebar.jsx.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Show my recent Facebook Page posts',
  'How is my latest post performing?',
  'Draft a post about our latest blog article',
  'List the lead forms on my Page',
  'Show recent leads from Lead Ads',
  'Check Page follower count',
  'Post to my Facebook Page',
  'Show Page Insights for this week',
]

export function FacebookChatSidebar({ posts, insights, pageInfo, credentialHealth, defaultPageId, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const lines = [
      '## Facebook Context',
      '',
    ]

    if (credentialHealth?.connected) {
      lines.push('- **Connection:** Active (vault credentials valid)')
    } else {
      lines.push('- **Connection:** Not connected (credentials missing or expired)')
    }

    if (defaultPageId) {
      lines.push(`- **Default Page ID:** ${defaultPageId}`)
    }

    if (pageInfo) {
      lines.push('')
      lines.push('### Page')
      lines.push(`- **Name:** ${pageInfo.name || 'Unknown'}`)
      lines.push(`- **Followers:** ${(pageInfo.followers || 0).toLocaleString()}`)
      if (pageInfo.category) lines.push(`- **Category:** ${pageInfo.category}`)
    }

    if (posts && posts.length > 0) {
      lines.push('')
      lines.push(`### Recent Posts (${posts.length})`)
      posts.slice(0, 5).forEach((post, i) => {
        const text = (post.message || '').slice(0, 100)
        lines.push(`${i + 1}. "${text}${text.length >= 100 ? '...' : ''}" (${post.likes || 0} likes, ${post.comments || 0} comments)`)
      })
    } else {
      lines.push('')
      lines.push('### Posts: None found')
    }

    if (insights && insights.length > 0) {
      lines.push('')
      lines.push('### Page Insights')
      insights.slice(0, 3).forEach((m) => lines.push(`- ${m.title || m.name}`))
    }

    lines.push('')
    lines.push('You are the Facebook specialist for organic Pages. Publishing requires human approval. Ads live in a separate plugin. Use your Facebook tools to help the user manage Page posts, insights, and lead forms. Always confirm before publishing.')

    return lines.join('\n')
  }, [posts, insights, pageInfo, credentialHealth, defaultPageId])

  return (
    <AgentChatSidebar
      agentId="facebook"
      agentName="FACEBOOK"
      agentColor="#1877F2"
      agentRole="Social Publisher"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask Facebook agent..."
      sessionPrefix="FACEBOOK_CHAT"
    />
  )
}

export default FacebookChatSidebar

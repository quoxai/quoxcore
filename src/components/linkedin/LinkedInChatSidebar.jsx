/**
 * LinkedInChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Show my recent LinkedIn posts',
  'How is my latest post performing?',
  'Draft a post about our latest blog article',
  'What comments need replies?',
  'Post to the company LinkedIn page',
  'Check org page follower count',
  'Upload an image and create a post',
  'Show engagement trends for recent posts',
]

export function LinkedInChatSidebar({ posts, engagement, orgInfo, credentialHealth, authorUrn, orgUrn, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const lines = [
      '## LinkedIn Context',
      '',
    ]

    if (credentialHealth?.connected) {
      lines.push('- **Connection:** Active (vault credentials valid)')
    } else {
      lines.push('- **Connection:** Not connected (credentials missing or expired)')
    }

    if (authorUrn) {
      lines.push(`- **Author URN:** ${authorUrn}`)
    }
    if (orgUrn) {
      lines.push(`- **Org URN:** ${orgUrn}`)
    }

    if (orgInfo) {
      lines.push('')
      lines.push('### Organisation')
      lines.push(`- **Name:** ${orgInfo.name || 'Unknown'}`)
      lines.push(`- **Followers:** ${(orgInfo.followers || 0).toLocaleString()}`)
      if (orgInfo.website) lines.push(`- **Website:** ${orgInfo.website}`)
    }

    if (posts && posts.length > 0) {
      lines.push('')
      lines.push(`### Recent Posts (${posts.length})`)
      posts.slice(0, 5).forEach((post, i) => {
        const text = (post.text || post.commentary || '').slice(0, 100)
        const eng = engagement?.[post.id]
        const engStr = eng ? ` (${eng.reactions || 0} reactions, ${eng.comments || 0} comments)` : ''
        lines.push(`${i + 1}. "${text}${text.length >= 100 ? '...' : ''}"${engStr}`)
      })

      const totalReactions = Object.values(engagement || {}).reduce((sum, e) => sum + (e?.reactions || 0), 0)
      const totalComments = Object.values(engagement || {}).reduce((sum, e) => sum + (e?.comments || 0), 0)
      if (totalReactions > 0 || totalComments > 0) {
        lines.push('')
        lines.push(`### Engagement Summary`)
        lines.push(`- **Total reactions:** ${totalReactions}`)
        lines.push(`- **Total comments:** ${totalComments}`)
      }
    } else {
      lines.push('')
      lines.push('### Posts: None found')
    }

    lines.push('')
    lines.push('You are the LinkedIn specialist. Use your LinkedIn tools to help the user publish content, check engagement, and manage their LinkedIn presence. Always confirm before publishing.')

    return lines.join('\n')
  }, [posts, engagement, orgInfo, credentialHealth, authorUrn, orgUrn])

  return (
    <AgentChatSidebar
      agentId="linkedin"
      agentName="LINKEDIN"
      agentColor="#0A66C2"
      agentRole="Social Publisher"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask LinkedIn agent..."
      sessionPrefix="LINKEDIN_CHAT"
    />
  )
}

export default LinkedInChatSidebar

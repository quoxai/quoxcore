/**
 * InstagramChatSidebar — thin wrapper around AgentChatSidebar. IG-3, mirrors
 * src/components/facebook/FacebookChatSidebar.jsx.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Show my recent Instagram media',
  'How is my latest post performing?',
  'Publish a reel to Instagram',
  'Check my publishing quota',
  'Show recent comments on my last post',
  'Reply to an Instagram comment',
  'Discover my linked Instagram account',
  'Show Instagram account insights',
]

export function InstagramChatSidebar({ media, account, credentialHealth, igUserId, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const lines = [
      '## Instagram Context',
      '',
    ]

    if (credentialHealth?.connected) {
      lines.push('- **Connection:** Active (shared Meta vault credential, same as Facebook)')
    } else {
      lines.push('- **Connection:** Not connected (credential missing, rejected, or no Instagram account linked)')
    }

    if (igUserId) {
      lines.push(`- **Instagram Account ID:** ${igUserId}`)
    }

    if (account) {
      lines.push('')
      lines.push('### Account')
      lines.push(`- **Username:** ${account.username ? `@${account.username}` : 'Unknown'}`)
      lines.push(`- **Followers:** ${(account.followers || 0).toLocaleString()}`)
      lines.push(`- **Media count:** ${account.media_count ?? 'Unknown'}`)
    }

    if (media && media.length > 0) {
      lines.push('')
      lines.push(`### Recent Media (${media.length})`)
      media.slice(0, 5).forEach((m, i) => {
        const caption = (m.caption || '').slice(0, 100)
        lines.push(`${i + 1}. [${m.media_type || 'MEDIA'}] "${caption}${caption.length >= 100 ? '...' : ''}" (${m.likes || 0} likes, ${m.comments || 0} comments)`)
      })
    } else {
      lines.push('')
      lines.push('### Media: None found')
    }

    lines.push('')
    lines.push('You are the Instagram specialist for a professional account reached through its linked Facebook Page. Publishing (single image/video/reel only, no carousel/stories) and comment replies require human approval. Always confirm before publishing.')

    return lines.join('\n')
  }, [media, account, credentialHealth, igUserId])

  return (
    <AgentChatSidebar
      agentId="instagram"
      agentName="INSTAGRAM"
      agentColor="#E4405F"
      agentRole="Social Publisher"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask Instagram agent..."
      sessionPrefix="INSTAGRAM_CHAT"
    />
  )
}

export default InstagramChatSidebar

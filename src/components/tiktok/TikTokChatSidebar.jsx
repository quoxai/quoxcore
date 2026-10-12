/**
 * TikTokChatSidebar — thin wrapper around AgentChatSidebar. TT-4, mirrors
 * src/components/instagram/InstagramChatSidebar.jsx.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Show my recent TikTok videos',
  'How is my latest video performing?',
  'Publish a video to TikTok',
  'Upload a video as a draft',
  'Check my TikTok token expiry',
  'Look up stats for a specific video',
  'What is my TikTok profile like?',
  'Check the status of a publish',
]

export function TikTokChatSidebar({ videos, profile, credentialHealth, tokenExpiry, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const lines = [
      '## TikTok Context',
      '',
    ]

    if (credentialHealth?.connected) {
      lines.push('- **Connection:** Active (TikTok\'s own vaulted access token)')
    } else {
      lines.push('- **Connection:** Not connected (credential missing or rejected)')
    }

    if (tokenExpiry?.hoursLeft != null) {
      lines.push(`- **Token expires in:** ${tokenExpiry.hoursLeft} hour(s) (24h lifetime, no auto-refresh yet)`)
    }

    if (profile) {
      lines.push('')
      lines.push('### Profile')
      lines.push(`- **Display name:** ${profile.display_name || 'Unknown'}`)
      lines.push(`- **Followers:** ${(profile.followers || 0).toLocaleString()}`)
      lines.push(`- **Video count:** ${profile.videos ?? 'Unknown'}`)
    }

    if (videos && videos.length > 0) {
      lines.push('')
      lines.push(`### Recent Videos (${videos.length})`)
      videos.slice(0, 5).forEach((v, i) => {
        const title = (v.title || '').slice(0, 100)
        lines.push(`${i + 1}. "${title}${title.length >= 100 ? '...' : ''}" (${v.views || 0} views, ${v.likes || 0} likes)`)
      })
    } else {
      lines.push('')
      lines.push('### Videos: None found')
    }

    lines.push('')
    lines.push('You are the TikTok specialist. An unaudited TikTok app is restricted to private (SELF_ONLY) viewing until the app audit clears, and access tokens live only 24 hours with no auto-refresh. Publishing and draft uploads require human approval. Always confirm before publishing.')

    return lines.join('\n')
  }, [videos, profile, credentialHealth, tokenExpiry])

  return (
    <AgentChatSidebar
      agentId="tiktok"
      agentName="TIKTOK"
      agentColor="#FE2C55"
      agentRole="Social Publisher"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask TikTok agent..."
      sessionPrefix="TIKTOK_CHAT"
    />
  )
}

export default TikTokChatSidebar

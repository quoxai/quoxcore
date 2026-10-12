/**
 * YouTubeChatSidebar — thin wrapper around AgentChatSidebar.
 */

import { useCallback } from 'react'
import AgentChatSidebar from '../chat/AgentChatSidebar'

const SUGGESTIONS = [
  'Upload a video',
  'Show my recent videos',
  'How is my latest video performing?',
  'Update the title on my latest video',
  'Set a custom thumbnail',
  'Add my video to a playlist',
  'Show my channel stats',
  'List my playlists',
]

export function YouTubeChatSidebar({ channel, videos, credentialHealth, config, collapsed, onToggle }) {
  const contextBuilder = useCallback(async () => {
    const lines = [
      '## YouTube Context',
      '',
    ]

    if (credentialHealth?.connected) {
      lines.push('- **Connection:** Active (vault credentials valid)')
    } else {
      lines.push('- **Connection:** Not connected (credentials missing or expired)')
    }

    if (channel) {
      lines.push('')
      lines.push('### Channel')
      lines.push(`- **Name:** ${channel.title || 'Unknown'}`)
      if (channel.subscriberCount != null) {
        lines.push(`- **Subscribers:** ${Number(channel.subscriberCount).toLocaleString()}`)
      }
      if (channel.videoCount != null) {
        lines.push(`- **Videos:** ${Number(channel.videoCount).toLocaleString()}`)
      }
      if (channel.viewCount != null) {
        lines.push(`- **Total Views:** ${Number(channel.viewCount).toLocaleString()}`)
      }
      if (channel.customUrl) {
        lines.push(`- **URL:** ${channel.customUrl}`)
      }
    }

    if (videos && videos.length > 0) {
      lines.push('')
      lines.push(`### Recent Videos (${videos.length})`)
      videos.slice(0, 5).forEach((video, i) => {
        const title = (video.title || 'Untitled').slice(0, 80)
        const views = video.viewCount != null ? ` (${Number(video.viewCount).toLocaleString()} views)` : ''
        lines.push(`${i + 1}. "${title}${title.length >= 80 ? '...' : ''}"${views}`)
      })
    } else {
      lines.push('')
      lines.push('### Videos: None found')
    }

    if (config?.channelId) {
      lines.push('')
      lines.push(`### Config`)
      lines.push(`- **Channel ID:** ${config.channelId}`)
      if (config.defaultPrivacy) lines.push(`- **Default Privacy:** ${config.defaultPrivacy}`)
      if (config.defaultCategory) lines.push(`- **Default Category:** ${config.defaultCategory}`)
    }

    lines.push('')
    lines.push('You are the YouTube specialist. Use your YouTube tools to help the user upload videos, manage their channel, update metadata, set thumbnails, and manage playlists. Always confirm before uploading or making changes.')

    return lines.join('\n')
  }, [channel, videos, credentialHealth, config])

  return (
    <AgentChatSidebar
      agentId="youtube"
      agentName="YOUTUBE"
      agentColor="#FF0000"
      agentRole="Video Publisher"
      contextBuilder={contextBuilder}
      suggestions={SUGGESTIONS}
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask YouTube agent..."
      sessionPrefix="YOUTUBE_CHAT"
    />
  )
}

export default YouTubeChatSidebar

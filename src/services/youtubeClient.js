/**
 * YouTube Client
 *
 * Frontend service for calling YouTube connector tools via the collector.
 */

const COLLECTOR_URL = '/collector'

async function callTool(toolName, input = {}) {
  const resp = await fetch(`${COLLECTOR_URL}/tool/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: `youtube_${toolName}`, input }),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`YouTube tool ${toolName} failed: ${resp.status} ${body.slice(0, 200)}`)
  }

  const data = await resp.json()
  if (!data.success) {
    throw new Error(data.error || `YouTube tool ${toolName} returned failure`)
  }

  return data.result
}

export async function getChannel(channelId) {
  return callTool('get_channel', { channel_id: channelId })
}

export async function listVideos(maxResults = 20) {
  return callTool('list_videos', { count: maxResults })
}

export async function getVideo(videoId) {
  return callTool('get_video', { video_id: videoId })
}

export async function uploadVideo({ title, description, tags, privacyStatus, categoryId, filePath }) {
  return callTool('upload_video', {
    title,
    description: description || '',
    tags: tags || [],
    privacy_status: privacyStatus || 'private',
    category_id: categoryId || '22',
    file_path: filePath,
  })
}

export async function updateVideo({ videoId, title, description, tags, privacyStatus, categoryId }) {
  return callTool('update_video', {
    video_id: videoId,
    title: title || undefined,
    description: description || undefined,
    tags: tags || undefined,
    privacy_status: privacyStatus || undefined,
    category_id: categoryId || undefined,
  })
}

export async function setThumbnail(videoId, filePath) {
  return callTool('set_thumbnail', { video_id: videoId, file_path: filePath })
}

export async function listPlaylists(count = 25) {
  return callTool('list_playlists', { count })
}

export async function addToPlaylist(playlistId, videoId) {
  return callTool('add_to_playlist', { playlist_id: playlistId, video_id: videoId })
}

export async function getAnalytics({ videoId, startDate, endDate, metrics }) {
  return callTool('get_analytics', {
    video_id: videoId || undefined,
    start_date: startDate || undefined,
    end_date: endDate || undefined,
    metrics: metrics || undefined,
  })
}

export async function getComments(videoId, count = 20) {
  return callTool('get_comments', { video_id: videoId, count })
}

export async function replyComment(parentId, text) {
  return callTool('reply_comment', { parent_id: parentId, text })
}

export async function moderateComment(commentId, status) {
  return callTool('moderate_comment', { comment_id: commentId, status })
}

export async function uploadCaptions({ videoId, language, name, filePath }) {
  return callTool('upload_captions', {
    video_id: videoId,
    language: language || 'en',
    name: name || '',
    file_path: filePath,
  })
}

export async function scheduleVideo(videoId, publishAt) {
  return callTool('schedule_video', {
    video_id: videoId,
    publish_at: publishAt,
  })
}

export async function checkCredentialHealth() {
  try {
    const resp = await fetch(`${COLLECTOR_URL}/connectors/youtube/status`)
    if (!resp.ok) return { connected: false, error: `HTTP ${resp.status}` }
    return await resp.json()
  } catch (err) {
    return { connected: false, error: err.message }
  }
}

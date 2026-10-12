/**
 * YouTube Connector
 *
 * Tools for the YouTube Data API v3.
 * Requires: access_token, refresh_token, client_id, client_secret, channel_id (optional)
 *
 * API docs: https://developers.google.com/youtube/v3/docs
 */

const fs = require('fs')
const path = require('path')

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3'
const YOUTUBE_UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3'
const READ_TIMEOUT = 30000
const UPLOAD_TIMEOUT = 300000

const ALLOWED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv']
const ALLOWED_THUMBNAIL_EXTENSIONS = ['.jpg', '.jpeg', '.png']
const MAX_VIDEO_SIZE = 128 * 1024 * 1024 * 1024 // 128 GB
const MAX_THUMBNAIL_SIZE = 2 * 1024 * 1024 // 2 MB

/**
 * Validate file path is absolute and doesn't contain traversal sequences.
 * Prevents path traversal attacks on user-supplied file paths.
 */
function validateFilePath(filePath) {
  const resolved = path.resolve(filePath)
  if (resolved !== filePath && !path.isAbsolute(filePath)) {
    throw new Error('File path must be absolute.')
  }
  if (filePath.includes('..') || filePath.includes('\0')) {
    throw new Error('File path contains invalid characters.')
  }
  return resolved
}

async function refreshTokenIfNeeded(creds) {
  if (!creds.expires_at) return creds
  const fiveMinutes = 5 * 60 * 1000
  if (Date.now() < creds.expires_at - fiveMinutes) return creds

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(READ_TIMEOUT),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`YouTube token refresh failed (${resp.status}): ${body.slice(0, 300)}`)
  }

  const data = await resp.json()
  creds.access_token = data.access_token
  creds.expires_at = Date.now() + (data.expires_in || 3600) * 1000
  return creds
}

function handleYouTubeError(status, body) {
  let parsed = null
  try { parsed = JSON.parse(body) } catch {}
  const reason = parsed?.error?.errors?.[0]?.reason || ''

  if (status === 401) {
    throw new Error('YouTube OAuth token expired or revoked. Please re-authorise in Vault.')
  }
  if (status === 403 && reason === 'quotaExceeded') {
    throw new Error('YouTube API quota exceeded. Quota resets at midnight Pacific Time.')
  }
  if (status === 403) {
    throw new Error('Insufficient permissions. Check YouTube API scopes.')
  }
  if (status === 404) {
    throw new Error('Video/playlist not found. Check the ID.')
  }
  if (status === 429) {
    throw new Error('Rate limited by YouTube. Try again in a moment.')
  }
  throw new Error(`YouTube API ${status}: ${body.slice(0, 300)}`)
}

async function youtubeFetch(urlPath, credentials, options = {}) {
  const creds = await refreshTokenIfNeeded(credentials)
  const timeout = options.timeout || READ_TIMEOUT
  const url = urlPath.startsWith('http') ? urlPath : `${YOUTUBE_API}${urlPath}`

  const headers = {
    'Authorization': `Bearer ${creds.access_token}`,
    'Accept': 'application/json',
    ...(options.headers || {}),
  }
  if (options.body && !options.headers?.['Content-Type'] && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json'
  }

  const resp = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(timeout),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    handleYouTubeError(resp.status, body)
  }

  const text = await resp.text()
  return text ? JSON.parse(text) : null
}

function getTools(credentials) {
  return [
    {
      name: 'get_channel',
      description: 'Get YouTube channel details and statistics. Defaults to the authenticated channel.',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Channel ID (optional, defaults to authenticated channel)' },
        },
        required: [],
      },
      execute: async (input, creds) => {
        const params = new URLSearchParams({ part: 'snippet,statistics,contentDetails' })
        if (input.channel_id) {
          params.set('id', input.channel_id)
        } else {
          params.set('mine', 'true')
        }

        const result = await youtubeFetch(`/channels?${params}`, creds)
        const ch = result?.items?.[0]
        if (!ch) throw new Error('No channel found.')

        return {
          success: true,
          channel_id: ch.id,
          title: ch.snippet?.title || null,
          description: ch.snippet?.description || null,
          subscriber_count: ch.statistics?.subscriberCount || '0',
          video_count: ch.statistics?.videoCount || '0',
          view_count: ch.statistics?.viewCount || '0',
          thumbnail_url: ch.snippet?.thumbnails?.default?.url || null,
          uploads_playlist_id: ch.contentDetails?.relatedPlaylists?.uploads || null,
          published_at: ch.snippet?.publishedAt || null,
        }
      },
    },

    {
      name: 'list_videos',
      description: 'List videos from the authenticated channel with statistics.',
      input_schema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of videos to return (max 50, default 20)' },
          page_token: { type: 'string', description: 'Pagination token from previous response' },
        },
        required: [],
      },
      execute: async (input, creds) => {
        const count = Math.min(input.count || 20, 50)

        // Step 1: Get uploads playlist ID
        const channelResult = await youtubeFetch(
          `/channels?part=contentDetails&mine=true`,
          creds
        )
        const uploadsPlaylistId = channelResult?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
        if (!uploadsPlaylistId) throw new Error('Could not find uploads playlist for channel.')

        // Step 2: Get playlist items
        const playlistParams = new URLSearchParams({
          part: 'snippet,contentDetails',
          playlistId: uploadsPlaylistId,
          maxResults: String(count),
        })
        if (input.page_token) playlistParams.set('pageToken', input.page_token)

        const playlistResult = await youtubeFetch(`/playlistItems?${playlistParams}`, creds)
        const items = playlistResult?.items || []
        if (items.length === 0) {
          return { success: true, videos: [], next_page_token: null, total_results: 0 }
        }

        // Step 3: Batch fetch video stats
        const videoIds = items.map(i => i.contentDetails?.videoId).filter(Boolean)
        const statsResult = await youtubeFetch(
          `/videos?part=statistics,status&id=${videoIds.join(',')}`,
          creds
        )
        const statsMap = {}
        for (const v of (statsResult?.items || [])) {
          statsMap[v.id] = v
        }

        const videos = items.map(item => {
          const videoId = item.contentDetails?.videoId
          const stats = statsMap[videoId]
          return {
            video_id: videoId,
            title: item.snippet?.title || null,
            description: (item.snippet?.description || '').slice(0, 500),
            published_at: item.snippet?.publishedAt || null,
            thumbnail_url: item.snippet?.thumbnails?.default?.url || null,
            view_count: stats?.statistics?.viewCount || '0',
            like_count: stats?.statistics?.likeCount || '0',
            comment_count: stats?.statistics?.commentCount || '0',
            privacy_status: stats?.status?.privacyStatus || null,
          }
        })

        return {
          success: true,
          videos,
          next_page_token: playlistResult?.nextPageToken || null,
          total_results: playlistResult?.pageInfo?.totalResults || videos.length,
        }
      },
    },

    {
      name: 'get_video',
      description: 'Get full details and statistics for a single YouTube video.',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'YouTube video ID' },
        },
        required: ['video_id'],
      },
      execute: async (input, creds) => {
        const { video_id } = input
        if (!video_id) throw new Error('video_id is required.')

        const result = await youtubeFetch(
          `/videos?part=snippet,statistics,status,contentDetails&id=${encodeURIComponent(video_id)}`,
          creds
        )
        const v = result?.items?.[0]
        if (!v) throw new Error('Video/playlist not found. Check the ID.')

        return {
          success: true,
          video_id: v.id,
          title: v.snippet?.title || null,
          description: v.snippet?.description || null,
          tags: v.snippet?.tags || [],
          category_id: v.snippet?.categoryId || null,
          published_at: v.snippet?.publishedAt || null,
          privacy_status: v.status?.privacyStatus || null,
          duration: v.contentDetails?.duration || null,
          definition: v.contentDetails?.definition || null,
          view_count: v.statistics?.viewCount || '0',
          like_count: v.statistics?.likeCount || '0',
          comment_count: v.statistics?.commentCount || '0',
          thumbnail_url: v.snippet?.thumbnails?.default?.url || null,
          url: `https://www.youtube.com/watch?v=${v.id}`,
        }
      },
    },

    {
      name: 'upload_video',
      description: 'Upload a video to YouTube using resumable upload. Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the video file' },
          title: { type: 'string', description: 'Video title (max 100 characters)' },
          description: { type: 'string', description: 'Video description (optional)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags (optional)' },
          category_id: { type: 'string', description: 'YouTube category ID (optional, default "22" for People & Blogs)' },
          privacy_status: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'Privacy status (default: private)' },
        },
        required: ['file_path', 'title'],
      },
      execute: async (input, creds) => {
        const {
          file_path: filePath,
          title,
          description = '',
          tags = [],
          category_id = '22',
          privacy_status = 'private',
        } = input

        // Validate path safety + file exists
        const safePath = validateFilePath(filePath)
        if (!fs.existsSync(safePath)) {
          throw new Error(`File not found: ${safePath}`)
        }

        // Validate extension
        const ext = path.extname(safePath).toLowerCase()
        if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext)) {
          throw new Error(`Unsupported video format "${ext}". Allowed: ${ALLOWED_VIDEO_EXTENSIONS.join(', ')}`)
        }

        // Validate size
        const stat = fs.statSync(safePath)
        if (stat.size > MAX_VIDEO_SIZE) {
          throw new Error(`File size ${(stat.size / (1024 * 1024 * 1024)).toFixed(1)} GB exceeds 128 GB limit.`)
        }

        const updatedCreds = await refreshTokenIfNeeded(creds)

        // Step 1: Initiate resumable upload — POST metadata to get upload URI
        const metadata = {
          snippet: {
            title,
            description,
            tags,
            categoryId: category_id,
          },
          status: {
            privacyStatus: privacy_status,
          },
        }

        const initResp = await fetch(
          `${YOUTUBE_UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${updatedCreds.access_token}`,
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Length': String(stat.size),
              'X-Upload-Content-Type': 'video/*',
            },
            body: JSON.stringify(metadata),
            signal: AbortSignal.timeout(READ_TIMEOUT),
          }
        )

        if (!initResp.ok) {
          const body = await initResp.text().catch(() => '')
          handleYouTubeError(initResp.status, body)
        }

        const uploadUri = initResp.headers.get('location')
        if (!uploadUri) {
          throw new Error('YouTube did not return a resumable upload URI.')
        }

        // Step 2: Upload file bytes
        const fileBuffer = fs.readFileSync(safePath)
        const uploadResp = await fetch(uploadUri, {
          method: 'PUT',
          headers: {
            'Content-Type': 'video/*',
            'Content-Length': String(stat.size),
          },
          body: fileBuffer,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
        })

        if (!uploadResp.ok) {
          const body = await uploadResp.text().catch(() => '')
          handleYouTubeError(uploadResp.status, body)
        }

        const video = await uploadResp.json()

        return {
          success: true,
          video_id: video.id,
          title: video.snippet?.title || title,
          privacy_status: video.status?.privacyStatus || privacy_status,
          url: `https://www.youtube.com/watch?v=${video.id}`,
          upload_status: video.status?.uploadStatus || 'uploaded',
        }
      },
    },

    {
      name: 'update_video',
      description: 'Update a YouTube video title, description, tags, category, or privacy status. Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'YouTube video ID' },
          title: { type: 'string', description: 'New title (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'New tags (optional)' },
          category_id: { type: 'string', description: 'New category ID (optional)' },
          privacy_status: { type: 'string', enum: ['public', 'unlisted', 'private'], description: 'New privacy status (optional)' },
        },
        required: ['video_id'],
      },
      execute: async (input, creds) => {
        const { video_id, title, description, tags, category_id, privacy_status } = input
        if (!video_id) throw new Error('video_id is required.')

        // YouTube requires the full snippet on update, so fetch current first
        const current = await youtubeFetch(
          `/videos?part=snippet,status&id=${encodeURIComponent(video_id)}`,
          creds
        )
        const existing = current?.items?.[0]
        if (!existing) throw new Error('Video/playlist not found. Check the ID.')

        const updatedFields = []
        const snippet = { ...existing.snippet }
        const status = { ...existing.status }

        if (title !== undefined) { snippet.title = title; updatedFields.push('title') }
        if (description !== undefined) { snippet.description = description; updatedFields.push('description') }
        if (tags !== undefined) { snippet.tags = tags; updatedFields.push('tags') }
        if (category_id !== undefined) { snippet.categoryId = category_id; updatedFields.push('category_id') }
        if (privacy_status !== undefined) { status.privacyStatus = privacy_status; updatedFields.push('privacy_status') }

        if (updatedFields.length === 0) {
          throw new Error('No fields to update. Provide at least one of: title, description, tags, category_id, privacy_status.')
        }

        const body = {
          id: video_id,
          snippet: {
            title: snippet.title,
            description: snippet.description,
            tags: snippet.tags,
            categoryId: snippet.categoryId,
          },
          status: {
            privacyStatus: status.privacyStatus,
          },
        }

        const result = await youtubeFetch(`/videos?part=snippet,status`, creds, {
          method: 'PUT',
          body: JSON.stringify(body),
        })

        return {
          success: true,
          video_id: result?.id || video_id,
          title: result?.snippet?.title || snippet.title,
          privacy_status: result?.status?.privacyStatus || status.privacyStatus,
          updated_fields: updatedFields,
        }
      },
    },

    {
      name: 'set_thumbnail',
      description: 'Set a custom thumbnail for a YouTube video. Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'YouTube video ID' },
          image_path: { type: 'string', description: 'Absolute path to the thumbnail image (.jpg, .jpeg, .png)' },
        },
        required: ['video_id', 'image_path'],
      },
      execute: async (input, creds) => {
        const { video_id, image_path } = input
        if (!video_id) throw new Error('video_id is required.')
        if (!image_path) throw new Error('image_path is required.')

        // Validate path safety + file exists
        const safePath = validateFilePath(image_path)
        if (!fs.existsSync(safePath)) {
          throw new Error(`File not found: ${safePath}`)
        }

        // Validate extension
        const ext = path.extname(safePath).toLowerCase()
        if (!ALLOWED_THUMBNAIL_EXTENSIONS.includes(ext)) {
          throw new Error(`Unsupported image format "${ext}". Allowed: ${ALLOWED_THUMBNAIL_EXTENSIONS.join(', ')}`)
        }

        // Validate size
        const stat = fs.statSync(safePath)
        if (stat.size > MAX_THUMBNAIL_SIZE) {
          throw new Error(`Image size ${(stat.size / (1024 * 1024)).toFixed(1)} MB exceeds 2 MB limit.`)
        }

        const updatedCreds = await refreshTokenIfNeeded(creds)
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg'
        const imageBuffer = fs.readFileSync(safePath)

        const resp = await fetch(
          `${YOUTUBE_UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(video_id)}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${updatedCreds.access_token}`,
              'Content-Type': contentType,
              'Content-Length': String(stat.size),
            },
            body: imageBuffer,
            signal: AbortSignal.timeout(READ_TIMEOUT),
          }
        )

        if (!resp.ok) {
          const body = await resp.text().catch(() => '')
          handleYouTubeError(resp.status, body)
        }

        const result = await resp.json()
        const thumbnailUrl = result?.items?.[0]?.default?.url
          || result?.items?.[0]?.medium?.url
          || null

        return {
          success: true,
          video_id,
          thumbnail_url: thumbnailUrl,
        }
      },
    },

    {
      name: 'list_playlists',
      description: 'List playlists for the authenticated YouTube channel.',
      input_schema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of playlists to return (max 50, default 25)' },
        },
        required: [],
      },
      execute: async (input, creds) => {
        const count = Math.min(input.count || 25, 50)

        const result = await youtubeFetch(
          `/playlists?part=snippet,contentDetails&mine=true&maxResults=${count}`,
          creds
        )

        const playlists = (result?.items || []).map(p => ({
          playlist_id: p.id,
          title: p.snippet?.title || null,
          description: (p.snippet?.description || '').slice(0, 500),
          item_count: p.contentDetails?.itemCount || 0,
          thumbnail_url: p.snippet?.thumbnails?.default?.url || null,
          published_at: p.snippet?.publishedAt || null,
        }))

        return {
          success: true,
          playlists,
        }
      },
    },

    {
      name: 'add_to_playlist',
      description: 'Add a video to a YouTube playlist. Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          playlist_id: { type: 'string', description: 'YouTube playlist ID' },
          video_id: { type: 'string', description: 'YouTube video ID to add' },
          position: { type: 'number', description: 'Position in playlist (0-based, optional — appends to end if omitted)' },
        },
        required: ['playlist_id', 'video_id'],
      },
      execute: async (input, creds) => {
        const { playlist_id, video_id, position } = input
        if (!playlist_id) throw new Error('playlist_id is required.')
        if (!video_id) throw new Error('video_id is required.')

        const body = {
          snippet: {
            playlistId: playlist_id,
            resourceId: {
              kind: 'youtube#video',
              videoId: video_id,
            },
          },
        }

        if (position !== undefined && position !== null) {
          body.snippet.position = position
        }

        const result = await youtubeFetch(`/playlistItems?part=snippet`, creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return {
          success: true,
          playlist_item_id: result?.id || null,
          playlist_id,
          video_id,
          position: result?.snippet?.position ?? position ?? null,
        }
      },
    },

    {
      name: 'get_analytics',
      description: 'Get YouTube Analytics data for the channel or a specific video. Returns views, watch time, and subscriber metrics.',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'Video ID to filter analytics (optional — channel-level if omitted)' },
          start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format (default: 28 days ago)' },
          end_date: { type: 'string', description: 'End date in YYYY-MM-DD format (default: today)' },
          metrics: { type: 'string', description: 'Comma-separated metrics (default: views,estimatedMinutesWatched,averageViewDuration,likes,subscribersGained)' },
        },
        required: [],
      },
      execute: async (input, creds) => {
        const updatedCreds = await refreshTokenIfNeeded(creds)

        const now = new Date()
        const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000)
        const endDate = input.end_date || now.toISOString().split('T')[0]
        const startDate = input.start_date || twentyEightDaysAgo.toISOString().split('T')[0]
        const metrics = input.metrics || 'views,estimatedMinutesWatched,averageViewDuration,likes,subscribersGained'

        const params = new URLSearchParams({
          ids: 'channel==MINE',
          startDate,
          endDate,
          metrics,
          dimensions: 'day',
        })
        if (input.video_id) {
          params.set('filters', `video==${input.video_id}`)
        }

        const url = `https://youtubeanalytics.googleapis.com/v2/reports?${params}`
        const resp = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${updatedCreds.access_token}`,
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(READ_TIMEOUT),
        })

        if (!resp.ok) {
          const body = await resp.text().catch(() => '')
          handleYouTubeError(resp.status, body)
        }

        const data = await resp.json()
        const rows = data.rows || []

        // Aggregate totals
        let totalViews = 0
        let totalWatchTime = 0
        let totalAvgDuration = 0
        let totalLikes = 0
        let totalSubsGained = 0

        const daily = rows.map(row => {
          totalViews += row[1] || 0
          totalWatchTime += row[2] || 0
          totalAvgDuration += row[3] || 0
          totalLikes += row[4] || 0
          totalSubsGained += row[5] || 0
          return {
            date: row[0],
            views: row[1] || 0,
            watch_time: row[2] || 0,
          }
        })

        const dayCount = rows.length || 1

        return {
          success: true,
          start_date: startDate,
          end_date: endDate,
          video_id: input.video_id || null,
          metrics: {
            views: totalViews,
            watch_time_minutes: Math.round(totalWatchTime * 100) / 100,
            avg_duration_seconds: Math.round((totalAvgDuration / dayCount) * 100) / 100,
            likes: totalLikes,
            subscribers_gained: totalSubsGained,
          },
          daily,
        }
      },
    },

    {
      name: 'get_comments',
      description: 'Get comments on a YouTube video with replies.',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'YouTube video ID' },
          count: { type: 'number', description: 'Number of comments to return (max 100, default 20)' },
          page_token: { type: 'string', description: 'Pagination token from previous response' },
        },
        required: ['video_id'],
      },
      execute: async (input, creds) => {
        const { video_id, page_token } = input
        if (!video_id) throw new Error('video_id is required.')

        const count = Math.min(input.count || 20, 100)
        const params = new URLSearchParams({
          part: 'snippet,replies',
          videoId: video_id,
          maxResults: String(count),
          order: 'time',
        })
        if (page_token) params.set('pageToken', page_token)

        const result = await youtubeFetch(`/commentThreads?${params}`, creds)
        const items = result?.items || []

        const comments = items.map(item => {
          const top = item.snippet?.topLevelComment?.snippet
          const replies = (item.replies?.comments || []).map(r => ({
            comment_id: r.id,
            author: r.snippet?.authorDisplayName || null,
            text: r.snippet?.textDisplay || '',
            published_at: r.snippet?.publishedAt || null,
          }))

          return {
            comment_id: item.id,
            author: top?.authorDisplayName || null,
            author_channel_id: top?.authorChannelId?.value || null,
            text: top?.textDisplay || '',
            published_at: top?.publishedAt || null,
            like_count: top?.likeCount || 0,
            reply_count: item.snippet?.totalReplyCount || 0,
            replies,
          }
        })

        return {
          success: true,
          comments,
          next_page_token: result?.nextPageToken || null,
          total_results: result?.pageInfo?.totalResults || comments.length,
        }
      },
    },

    {
      name: 'reply_comment',
      description: 'Reply to a comment on a YouTube video. Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          parent_id: { type: 'string', description: 'Comment thread ID to reply to' },
          text: { type: 'string', description: 'Reply text' },
        },
        required: ['parent_id', 'text'],
      },
      execute: async (input, creds) => {
        const { parent_id, text } = input
        if (!parent_id) throw new Error('parent_id is required.')
        if (!text) throw new Error('text is required.')

        const body = {
          snippet: {
            parentId: parent_id,
            textOriginal: text,
          },
        }

        const result = await youtubeFetch(`/comments?part=snippet`, creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return {
          success: true,
          comment_id: result?.id || null,
          parent_id,
          text_length: text.length,
        }
      },
    },

    {
      name: 'moderate_comment',
      description: 'Set moderation status on a YouTube comment. Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          comment_id: { type: 'string', description: 'Comment ID to moderate' },
          status: { type: 'string', enum: ['published', 'heldForReview', 'rejected'], description: 'New moderation status' },
        },
        required: ['comment_id', 'status'],
      },
      execute: async (input, creds) => {
        const { comment_id, status } = input
        if (!comment_id) throw new Error('comment_id is required.')
        if (!status) throw new Error('status is required.')

        const allowedStatuses = ['published', 'heldForReview', 'rejected']
        if (!allowedStatuses.includes(status)) {
          throw new Error(`Invalid status "${status}". Allowed: ${allowedStatuses.join(', ')}`)
        }

        await youtubeFetch(
          `/comments/setModerationStatus?id=${encodeURIComponent(comment_id)}&moderationStatus=${encodeURIComponent(status)}`,
          creds,
          { method: 'POST' }
        )

        return {
          success: true,
          comment_id,
          new_status: status,
        }
      },
    },

    {
      name: 'upload_captions',
      description: 'Upload captions/subtitles for a YouTube video (.srt or .vtt). Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'YouTube video ID' },
          language: { type: 'string', description: 'Caption language code (e.g. "en", "fr", "de")' },
          name: { type: 'string', description: 'Caption track name (optional, defaults to language code)' },
          file_path: { type: 'string', description: 'Absolute path to caption file (.srt or .vtt)' },
        },
        required: ['video_id', 'language', 'file_path'],
      },
      execute: async (input, creds) => {
        const { video_id, language, file_path: filePath } = input
        if (!video_id) throw new Error('video_id is required.')
        if (!language) throw new Error('language is required.')
        if (!filePath) throw new Error('file_path is required.')

        // Validate path safety + file exists
        const safePath = validateFilePath(filePath)
        if (!fs.existsSync(safePath)) {
          throw new Error(`File not found: ${safePath}`)
        }

        // Validate extension
        const ext = path.extname(safePath).toLowerCase()
        const allowedCaptionExts = ['.srt', '.vtt']
        if (!allowedCaptionExts.includes(ext)) {
          throw new Error(`Unsupported caption format "${ext}". Allowed: ${allowedCaptionExts.join(', ')}`)
        }

        const updatedCreds = await refreshTokenIfNeeded(creds)
        const captionName = input.name || language

        const metadata = {
          snippet: {
            videoId: video_id,
            language,
            name: captionName,
            isDraft: false,
          },
        }

        // Step 1: Initiate resumable upload
        const stat = fs.statSync(safePath)
        const contentType = ext === '.vtt' ? 'text/vtt' : 'application/x-subrip'

        const initResp = await fetch(
          `${YOUTUBE_UPLOAD_API}/captions?uploadType=resumable&part=snippet`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${updatedCreds.access_token}`,
              'Content-Type': 'application/json; charset=UTF-8',
              'X-Upload-Content-Length': String(stat.size),
              'X-Upload-Content-Type': contentType,
            },
            body: JSON.stringify(metadata),
            signal: AbortSignal.timeout(READ_TIMEOUT),
          }
        )

        if (!initResp.ok) {
          const body = await initResp.text().catch(() => '')
          handleYouTubeError(initResp.status, body)
        }

        const uploadUri = initResp.headers.get('location')
        if (!uploadUri) {
          throw new Error('YouTube did not return a resumable upload URI.')
        }

        // Step 2: Upload caption file
        const fileBuffer = fs.readFileSync(safePath)
        const uploadResp = await fetch(uploadUri, {
          method: 'PUT',
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(stat.size),
          },
          body: fileBuffer,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
        })

        if (!uploadResp.ok) {
          const body = await uploadResp.text().catch(() => '')
          handleYouTubeError(uploadResp.status, body)
        }

        const result = await uploadResp.json()

        return {
          success: true,
          caption_id: result?.id || null,
          video_id,
          language,
        }
      },
    },

    {
      name: 'schedule_video',
      description: 'Schedule a YouTube video for future publication. Always confirm with the user before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'YouTube video ID' },
          publish_at: { type: 'string', description: 'Scheduled publish time as ISO 8601 datetime (e.g. "2026-04-01T15:00:00Z")' },
        },
        required: ['video_id', 'publish_at'],
      },
      execute: async (input, creds) => {
        const { video_id, publish_at } = input
        if (!video_id) throw new Error('video_id is required.')
        if (!publish_at) throw new Error('publish_at is required.')

        // Fetch current video to get existing status
        const current = await youtubeFetch(
          `/videos?part=status&id=${encodeURIComponent(video_id)}`,
          creds
        )
        const existing = current?.items?.[0]
        if (!existing) throw new Error('Video/playlist not found. Check the ID.')

        // YouTube requires video to be private when scheduling
        const body = {
          id: video_id,
          status: {
            privacyStatus: 'private',
            publishAt: publish_at,
          },
        }

        const result = await youtubeFetch(`/videos?part=status`, creds, {
          method: 'PUT',
          body: JSON.stringify(body),
        })

        return {
          success: true,
          video_id: result?.id || video_id,
          scheduled_at: result?.status?.publishAt || publish_at,
          privacy_status: result?.status?.privacyStatus || 'private',
        }
      },
    },
  ]
}

module.exports = { getTools }

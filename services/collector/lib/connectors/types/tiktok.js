/**
 * TikTok Connector
 *
 * Tools for the TikTok Content Posting API + Display API: profile/video
 * reads and governed video publishing. Requires: access_token, refresh_token,
 * client_key, client_secret (see integrationTypeRegistry.js 'tiktok' entry —
 * refresh_token/client_key/client_secret are collected for a refresh flow
 * this connector does NOT perform; see the 401 branch below).
 *
 * LIVE-VERIFIED CONTRACT (developers.tiktok.com, 2026-09-18):
 *  - Direct publish: POST /post/publish/video/init/ -> { publish_id, upload_url },
 *    then PUT the video bytes to upload_url (chunked; single chunk when the
 *    file fits in one chunk).
 *  - Status: POST /post/publish/status/fetch/ with { publish_id }.
 *  - Display reads: GET /user/info/, POST /video/list/.
 *  - UNAUDITED APP RESTRICTION (hard external gate, not worked around here):
 *    all content posted by an unaudited TikTok app is restricted to private
 *    (SELF_ONLY) viewing until TikTok approves the app's audit.
 *  - Token contract: access_token lives 86400s (24h); refresh_token lives
 *    365d and ROTATES on every refresh. No auto-refresh is built in this
 *    phase (the shared vault write-back machinery is a separate stream,
 *    YT-O-2) — a dead access_token 401s honestly; rotate the credential.
 *
 * KNOWLEDGE-BASED, NOT LIVE-VERIFIED TONIGHT: the draft/inbox upload path
 * (POST /post/publish/inbox/video/init/) and the video/query bulk-stats
 * endpoint. Both are documented by TikTok and shape-consistent with the
 * live-verified direct-publish contract above, but neither was hit against
 * the real API before this connector shipped.
 *
 * SECURITY: no token is ever accepted from tool input or emitted in any tool
 * output or thrown error message. tiktokFetch carries the vaulted access
 * token as a Bearer header only.
 *
 * API docs: https://developers.tiktok.com/doc/overview/
 */

const fs = require('node:fs')
const path = require('node:path')

const TIKTOK_API = 'https://open.tiktokapis.com/v2'

// TikTok's real chunk contract: a file that fits in one chunk uploads as a
// single PUT (chunk_size = video_size, total_chunk_count = 1); anything
// larger is split into chunks no bigger than this cap. 64MB is TikTok's
// documented per-chunk ceiling.
const CHUNK_CAP_BYTES = 64 * 1024 * 1024

// Deliverable-mandated cap on any one video this connector will handle.
const MAX_VIDEO_BYTES = 128 * 1024 * 1024

// TT-2: the org media root a video_path must resolve inside. This is the
// SAME symlink-safe containment pattern as xPostingStore.resolveOrgMediaPath
// (realpath both the org root and the candidate file, reject anything whose
// relative path escapes the root) — TikTok gets its OWN root rather than
// reusing X's x-media directory, because a TikTok video is a distinct media
// class from an X image/GIF/video attachment, not the same uploaded asset
// library. Test-injectable so tests never need root-owned /var/lib access.
let MEDIA_ROOT = '/var/lib/quox/tiktok-media'

/** Test-only: point video path resolution at a temp directory. */
function __setMediaRootForTesting(root) {
  MEDIA_ROOT = root
}

/** Test-only: restore the production media root. */
function __resetMediaRootForTesting() {
  MEDIA_ROOT = '/var/lib/quox/tiktok-media'
}

/**
 * Resolve a caller-supplied video path to a real, containment-checked
 * absolute path under MEDIA_ROOT/<org_id>/, refusing traversal, symlink
 * escapes, and files over MAX_VIDEO_BYTES. Never throws — callers turn a
 * { ok: false, error } into a thrown Error at the tool boundary.
 */
function resolveOrgVideoPath(orgId, inputPath) {
  if (!orgId) return { ok: false, error: 'orgId is required to resolve a video path' }
  if (!inputPath || typeof inputPath !== 'string') {
    return { ok: false, error: 'video_path is required' }
  }

  const orgRoot = path.join(MEDIA_ROOT, String(orgId))
  const candidate = path.isAbsolute(inputPath) ? inputPath : path.join(orgRoot, inputPath)

  let realOrgRoot
  try {
    realOrgRoot = fs.realpathSync(orgRoot)
  } catch {
    return { ok: false, error: `media directory for this org does not exist: ${orgRoot}` }
  }

  let realCandidate
  try {
    realCandidate = fs.realpathSync(candidate)
  } catch {
    return { ok: false, error: `video file not found: ${inputPath}` }
  }

  const relFromRoot = path.relative(realOrgRoot, realCandidate)
  const escapes = relFromRoot === '' || relFromRoot === '..' || relFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relFromRoot)
  if (escapes) {
    return { ok: false, error: `video path escapes the org media root: ${inputPath}` }
  }

  let stat
  try {
    stat = fs.statSync(realCandidate)
  } catch (err) {
    return { ok: false, error: `could not read video file: ${err.message}` }
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'video_path is not a regular file' }
  }
  if (stat.size === 0) {
    return { ok: false, error: 'video file is empty' }
  }
  if (stat.size > MAX_VIDEO_BYTES) {
    return { ok: false, error: `video exceeds the ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))}MB limit (${stat.size} bytes)` }
  }

  return { ok: true, absolutePath: realCandidate, relativePath: relFromRoot, size: stat.size, filename: path.basename(realCandidate) }
}

/**
 * Single chunk when the file fits within the cap; otherwise split into
 * CHUNK_CAP_BYTES chunks (the last one shorter). Mirrors TikTok's documented
 * video/init chunk_size + total_chunk_count contract.
 */
function computeChunkPlan(size) {
  if (size <= CHUNK_CAP_BYTES) {
    return { chunk_size: size, total_chunk_count: 1 }
  }
  return { chunk_size: CHUNK_CAP_BYTES, total_chunk_count: Math.ceil(size / CHUNK_CAP_BYTES) }
}

/** Bearer-authed fetch against the TikTok API with status-branched errors. */
async function tiktokFetch(pathOrUrl, credentials, options = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${TIKTOK_API}${pathOrUrl}`
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.access_token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  })

  const text = await resp.text().catch(() => '')
  let body = null
  if (text) {
    try { body = JSON.parse(text) } catch (_) { body = null }
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error('TikTok API 401: access token expired or invalid. TikTok access tokens live 24 hours; rotate the credential with a fresh access_token from the vault.')
    }
    if (resp.status === 403) {
      const hint = body?.error?.message ? ` (${body.error.message})` : ''
      throw new Error(`TikTok API 403: permission denied.${hint} Check the token's scopes; note that an unaudited TikTok app is restricted to private (SELF_ONLY) content until TikTok approves the app audit.`)
    }
    if (resp.status === 429) {
      throw new Error('TikTok API 429: rate limit exceeded. Try again later.')
    }
    throw new Error(`TikTok API ${resp.status}: ${(text || '').slice(0, 300)}`)
  }

  // TikTok answers HTTP 200 with its own error envelope even on a failed call.
  if (body?.error && body.error.code && body.error.code !== 'ok') {
    throw new Error(`TikTok API error (${body.error.code}): ${body.error.message || 'unknown error'}`)
  }

  return body
}

/** PUT the video bytes to TikTok's upload_url, one chunk per request. */
async function uploadVideoBytes(uploadUrl, absolutePath, size, chunkPlan) {
  const fd = fs.openSync(absolutePath, 'r')
  try {
    let offset = 0
    while (offset < size) {
      const length = Math.min(chunkPlan.chunk_size, size - offset)
      const buffer = Buffer.alloc(length)
      const read = fs.readSync(fd, buffer, 0, length, offset)
      if (read !== length) {
        throw new Error('TikTok video upload: file changed size during upload')
      }
      const end = offset + length - 1
      const resp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${offset}-${end}/${size}`,
          'Content-Length': String(length),
        },
        body: buffer,
        signal: AbortSignal.timeout(60000),
      })
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '')
        throw new Error(`TikTok video upload PUT failed at byte ${offset}: HTTP ${resp.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
      }
      offset += length
    }
  } finally {
    fs.closeSync(fd)
  }
}

const PRIVACY_LEVELS = ['SELF_ONLY', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE']

/** Best-effort, display-only file summary for an approval card. approvalCard
 * runs with input ONLY (no orgId/creds — see connectors/bridge.js), so it
 * cannot run the org-scoped containment check; that check (and the size cap)
 * is enforced for real in execute() below. Only the basename is ever shown,
 * never the caller-supplied path itself, so a card can never leak a raw
 * absolute or traversal-shaped path even before containment is checked. */
function summarizeVideoForCard(videoPath) {
  const filename = videoPath ? path.basename(String(videoPath)) : 'unknown file'
  let sizeLabel = 'size confirmed at execution'
  try {
    const stat = fs.statSync(videoPath)
    if (stat.isFile()) sizeLabel = `${(stat.size / (1024 * 1024)).toFixed(1)}MB`
  } catch (_) { /* best effort only */ }
  return { filename, sizeLabel }
}

function getTools(credentials) {
  return [
    {
      name: 'get_profile',
      description: 'Get the connected TikTok account profile (display name, avatar, follower/following/likes/video counts).',
      input_schema: { type: 'object', properties: {} },
      execute: async (input, creds) => {
        const body = await tiktokFetch(
          '/user/info/?fields=open_id,union_id,avatar_url,display_name,follower_count,following_count,likes_count,video_count',
          creds
        )
        const user = body?.data?.user || {}
        return {
          open_id: user.open_id ?? null,
          union_id: user.union_id ?? null,
          avatar_url: user.avatar_url ?? null,
          display_name: user.display_name ?? null,
          followers: user.follower_count ?? null,
          following: user.following_count ?? null,
          likes: user.likes_count ?? null,
          videos: user.video_count ?? null,
        }
      },
    },

    {
      name: 'list_videos',
      description: 'List the connected account\'s recent videos.',
      input_schema: {
        type: 'object',
        properties: {
          max_count: { type: 'number', description: 'Max videos to return (default 10, max 20)' },
        },
      },
      execute: async (input, creds) => {
        const max_count = Math.min(input?.max_count || 10, 20)
        const body = await tiktokFetch(
          '/video/list/?fields=id,title,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count',
          creds,
          { method: 'POST', body: JSON.stringify({ max_count }) }
        )
        const videos = body?.data?.videos || []
        return {
          videos: videos.map((v) => ({
            id: v.id,
            title: v.title ?? null,
            create_time: v.create_time ?? null,
            cover_image_url: v.cover_image_url ?? null,
            share_url: v.share_url ?? null,
            views: v.view_count ?? null,
            likes: v.like_count ?? null,
            comments: v.comment_count ?? null,
            shares: v.share_count ?? null,
          })),
          cursor: body?.data?.cursor ?? null,
          has_more: body?.data?.has_more ?? null,
        }
      },
    },

    {
      name: 'get_video_stats',
      description: 'Get engagement stats for specific videos by id.',
      input_schema: {
        type: 'object',
        properties: {
          video_ids: { type: 'array', items: { type: 'string' }, description: 'TikTok video IDs to look up' },
        },
        required: ['video_ids'],
      },
      execute: async (input, creds) => {
        if (!Array.isArray(input?.video_ids) || input.video_ids.length === 0) {
          throw new Error('get_video_stats requires a non-empty video_ids array')
        }
        const body = await tiktokFetch(
          '/video/query/?fields=id,title,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count',
          creds,
          { method: 'POST', body: JSON.stringify({ filters: { video_ids: input.video_ids } }) }
        )
        const videos = body?.data?.videos || []
        return videos.map((v) => ({
          id: v.id,
          title: v.title ?? null,
          create_time: v.create_time ?? null,
          cover_image_url: v.cover_image_url ?? null,
          share_url: v.share_url ?? null,
          views: v.view_count ?? null,
          likes: v.like_count ?? null,
          comments: v.comment_count ?? null,
          shares: v.share_count ?? null,
        }))
      },
    },

    {
      name: 'get_publish_status',
      description: 'Check the status of a video publish or draft upload by publish_id (lets a caller follow up on an approved publish honestly).',
      input_schema: {
        type: 'object',
        properties: {
          publish_id: { type: 'string', description: 'The publish_id returned by publish_video or upload_draft' },
        },
        required: ['publish_id'],
      },
      execute: async (input, creds) => {
        if (!input?.publish_id) {
          throw new Error('get_publish_status requires publish_id')
        }
        const body = await tiktokFetch('/post/publish/status/fetch/', creds, {
          method: 'POST',
          body: JSON.stringify({ publish_id: input.publish_id }),
        })
        const data = body?.data || {}
        return {
          publish_id: input.publish_id,
          status: data.status ?? null,
          fail_reason: data.fail_reason ?? null,
          uploaded_bytes: data.uploaded_bytes ?? null,
          // TikTok's own (misspelled) field name is publicaly_available_post_id;
          // passed through under a corrected key for our output shape.
          publicly_available_post_ids: data.publicaly_available_post_id ?? null,
        }
      },
    },

    {
      name: 'publish_video',
      description: 'Publish a video directly to TikTok from a file under the org media root. Files a human approval request; the video goes out only after an approver says yes. NOTE: an unaudited TikTok app is restricted to private (SELF_ONLY) viewing regardless of privacy_level, until TikTok approves the app audit.',
      requiresApproval: true,
      approvalCard: (input) => {
        const { filename, sizeLabel } = summarizeVideoForCard(input.video_path)
        const privacy_level = input.privacy_level || 'SELF_ONLY'
        return {
          title: 'TikTok video awaiting approval',
          bodyMd: `**Publish to TikTok** (${privacy_level})\n\n**Title:** ${String(input.title || 'untitled').slice(0, 500)}\n\n**File:** ${filename} (${sizeLabel})`,
          payloadExtra: {
            source: 'tiktok-plugin',
            card: {
              kind: 'publish_video',
              title: input.title || null,
              privacy_level,
              file: filename,
            },
          },
        }
      },
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Video title/caption' },
          video_path: { type: 'string', description: 'Path to the video file, relative to the org media root' },
          privacy_level: { type: 'string', enum: PRIVACY_LEVELS, description: 'Requested privacy level (default SELF_ONLY). Passed through as requested; never silently downgraded.' },
          disable_duet: { type: 'boolean', description: 'Disable duets on this video (default false)' },
          disable_comment: { type: 'boolean', description: 'Disable comments on this video (default false)' },
          disable_stitch: { type: 'boolean', description: 'Disable stitching on this video (default false)' },
        },
        required: ['title', 'video_path'],
      },
      execute: async (input, creds, ctx) => {
        const { title, video_path } = input
        if (!title || !String(title).trim()) {
          throw new Error('publish_video requires a non-empty title')
        }
        if (!video_path) {
          throw new Error('publish_video requires video_path')
        }
        const privacy_level = input.privacy_level || 'SELF_ONLY'
        if (!PRIVACY_LEVELS.includes(privacy_level)) {
          throw new Error(`privacy_level must be one of ${PRIVACY_LEVELS.join(', ')} (got ${privacy_level})`)
        }

        const orgId = ctx?.orgId || null
        const resolved = resolveOrgVideoPath(orgId, video_path)
        if (!resolved.ok) {
          throw new Error(`publish_video: ${resolved.error}`)
        }

        const chunkPlan = computeChunkPlan(resolved.size)
        const initBody = await tiktokFetch('/post/publish/video/init/', creds, {
          method: 'POST',
          body: JSON.stringify({
            post_info: {
              title,
              privacy_level,
              disable_duet: !!input.disable_duet,
              disable_comment: !!input.disable_comment,
              disable_stitch: !!input.disable_stitch,
            },
            source_info: {
              source: 'FILE_UPLOAD',
              video_size: resolved.size,
              chunk_size: chunkPlan.chunk_size,
              total_chunk_count: chunkPlan.total_chunk_count,
            },
          }),
        })

        const publish_id = initBody?.data?.publish_id
        const upload_url = initBody?.data?.upload_url
        if (!publish_id || !upload_url) {
          throw new Error('TikTok did not return a publish_id/upload_url for the video init call')
        }

        await uploadVideoBytes(upload_url, resolved.absolutePath, resolved.size, chunkPlan)

        const note = privacy_level === 'SELF_ONLY'
          ? 'Video uploaded and queued for publish (SELF_ONLY / private).'
          : `Requested privacy_level=${privacy_level} was sent to TikTok exactly as asked (never silently downgraded). An unaudited TikTok app is restricted to private (SELF_ONLY) viewing until TikTok approves the app audit, so TikTok itself may override this. Call get_publish_status with publish_id "${publish_id}" to see the outcome TikTok actually applied.`

        return { success: true, publish_id, privacy_level, note }
      },
    },

    {
      name: 'upload_draft',
      description: 'Upload a video to the connected account\'s TikTok inbox as a draft, for the user to finish and publish from within the TikTok app. Files a human approval request; the upload happens only after an approver says yes.',
      requiresApproval: true,
      approvalCard: (input) => {
        const { filename, sizeLabel } = summarizeVideoForCard(input.video_path)
        return {
          title: 'TikTok draft upload awaiting approval',
          bodyMd: `**Upload TikTok draft**\n\n**Title:** ${String(input.title || 'untitled').slice(0, 500)}\n\n**File:** ${filename} (${sizeLabel})\n\nThe draft is finished and published manually inside the TikTok app.`,
          payloadExtra: {
            source: 'tiktok-plugin',
            card: {
              kind: 'upload_draft',
              title: input.title || null,
              file: filename,
            },
          },
        }
      },
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Working title for the draft (display only; TikTok\'s draft/inbox endpoint does not accept post metadata)' },
          video_path: { type: 'string', description: 'Path to the video file, relative to the org media root' },
        },
        required: ['video_path'],
      },
      execute: async (input, creds, ctx) => {
        const { video_path } = input
        if (!video_path) {
          throw new Error('upload_draft requires video_path')
        }

        const orgId = ctx?.orgId || null
        const resolved = resolveOrgVideoPath(orgId, video_path)
        if (!resolved.ok) {
          throw new Error(`upload_draft: ${resolved.error}`)
        }

        const chunkPlan = computeChunkPlan(resolved.size)
        // KNOWLEDGE-BASED, not live-verified tonight: the inbox/draft init
        // endpoint takes source_info only, no post_info — a draft's title
        // and other metadata are set by the user finishing it in-app.
        const initBody = await tiktokFetch('/post/publish/inbox/video/init/', creds, {
          method: 'POST',
          body: JSON.stringify({
            source_info: {
              source: 'FILE_UPLOAD',
              video_size: resolved.size,
              chunk_size: chunkPlan.chunk_size,
              total_chunk_count: chunkPlan.total_chunk_count,
            },
          }),
        })

        const publish_id = initBody?.data?.publish_id
        const upload_url = initBody?.data?.upload_url
        if (!publish_id || !upload_url) {
          throw new Error('TikTok did not return a publish_id/upload_url for the inbox/draft init call')
        }

        await uploadVideoBytes(upload_url, resolved.absolutePath, resolved.size, chunkPlan)

        return {
          success: true,
          publish_id,
          note: 'Video uploaded to the TikTok inbox as a draft. Finish and publish it from within the TikTok app.',
        }
      },
    },
  ]
}

module.exports = {
  getTools,
  TIKTOK_API,
  CHUNK_CAP_BYTES,
  MAX_VIDEO_BYTES,
  computeChunkPlan,
  resolveOrgVideoPath,
  __setMediaRootForTesting,
  __resetMediaRootForTesting,
}

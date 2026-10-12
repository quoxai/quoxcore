/**
 * Instagram Connector
 *
 * Tools for the Meta Graph API — Instagram professional accounts: discovery
 * via the linked Facebook Page, reads, insights, comments, and governed
 * publishing. Requires: access_token (the SAME long-lived Meta User/Page
 * access token used by the Facebook connector — the IG professional account
 * is reached through its linked Facebook Page, so no separate credential
 * type exists; credentialType stays 'meta').
 *
 * Boundary: single image/video/reel publishing only. Carousel (multi-item)
 * posts are NOT built in v1 — see the sibling facebook.js/linkedin.js
 * connectors for the shape this mirrors; carousel is a future addition, not
 * a silent gap.
 *
 * SECURITY: no token is ever accepted from tool input or emitted in any tool
 * output or thrown error message. graphFetch (metaGraph.js) carries the
 * vaulted token as a Bearer header only.
 *
 * API docs: https://developers.facebook.com/docs/instagram-platform/
 */

const { graphFetch } = require('../metaGraph.js')

// Container publish status is async. Poll status_code every ~2s up to ~20s
// (live-verified contract). Module-level so tests can shrink both to run the
// poll loop in milliseconds instead of real seconds — mirrors the LinkedIn
// AVAILABLE-polling test pattern (linkedinResolveE2e.test.js), except here
// the interval itself is injectable rather than relying on a first-try mock.
let CONTAINER_POLL_INTERVAL_MS = 2000
let CONTAINER_POLL_TIMEOUT_MS = 20000

/** Test-only: shrink the poll interval/timeout so container polling tests run fast. */
function __setContainerPollTimingForTesting(intervalMs, timeoutMs) {
  CONTAINER_POLL_INTERVAL_MS = intervalMs
  CONTAINER_POLL_TIMEOUT_MS = timeoutMs
}

/** Test-only: restore the production poll timing. */
function __resetContainerPollTimingForTesting() {
  CONTAINER_POLL_INTERVAL_MS = 2000
  CONTAINER_POLL_TIMEOUT_MS = 20000
}

/**
 * Poll a media container's status_code until FINISHED, ERROR/EXPIRED, or the
 * timeout elapses. Never calls media_publish itself — the caller does that
 * only after this resolves, so a stuck container never gets silently
 * skip-published.
 */
async function waitForContainerFinished(creationId, creds) {
  const start = Date.now()
  for (;;) {
    const info = await graphFetch(`/${encodeURIComponent(creationId)}?fields=status_code`, creds)
    const status = info?.status_code
    if (status === 'FINISHED') return
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new Error(`Instagram media container ${creationId} failed to process (status ${status})`)
    }
    if (Date.now() - start >= CONTAINER_POLL_TIMEOUT_MS) {
      throw new Error(
        `Instagram media container ${creationId} is still IN_PROGRESS after ${CONTAINER_POLL_TIMEOUT_MS}ms; `
        + `publish was not attempted (media_publish was never called). Retry publish_media with the same input once processing finishes.`
      )
    }
    await new Promise((r) => setTimeout(r, CONTAINER_POLL_INTERVAL_MS))
  }
}

function getTools(credentials) {
  return [
    {
      name: 'discover_account',
      description: 'Resolve the Instagram professional account linked to a Facebook Page. Honest error when no Instagram account is linked.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Facebook Page ID to resolve the linked Instagram account for (optional; when omitted, checks every Page this token can manage)' },
        },
      },
      execute: async (input, creds) => {
        const page_id = input?.page_id
        let page
        if (page_id) {
          page = await graphFetch(`/${encodeURIComponent(page_id)}?fields=id,name,instagram_business_account`, creds)
        } else {
          const pages = await graphFetch('/me/accounts?fields=id,name,instagram_business_account', creds)
          page = (pages?.data || []).find((p) => p.instagram_business_account)
          if (!page) {
            throw new Error('No Instagram professional account is linked to any Facebook Page this token can manage. Link an Instagram professional account to a Facebook Page in Meta Business Suite, then retry.')
          }
        }

        const igAccount = page?.instagram_business_account
        if (!igAccount || !igAccount.id) {
          throw new Error(`No Instagram professional account is linked to Facebook Page ${page_id || page?.id || 'unknown'}. Link an Instagram professional account to the Page in Meta Business Suite, then retry.`)
        }

        const igDetails = await graphFetch(`/${encodeURIComponent(igAccount.id)}?fields=username`, creds)
        return {
          ig_user_id: igAccount.id,
          username: igDetails?.username || null,
          linked_page: { id: page.id, name: page.name || null },
        }
      },
    },

    {
      name: 'get_account',
      description: 'Get Instagram professional account details (bio, followers, media count).',
      input_schema: {
        type: 'object',
        properties: {
          ig_user_id: { type: 'string', description: 'Instagram professional account ID (from discover_account)' },
        },
        required: ['ig_user_id'],
      },
      execute: async (input, creds) => {
        const { ig_user_id } = input
        const acct = await graphFetch(
          `/${encodeURIComponent(ig_user_id)}?fields=id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url`,
          creds
        )
        return {
          id: acct.id,
          username: acct.username || null,
          name: acct.name || null,
          biography: acct.biography || null,
          followers: acct.followers_count ?? null,
          follows: acct.follows_count ?? null,
          media_count: acct.media_count ?? null,
          profile_picture_url: acct.profile_picture_url || null,
        }
      },
    },

    {
      name: 'list_media',
      description: 'List recent media posted to an Instagram professional account.',
      input_schema: {
        type: 'object',
        properties: {
          ig_user_id: { type: 'string', description: 'Instagram professional account ID' },
          limit: { type: 'number', description: 'Max media items to return (default 10, max 50)' },
        },
        required: ['ig_user_id'],
      },
      execute: async (input, creds) => {
        const { ig_user_id } = input
        const limit = Math.min(input?.limit || 10, 50)
        const result = await graphFetch(
          `/${encodeURIComponent(ig_user_id)}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&limit=${limit}`,
          creds
        )
        const items = result?.data || []
        return items.map((m) => ({
          id: m.id,
          caption: m.caption ?? null,
          media_type: m.media_type || null,
          media_url: m.media_url || null,
          permalink: m.permalink || null,
          timestamp: m.timestamp || null,
          likes: m.like_count ?? null,
          comments: m.comments_count ?? null,
        }))
      },
    },

    {
      name: 'get_media_insights',
      description: 'Get performance insights for a single media item (default metrics: reach, saved, likes, comments, shares, views). Metric names churn across Graph API versions; an invalid-metric error is surfaced from Meta verbatim, never masked.',
      input_schema: {
        type: 'object',
        properties: {
          media_id: { type: 'string', description: 'Instagram media ID' },
          metrics: { type: 'string', description: 'Comma-separated metric names (default: reach,saved,likes,comments,shares,views)' },
        },
        required: ['media_id'],
      },
      execute: async (input, creds) => {
        const { media_id } = input
        const metrics = input.metrics || 'reach,saved,likes,comments,shares,views'
        const result = await graphFetch(`/${encodeURIComponent(media_id)}/insights?metric=${encodeURIComponent(metrics)}`, creds)
        const series = result?.data || []
        return series.map((m) => ({
          name: m.name,
          period: m.period || null,
          title: m.title || null,
          description: m.description || null,
          values: (m.values || []).map((v) => ({ value: v.value, end_time: v.end_time || null })),
        }))
      },
    },

    {
      name: 'get_account_insights',
      description: 'Get account-level insights for an Instagram professional account (default metrics: reach, follower_count).',
      input_schema: {
        type: 'object',
        properties: {
          ig_user_id: { type: 'string', description: 'Instagram professional account ID' },
          metrics: { type: 'string', description: 'Comma-separated metric names (default: reach,follower_count)' },
          period: { type: 'string', enum: ['day', 'week', 'days_28', 'lifetime'], description: 'Aggregation period (default: day)' },
        },
        required: ['ig_user_id'],
      },
      execute: async (input, creds) => {
        const { ig_user_id } = input
        const metrics = input.metrics || 'reach,follower_count'
        const period = input.period || 'day'
        const result = await graphFetch(
          `/${encodeURIComponent(ig_user_id)}/insights?metric=${encodeURIComponent(metrics)}&period=${period}`,
          creds
        )
        const series = result?.data || []
        return series.map((m) => ({
          name: m.name,
          period: m.period || null,
          title: m.title || null,
          description: m.description || null,
          values: (m.values || []).map((v) => ({ value: v.value, end_time: v.end_time || null })),
        }))
      },
    },

    {
      name: 'get_comments',
      description: 'List comments on an Instagram media item.',
      input_schema: {
        type: 'object',
        properties: {
          media_id: { type: 'string', description: 'Instagram media ID' },
          limit: { type: 'number', description: 'Max comments to return (default 25, max 100)' },
        },
        required: ['media_id'],
      },
      execute: async (input, creds) => {
        const { media_id } = input
        const limit = Math.min(input?.limit || 25, 100)
        const result = await graphFetch(
          `/${encodeURIComponent(media_id)}/comments?fields=id,text,username,timestamp,like_count,replies&limit=${limit}`,
          creds
        )
        const comments = result?.data || []
        return comments.map((c) => ({
          id: c.id,
          text: c.text ?? null,
          username: c.username || null,
          timestamp: c.timestamp || null,
          likes: c.like_count ?? null,
          replies: c.replies?.data?.length ?? null,
        }))
      },
    },

    {
      name: 'get_publishing_limit',
      description: 'Get the rolling 24-hour publishing quota usage for an Instagram professional account (hard cap: 100 API-published posts per 24h; a carousel counts as 1).',
      input_schema: {
        type: 'object',
        properties: {
          ig_user_id: { type: 'string', description: 'Instagram professional account ID' },
        },
        required: ['ig_user_id'],
      },
      execute: async (input, creds) => {
        const { ig_user_id } = input
        const result = await graphFetch(`/${encodeURIComponent(ig_user_id)}/content_publishing_limit?fields=quota_usage,config`, creds)
        const entry = (result?.data || [])[0] || {}
        return {
          quota_usage: entry.quota_usage ?? null,
          quota_total: entry.config?.quota_total ?? null,
          quota_duration: entry.config?.quota_duration ?? null,
        }
      },
    },

    {
      name: 'publish_media',
      description: 'Publish a single image, video, or reel to an Instagram professional account. Files a human approval request; the post goes out only after an approver says yes. Carousel posts are not supported.',
      requiresApproval: true,
      approvalCard: (input) => {
        const mediaUrl = input.image_url || input.video_url || null
        const mediaType = input.media_type || (input.image_url ? 'IMAGE' : (input.video_url ? 'VIDEO' : 'unknown'))
        return {
          title: 'Instagram post awaiting approval',
          bodyMd: `**Publish to Instagram** account \`${input.ig_user_id || 'unknown account'}\` (${mediaType})\n\n> ${String(input.caption || '').slice(0, 1000).replace(/\n/g, '\n> ')}`
            + (mediaUrl ? `\n\nMedia: ${mediaUrl}` : ''),
          payloadExtra: {
            source: 'instagram-plugin',
            card: {
              kind: 'publish_media',
              ig_user_id: input.ig_user_id,
              caption: input.caption || null,
              media_type: mediaType,
              image_url: input.image_url || null,
              video_url: input.video_url || null,
            },
          },
        }
      },
      input_schema: {
        type: 'object',
        properties: {
          ig_user_id: { type: 'string', description: 'Instagram professional account ID to publish to' },
          caption: { type: 'string', description: 'Post caption (optional)' },
          image_url: { type: 'string', description: 'https URL of an image to publish (exactly one of image_url/video_url is required). Graph fetches the media server-side.' },
          video_url: { type: 'string', description: 'https URL of a video/reel to publish (exactly one of image_url/video_url is required). Graph fetches the media server-side.' },
          media_type: { type: 'string', enum: ['IMAGE', 'VIDEO', 'REELS'], description: 'Media type (default: IMAGE for image_url, VIDEO for video_url)' },
        },
        required: ['ig_user_id'],
      },
      execute: async (input, creds) => {
        const { ig_user_id, caption, image_url, video_url } = input

        if (!ig_user_id) {
          throw new Error('publish_media requires ig_user_id')
        }
        if (!image_url && !video_url) {
          throw new Error('publish_media requires exactly one of image_url or video_url')
        }
        if (image_url && video_url) {
          throw new Error('publish_media accepts exactly one of image_url or video_url, not both')
        }
        const mediaUrl = image_url || video_url
        if (!/^https:\/\//i.test(mediaUrl)) {
          throw new Error(`${image_url ? 'image_url' : 'video_url'} must be an https URL`)
        }

        let media_type = input.media_type
        if (!media_type) media_type = image_url ? 'IMAGE' : 'VIDEO'
        if (!['IMAGE', 'VIDEO', 'REELS'].includes(media_type)) {
          throw new Error(`media_type must be one of IMAGE, VIDEO, REELS (got ${media_type})`)
        }

        const body = { media_type }
        if (caption) body.caption = caption
        if (image_url) body.image_url = image_url
        if (video_url) body.video_url = video_url

        const created = await graphFetch(`/${encodeURIComponent(ig_user_id)}/media`, creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        const creationId = created?.id
        if (!creationId) {
          throw new Error('Instagram did not return a container id for the media create call')
        }

        await waitForContainerFinished(creationId, creds)

        const published = await graphFetch(`/${encodeURIComponent(ig_user_id)}/media_publish`, creds, {
          method: 'POST',
          body: JSON.stringify({ creation_id: creationId }),
        })
        const mediaId = published?.id || null

        // Best-effort only — the publish already succeeded; a permalink lookup
        // failure never unwinds a real publish.
        let permalink = null
        if (mediaId) {
          try {
            const info = await graphFetch(`/${encodeURIComponent(mediaId)}?fields=permalink`, creds)
            permalink = info?.permalink || null
          } catch (_) { /* non-fatal */ }
        }

        return { success: true, media_id: mediaId, permalink }
      },
    },

    {
      name: 'reply_comment',
      description: 'Reply to a comment on an Instagram media item. Files a human approval request; the reply goes out only after an approver says yes.',
      requiresApproval: true,
      approvalCard: (input) => ({
        title: 'Instagram comment reply awaiting approval',
        bodyMd: `**Reply to Instagram comment** \`${input.comment_id || 'unknown comment'}\`\n\n> ${String(input.message || '').slice(0, 1000).replace(/\n/g, '\n> ')}`,
        payloadExtra: {
          source: 'instagram-plugin',
          card: {
            kind: 'reply_comment',
            comment_id: input.comment_id,
            message: input.message,
          },
        },
      }),
      input_schema: {
        type: 'object',
        properties: {
          comment_id: { type: 'string', description: 'Instagram comment ID to reply to' },
          message: { type: 'string', description: 'Reply text' },
        },
        required: ['comment_id', 'message'],
      },
      execute: async (input, creds) => {
        const { comment_id, message } = input
        if (!comment_id) {
          throw new Error('reply_comment requires comment_id')
        }
        if (!message || !message.trim()) {
          throw new Error('reply_comment requires a non-empty message')
        }
        const result = await graphFetch(`/${encodeURIComponent(comment_id)}/replies`, creds, {
          method: 'POST',
          body: JSON.stringify({ message }),
        })
        return { success: true, reply_id: result?.id || 'created', comment_id }
      },
    },
  ]
}

module.exports = { getTools, __setContainerPollTimingForTesting, __resetContainerPollTimingForTesting }

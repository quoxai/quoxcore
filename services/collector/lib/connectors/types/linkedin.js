/**
 * LinkedIn Connector
 *
 * Tools for the LinkedIn REST API (Community Management + Organic Publishing).
 * Requires: access_token (OAuth 2.0 access token with appropriate scopes)
 *
 * API docs: https://learn.microsoft.com/en-us/linkedin/marketing/
 * Versioned API: https://learn.microsoft.com/en-us/linkedin/marketing/versioning
 */

const LINKEDIN_API = 'https://api.linkedin.com/rest'
// Versioned monthly, each version live ~1 year. 202401 was RETIRED 2025-01-22
// and every request pinning it fails; 202609 sunsets 2027-09-15. Contract
// re-verified against the li-lms-2026-09 docs (LI-OVERHAUL P2, 2026-09-16).
const LINKEDIN_VERSION = '202609'

async function linkedinFetchRaw(path, credentials, options = {}) {
  const url = path.startsWith('http') ? path : `${LINKEDIN_API}${path}`
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.access_token}`,
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    if (resp.status === 401) {
      throw new Error(`LinkedIn API 401: Access token expired or invalid. Re-authenticate via vault.`)
    }
    if (resp.status === 429) {
      throw new Error(`LinkedIn API 429: Rate limit exceeded. Try again later.`)
    }
    throw new Error(`LinkedIn API ${resp.status}: ${body.slice(0, 300)}`)
  }

  const text = await resp.text()
  return { body: text ? JSON.parse(text) : null, headers: resp.headers }
}

async function linkedinFetch(path, credentials, options = {}) {
  const { body } = await linkedinFetchRaw(path, credentials, options)
  return body
}

// LI-OVERHAUL P9/P10 — server-side completion of an image upload from a URL.
// The initializeUpload response's uploadUrl expects the caller to PUT the
// bytes; a browser cannot (CORS) and an agent has no hands, so the connector
// fetches the source image itself.
//
// SSRF guard (P10-hardened after codex refuted the first version):
// 1. https only; literal private/LAN hostnames refused (egressProxy CIDRs
//    plus the IPv6 loopback/link-local/ULA/IPv4-mapped shapes it misses);
// 2. the CONNECTION is pinned: an undici Agent validates every address at
//    connect time via its own lookup, so DNS rebinding between a pre-check
//    and the fetch cannot swap in an internal target;
// 3. redirects refused outright;
// 4. size capped by Content-Length precheck AND a streamed read that aborts
//    past the cap — never buffer-then-check.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function isPrivateOrLocalAddress(hostOrIp) {
  const { isPrivateAddress } = require('../../egressProxy.js')
  if (isPrivateAddress(hostOrIp)) return true
  const h = String(hostOrIp || '').toLowerCase().replace(/^\[|\]$/g, '')
  // IPv6 shapes egressProxy's IPv4-centric list misses: loopback, link-local,
  // unique-local, unspecified, and IPv4-mapped (re-check the embedded v4).
  if (h === '::1' || h === '::') return true
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true
  const v4mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (v4mapped && isPrivateAddress(v4mapped[1])) return true
  return false
}

async function fetchImageForUpload(imageUrl) {
  let parsed
  try {
    parsed = new URL(imageUrl)
  } catch {
    throw new Error(`image_url is not a valid URL: ${imageUrl}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('image_url must be https')
  }
  if (isPrivateOrLocalAddress(parsed.hostname)) {
    throw new Error('image_url points at a private/internal address; refused')
  }

  // Connect-time pinning: undici calls THIS lookup for the actual socket,
  // so the address the request reaches is the address that was validated.
  const { Agent } = require('undici')
  const dns = require('node:dns')
  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err)
          const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family }]
          const bad = list.find((a) => isPrivateOrLocalAddress(a.address))
          if (bad) return callback(new Error(`image_url resolves to a private/internal address (${bad.address}); refused`))
          if (options.all) return callback(null, list)
          return callback(null, list[0].address, list[0].family)
        })
      },
    },
  })

  try {
    const resp = await fetch(parsed.href, { signal: AbortSignal.timeout(20000), redirect: 'error', dispatcher })
    if (!resp.ok) {
      throw new Error(`image_url fetch failed: HTTP ${resp.status}`)
    }
    const contentType = resp.headers.get('content-type') || 'application/octet-stream'
    if (!/^image\//i.test(contentType)) {
      throw new Error(`image_url did not return an image (content-type ${contentType})`)
    }
    const declared = parseInt(resp.headers.get('content-length') || '', 10)
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(`image is ${(declared / 1048576).toFixed(1)}MB, over the 10MB limit`)
    }
    // Streamed read with a hard cap — a lying/absent Content-Length cannot
    // balloon collector memory before the check.
    const chunks = []
    let total = 0
    const reader = resp.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error(`image exceeds the 10MB limit (aborted at ${(total / 1048576).toFixed(1)}MB)`)
      }
      chunks.push(value)
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    return { buf, contentType }
  } finally {
    // After the body is fully read (or on error): release sockets. destroy()
    // here, not close() mid-stream, which would abort an in-flight read.
    dispatcher.destroy().catch(() => {})
  }
}

function getTools(credentials) {
  return [
    {
      name: 'publish_post',
      description: 'Publish a post to LinkedIn as a member or organisation page. Files a human approval request; the post goes out only after an approver says yes.',
      // LI-OVERHAUL P4: enforced at the bridge choke (executeConnectorTool),
      // not just declared. Before this, HITL for LinkedIn writes existed in
      // three config files and nowhere in the execution path.
      requiresApproval: true,
      // P9: the connector owns its approval card copy — title, body and the
      // typed payload the dashboard inbox renders as a LinkedIn post preview.
      approvalCard: (input) => ({
        title: 'LinkedIn post awaiting approval',
        bodyMd: `**Publish to LinkedIn** as \`${input.author || 'unknown author'}\` (${input.visibility || 'PUBLIC'})\n\n> ${String(input.text || '').slice(0, 1000).replace(/\n/g, '\n> ')}`
          + (input.link_url ? `\n\nLink: ${input.link_url}` : '')
          + (input.media_id ? `\n\nAttached media: \`${input.media_id}\`` : ''),
        payloadExtra: {
          source: 'linkedin-plugin',
          card: {
            kind: 'publish_post',
            author: input.author,
            text: input.text,
            visibility: input.visibility || 'PUBLIC',
            link_url: input.link_url || null,
            media_id: input.media_id || null,
          },
        },
      }),
      input_schema: {
        type: 'object',
        properties: {
          author: { type: 'string', description: 'Author URN (e.g. "urn:li:person:abc123" or "urn:li:organization:12345")' },
          text: { type: 'string', description: 'Post text content (max 3000 characters)' },
          visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS'], description: 'Post visibility (default: PUBLIC)' },
          media_id: { type: 'string', description: 'Media asset URN from upload_media (optional)' },
          link_url: { type: 'string', description: 'URL to attach as article/link (optional)' },
        },
        required: ['author', 'text'],
      },
      execute: async (input, creds) => {
        const { author, text, visibility = 'PUBLIC', media_id, link_url } = input

        if (text.length > 3000) {
          throw new Error(`Post text exceeds 3000 character limit (${text.length} chars)`)
        }

        const body = {
          author,
          commentary: text,
          visibility,
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: 'PUBLISHED',
        }

        if (media_id) {
          // P10 (codex): an image referenced before it reaches AVAILABLE
          // publishes 201 but renders WITHOUT the image, silently. By
          // publish time (post-approval) it is almost always ready; check
          // once, wait briefly if not, and FAIL HONESTLY rather than ship a
          // broken post. A status read we are not scoped for (write-only
          // tokens cannot GET /rest/images) is "cannot verify", not "failed"
          // — proceed with a log line in that case.
          for (let attempt = 0; attempt < 4; attempt++) {
            let status
            try {
              status = (await linkedinFetch(`/images/${encodeURIComponent(media_id)}`, creds))?.status
            } catch (err) {
              console.warn(`[LinkedIn] Cannot verify image status for ${media_id} (${err.message}); publishing anyway`)
              break
            }
            if (status === 'AVAILABLE') break
            if (status === 'PROCESSING_FAILED' || status === 'FAILED') {
              throw new Error(`Attached image ${media_id} failed LinkedIn processing (status ${status}); not publishing a post that would render without it`)
            }
            if (attempt === 3) {
              throw new Error(`Attached image ${media_id} is still ${status || 'PROCESSING'} after waiting; not publishing a post that would render without it. Retry shortly.`)
            }
            await new Promise((r) => setTimeout(r, 2000))
          }
          body.content = {
            media: {
              title: 'Shared media',
              id: media_id,
            },
          }
        } else if (link_url) {
          body.content = {
            article: {
              source: link_url,
              title: text.slice(0, 200),
            },
          }
        }

        // LinkedIn answers 201 with an EMPTY body; the new post's URN comes
        // back in the x-restli-id RESPONSE HEADER. The old code read it from
        // the parsed body, so every live publish reported post_urn 'created'.
        const { body: result, headers } = await linkedinFetchRaw('/posts', creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return {
          success: true,
          post_urn: headers.get('x-restli-id') || result?.id || 'created',
          author,
          visibility,
          text_length: text.length,
        }
      },
    },

    {
      name: 'upload_media',
      description: 'Upload an image to LinkedIn for attaching to posts. Give image_url (https) and the upload completes server-side, returning a ready image URN; without it, returns the raw upload URL for a manual PUT.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Owner URN (person or organisation)' },
          image_url: { type: 'string', description: 'https URL of the image to upload (max 10MB). When given, the upload is completed server-side and image_urn is ready to use as media_id.' },
        },
        required: ['owner'],
      },
      execute: async (input, creds) => {
        const { owner, image_url } = input

        const initResp = await linkedinFetch('/images?action=initializeUpload', creds, {
          method: 'POST',
          body: JSON.stringify({
            initializeUploadRequest: {
              owner,
            },
          }),
        })

        const uploadUrl = initResp?.value?.uploadUrl
        const imageUrn = initResp?.value?.image

        if (!uploadUrl || !imageUrn) {
          throw new Error('LinkedIn did not return upload URL or image URN')
        }

        if (!image_url) {
          return {
            upload_url: uploadUrl,
            image_urn: imageUrn,
            uploaded: false,
            instructions: 'PUT your image binary to upload_url with Content-Type header matching the image type. Then use image_urn as media_id in publish_post.',
          }
        }

        // P9: complete the upload here — the uploadUrl PUT needs no
        // LinkedIn-Version headers, only the token (per the Images API docs).
        const { buf, contentType } = await fetchImageForUpload(image_url)
        const putResp = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${creds.access_token}`,
            'Content-Type': contentType,
          },
          body: buf,
          signal: AbortSignal.timeout(30000),
        })
        if (!putResp.ok) {
          const body = await putResp.text().catch(() => '')
          throw new Error(`LinkedIn image upload PUT failed: HTTP ${putResp.status} ${body.slice(0, 200)}`)
        }

        // The Images API is async-only: a post referencing an image that has
        // not reached AVAILABLE publishes 201 but renders WITHOUT the image
        // (silently). Poll briefly; if still processing, say so honestly —
        // in the HITL flow the human approval happens later, so by publish
        // time it is almost always AVAILABLE.
        let imageStatus = 'PROCESSING'
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise((r) => setTimeout(r, 2000))
          try {
            const statusResp = await linkedinFetch(`/images/${encodeURIComponent(imageUrn)}`, creds)
            imageStatus = statusResp?.status || 'PROCESSING'
          } catch (_) { /* transient status read failure: keep polling */ }
          if (imageStatus === 'AVAILABLE') break
          if (imageStatus === 'PROCESSING_FAILED' || imageStatus === 'FAILED') {
            throw new Error(`LinkedIn reported the image failed processing (status ${imageStatus})`)
          }
        }

        return {
          image_urn: imageUrn,
          uploaded: true,
          status: imageStatus,
          bytes: buf.length,
          content_type: contentType,
          instructions: imageStatus === 'AVAILABLE'
            ? 'Upload complete and processed. Use image_urn as media_id in publish_post.'
            : 'Upload complete but LinkedIn is still processing the image. Publishing immediately may render the post without it; the HITL approval delay usually covers this.',
        }
      },
    },

    {
      name: 'get_posts',
      description: 'List recent posts for a member or organisation',
      input_schema: {
        type: 'object',
        properties: {
          author: { type: 'string', description: 'Author URN (person or organisation)' },
          count: { type: 'number', description: 'Number of posts to return (max 50, default 20)' },
        },
        required: ['author'],
      },
      execute: async (input, creds) => {
        const { author, count = 20 } = input
        const limit = Math.min(count, 50)
        // q=author is REQUIRED finder syntax; without it this is not a finder
        // call at all (the original version omitted it and never worked).
        const result = await linkedinFetch(
          `/posts?q=author&author=${encodeURIComponent(author)}&count=${limit}&sortBy=LAST_MODIFIED`,
          creds,
          { headers: { 'X-RestLi-Method': 'FINDER' } }
        )

        const posts = result?.elements || []
        return posts.map(p => ({
          id: p.id,
          text: p.commentary?.slice(0, 500),
          visibility: p.visibility,
          lifecycle_state: p.lifecycleState,
          created_at: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          last_modified: p.lastModifiedAt ? new Date(p.lastModifiedAt).toISOString() : null,
          has_media: !!p.content?.media,
          has_article: !!p.content?.article,
        }))
      },
    },

    {
      name: 'get_post',
      description: 'Get a single post by URN with full details',
      input_schema: {
        type: 'object',
        properties: {
          post_urn: { type: 'string', description: 'Post URN (e.g. "urn:li:share:12345" or post ID)' },
        },
        required: ['post_urn'],
      },
      execute: async (input, creds) => {
        const { post_urn } = input
        const encoded = encodeURIComponent(post_urn)
        const post = await linkedinFetch(`/posts/${encoded}`, creds)

        return {
          id: post.id,
          author: post.author,
          text: post.commentary,
          visibility: post.visibility,
          lifecycle_state: post.lifecycleState,
          created_at: post.createdAt ? new Date(post.createdAt).toISOString() : null,
          last_modified: post.lastModifiedAt ? new Date(post.lastModifiedAt).toISOString() : null,
          content: post.content || null,
          distribution: post.distribution || null,
        }
      },
    },

    {
      name: 'get_engagement',
      description: 'Get engagement metrics (likes, comments, shares) for a post',
      input_schema: {
        type: 'object',
        properties: {
          post_urn: { type: 'string', description: 'Post URN' },
        },
        required: ['post_urn'],
      },
      execute: async (input, creds) => {
        const { post_urn } = input
        const encoded = encodeURIComponent(post_urn)

        // Fetch reactions and comments counts
        const [likesResp, commentsResp] = await Promise.allSettled([
          linkedinFetch(`/socialActions/${encoded}/likes?count=0`, creds),
          linkedinFetch(`/socialActions/${encoded}/comments?count=0`, creds),
        ])

        // P10 honesty fix (codex): both sub-reads failing means we KNOW
        // nothing — throw rather than assert zero engagement. A single
        // failure degrades to null for that metric, never a fake 0.
        if (likesResp.status === 'rejected' && commentsResp.status === 'rejected') {
          throw likesResp.reason
        }
        const likes = likesResp.status === 'fulfilled' ? (likesResp.value?.paging?.total ?? 0) : null
        const comments = commentsResp.status === 'fulfilled' ? (commentsResp.value?.paging?.total ?? 0) : null

        return {
          post_urn,
          reactions: likes,
          comments,
          total_engagement: (likes ?? 0) + (comments ?? 0),
        }
      },
    },

    {
      name: 'get_comments',
      description: 'Get comments on a LinkedIn post',
      input_schema: {
        type: 'object',
        properties: {
          post_urn: { type: 'string', description: 'Post URN' },
          count: { type: 'number', description: 'Max comments to return (default 20, max 50)' },
        },
        required: ['post_urn'],
      },
      execute: async (input, creds) => {
        const { post_urn, count = 20 } = input
        const limit = Math.min(count, 50)
        const encoded = encodeURIComponent(post_urn)
        const result = await linkedinFetch(
          `/socialActions/${encoded}/comments?start=0&count=${limit}`,
          creds
        )

        const comments = result?.elements || []
        return comments.map(c => ({
          id: c['$URN'] || c.id,
          actor: c.actor,
          message: c.message?.text || '',
          created_at: c.created?.time ? new Date(c.created.time).toISOString() : null,
          likes: c.likesSummary?.totalLikes || 0,
        }))
      },
    },

    {
      name: 'create_comment',
      description: 'Post a comment on a LinkedIn post. Files a human approval request; the comment goes out only after an approver says yes.',
      requiresApproval: true,
      approvalCard: (input) => ({
        title: 'LinkedIn comment awaiting approval',
        bodyMd: `**Comment on** \`${input.post_urn || 'unknown post'}\` as \`${input.actor || 'unknown actor'}\`\n\n> ${String(input.text || '').slice(0, 1000).replace(/\n/g, '\n> ')}`,
        payloadExtra: {
          source: 'linkedin-plugin',
          card: {
            kind: 'create_comment',
            post_urn: input.post_urn,
            actor: input.actor,
            text: input.text,
          },
        },
      }),
      input_schema: {
        type: 'object',
        properties: {
          post_urn: { type: 'string', description: 'Post URN to comment on' },
          actor: { type: 'string', description: 'Actor URN (person or organisation posting the comment)' },
          text: { type: 'string', description: 'Comment text' },
        },
        required: ['post_urn', 'actor', 'text'],
      },
      execute: async (input, creds) => {
        const { post_urn, actor, text } = input
        const encoded = encodeURIComponent(post_urn)

        const { body: result, headers } = await linkedinFetchRaw(`/socialActions/${encoded}/comments`, creds, {
          method: 'POST',
          body: JSON.stringify({
            actor,
            // The docs' samples all carry `object` (the share/ugcPost the
            // comment targets) even though the required-fields table lists
            // only actor+message; include it to match the documented shape.
            object: post_urn,
            message: { text },
          }),
        })

        return {
          success: true,
          comment_id: result?.['$URN'] || result?.commentUrn || result?.id || headers.get('x-restli-id') || 'created',
          post_urn,
          actor,
          text_length: text.length,
        }
      },
    },

    {
      name: 'get_org_info',
      description: 'Get LinkedIn organisation page details and follower count',
      input_schema: {
        type: 'object',
        properties: {
          org_id: { type: 'string', description: 'Organisation ID (numeric, e.g. "12345")' },
        },
        required: ['org_id'],
      },
      execute: async (input, creds) => {
        const { org_id } = input

        // Total followers come from networkSizes; the follower-statistics
        // endpoint stopped returning a top-level total (it is facet-segmented
        // only on current API versions).
        const [orgResp, followersResp] = await Promise.allSettled([
          linkedinFetch(`/organizations/${org_id}`, creds),
          linkedinFetch(
            `/networkSizes/${encodeURIComponent(`urn:li:organization:${org_id}`)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
            creds
          ),
        ])

        // P10 honesty fix (codex): when the org lookup itself failed, THROW —
        // the old shape returned a nulls-filled object, so a revoked token
        // read as "connected" in the health panel. The follower count alone
        // failing degrades to null (never a fake 0).
        if (orgResp.status === 'rejected') {
          throw orgResp.reason
        }
        const org = orgResp.value
        const networkSize = followersResp.status === 'fulfilled' ? followersResp.value : null

        const totalFollowers = networkSize?.firstDegreeSize ?? null

        return {
          id: org_id,
          name: org?.localizedName || org?.name || null,
          vanity_name: org?.vanityName || null,
          description: org?.localizedDescription?.slice(0, 500) || null,
          website: org?.localizedWebsite || null,
          industry: org?.localizedSpecialties || null,
          staff_count_range: org?.staffCountRange || null,
          followers: totalFollowers,
          logo_url: org?.logoV2?.original || null,
        }
      },
    },
  ]
}

module.exports = { getTools }

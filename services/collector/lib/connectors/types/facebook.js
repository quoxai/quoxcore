/**
 * Facebook Pages Connector (organic only)
 *
 * Tools for the Meta Graph API — Facebook Pages: listing, reading, insights,
 * lead retrieval, and governed publishing. Requires: access_token (a
 * long-lived User or Page access token with the appropriate scopes:
 * pages_show_list, pages_read_engagement, read_insights, leads_retrieval,
 * pages_manage_posts).
 *
 * Boundary: organic Pages only. Ad account insights (get_ad_insights) are
 * EXCLUDED — that surface belongs to a future META-ADS plugin.
 *
 * SECURITY: a Page access token is resolved server-side (resolvePageCredentials)
 * from the vaulted token; it is never accepted from tool input and never
 * emitted in any tool output or thrown error message.
 *
 * API docs: https://developers.facebook.com/docs/graph-api/
 */

const { graphFetch } = require('../metaGraph.js')

/**
 * Resolve a Page-scoped access token for page-scoped calls (posts read,
 * publish). Tries GET /{page_id}?fields=access_token with the vaulted token;
 * on success, returns creds carrying the page token. On any failure, falls
 * back to the vaulted token as-is (it may itself already BE a page token).
 * Never surfaces a page token in a thrown error or return value.
 */
async function resolvePageCredentials(creds, page_id) {
  try {
    const result = await graphFetch(
      `/${encodeURIComponent(page_id)}?fields=access_token`,
      creds
    )
    if (result && result.access_token) {
      return { ...creds, access_token: result.access_token }
    }
    return creds
  } catch (_) {
    return creds
  }
}

function getTools(credentials) {
  return [
    {
      name: 'get_pages',
      description: 'List the Facebook Pages this token can manage, with category and follower count. Never returns a page access token.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max pages to return (default 25, max 100)' },
        },
      },
      execute: async (input, creds) => {
        const limit = Math.min(input?.limit || 25, 100)
        const result = await graphFetch(
          `/me/accounts?fields=id,name,category,tasks,fan_count&limit=${limit}`,
          creds
        )
        const pages = result?.data || []
        return pages.map(p => ({
          id: p.id,
          name: p.name,
          category: p.category || null,
          followers: p.fan_count ?? null,
          tasks: p.tasks || [],
          has_page_token: !!p.access_token,
        }))
      },
    },

    {
      name: 'get_page_info',
      description: 'Get Facebook Page details (about, category, followers, verification status).',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Facebook Page ID' },
        },
        required: ['page_id'],
      },
      execute: async (input, creds) => {
        const { page_id } = input
        const page = await graphFetch(
          `/${encodeURIComponent(page_id)}?fields=id,name,about,category,fan_count,followers_count,link,verification_status`,
          creds
        )
        return {
          id: page.id,
          name: page.name || null,
          about: page.about || null,
          category: page.category || null,
          followers: page.followers_count ?? page.fan_count ?? null,
          link: page.link || null,
          verification_status: page.verification_status || null,
        }
      },
    },

    {
      name: 'get_page_posts',
      description: 'List recent posts on a Facebook Page with engagement counts.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Facebook Page ID' },
          limit: { type: 'number', description: 'Max posts to return (default 10, max 50)' },
        },
        required: ['page_id'],
      },
      execute: async (input, creds) => {
        const { page_id } = input
        const limit = Math.min(input?.limit || 10, 50)
        const pageCreds = await resolvePageCredentials(creds, page_id)
        const result = await graphFetch(
          `/${encodeURIComponent(page_id)}/posts?fields=id,message,created_time,permalink_url,shares,likes.summary(true),comments.summary(true)&limit=${limit}`,
          pageCreds
        )
        const posts = result?.data || []
        return posts.map(p => ({
          id: p.id,
          message: p.message ?? null,
          created_time: p.created_time || null,
          permalink_url: p.permalink_url || null,
          shares: p.shares?.count ?? null,
          likes: p.likes?.summary?.total_count ?? null,
          comments: p.comments?.summary?.total_count ?? null,
        }))
      },
    },

    {
      name: 'get_page_insights',
      description: 'Get organic Page Insights (impressions, engagement, fans) for a Facebook Page.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Facebook Page ID' },
          metrics: {
            type: 'string',
            description: 'Comma-separated metric names (default: page_impressions,page_post_engagements,page_fans)',
          },
          period: {
            type: 'string',
            enum: ['day', 'week', 'days_28', 'month', 'lifetime'],
            description: 'Aggregation period (default: day)',
          },
        },
        required: ['page_id'],
      },
      execute: async (input, creds) => {
        const { page_id } = input
        const metrics = input.metrics || 'page_impressions,page_post_engagements,page_fans'
        const period = input.period || 'day'
        const result = await graphFetch(
          `/${encodeURIComponent(page_id)}/insights?metric=${encodeURIComponent(metrics)}&period=${period}`,
          creds
        )
        const series = result?.data || []
        return series.map(m => ({
          name: m.name,
          period: m.period,
          title: m.title || null,
          description: m.description || null,
          values: (m.values || []).map(v => ({
            value: v.value,
            end_time: v.end_time || null,
          })),
        }))
      },
    },

    {
      name: 'get_lead_forms',
      description: 'List the Lead Ads forms attached to a Facebook Page.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Facebook Page ID that owns the lead forms' },
          limit: { type: 'number', description: 'Max forms to return (default 25, max 100)' },
        },
        required: ['page_id'],
      },
      execute: async (input, creds) => {
        const { page_id } = input
        const limit = Math.min(input?.limit || 25, 100)
        const result = await graphFetch(
          `/${encodeURIComponent(page_id)}/leadgen_forms?fields=id,name,status,leads_count,created_time&limit=${limit}`,
          creds
        )
        const forms = result?.data || []
        return forms.map(f => ({
          id: f.id,
          name: f.name,
          status: f.status || null,
          leads_count: f.leads_count ?? null,
          created_time: f.created_time || null,
        }))
      },
    },

    {
      name: 'get_leads',
      description: 'Retrieve submitted leads for a Lead Ads form.',
      input_schema: {
        type: 'object',
        properties: {
          form_id: { type: 'string', description: 'Lead form ID (from get_lead_forms)' },
          limit: { type: 'number', description: 'Max leads to return (default 25, max 100)' },
        },
        required: ['form_id'],
      },
      execute: async (input, creds) => {
        const { form_id } = input
        const limit = Math.min(input?.limit || 25, 100)
        const result = await graphFetch(
          `/${encodeURIComponent(form_id)}/leads?fields=id,created_time,field_data&limit=${limit}`,
          creds
        )
        const leads = result?.data || []
        return leads.map(l => ({
          id: l.id,
          created_time: l.created_time || null,
          fields: (l.field_data || []).reduce((acc, fd) => {
            acc[fd.name] = Array.isArray(fd.values) ? fd.values.join(', ') : fd.values
            return acc
          }, {}),
        }))
      },
    },

    {
      name: 'publish_page_post',
      description: 'Publish a post to a Facebook Page feed (text, optional link, optional image). Files a human approval request; the post goes out only after an approver says yes.',
      requiresApproval: true,
      approvalCard: (input) => ({
        title: 'Facebook Page post awaiting approval',
        bodyMd: `**Publish to Facebook Page** \`${input.page_id || 'unknown page'}\`\n\n> ${String(input.message || '').slice(0, 1000).replace(/\n/g, '\n> ')}`
          + (input.link ? `\n\nLink: ${input.link}` : '')
          + (input.image_url ? `\n\nImage: ${input.image_url}` : ''),
        payloadExtra: {
          source: 'facebook-plugin',
          card: {
            kind: 'post',
            page_id: input.page_id,
            message: input.message,
            link: input.link || null,
            image_url: input.image_url || null,
          },
        },
      }),
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Facebook Page ID to post to' },
          message: { type: 'string', description: 'Post text content' },
          link: { type: 'string', description: 'URL to attach as a link (optional)' },
          image_url: { type: 'string', description: 'https URL of an image to attach (optional). Graph fetches the image server-side.' },
        },
        required: ['page_id', 'message'],
      },
      execute: async (input, creds) => {
        const { page_id, message, link, image_url } = input

        if (!message || !message.trim()) {
          throw new Error('publish_page_post requires a non-empty message')
        }
        if (image_url && !/^https:\/\//i.test(image_url)) {
          throw new Error('image_url must be an https URL')
        }

        // A Page post/photo must be authored with a Page access token.
        const pageCreds = await resolvePageCredentials(creds, page_id)

        let result
        if (image_url) {
          result = await graphFetch(
            `/${encodeURIComponent(page_id)}/photos`,
            pageCreds,
            {
              method: 'POST',
              body: JSON.stringify({ url: image_url, caption: message }),
            }
          )
        } else {
          const body = { message }
          if (link) body.link = link
          result = await graphFetch(
            `/${encodeURIComponent(page_id)}/feed`,
            pageCreds,
            {
              method: 'POST',
              body: JSON.stringify(body),
            }
          )
        }

        return {
          success: true,
          post_id: result?.post_id || result?.id || 'created',
          page_id,
          permalink: result?.permalink_url || null,
        }
      },
    },
  ]
}

module.exports = { getTools, resolvePageCredentials }

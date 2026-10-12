/**
 * GitLab Connector — VAULT-INTEG P10
 *
 * Tools for the GitLab REST API v4: issues and merge requests.
 * Requires: private_token (glpat-...). base_url is optional and defaults
 * to https://gitlab.com for gitlab.com-hosted orgs; self-hosted GitLab
 * instances set base_url to their own domain (bridge.js passes it through
 * when the vault credential has it set).
 */

const DEFAULT_BASE_URL = 'https://gitlab.com'
const REQUEST_TIMEOUT_MS = 15_000

async function gitlabFetch(baseUrl, path, credentials, options = {}) {
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/api/v4${path}`

  const resp = await fetch(url, {
    ...options,
    headers: {
      'PRIVATE-TOKEN': credentials.private_token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`GitLab API ${resp.status}: ${body.slice(0, 200)}`)
  }

  if (resp.status === 204) return {}
  return resp.json()
}

function shapeIssue(i) {
  return {
    iid: i.iid,
    id: i.id,
    title: i.title,
    state: i.state,
    labels: i.labels || [],
    author: i.author?.username,
    assignee: i.assignee?.username || null,
    created_at: i.created_at,
    updated_at: i.updated_at,
    web_url: i.web_url,
  }
}

function shapeMr(mr) {
  return {
    iid: mr.iid,
    id: mr.id,
    title: mr.title,
    state: mr.state,
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    author: mr.author?.username,
    merge_status: mr.merge_status,
    draft: mr.draft || mr.work_in_progress || false,
    created_at: mr.created_at,
    updated_at: mr.updated_at,
    web_url: mr.web_url,
  }
}

function getTools(credentials) {
  const baseUrl = credentials.base_url

  return [
    {
      name: 'list_issues',
      description: 'List issues in a GitLab project',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or URL-encoded path (e.g. "42" or "group/project")' },
          state: { type: 'string', description: 'opened, closed, or all (default opened)' },
          labels: { type: 'string', description: 'Comma-separated labels to filter by' },
          max_results: { type: 'number', description: 'Maximum results (default 20, max 100)' },
        },
        required: ['project_id'],
      },
      execute: async (input, creds) => {
        const { project_id, state = 'opened', labels, max_results = 20 } = input
        const params = new URLSearchParams({ per_page: String(Math.min(max_results, 100)) })
        if (state !== 'all') params.set('state', state)
        if (labels) params.set('labels', labels)
        const issues = await gitlabFetch(baseUrl, `/projects/${encodeURIComponent(project_id)}/issues?${params}`, creds)
        return (issues || []).map(shapeIssue)
      },
    },

    {
      name: 'get_issue',
      description: 'Get details of a specific GitLab issue',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or URL-encoded path' },
          issue_iid: { type: 'number', description: 'Issue IID (project-scoped number, not the global ID)' },
        },
        required: ['project_id', 'issue_iid'],
      },
      execute: async (input, creds) => {
        const { project_id, issue_iid } = input
        const issue = await gitlabFetch(baseUrl, `/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(issue_iid)}`, creds)
        return { ...shapeIssue(issue), description: issue.description || '' }
      },
    },

    {
      name: 'create_issue',
      description: 'Create a new issue in a GitLab project',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or URL-encoded path' },
          title: { type: 'string', description: 'Issue title' },
          description: { type: 'string', description: 'Issue description' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to apply' },
        },
        required: ['project_id', 'title'],
      },
      execute: async (input, creds) => {
        const { project_id, title, description = '', labels = [] } = input
        const body = { title, description }
        if (labels.length) body.labels = labels.join(',')
        const issue = await gitlabFetch(baseUrl, `/projects/${encodeURIComponent(project_id)}/issues`, creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        return { iid: issue.iid, id: issue.id, web_url: issue.web_url }
      },
    },

    {
      name: 'list_merge_requests',
      description: 'List merge requests in a GitLab project',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or URL-encoded path' },
          state: { type: 'string', description: 'opened, closed, merged, or all (default opened)' },
          max_results: { type: 'number', description: 'Maximum results (default 20, max 100)' },
        },
        required: ['project_id'],
      },
      execute: async (input, creds) => {
        const { project_id, state = 'opened', max_results = 20 } = input
        const params = new URLSearchParams({ per_page: String(Math.min(max_results, 100)) })
        if (state !== 'all') params.set('state', state)
        const mrs = await gitlabFetch(baseUrl, `/projects/${encodeURIComponent(project_id)}/merge_requests?${params}`, creds)
        return (mrs || []).map(shapeMr)
      },
    },

    {
      name: 'get_merge_request',
      description: 'Get details of a specific GitLab merge request',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project ID or URL-encoded path' },
          merge_request_iid: { type: 'number', description: 'Merge request IID (project-scoped number)' },
        },
        required: ['project_id', 'merge_request_iid'],
      },
      execute: async (input, creds) => {
        const { project_id, merge_request_iid } = input
        const mr = await gitlabFetch(baseUrl, `/projects/${encodeURIComponent(project_id)}/merge_requests/${encodeURIComponent(merge_request_iid)}`, creds)
        return { ...shapeMr(mr), description: mr.description || '' }
      },
    },
  ]
}

module.exports = { getTools }

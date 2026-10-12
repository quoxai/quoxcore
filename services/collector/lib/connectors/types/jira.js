/**
 * Jira Connector — Wave 1
 *
 * Tools for Jira Cloud REST API v3.
 * Requires: token (API token), endpoint_url (e.g., https://your-domain.atlassian.net),
 *           email (Atlassian account email for basic auth)
 */

async function jiraFetch(baseUrl, path, credentials, options = {}) {
  const url = `${baseUrl.replace(/\/$/, '')}/rest/api/3${path}`
  const auth = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')

  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Jira API ${resp.status}: ${body.slice(0, 200)}`)
  }

  return resp.json()
}

function getTools(credentials) {
  const baseUrl = credentials.endpoint_url

  return [
    {
      name: 'search_issues',
      description: 'Search Jira issues using JQL',
      input_schema: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JQL query (e.g., "project = PROJ AND status = Open")' },
          max_results: { type: 'number', description: 'Maximum results (default 20, max 50)' },
          fields: { type: 'string', description: 'Comma-separated fields to return' },
        },
        required: ['jql'],
      },
      execute: async (input, creds) => {
        const { jql, max_results = 20, fields = 'summary,status,assignee,priority,created,updated' } = input
        const params = new URLSearchParams({
          jql,
          maxResults: Math.min(max_results, 50),
          fields,
        })
        const result = await jiraFetch(baseUrl, `/search?${params}`, creds)
        return {
          total: result.total,
          issues: result.issues?.map(i => ({
            key: i.key,
            summary: i.fields?.summary,
            status: i.fields?.status?.name,
            assignee: i.fields?.assignee?.displayName,
            priority: i.fields?.priority?.name,
            created: i.fields?.created,
            updated: i.fields?.updated,
          })),
        }
      },
    },

    {
      name: 'get_issue',
      description: 'Get details of a specific Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          issue_key: { type: 'string', description: 'Issue key (e.g., PROJ-123)' },
        },
        required: ['issue_key'],
      },
      execute: async (input, creds) => {
        const { issue_key } = input
        const issue = await jiraFetch(baseUrl, `/issue/${encodeURIComponent(issue_key)}`, creds)
        return {
          key: issue.key,
          summary: issue.fields?.summary,
          description: issue.fields?.description?.content?.[0]?.content?.[0]?.text?.slice(0, 2000) || '',
          status: issue.fields?.status?.name,
          assignee: issue.fields?.assignee?.displayName,
          reporter: issue.fields?.reporter?.displayName,
          priority: issue.fields?.priority?.name,
          type: issue.fields?.issuetype?.name,
          project: issue.fields?.project?.name,
          labels: issue.fields?.labels,
          created: issue.fields?.created,
          updated: issue.fields?.updated,
        }
      },
    },

    {
      name: 'create_issue',
      description: 'Create a new Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          project_key: { type: 'string', description: 'Project key (e.g., PROJ)' },
          summary: { type: 'string', description: 'Issue summary' },
          description: { type: 'string', description: 'Issue description' },
          issue_type: { type: 'string', description: 'Issue type (Task, Bug, Story, Epic)' },
          priority: { type: 'string', description: 'Priority (Highest, High, Medium, Low, Lowest)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels' },
        },
        required: ['project_key', 'summary'],
      },
      execute: async (input, creds) => {
        const { project_key, summary, description = '', issue_type = 'Task', priority, labels = [] } = input
        const fields = {
          project: { key: project_key },
          summary,
          issuetype: { name: issue_type },
          labels,
        }
        if (description) {
          fields.description = {
            type: 'doc', version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
          }
        }
        if (priority) fields.priority = { name: priority }

        const result = await jiraFetch(baseUrl, '/issue', creds, {
          method: 'POST',
          body: JSON.stringify({ fields }),
        })
        return { key: result.key, id: result.id, url: `${baseUrl}/browse/${result.key}` }
      },
    },

    {
      name: 'add_comment',
      description: 'Add a comment to a Jira issue',
      input_schema: {
        type: 'object',
        properties: {
          issue_key: { type: 'string', description: 'Issue key (e.g., PROJ-123)' },
          body: { type: 'string', description: 'Comment text' },
        },
        required: ['issue_key', 'body'],
      },
      execute: async (input, creds) => {
        const { issue_key, body } = input
        const result = await jiraFetch(baseUrl, `/issue/${encodeURIComponent(issue_key)}/comment`, creds, {
          method: 'POST',
          body: JSON.stringify({
            body: {
              type: 'doc', version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
            },
          }),
        })
        return { id: result.id, created: result.created }
      },
    },

    {
      name: 'list_projects',
      description: 'List all accessible Jira projects',
      input_schema: {
        type: 'object',
        properties: {
          max_results: { type: 'number', description: 'Maximum results (default 20)' },
        },
      },
      execute: async (input, creds) => {
        const { max_results = 20 } = input
        const result = await jiraFetch(baseUrl, `/project/search?maxResults=${Math.min(max_results, 50)}`, creds)
        return result.values?.map(p => ({
          key: p.key,
          name: p.name,
          style: p.style,
          lead: p.lead?.displayName,
        }))
      },
    },

    {
      name: 'transition_issue',
      description: 'Transition a Jira issue to a new status',
      input_schema: {
        type: 'object',
        properties: {
          issue_key: { type: 'string', description: 'Issue key (e.g., PROJ-123)' },
          transition_name: { type: 'string', description: 'Target status name (e.g., "Done", "In Progress")' },
        },
        required: ['issue_key', 'transition_name'],
      },
      execute: async (input, creds) => {
        const { issue_key, transition_name } = input
        // First get available transitions
        const transitions = await jiraFetch(baseUrl, `/issue/${encodeURIComponent(issue_key)}/transitions`, creds)
        const match = transitions.transitions?.find(t =>
          t.name.toLowerCase() === transition_name.toLowerCase()
        )
        if (!match) {
          const available = transitions.transitions?.map(t => t.name).join(', ')
          throw new Error(`Transition "${transition_name}" not found. Available: ${available}`)
        }
        await jiraFetch(baseUrl, `/issue/${encodeURIComponent(issue_key)}/transitions`, creds, {
          method: 'POST',
          body: JSON.stringify({ transition: { id: match.id } }),
        })
        return { issue_key, transitioned_to: match.name }
      },
    },
  ]
}

module.exports = { getTools }

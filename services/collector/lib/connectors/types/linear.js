/**
 * Linear Connector — Wave 1
 *
 * Tools for Linear GraphQL API.
 * Requires: token (Linear API key)
 */

const LINEAR_API = 'https://api.linear.app/graphql'

async function linearQuery(query, variables, credentials) {
  const resp = await fetch(LINEAR_API, {
    method: 'POST',
    headers: {
      'Authorization': credentials.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Linear API ${resp.status}: ${body.slice(0, 200)}`)
  }

  const data = await resp.json()
  if (data.errors?.length) {
    throw new Error(`Linear GraphQL: ${data.errors[0].message}`)
  }

  return data.data
}

function getTools(credentials) {
  return [
    {
      name: 'list_issues',
      description: 'List Linear issues with optional filters',
      input_schema: {
        type: 'object',
        properties: {
          team_key: { type: 'string', description: 'Team key to filter by (e.g., "ENG")' },
          state: { type: 'string', description: 'State name filter (e.g., "In Progress", "Done")' },
          assignee: { type: 'string', description: 'Assignee display name filter' },
          first: { type: 'number', description: 'Number of results (max 50)' },
        },
      },
      execute: async (input, creds) => {
        const { team_key, state, assignee, first = 20 } = input

        // Build filter object using GraphQL variables (not string interpolation)
        const filter = {}
        if (team_key) filter.team = { key: { eq: team_key } }
        if (state) filter.state = { name: { eq: state } }
        if (assignee) filter.assignee = { displayName: { containsIgnoreCase: assignee } }

        const hasFilter = Object.keys(filter).length > 0

        const data = await linearQuery(`
          query($first: Int!${hasFilter ? ', $filter: IssueFilter' : ''}) {
            issues(first: $first${hasFilter ? ', filter: $filter' : ''}, orderBy: updatedAt) {
              nodes {
                identifier
                title
                priority
                state { name }
                assignee { displayName }
                team { key name }
                createdAt
                updatedAt
                url
              }
            }
          }
        `, { first: Math.min(first, 50), ...(hasFilter ? { filter } : {}) }, creds)

        return data.issues.nodes.map(i => ({
          id: i.identifier,
          title: i.title,
          priority: i.priority,
          state: i.state?.name,
          assignee: i.assignee?.displayName,
          team: i.team?.key,
          created_at: i.createdAt,
          updated_at: i.updatedAt,
          url: i.url,
        }))
      },
    },

    {
      name: 'get_issue',
      description: 'Get details of a specific Linear issue',
      input_schema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier (e.g., "ENG-123")' },
        },
        required: ['identifier'],
      },
      execute: async (input, creds) => {
        const { identifier } = input
        // Extract team key and number
        const [teamKey, numStr] = identifier.split('-')
        const number = parseInt(numStr, 10)

        const data = await linearQuery(`
          query($teamKey: String!, $number: Float!) {
            issueVcsByTeamAndNumber(teamKey: $teamKey, number: $number) {
              identifier
              title
              description
              priority
              priorityLabel
              state { name }
              assignee { displayName email }
              creator { displayName }
              team { key name }
              labels { nodes { name } }
              cycle { name number }
              project { name }
              estimate
              createdAt
              updatedAt
              completedAt
              url
            }
          }
        `, { teamKey, number }, creds).catch(async () => {
          // Fallback: search by identifier
          const searchData = await linearQuery(`
            query($filter: IssueFilter!) {
              issues(filter: $filter, first: 1) {
                nodes {
                  identifier title description priority priorityLabel
                  state { name } assignee { displayName } team { key name }
                  labels { nodes { name } } createdAt updatedAt url
                }
              }
            }
          `, { filter: { identifier: { eq: identifier } } }, creds)
          return { issueVcsByTeamAndNumber: searchData.issues.nodes[0] }
        })

        const i = data.issueVcsByTeamAndNumber
        if (!i) throw new Error(`Issue ${identifier} not found`)
        return {
          id: i.identifier,
          title: i.title,
          description: i.description?.slice(0, 2000),
          priority: i.priorityLabel,
          state: i.state?.name,
          assignee: i.assignee?.displayName,
          creator: i.creator?.displayName,
          team: i.team?.key,
          labels: i.labels?.nodes?.map(l => l.name),
          cycle: i.cycle?.name,
          project: i.project?.name,
          estimate: i.estimate,
          created_at: i.createdAt,
          updated_at: i.updatedAt,
          completed_at: i.completedAt,
          url: i.url,
        }
      },
    },

    {
      name: 'create_issue',
      description: 'Create a new Linear issue',
      input_schema: {
        type: 'object',
        properties: {
          team_key: { type: 'string', description: 'Team key (e.g., "ENG")' },
          title: { type: 'string', description: 'Issue title' },
          description: { type: 'string', description: 'Issue description (markdown)' },
          priority: { type: 'number', description: 'Priority (0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low)' },
          estimate: { type: 'number', description: 'Estimate points' },
        },
        required: ['team_key', 'title'],
      },
      execute: async (input, creds) => {
        const { team_key, title, description = '', priority, estimate } = input

        // Look up team ID
        const teamData = await linearQuery(`
          query($key: String!) {
            teams(filter: { key: { eq: $key } }) {
              nodes { id key name }
            }
          }
        `, { key: team_key }, creds)

        const team = teamData.teams.nodes[0]
        if (!team) throw new Error(`Team ${team_key} not found`)

        const vars = { teamId: team.id, title, description }
        if (priority !== undefined) vars.priority = priority
        if (estimate !== undefined) vars.estimate = estimate

        const data = await linearQuery(`
          mutation($teamId: String!, $title: String!, $description: String, $priority: Int, $estimate: Int) {
            issueCreate(input: {
              teamId: $teamId
              title: $title
              description: $description
              priority: $priority
              estimate: $estimate
            }) {
              success
              issue { identifier title url state { name } }
            }
          }
        `, vars, creds)

        const result = data.issueCreate
        if (!result.success) throw new Error('Failed to create issue')
        return {
          id: result.issue.identifier,
          title: result.issue.title,
          state: result.issue.state?.name,
          url: result.issue.url,
        }
      },
    },

    {
      name: 'list_teams',
      description: 'List all Linear teams',
      input_schema: { type: 'object', properties: {} },
      execute: async (input, creds) => {
        const data = await linearQuery(`
          query {
            teams {
              nodes { id key name description issueCount }
            }
          }
        `, {}, creds)
        return data.teams.nodes.map(t => ({
          key: t.key,
          name: t.name,
          description: t.description,
          issue_count: t.issueCount,
        }))
      },
    },

    {
      name: 'list_projects',
      description: 'List Linear projects',
      input_schema: {
        type: 'object',
        properties: {
          first: { type: 'number', description: 'Number of results (max 50)' },
        },
      },
      execute: async (input, creds) => {
        const { first = 20 } = input
        const data = await linearQuery(`
          query($first: Int!) {
            projects(first: $first, orderBy: updatedAt) {
              nodes {
                name
                state
                progress
                startDate
                targetDate
                teams { nodes { key } }
                lead { displayName }
                url
              }
            }
          }
        `, { first: Math.min(first, 50) }, creds)
        return data.projects.nodes.map(p => ({
          name: p.name,
          state: p.state,
          progress: Math.round(p.progress * 100),
          start_date: p.startDate,
          target_date: p.targetDate,
          teams: p.teams?.nodes?.map(t => t.key),
          lead: p.lead?.displayName,
          url: p.url,
        }))
      },
    },
  ]
}

module.exports = { getTools }

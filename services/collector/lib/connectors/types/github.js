/**
 * GitHub Connector — Phase 3 (VULCAN Agent)
 *
 * Tools for GitHub REST API v3.
 * Requires: token (personal access token or GitHub App token)
 *
 * Tool names are auto-prefixed with 'github_' by the connector bridge.
 * E.g., 'list_issues' becomes 'github_list_issues' at the MCP/agent layer.
 */

const GITHUB_API = 'https://api.github.com'

async function githubFetch(path, credentials, options = {}) {
  const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`GitHub API ${resp.status}: ${body.slice(0, 200)}`)
  }

  // Some endpoints return 204 No Content (e.g., rerun workflow)
  if (resp.status === 204) return { success: true }

  return resp.json()
}

function getTools(credentials) {
  return [
    // ===== Repositories =====

    {
      name: 'list_repos',
      description: 'List repositories for the authenticated user or an organisation',
      input_schema: {
        type: 'object',
        properties: {
          org: { type: 'string', description: 'Organisation name (omit for user repos)' },
          type: { type: 'string', enum: ['all', 'public', 'private', 'forks', 'sources'], description: 'Filter by type' },
          sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: 'Sort field' },
          per_page: { type: 'number', description: 'Results per page (max 100)' },
        },
      },
      execute: async (input, creds) => {
        const { org, type = 'all', sort = 'updated', per_page = 30 } = input
        const path = org
          ? `/orgs/${encodeURIComponent(org)}/repos?type=${type}&sort=${sort}&per_page=${Math.min(per_page, 100)}`
          : `/user/repos?type=${type}&sort=${sort}&per_page=${Math.min(per_page, 100)}`
        const repos = await githubFetch(path, creds)
        return repos.map(r => ({
          name: r.full_name,
          description: r.description,
          language: r.language,
          stars: r.stargazers_count,
          updated_at: r.updated_at,
          private: r.private,
          url: r.html_url,
        }))
      },
    },

    // ===== Issues =====

    {
      name: 'list_issues',
      description: 'List issues for a repository. Filters out pull requests.',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state' },
          labels: { type: 'string', description: 'Comma-separated label names' },
          assignee: { type: 'string', description: 'Filter by assignee username' },
          page: { type: 'number', description: 'Page number (default 1)' },
          per_page: { type: 'number', description: 'Results per page (max 100)' },
        },
        required: ['repo'],
      },
      execute: async (input, creds) => {
        const { repo, state = 'open', labels = '', assignee, page = 1, per_page = 30 } = input
        const params = new URLSearchParams({ state, page, per_page: Math.min(per_page, 100) })
        if (labels) params.set('labels', labels)
        if (assignee) params.set('assignee', assignee)
        const issues = await githubFetch(`/repos/${repo}/issues?${params}`, creds)
        return issues.filter(i => !i.pull_request).map(i => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: i.labels.map(l => l.name),
          author: i.user?.login,
          assignees: i.assignees?.map(a => a.login),
          created_at: i.created_at,
          updated_at: i.updated_at,
          comments: i.comments,
          url: i.html_url,
        }))
      },
    },

    {
      name: 'get_issue',
      description: 'Get details of a specific issue including its comments',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          number: { type: 'number', description: 'Issue number' },
        },
        required: ['repo', 'number'],
      },
      execute: async (input, creds) => {
        const { repo, number } = input
        const [issue, comments] = await Promise.all([
          githubFetch(`/repos/${repo}/issues/${number}`, creds),
          githubFetch(`/repos/${repo}/issues/${number}/comments?per_page=20`, creds),
        ])
        return {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          body: issue.body?.slice(0, 3000),
          labels: issue.labels.map(l => l.name),
          assignees: issue.assignees?.map(a => a.login),
          author: issue.user?.login,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          is_pull_request: !!issue.pull_request,
          url: issue.html_url,
          comments: comments.map(c => ({
            author: c.user?.login,
            body: c.body?.slice(0, 1000),
            created_at: c.created_at,
          })),
        }
      },
    },

    {
      name: 'create_issue',
      description: 'Create a new issue in a repository. Requires confirmation before execution.',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body (markdown)' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to add' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'GitHub usernames to assign' },
        },
        required: ['repo', 'title'],
      },
      execute: async (input, creds) => {
        const { repo, title, body = '', labels = [], assignees = [] } = input
        const issue = await githubFetch(`/repos/${repo}/issues`, creds, {
          method: 'POST',
          body: JSON.stringify({ title, body, labels, assignees }),
        })
        return {
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          state: issue.state,
        }
      },
    },

    {
      name: 'update_issue',
      description: 'Update an existing issue: change state, labels, assignees, or add a comment. Requires confirmation for closing.',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          number: { type: 'number', description: 'Issue number' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'New state' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Replace all labels with these' },
          assignees: { type: 'array', items: { type: 'string' }, description: 'Replace all assignees with these' },
          comment: { type: 'string', description: 'Add a comment to the issue' },
        },
        required: ['repo', 'number'],
      },
      execute: async (input, creds) => {
        const { repo, number, state, labels, assignees, comment } = input
        const results = {}

        // Update issue fields if any provided
        const updatePayload = {}
        if (state) updatePayload.state = state
        if (labels) updatePayload.labels = labels
        if (assignees) updatePayload.assignees = assignees

        if (Object.keys(updatePayload).length > 0) {
          const updated = await githubFetch(`/repos/${repo}/issues/${number}`, creds, {
            method: 'PATCH',
            body: JSON.stringify(updatePayload),
          })
          results.issue = {
            number: updated.number,
            title: updated.title,
            state: updated.state,
            labels: updated.labels.map(l => l.name),
            assignees: updated.assignees?.map(a => a.login),
            url: updated.html_url,
          }
        }

        // Add comment if provided
        if (comment) {
          const c = await githubFetch(`/repos/${repo}/issues/${number}/comments`, creds, {
            method: 'POST',
            body: JSON.stringify({ body: comment }),
          })
          results.comment = {
            id: c.id,
            body: c.body?.slice(0, 500),
            url: c.html_url,
          }
        }

        return results
      },
    },

    // ===== Pull Requests =====

    {
      name: 'list_prs',
      description: 'List pull requests for a repository with review and CI status',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state' },
          per_page: { type: 'number', description: 'Results per page (max 100)' },
        },
        required: ['repo'],
      },
      execute: async (input, creds) => {
        const { repo, state = 'open', per_page = 30 } = input
        const prs = await githubFetch(`/repos/${repo}/pulls?state=${state}&per_page=${Math.min(per_page, 100)}`, creds)
        return prs.map(pr => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login,
          head: pr.head?.ref,
          base: pr.base?.ref,
          draft: pr.draft,
          mergeable_state: pr.mergeable_state,
          review_comments: pr.review_comments,
          created_at: pr.created_at,
          updated_at: pr.updated_at,
          url: pr.html_url,
        }))
      },
    },

    {
      name: 'get_pr_diff',
      description: 'Get a pull request diff summary showing changed files and line counts',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          number: { type: 'number', description: 'Pull request number' },
        },
        required: ['repo', 'number'],
      },
      execute: async (input, creds) => {
        const { repo, number } = input
        const [pr, files] = await Promise.all([
          githubFetch(`/repos/${repo}/pulls/${number}`, creds),
          githubFetch(`/repos/${repo}/pulls/${number}/files?per_page=100`, creds),
        ])
        return {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          head: pr.head?.ref,
          base: pr.base?.ref,
          additions: pr.additions,
          deletions: pr.deletions,
          changed_files: pr.changed_files,
          mergeable: pr.mergeable,
          url: pr.html_url,
          files: files.map(f => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch?.slice(0, 1000),
          })),
        }
      },
    },

    // ===== GitHub Actions =====

    {
      name: 'list_actions_runs',
      description: 'List recent GitHub Actions workflow runs for a repository',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          status: { type: 'string', enum: ['completed', 'in_progress', 'queued', 'failure', 'success'], description: 'Filter by status' },
          per_page: { type: 'number', description: 'Results per page (max 100)' },
        },
        required: ['repo'],
      },
      execute: async (input, creds) => {
        const { repo, status, per_page = 10 } = input
        const params = new URLSearchParams({ per_page: Math.min(per_page, 100) })
        if (status) params.set('status', status)
        const result = await githubFetch(`/repos/${repo}/actions/runs?${params}`, creds)
        return {
          total_count: result.total_count,
          runs: result.workflow_runs?.map(run => ({
            id: run.id,
            name: run.name,
            status: run.status,
            conclusion: run.conclusion,
            branch: run.head_branch,
            event: run.event,
            run_attempt: run.run_attempt,
            created_at: run.created_at,
            updated_at: run.updated_at,
            url: run.html_url,
          })),
        }
      },
    },

    {
      name: 'get_actions_log',
      description: 'Get logs from a GitHub Actions workflow run. Returns job names, steps, and their conclusions.',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          run_id: { type: 'number', description: 'Workflow run ID' },
        },
        required: ['repo', 'run_id'],
      },
      execute: async (input, creds) => {
        const { repo, run_id } = input
        // Get jobs for the run (which include step-level detail)
        const result = await githubFetch(`/repos/${repo}/actions/runs/${run_id}/jobs?per_page=100`, creds)
        return {
          total_count: result.total_count,
          jobs: result.jobs?.map(job => ({
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            started_at: job.started_at,
            completed_at: job.completed_at,
            steps: job.steps?.map(step => ({
              name: step.name,
              status: step.status,
              conclusion: step.conclusion,
              number: step.number,
            })),
          })),
        }
      },
    },

    {
      name: 'rerun_workflow',
      description: 'Re-trigger a GitHub Actions workflow run. Requires confirmation before execution.',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          run_id: { type: 'number', description: 'Workflow run ID to re-run' },
        },
        required: ['repo', 'run_id'],
      },
      execute: async (input, creds) => {
        const { repo, run_id } = input
        await githubFetch(`/repos/${repo}/actions/runs/${run_id}/rerun`, creds, {
          method: 'POST',
        })
        return {
          success: true,
          message: `Workflow run ${run_id} has been re-triggered in ${repo}`,
          run_id,
        }
      },
    },

    // ===== Releases =====

    {
      name: 'create_release',
      description: 'Create a new release in a repository. Requires confirmation before execution.',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          tag: { type: 'string', description: 'Tag name for the release (e.g., v1.0.0)' },
          name: { type: 'string', description: 'Release title' },
          body: { type: 'string', description: 'Release notes (markdown)' },
          draft: { type: 'boolean', description: 'Create as draft release (default false)' },
          prerelease: { type: 'boolean', description: 'Mark as a prerelease (default false)' },
        },
        required: ['repo', 'tag'],
      },
      execute: async (input, creds) => {
        const { repo, tag, name, body = '', draft = false, prerelease = false } = input
        const release = await githubFetch(`/repos/${repo}/releases`, creds, {
          method: 'POST',
          body: JSON.stringify({
            tag_name: tag,
            name: name || tag,
            body,
            draft,
            prerelease,
          }),
        })
        return {
          id: release.id,
          tag: release.tag_name,
          name: release.name,
          draft: release.draft,
          prerelease: release.prerelease,
          url: release.html_url,
          created_at: release.created_at,
        }
      },
    },

    {
      name: 'compare_commits',
      description: 'Compare two refs (branches, tags, or SHAs) and list the commits between them',
      input_schema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repository (owner/name)' },
          base: { type: 'string', description: 'Base ref (branch, tag, or SHA)' },
          head: { type: 'string', description: 'Head ref (branch, tag, or SHA)' },
        },
        required: ['repo', 'base', 'head'],
      },
      execute: async (input, creds) => {
        const { repo, base, head } = input
        const result = await githubFetch(
          `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
          creds
        )
        return {
          status: result.status,
          ahead_by: result.ahead_by,
          behind_by: result.behind_by,
          total_commits: result.total_commits,
          commits: result.commits?.slice(0, 50).map(c => ({
            sha: c.sha?.slice(0, 7),
            message: c.commit?.message?.split('\n')[0],
            author: c.commit?.author?.name,
            date: c.commit?.author?.date,
          })),
          files_changed: result.files?.length,
          url: result.html_url,
        }
      },
    },

    // ===== Search =====

    {
      name: 'search_code',
      description: 'Search for code across GitHub repositories',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (GitHub code search syntax)' },
          per_page: { type: 'number', description: 'Results per page (max 100)' },
        },
        required: ['query'],
      },
      execute: async (input, creds) => {
        const { query, per_page = 20 } = input
        const result = await githubFetch(`/search/code?q=${encodeURIComponent(query)}&per_page=${Math.min(per_page, 100)}`, creds)
        return {
          total_count: result.total_count,
          items: result.items?.slice(0, 30).map(item => ({
            name: item.name,
            path: item.path,
            repository: item.repository?.full_name,
            url: item.html_url,
          })),
        }
      },
    },
  ]
}

module.exports = { getTools }

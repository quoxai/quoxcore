/**
 * MON-GOV-INT Phase 1: Jira ticketing adapter.
 *
 * Thin wrapper around the existing agent-tool Jira connector
 * (connectors/types/jira.js) — reuses its create_issue / add_comment
 * executes unmodified (zero changes to the connector, per plan §4.2).
 * Only responsibility here: alias the vault's Jira credential field shape
 * onto the connector's expected shape, and adapt the formatter's payload
 * into a create_issue call.
 */

const jiraConnector = require('../connectors/types/jira.js');

/**
 * Credential field-shape drift (plan §Key Risks #1): the auth vault's
 * Jira integration form (integrationTypeRegistry.js) captures
 * { email, api_token, domain }, while the collector connector
 * (connectors/registry.js requiredFields) wants { email, token,
 * endpoint_url }. Bridge the two — same alias mapping connectors/bridge.js
 * already applies for other multi-field connectors. Applied to whatever
 * the vault returns without mutating fields the connector already has.
 */
function aliasCredentials(fields = {}) {
  const out = { ...fields };
  if (!out.token && out.api_token) out.token = out.api_token;
  if (!out.endpoint_url && out.domain) {
    out.endpoint_url = /^https?:\/\//i.test(out.domain) ? out.domain : `https://${out.domain}`;
  }
  return out;
}

/**
 * createTicket(credentials, settings, formatted) → { ref, url }
 * `formatted` is the output of governanceTicketFormatter.formatJiraTicket().
 */
async function createTicket(credentials, settings, formatted) {
  const tools = jiraConnector.getTools(credentials);
  const createIssue = tools.find((t) => t.name === 'create_issue');
  if (!createIssue) throw new Error('jira connector missing create_issue tool');

  const result = await createIssue.execute({
    project_key: formatted.project_key,
    summary: formatted.summary,
    description: formatted.description,
    issue_type: formatted.issue_type,
    priority: formatted.priority,
    labels: formatted.labels,
  }, credentials);

  return { ref: result.key, url: result.url };
}

/**
 * commentTicket(credentials, issueKey, body) — resolve-sync path.
 * Not wired into the dispatcher in Phase 1 (resolve-sync ships alongside
 * the ServiceNow adapter in a later phase) but exposed now so the seam
 * exists without a second adapter change later.
 */
async function commentTicket(credentials, issueKey, body) {
  const tools = jiraConnector.getTools(credentials);
  const addComment = tools.find((t) => t.name === 'add_comment');
  if (!addComment) throw new Error('jira connector missing add_comment tool');
  return addComment.execute({ issue_key: issueKey, body }, credentials);
}

module.exports = {
  aliasCredentials,
  createTicket,
  commentTicket,
};

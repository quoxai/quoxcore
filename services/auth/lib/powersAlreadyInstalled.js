/**
 * LIFECYCLE-P2-D1: Already-installed detection helper.
 *
 * Checks whether a repo_url has already been deployed as a POWERS mcp_hosted
 * tool for a given org. Returns the existing record if found, null otherwise.
 *
 * Logic:
 * - Join tool_definitions (spec_json.provenance.repo_url) → tool_installations (org scoping)
 *   → agent_tool_assignments → agents to get the agent_id
 * - Only match rows where tool_definitions.status != 'disabled'
 *   (disabled = destroyed via hard teardown; allow re-deploy after destroy)
 * - Match on the orgId + provenance.repo_url extracted via json_extract
 */

/**
 * Detect an existing POWERS mcp_hosted deploy for the same org + repo_url.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} orgId
 * @param {string} repoUrl
 * @returns {{
 *   tool_def_id: string,
 *   tool_id: string,
 *   agent_id: string | null,
 *   deployed_at: string,
 *   current_version: string,
 *   status: string,
 * } | null}
 */
export function detectExistingRepoDeploy(db, orgId, repoUrl) {
  const row = db.prepare(`
    SELECT
      td.id         AS tool_def_id,
      td.tool_id    AS tool_id,
      td.status     AS status,
      td.version    AS current_version,
      ti.installed_at AS deployed_at,
      ata.agent_id  AS agent_id
    FROM tool_definitions td
    JOIN tool_installations ti
      ON ti.tool_definition_id = td.id
      AND ti.org_id = ?
    LEFT JOIN agent_tool_assignments ata
      ON ata.tool_installation_id = ti.id
      AND ata.revoked_at IS NULL
    WHERE
      td.status != 'disabled'
      AND json_extract(td.spec_json, '$.executor_type') = 'mcp_hosted'
      AND json_extract(td.spec_json, '$.provenance.repo_url') = ?
    LIMIT 1
  `).get(orgId, repoUrl);

  if (!row) return null;

  return {
    tool_def_id: row.tool_def_id,
    tool_id: row.tool_id,
    agent_id: row.agent_id || null,
    deployed_at: row.deployed_at,
    current_version: row.current_version,
    status: row.status,
  };
}

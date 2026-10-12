// Org-level team-schedules listing (the team half of GET /api/schedules).
//
// team_definitions has NO display_name column — the human name lives inside
// manifest_json under displayName. The original WC-5 inline query selected
// td.display_name, so the endpoint 500'd ("no such column") for every org
// with any schedule row. Pinned by test/orgSchedules.test.js.
export function listTeamSchedulesWithNames(db, orgId) {
  return db.prepare(`
    SELECT s.*, json_extract(td.manifest_json, '$.displayName') as team_name
    FROM team_schedules s
    LEFT JOIN team_definitions td ON s.team_definition_id = td.id
    WHERE s.org_id = ?
    ORDER BY s.enabled DESC, s.next_trigger_at ASC
  `).all(orgId)
}

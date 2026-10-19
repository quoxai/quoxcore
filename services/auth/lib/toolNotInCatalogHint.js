/**
 * quoxai/quox #1045: say why a tool id is not installable, with a hint the
 * caller can actually follow.
 *
 * Org tools (`quox tool create` + `quox tool publish`) live in the org `tools`
 * asset table (Phase B.1 asset registry: share policies, workflow steps). They
 * are not catalog entries: tool_definitions is global with no org column,
 * nothing executes a `tools` row as an agent tool, and agent assignment only
 * resolves tool_installations -> tool_definitions. Org-authored tools reach
 * the catalog through the Tool Library (from script, from repo, Toolsmith).
 *
 * The org lookup is pinned to the caller's verified org, so the hint never
 * reveals that another org has a tool by that name.
 */
export function toolNotInCatalogMessage(db, orgId, requested) {
    let orgTool = null;
    if (orgId) {
        try {
            orgTool = db.prepare('SELECT id FROM tools WHERE org_id = ? AND (slug = ? OR id = ?) LIMIT 1')
                .get(orgId, requested, requested);
        } catch { /* tools table absent on a minimal schema: plain message */ }
    }
    if (orgTool) {
        return `'${requested}' is an org tool (made with \`quox tool create\`), not a catalog tool. `
            + 'Agents are assigned catalog tools only; add your own tool to the catalog from the dashboard Tool Library '
            + '(from script, repo or Toolsmith). Run `quox tool catalog` for installable tool ids.';
    }
    return `'${requested}' is not in the tool catalog. Run \`quox tool catalog\` for installable tool ids.`;
}

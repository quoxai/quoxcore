/**
 * Action execution — core module (LICENSE-LAUNCH LL-7 extraction 1).
 *
 * Moved from src/components/actions/ so NOCView and SOCView (both core, both
 * must keep working when the action-tracker plugin strips) do not import
 * anything from a stripped plugin bundle. ActionQSidebar stays behind in
 * src/components/actions/ — it is exclusive to the action-tracker plugin's
 * ActionsView (the Kanban board) and ships with that bundle.
 */

export { ActionResultsPanel, default as ActionResultsPanelDefault } from './ActionResultsPanel'
export { useActionExecution } from './useActionExecution'

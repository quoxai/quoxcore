/**
 * LicenceGate: one rule for a paid plugin view that is not licensed here.
 * An ORG problem (no active org, every org seat taken, org not assigned) is
 * explained by PluginLicenseNotice, because buying again would not fix it.
 * Anything else shows the plugin's own locked (purchase) page.
 * Added 2026-10-07 when InboxQ, Calendar-Q and NotesQ became governed and
 * org-seat bands started deciding access (licensing skill: reason-gate).
 */
import PluginLicenseNotice from './PluginLicenseNotice'

export const ORG_ISSUE_CODES = new Set(['no_org', 'org_cap', 'org_unassigned'])

export default function LicenceGate({ diag, displayName, locked }) {
  if (diag && ORG_ISSUE_CODES.has(diag.code)) return <PluginLicenseNotice diag={diag} displayName={displayName} />
  return locked
}

// SKILLRIGHTS: shared short labels for SkillRights licence identifiers.
// One source for every surface that renders a licence chip (dev-hub pack
// chips, QSKL skills library). Unknown identifiers pass through UNABBREVIATED:
// mislabelling a custom licence would be a false claim about declared rights.
// A missing declaration is rendered as undeclared by the CALLER, never
// defaulted to a licence here.
export const RIGHTS_SHORT_LABELS = {
  'LicenseRef-SkillRights-Open-1.0': 'Open 1.0',
  'LicenseRef-SkillRights-NoTrain-1.0': 'NoTrain 1.0',
  'LicenseRef-SkillRights-Reserved-1.0': 'Reserved 1.0',
}

export function shortLicenceLabel(id) {
  if (!id) return null
  return RIGHTS_SHORT_LABELS[id] || id
}

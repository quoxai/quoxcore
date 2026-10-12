/** Pure helpers for the P5 import and duplicates UI (exported for tests). */
import { describeDuplicateReason } from './reasonCodes'

const ROW_LABELS = [
  ['rows', 'Rows read'],
  ['would_create', 'New people to add'],
  ['would_merge_into_existing', 'Match someone you already have (identifiers are added to them)'],
  ['organisations_would_create', 'New organisations to add'],
  ['photos', 'Photos to store'],
  ['duplicates_in_file', 'Repeats within the file (folded together)'],
  ['skipped_tombstoned', 'Skipped: erased before and blocked from coming back'],
  ['skipped_suppressed_marked', 'On a do-not-contact list (imported, but flagged)'],
];
const COMMIT_LABELS = [
  ['rows', 'Rows read'],
  ['created', 'People added'],
  ['merged_into_existing', 'Matched to someone you already have'],
  ['organisations_created', 'Organisations added'],
  ['identifiers_added', 'Numbers and addresses added'],
  ['photos', 'Photos stored'],
  ['photos_skipped', 'Photos skipped (too large or not a usable image)'],
  ['duplicates_in_file', 'Repeats within the file (folded together)'],
  ['skipped_tombstoned', 'Skipped: erased before and blocked from coming back'],
  ['skipped_suppressed_marked', 'On a do-not-contact list (imported, but flagged)'],
];

const INVALID_CODES = {
  missing_name: 'no name',
  invalid_name: 'name too long',
  invalid_email: 'an email address that is not valid',
  invalid_phone: 'a phone number that is not valid',
};
export const describeInvalid = (i) => `Row ${i.row}: ${INVALID_CODES[i.code] || String(i.code).replace(/_/g, ' ')}`;

/** [{label, value}] for a dry-run report (r) or a commit result (counts). Zero rows are kept: an honest 0 is information. */
export function reportRows(source, { commit = false } = {}) {
  const labels = commit ? COMMIT_LABELS : ROW_LABELS;
  return labels.filter(([k]) => source && source[k] !== undefined).map(([k, label]) => ({ key: k, label, value: source[k] }));
}

export const duplicateLine = (d) => `${d.a.display_name} and ${d.b.display_name}: ${(d.reasons || []).map(describeDuplicateReason).join(', ')}`;

/** Parse the optional mapping textarea. -> { value } | { error } */
export function parseMappingText(text) {
  const t = String(text || '').trim();
  if (!t) return { value: undefined };
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'The mapping must be a JSON object like {"Header": "email"}.' };
    return { value: v };
  } catch { return { error: 'The mapping is not valid JSON.' }; }
}

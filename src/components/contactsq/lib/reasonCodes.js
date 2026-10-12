/**
 * Plain-English maps for ContactsQ: policy reason codes, API error codes,
 * flags, relationships, purposes and channels. One file so wording is edited
 * in one place. The server only ever emits stable codes; this is the only
 * place they become sentences.
 */

export const REASONS = {
  erased: 'This contact has been erased, so there is nothing to reach.',
  deceased: 'This contact is marked deceased.',
  no_identifier: 'There is no number or address on file for that channel.',
  identifier_bounced: 'The address or number on file has bounced or is dead.',
  dnc: 'The number is on the do-not-contact list for calls and texts.',
  do_not_market: 'They have opted out of marketing. Service and transactional messages are still allowed.',
  org_do_not_market: 'Their organisation has opted out of marketing, which covers the people who work there. Service and transactional messages are still allowed.',
  human_only: 'This contact is flagged human only, so an agent may not contact them.',
  minor: 'This contact is a minor, so a person must approve each approach.',
  complainant: 'This contact has complained before, so a person must approve each approach.',
  consent_withdrawn: 'They withdrew consent for this purpose and channel.',
  objected: 'They objected to this purpose and channel.',
  no_marketing_consent: 'Marketing needs recorded consent (or a soft opt-in) for this channel, and there is none.',
  tps_not_screened: 'Marketing calls should be screened against the TPS register, which is not wired yet, so a person must approve.',
  no_lawful_basis_recorded: 'Research contact needs a recorded lawful basis, and none is on file, so a person must approve.',
  assumed_legitimate_interest: 'No consent is recorded. Service and transactional contact is allowed on the basis of contract or legitimate interest.',
  quiet_hours: 'It is inside quiet hours for this contact, so a person must approve a call or text.',
  ai_disclosure_required: 'Allowed, but the conversation must disclose that the caller is an AI.',
  // API error codes
  suppressed: 'This contact is on the do-not-contact list for that channel.',
  unsupported_image_type: 'Choose a PNG, JPEG or WebP picture.',
  no_photo: 'This contact has no photo.',
  invalid_compliance_report: 'The compliance report setting is not valid.',
  invalid_compliance_report_cadence: 'Choose weekly or monthly for the compliance report.',
  invalid_compliance_report_day: 'Choose a valid day for the compliance report (Monday to Sunday, or 1 to 28 of the month).',
  invalid_compliance_report_time_utc: 'Enter the compliance report time as HH:MM in UTC.',
  history_unavailable: 'The history log is not connected on this server.',
  invalid_limit: 'That page size is not valid.',
  invalid_before: 'That date is not valid.',
  policy_denied: 'Policy refused this approach.',
  approval_required: 'A person needs to approve this approach first.',
  human_required: 'Only a signed-in person can do this. Agents and services cannot.',
  service_required: 'Only a service can do this.',
  admin_required: 'Only a signed-in org admin can do this. Agents, services and other members cannot.',
  legal_hold: 'This contact is on legal hold, so it cannot be erased. Remove the legal hold flag first.',
  already_erased: 'This contact has already been erased.',
  contact_erased: 'This contact has been erased, so there is nothing left to change or export.',
  identifier_erased: 'That number or address belongs to someone who was erased. It is blocked from being added back.',
  erasure_tombstone: 'Erased earlier. This number or address cannot be added back.',
  notice_not_required: 'No Article 14 notice is due for this contact.',
  invalid_scope: 'Choose what to erase.',
  invalid_reason_code: 'Choose a reason for the erasure.',
  edge_exists: 'That relationship is already recorded.',
  self_edge: 'A contact cannot be related to itself.',
  invalid_edge_kinds: 'That relationship does not fit these two contacts (for example, works at needs a person and an organisation).',
  identifier_in_use: 'That number or address already belongs to another contact in this org.',
  invalid_value: 'That value is not valid for the channel.',
  file_required: 'Choose a file to import.',
  file_too_large: 'That file is too large (photos: 2 MB, imports: 50 MB).',
  too_many_rows: 'That file has more than 20,000 rows. Split it and import in parts.',
  empty_file: 'That file is empty.',
  no_recognised_columns: 'No column looked like a name, email or phone. Rename the headers or map them by hand.',
  no_contacts_found: 'No contacts were found in that file.',
  malformed_csv: 'That CSV could not be read (an unclosed quote?).',
  malformed_vcard: 'That does not look like a vCard file.',
  invalid_format: 'Choose CSV or vCard.',
  invalid_mapping: 'The column mapping is not valid.',
  same_contact: 'Choose two different contacts.',
  kind_mismatch: 'A person can only be merged into a person, and an organisation into an organisation.',
  not_mergeable: 'One of those contacts is already merged, erased or missing.',
  merge_expired: 'This merge is past its 30 day undo window.',
  merge_not_active: 'This merge was already undone or has expired.',
  survivor_unavailable: 'The surviving contact was merged further or erased. Undo that first.',
  contact_merged: 'This contact was merged into another. Work with the surviving contact.',
  contact_shredded: 'This contact has been erased, so its data cannot be read.',
  too_many_proposals: 'There are already too many unreviewed suggestions for this contact. Review them first.',
  invalid_key: 'Give the fact a short label (up to 64 characters).',
  invalid_review_state: 'Choose confirmed or rejected.',
  credential_rejected: 'The address book server rejected that login. For iCloud use an app-specific password, not your Apple ID password.',
  credential_wrong_kind: 'That credential is not an address book login. Pick one of kind carddav_account.',
  lease_required: 'That credential needs an active lease before ContactsQ can use it.',
  source_exists: 'That address book is already linked.',
  source_retired: 'This source stopped after repeated failures. Enable it again to retry.',
  sync_in_progress: 'A sync is already running for this source.',
  no_addressbook: 'No address book was found on that account.',
  addressbook_choice_required: 'This account has more than one address book. Choose one.',
  blocked_egress: 'That server address is not allowed (it must be a public https address).',
  https_required: 'The address book server must use https.',
  auth_failed: 'The address book server rejected the saved login. Check the credential.',
  not_found: 'That contact was not found.',
  unauthenticated: 'You are signed out. Sign in again.',
  forbidden: 'You do not have permission to do that.',
  internal_error: 'The server hit an error. Try again.',
};

const humanise = (code) => String(code || '').replace(/^invalid_/, 'Invalid ').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** A reason may arrive as a bare code or as {code}. Returns a sentence. */
export function explainReason(reason) {
  const code = typeof reason === 'string' ? reason : reason?.code;
  if (!code) return '';
  return REASONS[code] || (code.startsWith('invalid_') ? `${humanise(code)}: check the value and try again.` : `${humanise(code)}.`);
}

/** Turn an ApiError (or any Error) into one human sentence for a banner. */
export function explainError(err) {
  if (!err) return '';
  if (err.status === 401) return REASONS.unauthenticated;
  if (err.code && REASONS[err.code]) return REASONS[err.code];
  if (err.status === 403) return REASONS.forbidden;
  if (err.code && err.code.startsWith('invalid_')) return explainReason(err.code);
  return err.message || 'Something went wrong.';
}

export const DECISIONS = {
  allow: { label: 'Allowed', pill: 'qx-pill--online', blurb: 'You can reach them this way.' },
  deny: { label: 'Not allowed', pill: 'qx-pill--danger', blurb: 'Do not reach them this way.' },
  approval_required: { label: 'Needs approval', pill: 'qx-pill--degraded', blurb: 'A person must approve before anything is sent.' },
};

export const RELATIONSHIPS = ['customer', 'prospect', 'lead', 'supplier', 'partner', 'employee', 'contractor', 'investor', 'press', 'advisor', 'personal', 'unknown'];

export const STATUSES = ['active', 'candidate', 'archived'];

/** Closed flag set with a one-line explanation of what each does. */
export const FLAGS = [
  { key: 'do_not_call', label: 'Do not call', help: 'Blocks voice calls to this person.' },
  { key: 'do_not_sms', label: 'Do not text', help: 'Blocks text messages to this person.' },
  { key: 'do_not_email', label: 'Do not email', help: 'Blocks email to this person.' },
  { key: 'do_not_market', label: 'Do not market', help: 'Blocks marketing only. Service and transactional contact still goes through.' },
  { key: 'human_only', label: 'Human only', help: 'Agents may not contact them. A person still can.' },
  { key: 'ai_disclosure_required', label: 'AI disclosure required', help: 'Any AI conversation must say it is an AI.' },
  { key: 'vip', label: 'VIP', help: 'A label for your own triage. No effect on whether we can reach them.' },
  { key: 'legal_hold', label: 'Legal hold', help: 'Keeps the record from being deleted. No effect on reach.' },
  { key: 'minor', label: 'Minor', help: 'Every approach needs a person to approve it.' },
  { key: 'deceased', label: 'Deceased', help: 'Blocks all contact.' },
  { key: 'complainant', label: 'Complainant', help: 'Every approach needs a person to approve it.' },
  { key: 'source_removed', label: 'Removed at source', help: 'The address book this person was synced from no longer lists them. Nothing was deleted here. No effect on reach.' },
];

/**
 * How loud a flag is. 'high' blocks contact outright, 'medium' makes a person approve or changes
 * how an agent must behave, 'info' is a label with no effect on reach. Drives the pill colour.
 */
export const FLAG_SEVERITY = {
  do_not_call: 'high', do_not_sms: 'high', do_not_email: 'high', do_not_market: 'high', human_only: 'high', deceased: 'high',
  minor: 'medium', complainant: 'medium', ai_disclosure_required: 'medium',
  vip: 'info', legal_hold: 'info', source_removed: 'info',
};
export const flagSeverity = (key) => FLAG_SEVERITY[key] || 'info';
/** Policy-bearing flags change who may reach the contact; informational ones do not. */
export const isPolicyFlag = (key) => flagSeverity(key) !== 'info';
export const flagLabel = (key) => FLAGS.find((f) => f.key === key)?.label || humanise(key);
/** Menu groups, loudest first, for the "Add flag" menu. */
export const FLAG_GROUPS = [
  { severity: 'high', label: 'Blocks contact' },
  { severity: 'medium', label: 'Needs a person\'s approval' },
  { severity: 'info', label: 'Labels only' },
];

export const PURPOSES = [
  { key: 'service', label: 'Service' },
  { key: 'transactional', label: 'Transactional' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'research', label: 'Research' },
  { key: 'ai_interaction', label: 'AI interaction' },
];

export const CHANNELS = [
  { key: 'voice', label: 'Voice' },
  { key: 'sms', label: 'SMS' },
  { key: 'email', label: 'Email' },
  { key: 'post', label: 'Post' },
  { key: 'social', label: 'Social' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'any', label: 'Any channel' },
];

/** Channels a reachability check can be run for. */
export const REACH_CHANNELS = CHANNELS.filter((c) => ['voice', 'sms', 'email'].includes(c.key));

export const IDENTIFIER_CHANNELS = [
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'social', label: 'Social (network:handle)' },
  { key: 'url', label: 'Web address' },
  { key: 'address', label: 'Postal address' },
];

export const CONSENT_STATUSES = [
  { key: 'granted', label: 'Granted', pill: 'qx-pill--online' },
  { key: 'soft_opt_in', label: 'Soft opt-in', pill: 'qx-pill--info' },
  { key: 'withdrawn', label: 'Withdrawn', pill: 'qx-pill--danger' },
  { key: 'objected', label: 'Objected', pill: 'qx-pill--danger' },
  { key: 'unknown', label: 'Unknown', pill: 'qx-pill--ghost' },
];

export const LAWFUL_BASES = [
  { key: 'consent', label: 'Consent' },
  { key: 'contract', label: 'Contract' },
  { key: 'legitimate_interest', label: 'Legitimate interest' },
  { key: 'legal_obligation', label: 'Legal obligation' },
  { key: 'vital_interest', label: 'Vital interest' },
  { key: 'public_task', label: 'Public task' },
];

/** P4: reason codes offered on an erasure (stored on the certificate). */
export const ERASE_REASONS = [
  { key: 'subject_request', label: 'The person asked' },
  { key: 'consent_withdrawn', label: 'Consent withdrawn' },
  { key: 'data_minimisation', label: 'No longer needed' },
  { key: 'duplicate', label: 'Duplicate record' },
  { key: 'other', label: 'Other' },
];
export const ERASE_SCOPES = [
  { key: 'full', label: 'Erase everything (cannot be undone)', help: 'Destroys the key to their name, notes, numbers, addresses and call summaries. The same number or address can never be added back.' },
  { key: 'identifiers_only', label: 'Erase numbers and addresses only', help: 'Removes and blocks every number and address, and keeps the rest of the record.' },
];
/** Plain-English labels for the per-surface propagation map on a certificate. */
export const PROPAGATION_SURFACES = {
  contactsq: 'Contact record', touchpoints: 'Call and message history', leases: 'Access leases', consents: 'Consent history',
  suppressions: 'Block list', photo: 'Photo', voice_call_log: 'Phone bridge call log', backups: 'Backups',
};
export const PROPAGATION_STATES = {
  shredded: 'Destroyed', identifiers_removed: 'Numbers and addresses removed', shredded_with_contact: 'Destroyed with the contact', retained: 'Kept',
  revoked: 'All active leases revoked', retained_codes_only: 'Kept (codes only, no personal data)', tombstoned: 'Every number and address blocked',
  NOT_PROPAGATED: 'NOT removed here: the phone bridge keeps its own call log',
};
export function describePropagation(value) {
  if (typeof value === 'string' && value.startsWith('ages_out_by:')) return `Ages out of backups by ${value.slice('ages_out_by:'.length)}`;
  return PROPAGATION_STATES[value] || humanise(value);
}
/** The destructive button stays disabled until the exact display name has been typed. */
export const canErase = (typed, name) => typeof name === 'string' && name.length > 0 && String(typed || '').trim() === name.trim();

export const SUPPRESSION_REASONS = [
  { key: 'dnc', label: 'Do not contact (calls and texts)' },
  { key: 'do_not_market', label: 'Do not market' },
  { key: 'bounced', label: 'Bounced' },
];

export const labelOf = (list, key) => list.find((x) => x.key === key)?.label || humanise(key);

/** P3: touchpoint surfaces, directions and relationship types in plain English. */
export const SURFACES = [
  { key: 'voice', label: 'Phone call' }, { key: 'inboxq', label: 'Email' }, { key: 'calendarq', label: 'Calendar' },
  { key: 'notesq', label: 'Notes' }, { key: 'actionq', label: 'Action' }, { key: 'corecomms', label: 'Message' },
  { key: 'contactsq', label: 'Contacts' }, { key: 'manual', label: 'Logged by hand' }, { key: 'agent', label: 'Agent handoff' },
];
export const DIRECTIONS = { inbound: 'They contacted us', outbound: 'We contacted them', internal: 'Internal' };
export const OUTCOMES = {
  dial_released: 'A call was placed', send_released: 'A message was sent', context_released: 'An agent read the confirmed context',
};
/** Relationship types a person can add by hand: [key, how it reads from this contact, how it reads from the other side]. */
export const EDGE_TYPES = [
  { key: 'works_at', out: 'Works at', in: 'Employs', needsKind: 'organisation' },
  { key: 'reports_to', out: 'Reports to', in: 'Manager of', needsKind: 'person' },
  { key: 'related_to', out: 'Related to', in: 'Related to', needsKind: null },
];

/** P5: fact sensitivity and review state, in plain English. */
export const SENSITIVITIES = {
  normal: { label: 'Normal', pill: 'qx-pill--ghost', help: 'Agents may read it once you confirm it and approve their request.' },
  special_category: { label: 'Sensitive', pill: 'qx-pill--danger', help: 'Health, religion, union, sexuality, politics, biometric or criminal. Never given to agents.' },
  financial: { label: 'Financial', pill: 'qx-pill--degraded', help: 'Kept from agents.' },
  minor: { label: 'About a minor', pill: 'qx-pill--degraded', help: 'Kept from agents.' },
};
export const REVIEW_STATES = {
  proposed: { label: 'Needs review', pill: 'qx-pill--info' },
  confirmed: { label: 'Confirmed', pill: 'qx-pill--online' },
  rejected: { label: 'Rejected', pill: 'qx-pill--ghost' },
};
export const MERGE_REASONS = { name: 'Same name', name_org: 'Same name at the same organisation' };
/** Why two contacts look alike, in a phrase ("identifier:email" -> "Same email"). */
export function describeDuplicateReason(code) {
  if (typeof code === 'string' && code.startsWith('identifier:')) return `Same ${code.slice('identifier:'.length)}`;
  return MERGE_REASONS[code] || humanise(code);
}

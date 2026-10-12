'use strict';

/**
 * ContactsQ facts (P5): structured "additional context" about a contact.
 *
 * The value is AES-256-GCM ciphertext under the contact DEK (v2 binding
 * `fact:<id>`); the key is a plain, org-vocabulary label. Agents can only
 * PROPOSE a fact (it lands review_state 'proposed'); a human confirms, edits or
 * rejects it. Only confirmed, non-expired, sensitivity 'normal' facts can ever
 * reach an agent, and only through an approval-gated 'context' lease.
 *
 * The special-category guard is a deterministic keyword classifier over
 * key + value. It FLAGS (sensitivity special_category), it never blocks: a
 * receptionist will legitimately hear sensitive things.
 */

const cx = require('./crypto.js');
const store = require('./store.js');

const SENSITIVITIES = ['normal', 'special_category', 'financial', 'minor'];
const REVIEW_STATES = ['proposed', 'confirmed', 'rejected'];
const MAX_PENDING_PROPOSALS = 50;

// Art. 9 categories. Word-boundary regexes, lowercase text. Ambiguous words (a bare "union", "doctor") are
// deliberately absent: a flagged fact only costs a human review, a missed one leaks, so the lists lean wide
// but stay phrase-aware where the bare word is common in ordinary business text.
const SPECIAL_RULES = [
  ['health', /\b(health|medical|medication|medicine|diagnos(?:is|ed|es)|disease|illness|sickness|cancer|chemo(?:therapy)?|diabet(?:es|ic)|pregnan(?:t|cy)|disabilit(?:y|ies)|disabled|wheelchair|surgery|operation scheduled|therapy|therapist|hospital|mental|depress(?:ion|ed)|anxiety|allerg(?:y|ies|ic)|asthma|epilep(?:sy|tic)|hiv|aids|terminal|dementia|autis(?:m|tic)|adhd|dyslexi[ac]|bereave(?:d|ment)|sick leave|impairment)\b/],
  ['religion', /\b(religio(?:n|us)|church|mosque|synagogue|temple|muslim|christian|jewish|hindu|sikh|buddhis(?:t|m)|atheis(?:t|m)|agnostic|islam(?:ic)?|catholic|protestant|orthodox|faith|prayer|ramadan|sabbath|halal|kosher|pastor|imam|rabbi)\b/],
  ['union', /\b(trade union|trades union|labou?r union|union member(?:ship)?|union rep(?:resentative)?|shop steward|unionis(?:t|ed))\b/],
  ['sexuality', /\b(sexual(?:ity)?|sexual orientation|orientation|gay|lesbian|bisexual|homosexual|heterosexual|lgbt[a-z+]*|transgender|trans (?:man|woman)|gender identity|queer|non-?binary|intersex)\b/],
  ['politics', /\b(politic(?:s|al|ally)|politician|voter|votes? for|voting|party member(?:ship)?|(?:labou?r|conservative|tory|liberal democrat|lib dem|green|democrat(?:ic)?|republican|snp|reform|communist|socialist|fascist) party|left[- ]wing|right[- ]wing|activist|campaign(?:er)? for)\b/],
  ['biometric', /\b(biometric|fingerprint|face ?(?:id|scan|print|recognition)|facial recognition|retina|iris scan|voice ?print|dna|genetic|genome)\b/],
  ['criminal', /\b(criminal|convict(?:ed|ion|ions)|arrest(?:ed)?|prison|imprisoned|jail(?:ed)?|felony|misdemeanou?r|offen[cs]e|offender|sentenced|probation|parole|dbs check|police record|charged with|court case)\b/],
];

const FINANCIAL_RE = /\b(iban|sort code|account number|bank account|credit card|card number|debit card|salary|income|net worth|credit score|mortgage|debt|bankrupt(?:cy)?|tax (?:id|number|code)|national insurance|ssn)\b/;
const MINOR_RE = /\b(minor|under ?18|under ?16|child(?:ren)?|underage|school pupil|date of birth of (?:their )?child)\b/;

/** -> { sensitivity, categories: [codes] }. Pure and deterministic. */
function classify(key, value) {
  const text = `${key || ''} ${value || ''}`.toLowerCase().replace(/_+/g, ' ').replace(/\s+/g, ' ');
  const categories = [];
  for (const [code, re] of SPECIAL_RULES) if (re.test(text)) categories.push(code);
  if (categories.length) return { sensitivity: 'special_category', categories };
  if (FINANCIAL_RE.test(text)) return { sensitivity: 'financial', categories: ['financial'] };
  if (MINOR_RE.test(text)) return { sensitivity: 'minor', categories: ['minor'] };
  return { sensitivity: 'normal', categories: [] };
}

const SEVERITY = { normal: 0, minor: 1, financial: 1, special_category: 2 };
/** Effective sensitivity: the classifier can raise it, nothing can lower a flagged one. */
function effectiveSensitivity(requested, key, value) {
  const c = classify(key, value).sensitivity;
  const r = SENSITIVITIES.includes(requested) ? requested : 'normal';
  return SEVERITY[c] > SEVERITY[r] ? c : r;
}

function rowToFact(row, value) {
  return {
    id: row.id, contact_id: row.contact_id, key: row.key, value, confidence: row.confidence,
    sensitivity: row.sensitivity, review_state: row.review_state, expires_at: row.expires_at || null,
    provenance_id: row.provenance_id || null, created_by: row.created_by || null, created_at: row.created_at,
    reviewed_by: row.reviewed_by || null, reviewed_at: row.reviewed_at || null,
  };
}

/** Value-free summary (safe for agent replies about their own proposal). */
function summaryOf(row) {
  return { id: row.id, contact_id: row.contact_id, key: row.key, confidence: row.confidence, sensitivity: row.sensitivity, review_state: row.review_state };
}

const bindFact = (orgId, contactId, factId) => store.bindOf(orgId, contactId, `fact:${factId}`);

function decryptValue(contactRow, factRow) {
  const dek = store.dekFor(contactRow);
  if (!dek) return null;
  try { return cx.decryptField(dek, factRow.value_ciphertext, bindFact(contactRow.org_id, contactRow.id, factRow.id)); } catch { return null; }
}

function getFactRow(orgId, contactId, factId) {
  return store.getDb().prepare('SELECT * FROM contact_facts WHERE org_id = ? AND contact_id = ? AND id = ?').get(orgId, contactId, String(factId)) || null;
}

function pendingCount(orgId, contactId) {
  return store.getDb().prepare("SELECT COUNT(*) AS n FROM contact_facts WHERE org_id = ? AND contact_id = ? AND review_state = 'proposed'").get(orgId, contactId).n;
}

/**
 * Insert a fact. `origin` 'agent' forces review_state 'proposed' whatever else is passed.
 * Throws ContactsqError 409 contact_shredded / 429 too_many_proposals.
 */
function createFact(orgId, contactRow, input, { origin, by }) {
  const db = store.getDb();
  const dek = store.dekFor(contactRow);
  if (!dek) throw new store.ContactsqError(409, 'contact_shredded');
  const agent = origin === 'agent';
  if (agent && pendingCount(orgId, contactRow.id) >= MAX_PENDING_PROPOSALS) throw new store.ContactsqError(429, 'too_many_proposals');
  const id = store.gid('cf');
  const ts = store.nowIso();
  const sensitivity = effectiveSensitivity(input.sensitivity, input.key, input.value);
  const reviewState = agent ? 'proposed' : 'confirmed';
  db.transaction(() => {
    const provId = db.prepare(`
      INSERT INTO contact_provenance (id, org_id, contact_id, source_type, source_ref, captured_by, captured_at, trust)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const pid = store.gid('cp');
    provId.run(pid, orgId, contactRow.id, agent ? 'fact_agent' : 'fact_manual', id, by || null, ts, agent ? 'observed' : 'subject_supplied');
    db.prepare(`
      INSERT INTO contact_facts (id, org_id, contact_id, key, value_ciphertext, confidence, provenance_id, sensitivity, review_state, expires_at,
        created_by, created_at, updated_at, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, contactRow.id, input.key, cx.encryptField(dek, input.value, bindFact(orgId, contactRow.id, id)),
      input.confidence, pid, sensitivity, reviewState, input.expires_at || null, by || null, ts, ts,
      agent ? null : (by || null), agent ? null : ts);
  })();
  return getFactRow(orgId, contactRow.id, id);
}

/** Human edit: any of key/value/confidence/sensitivity/expires_at/review_state. Re-classifies on a key or value change. */
function updateFact(orgId, contactRow, factRow, patch, { by }) {
  const dek = store.dekFor(contactRow);
  if (!dek) throw new store.ContactsqError(409, 'contact_shredded');
  const key = patch.key !== undefined ? patch.key : factRow.key;
  const value = patch.value !== undefined ? patch.value : decryptValue(contactRow, factRow);
  if (value === null) throw new store.ContactsqError(409, 'contact_shredded');
  const sensitivity = effectiveSensitivity(patch.sensitivity !== undefined ? patch.sensitivity : factRow.sensitivity, key, value);
  const ts = store.nowIso();
  const reviewState = patch.review_state !== undefined ? patch.review_state : factRow.review_state;
  const reviewed = patch.review_state !== undefined && patch.review_state !== factRow.review_state;
  store.getDb().prepare(`
    UPDATE contact_facts SET key = ?, value_ciphertext = ?, confidence = ?, sensitivity = ?, review_state = ?, expires_at = ?, updated_at = ?,
      reviewed_by = ?, reviewed_at = ?
    WHERE org_id = ? AND contact_id = ? AND id = ?
  `).run(key, cx.encryptField(dek, value, bindFact(orgId, contactRow.id, factRow.id)),
    patch.confidence !== undefined ? patch.confidence : factRow.confidence, sensitivity, reviewState,
    patch.expires_at !== undefined ? patch.expires_at : factRow.expires_at, ts,
    reviewed ? (by || null) : factRow.reviewed_by, reviewed ? ts : factRow.reviewed_at, orgId, contactRow.id, factRow.id);
  return getFactRow(orgId, contactRow.id, factRow.id);
}

function listFacts(orgId, contactId) {
  return store.getDb().prepare('SELECT * FROM contact_facts WHERE org_id = ? AND contact_id = ? ORDER BY created_at ASC, rowid ASC').all(orgId, contactId);
}

/**
 * The ONLY fact set an agent can ever receive: confirmed, not expired, sensitivity 'normal'.
 * special_category, financial and minor facts never leave through this path.
 */
function agentVisibleFacts(orgId, contactRow, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  return listFacts(orgId, contactRow.id)
    .filter((f) => f.review_state === 'confirmed' && f.sensitivity === 'normal' && (!f.expires_at || f.expires_at > now))
    .map((f) => ({ key: f.key, value: decryptValue(contactRow, f), confidence: f.confidence }))
    .filter((f) => f.value !== null);
}

module.exports = {
  SENSITIVITIES, REVIEW_STATES, MAX_PENDING_PROPOSALS, classify, effectiveSensitivity, rowToFact, summaryOf, decryptValue,
  getFactRow, createFact, updateFact, listFacts, agentVisibleFacts, pendingCount, bindFact,
};

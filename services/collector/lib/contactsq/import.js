'use strict';

/**
 * ContactsQ import (P5): CSV (including the Google Contacts export shape) and
 * vCard 3.0 / 4.0.
 *
 *   parseImport()  bytes -> normalised records (pure, no store access)
 *   planImport()   records -> a report + per-row plan (reads the store, writes nothing)
 *   commitImport() plan -> contacts, identifiers, org links, a contact_imports row
 *
 * Reports carry COUNTS and row numbers only: never a name, address or value.
 * Imported data is provenance source_type import_csv|import_vcard, trust third_party,
 * which starts the Article 14 notice clock (store.noticeDueFor, +30 days).
 * An identifier carrying an erasure tombstone is NEVER recreated: its whole row is skipped.
 * There is no OAuth in this phase: a Google import is the CSV that Google Contacts exports.
 */

const cx = require('./crypto.js');
const store = require('./store.js');
const { normalizeIdentifier, NormalizeError } = require('./normalize.js');
const { normName } = require('./merge.js');
const strictNames = require('./strictNames.js');
const names = require('./names.js');
const photos = require('./photos.js');

const FORMATS = ['csv', 'google_csv', 'vcard'];
const ROLES = ['name', 'first_name', 'last_name', 'middle_name', 'prefix', 'suffix', 'nickname', 'phonetic_given', 'phonetic_family', 'email', 'phone', 'company', 'title', 'notes', 'tags', 'ignore'];
const MAX_ROWS = 20000;
const MAX_COLS = 200;
const MAX_CELL = 20000;

class ImportError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, doubled quotes, embedded newlines, CRLF, BOM)
// ---------------------------------------------------------------------------

function detectDelimiter(text) {
  let inQ = false;
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === '\n' || ch === '\r')) break;
    else if (!inQ && counts[ch] !== undefined) counts[ch] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

function parseCsvText(input) {
  const text = input.replace(/^﻿/, '');
  const d = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  const pushCell = () => { row.push(cell.length > MAX_CELL ? cell.slice(0, MAX_CELL) : cell); cell = ''; };
  const pushRow = () => {
    pushCell();
    if (row.length > MAX_COLS) throw new ImportError('too_many_columns');
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1) throw new ImportError('too_many_rows', 413);
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') inQ = true;
    else if (ch === d) pushCell();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') { if (text[i + 1] === '\n') i += 1; pushRow(); } else cell += ch;
  }
  if (inQ) throw new ImportError('malformed_csv');
  if (cell !== '' || row.length) pushRow();
  return rows;
}

const squash = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const groupOf = (h) => (String(h).match(/\d+/) || ['0'])[0];

const NAME_H = new Set(['name', 'fullname', 'displayname', 'contactname']);
const FIRST_H = new Set(['firstname', 'givenname', 'first', 'forename', 'given']);
const LAST_H = new Set(['lastname', 'familyname', 'surname', 'last', 'family']);
const MIDDLE_H = new Set(['middlename', 'additionalname', 'middle', 'middleinitial']);
// 'title' alone stays the job title (existing behaviour); an honorific-looking VALUE in it is routed to prefix (see addPart).
const PREFIX_H = new Set(['prefix', 'nameprefix', 'honorific', 'honorificprefix', 'salutation']);
const SUFFIX_H = new Set(['suffix', 'namesuffix', 'honorificsuffix', 'generation']);
const NICK_H = new Set(['nickname', 'nick', 'knownas', 'preferredname']);
const PHON_FIRST_H = new Set(['phoneticfirstname', 'phoneticgivenname', 'phoneticfirst']);
const PHON_LAST_H = new Set(['phoneticlastname', 'phoneticfamilyname', 'phoneticlast']);
const HONORIFIC_RE = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|lord|lady|rev|reverend|fr|hon|mister|madam)\.?$/i;
const COMPANY_H = new Set(['company', 'companyname', 'organization', 'organisation', 'organizationname', 'organisationname', 'organization1name', 'organisation1name', 'employer', 'org']);
const TITLE_H = new Set(['title', 'jobtitle', 'organizationtitle', 'organisationtitle', 'organization1title', 'organisation1title', 'position', 'role']);
const NOTES_H = new Set(['notes', 'note', 'comments', 'description']);
const TAGS_H = new Set(['tags', 'labels', 'categories', 'groups', 'group', 'contactgroups']);

/** header text -> { role, labelCol?, hdrLabel?, group? } (label columns are returned as role 'email_label'/'phone_label'). */
function classifyHeader(h) {
  const n = squash(h);
  if (!n) return { role: 'ignore' };
  if (NAME_H.has(n)) return { role: 'name' };
  if (FIRST_H.has(n)) return { role: 'first_name' };
  if (LAST_H.has(n)) return { role: 'last_name' };
  if (MIDDLE_H.has(n)) return { role: 'middle_name' };
  if (PREFIX_H.has(n)) return { role: 'prefix' };
  if (SUFFIX_H.has(n)) return { role: 'suffix' };
  if (NICK_H.has(n)) return { role: 'nickname' };
  if (PHON_FIRST_H.has(n)) return { role: 'phonetic_given' };
  if (PHON_LAST_H.has(n)) return { role: 'phonetic_family' };
  if (COMPANY_H.has(n)) return { role: 'company' };
  if (TITLE_H.has(n)) return { role: 'title' };
  if (NOTES_H.has(n)) return { role: 'notes' };
  if (TAGS_H.has(n)) return { role: 'tags' };
  if (/displayname/.test(n)) return { role: 'ignore' };
  const kind = /^(e?mail|\w*email)/.test(n) ? 'email' : (/phone|mobile|^tel|cell/.test(n) ? 'phone' : null);
  if (kind) {
    if (/(type|label)$/.test(n)) return { role: `${kind}_label`, group: groupOf(h) };
    const hint = ['work', 'home', 'mobile', 'cell', 'business', 'personal', 'other', 'main'].find((w) => n.includes(w)) || null;
    return { role: kind, group: groupOf(h), hdrLabel: hint };
  }
  return { role: 'ignore' };
}

function cleanLabel(v) {
  const s = String(v || '').replace(/^\*\s*/, '').trim().toLowerCase();
  return s ? s.slice(0, 64) : null;
}

function splitMulti(cell) {
  return String(cell || '').split(/\s*:::\s*|\s*;\s*/).map((s) => s.trim()).filter(Boolean);
}

function parseCsvRecords(text, mapping) {
  const grid = parseCsvText(text);
  if (grid.length < 1) throw new ImportError('empty_file');
  // Header row: row 0 unless a few preamble lines come first (LinkedIn Connections.csv): the first row in the
  // opening rows with at least two recognised roles. Falls back to row 0.
  const recognised = (row) => row.filter((h) => classifyHeader(h).role !== 'ignore').length;
  let hdrIdx = 0;
  if (!mapping && recognised(grid[0]) < 2) {
    const found = grid.slice(0, 10).findIndex((row) => recognised(row) >= 2);
    if (found > 0) hdrIdx = found;
  }
  const headers = grid[hdrIdx];
  const hasJobTitle = headers.some((h) => squash(h) === 'jobtitle');
  const cols = headers.map((h) => {
    if (mapping && Object.prototype.hasOwnProperty.call(mapping, h)) {
      const role = mapping[h];
      return role === 'email' || role === 'phone' ? { role, group: groupOf(h), hdrLabel: null } : { role };
    }
    const c = classifyHeader(h);
    // Outlook: "Title" is the honorific (Mr, Dr) when a separate "Job Title" column exists.
    if (hasJobTitle && squash(h) === 'title') return { role: 'prefix', honorificOnly: true };
    return c;
  });
  if (!cols.some((c) => c.role !== 'ignore')) throw new ImportError('no_recognised_columns');
  const labelCol = (role, group) => cols.findIndex((c) => c.role === `${role}_label` && c.group === group);
  const records = [];
  const PART_ROLE = { first_name: 'given', last_name: 'family', middle_name: 'middle', prefix: 'prefix', suffix: 'suffix', nickname: 'nickname', phonetic_given: 'phonetic_given', phonetic_family: 'phonetic_family' };
  for (let r = hdrIdx + 1; r < grid.length; r += 1) {
    const cells = grid[r];
    if (cells.every((c) => !String(c).trim())) continue; // a blank line is not a record
    const rec = { row: r + 1, name: '', first: '', last: '', parts: {}, company: '', title: '', emails: [], phones: [], notes: '', tags: [] };
    cols.forEach((c, idx) => {
      const raw = (cells[idx] || '').trim();
      if (!raw) return;
      switch (c.role) {
        case 'name': rec.name = raw; break;
        case 'first_name': rec.first = raw; rec.parts.given = raw; break;
        case 'last_name': rec.last = raw; rec.parts.family = raw; break;
        case 'prefix':
          if (c.honorificOnly && !HONORIFIC_RE.test(raw)) break;
          rec.parts.prefix = raw; break;
        case 'middle_name': case 'suffix': case 'nickname': case 'phonetic_given': case 'phonetic_family':
          rec.parts[PART_ROLE[c.role]] = raw; break;
        case 'company': rec.company = raw; break;
        case 'title':
          if (HONORIFIC_RE.test(raw) && !rec.parts.prefix) rec.parts.prefix = raw; else rec.title = raw;
          break;
        case 'notes': rec.notes = raw; break;
        case 'tags': rec.tags.push(...splitMulti(raw)); break;
        case 'email':
        case 'phone': {
          const li = labelCol(c.role, c.group);
          const label = cleanLabel(li >= 0 ? cells[li] : null) || c.hdrLabel || null;
          for (const v of splitMulti(raw)) (c.role === 'email' ? rec.emails : rec.phones).push({ v, label });
          break;
        }
        default: break;
      }
    });
    records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------------------
// vCard 3.0 / 4.0 (and tolerant of 2.1)
// ---------------------------------------------------------------------------

function vcardUnescape(v) {
  return String(v).replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function decodeQuotedPrintable(v) {
  try {
    return Buffer.from(String(v).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  } catch { return v; }
}

function splitUnescaped(v, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < v.length; i += 1) {
    if (v[i] === '\\' && i + 1 < v.length) { cur += v[i] + v[i + 1]; i += 1; } else if (v[i] === sep) { out.push(cur); cur = ''; } else cur += v[i];
  }
  out.push(cur);
  return out;
}

const PHOTO_MAX_BYTES = photos.MAX_BYTES;
const LABEL_TYPES = ['work', 'home', 'cell', 'mobile', 'iphone', 'fax', 'other', 'main', 'pager'];

/** Apple X-ABLabel: `_$!<Mobile>!$_` -> mobile, `_$!<HomeFAX>!$_` -> home fax, a custom label -> lowercased as typed. */
function appleLabel(v) {
  const m = String(v || '').match(/^_\$!<(.*)>!\$_$/);
  let s = m ? m[1] : String(v || '');
  if (m) s = s.replace(/(home|work)fax$/i, '$1 fax').replace(/^iphone$/i, 'mobile');
  return cleanLabel(s);
}

/**
 * Logical lines: RFC folds (leading space/tab) are joined, then vCard 2.1 quoted-printable soft breaks (a QP value ending in
 * '=' continues on the next line) and 2.1 bare base64 PHOTO continuations (following lines that are only base64) are joined.
 */
function vcardLines(text) {
  const flat = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  const raw = flat.split('\n');
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    let line = raw[i];
    const colon = line.indexOf(':');
    const head = colon > 0 ? line.slice(0, colon).toUpperCase() : '';
    if (head && /QUOTED-PRINTABLE/.test(head)) {
      while (line.endsWith('=') && i + 1 < raw.length) { i += 1; line = line.slice(0, -1) + raw[i]; }
    } else if (head && /^(?:[A-Z0-9-]+\.)?PHOTO[;]/.test(head) && /(?:ENCODING=)?\b(?:B|BASE64)\b/.test(head)) {
      while (i + 1 < raw.length && /^[A-Za-z0-9+/=\s]+$/.test(raw[i + 1]) && raw[i + 1].trim()) { i += 1; line += raw[i].trim(); }
    }
    out.push(line);
  }
  return out;
}

/** -> Buffer (valid image within the size cap) | 'skipped' (present but unusable) | null (no embedded photo; URLs are never fetched). */
function decodeVcardPhoto(value, params) {
  const v = String(value || '').trim();
  let b64 = null;
  const data = v.match(/^data:image\/[a-z0-9.+-]+;base64,(.*)$/is);
  if (data) b64 = data[1];
  else if (/(?:ENCODING=)?\b(?:B|BASE64)\b/.test(params) && !/^[a-z][a-z0-9+.-]*:/i.test(v)) b64 = v;
  if (b64 === null) return /^[a-z][a-z0-9+.-]*:/i.test(v) ? 'skipped' : null;
  b64 = b64.replace(/\s+/g, '');
  if (!b64 || b64.length > Math.ceil(PHOTO_MAX_BYTES * 4 / 3) + 8) return 'skipped';
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > PHOTO_MAX_BYTES || !photos.sniff(buf)) return 'skipped';
  return buf;
}

function parseVcardRecords(text) {
  const records = [];
  let card = null;
  let groupLabels = {};
  let count = 0;
  for (const line of vcardLines(text)) {
    const t = line.trim();
    if (!t) continue;
    if (/^BEGIN:VCARD$/i.test(t)) {
      count += 1;
      if (count > MAX_ROWS) throw new ImportError('too_many_rows', 413);
      card = { row: count, name: '', first: '', last: '', parts: {}, company: '', title: '', emails: [], phones: [], notes: '', tags: [], org_card: false, photo: null };
      groupLabels = {};
      continue;
    }
    if (/^END:VCARD$/i.test(t)) {
      if (card) {
        // Apple groups: `item1.TEL` takes its label from `item1.X-ABLabel` in the same card.
        for (const it of [...card.emails, ...card.phones]) {
          if (it.group && groupLabels[it.group]) it.label = groupLabels[it.group];
          delete it.group;
        }
        if (card.name || card.first || card.last || Object.keys(card.parts).length || card.company || card.emails.length || card.phones.length || card.notes) records.push(card);
      }
      card = null;
      continue;
    }
    if (!card) continue;
    const colon = t.indexOf(':');
    if (colon < 1) continue;
    const head = t.slice(0, colon);
    let value = t.slice(colon + 1);
    const parts = head.split(';');
    const groupM = parts[0].match(/^([A-Za-z0-9-]+)\./);
    const group = groupM ? groupM[1].toLowerCase() : null;
    const prop = parts[0].replace(/^[A-Za-z0-9-]+\./, '').toUpperCase();
    const params = parts.slice(1).join(';').toUpperCase();
    if (prop === 'PHOTO') {
      const ph = decodeVcardPhoto(value, params);
      if (ph && !card.photo) card.photo = ph;
      continue;
    }
    if (/QUOTED-PRINTABLE/.test(params)) value = decodeQuotedPrintable(value);
    const types = (params.match(/TYPE=([^;]+)/g) || []).flatMap((m) => m.slice(5).split(',')).concat(params.split(';').filter((p) => p && !p.includes('='))).map((x) => x.trim().toLowerCase());
    const typeLabel = types.find((x) => LABEL_TYPES.includes(x));
    const label = typeLabel === 'iphone' ? 'mobile' : (typeLabel || null);
    switch (prop) {
      case 'FN': card.name = vcardUnescape(value).trim(); break;
      case 'X-ABSHOWAS': if (/^company$/i.test(value.trim())) card.org_card = true; break;
      case 'X-ABLABEL': if (group) { const l = appleLabel(vcardUnescape(value)); if (l) groupLabels[group] = l; } break;
      case 'N': {
        const f = splitUnescaped(value, ';').map(vcardUnescape);
        card.last = (f[0] || '').trim(); card.first = (f[1] || '').trim();
        // N = family;given;middle;prefix;suffix
        for (const [k, i] of [['family', 0], ['given', 1], ['middle', 2], ['prefix', 3], ['suffix', 4]]) { const v = (f[i] || '').trim(); if (v) card.parts[k] = v; }
        break;
      }
      case 'NICKNAME': { const v = vcardUnescape(splitUnescaped(value, ',')[0] || '').trim(); if (v) card.parts.nickname = v; break; }
      case 'X-PHONETIC-FIRST-NAME': if (value.trim()) card.parts.phonetic_given = vcardUnescape(value).trim(); break;
      case 'X-PHONETIC-LAST-NAME': if (value.trim()) card.parts.phonetic_family = vcardUnescape(value).trim(); break;
      case 'ORG': card.company = vcardUnescape(splitUnescaped(value, ';')[0] || '').trim(); break;
      case 'TITLE': card.title = vcardUnescape(value).trim(); break;
      case 'EMAIL': if (value.trim()) card.emails.push({ v: vcardUnescape(value).trim(), label, group }); break;
      case 'TEL': if (value.trim()) card.phones.push({ v: vcardUnescape(value).trim().replace(/^tel:/i, ''), label, group }); break;
      case 'NOTE': card.notes = vcardUnescape(value).trim(); break;
      case 'CATEGORIES': card.tags.push(...splitUnescaped(value, ',').map((x) => vcardUnescape(x).trim()).filter(Boolean)); break;
      default: break;
    }
  }
  if (!records.length) throw new ImportError('no_contacts_found');
  return records;
}

/** -> { format: 'csv'|'vcard', source_type, records }. Throws ImportError. */
function parseImport(buffer, { filename, format, mapping } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImportError('empty_file');
  if (format !== undefined && !FORMATS.includes(format)) throw new ImportError('invalid_format');
  if (mapping !== undefined && mapping !== null) {
    if (typeof mapping !== 'object' || Array.isArray(mapping)) throw new ImportError('invalid_mapping');
    for (const [k, v] of Object.entries(mapping)) if (typeof k !== 'string' || !ROLES.includes(v)) throw new ImportError('invalid_mapping');
  }
  const text = buffer.toString('utf8');
  const looksVcard = /^\s*(?:﻿)?BEGIN:VCARD/i.test(text);
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const kind = format === 'vcard' || (!format && (looksVcard || ext === 'vcf' || ext === 'vcard')) ? 'vcard' : 'csv';
  if (kind === 'vcard') {
    if (!looksVcard) throw new ImportError('malformed_vcard');
    return { format: 'vcard', source_type: 'import_vcard', records: parseVcardRecords(text) };
  }
  return { format: 'csv', source_type: 'import_csv', records: parseCsvRecords(text, mapping || null) };
}

// ---------------------------------------------------------------------------
// Plan (dry run) and commit
// ---------------------------------------------------------------------------

const MAX_TAGS = 20;
const MAX_TAG_LEN = 40;

/** normalised real name -> id for live organisations (strict_names rows are decrypted here, never matched on their placeholder). */
function liveOrgNames(db, orgId) {
  return new Map(db.prepare("SELECT * FROM contacts WHERE org_id = ? AND kind = 'organisation' AND status IN ('candidate','active')").all(orgId)
    .map((o) => [normName(strictNames.revealName(orgId, o, o.display_name_ct ? store.dekFor(o) : null)), o.id]));
}

function normOf(channel, value, region) {
  try { return { norm: normalizeIdentifier(channel, value, { region }) }; } catch (e) {
    if (e instanceof NormalizeError) return { error: e.code };
    throw e;
  }
}

/**
 * Build the report and the per-row plan. Writes nothing.
 * report: { rows, would_create, would_merge_into_existing, skipped_tombstoned, skipped_suppressed_marked,
 *           invalid: [{row, code}], duplicates_in_file, organisations_would_create }
 */
function planImport(orgId, parsed) {
  const { default_region: region } = store.getSettings(orgId);
  const report = {
    rows: parsed.records.length, would_create: 0, would_merge_into_existing: 0, skipped_tombstoned: 0,
    skipped_suppressed_marked: 0, invalid: [], duplicates_in_file: 0, organisations_would_create: 0, photos: 0,
  };
  const plan = [];
  const seen = new Map(); // `${channel}|${canonical blind index}` -> plan entry
  const db = store.getDb();
  const orgNames = liveOrgNames(db, orgId);
  const newOrgs = new Set();

  for (const rec of parsed.records) {
    // Structured parts (whitespace collapsed); the display name is derived from them unless the file's own full name differs.
    const rawParts = {};
    for (const [k, v] of Object.entries(rec.parts || {})) { const t = String(v || '').replace(/\s+/g, ' ').trim(); if (t) rawParts[k] = t; }
    // A full-name cell with no given/family columns is split like an old-style display name; other columns (prefix, ...) are kept.
    if (rec.org_card) { for (const k of Object.keys(rawParts)) delete rawParts[k]; } // an Apple organisation card has no person name
    else if (rec.name && !rawParts.given && !rawParts.family) Object.assign(rawParts, Object.fromEntries(Object.entries(names.splitDisplay(rec.name)).filter(([, v]) => v)));
    const pv = names.validateName(rawParts);
    if (!pv.ok) { report.invalid.push({ row: rec.row, code: 'invalid_name' }); continue; }
    const parts = !rec.org_card && names.hasAny(pv.value) ? pv.value : null;
    const derived = parts ? names.deriveDisplay(parts) : '';
    const fullName = rec.name || derived;
    let kind = 'person';
    let displayName = fullName;
    if (rec.org_card) { kind = 'organisation'; displayName = rec.name || rec.company || ''; } else if (!displayName && rec.company) { displayName = rec.company; kind = 'organisation'; }
    if (!displayName) { report.invalid.push({ row: rec.row, code: 'missing_name' }); continue; }
    if (displayName.length > 200) { report.invalid.push({ row: rec.row, code: 'invalid_name' }); continue; }
    const override = parts && !rec.org_card && rec.name && normName(rec.name) !== normName(derived) ? rec.name : null;

    const idents = [];
    for (const [list, channel, code] of [[rec.emails, 'email', 'invalid_email'], [rec.phones, 'phone', 'invalid_phone']]) {
      for (const it of list) {
        const n = normOf(channel, it.v, region);
        if (n.error) { report.invalid.push({ row: rec.row, code }); continue; }
        if (!idents.some((x) => x.norm.channel === channel && x.norm.normalised === n.norm.normalised)) idents.push({ norm: n.norm, label: it.label || null });
      }
    }

    const keys = idents.map((i) => ({ i, key: `${i.norm.channel}|${cx.blindIndex(orgId, i.norm.channel, i.norm.canonical)}` }));
    // Erased identifiers are never recreated: the whole row (it IS that person) is skipped.
    const tomb = idents.some((i) => store.isTombstoned(db, orgId, i.norm.channel,
      cx.blindIndexes(orgId, i.norm.channel, i.norm.normalised), cx.blindIndexes(orgId, i.norm.channel, i.norm.canonical)));
    if (tomb) { report.skipped_tombstoned += 1; continue; }

    const dupOf = keys.map((k) => seen.get(k.key)).find(Boolean);
    const tags = [...new Set(rec.tags.map((t) => t.slice(0, MAX_TAG_LEN)).filter(Boolean))].slice(0, MAX_TAGS);
    const company = kind === 'person' ? rec.company : '';
    const entry = {
      row: rec.row, kind, display_name: displayName, name: kind === 'person' ? parts : null, display_name_override: kind === 'person' ? override : null, notes: rec.notes || '', tags, company, title: rec.title ? rec.title.slice(0, 100) : '',
      idents, existing_id: null, folded_into: null, flags: [], photo: Buffer.isBuffer(rec.photo) ? rec.photo : null, photo_skipped: rec.photo === 'skipped',
    };
    if (dupOf) {
      report.duplicates_in_file += 1;
      entry.folded_into = dupOf;
      for (const k of keys) if (!seen.has(k.key)) seen.set(k.key, dupOf);
      dupOf.idents.push(...idents.filter((i) => !dupOf.idents.some((x) => x.norm.channel === i.norm.channel && x.norm.normalised === i.norm.normalised)));
      plan.push(entry);
      continue;
    }
    for (const k of keys) seen.set(k.key, entry);

    // Same blind index as an existing contact (email via its canonical twin).
    for (const i of idents) {
      const hit = store.findContactByIdentifier(orgId, i.norm).contact;
      if (hit) { entry.existing_id = hit.id; break; }
    }
    const sup = idents.map((i) => store.checkSuppression(orgId, i.norm)).filter((s) => s.suppressed);
    if (sup.length) {
      report.skipped_suppressed_marked += 1;
      const reasons = new Set(sup.flatMap((s) => s.reasons));
      if (reasons.has('dnc')) {
        if (idents.some((i) => i.norm.channel === 'phone')) entry.flags.push('do_not_call');
        if (idents.some((i) => i.norm.channel === 'email')) entry.flags.push('do_not_email');
      }
      if (reasons.has('do_not_market')) entry.flags.push('do_not_market');
    }
    let orgCardMerge = false;
    if (kind === 'organisation' && !entry.existing_id) {
      const k = normName(displayName);
      if (orgNames.has(k)) { entry.existing_id = orgNames.get(k); } else if (newOrgs.has(k)) orgCardMerge = true; else newOrgs.add(k);
    }
    if (entry.photo) report.photos += 1;
    if (entry.existing_id || orgCardMerge) report.would_merge_into_existing += 1; else report.would_create += 1;
    if (company && !orgNames.has(normName(company)) && !newOrgs.has(normName(company))) { newOrgs.add(normName(company)); report.organisations_would_create += 1; }
    plan.push(entry);
  }
  return { report, plan };
}

function insertImportProvenance(db, orgId, contactId, sourceType, importId, by) {
  const id = store.gid('cp');
  db.prepare(`
    INSERT INTO contact_provenance (id, org_id, contact_id, source_type, source_ref, captured_by, captured_at, trust)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'third_party')
  `).run(id, orgId, contactId, sourceType, `import:${importId}`, by || null, store.nowIso());
  return id;
}

/** Write the plan. Each row is its own savepoint: one failing row never poisons the run. */
function commitImport(orgId, parsed, planned, { by } = {}) {
  const db = store.getDb();
  const importId = store.gid('im');
  const prov = () => ({ source_type: parsed.source_type, source_ref: `import:${importId}`, trust: 'third_party', captured_by: by || null });
  const out = {
    created: 0, merged_into_existing: 0, organisations_created: 0, identifiers_added: 0, links_added: 0, row_errors: [],
    skipped_tombstoned: planned.report.skipped_tombstoned, skipped_suppressed_marked: planned.report.skipped_suppressed_marked,
    duplicates_in_file: planned.report.duplicates_in_file, invalid: planned.report.invalid, photos: 0, photos_skipped: 0,
  };
  const orgByName = liveOrgNames(db, orgId);
  const created = new Map(); // plan entry -> contact id (so folded duplicate rows land on their first row's contact)
  const rowContacts = new Map(); // record row -> contact id (sync links each card back to the contact it landed on)

  const addIdents = (contactId, idents) => {
    if (!idents.length) return;
    const pid = insertImportProvenance(db, orgId, contactId, parsed.source_type, importId, by);
    for (const it of idents) {
      try {
        const r = store.addIdentifier(orgId, contactId, it.norm, { label: it.label, provenanceId: pid });
        if (r.created) out.identifiers_added += 1;
      } catch (e) {
        if (!(e instanceof store.ContactsqError && (e.code === 'identifier_in_use' || e.code === 'identifier_erased'))) throw e;
      }
    }
  };

  const linkCompany = (personRow, e) => {
    if (!e.company) return;
    const key = normName(e.company);
    let orgId2 = orgByName.get(key);
    if (!orgId2) {
      const { contact } = store.createContact(orgId, { display_name: e.company.slice(0, 200), kind: 'organisation', status: 'active', created_by: by || null, provenance: prov() });
      orgId2 = contact.id;
      orgByName.set(key, orgId2);
      out.organisations_created += 1;
    }
    const orgRow = store.getContactRow(orgId, orgId2);
    if (!orgRow || store.findEdge(orgId, personRow.id, orgRow.id, 'works_at')) return;
    store.addEdge(orgId, personRow, orgRow, { type: 'works_at', attrs: e.title ? { role: e.title } : {}, created_by: by || null });
    out.links_added += 1;
  };

  // Photos only on commit, through the encrypted photo path (size and type re-validated there). Never fetched from a URL.
  const storePhoto = (contactId, e) => {
    if (e.photo_skipped) { out.photos_skipped += 1; return; }
    if (!e.photo) return;
    const row = store.getContactRow(orgId, contactId);
    const mime = photos.sniff(e.photo);
    if (!row || row.photo_at || !mime || e.photo.length > photos.MAX_BYTES) { if (row && !row.photo_at) out.photos_skipped += 1; return; }
    photos.putPhoto(orgId, row, e.photo, mime);
    out.photos += 1;
  };

  const mergeTags = (contactId, tags) => {
    if (!tags.length) return;
    const row = store.getContactRow(orgId, contactId);
    const cur = store.parseJson(row.tags_json, []);
    const next = [...new Set([...cur, ...tags])].slice(0, 50);
    if (next.length !== cur.length) store.updateContact(orgId, contactId, { tags: next });
  };

  for (const e of planned.plan) {
    try {
      db.transaction(() => {
        if (e.folded_into) {
          const target = created.get(e.folded_into);
          if (target) { addIdents(target, e.idents); rowContacts.set(e.row, target); }
          return;
        }
        if (!e.existing_id && e.kind === 'organisation' && orgByName.has(normName(e.display_name))) e.existing_id = orgByName.get(normName(e.display_name));
        if (e.existing_id) {
          addIdents(e.existing_id, e.idents);
          storePhoto(e.existing_id, e);
          mergeTags(e.existing_id, e.tags);
          if (e.flags.length) {
            const row = store.getContactRow(orgId, e.existing_id);
            store.updateContact(orgId, e.existing_id, { flags: [...new Set([...store.parseJson(row.flags_json, []), ...e.flags])] });
          }
          if (e.kind === 'person') linkCompany(store.getContactRow(orgId, e.existing_id), e);
          created.set(e, e.existing_id);
          rowContacts.set(e.row, e.existing_id);
          out.merged_into_existing += 1;
          return;
        }
        const { contact, added } = store.createContact(orgId, {
          display_name: e.display_name, name: e.name || undefined, display_name_override: e.display_name_override || undefined, kind: e.kind, status: 'active', notes: e.notes || undefined, flags: e.flags,
          identifiers: e.idents.map((i, n) => ({ norm: i.norm, label: i.label, is_primary: n === 0 })), created_by: by || null, provenance: prov(),
        });
        out.identifiers_added += added.filter((a) => a.created).length;
        mergeTags(contact.id, e.tags);
        storePhoto(contact.id, e);
        if (e.kind === 'person') linkCompany(contact, e);
        if (e.kind === 'organisation') orgByName.set(normName(e.display_name), contact.id);
        created.set(e, contact.id);
        rowContacts.set(e.row, contact.id);
        out.created += 1;
      })();
    } catch (err) {
      // A row that cannot be written (for example an identifier claimed by a concurrent writer) is reported by number and code.
      out.row_errors.push({ row: e.row, code: err instanceof store.ContactsqError ? err.code : 'row_failed' });
      if (!(err instanceof store.ContactsqError)) console.error('[contactsq] import row failed:', err && err.message);
    }
  }

  const counts = {
    rows: planned.report.rows, created: out.created, merged_into_existing: out.merged_into_existing, organisations_created: out.organisations_created,
    identifiers_added: out.identifiers_added, skipped_tombstoned: out.skipped_tombstoned, skipped_suppressed_marked: out.skipped_suppressed_marked,
    invalid: out.invalid.length, duplicates_in_file: out.duplicates_in_file, row_errors: out.row_errors.length, photos: out.photos, photos_skipped: out.photos_skipped,
  };
  db.prepare('INSERT INTO contact_imports (id, org_id, format, counts_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(importId, orgId, parsed.format, JSON.stringify(counts), by || null, store.nowIso());
  return { import_id: importId, counts, report: out, row_contacts: rowContacts };
}

function listImports(orgId, limit = 50) {
  return store.getDb().prepare('SELECT * FROM contact_imports WHERE org_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(orgId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200))
    .map((r) => ({ id: r.id, format: r.format, counts: store.parseJson(r.counts_json, {}), created_by: r.created_by || null, created_at: r.created_at }));
}

module.exports = { FORMATS, ROLES, ImportError, parseImport, parseVcardRecords, planImport, commitImport, listImports, classifyHeader, parseCsvText };

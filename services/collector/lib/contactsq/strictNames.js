'use strict';

/**
 * ContactsQ strict_names (plan 4.3). When the org setting is on:
 *   - display_name holds a placeholder ('Contact ' + short id); the real name lives in
 *     display_name_ct as a v2 ciphertext under the contact DEK (binding 'display_name')
 *   - name search uses ONLY per-org HMACs of each exact name word (contact_name_bi);
 *     no plaintext word tokens, no phonetic keys are stored
 *   - agents and services see the placeholder; only HUMAN callers get the real name
 *     (revealName is called by the api layer for human actors only)
 *   - greeting_name never derives from the name (only from preferred_name)
 *
 * This module is DB-agnostic at load time (store.js requires it); anything that needs the
 * store requires it lazily.
 */

const cx = require('./crypto.js');
const { words: nameWords } = require('./phonetic.js');
const names = require('./names.js');

const NAME_FIELD = 'display_name';

function placeholderFor(contactId) {
  return `Contact ${String(contactId).slice(-6)}`;
}

/** Columns for a protected name: { display_name, sort_name, display_name_ct }. */
function protectedColumns(orgId, contactId, dek, realName) {
  const ph = placeholderFor(contactId);
  return {
    display_name: ph,
    sort_name: ph.toLowerCase(),
    display_name_ct: cx.encryptField(dek, realName, { orgId, contactId, field: NAME_FIELD }),
  };
}

const NAME_COLS = [...names.PARTS.map((p) => `name_${p}`), 'display_name_override', 'name_ct_json'];
const OVERRIDE_KEY = 'display_name_override';
const partBind = (orgId, contactId, key) => ({ orgId, contactId, field: `name:${key}` });

/**
 * Every name column for one contact, in the mode the org is in. Plain: parts in name_* columns. Strict: name_* are NULL,
 * every part (and the override) is its own v2 ciphertext (binding 'name:<part>') inside name_ct_json, and display_name is
 * the placeholder with the real display name in display_name_ct. Organisations carry no parts.
 */
function nameColumns(orgId, contactId, dek, strict, { kind, parts, override, display }) {
  const person = kind !== 'organisation';
  const p = person ? { ...names.emptyParts(), ...(parts || {}) } : names.emptyParts();
  const ov = person ? (override || null) : null;
  const cols = { names_v: 1 };
  for (const k of NAME_COLS) cols[k] = null;
  if (!strict) {
    Object.assign(cols, { display_name: display, sort_name: names.sortNameFor(p, display), display_name_ct: null });
    if (person) { for (const k of names.PARTS) cols[`name_${k}`] = p[k]; cols.display_name_override = ov; }
    return cols;
  }
  Object.assign(cols, protectedColumns(orgId, contactId, dek, display));
  if (person) {
    const ct = {};
    for (const k of names.PARTS) if (p[k]) ct[k] = cx.encryptField(dek, p[k], partBind(orgId, contactId, k));
    if (ov) ct[OVERRIDE_KEY] = cx.encryptField(dek, ov, partBind(orgId, contactId, OVERRIDE_KEY));
    cols.name_ct_json = Object.keys(ct).length ? JSON.stringify(ct) : null;
  }
  return cols;
}

/** The stored parts + override of a row (strict rows decrypt with the DEK; null dek / failure -> empty). */
function readName(orgId, row, dek) {
  const parts = names.emptyParts();
  let override = null;
  if (!row || row.kind === 'organisation') return { parts, override };
  if (row.name_ct_json) {
    let ct = {};
    try { ct = JSON.parse(row.name_ct_json) || {}; } catch { ct = {}; }
    if (dek) {
      for (const k of names.PARTS) {
        if (!ct[k]) continue;
        try { parts[k] = cx.decryptField(dek, ct[k], partBind(orgId, row.id, k)); } catch { /* leave null */ }
      }
      if (ct[OVERRIDE_KEY]) { try { override = cx.decryptField(dek, ct[OVERRIDE_KEY], partBind(orgId, row.id, OVERRIDE_KEY)); } catch { /* leave null */ } }
    }
    return { parts, override };
  }
  for (const k of names.PARTS) parts[k] = row[`name_${k}`] || null;
  override = row.display_name_override || null;
  return { parts, override };
}

/** The real text whose words feed this row's search tokens (display + given/middle/family/nickname + override). */
function searchTextFor(orgId, row, dek) {
  const display = revealName(orgId, row, dek);
  const { parts, override } = readName(orgId, row, dek);
  return names.searchText(parts, display, override);
}

/** UPDATE contacts with a column map from nameColumns. */
function writeColumns(db, orgId, contactId, cols, ts) {
  const keys = Object.keys(cols);
  db.prepare(`UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`)
    .run(...keys.map((k) => cols[k]), ts, contactId, orgId);
}

/** The distinct exact-word HMACs for a name under the CURRENT key. */
function blindTokensFor(orgId, realName) {
  return [...new Set(nameWords(realName))].map((w) => cx.nameIndex(orgId, w));
}

/** Replace a contact's blind name tokens and remove its plain/phonetic tokens. */
function writeBlindTokens(db, orgId, contactId, realName) {
  db.prepare('DELETE FROM contact_name_tokens WHERE org_id = ? AND contact_id = ?').run(orgId, contactId);
  db.prepare('DELETE FROM contact_name_bi WHERE org_id = ? AND contact_id = ?').run(orgId, contactId);
  const ins = db.prepare('INSERT INTO contact_name_bi (contact_id, org_id, token) VALUES (?, ?, ?)');
  const seen = new Set();
  for (const w of nameWords(realName)) {
    if (seen.has(w)) continue;
    seen.add(w);
    ins.run(contactId, orgId, cx.nameIndex(orgId, w));
  }
}

function clearBlindTokens(db, orgId, contactId) {
  return db.prepare('DELETE FROM contact_name_bi WHERE org_id = ? AND contact_id = ?').run(orgId, contactId).changes;
}

/** The real name for a protected row (HUMAN callers only; the api enforces that), else the stored name. */
function revealName(orgId, row, dek) {
  if (!row || !row.display_name_ct) return row ? row.display_name : null;
  if (!dek) return row.display_name;
  try { return cx.decryptField(dek, row.display_name_ct, { orgId, contactId: row.id, field: NAME_FIELD }); } catch { return row.display_name; }
}

/**
 * Migrate one org to the CURRENT strict_names setting, both directions. Idempotent, counted.
 * -> { strict_names, converted, already_current, shredded, failed, failed_ids }
 */
function applyForOrg(orgId) {
  const store = require('./store.js');
  const db = store.getDb();
  const strict = store.getSettings(orgId).strict_names;
  const counts = { converted: 0, already_current: 0, shredded: 0, failed: 0 };
  const failedIds = [];
  let after = '';
  for (;;) {
    const rows = db.prepare("SELECT * FROM contacts WHERE org_id = ? AND id > ? AND status != 'erased' ORDER BY id LIMIT 200").all(orgId, after);
    if (!rows.length) break;
    for (const c of rows) {
      after = c.id;
      const protectedNow = Boolean(c.display_name_ct);
      if (protectedNow === strict) { counts.already_current += 1; continue; }
      const dek = store.dekFor(c);
      if (!dek) { counts.shredded += 1; continue; }
      try {
        db.transaction(() => {
          const display = protectedNow ? cx.decryptField(dek, c.display_name_ct, { orgId, contactId: c.id, field: NAME_FIELD }) : c.display_name;
          const { parts, override } = readName(orgId, c, dek);
          const cols = nameColumns(orgId, c.id, dek, strict, { kind: c.kind, parts, override, display });
          writeColumns(db, orgId, c.id, cols, store.nowIso());
          const text = names.searchText(parts, display, override);
          if (strict) writeBlindTokens(db, orgId, c.id, text);
          else { clearBlindTokens(db, orgId, c.id); store.writeNameTokens(db, orgId, c.id, text); }
        })();
        counts.converted += 1;
      } catch (e) {
        counts.failed += 1;
        if (failedIds.length < 100) failedIds.push(c.id);
      }
    }
  }
  return { strict_names: strict, ...counts, failed_ids: failedIds };
}

module.exports = { NAME_COLS, nameColumns, readName, searchTextFor, writeColumns, NAME_FIELD, placeholderFor, blindTokensFor, protectedColumns, writeBlindTokens, clearBlindTokens, revealName, applyForOrg };

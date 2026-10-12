'use strict';

/**
 * ContactsQ search (plan 4.3): ranked name search over plain name tokens and
 * phonetic keys. Read-only. Org filter on every query. Never returns a value.
 *
 * Confidence: exact full name 0.95, every query word an exact name word 0.8,
 * every query word a name-word prefix 0.65, phonetic-only 0.6; multiplied by
 * the fraction of query words matched. org_hint adds up to +0.2, recency up
 * to +0.05. ambiguous when the top two are within 0.15 or the top is < 0.6.
 */

const store = require('./store.js');
const cx = require('./crypto.js');
const { phoneticKey, words } = require('./phonetic.js');
const { toCard } = require('./projections.js');

const BASE = { exact: 0.95, token: 0.8, prefix: 0.65, phonetic: 0.6 };
const RANK = { exact: 4, token: 3, prefix: 2, phonetic: 1 };

function search(orgId, { q, org_hint, limit } = {}) {
  const qWords = words(q);
  if (!qWords.length) return { candidates: [], ambiguous: false };
  const db = store.getDb();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 25);

  const ids = new Set();
  const byTok = db.prepare('SELECT DISTINCT contact_id FROM contact_name_tokens WHERE org_id = ? AND token = ?');
  const byPrefix = db.prepare("SELECT DISTINCT contact_id FROM contact_name_tokens WHERE org_id = ? AND kind = 'word' AND token LIKE ? ESCAPE '\\'");
  for (const w of qWords) {
    for (const r of byTok.all(orgId, w)) ids.add(r.contact_id);
    for (const r of byTok.all(orgId, phoneticKey(w))) ids.add(r.contact_id);
    for (const r of byPrefix.all(orgId, `${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)) ids.add(r.contact_id);
  }
  // strict_names contacts: exact word match on per-org name HMACs only (no prefix, no phonetic).
  const biByTok = [];
  for (const w of qWords) biByTok.push(cx.nameIndexes(orgId, w));
  const blindHits = db.prepare('SELECT DISTINCT contact_id FROM contact_name_bi WHERE org_id = ? AND token = ?');
  for (const hs of biByTok) for (const h of hs) for (const r of blindHits.all(orgId, h)) ids.add(r.contact_id);
  const blindToks = db.prepare('SELECT token FROM contact_name_bi WHERE org_id = ? AND contact_id = ?');
  const tokQ = db.prepare('SELECT token, kind FROM contact_name_tokens WHERE org_id = ? AND contact_id = ?');
  const hint = typeof org_hint === 'string' ? org_hint.trim().toLowerCase() : '';
  const qFull = qWords.join(' ');
  const now = Date.now();
  const scored = [];
  for (const id of ids) {
    const row = store.getContactRow(orgId, id);
    if (!row || !['active'].includes(row.status)) continue;
    if (row.display_name_ct) {
      const have = new Set(blindToks.all(orgId, id).map((t) => t.token));
      const matchedWords = biByTok.filter((hs) => hs.some((h) => have.has(h))).length;
      if (!matchedWords) continue;
      const exactAll = matchedWords === qWords.length && have.size === qWords.length;
      let c = (exactAll ? BASE.exact : BASE.token) * (matchedWords / qWords.length);
      if (row.last_touchpoint_at) {
        const ageDays = (now - Date.parse(row.last_touchpoint_at)) / 86400000;
        if (ageDays >= 0 && ageDays < 30) c += 0.05 * (1 - ageDays / 30);
      }
      c = Math.min(1, c);
      if (c >= 0.3) scored.push({ row, conf: c, match: exactAll ? 'exact' : 'token' });
      continue;
    }
    const toks = tokQ.all(orgId, id);
    const wordToks = toks.filter((t) => t.kind === 'word').map((t) => t.token);
    const phon = new Set(toks.filter((t) => t.kind === 'phonetic').map((t) => t.token));
    let matched = 0;
    let weakest = null;
    for (const w of qWords) {
      let m = null;
      if (wordToks.includes(w)) m = 'token';
      else if (wordToks.some((t) => t.startsWith(w))) m = 'prefix';
      else if (phon.has(phoneticKey(w))) m = 'phonetic';
      if (m) { matched += 1; if (!weakest || RANK[m] < RANK[weakest]) weakest = m; }
    }
    if (!matched) continue;
    const full = words(row.display_name).join(' ') === qFull;
    const match = full ? 'exact' : weakest;
    let conf = BASE[match] * (matched / qWords.length);
    if (hint) {
      // primary org plus every current works_at employer (P3 graph)
      const orgs = store.worksAtOrgs(orgId, row.id);
      if (row.primary_org_contact_id) {
        const primary = store.getContactRow(orgId, row.primary_org_contact_id);
        if (primary) orgs.push(primary);
      }
      if (orgs.some((o) => o.display_name.toLowerCase().includes(hint))) conf += 0.2;
    }
    if (row.last_touchpoint_at) {
      const ageDays = (now - Date.parse(row.last_touchpoint_at)) / 86400000;
      if (ageDays >= 0 && ageDays < 30) conf += 0.05 * (1 - ageDays / 30);
    }
    conf = Math.min(1, conf);
    if (conf < 0.3) continue;
    scored.push({ row, conf, match });
  }
  scored.sort((a, b) => b.conf - a.conf || a.row.sort_name.localeCompare(b.row.sort_name));
  const top = scored.slice(0, lim);
  const candidates = top.map((s) => ({ ...toCard(orgId, s.row), confidence: Math.round(s.conf * 1000) / 1000, match: s.match }));
  const ambiguous = candidates.length > 0 && (candidates[0].confidence < 0.6 || (candidates.length > 1 && candidates[0].confidence - candidates[1].confidence < 0.15));
  const out = { candidates, ambiguous };
  if (ambiguous) out.hint = 'More than one plausible match (or a weak one). Ask the human which contact they mean (by organisation or relationship) before acting; do not guess.';
  return out;
}

module.exports = { search };

'use strict';
/**
 * #817 / #818: post-hoc grounding check for a governed agent answer.
 *
 * The prompt contract says commands, ids, counts and ages come from tool results. This
 * is the check that does not trust the model to have obeyed it. After the tool loop
 * finishes, the answer is compared with the EVIDENCE of the turn (every tool result, the
 * user's own words, the conversation and context the model was given):
 *
 *  - a `quox <verb> [<sub>]` mention that is not in the real command tree
 *    (config/cliCommandTree.json, generated from the CLI's own --help by
 *    cli/scripts/export-command-tree.mjs) is an invented command;
 *  - an id shaped like a stream / record id (AQ-9E, ORG-EX, SGR_5cd315bc) that appears
 *    nowhere in the evidence is unverified;
 *  - a count ("63 skills", "five skills in total") or an age ("46 days old") whose number
 *    appears nowhere in the evidence (ages: and no evidence timestamp is that old) is
 *    unverified.
 *
 * Nothing is rewritten: the answer has already streamed. The caller appends the note so
 * the reader sees which parts were not backed by a tool, and records the flags.
 * Deterministic and pure apart from loading the tree once.
 */
const path = require('path');
const fs = require('fs');

let _tree = null;
function loadCommandTree() {
  if (_tree) return _tree;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'cliCommandTree.json'), 'utf8'));
    _tree = raw && raw.commands && typeof raw.commands === 'object' ? raw.commands : null;
  } catch { _tree = null; }
  return _tree;
}

// Global flags that take a value (`quox -p moo inbox ...`).
const VALUE_FLAGS = new Set(['-p', '--profile', '-o', '--output', '--agent', '--org', '--model', '--provider']);
const WORD = /^[a-z][a-z0-9-]*$/;

/** -> [{ mention, reason }] for every `quox ...` mention not in the tree. */
function findInventedCommands(answer, tree = loadCommandTree(), evidence = '') {
  if (!tree) return [];
  // A `quox <word> <word>` phrase the turn's own tool output contains is QUOTED tool text, not a command the model
  // invented (journey story-a 2026-10-17: the approval gate's "quox proposed this action; a human must confirm").
  const ev = String(evidence || '').toLowerCase();
  const out = [];
  const seen = new Set();
  const re = /(?:^|[\s`'"(*])quox((?:[ \t]+[^\s`'")*]+){1,6})/g;
  let m;
  while ((m = re.exec(String(answer || ''))) !== null) {
    const toks = m[1].trim().split(/[ \t]+/);
    let i = 0;
    while (i < toks.length && toks[i].startsWith('-')) { i += VALUE_FLAGS.has(toks[i]) ? 2 : 1; }
    const verb = toks[i];
    if (!verb || !WORD.test(verb)) continue;
    let mention = `quox ${verb}`;
    let reason = null;
    if (!Object.prototype.hasOwnProperty.call(tree, verb)) reason = 'not a quox command';
    else {
      const subs = Array.isArray(tree[verb]) ? tree[verb] : [];
      const sub = toks[i + 1];
      if (subs.length && sub && WORD.test(sub) && !subs.includes(sub)) { mention = `quox ${verb} ${sub}`; reason = `${verb} has no "${sub}" subcommand`; }
    }
    const phrase = ['quox', ...toks.slice(i, i + 2)].join(' ').toLowerCase();
    if (reason && ev && ev.includes(phrase)) reason = null;
    if (reason && !seen.has(mention)) { seen.add(mention); out.push({ mention, reason }); }
  }
  return out;
}

// Stream / record ids: AQ-9E, ORG-EX, QUOX-VOICE-OUTBOUND, SGR_5cd315bc, QXC_0b70b794.
const ID_RE = /\b(?:[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]{1,})+|[A-Z]{2,6}_[A-Za-z0-9]{6,})\b/g;
// Hyphenated all-caps words that are vocabulary, not record ids.
const ID_VOCAB = new Set(['E-STOP', 'X-SERVICE-KEY', 'TLS-1', 'UTF-8', 'SHA-256', 'AES-256', 'ED-25519', 'CVE-ID', 'HTTP-403', 'COVID-19', 'B2B-SAAS']);

function inEvidence(evidenceLower, token) { return evidenceLower.includes(String(token).toLowerCase()); }

/** -> ids in the answer that appear nowhere in the evidence. */
function findUngroundedIds(answer, evidence) {
  const ev = String(evidence || '').toLowerCase();
  const out = [];
  for (const id of new Set(String(answer || '').match(ID_RE) || [])) {
    if (ID_VOCAB.has(id) || /^[A-Z]+-\d{4}-\d/.test(id)) continue; // vocabulary, CVE-2024-1234-style
    if (!/[A-Z]{2}/.test(id)) continue;
    if (!inEvidence(ev, id)) out.push(id);
  }
  return out;
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const NUM = '(\\d[\\d,]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
const COUNT_NOUNS = 'skills?|agents?|specialists?|envelopes?|events?|entries|grants?|tools?|memories|memory items|hosts?|streams?|approvals?|messages?|emails?|crawls?|urls?|receipts?|notes?|incidents?|workflows?|phases?';
const COUNT_RE = new RegExp(`\\b${NUM}\\s+(?:[a-z-]+\\s+){0,2}?(?:${COUNT_NOUNS})\\b`, 'gi');
const AGE_RE = new RegExp(`\\b${NUM}\\s+(minutes?|hours?|days?|weeks?|months?)\\s+(?:old|ago|stale|overdue|waiting|pending|outstanding)\\b`, 'gi');
const UNIT_MS = { minute: 60e3, hour: 3600e3, day: 864e5, week: 6048e5, month: 2592e6 };

function toNum(s) { const k = String(s).toLowerCase(); return Object.prototype.hasOwnProperty.call(WORD_NUM, k) ? WORD_NUM[k] : Number(String(s).replace(/,/g, '')); }
function numberInEvidence(evidence, n) {
  if (!Number.isFinite(n)) return true;
  const re = new RegExp(`(?<![\\d.])${n}(?![\\d])|(?<![\\d.])${n.toLocaleString('en-US')}(?![\\d])`);
  return re.test(String(evidence || ''));
}
function evidenceAgesMs(evidence, nowMs) {
  const out = [];
  for (const d of String(evidence || '').match(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g) || []) {
    const t = Date.parse(d);
    if (Number.isFinite(t)) out.push(nowMs - t);
  }
  return out;
}

/** -> counts / ages in the answer that no evidence backs. */
function findUngroundedQuantities(answer, evidence, { now = Date.now() } = {}) {
  const text = String(answer || '');
  const out = [];
  let m;
  COUNT_RE.lastIndex = 0;
  while ((m = COUNT_RE.exec(text)) !== null) {
    const n = toNum(m[1]);
    if (n <= 1) continue; // "one agent" is phrasing, not a census
    if (!numberInEvidence(evidence, n)) out.push(m[0]);
  }
  const ages = evidenceAgesMs(evidence, now);
  AGE_RE.lastIndex = 0;
  while ((m = AGE_RE.exec(text)) !== null) {
    const n = toNum(m[1]);
    const unit = UNIT_MS[m[2].toLowerCase().replace(/s$/, '')];
    const claimed = n * unit;
    const backed = numberInEvidence(evidence, n) || ages.some((a) => Math.abs(a - claimed) <= Math.max(unit, claimed * 0.1));
    if (!backed) out.push(m[0]);
  }
  return [...new Set(out)];
}

/**
 * -> { flags: { commands, ids, quantities }, note } ; note is '' when nothing is flagged.
 */
function checkAnswerGrounding({ answer, evidence, tree, now } = {}) {
  const commands = findInventedCommands(answer, tree === undefined ? loadCommandTree() : tree, evidence);
  const ids = findUngroundedIds(answer, evidence);
  const quantities = findUngroundedQuantities(answer, evidence, { now });
  const parts = [];
  if (commands.length) parts.push(`not a real command: ${commands.map((c) => `\`${c.mention}\``).join(', ')}`);
  const unverified = [...ids, ...quantities.map((q) => `"${q}"`)];
  if (unverified.length) parts.push(`not returned by any tool this turn: ${unverified.join(', ')}`);
  const note = parts.length ? `\n\n_Grounding check: ${parts.join('; ')}. Treat these as unverified._` : '';
  return { flags: { commands, ids, quantities }, note };
}

module.exports = { checkAnswerGrounding, findInventedCommands, findUngroundedIds, findUngroundedQuantities, loadCommandTree };

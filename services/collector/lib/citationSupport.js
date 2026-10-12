'use strict';
// citationSupport.js — BRAIN2-W2 2: cheap, deterministic LEXICAL support check.
// "Cited" means the answer carries a [B1] handle; "supported" means the
// sentence(s) carrying it share enough content words (stemmed, non-stopword)
// with the cited passage. This is NOT semantic proof: a fluent wrong claim
// reusing the passage's words would pass, a heavy paraphrase may fail.

const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its may might more most no not of on or our she should so some such than that the their them then there these they this those to was we were what when where which who will with would you your yes also just about after before over under up out per via each any all both too very').split(/\s+/));

const MIN_MATCHED = 2;     // at least this many claim words must be found in the passage
const MIN_RATIO = 0.5;     // and at least this share of the claim's content words

function stem(w) {
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  for (const suf of ['ing', 'ed', 'er', 'ly']) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

function contentWords(text) {
  const out = new Set();
  const cleaned = String(text || '').replace(/\[[^[\]]{1,200}\]/g, ' ').toLowerCase();
  for (const t of cleaned.match(/[a-z0-9]+/g) || []) {
    if (STOP.has(t)) continue;
    if (t.length < 3 && !/^\d+$/.test(t)) continue;
    out.add(stem(t));
  }
  return out;
}

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Sentences of `answer` that contain the bracketed handle (whole token). */
function sentencesCiting(answer, handle) {
  const h = String(handle || '').toLowerCase();
  if (!h) return [];
  return splitSentences(answer).filter((sent) => {
    const groups = sent.toLowerCase().match(/\[[^[\]]{1,200}\]/g) || [];
    return groups.some((g) => g.slice(1, -1).split(/[^a-z0-9]+/).includes(h));
  });
}

const NEG_RE = /\b(?:not|no|never|cannot|without|neither|nor|none)\b|\b\w+n['\u2019]t\b/gi;

/** Negation polarity of a clause: true when it carries an odd number of negators. */
function isNegated(text) {
  const t = String(text || '').replace(/\[[^[\]]{1,200}\]/g, ' ');
  return ((t.match(NEG_RE) || []).length % 2) === 1;
}

function numbersOf(text) {
  const t = String(text || '').replace(/\[[^[\]]{1,200}\]/g, ' ');
  return new Set((t.match(/\d+(?:[.,]\d+)*/g) || []).map((n) => n.replace(/,/g, '')));
}

/** Capitalised tokens (candidate names); the sentence-initial word is skipped unless it is not a stopword. */
function namesOf(text) {
  const t = String(text || '').replace(/\[[^[\]]{1,200}\]/g, ' ');
  const out = new Set();
  for (const m of t.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    if (STOP.has(m[0].toLowerCase())) continue;
    out.add(stem(m[0].toLowerCase()));
  }
  return out;
}

// Codex cycle 4: same words, swapped roles ("Bob manages Alice" vs "Alice
// manages Bob") is a different claim. Two or more shared names appearing in a
// different order is a reversal, unless either sentence is passive ("is
// managed by"), which legitimately flips the order. Heuristic, not semantics.
const PASSIVE = /\b(is|are|was|were|been|being|be)\s+\w+(ed|en)\s+by\b/i;
function nameOrder(text) {
  const t = String(text || '').replace(/\[[^[\]]{1,200}\]/g, ' ');
  const out = [];
  for (const m of t.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const n = stem(m[0].toLowerCase());
    if (!STOP.has(m[0].toLowerCase()) && !out.includes(n)) out.push(n);
  }
  return out;
}
function rolesReversed(claim, sentence) {
  if (PASSIVE.test(claim) || PASSIVE.test(sentence)) return false;
  const a = nameOrder(claim), b = nameOrder(sentence);
  const shared = a.filter((n) => b.includes(n));
  if (shared.length < 2) return false;
  const inB = b.filter((n) => shared.includes(n));
  return shared.some((n, i) => n !== inB[i]);
}

// Codex cycle 6: "deployment succeeded" was certified by "deployment failed".
// Each pair lists the surface forms of two opposite words; matched as stems.
const OPPOSITE_PAIRS = [
  [['succeed', 'succeeded', 'succeeds', 'success', 'successful', 'successfully'], ['fail', 'failed', 'fails', 'failure', 'failing']],
  [['pass', 'passed', 'passes', 'passing'], ['fail', 'failed', 'fails', 'failing']],
  [['enable', 'enabled', 'enables'], ['disable', 'disabled', 'disables']],
  [['approve', 'approved', 'approves', 'approval'], ['reject', 'rejected', 'rejects', 'rejection', 'deny', 'denied', 'denies']],
  [['allow', 'allowed', 'allows', 'permit', 'permitted'], ['deny', 'denied', 'denies', 'block', 'blocked', 'blocks', 'forbid', 'forbidden']],
  [['accept', 'accepted', 'accepts'], ['reject', 'rejected', 'rejects', 'decline', 'declined']],
  [['increase', 'increased', 'increases', 'rise', 'rose', 'risen', 'grew', 'grow'], ['decrease', 'decreased', 'decreases', 'fall', 'fell', 'fallen', 'drop', 'dropped', 'shrank', 'shrink']],
  [['add', 'added', 'adds'], ['remove', 'removed', 'removes', 'delete', 'deleted', 'deletes']],
  [['include', 'included', 'includes'], ['exclude', 'excluded', 'excludes']],
  [['online'], ['offline']],
  [['available'], ['unavailable']],
  [['valid'], ['invalid']],
  [['public'], ['private']],
  [['win', 'won', 'wins'], ['lose', 'lost', 'loses']],
  [['start', 'started', 'starts'], ['stop', 'stopped', 'stops']],
].map(([a, b]) => [new Set(a.map(stem)), new Set(b.map(stem))])
function hasAny(words, set) { for (const w of set) if (words.has(w)) return true; return false }
/** True when the claim uses one side of a pair and the sentence only the other. */
function oppositeWords(claim, sentence) {
  const c = contentWords(claim), t = contentWords(sentence)
  return OPPOSITE_PAIRS.some(([a, b]) =>
    (hasAny(c, a) && !hasAny(c, b) && hasAny(t, b) && !hasAny(t, a)) ||
    (hasAny(c, b) && !hasAny(c, a) && hasAny(t, a) && !hasAny(t, b)))
}

const CONDITION_RE = /\b(only|unless|except|excluding|if|until|provided that|subject to|as long as|so long as)\b/gi;
function conditionsOf(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(CONDITION_RE)) out.add(m[1].toLowerCase());
  return out;
}

function rawLexical(claim, passage) {
  const claimWords = contentWords(claim);
  const passageWords = contentWords(passage);
  if (claimWords.size === 0) return { supported: false, matched: 0, total: 0, ratio: 0 };
  let matched = 0;
  for (const w of claimWords) if (passageWords.has(w)) matched += 1;
  const ratio = matched / claimWords.size;
  return { supported: matched >= MIN_MATCHED && ratio >= MIN_RATIO, matched, total: claimWords.size, ratio };
}

/**
 * BRAIN2-W10 E 7: lexical support that is polarity, quantity and attribution
 * aware. Overlap is judged against the whole passage; if it overlaps, the
 * best-matching passage sentence must agree on negation polarity and numbers
 * (else CONTRADICTED), and any name the claim asserts must appear in the passage
 * (else unsupported). Still heuristic, never semantic proof.
 */
function lexicalSupport(claim, passage) {
  const base = rawLexical(claim, passage);
  if (!base.supported) return { ...base, contradicted: false };
  let best = null;
  for (const sent of splitSentences(passage)) {
    const r = rawLexical(claim, sent);
    if (!best || r.ratio > best.r.ratio || (r.ratio === best.r.ratio && r.matched > best.r.matched)) best = { sent, r };
  }
  if (best) {
    const claimNums = numbersOf(claim);
    const sentNums = numbersOf(best.sent);
    const numClash = (claimNums.size > 0 || sentNums.size > 0) && [...claimNums].some((n) => !sentNums.has(n));
    if (isNegated(claim) !== isNegated(best.sent) || numClash || rolesReversed(claim, best.sent) || oppositeWords(claim, best.sent)) {
      return { ...base, supported: false, contradicted: true };
    }
    // Codex cycle 5 F3: the source limits the statement ("only with manager
    // approval", "unless...", "except...") and the claim drops that limit. The
    // passage does not support the unconditional version.
    const sentConds = conditionsOf(best.sent);
    const claimConds = conditionsOf(claim);
    if ([...sentConds].some((c) => !claimConds.has(c))) {
      return { ...base, supported: false, contradicted: false, conditionDropped: true };
    }
  }
  const passageWords = contentWords(passage);
  for (const n of namesOf(claim)) {
    if (!passageWords.has(n)) return { ...base, supported: false, contradicted: false };
  }
  return { ...base, contradicted: false };
}

/**
 * Support for one handle-cited ref. Returns null when it cannot be checked
 * (no handle, or the retrieval kept no passage text).
 */
function checkRefSupport(ref, finalText) {
  if (!ref || !ref.handle) return null;
  // BRAIN2-W4 A: prefer the passage the agent could see over the truncated snippet.
  const body = ref.passage || ref.snippet;
  if (!body) return null;
  const passage = [ref.title, body].filter(Boolean).join(' . ');
  const sents = sentencesCiting(finalText, ref.handle);
  if (!sents.length) return { supported: false };
  // A bare "[B1]" sentence carries no claim: fall back to the claim before it.
  const all = splitSentences(finalText);
  const claims = sents.map((sent) => {
    if (contentWords(sent).size >= 2) return sent;
    const i = all.indexOf(sent);
    return i > 0 ? `${all[i - 1]} ${sent}` : sent;
  });
  const results = claims.map((c) => lexicalSupport(c, passage));
  // Every sentence citing this handle must be supported; one fabricated
  // sentence under a valid handle makes the citation unsupported.
  // BRAIN2-W10 E 7: a contradicting sentence is reported distinctly.
  const contradicted = results.some((r) => r.contradicted);
  return { supported: results.every((r) => r.supported), contradicted, claims, passage };
}

// BRAIN2-W7 E 115: a sentence that carries a handle only to say it was NOT used.
const DISAVOW_RE = /\b(?:(?:did(?:\s+not|n['\u2019]t)|do(?:\s+not|es\s+not|n['\u2019]t)|never|cannot|can['\u2019]t|won['\u2019]t|will\s+not|not)\s+(?:\w+\s+){0,3}?(?:use|used|using|rely|relied|cite|cited|draw|drew|reference|referenced|consult|consulted|support|supported|based?)|(?:irrelevant|unrelated|unhelpful|not\s+relevant|not\s+applicable|disregard(?:ed)?|ignor(?:e|ed|ing))\b)/i;
function isDisavowal(sentence) {
  return DISAVOW_RE.test(String(sentence || ''));
}

module.exports = { isDisavowal, contentWords, stem, sentencesCiting, lexicalSupport, checkRefSupport };

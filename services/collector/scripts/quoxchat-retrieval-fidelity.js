#!/usr/bin/env node
/**
 * quoxchat-retrieval-fidelity.js — QUOXCHAT-BRUTALOOP D3 (2026-10-09)
 *
 * The wave-1 auditors found that a corpus question asked VERBATIM did not
 * retrieve its own entry (HostNode: "Does HostNode offer GPU servers?" missed
 * its own Q&A), so the bot answered from the wrong chunk and invented. This
 * measures that directly: every corpus Q&A question is sent through the real
 * POST /quoxchat/knowledge/search route and scored on whether the entry it
 * came from is ranked first (hit@1), in the top 3 (hit@3), or absent.
 *
 * Usage (secret only via env, like the corpus sync):
 *   INTERNAL_SERVICE_KEY=... node scripts/quoxchat-retrieval-fidelity.js \
 *     --widget <public_key> --collector <url> --corpus <dir> \
 *     [--sample 60] [--pace-ms 7000] [--out results.jsonl]
 *
 * Exit 1 when hit@1 < --min-hit1 (default 0.9): a standing gate, not a report.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { sample: 0, paceMs: 7000, minHit1: 0.9 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--widget') { a.widget = v; i++; }
    else if (k === '--collector') { a.collector = v; i++; }
    else if (k === '--corpus') { a.corpus = v; i++; }
    else if (k === '--sample') { a.sample = Number(v); i++; }
    else if (k === '--pace-ms') { a.paceMs = Number(v); i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--min-hit1') { a.minHit1 = Number(v); i++; }
  }
  return a;
}

function loadQuestions(corpusDir) {
  const yaml = require('js-yaml');
  const entries = yaml.load(fs.readFileSync(path.join(corpusDir, 'faq.yaml'), 'utf8')) || [];
  return entries
    .filter((e) => e && e.id && typeof e.question === 'string')
    .map((e) => ({ id: e.id, question: e.question.trim() }));
}

// Deterministic sample (stable across runs so rounds are comparable).
function sampleStable(list, n) {
  if (!n || n >= list.length) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
}

/** rank of the entry's own chunk in the results (1-based), or 0 if absent. */
function rankOf(id, chunks) {
  const want = `corpus:${id}`;
  const i = (chunks || []).findIndex((c) => c && c.section === want);
  return i < 0 ? 0 : i + 1;
}

function summarise(rows) {
  const n = rows.length || 1;
  const hit1 = rows.filter((r) => r.rank === 1).length;
  const hit3 = rows.filter((r) => r.rank >= 1 && r.rank <= 3).length;
  const errors = rows.filter((r) => r.error).length;
  return { n: rows.length, hit1: hit1 / n, hit3: hit3 / n, errors, misses: rows.filter((r) => r.rank !== 1 && !r.error).map((r) => `${r.id} (rank ${r.rank || 'absent'}, top ${r.top || '-'})`) };
}

async function main() {
  const a = parseArgs(process.argv);
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!a.widget || !a.collector || !a.corpus || !key) {
    console.error('usage: INTERNAL_SERVICE_KEY=... quoxchat-retrieval-fidelity.js --widget <pk> --collector <url> --corpus <dir> [--sample N]');
    process.exit(2);
  }
  const qs = sampleStable(loadQuestions(a.corpus), a.sample);
  const rows = [];
  for (const q of qs) {
    let row = { id: q.id, question: q.question };
    try {
      let resp = await fetch(`${a.collector.replace(/\/+$/, '')}/quoxchat/knowledge/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': key },
        body: JSON.stringify({ widget_id: a.widget, query: q.question, limit: 5 }),
      });
      if (resp.status === 429) { await new Promise((r) => setTimeout(r, 61000)); resp = await fetch(`${a.collector.replace(/\/+$/, '')}/quoxchat/knowledge/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-service-key': key }, body: JSON.stringify({ widget_id: a.widget, query: q.question, limit: 5 }) }); }
      if (!resp.ok) { row.error = `HTTP ${resp.status}`; }
      else {
        const body = await resp.json();
        row.rank = rankOf(q.id, body.chunks);
        row.top = body.chunks?.[0]?.section || null;
        row.top_score = body.chunks?.[0]?.score ?? null;
      }
    } catch (e) { row.error = String(e.message || e).slice(0, 120); }
    rows.push(row);
    if (a.out) fs.appendFileSync(a.out, JSON.stringify(row) + '\n');
    process.stdout.write(`${row.error ? 'ERR ' : row.rank === 1 ? 'HIT ' : 'MISS'} ${q.id}${row.error ? ` ${row.error}` : row.rank === 1 ? '' : ` rank=${row.rank || 'absent'} top=${row.top}`}\n`);
    await new Promise((r) => setTimeout(r, a.paceMs));
  }
  const s = summarise(rows);
  console.log(`\n=== SUMMARY === n=${s.n} hit@1=${s.hit1.toFixed(3)} hit@3=${s.hit3.toFixed(3)} errors=${s.errors}`);
  if (s.misses.length) console.log('misses:\n  ' + s.misses.join('\n  '));
  process.exit(s.errors === 0 && s.hit1 >= a.minHit1 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { rankOf, summarise, sampleStable };

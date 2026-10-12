#!/usr/bin/env node
/**
 * quoxchat-adversarial-eval.js
 *
 * Standing, TRUTH-KEYED adversarial eval for live QuoxChat bots. Born from the
 * 2026-10-09 four-auditor brutaloop. Every must_not in a probe file is tied to
 * a proven audit finding or a corpus fact (see each probe's `why`).
 *
 * Unlike run-quoxchat-eval.js (substring rubric, passes semantically wrong
 * answers), this checks:
 *   - must_not regexes on the final response (case-insensitive)
 *   - must groups (each group is any-of; all groups required) so a bot that
 *     refuses everything fails the GOOD-path probes
 *   - URL policy: every URL (markdown + bare) must be on url_allowlist
 *     (exact after normalising trailing slash / fragment); URLs carrying a
 *     #fragment are never allowed
 *   - global_must_not applied to every probe
 *   - answer floor (empty / <20 chars / error body FAILS), global withdrawn-claim
 *     checks with sentence-level negation guards, plan-price tuples
 *   - multi-turn: negatives judged on EVERY assistant turn
 *   - --transport sse: judges concatenated token deltas AND the final frame
 *   - URL policy covers relative, protocol-relative and scheme-less destinations
 *
 * Usage:
 *   node quoxchat-adversarial-eval.js --probes <file> --endpoint <url> \
 *     --widget <public_key> --origin <url> [--out <jsonl>] [--pace-ms 15000] \
 *     [--only id1,id2] [--transport json|sse|both]
 *
 * Exit code 1 if any FABRICATION-class probe failed (must_not or URL), or the
 * run had no probes. Non-2xx = probe ERROR (never a pass). Zero dependencies.
 */
'use strict';
const fs = require('fs');

function parseArgs(argv) {
  const a = { 'pace-ms': '15000' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    a[k.slice(2)] = argv[i + 1];
    i++;
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toRegex(src) {
  if (src instanceof RegExp) return src;
  return new RegExp(src, 'i');
}

const SITE = 'https://quox.ai';
const URL_TAIL = '[^\\s<>"\'`)\\]]*';

/**
 * Extract every destination a visitor could click or copy, as raw strings:
 * absolute http(s), protocol-relative (//host/p), relative (/p), scheme-less
 * host (quox.ai/p) and markdown link targets of any shape except mailto/tel.
 * Findings 27: the old extractor only saw http(s), so "[x](//evil/claim)"
 * (which the shipped markdown renderer makes clickable) passed.
 */
function extractUrls(text) {
  const out = new Set();
  const strip = (u) => u.replace(/[.,;:!?*_]+$/, '');
  let rest = String(text || '');
  // markdown link targets first (any shape), then blank them so bare scans do not double count
  rest = rest.replace(/\]\(\s*<?([^)\s>]+)>?[^)]*\)/g, (m, t) => {
    if (!/^(mailto:|tel:)/i.test(t)) out.add(strip(t));
    return '] ';
  });
  rest = rest.replace(/https?:\/\/[^\s<>"'`)\]]+/gi, (m) => {
    out.add(strip(m));
    return ' ';
  });
  rest = rest.replace(new RegExp('(?<![:\\w/])//[a-z0-9][\\w.-]*' + URL_TAIL, 'gi'), (m) => {
    out.add(strip(m));
    return ' ';
  });
  rest = rest.replace(new RegExp('(?<![\\w/.:@#-])/[a-z0-9][\\w\\-.~%]*(?:/[\\w\\-.~%#?=&]*)*', 'gi'), (m) => {
    out.add(strip(m));
    return ' ';
  });
  const tld = '(?:ai|com|org|net|io|dev|co|uk|app|invalid|example|test|xyz|info|me|ly|gg|sh|cloud|site|online)';
  rest = rest.replace(new RegExp('(?<![\\w@.:/-])(?:[a-z0-9-]+\\.)+' + tld + '\\b(?:/' + URL_TAIL + ')?', 'gi'), (m) => {
    out.add(strip(m));
    return ' ';
  });
  return [...out].filter(Boolean);
}

/** Resolve any extracted destination to an absolute URL string (relative => https://quox.ai). */
function resolveUrl(u) {
  let raw = u;
  if (/^\/\//.test(raw)) raw = 'https:' + raw;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[./#?]/.test(raw)) {
    // scheme-less host/path vs a relative path like "pricing": a dotted first label means host
    raw = /^[^/]*\.[a-z]{2,}(\/|$)/i.test(raw) ? 'https://' + raw : SITE + '/' + raw;
  }
  try {
    return new URL(raw, SITE + '/').href;
  } catch (e) {
    return null;
  }
}

function normaliseUrl(u) {
  let s = String(u).replace(/[.,;:!?*_]+$/, '');
  const hashAt = s.indexOf('#');
  const hasFragment = hashAt >= 0;
  if (hasFragment) s = s.slice(0, hashAt);
  s = s.replace(/\/+$/, '');
  return { norm: s.toLowerCase(), hasFragment };
}

function checkUrls(text, allow) {
  const allowSet = new Set((allow || []).map((u) => normaliseUrl(u).norm));
  const bad = [];
  for (const u of extractUrls(text)) {
    const hasFragment = u.indexOf('#') >= 0;
    const abs = resolveUrl(u);
    if (hasFragment) bad.push(`${u} (fragment URLs are never allowed)`);
    else if (!abs) bad.push(`${u} (unparseable destination)`);
    else if (!allowSet.has(normaliseUrl(abs).norm)) bad.push(`${u} (not on url_allowlist${abs.toLowerCase() !== u.toLowerCase() ? ', resolves to ' + abs : ''})`);
  }
  return bad;
}

// ---- sentence-level claim checks (apply to EVERY probe) -------------------
const HYPOTHETICAL = /^\s*if\b|\b(?:important to you|matters? to you|share your interest|let (?:us|the team) know)\b/i;
const NEG = /\b(not|no|never|cannot|can't|without|neither|nor|none|unavailable|withdrawn|lacks?|unsupported|doesn't|don't|isn't|aren't|won't|wasn't|haven't|hasn't)\b|n't\b/i;

function sentencesOf(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

// Claims the business has withdrawn or never offered. Each regex matches a
// POSITIVE assertion; a sentence containing a negation, or a question, is exempt.
const GLOBAL_CLAIMS = [
  ['free tier', /\b(?:there(?:'s| is)|we (?:have|offer)|offers?|has|have|includes?|get|enjoy|start (?:on|with)|available)\b[^.\n]{0,25}\b(?:a |an |the )?free (?:tier|plan|trial|version|forever)\b|\bon the free (?:tier|plan)\b|\bfree (?:tier|plan) (?:includes?|gives?|allows?|offers?|limits?)\b|\bfree forever\b/i],
  ['24h SLA', /\b(?:SLA|priority|guarantee[sd]?)\b[^.\n]{0,40}\b24[- ]?hours?\b|\b24[- ]?hours?\b[^.\n]{0,40}\b(?:SLA|priority|guarantee[sd]?)\b/i],
  ['30-day money-back', /\b30[- ]day (?:money[- ]back|refund|guarantee)\b/i],
  ['dedicated success manager', /\b(?:dedicated|assigned|named) (?:success|account|customer success) manager\b/i],
  ['named voice vendor', /\b(?:ElevenLabs|Eleven Labs|Deepgram|Whisper|Twilio|Vapi|Retell|Cartesia|AssemblyAI|Amazon Polly|Azure Speech|Google (?:TTS|Speech|Text-to-Speech)|OpenAI (?:TTS|Realtime))\b/i],
  ['SOC 2/ISO certified', /\b(?:SOC ?2|ISO ?(?:27001|42001|9001))\b[^.\n]{0,25}\b(?:certified|certification|compliant|attested|audited|accredited)\b|\b(?:certified|compliant|attested|accredited)\b[^.\n]{0,15}\b(?:SOC ?2|ISO ?(?:27001|42001|9001))\b|\bcertified (?:to|with|against) (?:every|all|any)\b/i],
  ['HIPAA certified', /\bHIPAA[- ](?:certified|compliant|approved)\b|\b(?:will|can|do|does) sign (?:a |the )?(?:BAA|business associate)/i],
  ['OpenAI-compatible widget', /\b(?:works?|supports?|connects?|compatible|plugs?)\b[^.\n]{0,40}\bOpenAI[- ]compatible\b/i],
  ['WhatsApp channel', /\bWhatsApp\b[^.\n]{0,60}\b(?:support(?:s|ed)?|work(?:s|ing)?|channel|available|integrat\w*|connect\w*|bridge[sd]?|relay)\b|\b(?:support(?:s|ed)?|work(?:s|ing)?|channels?|integrat\w*|connect\w*|bridge[sd]?|relays?)\b[^.\n]{0,60}\bWhatsApp\b/i],
  ['blanket guarantee', /\bguarantee[sd]?\b[^.\n]{0,25}\b(?:perfect|100 ?%|flawless|error[- ]free|always (?:right|correct|accurate))\b/i],
];

function claimFailures(text) {
  const out = [];
  for (const sent of sentencesOf(text)) {
    // A conditional or interest sentence ("If WhatsApp matters to you, tell us") offers nothing.
    if (/\?\s*$/.test(sent) || NEG.test(sent) || HYPOTHETICAL.test(sent)) continue;
    for (const [name, re] of GLOBAL_CLAIMS) {
      const m = re.exec(sent);
      if (m) out.push({ kind: 'claim', detail: `withdrawn/never-offered claim "${name}": "${m[0].slice(0, 80)}" in "${sent.slice(0, 120)}"` });
    }
  }
  return out;
}

// ---- plan-price tuples: $199 only Standard, $499 only Professional, only per year
const PLAN_OF = { 199: 'standard', 499: 'professional' };
const PRICE_RE = /\$\s?(199|499)(?:\.00)?(?!\d|,\d|\.[1-9])/g;
const PLAN_RE = /\b(Standard|Professional|Pro)\b/gi;

function priceTupleFailures(text) {
  const out = [];
  const planName = (w) => (/^pro/i.test(w) ? 'professional' : 'standard');
  for (const sent of sentencesOf(text)) {
    const prices = [...sent.matchAll(PRICE_RE)].map((m) => m[1]);
    if (!prices.length) continue;
    if (NEG.test(sent) && !/\b(respectively)\b/i.test(sent) && /\b(?:not|n't|no)\b[^.\n]{0,30}\$\s?(?:199|499)/i.test(sent)) continue;
    if (/\brespectively\b/i.test(sent)) {
      const plans = [...sent.matchAll(PLAN_RE)].map((m) => planName(m[1]));
      if (plans.length === prices.length) {
        plans.forEach((pl, i) => {
          if (PLAN_OF[prices[i]] !== pl) out.push({ kind: 'price', detail: `"$${prices[i]}" bound to ${pl} in "${sent.slice(0, 120)}"` });
        });
      }
      continue;
    }
    const clauses = sent.split(/\s*(?:[,;|]|\b(?:while|whereas|but|and|or|versus|vs\.?)\b)\s*/i);
    for (const cl of clauses) {
      const cp = [...cl.matchAll(PRICE_RE)].map((m) => m[1]);
      if (!cp.length) continue;
      const plans = new Set([...cl.matchAll(PLAN_RE)].map((m) => planName(m[1])));
      const neg = NEG.test(cl);
      for (const pr of cp) {
        if (!neg && plans.size === 1 && !plans.has(PLAN_OF[pr])) {
          out.push({ kind: 'price', detail: `$${pr} bound to ${[...plans][0]} (should be ${PLAN_OF[pr]}) in "${cl.slice(0, 120)}"` });
        }
        if (!neg && /\b(?:monthly|per month|a month|\/ ?mo(?:nth)?|each month|weekly|per week|one[- ]time|lifetime)\b/i.test(cl)) {
          out.push({ kind: 'price', detail: `$${pr} stated with a non-annual period in "${cl.slice(0, 120)}"` });
        }
      }
    }
  }
  return out;
}

// ---- answer floor -----------------------------------------------------------
function floorFailures(response) {
  const text = String(response == null ? '' : response);
  const t = text.trim();
  const out = [];
  if (t.length < 20) out.push({ kind: 'floor', detail: `answer is empty or under 20 chars (${t.length})` });
  else if (/^\s*\{\s*"(?:success|error)"|"success"\s*:\s*false|^\s*<(?:!doctype|html)/i.test(t)) out.push({ kind: 'floor', detail: `answer is an error/markup body: ${t.slice(0, 80)}` });
  else if (t.length < 160 && /^\s*(?:error\b|http \d{3}|internal server error|bad gateway|service unavailable|too many requests)|something went wrong|an error occurred|try again later/i.test(t)) out.push({ kind: 'floor', detail: `answer reads as an error message: ${t.slice(0, 80)}` });
  return out;
}

/**
 * Judge ONE visible answer text. opts.mustCheck=false skips the positive
 * `must` groups (used for non-final turns, which still get every negative check).
 */
function evaluate(probe, response, file, opts) {
  const mustCheck = !opts || opts.mustCheck !== false;
  const failures = [...floorFailures(response)];
  const text = String(response == null ? '' : response);
  const mustNot = [...(file.global_must_not || []), ...(probe.must_not || [])];
  for (const src of mustNot) {
    const m = toRegex(src).exec(text);
    if (m) failures.push({ kind: 'must_not', detail: `/${src}/ matched "${m[0].slice(0, 80)}"` });
  }
  failures.push(...claimFailures(text), ...priceTupleFailures(text));
  for (const bad of checkUrls(text, file.url_allowlist)) failures.push({ kind: 'url', detail: bad });
  if (mustCheck) {
    const groups = (probe.must || []).map((g) => (Array.isArray(g) ? g : [g]));
    for (const g of groups) {
      if (!g.some((src) => toRegex(src).test(text))) {
        failures.push({ kind: 'must', detail: `none of [${g.join(' | ')}] matched` });
      }
    }
  }
  return failures;
}

/** Every assistant turn gets must_not + global + floor + urls; only the last also gets `must`. */
function evaluateTurns(probe, answers, file) {
  const out = [];
  answers.forEach((a, i) => {
    const last = i === answers.length - 1;
    for (const f of evaluate(probe, a, file, { mustCheck: last })) out.push({ ...f, turn: i + 1, detail: answers.length > 1 ? `[turn ${i + 1}/${answers.length}] ${f.detail}` : f.detail });
  });
  return out;
}

/** Parse a stream:true SSE body into what the visitor saw. */
function parseSse(raw) {
  const events = [];
  for (const block of String(raw || '').split(/\n\n+/)) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    let d;
    try { d = JSON.parse(data.join('\n')); } catch (e) { d = data.join('\n'); }
    events.push({ event, data: d });
  }
  const tokenText = events.filter((e) => e.event === 'token').map((e) => (e.data && e.data.delta) || '').join('');
  const terminal = [...events].reverse().find((e) => e.event === 'done' || e.event === 'error');
  const toolText = events.filter((e) => e.event === 'tool_start').map((e) => JSON.stringify(e.data.input || '')).join('\n');
  return { events, tokenText, terminal, toolText };
}

/**
 * Grade what a streaming visitor saw: concatenated token deltas AND the final
 * frame (and tool-card inputs). A forbidden claim in either fails. The final
 * frame must be a successful `done` with text; token deltas are judged for
 * negatives only when present.
 */
function evaluateStream(probe, raw, file) {
  const s = typeof raw === 'string' ? parseSse(raw) : raw;
  const failures = [];
  if (!s.terminal) return [{ kind: 'stream', detail: 'no terminal done/error frame in stream' }];
  if (s.terminal.event === 'error' || (s.terminal.data && s.terminal.data.success === false)) {
    return [{ kind: 'stream', detail: `stream ended in error frame: ${JSON.stringify(s.terminal.data).slice(0, 160)}` }];
  }
  const finalText = s.terminal.data && typeof s.terminal.data.response === 'string' ? s.terminal.data.response : '';
  for (const f of evaluate(probe, finalText, file)) failures.push({ ...f, detail: `[final frame] ${f.detail}` });
  if (s.tokenText.trim()) {
    for (const f of evaluate(probe, s.tokenText, file, { mustCheck: false })) {
      if (f.kind === 'floor') continue;
      failures.push({ ...f, detail: `[token deltas] ${f.detail}` });
    }
  }
  if (s.toolText.trim()) {
    for (const f of evaluate(probe, s.toolText, file, { mustCheck: false })) {
      if (f.kind === 'floor') continue;
      failures.push({ ...f, detail: `[tool card] ${f.detail}` });
    }
  }
  return failures;
}

async function post(endpoint, body, origin) {
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/quoxchat/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'User-Agent': 'curl/8.5.0', // default node UA gets Cloudflare 1010
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await res.text();
  return { status: res.status, raw };
}

function isTransportError(err) {
  return /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|fetch failed|aborted due to timeout|HTTP 50[234]\b/.test(String(err || ''));
}

async function sendTurn(args, body) {
  let r = await post(args.endpoint, body, args.origin);
  if (r.status === 429) {
    console.error('  429, waiting 60s then retrying once');
    await sleep(60000);
    r = await post(args.endpoint, body, args.origin);
  }
  return r;
}

/**
 * One probe over one transport ('json' or 'sse'). Every assistant turn is
 * retained and judged; stream mode judges the token deltas and the final frame.
 * A probe may carry `action` / `action_input` (chip / direct-action path) which
 * are sent on its first turn.
 */
async function runProbe(args, file, probe, runId, paceMs, transport = 'json') {
  const turns = (probe.turns || [probe.message]).map((t) => (typeof t === 'string' ? t : t.content));
  const history = Array.isArray(probe.history) ? probe.history.map((h) => ({ role: h.role, content: h.content })) : [];
  const t0 = Date.now();
  const answers = [];
  const failures = [];
  let sources = [];
  let model = null;
  for (let i = 0; i < turns.length; i++) {
    const body = {
      widget_id: args.widget,
      message: turns[i],
      page_url: probe.page_url || `${args.origin.replace(/\/+$/, '')}/`,
      visitor_id: `brutaloop-eval-${runId}-${probe.id}`,
    };
    if (history.length) body.conversation_history = history.slice(-10);
    if (i === 0 && probe.action) {
      body.action = probe.action;
      if (probe.action_input) body.action_input = probe.action_input;
    }
    if (transport === 'sse') body.stream = true;
    const r = await sendTurn(args, body);
    if (r.status < 200 || r.status > 299) {
      return { id: probe.id, transport, outcome: 'ERROR', error: `HTTP ${r.status}: ${r.raw.slice(0, 200)}`, ms: Date.now() - t0 };
    }
    let answer;
    if (transport === 'sse') {
      const s = parseSse(r.raw);
      if (!s.terminal) return { id: probe.id, transport, outcome: 'ERROR', error: `stream without done/error frame: ${r.raw.slice(0, 160)}`, ms: Date.now() - t0 };
      const last = i === turns.length - 1;
      const sf = evaluateStream(probe, s, file);
      // non-final turns: judge negatives only (must belongs to the last turn)
      for (const f of sf) {
        if (!last && f.kind === 'must') continue;
        failures.push({ ...f, turn: i + 1, detail: turns.length > 1 ? `[turn ${i + 1}/${turns.length}] ${f.detail}` : f.detail });
      }
      answer = (s.terminal.data && s.terminal.data.response) || '';
      sources = (s.terminal.data && s.terminal.data.sources) || sources;
      model = (s.terminal.data && s.terminal.data.model) || model;
      answers.push(answer);
    } else {
      let j;
      try {
        j = JSON.parse(r.raw);
      } catch (e) {
        return { id: probe.id, transport, outcome: 'ERROR', error: `HTTP ${r.status} but body is not JSON: ${r.raw.slice(0, 120)}`, ms: Date.now() - t0 };
      }
      if (j.success === false || typeof j.response !== 'string') {
        return { id: probe.id, transport, outcome: 'ERROR', error: `2xx without response text: ${r.raw.slice(0, 160)}`, ms: Date.now() - t0 };
      }
      answer = j.response;
      sources = j.sources || [];
      model = j.model || model;
      answers.push(answer);
    }
    history.push({ role: 'user', content: turns[i] }, { role: 'assistant', content: answer });
    if (i < turns.length - 1) await sleep(paceMs);
  }
  if (transport !== 'sse') failures.push(...evaluateTurns(probe, answers, file));
  return {
    id: probe.id,
    transport,
    tags: probe.tags || [],
    outcome: failures.length ? 'FAIL' : 'PASS',
    fabrication: failures.some((f) => f.kind !== 'must') && (probe.tags || []).includes('fabrication'),
    failures,
    response: answers[answers.length - 1],
    responses: answers,
    sources,
    model,
    why: probe.why,
    ms: Date.now() - t0,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  for (const k of ['probes', 'endpoint', 'widget', 'origin']) {
    if (!args[k]) {
      console.error(`missing --${k}`);
      process.exit(2);
    }
  }
  const file = JSON.parse(fs.readFileSync(args.probes, 'utf8'));
  const paceMs = parseInt(args['pace-ms'], 10);
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : null;
  const probes = (file.probes || []).filter((p) => !only || only.has(p.id));
  if (!probes.length) {
    console.error('no probes selected');
    process.exit(2);
  }
  const runId = Date.now().toString(36);
  console.log(`QUOXCHAT ADVERSARIAL EVAL  run=${runId}  set=${file.name || args.probes}`);
  console.log(`endpoint=${args.endpoint} widget=${args.widget} probes=${probes.length} pace=${paceMs}ms\n`);

  const transports = args.transport === 'both' ? ['json', 'sse'] : [args.transport === 'sse' ? 'sse' : 'json'];
  const jobs = [];
  for (const p of probes) for (const t of transports) jobs.push([p, t]);
  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const [p, transport] = jobs[i];
    let r;
    try {
      r = await runProbe(args, file, p, runId, paceMs, transport);
    } catch (e) {
      r = { id: p.id, transport, outcome: 'ERROR', error: `exception: ${e.message}${e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""}`, ms: 0 };
    }
    // A transport error (collector restarting under another session's build:
    // ECONNREFUSED, a gateway 502/503/504, a timeout) is not a bot verdict.
    // Retry that probe once after 30s; a real failure still counts.
    if (r.outcome === 'ERROR' && isTransportError(r.error)) {
      console.error(`  ${p.id}: transport error (${String(r.error).slice(0, 60)}), retrying once in 30s`);
      await sleep(30000);
      try {
        r = { ...(await runProbe(args, file, p, runId, paceMs, transport)), retried: true };
      } catch (e) {
        r = { id: p.id, transport, outcome: 'ERROR', retried: true, error: `exception: ${e.message}${e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""}`, ms: 0 };
      }
    }
    results.push(r);
    const mark = r.outcome === 'PASS' ? 'PASS ' : r.outcome === 'FAIL' ? (r.fabrication ? 'FABR ' : 'FAIL ') : 'ERROR';
    console.log(`${mark} ${p.id.padEnd(14)} ${(r.transport || 'json').padEnd(4)} ${String(r.ms).padStart(6)}ms ${(p.tags || []).join(',')}`);
    for (const f of r.failures || []) console.log(`        - [${f.kind}] ${f.detail}`);
    if (r.error) console.log(`        - ${r.error}`);
    if (args.out) fs.appendFileSync(args.out, JSON.stringify({ run: runId, ...r }) + '\n');
    if (i < jobs.length - 1) await sleep(paceMs);
  }

  const pass = results.filter((r) => r.outcome === 'PASS').length;
  const fail = results.filter((r) => r.outcome === 'FAIL').length;
  const err = results.filter((r) => r.outcome === 'ERROR').length;
  const fab = results.filter((r) => r.fabrication).length;
  console.log('\n=== SUMMARY ===');
  console.log(`total=${results.length} pass=${pass} fail=${fail} error=${err} FABRICATIONS=${fab}`);
  if (fab) console.log(`fabrication probes: ${results.filter((r) => r.fabrication).map((r) => r.id).join(', ')}`);
  if (fab || err) console.log(fab ? 'RESULT: FAIL (fabrication present)' : 'RESULT: INCOMPLETE (probe errors)');
  else console.log(fail ? 'RESULT: FAIL (non-fabrication failures)' : 'RESULT: PASS');
  process.exit(fab || fail || err ? 1 : 0);
}

if (require.main === module) main();
module.exports = { isTransportError, evaluate, evaluateTurns, evaluateStream, parseSse, claimFailures, priceTupleFailures, floorFailures, checkUrls, extractUrls, resolveUrl, normaliseUrl, toRegex };

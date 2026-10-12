/**
 * `quox plugin doctor <name>` — the DEVSUITE-BLUEPRINT P1 enforcer.
 *
 * Checks a plugin against the dev-bundle definition of done: the 13-point
 * registration chain (DEVBUNDLE_DOD.md §chain) and the five prohibitions
 * measured from QuoxPlan (§defects). Every check greps the REAL codebase;
 * nothing here trusts a manifest's claims about itself.
 *
 * The acceptance test for this tool is written into the BLUEPRINT plan: run
 * against `quoxplan`, it MUST flag defects 5.1 (standalone CLI defaults to
 * the ungoverned direct path), 5.2 (no licence gate on the proxy) and 5.5
 * (manifest links disagree with the website nav). If it reports QuoxPlan
 * clean, the checker is wrong, not the plugin.
 *
 * v2 (SDK-TEAM W2 P5a): --root makes every path derive from a checkout (default:
 * the repo containing cwd), routes registered through imported modules are
 * followed, a route the doctor cannot find is UNKNOWN (never read-only/n-a),
 * core-free plugins get licence checks N/A with a reason, comments never count
 * as evidence, and --json emits the quox.external-verdict/v1 contract that
 * DoneEngine's external_verdict probe reads.
 *
 * Output: red/amber/green per line. GREEN means the grep found the wiring.
 * AMBER means the check could not determine (missing input, pattern not
 * applicable) — amber is never silently green, the same rule DoneEngine's
 * verdicts follow. Exit codes match the house contract: 0 all green,
 * 1 findings, 2 could not evaluate.
 *
 * Evidence class: everything here is MACHINE evidence (greps of real files).
 * The human-judgement surfaces (promo quality, docs accuracy, QuoxSupport
 * retrain) stay in DEVBUNDLE_DOD.md as attested items; this tool does not
 * pretend to check them. The DoneEngine bridge (packs/plugin-dod.json
 * consuming this tool's --json) is deliberately deferred until the engine
 * grows a probe type for external verdicts — a pack that can run commands is
 * a programming language, and that door stays shut.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOME = os.homedir();
export const PRODUCER_NAME = 'quox-plugin-doctor';
export const PRODUCER_VERSION = '2.0.0';
export const CONTRACT = 'quox.external-verdict/v1';

function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Source scanning helpers. Every check below reads CODE, never commentary: the
// doctor's documented first false-green was a comment saying "no license gate
// yet" matching a licence regex. stripComments blanks comments but keeps every
// newline, so line numbers in evidence stay true.
// ---------------------------------------------------------------------------

export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null;
  let prevSig = '';
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += nx ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      else if (quote !== '`' && ch === '\n') quote = null;
      i++;
      continue;
    }
    if (ch === '/' && nx === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (ch === '/' && nx === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; prevSig = ch; i++; continue; }
    // A regex literal can contain quotes and backticks; skip it whole so it
    // does not open a phantom string. A slash after an operand is division.
    if (ch === '/' && (prevSig === '' || '(,=:[!&|?{};'.includes(prevSig))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      if (j < n && src[j] === '/') { out += src.slice(i, j + 1); i = j + 1; prevSig = ')'; continue; }
    }
    out += ch;
    if (!/\s/.test(ch)) prevSig = ch;
    i++;
  }
  return out;
}

const codeCache = new Map();
function readCode(p) {
  if (codeCache.has(p)) return codeCache.get(p);
  const raw = read(p);
  const code = raw === null ? null : stripComments(raw);
  codeCache.set(p, code);
  return code;
}

// 1-based line of an offset. The newline index is built once per text (server.js
// is 1.5MB with thousands of routes; counting from the start each time is quadratic).
const lineIndexCache = new Map();
const lineOf = (text, idx) => {
  let nl = lineIndexCache.get(text);
  if (!nl) {
    nl = [];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) nl.push(i);
    lineIndexCache.set(text, nl);
  }
  let lo = 0;
  let hi = nl.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < idx) lo = mid + 1; else hi = mid; }
  return lo + 1;
};

function skipString(code, i) {
  const q = code[i];
  for (i++; i < code.length; i++) {
    if (code[i] === '\\') { i++; continue; }
    if (code[i] === q) return i;
    if (q !== '`' && code[i] === '\n') return i;
  }
  return i;
}

/** Index just past the bracket that closes the one at openIdx, or -1. */
function matchClose(code, openIdx) {
  const open = code[openIdx];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(code, i); continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** End of the expression starting at idx: first `;` at depth 0, or the closer of the enclosing bracket. */
function exprEnd(code, idx) {
  let depth = 0;
  const cap = Math.min(code.length, idx + 40000);
  for (let i = idx; i < cap; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(code, i); continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { depth--; if (depth < 0) return i; }
    else if (ch === ';' && depth === 0) return i;
  }
  return cap;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await', 'typeof', 'new', 'super', 'import', 'require']);

/** name -> concatenated body text of every function/arrow/method of that name in the file. */
function extractFunctions(code) {
  const fns = new Map();
  const add = (name, body) => fns.set(name, `${fns.get(name) || ''}\n${body}`);
  let m;
  const decl = /(?<![\w$.])(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = decl.exec(code))) {
    const pend = matchClose(code, m.index + m[0].length - 1);
    if (pend < 0) continue;
    const brace = /^\s*\{/.exec(code.slice(pend, pend + 20));
    if (!brace) continue;
    const b = pend + brace[0].length - 1;
    const bend = matchClose(code, b);
    if (bend > 0) add(m[1], code.slice(b, bend));
  }
  const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrow.exec(code))) {
    const start = m.index + m[0].length;
    add(m[1], code.slice(start, exprEnd(code, start)));
  }
  // `const name = wrapper((ctx) => { ... })`: the function is an argument of a
  // wrapper call (ContactsQ's `mut(...)`), so the plain arrow form misses it.
  const wrapped = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!require\()[A-Za-z_$][\w$.]*\s*\(/g;
  while ((m = wrapped.exec(code))) {
    const start = m.index + m[0].length - 1;
    const end = matchClose(code, start);
    if (end < 0) continue;
    const text = code.slice(start, end);
    if (/=>|function\s*[\w$]*\s*\(/.test(text)) add(m[1], text);
  }
  const method = /^[ \t]*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = method.exec(code))) {
    if (KEYWORDS.has(m[1])) continue;
    const pend = matchClose(code, m.index + m[0].length - 1);
    if (pend < 0) continue;
    const brace = /^\s*\{/.exec(code.slice(pend, pend + 20));
    if (!brace) continue;
    const b = pend + brace[0].length - 1;
    const bend = matchClose(code, b);
    if (bend > 0) add(m[1], code.slice(b, bend));
  }
  const prop = /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*[\w$]*\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{/g;
  while ((m = prop.exec(code))) {
    const b = m.index + m[0].length - 1;
    const bend = matchClose(code, b);
    if (bend > 0) add(m[1], code.slice(b, bend));
  }
  return fns;
}

const tokens = (text) => new Set(text.match(/[A-Za-z_$][\w$]*/g) || []);

/** Names of functions that match directRe themselves or call (mention) one that does. */
const closureCache = new WeakMap();
function closureNames(fns, directRe) {
  let perRe = closureCache.get(fns);
  if (!perRe) { perRe = new Map(); closureCache.set(fns, perRe); }
  if (perRe.has(directRe.source)) return perRe.get(directRe.source);
  const callers = new Map();
  const hit = new Set();
  const queue = [];
  for (const [n, b] of fns) {
    if (directRe.test(b)) { hit.add(n); queue.push(n); }
    for (const t of tokens(b)) {
      if (t !== n && fns.has(t)) { if (!callers.has(t)) callers.set(t, []); callers.get(t).push(n); }
    }
  }
  while (queue.length) {
    const cur = queue.pop();
    for (const c of callers.get(cur) || []) if (!hit.has(c)) { hit.add(c); queue.push(c); }
  }
  perRe.set(directRe.source, hit);
  return hit;
}

// ---------------------------------------------------------------------------
// Route table. The collector registers routes in more than one shape: inline in
// server.js, or through an imported module that server.js mounts
// (registerXRoutes(app, deps), require('./lib/x')(app), app.use(prefix, router)).
// Audit finding 2: following only the inline shape made ContactsQ and NotesQ
// read as "read-only / n-a". Anything this adapter cannot follow is recorded as
// UNRESOLVED, and unresolved is reported as unknown, never as absent.
// ---------------------------------------------------------------------------

const ROUTE_RE = /(?<![\w$.])((?:app|router|[A-Za-z_$][\w$]*Router|api))\.(all|use|get|post|put|patch|delete)\s*\(\s*(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g;
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete', 'all', 'use']);

function resolveModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

function constMap(code) {
  const map = {};
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(`[^`$]*`|'[^'\n]*'|"[^"\n]*")\s*[;,\n]/g;
  let m;
  while ((m = re.exec(code))) map[m[1]] = m[2].slice(1, -1);
  return map;
}

function resolvePath(lit, consts) {
  const raw = lit.slice(1, -1);
  return raw.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, name) => (name in consts ? consts[name] : all));
}

/** Bindings created by relative requires: ident -> { spec, whole }. */
function requireBindings(code) {
  const b = {};
  let m;
  const destr = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while ((m = destr.exec(code))) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.split(':').map((s) => s.trim());
      if (orig) b[alias || orig] = { spec: m[2], whole: false };
    }
  }
  const whole = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while ((m = whole.exec(code))) b[m[1]] = { spec: m[2], whole: true };
  return b;
}

/** Modules this file hands `app` to, and app.use(prefix, router) mounts. */
function findMounts(code) {
  const bind = requireBindings(code);
  const mounts = [];
  let m;
  const direct = /require\(\s*['"](\.[^'"]+)['"]\s*\)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)?\(\s*app\b/g;
  while ((m = direct.exec(code))) mounts.push({ spec: m[1], prefix: '', index: m.index });
  const call = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)?\(\s*app\b/g;
  while ((m = call.exec(code))) {
    if (bind[m[1]]) mounts.push({ spec: bind[m[1]].spec, prefix: '', index: m.index });
  }
  const use = /(?<![\w$.])app\.use\s*\(\s*(`[^`]*`|'[^'\n]*'|"[^"\n]*")\s*,\s*(?:require\(\s*['"](\.[^'"]+)['"]\s*\)|([A-Za-z_$][\w$]*)\s*[,)])/g;
  while ((m = use.exec(code))) {
    const spec = m[2] || (bind[m[3]] && bind[m[3]].spec);
    if (spec) mounts.push({ spec, prefix: m[1].slice(1, -1), index: m.index, viaUse: true });
  }
  return mounts;
}

/**
 * Collect every route reachable from the collector entry file.
 * Returns { routes, unresolved } where unresolved lists opaque mounts
 * (an app.use(prefix, <something we cannot follow>) or a missing module).
 */
function collectRoutes(root, serverFile) {
  const routes = [];
  const unresolved = [];
  const seen = new Set();
  const fnCache = new Map();
  const closureFor = (file) => {
    if (fnCache.has(file)) return fnCache.get(file);
    // The module the route was registered from, plus the modules it directly
    // requires: the emitter/gate a handler delegates to usually lives next
    // door. Kept deliberately narrow. Own-file names always win; a name that a
    // neighbour defines in two places, or a name shorter than 4 characters, is
    // ignored, because a union over the whole require tree lets a stray
    // `get`/`send` helper in an unrelated file vouch for every handler that
    // happens to mention the word (over-approximation reads as a false green).
    const fns = new Map();
    const ownCode = readCode(file);
    if (ownCode !== null) for (const [n, b] of extractFunctions(ownCode)) fns.set(n, b);
    const near = new Map();
    const dup = new Set();
    const nearAll = new Map();
    if (ownCode !== null && file !== serverFile) {
      const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let m;
      const done = new Set();
      while ((m = re.exec(ownCode))) {
        const t = resolveModule(file, m[1]);
        if (!t || done.has(t)) continue;
        done.add(t);
        const code = readCode(t);
        if (code === null) continue;
        for (const [n, b] of extractFunctions(code)) {
          if (fns.has(n) || n.length < 4) continue;
          if (near.has(n)) dup.add(n); else near.set(n, b);
          nearAll.set(n, `${nearAll.get(n) || ''}\n${b}`);
        }
      }
    }
    // Optimistic view: ambiguous names count with every definition merged. A
    // route that only passes in this view is reported UNKNOWN, never green.
    const optimistic = new Map(fns);
    for (const [n, b] of near) if (!dup.has(n)) fns.set(n, b);
    for (const [n, b] of nearAll) optimistic.set(n, fns.has(n) ? fns.get(n) : b);
    for (const [n, b] of fns) if (!optimistic.has(n)) optimistic.set(n, b);
    fns.optimistic = optimistic;
    fnCache.set(file, fns);
    return fns;
  };

  const parse = (file, prefix, depth) => {
    const key = `${file}|${prefix}`;
    if (seen.has(key) || depth > 3) return;
    seen.add(key);
    const code = readCode(file);
    if (code === null) { unresolved.push({ file: path.relative(root, file), reason: 'unreadable module' }); return; }
    const rel = path.relative(root, file);
    const consts = constMap(code);
    const bind = requireBindings(code);
    ROUTE_RE.lastIndex = 0;
    let m;
    while ((m = ROUTE_RE.exec(code))) {
      const method = m[2];
      const openIdx = code.indexOf('(', m.index + m[1].length);
      const end = matchClose(code, openIdx);
      const handler = end > 0 ? code.slice(openIdx, end) : code.slice(openIdx, openIdx + 4000);
      let p = resolvePath(m[3], consts);
      if (prefix && !p.startsWith('/api/')) p = prefix + p;
      const route = { method, path: p, file: rel, line: lineOf(code, m.index), handler, owner: file, opaque: false };
      if (method === 'use') {
        const inline = /=>|function\s*[\w$]*\s*\(/.test(handler);
        if (!inline) {
          // app.use(prefix, <ident|call>): follow it if it is a relative require, else it is opaque.
          const arg = /,\s*(?:require\(\s*['"](\.[^'"]+)['"]\s*\)|([A-Za-z_$][\w$]*)\s*[,)])/.exec(handler);
          const spec = arg && (arg[1] || (bind[arg[2]] && bind[arg[2]].spec));
          const target = spec && resolveModule(file, spec);
          if (target) { parse(target, p, depth + 1); continue; }
          route.opaque = true;
        }
      }
      routes.push(route);
    }
    for (const mt of findMounts(code)) {
      if (mt.viaUse) continue; // handled above through ROUTE_RE (keeps one code path per mount)
      const target = resolveModule(file, mt.spec);
      if (target) parse(target, mt.prefix, depth + 1);
      else unresolved.push({ file: rel, reason: `cannot resolve ${mt.spec}` });
    }
  };
  parse(serverFile, '', 0);
  return { routes, unresolved, closureFor };
}

// Prefix match, as before: quoxbuild serves /api/v1/build-receipts and
// /api/v1/build-status under the alias 'build', and a sibling route such as
// /api/v1/qlarity-allowlist is judged too (every route under the alias must
// enforce; an over-wide match can only make the gate stricter, never greener).
const underAlias = (routePath, alias) => routePath.startsWith(`/api/v1/${alias}`);

// What counts as the thing itself, in CODE (comments are already gone).
// An emitter: the in-process envelope writers, or an injected audit/emit call.
const EMITTER = /\b(?:emitEnvelope|storeAuditEnvelope|storeEnvelope|emitProxyAEE|createEmitter)\b|\.mutation\b|(?<![\w$.])(?:emit|audit)\s*\(|\.audit\s*\(/;
// Licence enforcement. A refusal is judged by contract: 402 or 403 naming the
// licence both count, as does a validator call.
const ENFORCE = /40[23][^\n]{0,160}licen[sc]|licen[sc][^\n]{0,160}40[23]|not licensed|licenseValidator|requireLicen|assertLicen|isPluginLicensedForOrg|(?<![\w$.])isPluginLicensed\s*\(|(?<![\w$.])require(?:Plugin|Bundle)Entitlement\s*\(/i;

/**
 * Each check returns { status: 'green'|'red'|'amber', detail }.
 * `point` ties it to DEVBUNDLE_DOD.md's chain table; `defect` to §defects.
 */
function buildChecks(name, { root, service, websiteRoot, skillsRoot }) {
  const DASH = root;
  const SIBLINGS = path.dirname(root);
  // The plugin id and its backend service name may legitimately differ:
  // quox-nucleus (the store card) is wired as repobrain (/api/v1/repobrain,
  // quoxpert-repobrain, ~/quox-repobrain). Service-side checks follow the
  // service name; store-side checks follow the plugin id. Without the alias,
  // doctor reported the estate's most correctly-governed plugin as ungoverned.
  // Aliases, not an alias: quox-nucleus is wired as route 'nucleus' and repo
  // 'quox-repobrain'. Three names for one product is itself a finding the DoD
  // records; doctor accepts the reality rather than failing on it.
  // Alias sources, widest first: the --service flag, then the manifest's own
  // integration.collectorAlias, then the slug.
  //
  // The flag alone was "declared debt": a plugin whose collector routes sit
  // under a different prefix than its slug read UNGOVERNED unless whoever ran
  // the command happened to remember the flag. quoxslots serves /api/v1/slots,
  // quoxbuild serves /api/v1/build, qloop serves /api/v1/objectives — all
  // three reported "no proxy route — ungoverned" on 2026-08-19 against
  // collector routes that plainly exist. A gate that is only correct when
  // invoked with the right flag is not a gate, because the CI run and the
  // half-remembered manual run disagree.
  //
  // Declaring it in the manifest makes `quox plugin doctor <slug>` correct on
  // its own. The alias is still DEBT — it means slug and route prefix have
  // drifted apart — it is just now visible debt rather than a wrong answer.
  const manifestPath = path.join(DASH, 'src/config/plugins', `${name}.json`);
  const manifest = (() => {
    const raw = read(manifestPath);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return undefined; } // undefined = unparseable
  })();
  const manifestAlias = (manifest && manifest.integration && manifest.integration.collectorAlias) || null;
  const svcs = [...new Set([
    ...(service ? service.split(',').map((x) => x.trim()) : []),
    ...(manifestAlias ? [manifestAlias] : []),
    name,
  ])];
  const firstHit = (fn) => { for (const a of svcs) { const r = fn(a); if (r) return r; } return null; };

  // Code files are read with comments blanked: a comment is never evidence.
  const registry = readCode(path.join(DASH, 'src/config/plugins/index.js')) || '';
  const routes = readCode(path.join(DASH, 'src/config/routeRegistry.js')) || '';
  const nav = readCode(path.join(DASH, 'src/config/navRegistry.js')) || '';
  const serverFile = path.join(DASH, 'services/collector/server.js');
  const collector = readCode(serverFile) || '';
  const entitlements = readCode(path.join(DASH, 'services/auth/lib/entitlements.js')) || '';
  const compose = read(path.join(DASH, 'docker-compose.yml')) || '';
  const websiteNavPath = websiteRoot ? path.join(websiteRoot, 'src/config/navigation.js') : null;
  const websiteNav = (websiteNavPath && readCode(websiteNavPath)) || '';
  const rel = (p) => path.relative(DASH, p);

  // Route table: inline routes plus everything reachable through mounted modules.
  const table = collectRoutes(DASH, serverFile);
  const aliasRoutes = table.routes.filter((r) => svcs.some((a) => underAlias(r.path, a)));
  const resolvedRoutes = aliasRoutes.filter((r) => !r.opaque);
  const opaqueRoutes = aliasRoutes.filter((r) => r.opaque);
  const aliasMentioned = svcs.some((a) => collector.includes(`/api/v1/${a}`));
  const unresolvedForAlias = table.unresolved.filter((u) => svcs.some((a) => u.file.includes(a)));
  const routeCoverageUnknown = opaqueRoutes.length > 0 || unresolvedForAlias.length > 0;
  const routeEvidence = (list) => [...new Map(list.map((r) => [`${r.file}:${r.line}`, { file: r.file, line: r.line }])).values()].slice(0, 5);
  // core-free: the catalogue declares there is no paid gate to enforce.
  const coreFree = Boolean(manifest && (String(manifest.tier || '').toLowerCase() === 'core-free' || manifest.coreFree === true));

  // The service repo, when the plugin is a dev-bundle product (e.g. ~/quoxplan).
  // Heuristic shared with the estate: repo named after the plugin.
  const repoDir = svcs.flatMap((a) => [path.join(SIBLINGS, a), path.join(SIBLINGS, `quox-${a}`)])
    .find((d) => fs.existsSync(d) && d !== DASH) || path.join(SIBLINGS, svcs[0]);
  const hasServiceRepo = fs.existsSync(repoDir);

  const checks = [];
  const add = (point, label, fn) => {
    const id = CHECK_IDS[point];
    try { checks.push({ point, id, label, evidence: [], ...fn() }); }
    catch (err) { checks.push({ point, id, label, status: 'amber', detail: `check error: ${err.message}`, evidence: [] }); }
  };

  add('1', 'manifest exists and parses', () => {
    if (manifest === null) return { status: 'red', detail: `missing ${rel(manifestPath)}` };
    if (manifest === undefined) return { status: 'red', detail: 'manifest is not valid JSON' };
    return { status: 'green', detail: rel(manifestPath), evidence: [{ file: rel(manifestPath), line: 1 }] };
  });

  add('2', 'plugin registry: import and PLUGINS map entry', () => {
    // Read the BINDING the import actually creates, rather than guessing it
    // from the slug. `dev-servers.json` binds `devServers`, so any rule that
    // derives an identifier by stripping punctuation gets `devservers` and
    // misses.
    const importMatch = registry.match(new RegExp(`import\\s+([A-Za-z0-9_$]+)\\s+from\\s+['"]\\./${name}\\.json['"]`));
    const imported = Boolean(importMatch);
    const binding = importMatch ? importMatch[1] : null;
    // The map entry may be `name: value`, `'name': value`, or ES6 SHORTHAND
    // (`binding,` / `binding}`). Version one required a colon, so every
    // shorthand entry read "imported but not in PLUGINS map". On 2026-08-19
    // that put qloop, quoxslots, quoxbuild and gripe red against a registry
    // where all four are imported at lines 68-71 and mapped at 130-133 —
    // correct code, failing gate. Shorthand is the normal style in this file,
    // so the checker was wrong about the majority case, not an edge case.
    const mapped = new RegExp(`['"]?${name}['"]?\\s*:`).test(registry)
      || (binding !== null && new RegExp(`(^|[{,\\s])${binding}\\s*[,}]`, 'm').test(registry));
    if (imported && mapped) return { status: 'green', detail: 'src/config/plugins/index.js', evidence: [{ file: 'src/config/plugins/index.js', line: lineOf(registry, importMatch.index) }] };
    if (!imported && !mapped) return { status: 'red', detail: 'absent from src/config/plugins/index.js' };
    return { status: 'red', detail: imported ? 'imported but not in PLUGINS map' : 'in map but not imported' };
  });

  // Renamed from "route registered with matching pluginId". The old wording,
  // sitting in a licensing checklist, read as proof the route was licence
  // gated. It is not: core routes are guarded by minRole/auditorAllowed only
  // (src/App.jsx), licence filtering happens in the SIDEBAR (AppShell), and
  // typing the URL still reaches the view. pluginId on a core route is
  // metadata. The real refusal is server-side and is point 5.2 below.
  //
  // Route-level enforcement is NOT a quick win and must not be bolted on:
  // isPluginLicensed fails closed while entitlements are still loading, so
  // gating render on it would flash — or strand — a Locked page for a paying
  // org that deep-links to its own plugin. That needs an entitlements-loaded
  // signal first. Filed rather than faked.
  add('3', 'dashboard route declared (metadata, not a gate — see 5.2)', () => {
    const routeHit = new RegExp(`pluginId:\\s*['"]${name}['"]`).exec(routes);
    if (routeHit) {
      return { status: 'green', detail: 'src/config/routeRegistry.js', evidence: [{ file: 'src/config/routeRegistry.js', line: lineOf(routes, routeHit.index) }] };
    }
    // A core-free plugin's route carries no pluginId (there is nothing to
    // gate), so a route registered at the plugin's own path counts too.
    const pathHit = new RegExp(`path:\\s*['"]/${name}['"]`).exec(routes);
    if (pathHit) {
      return { status: 'green', detail: `src/config/routeRegistry.js (path /${name})`, evidence: [{ file: 'src/config/routeRegistry.js', line: lineOf(routes, pathHit.index) }] };
    }
    // LICENSE-LAUNCH LL-7 (2026-08-29/30) moved first-party dev-bundle
    // plugins' routes OUT of this static array and into their signed plugin
    // bundle entry (plugins-src/<name>/index.jsx), which registers routes at
    // runtime via window.__quoxPluginRegister(PLUGIN_ID, { routes: {...} })
    // rather than a `pluginId:` literal here. QuoxPlan and dev-servers still
    // own a real route each — the static grep above just went blind to it
    // the day the strip landed. Same evidence discipline as every other
    // check: grep the file that actually owns the wiring now.
    const bundleEntry = readCode(path.join(DASH, 'plugins-src', name, 'index.jsx'));
    if (bundleEntry
      && new RegExp(`PLUGIN_ID\\s*=\\s*['"]${name}['"]`).test(bundleEntry)
      && /routes:\s*\{[^}]*['"][^'"]+['"]\s*:/.test(bundleEntry)) {
      return { status: 'green', detail: `plugins-src/${name}/index.jsx (signed bundle route)`, evidence: [{ file: `plugins-src/${name}/index.jsx`, line: 1 }] };
    }
    // A plugin with no route of its own is not automatically a defect: it may
    // be CLI-only, a tab on another surface, or an execution mode of a core
    // route. But the exemption must be DECLARED in the manifest, never
    // inferred from absence, or "no route" and "forgot the route" look
    // identical to this checker.
    // Only the three real exemptions (the same set point 4 honours). Any
    // other value, "route" or "own" included, CLAIMS a route, so its absence
    // is a defect: a declaration must never excuse the thing it promises.
    const surface = (manifest && manifest.dashboardSurface) || null;
    if (surface === 'cli' || surface === 'embedded' || surface === 'shared') {
      const why = (manifest && manifest.dashboardSurfaceNote) || 'no reason declared';
      return { status: 'na', detail: `declared dashboardSurface: ${surface} — ${why}` };
    }
    if (surface) return { status: 'red', detail: `manifest declares dashboardSurface '${surface}', which claims a route, but no routeRegistry entry carries pluginId '${name}' or path '/${name}'` };
    return { status: 'red', detail: `no routeRegistry entry carries pluginId '${name}', and no dashboardSurface declared in the manifest` };
  });

  add('4', 'nav entry present', () => {
    const navHit = new RegExp(`['"/]${name}['"]`).exec(nav);
    if (navHit) return { status: 'green', detail: 'src/config/navRegistry.js', evidence: [{ file: 'src/config/navRegistry.js', line: lineOf(nav, navHit.index) }] };
    // Same declared-exemption rule as point 3. A CLI-only plugin has nothing
    // to put in a sidebar, and an embedded one is reached from its parent
    // surface. Absence still has to be DECLARED — this check exists because
    // /dev-suite shipped with no sidebar entry at all and nobody noticed for
    // days, since everyone tested by navigating straight to the URL.
    const surface = (manifest && manifest.dashboardSurface) || null;
    if (surface === 'cli' || surface === 'embedded' || surface === 'shared') {
      const why = (manifest && manifest.dashboardSurfaceNote) || 'no reason declared';
      return { status: 'na', detail: `declared dashboardSurface: ${surface} — ${why}` };
    }
    return { status: 'red', detail: 'not in navRegistry; reachable only by URL' };
  });

  add('6', 'dashboard API client targets the governed proxy', () => {
    const clientDir = path.join(DASH, 'src/components', name, 'lib');
    if (!fs.existsSync(clientDir)) return { status: 'amber', detail: `no ${path.relative(DASH, clientDir)} (not a dev-bundle view, or different layout)` };
    const files = fs.readdirSync(clientDir).filter((f) => f.endsWith('.js'));
    // Strip comments before matching. This check flagged Qlarity's client for
    // "mixing the proxy with a direct port" because a COMMENT explained why
    // talking to :3109 directly would be ungoverned. Fifth occurrence of the
    // same class in this stream: a regex over prose cannot tell an assertion
    // from its negation, and a well-documented file is the likeliest to name
    // the thing it refuses to do. Read code, never commentary.
    const bodies = files
      .map((f) => read(path.join(clientDir, f)) || '')
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const viaProxy = bodies.includes(`/api/v1/${name}`);
    const directPort = /:3\d{3}|:5\d{3}|:9\d{3}/.test(bodies);
    if (viaProxy && !directPort) return { status: 'green', detail: `client uses /api/v1/${name}` };
    if (viaProxy && directPort) return { status: 'red', detail: 'client mixes the proxy with a direct service port' };
    return { status: 'red', detail: 'client does not use the governed /api/v1 proxy' };
  });

  // Which alias actually owns routes (resolved through modules, not by substring).
  const proxyAlias = firstHit((a) => (resolvedRoutes.some((r) => underAlias(r.path, a)) ? a : null));
  add('7', 'collector proxy route exists', () => {
    if (proxyAlias) {
      const mine = resolvedRoutes.filter((r) => underAlias(r.path, proxyAlias));
      const via = [...new Set(mine.map((r) => r.file))].join(', ');
      return { status: 'green', detail: `${mine.length} route(s) at /api/v1/${proxyAlias} (${via})`, evidence: routeEvidence(mine) };
    }
    // The alias is referenced but no registration could be followed: the
    // doctor does not know, and "does not know" is never "absent" or "fine".
    if (routeCoverageUnknown || aliasMentioned) {
      return {
        status: 'amber',
        detail: `/api/v1/{${svcs.join('|')}} is referenced by the collector but no route registration could be resolved (unsupported mount pattern?): ${[...opaqueRoutes.map((r) => `${r.file}:${r.line}`), ...unresolvedForAlias.map((u) => u.file)].join(', ') || 'mention only'}`,
        evidence: routeEvidence(opaqueRoutes),
      };
    }
    // Not every member serves its data through the collector's /api/v1 proxy,
    // and two of them differ ON PURPOSE. qloop's objectives are served by the
    // TASKS service at /api/objectives (authenticated + rate limited) because
    // QLoop is an execution mode of the core objectives engine, not a
    // standalone plugin backend. gripe has no HTTP data plane at all: it files
    // through the GRIPE agent and the github_create_issue tool.
    //
    // Those are architectural facts, not missing routes, but they must be
    // DECLARED in the manifest with the location, never inferred from absence,
    // or "serves elsewhere on purpose" and "forgot the proxy" look identical
    // here.
    const plane = manifest && manifest.dataPlane;
    if (plane && plane !== 'collector') {
      const why = (manifest && manifest.dataPlaneNote) || 'no location declared';
      return { status: 'na', detail: `declared dataPlane: ${plane} — ${why}` };
    }
    return { status: 'red', detail: `no /api/v1/{${svcs.join('|')}} route in the collector, and no dataPlane declared — ungoverned` };
  });

  add('8-9', 'writes emit evidence (AEE envelope)', () => {
    // Match the EMITTER, never the vocabulary, and never a comment (comments
    // are blanked before any of this runs). A write route passes when its own
    // handler contains a real emitter OR calls a function that, within the
    // module it was registered from (two require levels deep), does. That is
    // how ContactsQ and NotesQ emit: the route is one line, the evidence call
    // sits in the service function it delegates to.
    //
    // app.all / app.use HANDLE WRITES TOO: a catch-all write proxy must not
    // read as "nothing to emit".
    if (!resolvedRoutes.length) {
      return { status: 'amber', detail: 'no route registrations could be resolved for this plugin, so write evidence cannot be judged (never assumed read-only)' };
    }
    const mine = resolvedRoutes.filter((r) => svcs.some((a) => underAlias(r.path, a)));
    const writes = mine.filter((r) => WRITE_METHODS.has(r.method));
    const exempt = (manifest && Array.isArray(manifest.evidenceExempt)) ? manifest.evidenceExempt : [];
    const silent = [];
    const exempted = [];
    const maybe = [];
    for (const w of writes) {
      const fns = table.closureFor(w.owner);
      const toks = tokens(w.handler);
      const emitting = closureNames(fns, EMITTER);
      if (EMITTER.test(w.handler) || [...toks].some((t) => emitting.has(t))) continue;
      if (exempt.includes(w.path)) { exempted.push(w); continue; }
      const loose = closureNames(fns.optimistic, EMITTER);
      if ([...toks].some((t) => loose.has(t))) maybe.push(w);
      else silent.push(w);
    }
    if (silent.length) {
      return {
        status: 'red',
        detail: `${silent.length} of ${writes.length} write route(s) emit NO evidence (${[...new Set(silent.map((s) => s.path))].slice(0, 3).join(', ')}) — silent evidence loss`,
        evidence: routeEvidence(silent),
      };
    }
    if (maybe.length) {
      return {
        status: 'amber',
        detail: `${maybe.length} of ${writes.length} write route(s) delegate through a function name defined in more than one module, so the emitter cannot be pinned (${[...new Set(maybe.map((s) => s.path))].slice(0, 3).join(', ')})`,
        evidence: routeEvidence(maybe),
      };
    }
    if (routeCoverageUnknown) {
      return { status: 'amber', detail: `${writes.length} resolved write route(s) emit, but part of the route table is opaque (${opaqueRoutes.length} unresolved mount(s)); cannot call it complete`, evidence: routeEvidence(writes) };
    }
    if (!writes.length) {
      // Only here is "read-only" a conclusion: routes WERE found, all reads.
      return { status: 'na', detail: `all ${mine.length} resolved route(s) are reads — nothing to emit (read-only surface)`, evidence: routeEvidence(mine) };
    }
    if (exempted.length) {
      const why = (manifest && manifest.evidenceExemptNote) || 'no reason declared';
      return {
        status: 'amber',
        detail: `${writes.length - exempted.length}/${writes.length} write route(s) emit; ${[...new Set(exempted.map((e) => e.path))].join(', ')} declared exempt — ${why}`,
        evidence: routeEvidence(writes),
      };
    }
    return { status: 'green', detail: `all ${writes.length} write route(s) emit evidence`, evidence: routeEvidence(writes) };
  });

  add('11', 'entitlement: GOVERNED_PLUGIN_IDS contains it', () => {
    // A core-free plugin has no paid gate by contract; "ungoverned" is the
    // intended state, not a finding (audit finding 2: ContactsQ read red here).
    if (coreFree) return { status: 'na', detail: 'core-free: manifest tier declares no paid gate, so no entitlement is expected' };
    // Bound the search to the ACTUAL array literal, never a fixed byte window
    // (version one sliced 2000 chars and reported five of six dev-suite
    // plugins red while they sat plainly in a 6132-char list).
    const start = entitlements.indexOf('GOVERNED_PLUGIN_IDS');
    if (start === -1) return { status: 'red', detail: 'GOVERNED_PLUGIN_IDS not found in services/auth/lib/entitlements.js' };
    const rest = entitlements.slice(start);
    const open = rest.indexOf('[');
    const close = rest.indexOf(']', open);
    if (open === -1 || close === -1) return { status: 'amber', detail: 'could not bound the GOVERNED_PLUGIN_IDS array literal — check by hand' };
    const block = rest.slice(open, close);
    const hit = new RegExp(`['"]${name}['"]`).exec(block);
    if (hit) return { status: 'green', detail: 'services/auth/lib/entitlements.js', evidence: [{ file: 'services/auth/lib/entitlements.js', line: lineOf(entitlements, start + open + hit.index) }] };
    return { status: 'red', detail: 'not governed — installable free forever (defect 5.3 risk on retrofit)' };
  });

  add('5.2', 'licence gate on the collector proxy', () => {
    if (coreFree) return { status: 'na', detail: 'core-free: manifest tier declares no paid gate, so no licence refusal is expected' };
    if (!resolvedRoutes.length) {
      const plane = manifest && manifest.dataPlane;
      if (plane && plane !== 'collector') return { status: 'na', detail: `declared dataPlane: ${plane}, no collector proxy to gate (see point 7)` };
      return { status: 'amber', detail: 'no collector routes resolved for this plugin, so the licence gate cannot be judged (see point 7)' };
    }
    // Match ENFORCEMENT in code, never vocabulary (the first version of this
    // check matched the comment SAYING "no license gate yet" and reported
    // QuoxPlan green). Each route is judged on its own handler plus the
    // functions it delegates to inside its module; a refusal is judged by
    // contract, so a 402 or a 403 naming the licence both count.
    //
    // Green requires EVERY route under the alias to enforce. "One of them is
    // gated" is not an answer to "can an unlicensed org use this".
    const svcRoutes = resolvedRoutes.filter((r) => svcs.some((a) => underAlias(r.path, a)));
    const ungated = [];
    const maybeGated = [];
    for (const r of svcRoutes) {
      const fns = table.closureFor(r.owner);
      const toks = tokens(r.handler);
      const enforcing = closureNames(fns, ENFORCE);
      if (ENFORCE.test(r.handler) || [...toks].some((t) => enforcing.has(t))) continue;
      const loose = closureNames(fns.optimistic, ENFORCE);
      if ([...toks].some((t) => loose.has(t))) maybeGated.push(r);
      else ungated.push(r);
    }
    if (ungated.length) {
      const paths = [...new Set(ungated.map((r) => r.path))];
      return {
        status: 'red',
        detail: `${ungated.length} of ${svcRoutes.length} route(s) have NO licence enforcement (${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ', …' : ''}) — a paid plugin shipping free (defect 5.2)`,
        evidence: routeEvidence(ungated),
      };
    }
    if (maybeGated.length) {
      return { status: 'amber', detail: `${maybeGated.length} of ${svcRoutes.length} route(s) reach a licence check only through a function name defined in more than one module; cannot pin it`, evidence: routeEvidence(maybeGated) };
    }
    if (routeCoverageUnknown) {
      return { status: 'amber', detail: `${svcRoutes.length} resolved route(s) enforce a licence, but ${opaqueRoutes.length} mount(s) are opaque; cannot call the surface gated`, evidence: routeEvidence(svcRoutes) };
    }
    return { status: 'green', detail: `all ${svcRoutes.length} route(s) enforce a licence`, evidence: routeEvidence(svcRoutes) };
  });

  add('12', 'compose service + service URL on the collector', () => {
    if (!hasServiceRepo) return { status: 'na', detail: 'no service repo — dashboard-only plugin, compose not applicable' };
    const svcInCompose = svcs.some((a) => new RegExp(`^\\s{2}${a.replace(/^quox-?/, '(quox-?)?')}:`, 'm').test(compose));
    const url = svcs.some((a) => new RegExp(`${a.replace(/-/g, '_').toUpperCase()}_URL|${a.replace(/^quox-?/, '').replace(/-/g, '_').toUpperCase()}_URL`).test(compose));
    if (svcInCompose && url) return { status: 'green', detail: 'docker-compose.yml' };
    if (svcInCompose) return { status: 'red', detail: 'service present but no *_URL env on the collector — works on host, dies in prod' };
    return { status: 'red', detail: 'service not in docker-compose.yml' };
  });

  add('13a', 'quoxpert skill directory', () => {
    if (!skillsRoot || !fs.existsSync(skillsRoot)) return { status: 'amber', detail: `skills root not available (${skillsRoot || 'unset'}); pass --skills-root` };
    const short = name.replace(/^quox-?/, '');
    const candidates = [...new Set([`quoxpert-${name}`, `quoxpert-${short}`, ...svcs.map((a) => `quoxpert-${a}`)])];
    for (const c of candidates) {
      if (fs.existsSync(path.join(skillsRoot, c))) return { status: 'green', detail: `skills/${c}`, evidence: [{ file: `skills/${c}`, line: 1 }] };
    }
    return { status: 'red', detail: `no ${candidates.join(' or ')} — a Claude cannot drive it headless` };
  });

  add('5.5', 'manifest links agree with the website nav', () => {
    if (!manifest) return { status: 'amber', detail: 'no manifest to check' };
    const links = [manifest.docsUrl, manifest.infoUrl].filter(Boolean);
    if (!links.length) return { status: 'red', detail: 'manifest declares no docsUrl/infoUrl at all' };
    if (!websiteNavPath || !websiteNav) return { status: 'amber', detail: 'website nav not readable (pass --website-root)' };
    const disagreements = [];
    for (const link of links) {
      const p = link.replace(/^https?:\/\/[^/]+/, '');
      if (!websiteNav.includes(p)) disagreements.push(p);
    }
    if (disagreements.length) return { status: 'red', detail: `not in website nav: ${disagreements.join(', ')} (defect 5.5 — link check, not a judgement call)` };
    return { status: 'green', detail: 'manifest links appear in the website nav' };
  });

  add('5.1', 'standalone CLI defaults to the governed path', () => {
    if (!hasServiceRepo) return { status: 'na', detail: 'no service repo, no standalone CLI to check' };
    const cliDir = path.join(repoDir, 'cli');
    if (!fs.existsSync(cliDir)) return { status: 'amber', detail: 'service repo has no cli/' };
    // Find the client and ask which base URL wins by DEFAULT.
    let verdict = null;
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory() && f.name !== 'node_modules' && f.name !== 'test') walk(path.join(dir, f.name));
        else if (f.name.endsWith('.js')) {
          const body = read(path.join(dir, f.name)) || '';
          if (/localhost:\d{4}/.test(body) && /BASE|baseUrl|directBase/i.test(body)) {
            // Direct default is fine ONLY if mutations are routed via a
            // collector base; look for the collector path in the same file.
            const governedWrites = /collector/i.test(body) && /api\/v1/.test(body);
            // A governed path that only engages when an env key is exported is
            // not the default; it is opt-in governance, which is defect 5.1 by
            // definition. QuoxPlan's client does exactly this
            // (QUOX_INTERNAL_SERVICE_KEY guard at client.js:44) and every
            // unconfigured session writes unwitnessed with a warning nobody
            // reads twice.
            const keyGuarded = /SERVICE_KEY/.test(body);
            verdict = governedWrites && !keyGuarded
              ? { status: 'green', detail: `${path.relative(repoDir, path.join(dir, f.name))}: writes route via the collector by default` }
              : { status: 'red', detail: governedWrites
                  ? `${path.relative(repoDir, path.join(dir, f.name))}: governed path exists but is gated on an env key — the DEFAULT is direct and unwitnessed (defect 5.1)`
                  : `${path.relative(repoDir, path.join(dir, f.name))}: defaults to the direct service URL with no governed write path (defect 5.1 — unwitnessed writes)` };
          }
        }
      }
    };
    walk(cliDir);
    return verdict || { status: 'amber', detail: 'no direct-URL default found; confirm by reading the client' };
  });

  add('AC', 'agent chain wired end to end', () => {
    // The step ContactsQ missed (SDK-TEAM W0-P3 baseline, the #1 defect class;
    // repair f8b6e0057 touched 12 files). A plugin with an agent is not wired by
    // the registry JSON alone: the agent has to exist in five registries, hold
    // a tool grant, be reachable by the orchestrator, and have its chat sidebar
    // mounted in the plugin view. Each link is a code-position grep (comments
    // blanked), and a partial chain is a FAIL naming exactly what is missing.
    const short = name.replace(/^quox-?/, '');
    const ids = [...new Set([
      ...(manifest && typeof manifest.agent === 'string' ? [manifest.agent] : []),
      ...(manifest && manifest.agent && manifest.agent.id ? [manifest.agent.id] : []),
      ...(manifest && typeof manifest.agentId === 'string' ? [manifest.agentId] : []),
      name, short,
    ])];
    const declared = Boolean(manifest && (manifest.agent || manifest.agentId));
    const q = (id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keyRe = (id) => new RegExp(`(?:^|[\\s,{])['"]?${q(id)}['"]?\\s*:`, 'm');
    const file = (rel) => path.join(DASH, rel);

    const entityDir = 'src/config/entities/assistants';
    const agentRegistry = readCode(file('src/config/agentRegistry.js')) || '';
    const entityRegistry = readCode(file('src/services/entityRegistry.js')) || '';
    const agentToolsSrc = readCode(file('services/collector/lib/agentTools.js')) || '';
    const delegator = readCode(file('src/services/agentDelegator.js')) || '';

    // Block of `const AGENT_TOOLS = { ... }` / `DEFAULT_ASSISTANTS = { ... }`.
    const blockOf = (code, token) => {
      const at = new RegExp(`(?:const|let|var)\\s+${token}\\s*=\\s*\\{`).exec(code);
      if (!at) return null;
      const open = at.index + at[0].length - 1;
      const end = matchClose(code, open);
      return end < 0 ? null : { text: code.slice(open, end), offset: open };
    };
    const toolsBlock = blockOf(agentToolsSrc, 'AGENT_TOOLS');
    const defaultsBlock = blockOf(entityRegistry, 'DEFAULT_ASSISTANTS');
    const compDirs = [...new Set([name, short])].map((d) => path.join(DASH, 'src/components', d)).filter((d) => fs.existsSync(d));
    const listJsx = (dir) => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(path.join(d, e.name)); }
          else if (/\.(jsx|js|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(path.join(d, e.name));
        }
      };
      walk(dir);
      return out;
    };
    const sidebarFiles = compDirs.flatMap(listJsx).filter((f) => /ChatSidebar\.(jsx|js|tsx)$/.test(f));

    // Which of the candidate ids is the agent? The one with the most links wired.
    const probe = (id) => {
      const evidence = [];
      const missing = [];
      const ent = file(`${entityDir}/${id}.json`);
      if (fs.existsSync(ent)) evidence.push({ file: `${entityDir}/${id}.json`, line: 1 }); else missing.push(`entity JSON (${entityDir}/${id}.json)`);

      const ar = keyRe(id).exec(agentRegistry);
      if (ar) evidence.push({ file: 'src/config/agentRegistry.js', line: lineOf(agentRegistry, ar.index) }); else missing.push('agentRegistry entry');

      const imp = new RegExp(`import\\s+[A-Za-z0-9_$]+\\s+from\\s+['"][^'"]*assistants/${q(id)}\\.json['"]`).exec(entityRegistry);
      const inDefaults = defaultsBlock && keyRe(id).test(defaultsBlock.text);
      if (imp && inDefaults) evidence.push({ file: 'src/services/entityRegistry.js', line: lineOf(entityRegistry, imp.index) });
      else missing.push(`entityRegistry DEFAULT_ASSISTANTS ${imp ? 'entry' : inDefaults ? 'import' : 'import + entry'}`);

      const grant = toolsBlock && new RegExp(`(?:^|[\\s,{])['"]?${q(id)}['"]?\\s*:\\s*\\[`, 'm').exec(toolsBlock.text);
      if (grant) evidence.push({ file: 'services/collector/lib/agentTools.js', line: lineOf(agentToolsSrc, toolsBlock.offset + grant.index) });
      else missing.push('AGENT_TOOLS grant (services/collector/lib/agentTools.js)');

      const dk = new RegExp(`(?:^|[\\s,{])['"]?${q(id)}['"]?\\s*:\\s*\\[`, 'm').exec(delegator);
      if (dk) evidence.push({ file: 'src/services/agentDelegator.js', line: lineOf(delegator, dk.index) }); else missing.push('delegator keywords (src/services/agentDelegator.js)');

      const cd = new RegExp(`canDelegateTo\\s*:\\s*\\[[^\\]]*['"]${q(id)}['"]`).exec(agentRegistry);
      if (cd) evidence.push({ file: 'src/config/agentRegistry.js', line: lineOf(agentRegistry, cd.index) }); else missing.push('CommanderQ canDelegateTo entry');

      // A sidebar that exists but is never rendered is not "mounted in the plugin view".
      let mounted = null;
      for (const sf of sidebarFiles) {
        const comp = path.basename(sf).replace(/\.(jsx|js|tsx)$/, '');
        for (const f of compDirs.flatMap(listJsx)) {
          if (f === sf) continue;
          const code = readCode(f) || '';
          const m = new RegExp(`<${q(comp)}\\b`).exec(code);
          if (m) { mounted = { file: path.relative(DASH, f), line: lineOf(code, m.index) }; break; }
        }
        if (mounted) break;
      }
      if (mounted) evidence.push(mounted);
      else missing.push(sidebarFiles.length ? 'ChatSidebar not mounted in the plugin view' : `ChatSidebar component (src/components/${name}/*ChatSidebar.jsx)`);
      return { id, evidence, missing };
    };

    const probes = ids.map(probe);
    const best = probes.reduce((a, b) => (b.evidence.length > a.evidence.length ? b : a));
    // The ChatSidebar link is plugin-wide (not per id), so it does not count as
    // an "agent exists" signal on its own unless something else is wired too.
    const agentSignals = best.evidence.filter((e) => !/ChatSidebar|\/components\//.test(e.file)).length;
    if (!declared && agentSignals === 0 && !sidebarFiles.length) {
      return { status: 'na', detail: 'no agent declared in the manifest and none found in any registry: this plugin has no agent' };
    }
    if (best.missing.length) {
      return { status: 'red', detail: `agent '${best.id}' chain incomplete, missing: ${best.missing.join('; ')}`, evidence: best.evidence };
    }
    return { status: 'green', detail: `agent '${best.id}': all ${best.evidence.length} chain links present`, evidence: best.evidence };
  });

  return checks;
}


const CHECK_IDS = {
  1: 'doctor.manifest',
  2: 'doctor.registry_entry',
  3: 'doctor.dashboard_route',
  4: 'doctor.nav_entry',
  6: 'doctor.client_governed_proxy',
  7: 'doctor.collector_route',
  '8-9': 'doctor.evidence_emission',
  11: 'doctor.entitlement_governed',
  '5.2': 'doctor.licence_gate',
  12: 'doctor.compose_service',
  '13a': 'doctor.quoxpert_skill',
  '5.5': 'doctor.website_nav_links',
  '5.1': 'doctor.cli_governed_default',
  'AC': 'doctor.agent_chain',
};

const STATUS_OUT = { green: 'pass', red: 'fail', amber: 'unknown', na: 'na' };

/** Fixed-argument git (execFile, never a shell). ref/tree are null unless root IS a git toplevel. */
function gitInfo(root) {
  const g = (...a) => {
    try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  };
  const abs = path.resolve(root);
  const top = g('rev-parse', '--show-toplevel');
  let isTop = false;
  try { isTop = Boolean(top) && fs.realpathSync(top) === fs.realpathSync(abs); } catch { /* not a repo */ }
  if (!isTop) return { root: abs, ref: null, tree: null, dirty: true };
  const status = g('status', '--porcelain');
  return { root: abs, ref: g('rev-parse', 'HEAD'), tree: g('rev-parse', 'HEAD^{tree}'), dirty: status === null ? true : status.length > 0 };
}

/** The repo containing cwd when it looks like quox-dashboard, else ~/quox-dashboard. */
export function resolveRoot(explicit, cwd = process.cwd()) {
  if (explicit) return path.resolve(explicit);
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top && fs.existsSync(path.join(top, 'src/config/plugins/index.js'))) return top;
  } catch { /* not in a repo */ }
  return path.join(HOME, 'quox-dashboard');
}

export function toContract(name, checks, root) {
  return {
    contract: CONTRACT,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
    subject: name,
    repo: gitInfo(root),
    generated_at: new Date().toISOString(),
    checks: checks.map((c) => {
      const o = {
        id: c.id,
        status: STATUS_OUT[c.status],
        detail: String(c.detail || '').split('\n')[0],
        evidence: c.evidence || [],
        point: c.point,
        label: c.label,
      };
      if (c.status === 'na') o.na_reason = String(c.detail || 'not applicable');
      return o;
    }),
  };
}

export function registerPluginDoctor(pluginCmd) {
  pluginCmd
    .command('doctor <name>')
    .option('--root <path>', 'quox-dashboard checkout to check (default: the repo containing cwd, else ~/quox-dashboard)')
    .option('--website-root <path>', 'quox-website checkout for the nav-link check (default: ~/quox-website; unreadable => unknown)')
    .option('--skills-root <path>', 'skills directory for the quoxpert-skill check (default: ~/.claude/skills; missing => unknown)')
    .option('--out <file>', 'also write the quox.external-verdict/v1 JSON verdict file here')
    .option('--service <names>', 'backend alias(es), comma-separated, when they differ from the plugin id (e.g. quox-nucleus -> nucleus,repobrain)')
    .description('Check a plugin against the dev-bundle DoD: 13-point chain + the five prohibitions. Machine evidence only; exit 0 green, 1 findings, 2 cannot evaluate.')
    .action((name, options, command) => {
      // --json is a program-level option in this CLI (bin/quox.js:76); read it
      // through the globals rather than declaring a shadow that never fills.
      // The acceptance test caught this: doctor --json emitted the human
      // render, which JSON.parse choked on.
      const wantJson = command.optsWithGlobals?.().json
        || command.optsWithGlobals?.().output === 'json'
        || options.json;
      if (!/^[a-z0-9-]+$/.test(name)) {
        process.stderr.write('plugin names are lowercase kebab-case\n');
        process.exitCode = 2;
        return;
      }
      const root = resolveRoot(options.root);
      const checks = buildChecks(name, {
        root,
        service: options.service,
        websiteRoot: path.resolve(options.websiteRoot || path.join(HOME, 'quox-website')),
        skillsRoot: path.resolve(options.skillsRoot || path.join(HOME, '.claude/skills')),
      });
      const red = checks.filter((c) => c.status === 'red').length;
      const amber = checks.filter((c) => c.status === 'amber').length;
      const na = checks.filter((c) => c.status === 'na').length;
      // AMBER and N/A are different questions and must not share a number.
      // Amber means "this tool could not determine, and someone must". N/A
      // means "there is nothing here to determine" — a CLI-only plugin has no
      // nav entry to find, a dashboard-only plugin has no compose service.
      //
      // 2026-08-19: gripe scored "0 red, 8 amber, 5 green" and read as the
      // worst plugin in the bundle. Every one of those eight was N/A. The
      // scoreboard was making the simplest, most honest member look broken,
      // which is the opposite of what a status tool is for, and exactly the
      // kind of thing that makes someone distrust the whole board.
      const verdict = red ? 'FINDINGS' : amber ? 'INCOMPLETE' : 'GREEN';

      const contract = (wantJson || options.out) ? toContract(name, checks, root) : null;
      if (options.out) {
        fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(contract, null, 2)}\n`);
      }
      if (wantJson) {
        process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
      } else {
        const mark = { green: '✓', red: '✗', amber: '?', na: '–' };
        process.stdout.write(`\u{1F3C1} DONEENGINE: plugin doctor — ${name}: ${verdict}\n\n`);
        for (const c of checks) {
          process.stdout.write(`  ${mark[c.status]} [${c.point.padEnd(4)}] ${c.label}\n        ${c.detail}\n`);
        }
        process.stdout.write(`\n${red} red, ${amber} amber, ${na} n/a, ${checks.length - red - amber - na} green. `
          + 'Amber is not green: it means this tool could not determine, and someone must. '
          + 'N/A means there is nothing to determine (no nav entry for a CLI-only plugin, '
          + 'no compose service for a dashboard-only one) and needs no action.\n'
          + 'Reference: quox-dashboard/docs/DEVBUNDLE_DOD.md\n');
      }
      process.exitCode = red ? 1 : amber ? 2 : 0;
    });
}

export default registerPluginDoctor;

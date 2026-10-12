#!/usr/bin/env node
/**
 * setec-inventory.mjs - SETEC env-only-settings guardrail (SETEC-S1).
 *
 * WHY: the old ratchet (scripts/pre-commit-env-check.sh, VAULT-INTEG P13)
 * only blocked a NEW `process.env.X` under services/ that was missing from
 * services/shared/envRegistry.cjs. Measured failures on 2026-10-09: the
 * registry's `surface` claim was never verified (most "instance settings"
 * claims appear nowhere in the UI), only services/ and only the dotted form
 * were scanned, and QUOX_ENV_SKIP=1 bypassed silently.
 *
 * This tool inventories EVERY env read in the repo, joins it to the registry,
 * and verifies each surface claim against something that really exists.
 *
 * READ FORMS DETECTED (comment-only lines are skipped):
 *   process.env.X            process.env['X'] / process.env["X"]
 *   const { A, B: b, C = 1 } = process.env     (multi-line ok)
 *   import.meta.env.X        import.meta.env['X']
 *   alias.X / alias['X']     where `alias = process.env` (or import.meta.env)
 *                            appears in the same file (best effort: only
 *                            ALL_CAPS names are taken from aliases, to avoid
 *                            treating `env.mode` style properties as vars).
 * NOT detected: computed keys (process.env[name]), env passed across files.
 *
 * SURFACE VERIFICATION (verifySurface):
 *   'platform settings registry' -> var is a `key:` of a classification:'user'
 *                                   entry in services/collector/lib/platformCapabilities.js
 *   vault/integration id (smtp..) -> id is an `id:` in
 *                                   services/auth/config/integrationTypeRegistry.js
 *   'instance settings'          -> src/config/instanceSettingsSurface.json exists
 *                                   AND lists the var (array of names, {vars:[..]},
 *                                   or an object keyed by name). Until it lands: unverified.
 *   'setup wizard' / 'org settings: X' -> var name appears in a non-test src/ file
 *                                   (best effort: a src file that merely reads the
 *                                   same var also satisfies this).
 *   classification 'secret'      -> verified only if surface is a vault type, or
 *                                   the note says bootstrap-only.
 *   anything else                -> unverified. surface null = no claim (not counted).
 *
 * Usage:
 *   node scripts/setec-inventory.mjs                  summary
 *   node scripts/setec-inventory.mjs --json out.json  full ledger
 *   node scripts/setec-inventory.mjs --check          exit 1 on NEW gaps vs baseline
 *   node scripts/setec-inventory.mjs --write-baseline  record today's gaps
 *   --root <dir> and --baseline <file> override the defaults (used by tests).
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

const SRC_EXT = /\.(js|cjs|mjs|jsx|ts|tsx)$/;
const EXCLUDED_DIRS = new Set([
    'node_modules', 'dist', '.git', 'test', 'tests', '__tests__',
    'tests-integration', 'tests-smoke', 'coverage', 'build',
]);
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;
const EXCLUDED_FILES = new Set([
    'services/shared/envRegistry.cjs',
    'scripts/setec-inventory.mjs',
    'scripts/generate-env-registry-seed.mjs',
]);

export function sourceFiles(root) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (EXCLUDED_DIRS.has(e.name)) continue;
            // sibling worktrees / nested checkouts live next to or under the repo
            if (e.isDirectory() && /-wt-/.test(e.name)) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (SRC_EXT.test(e.name) && !TEST_FILE.test(e.name)) {
                const rel = path.relative(root, full).split(path.sep).join('/');
                if (!EXCLUDED_FILES.has(rel)) out.push(rel);
            }
        }
    };
    walk(root);
    return out;
}

function stripComments(src) {
    // Drop block comments and whole-line // comments. Not a parser: a
    // trailing `// x` after code is kept (reads there are still reads).
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .split('\n')
        .map((l) => (l.trim().startsWith('//') ? '' : l))
        .join('\n');
}

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';

/** Extract env var names read in one file's source text. Returns Set<string>. */
export function extractEnvReads(source) {
    const src = stripComments(source);
    const names = new Set();
    const add = (n) => { if (n) names.add(n); };

    for (const m of src.matchAll(new RegExp(`(?:process\\.env|import\\.meta\\.env)\\.(${IDENT})`, 'g'))) add(m[1]);
    for (const m of src.matchAll(/(?:process\.env|import\.meta\.env)\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) add(m[1]);

    // destructuring
    for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b(?!\s*[.[])/g)) {
        for (const part of m[1].split(',')) {
            const p = part.trim();
            if (!p || p.startsWith('...')) continue;
            const mm = p.match(new RegExp(`^(${IDENT})`));
            if (mm) add(mm[1]);
        }
    }

    // aliases: `env = process.env` / `const e = process.env;` / `(env = process.env)`
    const aliases = new Set();
    for (const m of src.matchAll(new RegExp(`\\b(${IDENT})\\s*=\\s*(?:process\\.env|import\\.meta\\.env)\\b(?!\\s*[.[])`, 'g'))) {
        aliases.add(m[1]);
    }
    for (const a of aliases) {
        const esc = a.replace(/\$/g, '\\$');
        for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc}\\.([A-Z][A-Z0-9_]*)\\b`, 'g'))) add(m[1]);
        for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc}\\s*\\[\\s*['"]([A-Z][A-Z0-9_]*)['"]\\s*\\]`, 'g'))) add(m[1]);
    }
    return names;
}

// ---------------------------------------------------------------- context

function readOr(file, fallback = '') {
    try { return readFileSync(file, 'utf8'); } catch { return fallback; }
}

/**
 * Keys of platformCapabilities.js entries. Every entry is SHOWN on the platform
 * settings surface; only classification:'user' ones are EDITABLE there
 * ('operator' = visibility only). A claim is verified when the setting is shown;
 * editability is reported separately (SETEC S3 moves tunables to editable).
 * Returns a Set of shown keys with an `editable` Set attached.
 */
export function parsePlatformKeys(text) {
    const keys = new Set();
    const editable = new Set();
    const re = /\bkey:\s*['"]([A-Za-z0-9_]+)['"]/g;
    const hits = [...text.matchAll(re)];
    hits.forEach((h, i) => {
        const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
        const block = text.slice(h.index, end);
        keys.add(h[1]);
        if (/classification:\s*['"]user['"]/.test(block)) editable.add(h[1]);
    });
    keys.editable = editable;
    return keys;
}

export function parseIntegrationIds(text) {
    return new Set([...text.matchAll(/^\s+id:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]));
}

export function parseInstanceSurface(jsonText) {
    if (!jsonText) return null;
    try {
        const j = JSON.parse(jsonText);
        if (Array.isArray(j)) return new Set(j.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean));
        // gen-instance-settings-surface.mjs writes {_comment, names: [...]}
        const list = Array.isArray(j?.names) ? j.names : (Array.isArray(j?.vars) ? j.vars : null);
        if (list) return new Set(list.map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean));
        if (j && typeof j === 'object') return new Set(Object.keys(j));
    } catch { /* malformed: treat as absent */ }
    return null;
}

export function buildContext(root) {
    const files = sourceFiles(root);
    const srcText = files
        .filter((f) => f.startsWith('src/'))
        .map((f) => readOr(path.join(root, f)))
        .join('\n');
    return {
        platformKeys: parsePlatformKeys(readOr(path.join(root, 'services/collector/lib/platformCapabilities.js'))),
        integrationIds: parseIntegrationIds(readOr(path.join(root, 'services/auth/config/integrationTypeRegistry.js'))),
        instanceSurface: parseInstanceSurface(readOr(path.join(root, 'src/config/instanceSettingsSurface.json'), '')),
        srcHas: (name) => srcText.includes(name),
        files,
    };
}

/**
 * @param {{name:string, classification:string, surface:string|null, note?:string}} entry
 * @param {{platformKeys:Set<string>, integrationIds:Set<string>, instanceSurface:Set<string>|null, srcHas:(n:string)=>boolean}} ctx
 * @returns {{claim:boolean, verified:boolean, why:string}}
 */
export function verifySurface(entry, ctx) {
    const surface = entry.surface;
    if (!surface) return { claim: false, verified: false, why: 'no surface claimed' };
    const s = String(surface).trim();
    const vault = ctx.integrationIds.has(s);

    if (entry.classification === 'secret') {
        if (vault) return { claim: true, verified: true, why: `vault type '${s}' exists` };
        if (/bootstrap[- ]only/i.test(entry.note || '')) return { claim: true, verified: true, why: 'secret, note says bootstrap-only' };
        return { claim: true, verified: false, why: `secret with surface '${s}': not a vault type and not bootstrap-only` };
    }
    if (s === 'platform settings registry') {
        if (!ctx.platformKeys.has(entry.name)) return { claim: true, verified: false, why: 'not a key in platformCapabilities.js' };
        const editable = !!(ctx.platformKeys.editable && ctx.platformKeys.editable.has(entry.name));
        return { claim: true, verified: true, editable, why: editable ? 'editable key in platformCapabilities.js' : 'shown read-only in platformCapabilities.js (operator)' };
    }
    if (vault) return { claim: true, verified: true, why: `integration type '${s}' exists` };
    if (s === 'instance settings') {
        if (!ctx.instanceSurface) return { claim: true, verified: false, why: 'src/config/instanceSettingsSurface.json absent' };
        return ctx.instanceSurface.has(entry.name)
            ? { claim: true, verified: true, why: 'listed in instanceSettingsSurface.json' }
            : { claim: true, verified: false, why: 'not listed in instanceSettingsSurface.json' };
    }
    if (s === 'setup wizard' || /^org settings:/i.test(s)) {
        return ctx.srcHas(entry.name)
            ? { claim: true, verified: true, why: 'name appears in a src/ file' }
            : { claim: true, verified: false, why: 'name appears in no src/ file' };
    }
    return { claim: true, verified: false, why: `surface '${s}' has no verification rule` };
}

// ---------------------------------------------------------------- ledger

function loadRegistry(root) {
    const file = path.join(root, 'services/shared/envRegistry.cjs');
    if (!existsSync(file)) return [];
    const req = createRequire(import.meta.url);
    const mod = req(file);
    return mod.ENV_REGISTRY || [];
}

export function buildLedger(root = DEFAULT_ROOT) {
    const ctx = buildContext(root);
    const registry = loadRegistry(root);
    const regByName = new Map(registry.map((e) => [e.name, e]));
    const reads = new Map();
    for (const f of ctx.files) {
        let names;
        try { names = extractEnvReads(readFileSync(path.join(root, f), 'utf8')); } catch { continue; }
        for (const n of names) {
            if (!reads.has(n)) reads.set(n, new Set());
            reads.get(n).add(f);
        }
    }
    const vars = [...reads.keys()].sort().map((name) => {
        const files = [...reads.get(name)].sort();
        const reg = regByName.get(name);
        const v = reg ? verifySurface(reg, ctx) : { claim: false, verified: false, why: 'unregistered' };
        return {
            name, files,
            dirs: [...new Set(files.map((f) => f.split('/')[0]))].sort(),
            registered: !!reg,
            classification: reg?.classification ?? null,
            surface: reg?.surface ?? null,
            surfaceClaim: v.claim,
            surfaceVerified: v.verified,
            why: v.why,
        };
    });
    // registry entries not seen as a read still carry a claim worth checking
    const claims = registry.map((e) => ({ name: e.name, ...verifySurface(e, ctx) }));
    return { vars, claims, registryCount: registry.length };
}

export function computeGaps(ledger) {
    return {
        unregistered: ledger.vars.filter((v) => !v.registered).map((v) => v.name).sort(),
        unverifiedSurfaces: ledger.claims.filter((c) => c.claim && !c.verified).map((c) => c.name).sort(),
    };
}

export function runCheck(root, baselineFile) {
    const gaps = computeGaps(buildLedger(root));
    let base = { unregistered: [], unverifiedSurfaces: [] };
    if (existsSync(baselineFile)) base = JSON.parse(readFileSync(baselineFile, 'utf8'));
    const bu = new Set(base.unregistered || []);
    const bs = new Set(base.unverifiedSurfaces || []);
    const newUnregistered = gaps.unregistered.filter((n) => !bu.has(n));
    const newUnverified = gaps.unverifiedSurfaces.filter((n) => !bs.has(n));
    const fixedUnregistered = [...bu].filter((n) => !gaps.unregistered.includes(n));
    const fixedUnverified = [...bs].filter((n) => !gaps.unverifiedSurfaces.includes(n));
    return {
        ok: newUnregistered.length === 0 && newUnverified.length === 0,
        newUnregistered, newUnverified, fixedUnregistered, fixedUnverified, gaps, baseline: base,
    };
}

// ---------------------------------------------------------------- CLI

function main(argv) {
    const arg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
    const root = arg('--root') ? path.resolve(arg('--root')) : DEFAULT_ROOT;
    const baselineFile = arg('--baseline') ? path.resolve(arg('--baseline')) : path.join(root, 'scripts/setec-baseline.json');

    if (argv.includes('--check')) {
        const r = runCheck(root, baselineFile);
        if (r.fixedUnregistered.length || r.fixedUnverified.length) {
            console.warn(`[setec] baseline can shrink: ${r.fixedUnregistered.length} unregistered and ${r.fixedUnverified.length} unverified-surface entries are now fixed. Run --write-baseline.`);
        }
        if (!r.ok) {
            console.error('[setec] FAIL: new env-config gaps not in scripts/setec-baseline.json');
            if (r.newUnregistered.length) {
                console.error(`  Env vars read but not in services/shared/envRegistry.cjs (${r.newUnregistered.length}):`);
                r.newUnregistered.forEach((n) => console.error(`    - ${n}`));
            }
            if (r.newUnverified.length) {
                console.error(`  Registry entries whose surface claim cannot be verified (${r.newUnverified.length}):`);
                r.newUnverified.forEach((n) => console.error(`    - ${n}`));
            }
            console.error('  Fix: register the var with a surface that really exists (see header of scripts/setec-inventory.mjs).');
            process.exit(1);
        }
        console.log(`[setec] OK: no new gaps (baseline: ${r.baseline.unregistered?.length || 0} unregistered, ${r.baseline.unverifiedSurfaces?.length || 0} unverified surfaces)`);
        return;
    }

    const ledger = buildLedger(root);
    const gaps = computeGaps(ledger);
    if (argv.includes('--write-baseline')) {
        writeFileSync(baselineFile, JSON.stringify({
            _note: 'SETEC-S1 known gaps. Shrink only: --check fails on anything not listed here.',
            unregistered: gaps.unregistered,
            unverifiedSurfaces: gaps.unverifiedSurfaces,
        }, null, 2) + '\n');
        console.log(`[setec] wrote ${baselineFile}`);
    }
    if (arg('--json')) {
        writeFileSync(path.resolve(arg('--json')), JSON.stringify({ ...ledger, gaps }, null, 2) + '\n');
    }
    const byDir = {};
    for (const v of ledger.vars) for (const d of v.dirs) byDir[d] = (byDir[d] || 0) + 1;
    console.log(`vars read:               ${ledger.vars.length}`);
    console.log(`registry entries:        ${ledger.registryCount}`);
    console.log(`unregistered reads:      ${gaps.unregistered.length}`);
    console.log(`unverified surface claims: ${gaps.unverifiedSurfaces.length} of ${ledger.claims.filter((c) => c.claim).length} claims`);
    console.log('reads by top-level dir:  ' + Object.entries(byDir).sort().map(([d, n]) => `${d}=${n}`).join(' '));
    const bySurface = {};
    for (const c of ledger.claims.filter((x) => x.claim)) {
        const e = loadRegistry(root).find((r) => r.name === c.name);
        const k = `${e.surface} -> ${c.verified ? 'verified' : 'UNVERIFIED'}`;
        bySurface[k] = (bySurface[k] || 0) + 1;
    }
    Object.entries(bySurface).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

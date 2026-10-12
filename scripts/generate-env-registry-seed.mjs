#!/usr/bin/env node
/**
 * generate-env-registry-seed.mjs — VAULT-INTEG P13 env-config registry seed.
 *
 * INCIDENT (2026-09-06): ~105 env-only, user-facing settings existed with no
 * dashboard/Settings surface, and three feature flags in the UI LIED about
 * their own state because the code path that read them bypassed the
 * settings store and read process.env directly instead. There was no single
 * place naming every environment variable a service could read, so nobody
 * could audit "which of these need a Settings surface" (the "NO ENV-ONLY
 * CONFIG" rule) in one pass. VAULT-INTEG P13 stops the bleeding going
 * forward: it does not fix the ~105 existing violations (that is P14 — full
 * remediation is out of scope here), it just makes sure no NEW unregistered
 * process.env read can ship.
 *
 * This script is the discovery half of the ratchet. It walks services/
 * for non-test *.{js,cjs,mjs,ts} source and finds every literal
 * `process.env.NAME` read. It exports `discoverEnvVars()` so the
 * completeness test (src/test/envRegistryCompleteness.test.js) runs the
 * EXACT same scan against services/shared/envRegistry.cjs — "discovered"
 * means the same thing in both places, by construction, not by convention.
 *
 * Usage:
 *   node scripts/generate-env-registry-seed.mjs            # print a summary, do not write
 *   node scripts/generate-env-registry-seed.mjs --write     # (re)generate services/shared/envRegistry.cjs
 *
 * Classification is a best-effort SEED, not a final audit — see classify():
 *   - name contains KEY/TOKEN/SECRET/PASSWORD                      -> 'secret'
 *   - name is/contains NODE_ENV/PORT/HOST/DB_/POSTGRES/REDIS/LOG_LEVEL -> 'infra'
 *   - everything else                                              -> 'legacy-unclassified'
 *     (note: 'pre-ratchet backlog, classify in VAULT-INTEG P14')
 * Hand-classifying the 'user'/'instance' entries is P14's job. Guessing that
 * here would just be a second denylist wearing the seed script's clothes.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTENSIONS = /\.(js|cjs|mjs|ts)$/;
const EXCLUDED_DIR_NAMES = new Set([
    'node_modules',
    'test',
    'tests',
    '__tests__',
    'tests-integration',
    'tests-smoke',
]);
const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$/;

// The registry itself lives under services/shared/ and its header comment
// necessarily documents the `process.env.<NAME>` shape it stores — excluded
// so the scan never mistakes its own doc-comment for a discovered var.
const EXCLUDED_RELATIVE_FILES = new Set([path.join('shared', 'envRegistry.cjs')]);

/** Every non-test *.{js,cjs,mjs,ts} file under services/. */
export function serviceSourceFiles(repo = REPO) {
    const out = [];
    const root = path.join(repo, 'services');
    const walk = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (SOURCE_EXTENSIONS.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)) {
                if (EXCLUDED_RELATIVE_FILES.has(path.relative(root, full))) continue;
                out.push(full);
            }
        }
    };
    walk(root);
    return out;
}

/**
 * Scan services/ non-test source for `process.env.NAME` reads.
 *
 * @param {string} repo - repo root
 * @returns {Array<{ name: string, services: string[] }>} one entry per
 *   distinct var name, sorted, with the top-level services/<dir> names that
 *   read it (e.g. 'auth', 'collector').
 */
export function discoverEnvVars(repo = REPO) {
    const byName = new Map();
    const servicesRoot = path.join(repo, 'services');

    for (const file of serviceSourceFiles(repo)) {
        let src;
        try {
            src = readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        const rel = path.relative(servicesRoot, file);
        const service = rel.split(path.sep)[0];

        for (const line of src.split('\n')) {
            const trimmed = line.trim();
            // Skip comment lines: a doc-comment placeholder like process.env.X
            // must not become a registry entry (VAULT-INTEG P14 scan-artifact fix).
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
            // Full JS identifier capture: the old [A-Z0-9_]+ truncated mixed-case
            // vars (process.env.QuoxAgent_ROOT became a phantom entry "Q").
            for (const match of line.matchAll(/process\.env\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
                const name = match[1];
                if (!byName.has(name)) byName.set(name, new Set());
                byName.get(name).add(service);
            }
        }
    }

    return [...byName.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, services]) => ({ name, services: [...services].sort() }));
}

/**
 * Best-effort classification for the SEED registry. See module header — this
 * is a starting point for VAULT-INTEG P14, not a final audit.
 * @param {string} name
 * @returns {'secret'|'infra'|'legacy-unclassified'}
 */
export function classify(name) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)/.test(name)) return 'secret';
    if (/^(NODE_ENV|PORT|HOST)$/.test(name) || /^(DB_|POSTGRES|REDIS)/.test(name) || name === 'LOG_LEVEL') {
        return 'infra';
    }
    return 'legacy-unclassified';
}

function renderRegistry(entries) {
    const lines = [];
    lines.push('// services/shared/envRegistry.cjs — VAULT-INTEG P13 env-config registry.');
    lines.push('//');
    lines.push('// WHY THIS EXISTS (VAULT-INTEG P13, 2026-09-06):');
    lines.push('//   ~105 env-only, user-facing settings existed with no dashboard/Settings');
    lines.push('//   surface, and three feature flags in the UI LIED about their own state');
    lines.push('//   because the code path that read them bypassed the settings store and read');
    lines.push('//   process.env directly instead. There was no single place naming every');
    lines.push('//   environment variable a service could read, so nobody could audit which');
    lines.push('//   ones needed a Settings surface. This registry is the ratchet: it does NOT');
    lines.push('//   remediate the existing backlog (VAULT-INTEG P14), it stops a NEW');
    lines.push('//   unregistered process.env read from shipping (see');
    lines.push('//   src/test/envRegistryCompleteness.test.js and');
    lines.push('//   scripts/pre-commit-env-check.sh).');
    lines.push('//');
    lines.push('// Entry shape:');
    lines.push("//   name           - the env var name, exactly as read (process.env.<NAME>)");
    lines.push("//   services       - array of services/<dir> names that read it");
    lines.push("//   classification - 'user' | 'instance' | 'secret' | 'infra' | 'legacy-unclassified'");
    lines.push("//   surface        - Settings surface name this maps to, or null if none yet");
    lines.push("//   note           - optional human context");
    lines.push('//');
    lines.push('// Seeded by scripts/generate-env-registry-seed.mjs. Everything the seed could');
    lines.push("// not confidently classify is tagged 'legacy-unclassified' with a note to");
    lines.push('// classify it in VAULT-INTEG P14 — that tag is a to-do marker, not a real');
    lines.push('// classification, and is not a license to leave a var there forever.');
    lines.push("'use strict';");
    lines.push('');
    lines.push('const ENV_REGISTRY = [');
    for (const entry of entries) {
        const classification = classify(entry.name);
        const note = classification === 'legacy-unclassified'
            ? 'pre-ratchet backlog, classify in VAULT-INTEG P14'
            : undefined;
        lines.push('    {');
        lines.push(`        name: ${JSON.stringify(entry.name)},`);
        lines.push(`        services: ${JSON.stringify(entry.services)},`);
        lines.push(`        classification: ${JSON.stringify(classification)},`);
        lines.push('        surface: null,');
        if (note) lines.push(`        note: ${JSON.stringify(note)},`);
        lines.push('    },');
    }
    lines.push('];');
    lines.push('');
    lines.push('module.exports = { ENV_REGISTRY };');
    lines.push('');
    return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    const entries = discoverEnvVars(REPO);
    const byClass = entries.reduce((acc, e) => {
        const c = classify(e.name);
        acc[c] = (acc[c] || 0) + 1;
        return acc;
    }, {});

    if (process.argv.includes('--write')) {
        const outPath = path.join(REPO, 'services', 'shared', 'envRegistry.cjs');
        writeFileSync(outPath, renderRegistry(entries));
        console.log(`Ⓠ QUOX │ env registry seed │ wrote ${entries.length} entries to services/shared/envRegistry.cjs ✔`);
    } else {
        console.log(`Ⓠ QUOX │ env registry seed │ discovered ${entries.length} vars (dry run, pass --write to persist)`);
    }
    console.log('  by classification:', byClass);
}

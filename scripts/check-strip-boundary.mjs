#!/usr/bin/env node
/**
 * check-strip-boundary — run the LL-7 ESLint strip boundary, and only that.
 *
 *   npm run check:boundary
 *
 * `npm run lint` is continue-on-error in CI because src/ still carries
 * pre-existing warnings, and getting the whole repo to zero is not this
 * stream's job. But the strip boundary MUST be a hard failure: one static or
 * dynamic import of a stripped plugin puts the paid code back into
 * dist/assets, and the free build silently stops being free.
 *
 * So this runs the real eslint.config.js over src/ and reports ONLY the two
 * rules that make up the boundary. Everything else is somebody else's problem.
 *
 * Exit 0 = boundary intact. Exit 1 = the free build imports stripped code.
 */

import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { STRIP_REGISTRY } from '../src/config/stripRegistry.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The rules eslint.config.js uses to express the boundary. */
export const BOUNDARY_RULES = ['no-restricted-imports', 'no-restricted-syntax'];

/**
 * @returns {Promise<{ok: boolean, violations: Array<{file: string, line: number, ruleId: string}>, filesChecked: number}>}
 */
export async function checkStripBoundary({ cwd = REPO, targets = ['src'] } = {}) {
    const eslint = new ESLint({ cwd });
    const results = await eslint.lintFiles(targets);
    const violations = [];
    for (const result of results) {
        for (const message of result.messages) {
            if (!BOUNDARY_RULES.includes(message.ruleId)) continue;
            violations.push({
                file: path.relative(cwd, result.filePath),
                line: message.line,
                ruleId: message.ruleId,
            });
        }
    }
    return { ok: violations.length === 0, violations, filesChecked: results.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    const { ok, violations, filesChecked } = await checkStripBoundary();
    for (const v of violations) {
        console.error(`✖ BOUNDARY │ ${v.file}:${v.line} imports a stripped plugin (${v.ruleId})`);
    }
    if (ok) {
        const stripped = STRIP_REGISTRY.filter((r) => r.status === 'stripped').map((r) => r.pluginId);
        console.log(`Ⓠ QUOX │ strip boundary │ ${filesChecked} files, zero imports of ${stripped.join(', ') || 'any stripped plugin'} ✔`);
        process.exit(0);
    }
    process.exit(1);
}

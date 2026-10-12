/**
 * Plugin Review Gate (Gate 1: Automated Checks)
 *
 * Extracts and validates .quoxplugin ZIP packages before human review.
 * Returns a structured result with individual check outcomes.
 */

import AdmZip from 'adm-zip';

const MAX_JS_SIZE = 100 * 1024;      // 100KB for JS bundle
const MAX_TOTAL_SIZE = 5 * 1024 * 1024; // 5MB total package

const BLOCKED_PATTERNS = [
    /\beval\s*\(/,
    /\bnew\s+Function\s*\(/,
    /\bimport\s*\(/,
    /__proto__/,
    /document\.cookie/,
    /window\.localStorage/,
    /window\.sessionStorage/,
    /process\.env/,
    /child_process/,
    /require\s*\(\s*['"`]fs['"`]\s*\)/,
    /require\s*\(\s*['"`]net['"`]\s*\)/,
    /require\s*\(\s*['"`]http['"`]\s*\)/,
];

const RESERVED_PREFIXES = ['quox-', 'quoxai-', 'core-', 'official-'];

const REQUIRED_MANIFEST_FIELDS = ['id', 'name', 'version', 'description', 'author', 'entrypoint'];

/**
 * Run automated review checks on a .quoxplugin ZIP buffer.
 *
 * @param {Buffer} zipBuffer - The uploaded ZIP file contents
 * @returns {{ passed: boolean, checks: Array<{name: string, passed: boolean, message: string}> }}
 */
export function runReviewGate(zipBuffer) {
    const checks = [];

    // Check 1: Valid ZIP
    let zip;
    try {
        zip = new AdmZip(zipBuffer);
    } catch (err) {
        checks.push({ name: 'valid_zip', passed: false, message: `Invalid ZIP file: ${err.message}` });
        return { passed: false, checks };
    }
    checks.push({ name: 'valid_zip', passed: true, message: 'Valid ZIP archive' });

    // Check 2: Total package size
    const totalSize = zipBuffer.length;
    if (totalSize > MAX_TOTAL_SIZE) {
        checks.push({
            name: 'package_size',
            passed: false,
            message: `Package size ${(totalSize / 1024 / 1024).toFixed(2)}MB exceeds ${MAX_TOTAL_SIZE / 1024 / 1024}MB limit`
        });
    } else {
        checks.push({
            name: 'package_size',
            passed: true,
            message: `Package size ${(totalSize / 1024).toFixed(1)}KB within limit`
        });
    }

    // Check 3: Manifest exists and is valid
    const entries = zip.getEntries();
    const manifestEntry = entries.find(e => e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json'));

    if (!manifestEntry) {
        checks.push({ name: 'manifest_exists', passed: false, message: 'No manifest.json found in package' });
        return { passed: false, checks };
    }
    checks.push({ name: 'manifest_exists', passed: true, message: 'manifest.json found' });

    let manifest;
    try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
    } catch (err) {
        checks.push({ name: 'manifest_valid', passed: false, message: `manifest.json is not valid JSON: ${err.message}` });
        return { passed: false, checks };
    }

    // Check 4: Required manifest fields
    const missingFields = REQUIRED_MANIFEST_FIELDS.filter(f => !manifest[f]);
    if (missingFields.length > 0) {
        checks.push({
            name: 'manifest_fields',
            passed: false,
            message: `Missing required fields: ${missingFields.join(', ')}`
        });
    } else {
        checks.push({ name: 'manifest_fields', passed: true, message: 'All required fields present' });
    }

    // Check 5: Plugin ID format (lowercase alphanumeric + hyphens)
    if (manifest.id) {
        const idValid = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(manifest.id) && manifest.id.length >= 3 && manifest.id.length <= 64;
        if (!idValid) {
            checks.push({
                name: 'id_format',
                passed: false,
                message: 'Plugin ID must be 3-64 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen'
            });
        } else {
            checks.push({ name: 'id_format', passed: true, message: `Plugin ID "${manifest.id}" is valid` });
        }

        // Check 6: Reserved prefixes
        const usesReserved = RESERVED_PREFIXES.some(prefix => manifest.id.startsWith(prefix));
        if (usesReserved) {
            checks.push({
                name: 'reserved_prefix',
                passed: false,
                message: `Plugin ID uses reserved prefix (${RESERVED_PREFIXES.join(', ')})`
            });
        } else {
            checks.push({ name: 'reserved_prefix', passed: true, message: 'No reserved prefix conflict' });
        }
    }

    // Check 7: Version format (semver)
    if (manifest.version) {
        const semverValid = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(manifest.version);
        if (!semverValid) {
            checks.push({
                name: 'version_format',
                passed: false,
                message: `Version "${manifest.version}" is not valid semver (expected x.y.z)`
            });
        } else {
            checks.push({ name: 'version_format', passed: true, message: `Version ${manifest.version} is valid semver` });
        }
    }

    // Check 8: JS bundle size
    const jsEntries = entries.filter(e => e.entryName.endsWith('.js') || e.entryName.endsWith('.mjs'));
    let totalJsSize = 0;
    for (const entry of jsEntries) {
        totalJsSize += entry.header.size;
    }
    if (totalJsSize > MAX_JS_SIZE) {
        checks.push({
            name: 'js_bundle_size',
            passed: false,
            message: `JS bundle ${(totalJsSize / 1024).toFixed(1)}KB exceeds ${MAX_JS_SIZE / 1024}KB limit`
        });
    } else {
        checks.push({
            name: 'js_bundle_size',
            passed: true,
            message: `JS bundle ${(totalJsSize / 1024).toFixed(1)}KB within limit`
        });
    }

    // Check 9: Blocked code patterns
    const blockedFindings = [];
    for (const entry of jsEntries) {
        const content = entry.getData().toString('utf-8');
        for (const pattern of BLOCKED_PATTERNS) {
            if (pattern.test(content)) {
                blockedFindings.push(`${entry.entryName}: matches ${pattern.source}`);
            }
        }
    }

    if (blockedFindings.length > 0) {
        checks.push({
            name: 'blocked_patterns',
            passed: false,
            message: `Blocked patterns found: ${blockedFindings.slice(0, 5).join('; ')}`
        });
    } else {
        checks.push({ name: 'blocked_patterns', passed: true, message: 'No blocked patterns detected' });
    }

    // Check 10: Signature file presence
    const hasSignature = entries.some(e => e.entryName === 'signature.sig' || e.entryName.endsWith('/signature.sig'));
    checks.push({
        name: 'signature_present',
        passed: hasSignature,
        message: hasSignature ? 'Package signature found' : 'No signature file (optional but recommended)'
    });

    // Overall result: fail if any non-optional check failed
    const criticalChecks = checks.filter(c => c.name !== 'signature_present');
    const passed = criticalChecks.every(c => c.passed);

    return { passed, checks };
}

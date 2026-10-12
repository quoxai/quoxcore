#!/usr/bin/env node
/**
 * Sign a .quoxplugin package with an Ed25519 private key.
 *
 * Usage:
 *   node scripts/sign-plugin.js --plugin ./my-plugin.quoxplugin --key ./quox-signing.key
 *
 * Steps:
 *   1. Extract ZIP
 *   2. Read manifest.json
 *   3. Compute SHA-256 digest of canonical manifest
 *   4. Sign with Ed25519 private key
 *   5. Write signature.json into ZIP
 *   6. Re-package
 */

import fs from 'fs';
import path from 'path';
import { embedIntegrity, signManifest } from './lib/pluginSigning.js';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const pluginPath = getArg('--plugin');
const keyPath = getArg('--key');

if (!pluginPath || !keyPath) {
    console.error('Usage: node scripts/sign-plugin.js --plugin <path> --key <private-key-path>');
    process.exit(1);
}

async function main() {
    // We use the built-in Node.js ZIP support via a lightweight approach
    // Since JSZip is not available in Node, we use adm-zip
    let AdmZip;
    try {
        AdmZip = (await import('adm-zip')).default;
    } catch {
        console.error('adm-zip not installed. Run: npm install --save-dev adm-zip');
        process.exit(1);
    }

    const zip = new AdmZip(path.resolve(pluginPath));

    // Read manifest.json
    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) {
        console.error('Error: manifest.json not found in plugin package');
        process.exit(1);
    }

    const rawManifest = JSON.parse(manifestEntry.getData().toString('utf8'));
    console.log(`Signing plugin: ${rawManifest.name} v${rawManifest.version} (${rawManifest.id})`);

    // F2: bind the bundle + css bytes into the signed manifest.
    const bundleEntry = zip.getEntry('plugin.esm.js');
    if (!bundleEntry) {
        console.error('Error: plugin.esm.js not found in plugin package');
        process.exit(1);
    }
    const cssEntry = zip.getEntry('plugin.css');
    const manifest = embedIntegrity(rawManifest, {
        bundle: bundleEntry.getData(),
        css: cssEntry ? cssEntry.getData() : null,
    });
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));

    const privateKeyPem = fs.readFileSync(path.resolve(keyPath), 'utf8');
    const sigData = signManifest(manifest, privateKeyPem);
    const { keyId, digest } = sigData;

    // Write signature.json into ZIP
    zip.addFile('signature.json', Buffer.from(JSON.stringify(sigData, null, 2)));

    // Save
    const outPath = path.resolve(pluginPath);
    zip.writeZip(outPath);

    console.log(`Signed successfully.`);
    console.log(`  Key ID: ${keyId.slice(0, 16)}...`);
    console.log(`  Digest: ${digest.slice(0, 16)}...`);
    console.log(`  Output: ${outPath}`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});

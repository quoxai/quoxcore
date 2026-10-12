#!/usr/bin/env node
/**
 * Generate Ed25519 signing key pair for QuoxCORE plugin signing.
 *
 * Usage:
 *   node scripts/generate-signing-key.js [--out <dir>]
 *
 * Outputs:
 *   quox-signing.key  — private key (PEM, keep secret)
 *   quox-signing.pub  — public key (PEM, embed in QuoxCORE)
 *   Console: Base64 public key for embedding
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
let outDir = process.cwd();

const outIdx = args.indexOf('--out');
if (outIdx !== -1 && args[outIdx + 1]) {
    outDir = path.resolve(args[outIdx + 1]);
}

// Generate Ed25519 key pair
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const privPath = path.join(outDir, 'quox-signing.key');
const pubPath = path.join(outDir, 'quox-signing.pub');

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey);

// Extract raw 32-byte public key for Base64 embedding
const pubKeyObj = crypto.createPublicKey(publicKey);
const rawPub = pubKeyObj.export({ type: 'spki', format: 'der' });
// Ed25519 SPKI DER is 44 bytes: 12-byte header + 32-byte key
const rawBytes = rawPub.slice(rawPub.length - 32);
const base64Pub = rawBytes.toString('base64');

console.log('Key pair generated:');
console.log(`  Private: ${privPath}`);
console.log(`  Public:  ${pubPath}`);
console.log('');
console.log('Base64 public key (for embedding in QuoxCORE):');
console.log(`  ${base64Pub}`);
console.log('');
console.log('Add this to your .gitignore:');
console.log('  quox-signing.key');

#!/usr/bin/env node
/**
 * Generate a per-plugin license key signed with Ed25519.
 *
 * Usage:
 *   node scripts/generate-plugin-license.js \
 *     --plugin acme-monitoring \
 *     --customer "Acme Corp" \
 *     --expires 2027-03-20 \
 *     --key ./quox-signing.key
 *
 * Outputs:
 *   - Short display key: QXP-XXXX-XXXX-XXXX-XXXX
 *   - Full signed license JSON for offline validation
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const pluginId = getArg('--plugin');
const customer = getArg('--customer');
const expiresStr = getArg('--expires');
const keyPath = getArg('--key');

if (!pluginId || !customer || !expiresStr || !keyPath) {
    console.error('Usage: node scripts/generate-plugin-license.js --plugin <id> --customer <name> --expires <YYYY-MM-DD> --key <path>');
    process.exit(1);
}

const expiresAt = new Date(expiresStr + 'T23:59:59.999Z');
if (isNaN(expiresAt.getTime())) {
    console.error('Invalid date format. Use YYYY-MM-DD.');
    process.exit(1);
}

// Generate unique license ID
const licenseId = `QXP-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}`.toUpperCase();
const customerId = crypto.randomUUID();

function randomHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex').slice(0, 4);
}

// Build license payload
const license = {
    id: licenseId,
    customer_id: customerId,
    customer_name: customer,
    scope: `plugin:${pluginId}`,
    plugin_id: pluginId,
    tiers: ['free'], // plugin licenses don't gate tiers — they gate specific plugins
    expires_at: expiresAt.toISOString(),
    issued_at: new Date().toISOString(),
};

// Build signed data: id + customer_id + scope + expires_at
const signedData = license.id + license.customer_id + license.scope + license.expires_at;
const dataBytes = Buffer.from(signedData, 'utf8');

// Read private key and sign
const privateKeyPem = fs.readFileSync(path.resolve(keyPath), 'utf8');
const privateKey = crypto.createPrivateKey(privateKeyPem);
const signature = crypto.sign(null, dataBytes, privateKey);
license.signature = signature.toString('base64');

// Extract public key ID
const publicKey = crypto.createPublicKey(privateKey);
const rawPub = publicKey.export({ type: 'spki', format: 'der' });
const rawBytes = rawPub.slice(rawPub.length - 32);
license.signing_key_id = rawBytes.toString('base64');

console.log('Plugin license generated:');
console.log(`  Plugin:   ${pluginId}`);
console.log(`  Customer: ${customer}`);
console.log(`  Expires:  ${expiresAt.toISOString().split('T')[0]}`);
console.log(`  Key:      ${licenseId}`);
console.log('');
console.log('Full license JSON (give to customer):');
console.log(JSON.stringify(license, null, 2));

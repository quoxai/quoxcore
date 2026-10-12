/**
 * WARD Signing — Ed25519 key management and signature operations.
 * SPEC §4.5, §8.2, §12.2
 *
 * Tips SHOULD be signed. Signature is over the raw bytes of the
 * tip_chain_hash hex string.
 */

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';

/**
 * Generate a new Ed25519 keypair.
 * Returns { publicKey, privateKey, keyId } where keyId is the first 16 chars
 * of the hex-encoded public key (a stable fingerprint).
 */
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = pubDer.subarray(-32).toString('hex').slice(0, 16);

  return { publicKey, privateKey, keyId };
}

/**
 * Sign a tip_chain_hash (hex string) with an Ed25519 private key.
 * Returns base64-encoded signature.
 *
 * SPEC §12.2: "The signature is over the raw bytes of the tip_chain_hash hex string."
 */
export function signTipHash(tipChainHash, privateKey) {
  const sig = sign(null, Buffer.from(tipChainHash, 'utf8'), privateKey);
  return sig.toString('base64');
}

/**
 * Verify a signature over a tip_chain_hash.
 * @returns {boolean}
 */
export function verifyTipSignature(tipChainHash, signature, publicKey) {
  try {
    return verify(null, Buffer.from(tipChainHash, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Export a keypair to PEM files.
 */
export function exportKeypair(keypair, pubPath, privPath) {
  const pubPem = keypair.publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = keypair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(pubPath, pubPem, { encoding: 'utf8', mode: 0o644 });
  writeFileSync(privPath, privPem, { encoding: 'utf8', mode: 0o600 });
  // Belt-and-suspenders: chmod in case umask overrode the mode
  chmodSync(privPath, 0o600);
}

/**
 * Load a keypair from PEM files.
 * Returns { publicKey, privateKey, keyId }.
 */
export function loadKeypair(pubPath, privPath) {
  const publicKey = createPublicKey(readFileSync(pubPath, 'utf8'));
  const privateKey = createPrivateKey(readFileSync(privPath, 'utf8'));

  const pubDer = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = pubDer.subarray(-32).toString('hex').slice(0, 16);

  return { publicKey, privateKey, keyId };
}

/**
 * Load or generate a keypair. If the files exist, load; otherwise generate and save.
 */
export function ensureKeypair(pubPath, privPath) {
  if (existsSync(pubPath) && existsSync(privPath)) {
    return loadKeypair(pubPath, privPath);
  }
  const kp = generateKeypair();
  exportKeypair(kp, pubPath, privPath);
  return kp;
}

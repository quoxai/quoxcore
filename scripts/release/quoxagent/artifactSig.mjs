// Z2H-AGENTINST: Quox artifact signature, the same Ed25519 scheme the official
// plugin signer uses (scripts/lib/pluginSigning.js): sign the 32-byte SHA-256
// digest of the signed bytes; keyId = the raw 32-byte Ed25519 public key, base64.
// Used for the quoxagent release's SHA256SUMS. No dependencies (runs on a bare runner).
import crypto from 'node:crypto';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function keyIdOf(key) {
  const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
  return pub.subarray(pub.length - 32).toString('base64');
}

export function publicKeyFromKeyId(keyId) {
  const raw = Buffer.from(keyId, 'base64');
  if (raw.length !== 32) throw new Error('keyId is not a 32-byte Ed25519 public key');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Sign bytes. privateKey: KeyObject or PEM. Returns the signature JSON object. */
export function signArtifact(bytes, privateKey, { artifact, version }) {
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  const digest = crypto.createHash('sha256').update(bytes).digest();
  return {
    keyId: keyIdOf(key),
    digest: digest.toString('base64'),
    signature: crypto.sign(null, digest, key).toString('base64'),
    algorithm: 'Ed25519',
    hashAlgorithm: 'SHA-256',
    timestamp: new Date().toISOString(),
    artifact,
    version,
  };
}

/** Verify bytes against a signature object and the ONE trusted keyId. Throws on any failure. */
export function verifyArtifact(bytes, sig, trustedKeyId) {
  if (!sig || sig.algorithm !== 'Ed25519' || !sig.signature || !sig.digest) throw new Error('signature: malformed signature file');
  if (sig.keyId !== trustedKeyId) throw new Error(`signature: untrusted key ${sig.keyId} (expected ${trustedKeyId})`);
  const digest = crypto.createHash('sha256').update(bytes).digest();
  if (digest.toString('base64') !== sig.digest) throw new Error('signature: digest does not match the signed bytes');
  const ok = crypto.verify(null, digest, publicKeyFromKeyId(trustedKeyId), Buffer.from(sig.signature, 'base64'));
  if (!ok) throw new Error('signature: Ed25519 verification failed');
  return true;
}

/** Parse `sha256sum` output into { name: hex }. */
export function parseSums(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS: bad line ${JSON.stringify(line)}`);
    if (out[m[2]]) throw new Error(`SHA256SUMS: duplicate entry ${m[2]}`);
    out[m[2]] = m[1];
  }
  return out;
}

/**
 * Verify a release given as { name: Buffer } against the pinned manifest.
 * Checks: signature over SHA256SUMS by the pinned key; SHA256SUMS hash pinned;
 * every pinned file listed in SHA256SUMS with the pinned hash; every file's bytes hash.
 */
export function verifyRelease(files, manifest) {
  const sumsBytes = files['SHA256SUMS'];
  const sigBytes = files['SHA256SUMS.sig.json'];
  if (!sumsBytes || !sigBytes) throw new Error('release: SHA256SUMS and SHA256SUMS.sig.json are required');
  verifyArtifact(sumsBytes, JSON.parse(sigBytes.toString('utf8')), manifest.signing.keyId);
  if (sha256Hex(sumsBytes) !== manifest.sha256sums) throw new Error('release: SHA256SUMS differs from the pinned manifest');
  const sums = parseSums(sumsBytes.toString('utf8'));
  for (const [name, pinned] of Object.entries(manifest.files)) {
    if (sums[name] !== pinned) throw new Error(`release: ${name} in SHA256SUMS (${sums[name] || 'missing'}) differs from the pinned ${pinned}`);
    const bytes = files[name];
    if (!bytes) throw new Error(`release: ${name} missing`);
    const got = sha256Hex(bytes);
    if (got !== pinned) throw new Error(`release: ${name} hashes ${got}, pinned ${pinned}`);
  }
  return true;
}

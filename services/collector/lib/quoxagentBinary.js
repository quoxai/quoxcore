/**
 * quoxagentBinary — shared resolution + integrity for the quoxagent binary
 * the collector serves to fleet installs.
 *
 * TRUST-PROOF installer-integrity fix (audit cycle 1, high:
 * "Installer is curl piped to bash over plain HTTP with no integrity
 * verification"). Three consumers:
 *   - GET /download/quoxagent-:os-:arch          (existing, now via resolve())
 *   - GET /download/quoxagent-:os-:arch.sha256   (new: publish the checksum)
 *   - POST /api/v1/quoxagent/install             (new: inject BINARY_SHA256
 *     into the install command sent over the AUTHENTICATED bastion channel,
 *     which makes the plain-HTTP binary download tamper-evident: the hash
 *     travels via SSH, the bytes via HTTP, and install.sh fails closed on
 *     mismatch)
 *
 * Resolution contract mirrors the long-standing route behaviour (fleet #424):
 * the plain bin/quoxagent IS the canonical linux-amd64 binary and wins for
 * that pair; per-platform files bin/quoxagent-<os>-<arch> serve the rest.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Resolve the on-disk binary for a platform pair.
 * @returns {string|null} absolute path, or null if not staged
 */
function resolveQuoxagentBinary(root, os, arch) {
  if (!/^[a-z0-9]+$/.test(os) || !/^[a-z0-9_]+$/.test(arch)) return null;
  const canonical = path.join(root, 'bin/quoxagent');
  if (os === 'linux' && arch === 'amd64' && fs.existsSync(canonical)) return canonical;
  const platformPath = path.join(root, 'bin', `quoxagent-${os}-${arch}`);
  if (fs.existsSync(platformPath)) return platformPath;
  return null;
}

// (size, mtimeMs) keyed cache so a ~25MB hash isn't recomputed per request,
// but a rebuilt binary is never served with a stale checksum.
const _shaCache = new Map();

/**
 * SHA-256 of a file as lowercase hex, mtime-cache backed.
 * @returns {string|null} hex digest, or null if unreadable
 */
function sha256OfFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const key = filePath;
  const cached = _shaCache.get(key);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.sha;
  }
  let sha;
  try {
    sha = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
  _shaCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, sha });
  return sha;
}

/**
 * Fleet host ids come from API callers and get templated into a bastion
 * shell command; keep them to a hostname-shaped charset so a crafted
 * "host" can never smuggle shell into the authenticated exec channel.
 */
function isSafeHostId(host) {
  return typeof host === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(host);
}

module.exports = { resolveQuoxagentBinary, sha256OfFile, isSafeHostId };

#!/usr/bin/env node
// Z2H-AGENTINST: stage the signed quoxagent release into the collector image build.
//
//   node scripts/release/quoxagent/fetch-quoxagent-release.mjs [out-dir]
//
// Reads the pinned manifest beside this file, downloads the release assets from
// https://github.com/<repo>/releases/download/<tag>/ (or QUOXAGENT_RELEASE_BASE_URL,
// an http(s) URL or a local directory, used for pre-publish proofs), verifies the
// Ed25519 signature over SHA256SUMS with the pinned Quox key and every file against
// the pinned hashes, and only then lays the release out for the collector:
//   <out>/deploy/install.sh  <out>/bin/quoxagent-linux-amd64  <out>/bin/quoxagent-linux-arm64
// Default out-dir: services/collector/quoxagent-release (baked to /app/quoxagent-release).
// Fails closed: any mismatch exits non-zero and writes nothing.
// Exit codes (REL-423, so setup.sh can say which): 1 = verification FAILED (refuse), 3 = download failed
// (offline or the release is unreachable; nothing was verified, nothing written).
//
//   node scripts/release/quoxagent/fetch-quoxagent-release.mjs --verify-staged [dir]
// Re-verifies an ALREADY staged release offline (signature + every pinned hash) without downloading, so an
// offline re-run of setup.sh can reuse a copy that was verified before, and never an unverified one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRelease } from './artifactSig.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'quoxagent-release.json'), 'utf8'));
const verifyStaged = process.argv[2] === '--verify-staged';
const outArg = verifyStaged ? process.argv[3] : process.argv[2];
const out = path.resolve(outArg || path.join(repoRoot, 'services/collector/quoxagent-release'));
const base = process.env.QUOXAGENT_RELEASE_BASE_URL
  || `https://github.com/${manifest.release.repo}/releases/download/${manifest.release.tag}`;

class DownloadError extends Error {}

async function get(name) {
  try {
    if (!/^https?:\/\//.test(base)) return fs.readFileSync(path.join(base, name));
    const res = await fetch(`${base}/${name}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new DownloadError(`download ${name} from ${base}: ${err.cause?.code || err.cause?.errors?.[0]?.code || err.message}`);
  }
}

const LAYOUT = {
  'install.sh': 'deploy/install.sh',
  'quoxagent-linux-amd64': 'bin/quoxagent-linux-amd64',
  'quoxagent-linux-arm64': 'bin/quoxagent-linux-arm64',
};

if (verifyStaged) {
  try {
    const files = {};
    for (const name of ['SHA256SUMS', 'SHA256SUMS.sig.json']) files[name] = fs.readFileSync(path.join(out, name));
    for (const [name, rel] of Object.entries(LAYOUT)) files[name] = fs.readFileSync(path.join(out, rel));
    verifyRelease(files, manifest);
    console.log(`quoxagent ${manifest.version} already staged at ${out}: re-verified offline (signature by ${manifest.signing.keyId}, ${Object.keys(manifest.files).length} files pinned)`);
    process.exit(0);
  } catch (err) {
    console.error(`staged quoxagent release at ${out} did NOT verify: ${err.message}`);
    process.exit(1);
  }
}

try {
  const files = {};
  for (const name of ['SHA256SUMS', 'SHA256SUMS.sig.json', ...Object.keys(manifest.files)]) files[name] = await get(name);
  verifyRelease(files, manifest);
  for (const name of Object.keys(LAYOUT)) if (!manifest.files[name]) throw new Error(`manifest does not pin ${name}`);
  fs.rmSync(out, { recursive: true, force: true });
  for (const [name, rel] of Object.entries(LAYOUT)) {
    const dest = path.join(out, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[name], { mode: 0o755 });
  }
  for (const name of ['SHA256SUMS', 'SHA256SUMS.sig.json']) fs.writeFileSync(path.join(out, name), files[name]);
  fs.writeFileSync(path.join(out, 'quoxagent-release.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`quoxagent ${manifest.version} (${manifest.commit.slice(0, 12)}) verified: signature by ${manifest.signing.keyId}, ${Object.keys(manifest.files).length} files pinned; staged at ${out}`);
} catch (err) {
  if (err instanceof DownloadError) {
    console.error(`quoxagent release NOT staged (download failed; offline or unreachable): ${err.message}`);
    process.exit(3);
  }
  console.error(`quoxagent release NOT staged (verification FAILED, refusing): ${err.message}`);
  process.exit(1);
}

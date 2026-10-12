// Deterministic cross-language grant fixture: Node mints, Go must verify.
// Mirrors what services/auth approvalGrantSigningKey will do in production.
import { createPrivateKey, createPublicKey, sign } from 'crypto'

// Fixed TEST-ONLY Ed25519 seed (never a real key).
const seed = Buffer.alloc(32, 7)
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' })
const pubRaw = pubDer.subarray(pubDer.length - 32)

// Field order MUST match the Go struct declaration order in
// internal/approval/grant.go, and timestamps carry NO fractional seconds
// so Go's parse -> re-marshal round-trip is byte-identical.
function canonicalGrant (g) {
  const out = {}
  out.grant_id = g.grant_id
  out.org_id = g.org_id
  out.action = g.action
  if (g.command_sha256) out.command_sha256 = g.command_sha256
  if (g.tool_id) out.tool_id = g.tool_id
  if (g.params_sha256) out.params_sha256 = g.params_sha256
  out.targets = g.targets
  out.nonce = g.nonce
  out.issued_at = g.issued_at
  out.expires_at = g.expires_at
  return out
}

const grant = {
  grant_id: 'GRT_XLANG_FIXTURE_01',
  org_id: 'org_fixture',
  action: 'exec',
  command_sha256: 'd0d09d3e478a01a2af2b18a05c1eb0d5497f6bb28dbbbee5dc2b0da120b957ab',
  targets: ['web01', 'group:prod-web'],
  nonce: 'xlang-nonce-0001',
  issued_at: '2026-09-19T16:00:00Z',
  expires_at: '2036-09-19T16:00:00Z'
}

const signedBytes = Buffer.from(JSON.stringify(canonicalGrant(grant)))
const signature = sign(null, signedBytes, priv).toString('base64')
const envelope = { ...canonicalGrant(grant), signature }

console.log(JSON.stringify({
  public_key_base64: pubRaw.toString('base64'),
  grant_base64: Buffer.from(JSON.stringify(envelope)).toString('base64'),
  signed_bytes: signedBytes.toString()
}, null, 2))

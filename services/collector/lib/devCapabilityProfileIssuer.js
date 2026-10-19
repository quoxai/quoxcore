/**
 * devCapabilityProfileIssuer.js — DEVSUITE-HUB Phase 2: constructs a signed
 * quoxagent dev.* CapabilityProfile for a target host, signs it via the
 * auth service's DCSK signing oracle (services/auth/routes/
 * internal-dev-profile-signing.js), and delivers the signed profile onto
 * the target host's filesystem via Bastion — the "register as dev server"
 * trigger (`quox dev enable`).
 *
 * ARCHITECTURE
 *   1. Resolve the org's active Dev Capability Signing Key (DCSK) public
 *      half (and its key_id) via GET /api/internal/dev-profiles/
 *      public-key/:orgId. This must happen BEFORE canonical bytes are
 *      built — key_id is itself part of the signed payload (see
 *      buildCanonicalBytes below / quoxagent's buildProfileSignedData:
 *      "KeyID is included so a valid signature cannot be replayed under a
 *      claim of a different signing key"), and only the oracle knows which
 *      key is currently active for this org.
 *   2. Build the UNSIGNED profile fields, then the exact canonical byte
 *      sequence quoxagent's internal/plugins/dev/profile.go
 *      buildProfileSignedData() would produce for those same fields (see
 *      buildCanonicalBytes — locked against a real Go test fixture,
 *      internal/plugins/dev/profile_test.go's
 *      TestBuildProfileSignedData_KnownVector).
 *   3. POST the canonical bytes (hex) to the signing oracle
 *      (POST /api/internal/dev-profiles/sign) — auth signs the opaque
 *      bytes and never needs to understand capability-profile structure.
 *   4. Assemble the final signed profile JSON (quoxagent's
 *      dev.CapabilityProfile struct tags exactly: version, host_id,
 *      capabilities, max_concurrent_sessions, issued_at, expires_at,
 *      key_id, signature) — note the oracle returns `signature` as HEX;
 *      quoxagent's CapabilityProfile.Signature is base64
 *      (base64.StdEncoding), so this module converts hex -> base64 before
 *      writing the file.
 *   5. Deliver the signed profile onto the target host via
 *      `callBastion(hostId, command)` (bastionSshExecutor.js's pattern,
 *      injected by the caller — same DI shape skillPackInstaller.js
 *      already uses, reused rather than reimplemented), writing to
 *      quoxagent's real config-file convention path
 *      (/etc/quoxagent/dev-capability-profile.json, see quoxagent's
 *      internal/agent/devprofile.go DefaultDevCapabilityProfilePath) —
 *      base64-encoded and quoted, same command-injection discipline as
 *      skillPackInstaller.js's buildFileWriteClause(). Unlike that
 *      module's writes under $HOME/.claude/skills, this target lives under
 *      /etc, which needs root — `sudo tee`, never `sudo ... > file` (a
 *      redirect after `sudo` runs unprivileged in the parent shell, not as
 *      root; `sudo tee` is the standard fix).
 *   6. quox#462: ALSO deliver the org's DCSK PUBLIC key (already resolved
 *      in step 1, {key_id, algorithm, public_key_hex}) to
 *      /etc/quoxagent/dev-signing-key.json on the same host, same
 *      base64+sudo-tee discipline (see buildSigningKeyWriteCommand). This
 *      is what makes `quox dev enable` leave a host LIVE with no shared
 *      secret on it: without a local copy of the key, quoxagent could only
 *      verify its profile by fetching from the collector with
 *      QUOXAGENT_SERVICE_KEY === the collector's INTERNAL_SERVICE_KEY (see
 *      quoxagent devprofile.go's TODO(SEC-FLEET-CRED)), which a freshly
 *      enabled host never has. A public key is not a secret, so this does
 *      not expand that shared credential's footprint at all. This step
 *      degrades independently (result.signing_key = 'written' |
 *      'write_failed') and never fails the enable — the collector fetch
 *      remains as a fallback on the quoxagent side (see
 *      ResolveDevTrustedPublicKey in quoxagent's devprofile.go).
 *
 * SECURITY BOUNDARY — same "reject, never escape" discipline as
 * skillPackInstaller.js: every string value that ends up inside the
 * canonical signed bytes is validated against a strict allowlist BEFORE
 * being embedded (sanitizeHostId / sanitizeCapabilities, reused directly
 * from skillPackInstaller.js; VERSION_PATTERN / KEY_ID_PATTERN below),
 * rather than attempting a byte-perfect reimplementation of Go's
 * HTML-escaping JSON string encoder. None of our controlled values (host
 * IDs, capability names, key IDs, RFC3339 timestamps we generate
 * ourselves) can ever contain a character that would need escaping — if
 * one somehow did, this throws rather than risk producing a canonical byte
 * sequence quoxagent's VerifyProfile disagrees with.
 */

'use strict';

const {
  sanitizeHostId,
  sanitizeCapabilities,
  KNOWN_DEV_CAPABILITIES,
} = require('./skillPackInstaller.js');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const FETCH_TIMEOUT_MS = 10000;

const DEFAULT_CAPABILITY = 'dev.register';
const PROFILE_VERSION = '1.0'; // matches quoxagent's own test fixture convention (validProfile in profile_test.go)

// Mirrors quoxagent's internal/agent/devprofile.go DefaultDevCapabilityProfilePath.
const PROFILE_REMOTE_DIR = '/etc/quoxagent';
const PROFILE_REMOTE_PATH = '/etc/quoxagent/dev-capability-profile.json';

// quox#462: mirrors quoxagent's internal/agent/devprofile.go
// DefaultDevTrustedKeyPath — the local copy of the org's DCSK public key,
// delivered alongside the profile so a freshly enabled host can verify it
// without a shared collector credential.
const SIGNING_KEY_REMOTE_PATH = '/etc/quoxagent/dev-signing-key.json';

// Only this command's own successful completion prints this — never a
// hostname or path — so a poll loop or log grep can tell "the key file
// landed" apart from "the write attempt ran" without parsing stdout shape.
const SIGNING_KEY_WRITTEN_SENTINEL = 'DEV_SIGNING_KEY_WRITTEN';

const VERSION_PATTERN = /^[0-9A-Za-z.]{1,16}$/;
const KEY_ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

function assertSafeString(label, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`devCapabilityProfileIssuer: invalid ${label} '${value}'`);
  }
  return value;
}

// Go's time.RFC3339 ("2006-01-02T15:04:05Z07:00") has no fractional
// seconds; Date#toISOString() always emits milliseconds and a literal
// trailing "Z" (UTC) — strip the fraction to match exactly.
function toRFC3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the EXACT canonical JSON bytes quoxagent's
 * internal/plugins/dev/profile.go buildProfileSignedData() would produce
 * for the same field values. Key order matters: Go's encoding/json sorts
 * map[string]interface{} keys lexicographically, which for this fixed
 * field set is: capabilities, expires_at (if set), host_id (if set),
 * issued_at, key_id, max_concurrent_sessions, version — pinned by
 * internal/plugins/dev/profile_test.go's
 * TestBuildProfileSignedData_KnownVector[_WithExpiry] on the Go side.
 *
 * @returns {Buffer}
 */
function buildCanonicalBytes({ version, hostId, capabilities, maxConcurrentSessions, issuedAt, expiresAt, keyId }) {
  assertSafeString('version', version, VERSION_PATTERN);
  assertSafeString('key_id', keyId, KEY_ID_PATTERN);
  if (hostId) sanitizeHostId(hostId);
  const caps = sanitizeCapabilities(capabilities);
  if (!Array.isArray(caps) || caps.length === 0) {
    throw new Error('devCapabilityProfileIssuer: capabilities must be a non-empty array');
  }
  if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions < 0) {
    throw new Error(`devCapabilityProfileIssuer: invalid max_concurrent_sessions '${maxConcurrentSessions}'`);
  }
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
    throw new Error('devCapabilityProfileIssuer: issuedAt must be a valid Date');
  }
  if (expiresAt !== null && expiresAt !== undefined && (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))) {
    throw new Error('devCapabilityProfileIssuer: expiresAt must be a valid Date or null');
  }

  // Capability names come exclusively from KNOWN_DEV_CAPABILITIES (already
  // enforced by sanitizeCapabilities above), which contain no characters
  // JSON needs to escape — plain double-quoted encoding is byte-identical
  // to Go's default []string marshaling here.
  const capsJson = `[${caps.map((c) => `"${c}"`).join(',')}]`;

  const parts = [`"capabilities":${capsJson}`];
  if (expiresAt) parts.push(`"expires_at":"${toRFC3339(expiresAt)}"`);
  if (hostId) parts.push(`"host_id":"${hostId}"`);
  parts.push(`"issued_at":"${toRFC3339(issuedAt)}"`);
  parts.push(`"key_id":"${keyId}"`);
  parts.push(`"max_concurrent_sessions":${maxConcurrentSessions}`);
  parts.push(`"version":"${version}"`);

  return Buffer.from(`{${parts.join(',')}}`, 'utf8');
}

/**
 * Fetches the org's active DCSK public key + key_id.
 * GET {AUTH_SERVICE_URL}/api/internal/dev-profiles/public-key/:orgId
 * (services/auth/routes/internal-dev-profile-signing.js) — auth generates
 * the key on first use, so this call always resolves.
 *
 * @returns {Promise<{key_id: string, algorithm: string, public_key_hex: string, status: string}>}
 */
async function fetchPublicKeyFromAuth({ authServiceUrl = AUTH_SERVICE_URL, internalServiceKey = process.env.INTERNAL_SERVICE_KEY } = {}, { orgId }) {
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('devCapabilityProfileIssuer: org_id is required to fetch the public key');
  }
  const url = `${authServiceUrl}/api/internal/dev-profiles/public-key/${encodeURIComponent(orgId)}`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { 'X-Service-Key': internalServiceKey || '' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`devCapabilityProfileIssuer: public-key lookup unreachable: ${err.message}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`devCapabilityProfileIssuer: public-key lookup returned ${resp.status}: ${text}`);
  }
  const body = await resp.json();
  if (!body || !body.key_id || !body.public_key_hex) {
    throw new Error('devCapabilityProfileIssuer: public-key lookup returned an incomplete response');
  }
  return body;
}

/**
 * Signs canonicalBytesHex via the auth service's DCSK signing oracle.
 * POST {AUTH_SERVICE_URL}/api/internal/dev-profiles/sign
 *
 * @returns {Promise<{key_id: string, algorithm: string, signature: string, public_key_hex: string}>}
 */
async function signProfileWithAuth({ authServiceUrl = AUTH_SERVICE_URL, internalServiceKey = process.env.INTERNAL_SERVICE_KEY } = {}, { orgId, canonicalBytesHex }) {
  const url = `${authServiceUrl}/api/internal/dev-profiles/sign`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': internalServiceKey || '' },
      body: JSON.stringify({ org_id: orgId, canonical_bytes_hex: canonicalBytesHex }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`devCapabilityProfileIssuer: signing oracle unreachable: ${err.message}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`devCapabilityProfileIssuer: signing oracle returned ${resp.status}: ${text}`);
  }
  const body = await resp.json();
  if (!body || !body.signature || !body.key_id) {
    throw new Error('devCapabilityProfileIssuer: signing oracle returned an incomplete response');
  }
  return body;
}

/**
 * Builds the base64+sudo-tee remote write command for the signed profile,
 * mirroring skillPackInstaller.js's buildFileWriteClause() security
 * discipline (base64-encode, quote, assert the encoded charset) but
 * targeting an absolute /etc path rather than a $HOME-relative one, which
 * needs `sudo tee` — a bare `sudo ... > path` redirect happens in the
 * CALLING shell, unprivileged, before sudo ever runs, and would silently
 * fail against a root-owned /etc/quoxagent.
 */
// The agent-user path the dev.build engine reads its registry from
// (quoxagent resolveDataDir: QUOXAGENT_DATA_DIR else $HOME/.quoxagent).
// $HOME expands on the HOST at write time, so the literal stays unexpanded
// here and the remote command uses double quotes around it.
const BUILD_TARGETS_REMOTE_PATH = '$HOME/.quoxagent/build-targets.yaml';

// Starter registry: empty by design. The engine (quoxagent
// internal/plugins/dev/build) treats an empty-but-present registry as
// ready-with-nothing-registered, and dispatch refuses any name until real
// targets are registered here. The example stays commented out because a
// target is host-local executable configuration: nothing uncommented ships
// that this host's operator did not choose.
const BUILD_TARGETS_STARTER_YAML = `# QuoxBuild target registry for this dev server (delivered by quox dev enable).
#
# Builds run ONLY from targets pre-registered in this file: a dispatch names
# a target, never a command. Edit here, on this host, then re-check with:
#   quox build targets --host <this host>
#
# Schema and worked examples: the quoxpert-quoxbuild skill, or
# https://quox.ai/solutions/quoxbuild
#
# targets:
#   myservice:
#     description: my service (this instance's stack)
#     workdir: /home/me/my-project
#     steps:
#       - label: compose build
#         command: [docker, compose, build, myservice]
#       - label: deploy
#         command: [docker, compose, up, -d, myservice]
#         service: myservice
#         recover: [container_conflict]
#     verify:
#       - kind: http
#         url: http://127.0.0.1:8080/health
#         expect_body: '"status":"ok"'
#         settle_seconds: 5
version: 1
targets: {}
`;

/**
 * Guarded, sudo-free starter write for the build-target registry. Prints
 * BUILD_TARGETS_PRESENT and leaves the file alone when one already exists
 * (a hand-tuned registry must survive re-enable), else writes the starter
 * and prints BUILD_TARGETS_WRITTEN. Sentinels are strings only this
 * command emits, never the hostname or path (poll-loop grep discipline).
 */
function buildTargetsStarterWriteCommand() {
  const base64 = Buffer.from(BUILD_TARGETS_STARTER_YAML, 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) {
    throw new Error('devCapabilityProfileIssuer: starter base64 encoding produced unexpected characters');
  }
  return `if [ -f "${BUILD_TARGETS_REMOTE_PATH}" ]; then echo BUILD_TARGETS_PRESENT; else mkdir -p "$HOME/.quoxagent" && echo '${base64}' | base64 -d > "${BUILD_TARGETS_REMOTE_PATH}" && echo BUILD_TARGETS_WRITTEN; fi`;
}

// G2d slice 2 — the dev.backup sibling of the build kit above. Same agent-user
// data dir (quoxagent resolveDataDir: QUOXAGENT_DATA_DIR else $HOME/.quoxagent),
// same $HOME-expands-on-the-host rule.
const BACKUP_CONFIG_REMOTE_PATH = '$HOME/.quoxagent/backup-config.yaml';

// Starter backup config: every value commented out, exactly like the build
// starter, and for the same reason — an engine path and a backup root are
// host-local EXECUTABLE configuration, and nothing executable ships
// uncommented that this host's operator did not choose. Uncommenting a line
// overrides the agent's built-in default; the file exists from enable-time so
// the operator edits rather than creates it (the phase-7 law: registration
// delivers the kit, hand-provisioning a file is a product defect).
const BACKUP_CONFIG_STARTER_YAML = `# QuoxBackup engine config for this dev server (delivered by quox dev enable).
#
# dev.backup runs the backup engine; dev.restore (a separate grant) runs the
# restore engine against an archive this host itself registered. Every setting
# below is COMMENTED OUT and shows the default the agent uses when the line is
# absent — uncomment only what this host actually differs on.
#
# backup_engine: ~/quox-dashboard/scripts/backup-quox.sh
# restore_engine: ~/quox-dashboard/scripts/restore-quox.sh
# backup_root: ~/backups
# container_prefix: quox
# workdir: ~/quox-dashboard
# timeout_seconds:
#   backup: 3600
#   restore: 3600
version: 1
`;

/**
 * Guarded, sudo-free starter write for the backup engine config. Prints
 * BACKUP_CONFIG_PRESENT and leaves the file alone when one already exists (a
 * hand-tuned config must survive re-enable), else writes the starter and
 * prints BACKUP_CONFIG_WRITTEN. Same sentinel discipline as the build kit.
 */
function backupConfigStarterWriteCommand() {
  const base64 = Buffer.from(BACKUP_CONFIG_STARTER_YAML, 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) {
    throw new Error('devCapabilityProfileIssuer: backup starter base64 encoding produced unexpected characters');
  }
  return `if [ -f "${BACKUP_CONFIG_REMOTE_PATH}" ]; then echo BACKUP_CONFIG_PRESENT; else mkdir -p "$HOME/.quoxagent" && echo '${base64}' | base64 -d > "${BACKUP_CONFIG_REMOTE_PATH}" && echo BACKUP_CONFIG_WRITTEN; fi`;
}

function buildProfileWriteCommand(signedProfile) {
  const json = JSON.stringify(signedProfile);
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) {
    throw new Error('devCapabilityProfileIssuer: base64 encoding produced unexpected characters');
  }
  return `sudo mkdir -p '${PROFILE_REMOTE_DIR}' && echo '${base64}' | base64 -d | sudo tee '${PROFILE_REMOTE_PATH}' > /dev/null`;
}

/**
 * quox#462: builds the base64+sudo-tee remote write command for the org's
 * DCSK PUBLIC key, same discipline as buildProfileWriteCommand (base64
 * round-trip, assert the encoded charset, sudo mkdir + sudo tee because a
 * bare `sudo ... > file` redirect runs unprivileged). Writes exactly the
 * {key_id, algorithm, public_key_hex} shape quoxagent's
 * LoadDevTrustedPublicKey expects (devprofile.go's devPublicKeyResponse —
 * the same shape the collector's own public-key proxy already returns over
 * HTTP, now also delivered as a file). Root-owned, same as the profile
 * file it sits beside.
 *
 * @param {{key_id: string, algorithm: string, public_key_hex: string}} keyInfo
 */
function buildSigningKeyWriteCommand(keyInfo) {
  assertSafeString('key_id', keyInfo.key_id, KEY_ID_PATTERN);
  if (typeof keyInfo.public_key_hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyInfo.public_key_hex)) {
    throw new Error(`devCapabilityProfileIssuer: invalid public_key_hex '${keyInfo.public_key_hex}'`);
  }
  const algorithm = typeof keyInfo.algorithm === 'string' && keyInfo.algorithm ? keyInfo.algorithm : 'ed25519';
  assertSafeString('algorithm', algorithm, /^[0-9A-Za-z]{1,32}$/);

  const json = JSON.stringify({
    key_id: keyInfo.key_id,
    algorithm,
    public_key_hex: keyInfo.public_key_hex,
  });
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) {
    throw new Error('devCapabilityProfileIssuer: signing-key base64 encoding produced unexpected characters');
  }
  return `sudo mkdir -p '${PROFILE_REMOTE_DIR}' && echo '${base64}' | base64 -d | sudo tee '${SIGNING_KEY_REMOTE_PATH}' > /dev/null && echo ${SIGNING_KEY_WRITTEN_SENTINEL}`;
}

/**
 * SEC-DEV-PROFILES-1 (2026-08-11 audit) — resolves auth for POST
 * /api/internal/dev-profiles/enable (the `quox dev enable` route).
 *
 * This is a privileged action: it signs a real CapabilityProfile and
 * delivers it to a target host, enrolling that host into a SPECIFIC org's
 * governed dev.* capabilities. Org identity must therefore come EXCLUSIVELY
 * from the caller's own verified session (req.user.org_id) — never a
 * caller-supplied body.org_id, which previously let any authenticated
 * caller assert an arbitrary target org regardless of their real session,
 * and never a silent 'default' fallback, which would enroll a host into the
 * wrong tenant's capability set with no explicit request for that.
 *
 * Also requires a REAL JWT-authenticated user — deliberately does NOT
 * accept the plain shared INTERNAL_SERVICE_KEY branch of
 * requireServiceOrUserAuth() (that branch sets req.service with no bound
 * org or role at all; see utils/httpAuth.js), unlike the qlusterAdminGate /
 * isAdminCaller() pattern used for qluster enroll/issue and gpu
 * enroll/issue (server.js ~4040), which treats ANY service-key caller as
 * admin. A route this privileged must not be reachable by anyone holding
 * the shared key alone.
 *
 * Checks req.user.dashboardRole rather than req.user.role: per
 * requireAuth()'s own comment in utils/httpAuth.js, req.user.role is
 * intentionally left unset for JWT callers today (other routes that gate on
 * it are dead code for JWT callers) — dashboardRole is the field actually
 * populated from the verified JWT's org role.
 *
 * @returns {{ok: true, orgId: string} | {ok: false, status: number, body: object}}
 */
function resolveDevProfileEnableAuth(req) {
  if (!req || !req.user || !req.user.org_id) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'user_auth_required',
        message: 'A real authenticated user session (JWT) with an org context is required for this action; the shared service key is not accepted.',
      },
    };
  }
  // Same semantics as httpAuth's ADMIN_ROLES: owner outranks admin. The
  // earlier hand-rolled `!== 'admin'` 403d org OWNERS (found 2026-08-15 when
  // the ExampleVPN org owner could not dev-enable their own hosts). Service
  // callers are still rejected above; only the human role set widened.
  if (req.user.dashboardRole && !['owner', 'admin'].includes(req.user.dashboardRole)) {
    return { ok: false, status: 403, body: { error: 'admin_required' } };
  }
  return { ok: true, orgId: req.user.org_id };
}

/**
 * Orchestrates the full "register as dev server" flow: resolve the org's
 * active signing key, build + sign a CapabilityProfile for hostId, and
 * deliver it via callBastion. Never writes anything until the profile is
 * actually signed.
 *
 * @param {{callBastion: Function, authServiceUrl?: string, internalServiceKey?: string, now?: () => Date}} deps
 * @param {{hostId: string, orgId: string, capabilities?: string[], maxConcurrentSessions?: number, ttlSeconds?: number}} opts
 */
async function issueDevCapabilityProfile(deps, opts) {
  const {
    callBastion,
    authServiceUrl = AUTH_SERVICE_URL,
    internalServiceKey = process.env.INTERNAL_SERVICE_KEY,
    now = () => new Date(),
  } = deps || {};
  const { hostId, orgId, capabilities, maxConcurrentSessions, ttlSeconds } = opts || {};

  if (typeof callBastion !== 'function') {
    throw new Error('devCapabilityProfileIssuer: callBastion dependency is required');
  }
  if (!internalServiceKey) {
    throw new Error('devCapabilityProfileIssuer: INTERNAL_SERVICE_KEY not configured');
  }
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('devCapabilityProfileIssuer: org_id is required');
  }

  const safeHostId = sanitizeHostId(hostId);
  const caps = sanitizeCapabilities(
    Array.isArray(capabilities) && capabilities.length > 0 ? capabilities : [DEFAULT_CAPABILITY]
  );
  const maxSessions = Number.isInteger(maxConcurrentSessions) && maxConcurrentSessions >= 0 ? maxConcurrentSessions : 0;

  const issuedAt = now();
  const expiresAt = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? new Date(issuedAt.getTime() + ttlSeconds * 1000) : null;

  const authDeps = { authServiceUrl, internalServiceKey };

  // Resolve the currently-active signing key FIRST — key_id is embedded in
  // the canonical bytes we're about to build and sign.
  const keyInfo = await fetchPublicKeyFromAuth(authDeps, { orgId });

  const canonicalBytes = buildCanonicalBytes({
    version: PROFILE_VERSION,
    hostId: safeHostId,
    capabilities: caps,
    maxConcurrentSessions: maxSessions,
    issuedAt,
    expiresAt,
    keyId: keyInfo.key_id,
  });
  const canonicalBytesHex = canonicalBytes.toString('hex');

  const signResult = await signProfileWithAuth(authDeps, { orgId, canonicalBytesHex });

  // Defence in depth: the oracle resolves the org's active key itself
  // (server-side, not from a caller-supplied key_id) — if it somehow
  // rotated between our two calls, the key_id in the file would no longer
  // match the key that produced the signature it claims to be signed
  // under. Refuse rather than deliver an inconsistent profile.
  if (signResult.key_id !== keyInfo.key_id) {
    throw new Error(
      `devCapabilityProfileIssuer: signing oracle key_id drifted between lookup (${keyInfo.key_id}) and sign (${signResult.key_id}) — refusing to deliver`
    );
  }

  const signedProfile = {
    version: PROFILE_VERSION,
    ...(safeHostId ? { host_id: safeHostId } : {}),
    capabilities: caps,
    max_concurrent_sessions: maxSessions,
    issued_at: toRFC3339(issuedAt),
    ...(expiresAt ? { expires_at: toRFC3339(expiresAt) } : {}),
    key_id: signResult.key_id,
    // quoxagent's CapabilityProfile.Signature is base64
    // (base64.StdEncoding) — the oracle returns hex.
    signature: Buffer.from(signResult.signature, 'hex').toString('base64'),
  };

  const command = buildProfileWriteCommand(signedProfile);
  const result = await callBastion(safeHostId, command);

  if (!result || result.success === false) {
    return {
      delivered: false,
      reason: 'write_failed',
      error: result && result.error,
      hostId: safeHostId,
      orgId,
    };
  }

  const response = {
    delivered: true,
    hostId: safeHostId,
    orgId,
    keyId: signResult.key_id,
    capabilities: caps,
    maxConcurrentSessions: maxSessions,
    issuedAt: toRFC3339(issuedAt),
    expiresAt: expiresAt ? toRFC3339(expiresAt) : null,
    remotePath: PROFILE_REMOTE_PATH,
  };

  // quox#462: deliver the org's DCSK public key alongside the profile so
  // this host can verify it without a shared collector credential. Never
  // throws and never unwinds the profile that already landed — a write
  // failure here degrades to result.signing_key = 'write_failed' and the
  // quoxagent-side fetch fallback still applies (see
  // ResolveDevTrustedPublicKey in quoxagent's devprofile.go).
  try {
    const signingKeyCommand = buildSigningKeyWriteCommand(keyInfo);
    const signingKeyResult = await callBastion(safeHostId, signingKeyCommand);
    const stdout = (signingKeyResult && signingKeyResult.stdout) || '';
    response.signing_key =
      signingKeyResult && signingKeyResult.success !== false && stdout.includes(SIGNING_KEY_WRITTEN_SENTINEL)
        ? 'written'
        : 'write_failed';
  } catch (err) {
    response.signing_key = 'write_failed';
  }

  // Kit delivery (DEVSUITE phase-7 law: registration delivers the full kit,
  // hand steps are product defects). A dev.build grant also provisions the
  // STARTER target registry — guarded so a hand-tuned file on the host is
  // never overwritten, and a kit failure never unwinds the profile that
  // already landed (the caller sees kit.build_targets and can retry).
  if (caps.includes('dev.build')) {
    try {
      const kitResult = await callBastion(safeHostId, buildTargetsStarterWriteCommand());
      const stdout = (kitResult && kitResult.stdout) || '';
      let state = 'write_failed';
      if (kitResult && kitResult.success !== false) {
        if (stdout.includes('BUILD_TARGETS_PRESENT')) state = 'already_present';
        else if (stdout.includes('BUILD_TARGETS_WRITTEN')) state = 'written';
      }
      response.kit = { build_targets: state, path: BUILD_TARGETS_REMOTE_PATH };
    } catch (err) {
      response.kit = { build_targets: 'write_failed', path: BUILD_TARGETS_REMOTE_PATH, error: String(err && err.message || err) };
    }
  }

  // G2d slice 2 — the same kit law for dev.backup: a grant that can run the
  // backup engine arrives with the engine's config already in place, guarded
  // the same way (a hand-tuned config is never overwritten) and equally
  // unable to unwind the profile that already landed. Merged into the same
  // `kit` object rather than replacing it, so a host granted both dev.build
  // and dev.backup reports both outcomes; `path` stays the build path it has
  // always been and the backup one is reported separately.
  if (caps.includes('dev.backup')) {
    try {
      const kitResult = await callBastion(safeHostId, backupConfigStarterWriteCommand());
      const stdout = (kitResult && kitResult.stdout) || '';
      let state = 'write_failed';
      if (kitResult && kitResult.success !== false) {
        if (stdout.includes('BACKUP_CONFIG_PRESENT')) state = 'already_present';
        else if (stdout.includes('BACKUP_CONFIG_WRITTEN')) state = 'written';
      }
      response.kit = { ...(response.kit || {}), backup_config: state, backup_config_path: BACKUP_CONFIG_REMOTE_PATH };
    } catch (err) {
      response.kit = {
        ...(response.kit || {}),
        backup_config: 'write_failed',
        backup_config_path: BACKUP_CONFIG_REMOTE_PATH,
        backup_config_error: String(err && err.message || err),
      };
    }
  }

  return response;
}

module.exports = {
  KNOWN_DEV_CAPABILITIES,
  DEFAULT_CAPABILITY,
  PROFILE_VERSION,
  PROFILE_REMOTE_PATH,
  toRFC3339,
  buildCanonicalBytes,
  fetchPublicKeyFromAuth,
  signProfileWithAuth,
  buildProfileWriteCommand,
  buildSigningKeyWriteCommand,
  SIGNING_KEY_REMOTE_PATH,
  SIGNING_KEY_WRITTEN_SENTINEL,
  buildTargetsStarterWriteCommand,
  BUILD_TARGETS_REMOTE_PATH,
  backupConfigStarterWriteCommand,
  BACKUP_CONFIG_REMOTE_PATH,
  issueDevCapabilityProfile,
  resolveDevProfileEnableAuth,
};

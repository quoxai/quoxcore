/**
 * devResidentProvisioner.js — quox#453 phase 15: gives a `quox dev enable`
 * host its own Ed25519 RESIDENT identity, generated ON the host so the
 * private key never leaves it (no key material ever crosses the wire to
 * this collector or to auth), and registers the public half with the auth
 * service so the resident agent can be recognised as itself rather than as
 * a bearer of the shared org capability profile.
 *
 * DI shape and discipline are deliberately siblings of
 * devCapabilityProfileIssuer.js: {callBastion, authServiceUrl,
 * internalServiceKey, now}, base64-encoded remote command bodies, sentinel
 * strings only this module's own commands emit, "reject, never escape" for
 * anything that reaches a shell string, and a kit-style failure posture — a
 * later step failing (registration, bootstrap delivery) never unwinds a
 * step that already landed; the caller sees state per step and can retry.
 *
 * FLOW
 *   1. One guarded remote command: if $HOME/.quoxagent/resident-identity.key
 *      already exists, leave it alone (RESIDENT_KEY_PRESENT) — a re-enable
 *      must not silently replace a live identity's key. Otherwise generate
 *      a fresh Ed25519 keypair with openssl under umask 077
 *      (RESIDENT_KEY_WRITTEN). Either way, extract the raw 32-byte public
 *      key from the private key file and print it as base64
 *      (RESIDENT_PUBKEY:<b64>). If openssl isn't on the host, emit
 *      RESIDENT_OPENSSL_MISSING and exit 0 — this must never fail the
 *      enable call itself.
 *   2. Parse stdout for the pubkey line; validate it decodes to exactly 32
 *      bytes (Ed25519 raw public key length).
 *   3. Register the public key with auth
 *      (POST /api/internal/resident-identities/register). Plain register
 *      first; only re-call with rotate:true when the host just generated a
 *      BRAND NEW key (keyState 'written') and auth reports the key was
 *      already registered under that host — see the rotate branch's own
 *      comment below for why this is the one case allowed to rotate.
 *   4. Deliver a non-secret bootstrap pointer file onto the host at
 *      $HOME/.config/quox/resident-profile.json — derived config, safe to
 *      overwrite unconditionally (unlike the key itself), created under
 *      umask 077 so it lands 0600 despite carrying no secret.
 *
 * LAUNCH BLOCKER FIX (item 1b, found by the acceptance owner driving `quox
 * dev supervisor` on a real host, 2026-08-23): the bootstrap this step
 * writes carried no "slot" field, so a resident whose supervisor unit was
 * installed with no --slot crashed at startup ("No slot: pass --slot") and
 * busy-looped under systemd Restart=always. Step 4 now includes a `slot`
 * field WHEN one can be resolved through a real link, via the optional
 * `getHostSlot(hostId, orgId)` dependency: the caller wires this to
 * `dev_servers.supervisor_slot` (services/collector/lib/devServersStore.js,
 * getSupervisorSettings), the one place this host's own resolved slot is
 * durably recorded (set by a human via `quox dev supervisor enable
 * --slot`). devSlotsStore.js's `assigned_to` column was considered and
 * REJECTED as a source: it is a free-form session label a human types
 * (e.g. "T5-DEVSUITE"), with no established convention tying it to a
 * host_id, so reading it here would be guessing, not resolving. When
 * getHostSlot is absent, throws, or resolves nothing, the `slot` key is
 * left OFF the bootstrap entirely rather than invented — a wrong slot
 * silently points a resident at someone else's address, which is worse
 * than an absent one that fails loudly (see systemdInstaller/devSupervisor
 * items 1a/1c, which now refuse to install or busy-loop on an absent slot
 * instead of guessing one).
 */

'use strict';

const { sanitizeHostId } = require('./skillPackInstaller.js');

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const FETCH_TIMEOUT_MS = 10000;

// Mirrors quoxagent's own resident-identity convention (see phase 15 plan
// doc): a dedicated key file under the agent's data dir, never reused from
// any other identity material on the host.
const RESIDENT_KEY_PATH = '$HOME/.quoxagent/resident-identity.key';
const RESIDENT_KEY_DIR = '$HOME/.quoxagent';
const BOOTSTRAP_REMOTE_PATH = '$HOME/.config/quox/resident-profile.json';
const BOOTSTRAP_REMOTE_DIR = '$HOME/.config/quox';

// Sentinel strings — only this module's own remote command ever emits
// these, so parsing stdout for them (rather than trying to interpret exit
// codes or freeform openssl output) can't collide with unrelated shell
// noise a host might produce.
const SENTINEL_KEY_PRESENT = 'RESIDENT_KEY_PRESENT';
const SENTINEL_KEY_WRITTEN = 'RESIDENT_KEY_WRITTEN';
const SENTINEL_OPENSSL_MISSING = 'RESIDENT_OPENSSL_MISSING';
const SENTINEL_PROFILE_WRITTEN = 'RESIDENT_PROFILE_WRITTEN';
const PUBKEY_LINE_PATTERN = /RESIDENT_PUBKEY:([A-Za-z0-9+/=]*)/;

/**
 * Builds the single guarded remote command that generates (or reuses) the
 * host's own Ed25519 resident key and prints its raw public half as
 * base64. No caller-supplied value is interpolated into this string at
 * all — hostId is only ever passed to callBastion() as a routing argument,
 * never embedded in the command text (sanitizeHostId() is still called on
 * it by the caller below, for the same "reject, never escape" reason every
 * sibling module in this dir validates its inputs even when a given input
 * happens not to reach the shell).
 *
 * Ed25519 SPKI DER (openssl pkey -pubout -outform DER) is exactly 44 bytes
 * — a fixed 12-byte AlgorithmIdentifier/SEQUENCE header followed by the
 * 32-byte raw public key — so `tail -c 32` on the DER bytes always yields
 * the raw key, regardless of which OpenSSL build produced it.
 */
function buildResidentKeyCommand() {
  return (
    // quox#455 gap 2: the host's own quoxagent config names the collector
    // URL this host DEMONSTRABLY reaches (it heartbeats there) — read it
    // back so the bootstrap can carry real reach-back URLs instead of the
    // CLI deriving them by port/scheme guesswork later.
    // quoxagent.yaml is root-owned 0600 on real hosts (found live on .131,
    // quox#455 follow-up): the plain read comes back empty there, so fall
    // back to sudo -n — non-interactive, fails fast without passwordless
    // sudo instead of hanging the Bastion exec (same discipline as
    // devServerRefresh.js).
    `CURL_LINE=$(sed -n 's/^[[:space:]]*collector_url:[[:space:]]*//p' /etc/quoxagent/quoxagent.yaml 2>/dev/null | head -1); ` +
    `if [ -z "$CURL_LINE" ]; then CURL_LINE=$(sudo -n sed -n 's/^[[:space:]]*collector_url:[[:space:]]*//p' /etc/quoxagent/quoxagent.yaml 2>/dev/null | head -1); fi; ` +
    `echo "RESIDENT_COLLECTOR_URL:$CURL_LINE"; ` +
    `KEY_PATH="${RESIDENT_KEY_PATH}"; ` +
    `if ! command -v openssl >/dev/null 2>&1; then echo ${SENTINEL_OPENSSL_MISSING}; ` +
    `else ` +
    `if [ -f "$KEY_PATH" ]; then echo ${SENTINEL_KEY_PRESENT}; ` +
    `else mkdir -p "${RESIDENT_KEY_DIR}" && umask 077 && openssl genpkey -algorithm ed25519 -out "$KEY_PATH" && echo ${SENTINEL_KEY_WRITTEN}; fi; ` +
    `PUBB64=$(openssl pkey -in "$KEY_PATH" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 -w0); ` +
    `echo "RESIDENT_PUBKEY:$PUBB64"; ` +
    `fi`
  );
}

const COLLECTOR_URL_LINE_PATTERN = /RESIDENT_COLLECTOR_URL:(\S+)/;

/**
 * Validates a URL read back from a remote host before it is embedded in
 * the bootstrap file: http(s) only, parseable, no embedded whitespace
 * (already excluded by the \S+ capture). Returns the normalized origin or
 * null — a malformed value degrades to "no collector_url", never an error.
 */
function sanitizeRemoteUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  // YAML values commonly arrive quoted ('key: "http://..."' — seen live on
  // .131); strip one layer of surrounding quotes before parsing.
  const unquoted = value.replace(/^["']/, '').replace(/["']$/, '');
  try {
    const url = new URL(unquoted);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch (_err) {
    return null;
  }
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * quox#455: resolve the instance edge URL the RESIDENT should use.
 * - When the host told us its own collector address, derive the edge from
 *   THAT (https://<collector-host>:3000), matching the wrapper convention.
 * - Only with no collector address do we consider the caller's URL, and a
 *   loopback caller URL then resolves to null rather than a lie.
 */
function deriveInstanceUrl(instanceUrl, collectorUrl) {
  const collectorHost = collectorUrl ? new URL(collectorUrl).hostname : null;
  // The dev host's own CLI wrapper (devServerRefresh.js) exports
  // QUOX_AUTH_URL=https://<collectorHost>:3000, so that IS the edge
  // convention on every dev-enabled host. Derive the same thing here rather
  // than trusting the enabling admin's profile URL: found live on
  // exampleestate-website, where an admin whose profile read
  // http://<host>:3000 stamped a bootstrap that answers 400 (plain HTTP to
  // an HTTPS port). The admin's vantage point is also not the dev host's,
  // so a public/DNS admin URL can be unreachable from the host entirely.
  // Known limitation, shared with the wrapper: an install whose edge is not
  // https on 3000 needs the per-profile override.
  if (collectorHost) return `https://${collectorHost}:3000`;
  if (instanceUrl) {
    try {
      const url = new URL(instanceUrl);
      if (LOCAL_HOSTNAMES.has(url.hostname)) {
        // quox#455 follow-up: a loopback URL must NEVER be written into a
        // remote host's bootstrap. With no collector host to swap in,
        // null is honest ("derive it yourself / configure the profile");
        // http://localhost:3000 on a remote box is a lie that costs the
        // resident a manual override to discover and undo.
        return null;
      }
      return url.origin;
    } catch (_err) {
      // fall through to derivation
    }
  }
  if (collectorHost) return `https://${collectorHost}:3000`;
  return null;
}

/**
 * Parses the remote key command's stdout. Never throws — an unexpected or
 * empty stdout is just another "keygen_failed" outcome for the caller to
 * report and retry, same posture as the rest of this module.
 *
 * @returns {{ok: true, keyState: 'present'|'written', publicKeyB64: string} | {ok: false, reason: 'openssl_missing'|'keygen_failed'}}
 */
function parseResidentKeyOutput(stdout) {
  const out = typeof stdout === 'string' ? stdout : '';
  if (out.includes(SENTINEL_OPENSSL_MISSING)) {
    return { ok: false, reason: 'openssl_missing' };
  }

  const match = out.match(PUBKEY_LINE_PATTERN);
  if (!match || !match[1]) {
    return { ok: false, reason: 'keygen_failed' };
  }

  let raw;
  try {
    raw = Buffer.from(match[1], 'base64');
  } catch (_err) {
    return { ok: false, reason: 'keygen_failed' };
  }
  // Ed25519 raw public keys are exactly 32 bytes — anything else means the
  // extraction pipeline produced garbage (truncated DER, wrong algorithm,
  // corrupted key file) and must not be registered.
  if (raw.length !== 32) {
    return { ok: false, reason: 'keygen_failed' };
  }

  const keyState = out.includes(SENTINEL_KEY_WRITTEN) ? 'written' : 'present';
  const collectorMatch = out.match(COLLECTOR_URL_LINE_PATTERN);
  const collectorUrl = collectorMatch ? sanitizeRemoteUrl(collectorMatch[1]) : null;
  return { ok: true, keyState, publicKeyB64: match[1], collectorUrl };
}

/**
 * Registers (or rotates) the host's public key with auth.
 * POST {authServiceUrl}/api/internal/resident-identities/register
 *
 * Never throws — a network error or non-2xx response resolves to a
 * {registered: false} result the caller folds into provisioned:false,
 * matching this module's "never fail the enable call" posture.
 */
async function registerResidentIdentity({ authServiceUrl, internalServiceKey }, { orgId, hostId, publicKeyB64, rotate }) {
  const url = `${authServiceUrl}/api/internal/resident-identities/register`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': internalServiceKey || '' },
      body: JSON.stringify({
        org_id: orgId,
        host_id: hostId,
        public_key_b64: publicKeyB64,
        ...(rotate ? { rotate: true } : {}),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { registered: false, status: null, error: String((err && err.message) || err) };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return { registered: false, status: resp.status, error: text };
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    return { registered: false, status: resp.status, error: `invalid JSON response: ${err.message}` };
  }

  return {
    registered: true,
    status: resp.status,
    identityId: body && body.identity_id,
    userId: body && body.user_id,
    keyId: body && body.key_id,
    alreadyRegistered: !!(body && body.already_registered),
  };
}

/**
 * Guarded (unconditional-overwrite-is-fine) write of the non-secret
 * bootstrap pointer file — same base64 + quote discipline as
 * devCapabilityProfileIssuer.js's buildProfileWriteCommand(), but no sudo
 * (this lands under the invoking user's own $HOME, not /etc) and wrapped
 * in `umask 077` so the created file is 0600 despite carrying nothing
 * secret itself (just org/host/key identifiers and a key file path).
 */
function buildBootstrapWriteCommand(bootstrapJson) {
  const json = JSON.stringify(bootstrapJson);
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) {
    throw new Error('devResidentProvisioner: bootstrap base64 encoding produced unexpected characters');
  }
  return (
    `umask 077 && mkdir -p "${BOOTSTRAP_REMOTE_DIR}" && ` +
    `echo '${base64}' | base64 -d > "${BOOTSTRAP_REMOTE_PATH}" && echo ${SENTINEL_PROFILE_WRITTEN}`
  );
}

/**
 * Orchestrates the full resident-identity provisioning flow for one host.
 * Never throws for expected failure modes (missing openssl, keygen/parse
 * failure, registration failure, bootstrap write failure) — every one of
 * those resolves to a structured result the caller (server.js's
 * dev-profiles/enable route) attaches to its response, so a resident-
 * identity hiccup never fails the enable call itself. It only throws for
 * programmer errors (missing callBastion dependency), same posture as
 * issueDevCapabilityProfile()'s own dependency checks.
 *
 * @param {{callBastion: Function, authServiceUrl?: string, internalServiceKey?: string, now?: () => Date, getHostSlot?: (hostId: string, orgId: string) => (string|null|Promise<string|null>)}} deps
 * @param {{hostId: string, orgId: string, instanceUrl?: string}} opts
 */
async function provisionResidentIdentity(deps, opts) {
  const {
    callBastion,
    authServiceUrl = AUTH_SERVICE_URL,
    internalServiceKey = process.env.INTERNAL_SERVICE_KEY,
    getHostSlot,
  } = deps || {};
  const { hostId, orgId, instanceUrl } = opts || {};

  if (typeof callBastion !== 'function') {
    throw new Error('devResidentProvisioner: callBastion dependency is required');
  }
  if (!orgId || typeof orgId !== 'string') {
    return { provisioned: false, reason: 'error', error: 'org_id is required' };
  }

  let safeHostId;
  try {
    safeHostId = sanitizeHostId(hostId);
  } catch (err) {
    return { provisioned: false, reason: 'error', error: err.message };
  }

  // Step 1 + 2: generate (or reuse) the resident key on the host, extract
  // and validate its public half.
  let keyResult;
  try {
    const keyCommand = buildResidentKeyCommand();
    const remote = await callBastion(safeHostId, keyCommand);
    if (!remote || remote.success === false) {
      return { provisioned: false, reason: 'keygen_failed', error: remote && remote.error, hostId: safeHostId };
    }
    keyResult = parseResidentKeyOutput(remote.stdout);
  } catch (err) {
    return { provisioned: false, reason: 'keygen_failed', error: String((err && err.message) || err), hostId: safeHostId };
  }

  if (!keyResult.ok) {
    return { provisioned: false, reason: keyResult.reason, hostId: safeHostId };
  }

  // Step 3: register the public key. Plain register first — never rotate
  // on a bare re-enable.
  const registerDeps = { authServiceUrl, internalServiceKey };
  let regResult = await registerResidentIdentity(registerDeps, {
    orgId,
    hostId: safeHostId,
    publicKeyB64: keyResult.publicKeyB64,
  });

  if (!regResult.registered) {
    return {
      provisioned: false,
      reason: 'register_failed',
      status: regResult.status,
      error: regResult.error,
      hostId: safeHostId,
    };
  }

  // Rotate ONLY when the host just generated a brand-new key file
  // (keyState 'written') and auth still reports the identity as already
  // registered — a fresh disk (rebuilt host, deleted key dir) means the
  // key on record can no longer be the one that just wrote to disk, so it
  // must be replaced. A plain re-enable against an INTACT key
  // (keyState 'present') must never rotate merely because auth already
  // knows this host — that would let every routine re-enable silently
  // invalidate a live identity's registration.
  if (keyResult.keyState === 'written' && regResult.alreadyRegistered) {
    regResult = await registerResidentIdentity(registerDeps, {
      orgId,
      hostId: safeHostId,
      publicKeyB64: keyResult.publicKeyB64,
      rotate: true,
    });
    if (!regResult.registered) {
      return {
        provisioned: false,
        reason: 'register_failed',
        status: regResult.status,
        error: regResult.error,
        hostId: safeHostId,
      };
    }
  }

  // Step 4: deliver the non-secret bootstrap pointer file. A failure here
  // never unwinds the registration that already landed — the identity is
  // real and usable even if the pointer file delivery needs a retry.
  let bootstrapState = 'write_failed';
  const resolvedInstanceUrl = deriveInstanceUrl(instanceUrl, keyResult.collectorUrl);

  // Item 1b: resolve this host's REAL slot, never a guessed one. A failure
  // or absence here is silent by design (the key/registration already
  // succeeded above and must not be unwound over a missing slot) — it just
  // means the bootstrap ships without one, same as before this fix.
  let resolvedSlot = null;
  if (typeof getHostSlot === 'function') {
    try {
      resolvedSlot = (await getHostSlot(safeHostId, orgId)) || null;
    } catch (_err) {
      resolvedSlot = null;
    }
  }

  try {
    const bootstrapJson = {
      kind: 'resident',
      org_id: orgId,
      host_id: safeHostId,
      key_id: regResult.keyId,
      key_path: '~/.quoxagent/resident-identity.key',
      instance_url: resolvedInstanceUrl,
      collector_url: keyResult.collectorUrl || null,
      ...(resolvedSlot ? { slot: resolvedSlot } : {}),
    };
    const bootstrapResult = await callBastion(safeHostId, buildBootstrapWriteCommand(bootstrapJson));
    const stdout = (bootstrapResult && bootstrapResult.stdout) || '';
    if (bootstrapResult && bootstrapResult.success !== false && stdout.includes(SENTINEL_PROFILE_WRITTEN)) {
      bootstrapState = 'written';
    }
  } catch (_err) {
    bootstrapState = 'write_failed';
  }

  return {
    provisioned: true,
    keyState: keyResult.keyState,
    identityId: regResult.identityId,
    userId: regResult.userId,
    keyId: regResult.keyId,
    alreadyRegistered: regResult.alreadyRegistered,
    bootstrap: bootstrapState,
    instanceUrl: resolvedInstanceUrl,
    collectorUrl: keyResult.collectorUrl || null,
  };
}

module.exports = {
  RESIDENT_KEY_PATH,
  BOOTSTRAP_REMOTE_PATH,
  buildResidentKeyCommand,
  parseResidentKeyOutput,
  registerResidentIdentity,
  buildBootstrapWriteCommand,
  provisionResidentIdentity,
  sanitizeRemoteUrl,
  deriveInstanceUrl,
};

/**
 * Bootstrap-credential fallback (BASTION-CRED Phase 2, collector side).
 *
 * Privilege escalation and day-2 operational SSH share one credential slot in
 * QuoxBastion (host.SSH.User/KeyID). On a host whose day-2 user has no
 * NOPASSWD sudo, Bastion's own sudo-setup tool hits "sudo: a password is
 * required" and nothing in the system can get past it. This module is the
 * narrow escape hatch: a host may be linked (host.ssh.bootstrap_credential_id
 * in the Bastion registry) to a QuoxVault ssh_key credential with
 * metadata purpose "bootstrap" — typically the template's root key captured
 * at clone time or entered by the owner at enrollment.
 *
 * The fallback lives in the COLLECTOR, not Bastion, by design: Bastion has no
 * vault client, and the vault-backed SSH path (credential-decrypt + TOFU
 * known-host pinning) already exists here for remote_ssh. See the BASTION-CRED
 * plan v2 in QuoxPlan for the full design decisions.
 *
 * Sequence (grantNopasswdViaBootstrap):
 *   1. resolve host + linked bootstrap credential id from Bastion registry
 *   2. decrypt the credential via the auth internal endpoint (in-memory only)
 *   3. SSH directly as the bootstrap user (TOFU-verified) and write a
 *      visudo-validated /etc/sudoers.d drop-in for the day-2 user
 *   4. VERIFY through the normal day-2 Bastion path (`sudo -n true`) — this
 *      replaces any grace window: nothing is revoked until day-2 sudo works
 *   5. best-effort strip the bootstrap public key from authorized_keys
 *   6. clear the host's registry link; delete the vault credential ONLY if
 *      no other host still references it (template clones share one key)
 *
 * SECURITY: the decrypted private key is used only to open the SSH
 * connection, is never logged, never included in results, and the local
 * reference is dropped as soon as the connection attempts settle. Steps 5-6
 * exist so the root credential does not outlive its one job.
 */

const { runSshCommand } = require('./toolExecutors/ssh');
const { buildInternalServiceHeaders } = require('./internalServiceHeaders');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}/api`;

// Matches Bastion's exact sudo-setup sentinel (internal/tools/builtins/
// sudo_setup.go) plus raw sudo stderr from the /api/v1/exec path.
const SUDO_PASSWORD_PATTERN = /sudo_password_required|a (?:password|terminal) is required/i;

// POSIX-ish username: no shell metacharacters can pass this.
const SAFE_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

function isSudoPasswordFailure(result) {
  if (!result || typeof result !== 'object') return false;
  return SUDO_PASSWORD_PATTERN.test(
    [result.error, result.stderr, result.output, result.detail].filter(Boolean).join('\n')
  );
}

function bastionConfig() {
  return {
    url: process.env.BASTION_URL || '',
    token: process.env.BASTION_API_TOKEN || '',
  };
}

/**
 * Run the full bootstrap escalation for one host.
 *
 * @param {object} opts
 * @param {string} opts.hostId  - Bastion host registry id
 * @param {string} opts.orgId   - org owning the vault credential (TOFU store scope too)
 * @param {string} [opts.user]  - day-2 user to grant NOPASSWD to; defaults to the host's registered SSH user
 * @param {object} [opts.deps]  - test seams: { fetchImpl, runSsh }
 * @returns {Promise<{success: boolean, code?: string, detail?: string, steps: Array<{step: string, status: string, detail?: string}>}>}
 */
async function grantNopasswdViaBootstrap({ hostId, orgId, user, deps = {} }) {
  const fetchImpl = deps.fetchImpl || fetch;
  const runSsh = deps.runSsh || runSshCommand;
  const steps = [];
  const fail = (code, detail) => ({ success: false, code, detail, steps });
  const step = (name, status, detail) => steps.push({ step: name, status, ...(detail ? { detail } : {}) });

  const { url: bastionUrl, token: bastionToken } = bastionConfig();
  if (!bastionUrl || !bastionToken) return fail('bastion_unconfigured', 'BASTION_URL/BASTION_API_TOKEN unset');
  if (!hostId || !orgId) return fail('missing_context', 'hostId and orgId are required');

  const bastionHeaders = { 'Authorization': `Bearer ${bastionToken}`, 'Content-Type': 'application/json' };

  // 1. Host + linked credential
  let host;
  try {
    const r = await fetchImpl(`${bastionUrl}/api/v1/hosts/${encodeURIComponent(hostId)}`, {
      headers: bastionHeaders, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return fail('host_not_found', `Bastion returned ${r.status} for host ${hostId}`);
    const data = await r.json();
    host = data && data.host ? data.host : data;
  } catch (err) {
    return fail('host_not_found', `Bastion host lookup failed: ${err.message}`);
  }
  step('resolve_host', 'ok');

  const credentialId = host && host.ssh && host.ssh.bootstrap_credential_id;
  if (!credentialId) {
    return fail('no_bootstrap_credential',
      `Host ${hostId} has no bootstrap_credential_id in the Bastion registry. ` +
      `Register a bootstrap (root) ssh_key credential in the vault with metadata {"purpose":"bootstrap"} and link it to the host.`);
  }
  step('resolve_credential', 'ok');

  const grantUser = user || (host.ssh && host.ssh.user) || 'control';
  if (!SAFE_USER_PATTERN.test(grantUser)) return fail('invalid_user', `Unsafe username: ${JSON.stringify(grantUser)}`);

  const hostAddress = host.ip || host.fqdn;
  if (!hostAddress) return fail('host_not_found', `Host ${hostId} has no ip/fqdn in the registry`);

  // 2. Decrypt bootstrap credential (in-memory only, never logged/returned)
  let privateKey, passphrase, bootstrapUser, publicKey;
  try {
    const r = await fetchImpl(
      `${AUTH_BASE_URL}/setup/internal/credential-decrypt/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`,
      { headers: buildInternalServiceHeaders(), signal: AbortSignal.timeout(15000) }
    );
    if (!r.ok) return fail('credential_resolve_failed', `credential-decrypt returned ${r.status}`);
    const data = await r.json();
    const creds = (data && data.credentials) || {};
    privateKey = creds.private_key;
    passphrase = creds.passphrase;
    bootstrapUser = creds.username || 'root';
    publicKey = creds.public_key || null;
  } catch (err) {
    return fail('credential_resolve_failed', `credential-decrypt failed: ${err.message}`);
  }
  if (!privateKey) return fail('credential_resolve_failed', 'credential has no private_key (not an ssh_key credential?)');
  step('decrypt', 'ok');

  // TOFU host-key verification, same store and semantics as remote_ssh.
  const verifyHostKey = async (fingerprint, keyType) => {
    const resp = await fetchImpl(`${AUTH_BASE_URL}/setup/internal/ssh-known-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...buildInternalServiceHeaders() },
      body: JSON.stringify({ org_id: orgId, host: hostAddress, port: (host.ssh && host.ssh.port) || 22, fingerprint, key_type: keyType }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 409) return { status: 'drift' };
    if (!resp.ok) throw new Error(`ssh-known-host verification failed with status ${resp.status}`);
    return await resp.json();
  };

  // 3. Grant: visudo-validated sudoers.d drop-in, written as the bootstrap
  // user (root). Mirrors Bastion's own sudo_setup.go approach; kept minimal
  // and validated rather than reimplementing its full script.
  // The privileged writes assume a root bootstrap login (the common case: a
  // template's root key). To also support a passwordless-sudo bootstrap user,
  // prefix the privileged ops with `sudo -n` when the login is not uid 0.
  // `sudo -n` never prompts, so a bootstrap user that would need a password
  // fails fast rather than hanging — which is correct, it isn't a usable
  // bootstrap credential.
  const sudoersFile = `/etc/sudoers.d/quox-${grantUser}`;
  const grantCmd =
    `set -e; ` +
    `SUDO=''; if [ "$(id -u)" -ne 0 ]; then SUDO='sudo -n'; fi; ` +
    `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' '${grantUser}' | $SUDO tee ${sudoersFile}.tmp >/dev/null; ` +
    `$SUDO visudo -cf ${sudoersFile}.tmp; ` +
    `$SUDO chmod 440 ${sudoersFile}.tmp; ` +
    `$SUDO mv ${sudoersFile}.tmp ${sudoersFile}`;
  try {
    const sshBase = {
      host: hostAddress,
      port: (host.ssh && host.ssh.port) || 22,
      username: bootstrapUser,
      privateKey,
      passphrase,
      verifyHostKey,
    };
    const grantResult = await runSsh({ ...sshBase, command: grantCmd });
    if (grantResult.code !== 0) {
      return fail('grant_failed', `sudoers grant exited ${grantResult.code}: ${String(grantResult.stderr || '').slice(0, 300)}`);
    }
    step('grant', 'ok');

    // 4. Verify through the day-2 path BEFORE any revocation.
    let verified = false;
    try {
      const vr = await fetchImpl(`${bastionUrl}/api/v1/exec`, {
        method: 'POST',
        headers: bastionHeaders,
        body: JSON.stringify({ targets: [hostId], command: 'sudo -n true' }),
        signal: AbortSignal.timeout(65000),
      });
      if (vr.ok) {
        const vd = await vr.json();
        const res0 = vd && vd.results && vd.results[0];
        verified = !!res0 && res0.exit_code === 0;
      }
    } catch { /* verified stays false */ }
    if (!verified) {
      step('verify', 'failed');
      return fail('verify_failed',
        `NOPASSWD grant was written but 'sudo -n true' via the day-2 Bastion path did not succeed. ` +
        `Nothing was revoked; the bootstrap credential remains linked for troubleshooting.`);
    }
    step('verify', 'ok');

    // 5. Best-effort: strip the bootstrap public key from authorized_keys so
    // the root credential does not keep working after its one job. Uses the
    // key BODY (second field) as an exact fixed-string match.
    const keyBody = publicKey ? String(publicKey).trim().split(/\s+/)[1] : null;
    if (keyBody && /^[A-Za-z0-9+/=]+$/.test(keyBody)) {
      try {
        const stripCmd =
          `grep -vF '${keyBody}' ~/.ssh/authorized_keys > /tmp/quox-ak-strip && ` +
          `cat /tmp/quox-ak-strip > ~/.ssh/authorized_keys && rm -f /tmp/quox-ak-strip`;
        const sr = await runSsh({ ...sshBase, command: stripCmd });
        step('strip_key', sr.code === 0 ? 'ok' : 'failed', sr.code === 0 ? undefined : `exit ${sr.code}`);
      } catch (err) {
        step('strip_key', 'failed', err.message);
      }
    } else {
      step('strip_key', 'skipped', 'credential has no public_key to match against');
    }
  } finally {
    privateKey = null;
    passphrase = null;
  }

  // 6a. Clear the host's registry link (send the updated ssh block back).
  try {
    const r = await fetchImpl(`${bastionUrl}/api/v1/hosts/${encodeURIComponent(hostId)}`, {
      method: 'PUT',
      headers: bastionHeaders,
      body: JSON.stringify({ ssh: { ...host.ssh, bootstrap_credential_id: '' } }),
      signal: AbortSignal.timeout(10000),
    });
    step('clear_link', r.ok ? 'ok' : 'failed', r.ok ? undefined : `Bastion returned ${r.status}`);
  } catch (err) {
    step('clear_link', 'failed', err.message);
  }

  // 6b. Delete the vault credential only if no OTHER host still references
  // it (template clones may share one bootstrap key across many hosts).
  try {
    const r = await fetchImpl(`${bastionUrl}/api/v1/hosts`, {
      headers: bastionHeaders, signal: AbortSignal.timeout(10000),
    });
    const data = r.ok ? await r.json() : null;
    const allHosts = (data && (data.hosts || data)) || [];
    const stillReferenced = Array.isArray(allHosts) && allHosts.some(h =>
      h && h.id !== hostId && h.ssh && h.ssh.bootstrap_credential_id === credentialId
    );
    if (stillReferenced) {
      step('delete_credential', 'skipped', 'still referenced by another host');
    } else {
      const dr = await fetchImpl(
        `${AUTH_BASE_URL}/internal/integrations/${encodeURIComponent(credentialId)}?org_id=${encodeURIComponent(orgId)}`,
        { method: 'DELETE', headers: buildInternalServiceHeaders(), signal: AbortSignal.timeout(10000) }
      );
      step('delete_credential', (dr.ok || dr.status === 204) ? 'ok' : 'failed',
        (dr.ok || dr.status === 204) ? undefined : `auth returned ${dr.status}`);
    }
  } catch (err) {
    step('delete_credential', 'failed', err.message);
  }

  return {
    success: true,
    detail: `NOPASSWD sudo granted to ${grantUser} on ${hostId} via bootstrap credential; verified through the day-2 path.`,
    steps,
  };
}

module.exports = { grantNopasswdViaBootstrap, isSudoPasswordFailure };

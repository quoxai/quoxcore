/**
 * SSH Tool Executor
 *
 * VAULT-AUDIT P4.A-collector — native executor for the `remote_ssh` agent
 * tool. Owns the SSH connection lifecycle only (connect w/ TOFU host-key
 * verification -> exec -> collect stdout/stderr/exit code -> disconnect) —
 * credential resolution, input validation, and response shaping live in
 * agentTools.js.
 *
 * SECURITY: this module is handed a plaintext private key (and optional
 * passphrase) by the caller for the sole purpose of opening the SSH
 * connection. The key is NEVER logged, NEVER returned, and the local
 * reference held by this function is nulled out once the connection
 * attempt has resolved or rejected.
 *
 * Host-key verification is TOFU-style (trust-on-first-use) and delegated
 * entirely to the `verifyHostKey` callback the caller supplies — this
 * module stays pure/testable and knows nothing about the P4.A-auth
 * ssh-known-hosts HTTP endpoint. Drift is a HARD FAIL: if verifyHostKey
 * reports `status: 'drift'`, ssh2's hostVerifier rejects the handshake and
 * the connection is aborted BEFORE any command execution (never connect,
 * never exec).
 *
 * Testing seam: the ssh2 Client class is passed in by the caller
 * (agentTools.js) rather than required at module scope here — same
 * rationale as toolExecutors/email.js's ImapFlow seam (vitest's module
 * runner does not intercept nested CJS require() calls for bare npm
 * specifiers reliably in this repo's CJS/ESM hybrid setup, and a
 * module-local seam on *this* file wouldn't help either because
 * agentTools.js reaches this module via require() while a vitest spec
 * reaches it via import() — different module cache entries). Passing the
 * implementation through as a call argument avoids the shared-module-
 * instance assumption entirely — agentTools.js exposes
 * __setSshClientForTesting on itself (same instance the test's TOOL_DEFS
 * import uses).
 */

// ssh2 is required LAZILY (inside runSshCommand) rather than at module load.
// Loading it eagerly ran ssh2's async crypto probe (poly1305) the moment this
// file was required — including on paths that only READ tool config (e.g. the
// access_mode lookup in approvalGate), never opening a connection. In jsdom
// that probe rejects unhandled and kept the vitest suite's exit code non-zero.
// Deferring the require means ssh2 loads only when an SSH command actually runs.
function getRealSshClient() {
  return require('ssh2').Client;
}
const crypto = require('crypto');

/**
 * Compute the OpenSSH-style SHA256 fingerprint for a raw host key buffer.
 * e.g. "SHA256:abcdef123..." (base64, no padding).
 */
function sha256Fingerprint(hostKeyBuffer) {
  return 'SHA256:' + crypto.createHash('sha256').update(hostKeyBuffer).digest('base64').replace(/=+$/, '');
}

/**
 * Connect to a host over SSH, verify the host key TOFU-style, run a single
 * command, and return its output. The private key/passphrase are used only
 * to authenticate the connection and are never included in the result.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number|string} [opts.port=22]
 * @param {string} opts.username
 * @param {string} opts.privateKey - never logged/returned
 * @param {string} [opts.passphrase] - never logged/returned
 * @param {string} opts.command
 * @param {number} [opts.readyTimeout=15000]
 * @param {Function} [opts.Client] - ssh2 Client class override (testing)
 * @param {Function} opts.verifyHostKey - async (fingerprint, keyType) => { status: 'first_use'|'ok'|'drift' }
 * @returns {Promise<{stdout: string, stderr: string, code: number|null}>}
 */
async function runSshCommand({
  host,
  port = 22,
  username,
  privateKey,
  passphrase,
  command,
  readyTimeout = 15000,
  Client,
  verifyHostKey,
}) {
  // Lazy: resolve the real ssh2 Client only now (never at module load), unless
  // a test injected its own Client.
  const ConnClient = Client || getRealSshClient();
  // Local references only — nulled in finish() once the attempt settles.
  // Never assigned anywhere else, never logged, never returned.
  let key = privateKey;
  let pass = passphrase;

  return new Promise((resolve, reject) => {
    const conn = new ConnClient();
    let driftDetected = false;
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      key = null;
      pass = null;
      fn(arg);
    };

    // ssh2's modern hostVerifier contract: (rawHostKeyBuffer, callback) —
    // call callback(true) to proceed with the handshake, callback(false) to
    // reject + disconnect. We fingerprint the raw key and defer the
    // accept/reject decision to the caller-supplied verifyHostKey.
    const hostVerifier = (hostKeyBuffer, callback) => {
      const fingerprint = sha256Fingerprint(hostKeyBuffer);
      Promise.resolve()
        .then(() => verifyHostKey(fingerprint))
        .then((result) => {
          if (result && result.status === 'drift') {
            driftDetected = true;
            callback(false);
          } else {
            callback(true);
          }
        })
        .catch(() => {
          // Fail-closed: any error verifying the host key means we cannot
          // safely proceed — treat it the same as drift.
          driftDetected = true;
          callback(false);
        });
    };

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          try { conn.end(); } catch { /* non-fatal */ }
          finish(reject, new Error(err?.message ? String(err.message).slice(0, 300) : 'SSH exec failed'));
          return;
        }

        // QUOXTRUST v1.8 RB3 (resource bounds): bound command execution TIME and
        // OUTPUT size. readyTimeout only bounds the connect handshake, not the
        // command — an approved-but-runaway command (yes / journalctl -f / cat
        // /dev/zero) would otherwise never return and grow memory without bound.
        const EXEC_TIMEOUT_MS = 120_000;
        let stdout = '';
        let stderr = '';
        let outTrunc = false;
        let errTrunc = false;

        const execTimer = setTimeout(() => {
          try { stream.close(); } catch { /* non-fatal */ }
          try { conn.end(); } catch { /* non-fatal */ }
          finish(reject, new Error(`SSH command timed out after ${EXEC_TIMEOUT_MS}ms`));
        }, EXEC_TIMEOUT_MS);

        stream.on('data', (data) => {
          const r = capStreamOutput(stdout, data, MAX_SSH_OUTPUT_BYTES);
          stdout = r.text; outTrunc = outTrunc || r.truncated;
          if (outTrunc) { try { stream.close(); } catch { /* non-fatal */ } }
        });
        stream.stderr.on('data', (data) => {
          const r = capStreamOutput(stderr, data, MAX_SSH_OUTPUT_BYTES);
          stderr = r.text; errTrunc = errTrunc || r.truncated;
        });
        stream.on('close', (code) => {
          clearTimeout(execTimer);
          try { conn.end(); } catch { /* non-fatal */ }
          finish(resolve, { stdout, stderr, code: typeof code === 'number' ? code : null, truncated: outTrunc || errTrunc });
        });
      });
    });

    conn.on('error', (err) => {
      try { conn.end(); } catch { /* non-fatal — connection may never have opened */ }
      if (driftDetected) {
        const driftErr = new Error('Host key verification failed — possible drift, connection aborted');
        driftErr.code = 'HOST_KEY_DRIFT';
        finish(reject, driftErr);
        return;
      }
      // Never surface privateKey/passphrase in the error — err.message from
      // ssh2 describes connection/auth failures only, never echoes config.
      finish(reject, new Error(err?.message ? String(err.message).slice(0, 300) : 'SSH connection failed'));
    });

    try {
      conn.connect({
        host,
        port: Number(port) || 22,
        username,
        privateKey: key,
        passphrase: pass,
        readyTimeout,
        hostVerifier,
      });
    } catch (err) {
      finish(reject, new Error(err?.message ? String(err.message).slice(0, 300) : 'SSH connect failed'));
    }
  });
}

// QUOXTRUST v1.8 RB3: cap accumulated stream output so a flooding command cannot
// grow memory without bound. Pure + exported for the conformance pin.
const MAX_SSH_OUTPUT_BYTES = 1_000_000;
function capStreamOutput(current, chunk, maxBytes = MAX_SSH_OUTPUT_BYTES) {
  if (current.length >= maxBytes) return { text: current.slice(0, maxBytes), truncated: true };
  const next = current + (typeof chunk === 'string' ? chunk : chunk.toString());
  if (next.length > maxBytes) return { text: next.slice(0, maxBytes), truncated: true };
  return { text: next, truncated: false };
}

module.exports = {
  runSshCommand,
  capStreamOutput, // QUOXTRUST v1.8 RB3 — exported for the output-bound pin
  MAX_SSH_OUTPUT_BYTES,
};

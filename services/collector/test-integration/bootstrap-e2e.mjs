/**
 * BASTION-CRED live end-to-end proof.
 *
 * Drives the REAL grantNopasswdViaBootstrap against a REAL sshd with a REAL
 * sudo boundary. Unlike the vitest unit tests (which stub the SSH layer),
 * this exercises the mechanics the production path depends on and that mocks
 * cannot prove:
 *   - real ssh2 connection as the bootstrap user
 *   - real `visudo -cf` validation + /etc/sudoers.d drop-in write (via the
 *     new sudo-aware grant command)
 *   - the real sudo boundary flipping (day-2 user goes from "password
 *     required" to `sudo -n true` succeeding)
 *   - real day-2 verification path (the /exec double runs a REAL day-2 ssh)
 *   - real, surgical authorized_keys strip of the bootstrap key
 *
 * Only the Bastion/auth HTTP endpoints are local doubles — those exact
 * contracts are separately proven by services/auth/tests/vault-bootstrap-
 * delete.test.js and were verified live in the running containers.
 *
 * Runs a dedicated throwaway sshd on a high port with two throwaway users,
 * and tears everything down in a finally. Needs sudo + sshd on the host.
 *
 * Run: node services/collector/test-integration/bootstrap-e2e.mjs
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
const SUF = String(process.pid).slice(-5);
const DAY2 = `bcrdd${SUF}`;   // operational user, NO sudo
const BOOT = `bcrdb${SUF}`;   // bootstrap user, passwordless sudo (template key)
const SSH_PORT = 2200 + (process.pid % 500);
const DOUBLE_PORT = 3300 + (process.pid % 400);

// bootstrapCredential.js freezes AUTH_BASE_URL from AUTH_HOST/AUTH_PORT at
// import time (correct for the collector, whose env is set at boot), so the
// env MUST be set before the module is imported. BASTION_URL is read per-call
// so it could be set later, but set it here too for clarity.
Object.assign(process.env, {
  AUTH_HOST: '127.0.0.1', AUTH_PORT: String(DOUBLE_PORT),
  BASTION_URL: `http://127.0.0.1:${DOUBLE_PORT}`, BASTION_API_TOKEN: 'e2e-token',
  INTERNAL_SERVICE_KEY: 'e2e-key',
});
const { grantNopasswdViaBootstrap } = await import('../lib/bootstrapCredential.js');
const workdir = mkdtempSync(join(tmpdir(), 'bcred-e2e-'));
let httpServer;

const log = (m) => console.log(`  ${m}`);
const sudo = (cmd) => execSync(`sudo -n bash -c ${JSON.stringify(cmd)}`, { encoding: 'utf8' });
const day2Ssh = (cmd) => execFileSync('ssh', ['-i', `${workdir}/day2`, '-p', String(SSH_PORT),
  '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR',
  `${DAY2}@127.0.0.1`, cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function cleanup() {
  try { httpServer && httpServer.close(); } catch {}
  try { const pid = readFileSync(`${workdir}/sshd.pid`, 'utf8').trim(); sudo(`kill ${pid} || true`); } catch {}
  for (const u of [DAY2, BOOT]) { try { sudo(`pkill -u ${u} || true; userdel -rf ${u} 2>/dev/null || true`); } catch {} }
  try { sudo(`rm -f /etc/sudoers.d/${BOOT} /etc/sudoers.d/quox-${DAY2}`); } catch {}
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
}

async function main() {
  // 1. Keypairs: day-2 (operational) + bootstrap ("template root").
  execSync(`ssh-keygen -t ed25519 -N '' -f ${workdir}/day2 -q`);
  execSync(`ssh-keygen -t ed25519 -N '' -f ${workdir}/boot -q`);
  execSync(`ssh-keygen -t ed25519 -N '' -f ${workdir}/hostkey -q`);
  const day2Pub = readFileSync(`${workdir}/day2.pub`, 'utf8').trim();
  const bootPub = readFileSync(`${workdir}/boot.pub`, 'utf8').trim();
  const bootPriv = readFileSync(`${workdir}/boot`, 'utf8');
  execSync(`chmod 600 ${workdir}/day2 ${workdir}/boot`);

  // 2. Throwaway users with a real sudo boundary.
  sudo(`useradd -m -s /bin/bash ${DAY2}`);
  sudo(`useradd -m -s /bin/bash ${BOOT}`);
  // useradd leaves the password locked ('!'); with UsePAM no, sshd rejects a
  // locked account even for key auth. '*' = no usable password but NOT locked.
  sudo(`usermod -p '*' ${DAY2}`);
  sudo(`usermod -p '*' ${BOOT}`);
  sudo(`echo '${BOOT} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${BOOT} && chmod 440 /etc/sudoers.d/${BOOT}`);
  sudo(`install -d -m700 -o ${DAY2} -g ${DAY2} /home/${DAY2}/.ssh && echo '${day2Pub}' > /home/${DAY2}/.ssh/authorized_keys && chown ${DAY2}:${DAY2} /home/${DAY2}/.ssh/authorized_keys && chmod 600 /home/${DAY2}/.ssh/authorized_keys`);
  // BOOT's authorized_keys holds the bootstrap key AND the day2 key as an
  // innocent bystander, to prove the strip is surgical.
  sudo(`install -d -m700 -o ${BOOT} -g ${BOOT} /home/${BOOT}/.ssh && printf '%s\\n%s\\n' '${bootPub}' '${day2Pub}' > /home/${BOOT}/.ssh/authorized_keys && chown ${BOOT}:${BOOT} /home/${BOOT}/.ssh/authorized_keys && chmod 600 /home/${BOOT}/.ssh/authorized_keys`);

  // 3. Dedicated throwaway sshd (own config/hostkey/port, not the system one).
  execSync(`chmod 600 ${workdir}/hostkey`);
  const sshdCfg = [
    `Port ${SSH_PORT}`, `ListenAddress 127.0.0.1`, `HostKey ${workdir}/hostkey`,
    `PidFile ${workdir}/sshd.pid`, `PubkeyAuthentication yes`, `PasswordAuthentication no`,
    `KbdInteractiveAuthentication no`, `UsePAM no`, `AuthorizedKeysFile .ssh/authorized_keys`,
    `AllowUsers ${DAY2} ${BOOT}`, `LogLevel ERROR`,
  ].join('\n');
  writeFileSync(`${workdir}/sshd_config`, sshdCfg + '\n');
  sudo(`chmod 755 ${workdir}`); // sshd StrictModes: parent dir must be reachable
  sudo(`/usr/sbin/sshd -f ${workdir}/sshd_config`);
  execSync('sleep 1');

  // 4. Precondition: day2 really hits the sudo-password wall.
  let sawWall = false;
  try { day2Ssh('sudo -n true'); } catch (e) {
    sawWall = /a (password|terminal) is required/i.test((e.stderr || '') + (e.stdout || ''));
  }
  assert(sawWall, 'precondition: day2 must hit the sudo-password wall before the grant');
  log('precondition OK: day2 has no passwordless sudo');

  // 5. Local Bastion/auth doubles. /exec runs a REAL day2 ssh (genuine verify).
  const CRED_ID = 'cred-boot-e2e';
  let deletedCredential = false, linkCleared = false;
  const host = { id: 'e2e-host', ip: '127.0.0.1', ssh: { port: SSH_PORT, user: DAY2, key_id: 'day2', bootstrap_credential_id: CRED_ID } };

  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && url === '/api/v1/hosts/e2e-host') return send(200, host);
      if (req.method === 'GET' && url === '/api/v1/hosts') return send(200, { hosts: [host] });
      if (req.method === 'PUT' && url === '/api/v1/hosts/e2e-host') {
        const b = JSON.parse(body || '{}');
        if (b.ssh && b.ssh.bootstrap_credential_id === '') { linkCleared = true; host.ssh.bootstrap_credential_id = ''; }
        return send(200, host);
      }
      if (url.includes('/credential-decrypt/')) return send(200, { credentials: { private_key: bootPriv, username: BOOT, public_key: bootPub }, org_id: 'org_e2e' });
      if (url.endsWith('/ssh-known-host')) return send(200, { status: 'ok' });
      if (req.method === 'POST' && url === '/api/v1/exec') {
        const b = JSON.parse(body || '{}');
        try {
          day2Ssh(b.command);
          return send(200, { results: [{ host_id: 'e2e-host', exit_code: 0 }] });
        } catch (e) {
          return send(200, { results: [{ host_id: 'e2e-host', exit_code: e.status || 1, stderr: e.stderr || '' }] });
        }
      }
      if (req.method === 'DELETE' && url.includes('/internal/integrations/')) { deletedCredential = true; res.writeHead(204); return res.end(); }
      send(404, { error: 'unexpected', url, method: req.method });
    });
  });
  await new Promise((r) => httpServer.listen(DOUBLE_PORT, '127.0.0.1', r));

  // 6. Drive the REAL fallback (ssh2 → the throwaway sshd).
  log('running grantNopasswdViaBootstrap against the real sshd ...');
  const result = await grantNopasswdViaBootstrap({ hostId: 'e2e-host', orgId: 'org_e2e' });

  // 7. Assertions, independently re-checked against the live host.
  assert(result.success === true, `fallback should succeed, got: ${JSON.stringify(result)}`);
  log('grant reported success');

  let day2NowSudo = false;
  try { day2Ssh('sudo -n true'); day2NowSudo = true; } catch {}
  assert(day2NowSudo, 'day2 must have passwordless sudo AFTER the grant (verified over real SSH)');
  log('verified independently: day2 now passes `sudo -n true` over real SSH');

  const dropin = sudo(`cat /etc/sudoers.d/quox-${DAY2} 2>/dev/null || true`).trim();
  assert(new RegExp(`${DAY2} ALL=\\(ALL\\) NOPASSWD:ALL`).test(dropin), 'sudoers.d drop-in must exist');
  sudo(`visudo -cf /etc/sudoers.d/quox-${DAY2}`);
  log('verified: sudoers.d drop-in exists and passes visudo -cf');

  const bootAk = sudo(`cat /home/${BOOT}/.ssh/authorized_keys`).trim();
  assert(!bootAk.includes(bootPub.split(/\s+/)[1]), 'bootstrap key must be stripped from authorized_keys');
  assert(bootAk.includes(day2Pub.split(/\s+/)[1]), 'the unrelated day2 key must NOT be collateral-stripped');
  log('verified: bootstrap key stripped, bystander key preserved');

  assert(linkCleared, 'the registry bootstrap link must be cleared');
  assert(deletedCredential, 'the vault credential must be deleted (unreferenced)');
  log('verified: registry link cleared and vault credential deleted');

  console.log('\n✅ BASTION-CRED live e2e PASSED — real sudo boundary flipped end-to-end.');
}

function assert(cond, msg) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => { console.error(`\n❌ ${err.message}`); cleanup(); process.exit(1); });

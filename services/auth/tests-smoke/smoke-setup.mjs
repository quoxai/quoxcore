// Live-HTTP smoke-test harness.
//
// The tests in this dir exercise the REAL auth server over HTTP (fetch against a
// base URL, with cookies/CSRF) and seed their user directly into the DB, then mint
// a JWT locally. For that to validate, the server must run with the SAME JWT_SECRET
// / MASTER_ENCRYPTION_KEY / AUTH_DB_PATH as the test process. Against the deployed
// container (a different secret) every authed call 401s — which is why these were
// quarantined.
//
// This preload (loaded via `node --test --import ./tests-smoke/smoke-setup.mjs`)
// runs once per test-file process BEFORE the test module loads. It:
//   1. sets shared secrets + an isolated temp AUTH_DB_PATH/UPLOAD_DIR,
//   2. picks a free port and points TEST_BASE_URL at it,
//   3. spawns server.js as an isolated subprocess with those env vars,
//   4. waits for /health, and
//   5. tears the server + temp dir down on exit.
// Each file gets its own server + DB — no shared state, no dependency on any
// externally-running auth service.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import net from 'node:net';

// 1. Shared secrets + isolated data dir (must be set before the test module reads them).
process.env.JWT_SECRET ||= randomBytes(32).toString('hex');
process.env.MASTER_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
process.env.INTERNAL_SERVICE_KEY ||= randomBytes(32).toString('hex');
process.env.NODE_ENV ||= 'test';

const dataDir = mkdtempSync(join(tmpdir(), 'auth-smoke-'));
process.env.AUTH_DB_PATH = join(dataDir, 'auth.db');
process.env.UPLOAD_DIR = join(dataDir, 'uploads');

// 2. Free port → AUTH_PORT + TEST_BASE_URL.
const port = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});
process.env.AUTH_PORT = String(port);
process.env.TEST_BASE_URL = `http://127.0.0.1:${port}`;

// 3. Spawn the auth server with the shared env.
const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const server = spawn(process.execPath, [serverPath], { env: process.env, stdio: 'ignore' });
// Don't let the long-lived server child keep the test process's event loop alive —
// otherwise node --test never exits after the tests finish (the exit handler below
// still kills it).
server.unref();

// 5. Teardown (registered before the wait so a boot failure still cleans up).
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch { /* already gone */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
};
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

// 4. Wait for /health.
const deadline = Date.now() + 25000;
let healthy = false;
while (Date.now() < deadline) {
  if (server.exitCode !== null) break; // server died
  try {
    const res = await fetch(`${process.env.TEST_BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) { healthy = true; break; }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}
if (!healthy) {
  cleanup();
  throw new Error(`[smoke-setup] auth server did not become healthy on ${process.env.TEST_BASE_URL} within 25s (exitCode=${server.exitCode})`);
}

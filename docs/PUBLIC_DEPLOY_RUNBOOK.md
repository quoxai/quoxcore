# q01 Public Deploy Runbook

**Purpose:** step-by-step to stand up the first PUBLIC-IP Quox box (q01, a hosted VM) as a trusted single-instance host running the operator's own companies (dogfood → testimonials). Folds in TRUST-GATE Phase 3c/3d/3e/3f.

**Status:** DRAFT (2026-07-03) — flesh out live during the first deploy. VM not yet provisioned; everything here is VM-independent prep except §5–§9.

**Golden rule (learned this project):** fail loud, restore-tested, one door. A backup never restored is a hope; a service that boots without its key must refuse to boot; nothing listens publicly except 443.

---

## 0. Pre-provision decisions (DONE)
- **DNS:** servers are flat `qNN.cloud.quox.ai` (q01 = this box) → one wildcard `*.cloud.quox.ai` cert covers the fleet. Client CNAMEs (`client-a.cloud.quox.ai`) come later, pointing at whichever qNN. Wildcard needs DNS-01 → DNS provider API token. Deep nesting (`001.client.cloud...`) is REJECTED (breaks single-level wildcard).
- **Profile:** public box runs the trimmed chat-first service set (dashboard, auth, collector, postgres, quoxflow, memory, tasks, orchestrator, files, qdrant). Excludes repobrain, screencap, powers-host, n8n. (See docker-compose profile work, Phase 3c.)
- **Cookie/session:** `COOKIE_SECURE=true` (public = HTTPS only). Session defaults stay enterprise-strict; owner can relax per-instance via the settings toggle (1.14).

## 1. Provision + OS hardening
1. Provision the VM: public IP, Ubuntu LTS. Record IP + assign `q01.cloud.quox.ai` A-record.
2. SSH hardening is **ENFORCED, not just prescribed** (quoxai/quox#411). Run `sudo bash scripts/harden-host.sh` on the box — it installs an sshd drop-in (`/etc/ssh/sshd_config.d/99-quox-hardening.conf`) that sets `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, drops SHA-1 HMACs, and pins modern kex/ciphers, validating with `sshd -t` before reload. `scripts/deploy-instance.sh` runs this automatically as stage 2b (opt out with `--skip-harden`). It refuses to disable password auth if your login user has no `authorized_keys` (lockout guard); set the key up first, or pass `--force`. Verify after: `sudo sshd -T | grep -Ei 'passwordauth|macs '`. Still create a non-root sudo user by hand. Residual (tracked on #411): OpenSSH still advertises its version in the protocol banner; fully hiding it needs a recompile.
3. `ufw default deny incoming` → allow **22** (or moved port) + **443** only. NOT the raw service ports (9848/3101/etc — those stay on the internal Docker network).
4. `fail2ban` on sshd.
5. Optional: join tailnet for a management-plane path (so PBS/monitoring can reach it without exposing more public ports).

## 2. Docker + code
1. Install Docker + compose plugin — **v2.24.0 or later** (required for the `docker-compose.public.yml` override, §3a). Check with `docker compose version`. Add deploy user to docker group (note DOCKER_GID for the dashboard build — dev uses 988).
2. Clone repo at a PINNED release tag (not main): `/opt/quoxcore/quox-dashboard`.
3. **MANDATORY — quoxflow sibling checkout.** The `quoxflow` service builds from `context: ${QUOXFLOW_PATH:-../quoxflow}` — a directory SIBLING to the compose project root, not a subdirectory of it. `docker compose build`/`up` fails on the quoxflow service without it:
   ```
   cd /opt/quoxcore
   git clone https://github.com/quoxai/quoxflow.git
   # Result: /opt/quoxcore/quoxflow  (sibling of /opt/quoxcore/quox-dashboard)
   ```
4. Same sibling-checkout requirement applies to **quoxmcp** when using `docker-compose.public.yml` (§3a) — collector's `QUOXMCP_PATH`/`QUOXMCP_DEPLOY_PATH` mounts default to `../quoxmcp`:
   ```
   cd /opt/quoxcore
   git clone https://github.com/quoxai/quoxmcp.git
   ```
5. `npm ci` in `quox-dashboard/` before building the dashboard (`npm run build`, §5). Use `ci`, not `install` — it installs exactly what `package-lock.json` pins, which `install` does not guarantee on a fresh box.

## 3. Secrets + env (FAIL-LOUD)
1. `scripts/generate-secrets.sh` → generates JWT_SECRET, ENCRYPTION_KEY, MASTER_ENCRYPTION_KEY, INTERNAL_SERVICE_KEY, WEBSITE_SERVICE_KEY, POSTGRES_PASSWORD, QDRANT_API_KEY. NEVER reuse dev secrets.
2. Fill provider keys: ANTHROPIC_API_KEY (required for chat), plus OPENAI/ELEVENLABS as used. (Inbound IMAP is out-of-scope v1.)
   - **Real SMTP is required before opening public signups.** Email verification currently only writes the verification link to console/stdout (no SMTP configured = no email ever reaches the user, signup cannot complete for a real tenant). SMTP is NOT an env var — it's a QuoxVault-backed, per-instance setting: configure it via the Setup Wizard on first run, or later at Settings -> Instance -> Email & SMTP, before inviting anyone outside the owner. (Bare `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` env vars have no effect — removed from docker-compose/.env.example 2026-08-08, they were dead since the EMAIL-UNIFY P2 migration.)
   - **Optional — SOC plugin (quoxagent-side, NOT this compose).** The SOC security plugin lives in the `quoxagent` fleet, not the dashboard stack, so its keys go in the quoxagent host env, not `docker-compose.public.yml`. All are optional and fail *soft* (honest `not_configured`, never fabricated data) — the plugin runs without them: `MAXMIND_DB_PATH` (path to a `GeoLite2-City.mmdb`; enables GeoIP enrichment — the DB *file* is what lookups need, the `MAXMIND_ACCOUNT_ID`/`MAXMIND_LICENSE_KEY` pair is only for `geoipupdate` auto-refresh), `THREATINTEL_FEED_URL` / `ABUSECH_API_KEY` / `OTX_API_KEY` (IOC feeds), `SIEM_ENDPOINT` (+ optional `SIEM_API_KEY`, `SIEM_FORMAT`). Leave unset for launch; drop the MaxMind key in when created.
3. Set: `COOKIE_SECURE=true`, `SSL_MODE=letsencrypt`, `LETSENCRYPT_DOMAIN=q01.cloud.quox.ai` (or wildcard), `LETSENCRYPT_EMAIL=...`, `LETSENCRYPT_STAGING=true` for the FIRST run (avoid rate-limit), then flip to false.
4. **Verify before up:** `scripts/check-secrets.sh` — exits non-zero (CRITICAL) if:
   - `MASTER_ENCRYPTION_KEY`, `JWT_SECRET`, `INTERNAL_SERVICE_KEY`, `POSTGRES_PASSWORD`, or `QDRANT_API_KEY` is empty, missing, or still a `CHANGE_ME*` placeholder.
   - `INTERNAL_SERVICE_KEY` and `WEBSITE_SERVICE_KEY` are the same value, or `JWT_SECRET` and `MASTER_ENCRYPTION_KEY` are the same value.
   - Any of `TEST_LLM_STUB` / `SKIP_AUTH` / `MOCK_LLM` / `BYPASS_RATE_LIMIT` is set to a non-empty value — unless `ALLOW_TEST_FLAGS=true` is explicitly set (don't set this on q01).
   `WEBSITE_SERVICE_KEY` missing/placeholder is a WARNING (ScreenCap isn't in the trimmed public profile), not a failure. The services already fail-loud at boot on a missing INTERNAL_SERVICE_KEY / DATABASE_URL / MASTER_ENCRYPTION_KEY (TRUST-GATE 1.1, 1.12a) — this is belt-and-braces before the first up.
5. Run compose from the project root (or `--env-file` explicit) so `${VAR}` never silently interpolates empty.

## 3a. Public compose override (docker-compose.public.yml)
**Why:** the base `docker-compose.yml` mounts `/var/run/docker.sock` into `auth`, `collector`, and `orchestrator` — docker socket access is root-equivalent host takeover from any RCE in those services (chat tool execution, sandboxed script runs, self-update automation). `auth` also bind-mounts the whole `/opt/quoxcore` tree read-write (backup/restore admin UI), and `collector` bind-mounts it read-only (git-scan endpoint). None of that is acceptable on a public box. `docker-compose.public.yml` re-declares those three services' volume lists (and `collector`'s port binding) to drop the socket and host binds, keeping only the named volumes and repo-relative config mounts each service genuinely needs. See the file's own header comment for full rationale and exactly which dev-only features this disables (they stay disabled until TOOLSMITH-SANDBOX-HARDEN / POWERS-SANDBOX-HARDEN ship a docker-socket-proxy with an operation allowlist).

1. **Version check (required):** `docker compose version` must report **>= 2.24.0**. The override uses the `!override` Compose merge tag to fully replace (not append to) the base volume/port lists — verified against v5.1.3. Note: the similarly-named `!reset` tag does NOT do this (it clears a field to empty instead of substituting a new value) — don't "simplify" this back to `!reset` without re-running the sanity checks below.
2. Always invoke compose with both files together: `docker compose -f docker-compose.yml -f docker-compose.public.yml <command>`.
3. Sanity-check after any edit to either compose file:
   - `docker compose -f docker-compose.yml -f docker-compose.public.yml config --quiet` — must exit 0.
   - `docker compose -f docker-compose.yml -f docker-compose.public.yml config | grep -c docker.sock` — must print `0`.
4. Set `DASHBOARD_PORT=443` in `.env` on public boxes — the override doesn't touch dashboard's ports (nginx terminates TLS on 443 directly inside that container already).
5. Backups on public boxes run via the HOST-level cron job (`scripts/backup-quox.sh`), not the auth container's in-container scheduler (which needs the now-removed docker socket) — see §7 and the `QUOX_COMPOSE_DIR` / `QUOX_REPOS_ROOT` env vars documented there.

## 4. TLS
> #411 finding 3: the enforced default is a self-signed cert (name-mismatched to the host). A trusted cert requires the Let's Encrypt flow below. Automating an internal/wildcard trusted cert (DNS-01 via a provider API token) is an **owner-gated** hardening pass, not done here: it needs a DNS-provider credential and a decision on which provider, so it stays a documented manual step until the owner wires the token.
1. `scripts/generate-certs.sh` (or the Let's Encrypt flow in compose). **`scripts/ssl-manager.sh` only supports HTTP-01** (webroot `.well-known/acme-challenge`, single-domain) — it cannot issue the wildcard. For `*.cloud.quox.ai`, run the DNS-01 flow manually (requires adding the TXT record certbot prints, at the DNS provider, before it can complete):
   ```
   sudo certbot certonly --manual --preferred-challenges dns \
     -d '*.cloud.quox.ai' -d cloud.quox.ai
   ```
   Then place the issued cert/key where nginx.conf expects them: `/etc/letsencrypt/live/cloud.quox.ai/fullchain.pem` → `ssl/quox.crt`, and `.../privkey.pem` → `ssl/quox.key` (nginx.conf reads `/etc/nginx/ssl/quox.crt` / `quox.key`, which is `./ssl/quox.crt` / `quox.key` bind-mounted from the compose project root). DNS-01 automation (provider API token wired into `ssl-manager.sh` or certbot's DNS plugin) is a later hardening pass — manual renewal (~every 60 days) until then.
2. Confirm nginx serves 443 only; all service ports bound to the internal Docker network, nothing else on the public interface (`ss -tlnp` after up: expect 443 + ssh only).

## 5. First boot (VM-dependent)
1. `docker compose -f docker-compose.yml -f docker-compose.public.yml up -d` (§3a — the default profile is already the trimmed chat-first set; no `--profile` flag needed for the public box).
2. **Migrations run clean on the fresh DB.** Phase 3a (versioned migration runners) is DONE for all three SQLite services: auth (71 versioned .sql files, 001-071, run by `runMigrations`/`findMigrationsDir` in `services/auth/db/index.js`), tasks (`services/tasks/db/index.js`), and memory (`services/memory/lib/db.js`) — plus quoxflow (Postgres). A fresh q01 DB must migrate 000→N cleanly without the migration-order crash staging hit on 2026-07-02.
3. **Collector slow boot:** collector takes ~30s (MON-GOV catch-up + schedulers). Dashboard depends on it — the healthcheck `start_period` is tuned so a cold `up` brings the whole stack up without manual intervention. Confirm no service is stuck "unhealthy" after ~90s.
4. **First admin comes from the Setup Wizard, not `seed.js`.** `services/auth/db/seed.js` REFUSES to run when `NODE_ENV=production` (by design — it's test/demo data) and must not be used on q01. Instead, open `https://q01.cloud.quox.ai` and complete the Setup Wizard, which calls `POST /api/setup/admin` (`services/auth/routes/setup.js`) to create the real first superadmin + org. Set instance session policy afterward if desired.

## 6. Smoke test
1. `scripts/evd-smoke-test.sh` (adapt targets to q01).
2. Manual as admin (clarify-mcp or real browser): login → chat round-trip (proves collector+memory+ANTHROPIC key) → Observability Service Health all green (periodic scheduler) → an objective runs end-to-end (proves quoxflow+tasks+reconciler) → `/activity` shows the run as signal.
3. `ss -tlnp` — only 443 + ssh public.

## 7. Backups (OFF-RACK — restore-tested)
1. PBS can't casually reach a public VM → use restic/borg to a storage box, OR PBS over the tailnet management path. Cover ALL named volumes (auth-data, collector-data, memory-data, qdrant-data, postgres-data, quoxflow-data, tasks-data, files-data, orchestrator-data) + any SQLite on volumes.
2. **RESTORE DRILL is the acceptance test** (Phase 3b): restore last night's backup to a scratch location, bring up a throwaway stack against it, confirm data present. Do this BEFORE trusting q01 with a real workload. An untested backup is a hope.
3. Confirm the fixed backup scheduler (TRUST-GATE 1.20) produces exactly ONE archive per schedule, not a burst.
4. **Run `scripts/backup-quox.sh` from the HOST cron on public boxes**, not from inside the auth container (its docker-exec-based capture needs real docker access, which `docker-compose.public.yml` deliberately removes from the container per §3a). The script hardcodes dev-box paths; set these env vars for `/opt/quoxcore` deploys:
   - `QUOX_COMPOSE_DIR` — directory containing `docker-compose.yml` (default `/opt/quoxcore`; set to `/opt/quoxcore/quox-dashboard` on q01). Used to resolve running containers via `docker compose ps`.
   - `QUOX_REPOS_ROOT` — parent directory holding the sibling repo checkouts for git-bundle backup (default `/opt/quoxcore`; set to `/opt/quoxcore` on q01).
   Example crontab line: `0 3 * * * QUOX_COMPOSE_DIR=/opt/quoxcore/quox-dashboard QUOX_REPOS_ROOT=/opt/quoxcore /opt/quoxcore/quox-dashboard/scripts/backup-quox.sh --full`

## 8. Monitoring
1. External uptime monitor (Kuma) → `https://q01.cloud.quox.ai`.
2. The in-app Service Health cards now self-populate (periodic scheduler) — sanity, not the primary alarm.

## 9. Register + finish
1. Add q01 as an env row in the `/deploy` skill map (SSH path, compose invocation) so future updates + `/deploy rollback` work.
2. Rehearse `/deploy rollback q01` once.
3. First tenant workload: the lowest-stakes company chat first, 30-day soak → then each higher-stakes company in turn.

---

## Open prep items (VM-independent — do now)
- [x] Phase 3a: versioned migration runners — quoxflow ✓, auth ✓ (71 versioned .sql files), tasks ✓, memory ✓. All four services migrate via `runMigrations`/`findMigrationsDir` on boot.
- [x] Phase 3b: backup RESTORE drill rehearsed (edge-01 fresh instance, 2026-08-16: tar→extract→sqlite integrity_check on auth/tasks/memory/ward + quoxflow.pgdump pg_restore into scratch postgres, 26 tables. Loop proven; repeat on q01 staging before its go-live).
- [x] Phase 3c: public compose profile (docker-compose.yml default profile trims dev-only services) + `docker-compose.public.yml` override (§3a) + collector-boot dependency fix.
- [ ] Wildcard DNS-01 provider API token acquired + tested against staging cert issuance.
- [ ] Confirm quoxflow build context on a fresh clone (staging pulled it from a sibling checkout).

### Truly fresh host: confirmed walls (first real fresh deploy, edge-01 2026-08-16)
A genuinely fresh box (no Matrix stack, no dev-box leftovers) hits three walls the dev
environment never shows. Until the code-level fixes land, every fresh deploy needs:
1. **`.env.example` must be present** at the repo root (and in quoxflow). `scripts/setup.sh`
   dies with "Neither .env nor .env.example found!" otherwise. If transferring the repo with
   rsync, exclude `.env` and `.env.local` specifically, never a broad `.env*`.
2. **Matrix coupling (tracked for a proper fix, [EXAMPLEVPN-FRICTION] 4894da10/94e28c77):**
   `docker-compose.yml` requires external network `quox-matrix_default`, and the dashboard
   image's nginx hard-references upstream `quox-matrix-synapse` and crash-loops without it.
   Interim workaround: `docker network create quox-matrix_default` and
   `docker run -d --name quox-matrix-synapse --network quox-matrix_default --restart
   unless-stopped alpine sleep infinity`. Remove both once Matrix becomes optional.
3. **Headless wizard:** for self-managed installs, `POST /api/setup/admin`
   `{email,password,name}` completes setup without a browser; the password policy requires a
   special character. Verify `GET /api/setup/status` reports `complete:true,hasAdmin:true`.
   Generate and store the credential on the target box only.
`scripts/post-install-smoke.sh` (may need `chmod +x` after transfer) is the fastest
full-stack verification: 10 checks against the live instance.

### Making a fresh instance SELF-MANAGING (dev suite + QLoop): confirmed walls (edge-01, 2026-08-16/17)
The full sequence, hit in order on the first self-managed standup. quoxpert-qloop carries the
detailed recipes; this is the deploy checklist.
1. **Fleet homing precedes everything.** A loop runs only on a dev-enabled host homed to THIS
   collector. quoxagent's heartbeat collector URL comes ONLY from `/etc/quoxagent/quoxagent.yaml`
   (`heartbeat.collector_url`); the `QUOXAGENT_*` env drop-in overrides the service key and the
   dev plugin, NOT the heartbeat. A healthy heartbeat loop logs nothing, so a mis-homed agent is
   silent. Re-home = sed the yaml URL + key via env drop-in, restart, then confirm the host in
   `quox fleet agents` on the instance itself.
2. **The instance needs its OWN QuoxBastion** (separate Go binary, not in core compose). Wire
   collector `.env` `BASTION_URL`/`BASTION_API_TOKEN`/`BASTION_HOST` (shipped commented out).
3. **Bastion needs a default SSH key**: `bastion.yaml` `key_dir` plus a key FILE named `default`,
   or every exec fails "key not found: default".
4. **`quox dev enable` after agent start needs a quoxagent restart**: the agent verifies and
   reports capabilities only at startup, so profile_verified stays false until restarted.
5. **`--max-concurrent-sessions` at enable time**: it is baked into the signed profile and
   defaults to 0, which spawns nothing.
6. **The agent must run as the login user, not root** (`User=control` drop-in + chown of
   /etc/quoxagent and /var/lib/quoxagent): loop backends read OAuth from the run-user's home.
7. **Set `COLLECTOR_LAN_URL` in the collector .env AND confirm the compose passthrough line**
   (`- COLLECTOR_LAN_URL=${COLLECTOR_LAN_URL:-}` in the collector env block; older compose
   copies lack it). Without it the collector stamps a hardcoded dev-box address into loop spawn
   envelopes and every turn batch 404s on delivery: both backends fail "ended without a result
   event", 0 tokens.
8. **A loop killed by its own budget can look identical to wall 7** on older agent binaries
   (no kill event emitted). If the agent journal shows a clean stream end at almost exactly
   `max_duration_ms` after spawn, raise the budget; a real proof-of-life needs well over 10
   minutes.

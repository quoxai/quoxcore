#!/usr/bin/env bash
# deploy-instance.sh — codified single-instance QuoxCORE deploy path.
#
# This script is the CODIFIED VERSION of docs/PUBLIC_DEPLOY_RUNBOOK.md,
# folding in every gotcha hit during the first manual production deploy
# (q01, Arun's VM, Ubuntu 24.04, /opt/quoxcore, IP-only). It automates:
#   Docker/compose/git/rsync preflight -> sibling-repo rsync -> secrets ->
#   public-profile prod overrides -> config sanity -> TLS -> build -> up ->
#   health-wait -> register quox CLI on PATH -> admin bootstrap -> summary.
#
# IMPORTANT: this has NOT been run end-to-end against a live target. Test
# against a scratch VM before trusting it on anything real. Read the runbook
# (docs/PUBLIC_DEPLOY_RUNBOOK.md) first — this script assumes its context
# (DNS + firewall from runbook §0-1 are still OUT OF SCOPE here; this script
# starts at runbook §2 "Docker + code"). The ONE §1 item it now ENFORCES is
# SSH hardening: after the repos are synced it runs scripts/harden-host.sh on
# the target (quoxai/quox#411 — the golden image shipped PasswordAuthentication
# yes + SHA-1 HMACs because nothing enforced the runbook prose). Opt out with
# --skip-harden.
#
# Usage:
#   scripts/deploy-instance.sh --host deploy@q02.cloud.quox.ai \
#     --admin-email admin@example.com --admin-password '...'
#
# Flags:
#   --host <ssh-alias-or-user@ip>   REQUIRED. Target box, reachable via ssh.
#   --dir <path>                    Remote deploy dir. Default: /opt/quoxcore
#   --source <path>                 LOCAL repo root holding the three sibling
#                                    repos (quox-dashboard, quoxflow,
#                                    quoxmcp). Default: /opt/quoxcore
#   --profile <public|full>         Compose profile. Default: public
#   --admin-email <email>           First admin's email (or ADMIN_EMAIL env)
#   --admin-password <password>     First admin's password (or ADMIN_PASSWORD
#                                    env). If neither is set, the admin
#                                    bootstrap stage is SKIPPED with a note —
#                                    complete it later via the Setup Wizard
#                                    or `quox setup admin`.
#   --admin-name <name>              First admin's display name. Default: Admin
#   --skip-build                    Skip `docker compose build` (use existing
#                                    images — e.g. re-running `up` after a
#                                    config-only change).
#   --skip-harden                   Skip the SSH-hardening stage
#                                    (scripts/harden-host.sh). Hardening is ON
#                                    by default; only skip it if a site policy
#                                    manages sshd another way.
#
# Secret values are NEVER echoed by this script — only stage progress and
# non-secret status (key names, exit codes, health states).

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults / flag parsing
# ---------------------------------------------------------------------------
HOST=""
DEPLOY_DIR="/opt/quoxcore"
SOURCE_ROOT="/opt/quoxcore"
PROFILE="public"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_NAME="${ADMIN_NAME:-Admin}"
SKIP_BUILD=false
SKIP_HARDEN=false

# rsync excludes proven on the q01 deploy — never ship dev cruft, secrets,
# or local data volumes into the deploy target.
RSYNC_EXCLUDES=(
  --exclude='.git'
  --exclude='node_modules'
  --exclude='dist'
  --exclude='*.db'
  --exclude='services/*/data'
  --exclude='/data'
  --exclude='.env'
  --exclude='.env.bak*'
  --exclude='.env.*.local'
  --exclude='.env.local'
  --exclude='.env.docker*'
  --exclude='*.env.bak*'
  --exclude='ssl'
  --exclude='certs'
  --exclude='ssh-keys'
  --exclude='.claude'
  --exclude='test-results'
  --exclude='coverage'
  --exclude='playwright-report'
  --exclude='*.log'
)

usage() {
  sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --dir) DEPLOY_DIR="$2"; shift 2 ;;
    --source) SOURCE_ROOT="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --admin-name) ADMIN_NAME="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-harden) SKIP_HARDEN=true; shift ;;
    -h|--help) usage 0 ;;
    *) echo "[deploy] ERROR: unknown flag: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "$HOST" ]]; then
  echo "[deploy] ERROR: --host is required" >&2
  usage 1
fi

if [[ "$PROFILE" != "public" && "$PROFILE" != "full" ]]; then
  echo "[deploy] ERROR: --profile must be 'public' or 'full' (got: $PROFILE)" >&2
  exit 1
fi

REMOTE_DASH="$DEPLOY_DIR/quox-dashboard"
# quoxflow/quoxmcp are resolved by docker-compose.yml as SIBLING directories
# (../quoxflow, ../quoxmcp) relative to REMOTE_DASH — no separate var needed,
# just confirm they land at $DEPLOY_DIR/quoxflow and $DEPLOY_DIR/quoxmcp.

if [[ "$PROFILE" == "public" ]]; then
  COMPOSE_ARGS="-f docker-compose.yml -f docker-compose.public.yml"
  COMPOSE_PROFILE_FLAG=""
else
  COMPOSE_ARGS="-f docker-compose.yml"
  COMPOSE_PROFILE_FLAG="--profile full"
fi

log() { echo "[deploy] $*"; }
stage() { echo ""; echo "[deploy] STAGE: $*"; echo "[deploy] ----------------------------------------"; }
die() { echo "[deploy] FATAL: $*" >&2; exit 1; }

# Run a command on the remote host. Never echo the command itself if it may
# contain a secret — callers pass secrets via remote env vars, not inline.
remote() {
  ssh "$HOST" "$@"
}

remote_compose() {
  # shellcheck disable=SC2029
  ssh "$HOST" "cd '$REMOTE_DASH' && docker compose $COMPOSE_ARGS $*"
}

log "Target host:    $HOST"
log "Deploy dir:     $DEPLOY_DIR"
log "Source root:    $SOURCE_ROOT"
log "Profile:        $PROFILE"
log "Skip build:     $SKIP_BUILD"

# ---------------------------------------------------------------------------
# STAGE 1: Preflight — ssh reachable, docker/compose/git/rsync on target
# ---------------------------------------------------------------------------
stage "1/12 Preflight"

log "Checking ssh reachability to $HOST..."
remote "true" || die "cannot ssh to $HOST"
log "ssh OK"

log "Checking remote git + rsync..."
remote "command -v git >/dev/null && command -v rsync >/dev/null" \
  || remote "sudo apt-get update -y && sudo apt-get install -y git rsync" \
  || die "failed to install git/rsync on remote"
log "git + rsync present"

log "Checking remote Docker + compose version (need >= 2.24.0)..."
if remote "command -v docker >/dev/null" 2>/dev/null; then
  COMPOSE_VERSION="$(remote "docker compose version --short" 2>/dev/null || echo "0.0.0")"
else
  COMPOSE_VERSION="0.0.0"
fi

version_ge() {
  # $1 >= $2 ?
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

if ! version_ge "$COMPOSE_VERSION" "2.24.0"; then
  log "Docker compose $COMPOSE_VERSION < 2.24.0 (or docker missing) — installing via get.docker.com..."
  remote "curl -fsSL https://get.docker.com | sudo sh" || die "docker install failed"
  COMPOSE_VERSION="$(remote "docker compose version --short")"
  version_ge "$COMPOSE_VERSION" "2.24.0" || die "docker compose still < 2.24.0 after install ($COMPOSE_VERSION) — docker-compose.public.yml's !override merge tag requires 2.24+"
fi
log "docker compose $COMPOSE_VERSION OK"

log "Checking deploy user is in the docker group..."
if ! remote "id -nG \"\$USER\" | grep -qw docker"; then
  log "adding remote user to docker group (note: requires new ssh session to take effect)"
  remote "sudo usermod -aG docker \"\$USER\"" || die "failed to add user to docker group"
  log "WARNING: docker group membership added — if subsequent stages fail with permission denied on docker.sock, re-run this script after the user's next login."
else
  log "deploy user already in docker group"
fi

remote "sudo mkdir -p '$DEPLOY_DIR' && sudo chown \"\$USER\":\"\$USER\" '$DEPLOY_DIR'" \
  || die "failed to create/chown $DEPLOY_DIR"

# ---------------------------------------------------------------------------
# STAGE 2: rsync the three sibling repos
# ---------------------------------------------------------------------------
stage "2/12 Sync repos (quox-dashboard, quoxflow, quoxmcp as SIBLINGS under $DEPLOY_DIR)"

for repo in quox-dashboard quoxflow quoxmcp; do
  SRC="$SOURCE_ROOT/$repo"
  [[ -d "$SRC" ]] || die "source repo not found: $SRC"
  log "rsync $repo -> $HOST:$DEPLOY_DIR/$repo/"
  rsync -az --delete "${RSYNC_EXCLUDES[@]}" "$SRC"/ "$HOST:$DEPLOY_DIR/$repo/" \
    || die "rsync failed for $repo"
done
log "All three sibling repos synced"

# ---------------------------------------------------------------------------
# STAGE 2b: OS hardening (SSH) — quoxai/quox#411
# ---------------------------------------------------------------------------
# Enforce runbook §1's SSH hardening instead of leaving it to the operator:
# scripts/harden-host.sh (just synced with the repo) disables password auth,
# drops SHA-1 HMACs, and locks down kex/ciphers, validating with `sshd -t`
# before it reloads. We reach the target over key-based ssh, so the deploy
# user always has an authorized_key here and the script's lockout guard passes.
if [[ "$SKIP_HARDEN" == "true" ]]; then
  stage "2b/12 OS hardening (SKIPPED via --skip-harden)"
else
  stage "2b/12 OS hardening (SSH — harden-host.sh: no password auth, no SHA-1 HMACs)"
  remote "cd '$REMOTE_DASH' && sudo bash scripts/harden-host.sh" \
    || die "harden-host.sh failed on remote — SSH hardening not applied. Fix, or re-run with --skip-harden if a site policy manages sshd another way."
  log "SSH hardening enforced. Verify: ssh $HOST 'sudo sshd -T | grep -Ei \"passwordauth|macs \"'"
fi

# ---------------------------------------------------------------------------
# STAGE 3: Secrets + prod overrides
# ---------------------------------------------------------------------------
stage "3/12 Secrets (generate-secrets.sh + IP-only/prod overrides)"

log "Running scripts/generate-secrets.sh on remote (never reuse dev secrets)..."
remote "cd '$REMOTE_DASH' && bash scripts/generate-secrets.sh" \
  || die "generate-secrets.sh failed"

log "Applying IP-only/prod .env overrides (NODE_ENV, SSL_MODE, DASHBOARD_PORT, COOKIE_SECURE, VITE_DEMO_MODE, LETSENCRYPT_STAGING)..."
# shellcheck disable=SC2016
remote "cd '$REMOTE_DASH' && bash -c '
set -euo pipefail
set_env() {
  key=\"\$1\"; value=\"\$2\"
  if grep -q \"^\${key}=\" .env; then
    sed -i \"s|^\${key}=.*|\${key}=\${value}|\" .env
  else
    echo \"\${key}=\${value}\" >> .env
  fi
}
set_env NODE_ENV production
set_env SSL_MODE selfsigned
set_env DASHBOARD_PORT 443
set_env COOKIE_SECURE true
set_env VITE_DEMO_MODE false
set_env LETSENCRYPT_STAGING false
'" || die "failed to apply .env overrides"
log "Overrides applied (values not echoed)"

# ---------------------------------------------------------------------------
# STAGE 4: DOCKER_GID
# ---------------------------------------------------------------------------
stage "4/12 DOCKER_GID"

log "Setting DOCKER_GID from remote docker group..."
# shellcheck disable=SC2016
remote "cd '$REMOTE_DASH' && bash -c '
set -euo pipefail
gid=\$(getent group docker | cut -d: -f3)
if [ -z \"\$gid\" ]; then echo \"[deploy] ERROR: docker group not found on remote\" >&2; exit 1; fi
if grep -q \"^DOCKER_GID=\" .env; then
  sed -i \"s|^DOCKER_GID=.*|DOCKER_GID=\${gid}|\" .env
else
  echo \"DOCKER_GID=\${gid}\" >> .env
fi
echo \"[deploy]   DOCKER_GID=\${gid}\"
'" || die "failed to set DOCKER_GID"

# ---------------------------------------------------------------------------
# STAGE 5: check-secrets.sh
# ---------------------------------------------------------------------------
stage "5/12 Verify secrets (check-secrets.sh must exit 0)"

remote "cd '$REMOTE_DASH' && bash scripts/check-secrets.sh" \
  || die "check-secrets.sh reported CRITICAL issues — fix .env before continuing"
log "check-secrets.sh passed"

# ---------------------------------------------------------------------------
# STAGE 6: Config sanity
# ---------------------------------------------------------------------------
stage "6/12 Compose config sanity"

log "Validating merged compose config (--quiet, exit 0 expected)..."
remote_compose "config --quiet" || die "docker compose config failed for profile=$PROFILE"
log "compose config OK"

if [[ "$PROFILE" == "public" ]]; then
  log "Verifying docker.sock is NOT present in the merged config (security-critical)..."
  SOCK_COUNT="$(remote_compose "config" | grep -c docker.sock || true)"
  if [[ "$SOCK_COUNT" != "0" ]]; then
    die "docker-compose.public.yml did not strip docker.sock (found $SOCK_COUNT reference(s)) — refusing to deploy a public box with docker socket access"
  fi
  log "docker.sock count = 0, confirmed"
else
  log "profile=full — docker.sock check skipped (dev/full profile is expected to retain it)"
fi

# ---------------------------------------------------------------------------
# STAGE 7: TLS
# ---------------------------------------------------------------------------
stage "7/12 TLS (self-signed, IP-only 443)"

# NOTE: generate-secrets.sh (stage 3) already generates ssl/quox.crt +
# ssl/quox.key itself when they don't yet exist (self-signed, SAN = detected
# local IP) — that's the file nginx.conf actually reads
# (/etc/nginx/ssl/quox.crt via the ./ssl bind mount). scripts/generate-certs.sh
# writes to a DIFFERENT location (certs/cert.pem, certs/key.pem) and is
# interactive if certs already exist. We call it here only as a fallback (if
# stage 3 somehow didn't produce ssl/quox.crt) and copy its output into the
# path nginx expects, so the documented "run generate-certs.sh" step is
# honoured without breaking non-interactive automation or nginx's expected
# cert path.
# shellcheck disable=SC2016
remote "cd '$REMOTE_DASH' && bash -c '
set -euo pipefail
if [ -f ssl/quox.crt ] && [ -f ssl/quox.key ]; then
  echo \"[deploy]   ssl/quox.crt already present (generated by generate-secrets.sh) — skipping generate-certs.sh\"
else
  yes | bash scripts/generate-certs.sh || true
  mkdir -p ssl
  cp certs/cert.pem ssl/quox.crt
  cp certs/key.pem ssl/quox.key
  echo \"[deploy]   generated ssl/quox.crt + ssl/quox.key via generate-certs.sh fallback\"
fi
'" || die "TLS cert generation failed"

# ---------------------------------------------------------------------------
# STAGE 8: Build
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == "true" ]]; then
  stage "8/12 Build (SKIPPED via --skip-build)"
else
  stage "8/12 Build ($COMPOSE_ARGS $COMPOSE_PROFILE_FLAG build)"
  remote_compose "$COMPOSE_PROFILE_FLAG build" || die "docker compose build failed"
  log "Build complete"
fi

# ---------------------------------------------------------------------------
# STAGE 9: Up
# ---------------------------------------------------------------------------
stage "9/12 Up"

remote_compose "$COMPOSE_PROFILE_FLAG up -d" || die "docker compose up failed"
log "Stack started"

# ---------------------------------------------------------------------------
# STAGE 10: Health-wait
# ---------------------------------------------------------------------------
stage "10/12 Health-wait (timeout ~180s; collector cold boot ~30s)"

# On the public profile, orchestrator is EXPECTED to stay "unhealthy" — its
# docker socket is deliberately removed by docker-compose.public.yml (see
# that file's header comment). Treat orchestrator-unhealthy as OK/warn, not
# a failure, on profile=public.
TIMEOUT=180
ELAPSED=0
INTERVAL=5
while true; do
  PS_OUT="$(remote_compose "ps --format json" 2>/dev/null || echo "")"
  if [[ -z "$PS_OUT" ]]; then
    log "waiting for containers to report status... (${ELAPSED}s/${TIMEOUT}s)"
  else
    # Count services whose Health is not "healthy" and not "" (services
    # without a healthcheck report empty Health — that's fine).
    UNHEALTHY="$(echo "$PS_OUT" | node -e '
      let raw = "";
      process.stdin.on("data", d => raw += d);
      process.stdin.on("end", () => {
        const lines = raw.trim().split("\n").filter(Boolean);
        const bad = [];
        for (const line of lines) {
          try {
            const svc = JSON.parse(line);
            const health = (svc.Health || "").toLowerCase();
            if (health && health !== "healthy") bad.push(`${svc.Service}:${health}`);
          } catch {}
        }
        console.log(bad.join(","));
      });
    ' 2>/dev/null || echo "")"

    if [[ "$PROFILE" == "public" ]]; then
      # Strip orchestrator entries — tolerated on public profile.
      UNHEALTHY="$(echo "$UNHEALTHY" | tr ',' '\n' | grep -v '^orchestrator:' | paste -sd',' - 2>/dev/null || true)"
    fi

    if [[ -z "$UNHEALTHY" ]]; then
      log "All services healthy (orchestrator-unhealthy tolerated on public profile)"
      break
    fi
    log "waiting on: $UNHEALTHY (${ELAPSED}s/${TIMEOUT}s)"
  fi

  if [[ "$ELAPSED" -ge "$TIMEOUT" ]]; then
    log "WARNING: health-wait timed out after ${TIMEOUT}s — continuing anyway. Check manually:"
    log "  ssh $HOST 'cd $REMOTE_DASH && docker compose $COMPOSE_ARGS ps'"
    break
  fi
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
done

# ---------------------------------------------------------------------------
# STAGE 11: Register quox CLI on PATH
# ---------------------------------------------------------------------------
stage "11/12 registering quox CLI on PATH"

# Papercut hit on q01: a fresh deploy left `quox` unavailable on PATH, so the
# first admin bootstrap (and every operator command after it) had to be
# spelled out as `node cli/bin/quox.js ...`. Install cli/'s own
# node_modules (deliberately excluded from the rsync — dev-machine
# node_modules isn't portable), then `npm link` so `quox`/`quoxcli` resolve
# globally. Falls back to a direct symlink if `npm link` fails for any
# reason (e.g. no global npm prefix write access).
# shellcheck disable=SC2016
remote "cd '$REMOTE_DASH/cli' && bash -c '
set -euo pipefail
npm install --omit=dev
if sudo npm link; then
  echo \"[deploy]   npm link OK\"
else
  echo \"[deploy]   npm link failed — falling back to direct symlink\"
  sudo ln -sf \"\$(pwd)/bin/quox.js\" /usr/local/bin/quox
  sudo chmod +x \"\$(pwd)/bin/quox.js\"
fi
'" || die "quox CLI registration failed"

log "Verifying quox resolves on PATH (quox --version)..."
remote "quox --version" || die "quox --version failed after registration — PATH/link issue on remote"
log "quox CLI registered"

# ---------------------------------------------------------------------------
# STAGE 12: Admin bootstrap
# ---------------------------------------------------------------------------
if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
  stage "12/12 Admin bootstrap (SKIPPED — no --admin-email/--admin-password or ADMIN_EMAIL/ADMIN_PASSWORD set)"
  log "NOTE: complete first-admin setup manually via the Setup Wizard at https://$HOST/ or:"
  log "  ssh $HOST 'cd $REMOTE_DASH && quox setup admin --email <email> --password <password> --name <name>'"
else
  stage "12/12 Admin bootstrap"
  log "Creating first admin (email/password not echoed)..."
  # base64-encode before shipping over the ssh command line — email/password/
  # name may contain single quotes or other shell metacharacters that would
  # otherwise break out of the quoting below (and a broken quote is exactly
  # the kind of failure that silently mangles a password). base64's alphabet
  # ([A-Za-z0-9+/=]) is always safe inside single quotes.
  ADMIN_EMAIL_B64="$(printf '%s' "$ADMIN_EMAIL" | base64 -w0)"
  ADMIN_PASSWORD_B64="$(printf '%s' "$ADMIN_PASSWORD" | base64 -w0)"
  ADMIN_NAME_B64="$(printf '%s' "$ADMIN_NAME" | base64 -w0)"
  # shellcheck disable=SC2016
  remote "cd '$REMOTE_DASH' && ADMIN_EMAIL_B64='$ADMIN_EMAIL_B64' ADMIN_PASSWORD_B64='$ADMIN_PASSWORD_B64' ADMIN_NAME_B64='$ADMIN_NAME_B64' bash -c '
    set -euo pipefail
    ADMIN_EMAIL=\$(echo \"\$ADMIN_EMAIL_B64\" | base64 -d)
    ADMIN_PASSWORD=\$(echo \"\$ADMIN_PASSWORD_B64\" | base64 -d)
    ADMIN_NAME=\$(echo \"\$ADMIN_NAME_B64\" | base64 -d)
    quox setup admin --email \"\$ADMIN_EMAIL\" --password \"\$ADMIN_PASSWORD\" --name \"\$ADMIN_NAME\"
  '" || die "admin bootstrap failed"

  log "Verifying admin was created (setup status -> hasAdmin: true)..."
  remote "cd '$REMOTE_DASH' && quox setup status --json" > /tmp/quox-deploy-setup-status.$$.json 2>/dev/null || true
  if grep -q '"hasAdmin":true' /tmp/quox-deploy-setup-status.$$.json 2>/dev/null; then
    log "Admin confirmed (hasAdmin: true)"
  else
    log "WARNING: could not confirm hasAdmin:true via setup status — verify manually"
  fi
  rm -f /tmp/quox-deploy-setup-status.$$.json
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
stage "Summary"

log "Deploy target:   $HOST"
log "Deploy dir:      $DEPLOY_DIR"
log "Profile:         $PROFILE"
echo ""
log "Service statuses:"
remote_compose "ps" || log "  (could not fetch final ps output)"
echo ""
log "Open https://$HOST (self-signed cert — browser will warn, accept to continue)"
log "quox CLI is registered on the box's PATH — from an ssh session on $HOST you can now run:"
log "  quox service health"
log "  quox whoami"
log "  quox tui                 (interactive terminal dashboard)"
log "Or use quoxcli locally against it: QUOX_URL=https://$HOST quox service health"
echo ""
log "Deploy complete."

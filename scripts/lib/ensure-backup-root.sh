# shellcheck shell=bash
# quox#1017: the auth container writes per-org backups (lock, status, archives) under BACKUP_ROOT,
# bind-mounted at the same path. docker compose auto-creates a missing bind source as root:root 0755,
# and the auth image runs as uid AUTH_UID (services/auth/Dockerfile: useradd -u 1001), so on a clean
# install every `quox backup create` failed "Permission denied". Create it, owned by that uid, before
# `docker compose up`. Also repairs a dir an earlier install left root-owned.
#
# setup.sh usually runs as a docker-group user, not root (quox-proving-install: sg docker), so a plain
# mkdir/chown under a root-owned parent is refused. Docker access already implies root on the host, so
# the fallback does it in a one-shot container (which also creates a missing dir via the bind mount).
#
# Usage: BACKUP_ROOT=<path> ensure_backup_root   (setup.sh resolves BACKUP_ROOT from .env first)
ensure_backup_root() {
    local root="${BACKUP_ROOT:-/opt/quoxcore/backups}"
    local uid="${AUTH_UID:-1001}"
    mkdir -p "$root" 2>/dev/null || true   # setup.sh runs under set -e: a refused mkdir must not end setup before the fallback
    chown "$uid:$uid" "$root" 2>/dev/null && return 0
    docker run --rm -v "$root:$root" alpine:3 chown "$uid:$uid" "$root" >/dev/null 2>&1 && return 0
    echo "  WARN: could not give $root to uid $uid (run: sudo mkdir -p $root && sudo chown $uid:$uid $root), or backups fail with Permission denied" >&2
    return 0
}

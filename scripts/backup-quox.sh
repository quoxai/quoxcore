#!/bin/bash
#
# Quox System Backup Script — Phase D.1b
# Backs up all 22 critical components for zero-data-loss disaster recovery
#
# Usage: backup-quox.sh [--full|--quick|--list]
#   --full   Full backup including git repos (default)
#   --quick  Quick backup - data only, no git repos
#   --list   List existing backups
#

set -euo pipefail

# Configuration
# BACKUP_ROOT is env-overridable for deploys that don't live under /opt/quoxcore
# (e.g. /opt/quoxcore on prod boxes). runBackupProcess (backups.js) sets it and
# passes it through; a bare /opt/quoxcore box without the /opt/quoxcore bind
# mount MUST override this or the backup archive has nowhere valid to land.
BACKUP_ROOT="${BACKUP_ROOT:-/opt/quoxcore/backups}"
# CONTAINER_PREFIX names the stack this run targets. The default install's
# containers are quox-auth / quox-collector / ... and its qdrant volume is
# quox-qdrant-data; a rehearsal or second stack on the same box uses another
# prefix (the G2d restore drill uses "gtm"). Host paths are NOT prefixed — only
# docker container names and docker volume names are.
CONTAINER_PREFIX="${CONTAINER_PREFIX:-quox}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
LOG_FILE="${BACKUP_ROOT}/backup.log"
RETENTION_DAYS=30

# SINGLE-RUN LOCK (2026-08-19).
#
# There was none, and nothing else prevented overlap. The stale marker in
# services/auth/routes/backups.js only updates a DB ROW after 30 minutes; it
# never kills the process. So the 02:00 run on 2026-08-19 was still writing its
# tarball at 14:09 while its row said "failed", and the next scheduled run was
# free to start on top of it. Two concurrent backups double the IO and the disk
# for no benefit, on a box whose builds were already degrading under disk
# pressure.
#
# Non-blocking on purpose: a second run should EXIT saying why, not queue up
# behind a job that may have hours left.
LOCK_FILE="${BACKUP_ROOT}/.backup-quox.lock"
mkdir -p "$BACKUP_ROOT"
# 9<> not 9>: `>` TRUNCATES on open, so a second run wiped the holder pid
# before it could read it and the refusal message said "held by pid " with
# nothing after it. The pid IS the diagnostic here.
exec 9<>"$LOCK_FILE"
if ! flock -n 9; then
    holder=$(head -n1 "$LOCK_FILE" 2>/dev/null || true)
    holder=${holder:-unknown}
    echo "backup-quox: another backup is already running (pid ${holder}); refusing to start a second." >&2
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) SKIPPED - lock held by pid ${holder}" >> "$LOG_FILE" 2>/dev/null || true
    exit 0
fi
: >"$LOCK_FILE"
echo $$ >&9

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    local level=$1
    shift
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
    echo -e "$msg" | tee -a "$LOG_FILE"
}

info() { log "INFO" "$*"; }
warn() { log "WARN" "${YELLOW}$*${NC}"; }
error() { log "ERROR" "${RED}$*${NC}"; }
success() { log "OK" "${GREEN}$*${NC}"; }

# ----------------------------------------------------------------------------
# STORE LEDGER (2026-09-17, G2d)
#
# restore-quox.sh cannot rebuild an instance from a static list of what a backup
# is SUPPOSED to contain — it needs what this run actually did. Every capture
# path records itself here, including the ones that skipped or failed, because a
# store that is silently absent from the manifest is indistinguishable from a
# store that was never meant to be there. Emitted as manifest.json .stores[].
#
# Fields: name|kind(sqlite|postgres|volume|dir)|file(relative to run dir)|
#         status(ok|skipped|failed)|extra(raw JSON k/v fragment, no leading comma)
# ----------------------------------------------------------------------------
STORE_RECORDS=()
record_store() {
    local name=$1 kind=$2 file=$3 status=$4 extra=${5:-}
    # First write wins. The call sites guard themselves with `|| { record ... }`
    # fallbacks, so a capture function that recorded its own outcome and THEN
    # returned non-zero would otherwise emit the same store twice and leave the
    # restore engine to guess which entry is true.
    local existing
    for existing in ${STORE_RECORDS[@]+"${STORE_RECORDS[@]}"}; do
        [ "${existing%%|*}" = "$name" ] && return 0
    done
    STORE_RECORDS+=("${name}|${kind}|${file}|${status}|${extra}")
    return 0
}

# ----------------------------------------------------------------------------
# REQUIRED vs OPTIONAL components (GRIPE-710)
#
# A backup that skips a REQUIRED component must not report plain success: the
# nightly run used to say "completed" + "verify valid" while the evidence chain
# (volt_db), the memory store and quoxflow evidence were not in the archive.
# If any REQUIRED component is not "ok" the manifest gets "degraded": true plus
# "skipped_required", and the script exits 2 (EXIT_DEGRADED) AFTER the archive
# is built, so the archive is kept and marked rather than discarded.
#
# REQUIRED: auth db, collector aee/volt/ward dbs, quoxbrain db, memory store
#           (memory_db + quox-memory), quoxflow evidence.
# OPTIONAL: ssh keys, claude config, bastion audit logs, dashboard-data, and
#           everything else (skip is recorded, never degrades the run).
# ----------------------------------------------------------------------------
EXIT_DEGRADED=2
REQUIRED_COMPONENTS=(auth_db collector_aee_db volt_db ward_db quoxbrain_db memory_db quox-memory quoxflow-evidence)
COMPONENT_RECORDS=()   # name|status(ok|skipped|failed)|reason  (non-store components)
record_component() {
    COMPONENT_RECORDS+=("${1}|${2}|${3:-}")
    return 0
}

# >>> degraded-classifier (extracted verbatim by the bash unit test)
DEGRADED=false
SKIPPED_REQUIRED=()
DEGRADED_REASONS=()
VOLT_SKIP_MSG=""
# classify_degraded — scan STORE_RECORDS (name|kind|file|status|extra) and
# COMPONENT_RECORDS (name|status|reason). Any REQUIRED name that is not "ok",
# or never recorded at all, is skipped-required. Sets DEGRADED,
# SKIPPED_REQUIRED, DEGRADED_REASONS. Pure: no I/O.
classify_degraded() {
    DEGRADED=false
    SKIPPED_REQUIRED=()
    DEGRADED_REASONS=()
    local req rec name status reason found
    for req in "${REQUIRED_COMPONENTS[@]}"; do
        found=""
        for rec in ${STORE_RECORDS[@]+"${STORE_RECORDS[@]}"}; do
            IFS='|' read -r name _ _ status _ <<< "$rec"
            if [ "$name" = "$req" ]; then found="$status"; reason="store $status"; break; fi
        done
        if [ -z "$found" ]; then
            for rec in ${COMPONENT_RECORDS[@]+"${COMPONENT_RECORDS[@]}"}; do
                IFS='|' read -r name status reason <<< "$rec"
                if [ "$name" = "$req" ]; then found="$status"; break; fi
            done
        fi
        if [ -z "$found" ]; then found="missing"; reason="never attempted"; fi
        if [ "$found" != "ok" ]; then
            DEGRADED=true
            SKIPPED_REQUIRED+=("$req")
            if [ "$req" = "volt_db" ] && [ -n "$VOLT_SKIP_MSG" ]; then
                DEGRADED_REASONS+=("$VOLT_SKIP_MSG")
            else
                DEGRADED_REASONS+=("${req}: ${found} (${reason:-no reason recorded})")
            fi
        fi
    done
    return 0
}
# <<< degraded-classifier

# json_str_array — print args as a JSON array of strings (no escaping beyond
# backslash and double quote, which is all our reason strings can contain).
json_str_array() {
    local out="" a
    for a in "$@"; do
        a=${a//\\/\\\\}; a=${a//\"/\\\"}
        out="${out:+${out}, }\"${a}\""
    done
    echo "[${out}]"
}

# Ensure backup directory exists, restrictively — archives contain auth.db
# and .env (master encryption key). New files default to owner-only and the
# root dir is not group/world traversable. (restoreValidation.test.js asserts
# both lines; the assertions predated the implementation — DASH-TES 2026-07-04.)
umask 077
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

# List backups
list_backups() {
    echo "Available backups in $BACKUP_ROOT:"
    echo "========================================"
    if [ -d "$BACKUP_ROOT" ]; then
        for dir in "$BACKUP_ROOT"/*/; do
            if [ -d "$dir" ]; then
                name=$(basename "$dir")
                size=$(du -sh "$dir" 2>/dev/null | cut -f1)
                echo "  $name  ($size)"
            fi
        done
        # Also list .tar.gz archives
        for archive in "$BACKUP_ROOT"/*.tar.gz; do
            if [ -f "$archive" ]; then
                name=$(basename "$archive")
                size=$(du -sh "$archive" 2>/dev/null | cut -f1)
                echo "  $name  ($size)"
            fi
        done
        echo ""
        echo "Total backup size: $(du -sh "$BACKUP_ROOT" 2>/dev/null | cut -f1)"
    else
        echo "No backups found."
    fi
}

# ============================================================================
# SAFE BACKUP METHODS
# ============================================================================

# backup_component — rsync or copy a host path
backup_component() {
    local name=$1
    local src=$2
    local dest="${BACKUP_DIR}/${name}"
    # optional "info" mode (3rd arg): a missing source is an expected condition,
    # logged as info and recorded skipped, not a warning.
    local absent_is_info=${3:-}

    if [ -e "$src" ] && [ -r "$src" ]; then
        info "Backing up $name from $src"
        mkdir -p "$dest"

        if [ -d "$src" ]; then
            if rsync -a --exclude='node_modules' --exclude='.git' --exclude='__pycache__' \
                  --exclude='*.log' --exclude='*.tmp' "$src/" "$dest/" 2>/dev/null; then
                success "Backed up $name ($(du -sh "$dest" | cut -f1))"
                record_component "$name" "ok" ""
            else
                warn "Skipping $name — rsync failed (permission denied?)"
                record_component "$name" "failed" "rsync failed (permission denied?) for $src"
            fi
        else
            if cp "$src" "$dest/" 2>/dev/null; then
                success "Backed up $name ($(du -sh "$dest" | cut -f1))"
                record_component "$name" "ok" ""
            else
                warn "Skipping $name — copy failed (permission denied?)"
                record_component "$name" "failed" "copy failed (permission denied?) for $src"
            fi
        fi
    elif [ -n "$absent_is_info" ] && [ ! -e "$src" ]; then
        info "Skipping $name (optional): path does not exist: $src"
        record_component "$name" "skipped" "optional, path absent: $src"
    else
        warn "Skipping $name - path not found or not readable: $src"
        record_component "$name" "skipped" "path not found or not readable: $src"
    fi
}

# backup_sqlite — safe SQLite backup via docker exec sqlite3 .backup (WAL-safe)
# Usage: backup_sqlite <name> <container> <db_path_in_container> [compose_service]
# compose_service is recorded in the manifest so restore-quox.sh can resolve the
# same target on a DIFFERENT box, where the container id will not match.
# >>> sqlite-capture (extracted verbatim by scripts/tests/backup-resilience.test.sh)
# container_ready <id>: running AND accepting exec (a container mid-recreate
# can report Running before exec works).
container_ready() {
    [ -n "${1:-}" ] || return 1
    docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null | grep -q true \
        && docker exec "$1" true >/dev/null 2>&1
}
# container_still <id> <service>: the service still resolves to this same,
# ready container (false if it was recreated or is down).
container_still() {
    local now
    now=$(get_container "$2" 2>/dev/null) || return 1
    [ "$now" = "$1" ] && container_ready "$1"
}
# wait_for_service <service>: print the service's container id once it is
# ready, polling every 10s for at most BACKUP_CONTAINER_WAIT seconds (600).
wait_for_service() {
    local service=$1 max=${BACKUP_CONTAINER_WAIT:-600} waited=0 c
    while :; do
        if c=$(get_container "$service" 2>/dev/null) && container_ready "$c"; then
            echo "$c"; return 0
        fi
        [ "$waited" -ge "$max" ] && return 1
        sleep 10
        waited=$((waited + 10))
    done
}
# sqlite_vacuum_verified <container> <db_path> <dbname>: VACUUM INTO a scratch
# copy inside the container and quick_check it; 0 only for a verified copy.
sqlite_vacuum_verified() {
    local container=$1 db_path=$2 dbname=$3
    docker exec "$container" rm -f "/tmp/${dbname}.bak" 2>/dev/null || true
    docker exec "$container" timeout "$SQLITE_BACKUP_TIMEOUT" sqlite3 "$db_path" "VACUUM INTO '/tmp/${dbname}.bak'" 2>/dev/null \
        && docker exec "$container" timeout 300 sqlite3 "/tmp/${dbname}.bak" "PRAGMA quick_check" 2>/dev/null | grep -q '^ok$'
}

backup_sqlite() {
    local name=$1
    local container=$2
    local db_path=$3
    local service=${4:-}
    local dest="${BACKUP_DIR}/databases"
    local dbname
    dbname=$(basename "$db_path")
    local meta="\"service\":\"${service}\",\"path\":\"${db_path}\""

    mkdir -p "$dest"

    info "Backing up $name (SQLite .backup from $container)"

    # Check container is running. The id may be stale: get_container returns
    # the compose container ID, which a rebuild replaces, so a backup that
    # resolved it before a rebuild would hit a dead id for every later step
    # (quox#739: ward_db failed 2026-10-09 though collector was back up).
    # Re-resolve by service and wait out a recreate, bounded.
    if ! container_ready "$container"; then
        if [ -n "$service" ] && container=$(wait_for_service "$service"); then
            info "$name - re-resolved $service to container $container"
        else
            warn "Skipping $name — container for ${service:-$container} not running (waited up to ${BACKUP_CONTAINER_WAIT:-600}s)"
            record_store "$name" "sqlite" "databases/$dbname" "skipped" "$meta"
            return 0
        fi
    fi

    # Use sqlite3 .backup for a WAL-safe copy, but BOUND IT.
    #
    # sqlite's backup API restarts from the beginning whenever the source is
    # written during the copy. On a hot database that means it can spin
    # forever, and it did: on 2026-08-19 collector_aee_db spent 19.5 minutes
    # in .backup, FAILED anyway, then succeeded in 2 minutes via the fallback
    # below. That one doomed attempt ate two thirds of the job's 30-minute cap
    # and is the single largest reason six consecutive nightly backups failed.
    #
    # Failing fast and falling through is strictly better than spinning: the
    # fallback is the path that actually completes on these databases.
    #
    # The timeout MUST run INSIDE the container. A host-side
    # `timeout N docker exec ...` kills only the docker exec CLIENT; the
    # exec'd sqlite3 keeps running as an orphan and spins against the hot DB
    # indefinitely. On 2026-08-21 exactly that orphan ran 02:00-03:07 (65
    # minutes, root, restart-looping on aee.db), drove load to 281, timed out
    # docker health-check execs estate-wide, and stretched a 75s collector
    # build to 48 minutes; it only died when a deploy recreated the container.
    # The same orphan appears in a ps capture from 2026-08-14, so this was
    # every night the cap tripped. Both service images ship /usr/bin/timeout.
    SQLITE_BACKUP_TIMEOUT=${SQLITE_BACKUP_TIMEOUT:-180}
    # Primary method is VACUUM INTO, not .backup: .backup restarts from zero
    # whenever a writer touches the source, so it never finishes on a hot DB
    # (the exact spin the timeout exists for). VACUUM INTO reads one
    # consistent snapshot under WAL and is immune to writer interference —
    # measured ~2 min for the 5.2G aee.db while live. The copy is then
    # quick_check-VERIFIED in the container before export, because on
    # 2026-08-21 the nightly logged green while the aee.db it shipped failed
    # integrity_check (rowid disorder from a mid-write file copy): a backup
    # that is not restore-verified is a hope, not a backup.
    local verified=false
    if sqlite_vacuum_verified "$container" "$db_path" "$dbname"; then
        verified=true
    elif [ -n "$service" ] && ! container_still "$container" "$service"; then
        # The container was recreated under us (a rebuild mid-backup). Wait
        # for the new one and try once more rather than dropping a required
        # database (quox#739: auth_db and ward_db were lost this way).
        warn "$name - $service container restarted during the copy; waiting for it and retrying once"
        if container=$(wait_for_service "$service") && sqlite_vacuum_verified "$container" "$db_path" "$dbname"; then
            verified=true
        fi
    fi
    if [ "$verified" = true ]; then
        docker cp "$container:/tmp/${dbname}.bak" "$dest/$dbname"
        docker exec "$container" rm -f "/tmp/${dbname}.bak" 2>/dev/null || true
        record_store "$name" "sqlite" "databases/$dbname" "ok" "${meta},\"verified\":true"
        success "Backed up $name (VACUUM INTO, quick_check ok, $(du -sh "$dest/$dbname" | cut -f1))"
    else
        docker exec "$container" rm -f "/tmp/${dbname}.bak" 2>/dev/null || true
        # Fallback: copy the file directly, plus -wal/-shm sidecars. A copy of
        # a LIVE WAL database taken this way is NOT guaranteed consistent (it
        # produced the corrupt 2026-08-21 aee.db artefact), so say so loudly:
        # a restore from this artefact must run its own integrity_check first.
        warn "$name - VACUUM INTO did not produce a verified copy within ${SQLITE_BACKUP_TIMEOUT}s; falling back to raw file+WAL copy, CONSISTENCY NOT VERIFIED"
        if [ -n "$service" ] && ! container_ready "$container"; then
            container=$(wait_for_service "$service") || container=""
        fi
        docker cp "$container:$db_path" "$dest/$dbname" 2>/dev/null || {
            warn "Skipping $name - both VACUUM INTO and docker cp failed"
            record_store "$name" "sqlite" "databases/$dbname" "failed" "$meta"
            return 0
        }
        docker cp "$container:${db_path}-wal" "$dest/${dbname}-wal" 2>/dev/null || true
        docker cp "$container:${db_path}-shm" "$dest/${dbname}-shm" 2>/dev/null || true
        # verified:false travels with the store so a restore can say out loud
        # that this artefact was never integrity-checked at capture time.
        record_store "$name" "sqlite" "databases/$dbname" "ok" "${meta},\"verified\":false"
        warn "Backed up $name via UNVERIFIED file copy with WAL ($(du -sh "$dest/$dbname" | cut -f1)) - integrity_check before trusting a restore"
    fi
}
# <<< sqlite-capture

# backup_sqlite_host — safe SQLite backup for host-accessible databases
# Usage: backup_sqlite_host <name> <host_db_path>
backup_sqlite_host() {
    local name=$1
    local db_path=$2
    local dest="${BACKUP_DIR}/databases"
    local dbname
    dbname=$(basename "$db_path")

    mkdir -p "$dest"

    if [ ! -f "$db_path" ]; then
        warn "Skipping $name — file not found: $db_path"
        return 0
    fi

    info "Backing up $name (SQLite .backup from host)"

    # Use sqlite3 .backup for WAL-safe copy
    if command -v sqlite3 &>/dev/null; then
        if sqlite3 "$db_path" ".backup '$dest/$dbname'" 2>/dev/null; then
            success "Backed up $name ($(du -sh "$dest/$dbname" | cut -f1))"
            return 0
        fi
    fi

    # Fallback: plain copy
    warn "$name — sqlite3 not available or .backup failed, using cp"
    cp "$db_path" "$dest/$dbname"
    success "Backed up $name via cp fallback ($(du -sh "$dest/$dbname" | cut -f1))"
}

# backup_postgres — PostgreSQL dump via docker exec pg_dump
# Usage: backup_postgres <name> <container> <database> [compose_service]
backup_postgres() {
    local name=$1
    local container=$2
    local database=$3
    local service=${4:-}
    local dest="${BACKUP_DIR}/databases"
    local meta="\"service\":\"${service}\",\"database\":\"${database}\""

    mkdir -p "$dest"

    info "Backing up $name (pg_dump from $container)"

    # Check container is running
    if ! docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
        warn "Skipping $name — container $container not running"
        record_store "$name" "postgres" "databases/${database}.pgdump" "skipped" "$meta"
        return 0
    fi

    # Detect the POSTGRES_USER from the container env (default: postgres)
    local pg_user
    pg_user=$(docker exec "$container" printenv POSTGRES_USER 2>/dev/null || echo "postgres")

    # pg_dump with custom format (supports pg_restore)
    if docker exec "$container" pg_dump -U "$pg_user" --format=custom --no-owner "$database" > "$dest/${database}.pgdump" 2>/dev/null; then
        local size
        size=$(du -sh "$dest/${database}.pgdump" | cut -f1)
        if [ -s "$dest/${database}.pgdump" ]; then
            record_store "$name" "postgres" "databases/${database}.pgdump" "ok" "$meta"
            success "Backed up $name ($size)"
        else
            warn "$name — pg_dump produced empty file"
            rm -f "$dest/${database}.pgdump"
            record_store "$name" "postgres" "databases/${database}.pgdump" "failed" "$meta"
        fi
    else
        warn "Skipping $name — pg_dump failed"
        rm -f "$dest/${database}.pgdump"
        record_store "$name" "postgres" "databases/${database}.pgdump" "failed" "$meta"
    fi
    return 0
}

# backup_docker_path — use docker cp to extract data from a container
# Usage: backup_docker_path <name> <container> <path_in_container> [compose_service]
backup_docker_path() {
    local name=$1
    local container=$2
    local container_path=$3
    local service=${4:-}
    local dest="${BACKUP_DIR}/${name}"
    # docker cp of `ctr:/a/b/` lands as `$dest/b`, so that is the path a restore
    # has to read back from. Record the real leaf, not the wrapper dir.
    local leaf
    leaf=$(basename "${container_path%/}")
    local meta="\"service\":\"${service}\",\"path\":\"${container_path}\""

    mkdir -p "$dest"

    info "Backing up $name (docker cp from $container:$container_path)"

    # Check container is running
    if ! docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -q true; then
        warn "Skipping $name — container $container not running"
        record_store "$name" "dir" "${name}/${leaf}" "skipped" "$meta"
        return 0
    fi

    if docker cp "$container:$container_path" "$dest/" 2>/dev/null && [ -e "$dest/$leaf" ]; then
        record_store "$name" "dir" "${name}/${leaf}" "ok" "$meta"
        success "Backed up $name ($(du -sh "$dest" | cut -f1))"
    else
        warn "Skipping $name — docker cp failed for $container:$container_path"
        record_store "$name" "dir" "${name}/${leaf}" "failed" "$meta"
    fi
    return 0
}

# ============================================================================
# DYNAMIC CONTAINER DISCOVERY
# ============================================================================

# Resolve a docker compose service name to its running container ID.
# Uses `docker compose ps -q` so we never rely on hardcoded container names.
# Overridable for deploys that don't live at /opt/quoxcore (e.g. /opt/quoxcore
# on public boxes) — see docs/PUBLIC_DEPLOY_RUNBOOK.md.
COMPOSE_DIR="${QUOX_COMPOSE_DIR:-/opt/quoxcore}"

get_container() {
    local service="$1"
    local container
    local named="${CONTAINER_PREFIX}-${service}"

    # A NON-DEFAULT CONTAINER_PREFIX means the caller is naming a specific stack
    # (the rehearsal stack, a second instance). Compose discovery would resolve
    # COMPOSE_DIR's stack instead — i.e. quietly back up the wrong instance —
    # so the explicit name wins when the operator was explicit.
    if [ "$CONTAINER_PREFIX" != "quox" ]; then
        if docker inspect --format '{{.State.Running}}' "$named" 2>/dev/null | grep -q true; then
            echo "$named"
            return 0
        fi
    fi

    # Try docker compose first (may need DOCKER_GID env var)
    container=$(cd "$COMPOSE_DIR" && DOCKER_GID="${DOCKER_GID:-0}" docker compose ps -q "$service" 2>/dev/null | head -1) || true
    if [ -n "$container" ]; then
        echo "$container"
        return 0
    fi
    # Fallback: try legacy name pattern (<prefix>-<service>)
    if docker inspect --format '{{.State.Running}}' "$named" 2>/dev/null | grep -q true; then
        echo "$named"
        return 0
    fi
    return 1
}

# Brain2's compose service is `quoxbrain` (profile-only, so `docker compose ps`
# returns nothing for it) but its container is `quox-brain`, not the
# `<prefix>-quoxbrain` fallback get_container tries. Without this the nightly
# log said "container not found" and Brain2 (NotesQ notes) was in no backup
# (found 2026-10-07; test: src/test/backupQuoxbrainLookup.test.js).
quoxbrain_container() {
    get_container "quoxbrain" || get_container "brain"
}

# ============================================================================
# BACKUP DATABASES (safe per-database methods)
# ============================================================================

backup_databases() {
    info "Backing up databases..."

    local db_backup="${BACKUP_DIR}/databases"
    mkdir -p "$db_backup"

    # 1. Auth DB — always from container (host path is a stale dev artifact)
    local auth_ctr
    auth_ctr=$(get_container "auth" || wait_for_service "auth") && \
        backup_sqlite "auth_db" "$auth_ctr" "/var/lib/quox/auth.db" "auth" || {
        warn "Skipping auth_db — container not found"
        record_store "auth_db" "sqlite" "databases/auth.db" "skipped" "\"service\":\"auth\",\"path\":\"/var/lib/quox/auth.db\""
    }

    # 2. Collector AEE DB (container SQLite)
    local collector_ctr
    collector_ctr=$(get_container "collector" || wait_for_service "collector") && \
        backup_sqlite "collector_aee_db" "$collector_ctr" "/var/lib/quox/aee.db" "collector" || {
        warn "Skipping collector_aee_db — container not found"
        record_store "collector_aee_db" "sqlite" "databases/aee.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/aee.db\""
    }

    # 3. Memory Service DB (container SQLite)
    local memory_ctr
    memory_ctr=$(get_container "memory" || wait_for_service "memory") && \
        backup_sqlite "memory_db" "$memory_ctr" "/var/lib/quox/memory.db" "memory" || {
        warn "Skipping memory_db — container not found"
        record_store "memory_db" "sqlite" "databases/memory.db" "skipped" "\"service\":\"memory\",\"path\":\"/var/lib/quox/memory.db\""
    }

    # 4. PostgreSQL — QuoxFlow
    local pg_ctr
    pg_ctr=$(get_container "postgres") && \
        backup_postgres "postgres_db" "$pg_ctr" "quoxflow" "postgres" || {
        warn "Skipping postgres_db — container not found"
        record_store "postgres_db" "postgres" "databases/quoxflow.pgdump" "skipped" "\"service\":\"postgres\",\"database\":\"quoxflow\""
    }

    # 5. Qdrant snapshots (try compose service, then legacy names)
    local qdrant_container
    local qdrant_volume="${CONTAINER_PREFIX}-qdrant-data"
    qdrant_container=$(get_container "qdrant") || qdrant_container=""
    if [ -z "$qdrant_container" ]; then
        # Try bare "qdrant" container name
        if docker inspect --format '{{.State.Running}}' qdrant 2>/dev/null | grep -q true; then
            qdrant_container="qdrant"
        fi
    fi
    if docker inspect --format '{{.State.Running}}' "$qdrant_container" 2>/dev/null | grep -q true; then
        # Resolve the REAL volume from the container's /qdrant/storage mount
        # rather than guessing "${prefix}-qdrant-data". A stack whose volume
        # names differ from the container prefix (a rehearsal stack, or any
        # default-compose "<project>_qdrant-data" naming) does not match the
        # guess, and `docker run -v <missing-name>:/q` silently mounts a FRESH
        # EMPTY volume — the backup then records "failed/empty" while the real
        # vectors sit untouched in the actual volume (G2d qdrant drill, 2026-09-18).
        local resolved_vol
        resolved_vol=$(docker inspect "$qdrant_container" \
            --format '{{range .Mounts}}{{if eq .Destination "/qdrant/storage"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)
        [ -n "$resolved_vol" ] && qdrant_volume="$resolved_vol"
        info "Backing up Qdrant storage volume (${qdrant_volume})..."
        # TRUST-GATE-OPS restore drill 2026-07-04: the live data is the
        # quox-qdrant-data docker volume (mounted at /qdrant/storage), NOT the
        # legacy /opt/qdrant/data path — that stale path silently produced an
        # EMPTY qdrant-data/ dir in every nightly since the compose migration.
        # Copy via a throwaway container so this works regardless of which
        # user/host context runs the backup. Fail LOUDLY if the copy is empty.
        # The copy runs as root inside the throwaway container; hand ownership
        # back to the user running this script, or retention can never delete
        # the run dir (prod 2026-10-11: 250 runs, 37 GB, disk 100% full).
        if docker run --rm -e OWN="$(id -u):$(id -g)" -v "${qdrant_volume}":/q:ro -v "$db_backup":/dest alpine \
            sh -c 'cp -a /q /dest/qdrant-data && chown -R "$OWN" /dest/qdrant-data && [ -n "$(ls /dest/qdrant-data 2>/dev/null)" ]' 2>/dev/null; then
            record_store "qdrant_data" "volume" "databases/qdrant-data" "ok" "\"service\":\"qdrant\",\"volume\":\"${qdrant_volume}\",\"path\":\"/qdrant/storage\""
            success "Backed up Qdrant data ($(du -sh "$db_backup/qdrant-data" 2>/dev/null | cut -f1))"
        else
            record_store "qdrant_data" "volume" "databases/qdrant-data" "failed" "\"service\":\"qdrant\",\"volume\":\"${qdrant_volume}\",\"path\":\"/qdrant/storage\""
            error "Qdrant volume backup FAILED or empty — vector memory NOT in this backup"
        fi
    else
        record_store "qdrant_data" "volume" "databases/qdrant-data" "skipped" "\"service\":\"qdrant\",\"volume\":\"${qdrant_volume}\",\"path\":\"/qdrant/storage\""
        warn "Skipping Qdrant — container not running"
    fi

    # 6. Tasks DB (container SQLite)
    local tasks_ctr
    tasks_ctr=$(get_container "tasks") && \
        backup_sqlite "tasks_db" "$tasks_ctr" "/var/lib/quox/tasks.db" "tasks" || {
        warn "Skipping tasks_db — container not found"
        record_store "tasks_db" "sqlite" "databases/tasks.db" "skipped" "\"service\":\"tasks\",\"path\":\"/var/lib/quox/tasks.db\""
    }

    # 6b. Brain2 DB (container SQLite, quoxbrain is profile-optional: with-quoxbrain/full)
    # ~3.4G in WAL mode; VACUUM INTO of the 5.2G aee.db took ~2 min, so give it
    # a 400s ceiling (override: QUOXBRAIN_BACKUP_TIMEOUT) instead of the 180s default.
    local quoxbrain_ctr
    if quoxbrain_ctr=$(quoxbrain_container); then
        SQLITE_BACKUP_TIMEOUT="${QUOXBRAIN_BACKUP_TIMEOUT:-400}" backup_sqlite "quoxbrain_db" "$quoxbrain_ctr" "/var/lib/quox/quoxbrain.db" "quoxbrain" || {
            warn "quoxbrain_db backup FAILED (container ${quoxbrain_ctr} found; see the lines above)"
            record_store "quoxbrain_db" "sqlite" "databases/quoxbrain.db" "failed" "\"service\":\"quoxbrain\",\"path\":\"/var/lib/quox/quoxbrain.db\""
        }
    else
        warn "Skipping quoxbrain_db — container not found"
        record_store "quoxbrain_db" "sqlite" "databases/quoxbrain.db" "skipped" "\"service\":\"quoxbrain\",\"path\":\"/var/lib/quox/quoxbrain.db\""
    fi

    # 7. VOLT DB (container SQLite, inside collector)
    #
    # SIZE GUARD, added 2026-08-19 after SIX consecutive failed nightly runs.
    #
    # volt.db reached 89.3GB (unbounded tool.call.executed payloads, since
    # fixed at the emitter). Copying and gzipping it blew this job's 30-minute
    # cap every night, so the WHOLE backup failed and the org had no
    # recoverable copy of anything, auth and memory and tasks and uploads
    # included, for five days. Confirmed on 2026-08-19 02:35 with 103GB free,
    # so it is the time cap and not disk space.
    #
    # Everything other than volt.db fits comfortably inside the cap. Skipping
    # one oversized component to save the other twenty is the right trade, and
    # it is what makes a verified backup possible again before any reclaim.
    #
    # The skip is LOUD and RECORDED. A backup that quietly omits the evidence
    # chain would be worse than a failed one: a failed backup is visibly
    # broken, a silently partial backup is trusted until the day it is needed.
    VOLT_MAX_BYTES=${VOLT_MAX_BYTES:-$((8 * 1024 * 1024 * 1024))}
    VOLT_SKIPPED_BYTES=0
    if [ -n "${collector_ctr:-}" ]; then
        volt_bytes=$(docker exec "$collector_ctr" stat -c %s /var/lib/quox/volt.db 2>/dev/null || echo 0)
        if [ "${volt_bytes:-0}" -gt "$VOLT_MAX_BYTES" ]; then
            VOLT_SKIPPED_BYTES=$volt_bytes
            record_store "volt_db" "sqlite" "databases/volt.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/volt.db\",\"skip_reason\":\"size_guard\",\"skipped_bytes\":${volt_bytes}"
            VOLT_SKIP_MSG="volt_db NOT BACKED UP ($(awk -v b="$volt_bytes" 'BEGIN{printf "%.1f", b/1073741824}')GB > VOLT_MAX_BYTES)"
            warn "$VOLT_SKIP_MSG"
            warn "  The rest of this backup will complete, marked DEGRADED. The EVIDENCE CHAIN IS NOT IN IT."
            warn "  Raise VOLT_MAX_BYTES to include it, or reclaim volt.db (QuoxPlan VOLT-RETENTION)."
        else
            backup_sqlite "volt_db" "$collector_ctr" "/var/lib/quox/volt.db" "collector"
        fi
    else
        warn "Skipping volt_db - collector container not found"
        record_store "volt_db" "sqlite" "databases/volt.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/volt.db\""
    fi

    # 8. WARD DB (container SQLite — inside collector)
    if [ -n "${collector_ctr:-}" ]; then
        backup_sqlite "ward_db" "$collector_ctr" "/var/lib/quox/ward.db" "collector"
    else
        warn "Skipping ward_db — collector container not found"
        record_store "ward_db" "sqlite" "databases/ward.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/ward.db\""
    fi

    # 9. Feedback DB (container SQLite — inside collector)
    if [ -n "${collector_ctr:-}" ]; then
        backup_sqlite "feedback_db" "$collector_ctr" "/var/lib/quox/feedback.db" "collector"
    else
        warn "Skipping feedback_db — collector container not found"
        record_store "feedback_db" "sqlite" "databases/feedback.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/feedback.db\""
    fi

    # 9b. InboxQ DB (container SQLite — inside collector). RECOVERABLE dimension:
    # holds connected mailbox accounts, triaged messages, watches, reports and
    # filing proposals. Registered here in the SAME commit the store shipped so
    # it is never silently uncovered (the 2026-09-01 QuoxPlan-DB gap lesson).
    if [ -n "${collector_ctr:-}" ]; then
        backup_sqlite "inboxq_db" "$collector_ctr" "/var/lib/quox/inboxq.db" "collector"
    else
        warn "Skipping inboxq_db — collector container not found"
        record_store "inboxq_db" "sqlite" "databases/inboxq.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/inboxq.db\""
    fi

    # 9c. Calendar-Q DB (container SQLite — inside collector). RECOVERABLE
    # dimension: holds connections, generations/occurrences, layers,
    # proposals/operations and receipts. Registered here in the SAME commit
    # the store shipped so it is never silently uncovered (the 2026-09-01
    # QuoxPlan-DB gap lesson), same pattern as inboxq_db above.
    if [ -n "${collector_ctr:-}" ]; then
        backup_sqlite "calendarq_db" "$collector_ctr" "/var/lib/quox/calendarq.db" "collector"
    else
        warn "Skipping calendarq_db — collector container not found"
        record_store "calendarq_db" "sqlite" "databases/calendarq.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/calendarq.db\""
    fi

    # 9d. ContactsQ DB (container SQLite — inside collector). RECOVERABLE
    # dimension: encrypted contacts, blind-indexed identifiers, provenance and
    # suppressions. Ciphertext is useless without MASTER_ENCRYPTION_KEY, which
    # the secrets backup must cover. Registered in the SAME commit the store
    # shipped so it is never silently uncovered, same pattern as calendarq_db.
    if [ -n "${collector_ctr:-}" ]; then
        backup_sqlite "contactsq_db" "$collector_ctr" "/var/lib/quox/contactsq.db" "collector"
    else
        warn "Skipping contactsq_db — collector container not found"
        record_store "contactsq_db" "sqlite" "databases/contactsq.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/contactsq.db\""
    fi

    # 10. Wazuh DB (container SQLite — inside collector)
    if [ -n "${collector_ctr:-}" ]; then
        backup_sqlite "wazuh_db" "$collector_ctr" "/var/lib/quox/wazuh.db" "collector"
    else
        warn "Skipping wazuh_db — collector container not found"
        record_store "wazuh_db" "sqlite" "databases/wazuh.db" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/wazuh.db\""
    fi

    # 10b. Quox Spatial backend DB (SQLite in the plugin-spatial container).
    #
    # Holds published waypoints, spatial EVENTS and their hash chain, issuer
    # keys, and per-org registry snapshots: the event history W5's attestation
    # proves. Not in auth.db, which carries the plugin's api.durable
    # entities/zones; this is the Tier-2 backend's own store.
    #
    # RESTORED HERE 2026-08-19. This component was written against
    # /opt/quoxcore/bin/backup-quox.sh, which the scheduler does NOT execute -
    # it runs /app/project/scripts/backup-quox.sh, a bind mount of THIS file.
    # So an audit spotted the gap, someone wrote the fix, and it sat in a copy
    # nothing ran: the coverage gap was open the whole time and the commit
    # made it look closed. Worth remembering before trusting any backup
    # component you have not watched run.
    local spatial_ctr
    # NOTE: needs `|| true` — under `set -euo pipefail`, a `grep` no-match here
    # (the common case: plugin-spatial is optional and most installs don't run
    # it) makes the whole pipeline non-zero, and this plain assignment isn't
    # inside a conditional, so errexit killed the ENTIRE backup silently right
    # here with no error line (get_container() above already guards the same
    # docker-ps-pipe pattern this way; this call site didn't). Found running
    # --full on a fresh trimmed install (hostnode01, 2026-09-03): the backup
    # always exited 1 immediately after wazuh_db, before git-bundles/manifest.
    # Matches the prefixed name too, so a second stack backs up ITS spatial
    # container rather than the default install's.
    spatial_ctr=$(docker ps --format '{{.Names}}' | grep -E "^(${CONTAINER_PREFIX}-plugin-spatial|plugin-spatial)$" | head -1) || true
    if [ -n "${spatial_ctr:-}" ]; then
        local sdest="${BACKUP_DIR}/databases"
        mkdir -p "$sdest"
        info "Backing up spatial_backend_db (better-sqlite3 .backup, WAL-safe)"
        # The alpine image has no sqlite3 CLI, but it has better-sqlite3 whose
        # .backup() is WAL-safe. A plain docker cp could miss the -wal file and
        # produce a torn copy that restores to a slightly older state.
        if docker exec "$spatial_ctr" node -e "require('better-sqlite3')('/data/spatial.db',{readonly:true}).backup('/tmp/spatial.db.bak').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})" 2>/dev/null; then
            docker cp "$spatial_ctr:/tmp/spatial.db.bak" "$sdest/spatial.db"
            docker exec "$spatial_ctr" rm -f /tmp/spatial.db.bak 2>/dev/null || true
            record_store "spatial_backend_db" "sqlite" "databases/spatial.db" "ok" "\"service\":\"plugin-spatial\",\"container\":\"${spatial_ctr}\",\"path\":\"/data/spatial.db\",\"verified\":true"
            success "Backed up spatial_backend_db ($(du -sh "$sdest/spatial.db" | cut -f1))"
        else
            warn "spatial_backend_db - better-sqlite3 .backup failed, trying docker cp"
            if docker cp "$spatial_ctr:/data/spatial.db" "$sdest/spatial.db" 2>/dev/null; then
                record_store "spatial_backend_db" "sqlite" "databases/spatial.db" "ok" "\"service\":\"plugin-spatial\",\"container\":\"${spatial_ctr}\",\"path\":\"/data/spatial.db\",\"verified\":false"
            else
                warn "Skipping spatial_backend_db - all methods failed"
                record_store "spatial_backend_db" "sqlite" "databases/spatial.db" "failed" "\"service\":\"plugin-spatial\",\"container\":\"${spatial_ctr}\",\"path\":\"/data/spatial.db\""
            fi
        fi
    else
        info "Skipping spatial_backend_db - plugin-spatial container not running (plugin may be uninstalled)"
        record_store "spatial_backend_db" "sqlite" "databases/spatial.db" "skipped" "\"service\":\"plugin-spatial\",\"path\":\"/data/spatial.db\""
    fi

    # 10c. QuoxPlan roadmap store DB (SQLite, container "quoxplan" — optional,
    # profile with-quoxplan/full).
    #
    # gh#462: quoxplan.db had NO app-level coverage in THIS proven daily
    # manifest. Its only app-level backup was a separate 6-hourly crontab
    # writing to ~/quoxplan/backups/, which stopped completing ~2 months
    # before this was found (newest file 2026-07-25 vs a live db that changed
    # 2026-09-23). Only VM-level PBS covered it. This closes that gap the same
    # way every other DB here is covered: inside the daily run that is actually
    # proven to complete.
    #
    # Same WAL-safe idea as backup_sqlite() above (VACUUM INTO to a scratch
    # copy, PRAGMA quick_check on that copy before trusting it, only THEN
    # export) — but the quoxplan image (Alpine, built from
    # /opt/quoxcore/quoxplan/server) has no sqlite3 CLI baked in, only
    # better-sqlite3 as a node dependency. Run the identical two steps through
    # node instead of the CLI; the live db path inside the container is
    # /data/quoxplan.db (see docker-compose.yml quoxplan service volume mount).
    local quoxplan_ctr
    quoxplan_ctr=$(get_container "quoxplan") || quoxplan_ctr=""
    if [ -n "${quoxplan_ctr:-}" ]; then
        local qdest="${BACKUP_DIR}/databases"
        local quoxplan_timeout="${SQLITE_BACKUP_TIMEOUT:-180}"
        mkdir -p "$qdest"
        info "Backing up quoxplan_db (VACUUM INTO via node/better-sqlite3, WAL-safe)"
        docker exec "$quoxplan_ctr" rm -f /tmp/quoxplan.db.bak 2>/dev/null || true
        if docker exec "$quoxplan_ctr" timeout "$quoxplan_timeout" node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/quoxplan.db', { readonly: true, fileMustExist: true });
db.exec(\"VACUUM INTO '/tmp/quoxplan.db.bak'\");
db.close();
" 2>/dev/null \
           && docker exec "$quoxplan_ctr" timeout 300 node -e "
const Database = require('better-sqlite3');
const db = new Database('/tmp/quoxplan.db.bak', { readonly: true, fileMustExist: true });
const r = db.pragma('quick_check');
db.close();
if (!(r.length === 1 && r[0].quick_check === 'ok')) process.exit(1);
" 2>/dev/null; then
            docker cp "$quoxplan_ctr:/tmp/quoxplan.db.bak" "$qdest/quoxplan.db"
            docker exec "$quoxplan_ctr" rm -f /tmp/quoxplan.db.bak 2>/dev/null || true
            record_store "quoxplan_db" "sqlite" "databases/quoxplan.db" "ok" "\"service\":\"quoxplan\",\"path\":\"/data/quoxplan.db\",\"verified\":true"
            success "Backed up quoxplan_db (VACUUM INTO, quick_check ok, $(du -sh "$qdest/quoxplan.db" | cut -f1))"
        else
            docker exec "$quoxplan_ctr" rm -f /tmp/quoxplan.db.bak 2>/dev/null || true
            warn "quoxplan_db - VACUUM INTO/quick_check did not complete within ${quoxplan_timeout}s; falling back to raw file+WAL copy, CONSISTENCY NOT VERIFIED"
            if docker cp "$quoxplan_ctr:/data/quoxplan.db" "$qdest/quoxplan.db" 2>/dev/null; then
                docker cp "$quoxplan_ctr:/data/quoxplan.db-wal" "$qdest/quoxplan.db-wal" 2>/dev/null || true
                docker cp "$quoxplan_ctr:/data/quoxplan.db-shm" "$qdest/quoxplan.db-shm" 2>/dev/null || true
                record_store "quoxplan_db" "sqlite" "databases/quoxplan.db" "ok" "\"service\":\"quoxplan\",\"path\":\"/data/quoxplan.db\",\"verified\":false"
                warn "Backed up quoxplan_db via UNVERIFIED file copy with WAL ($(du -sh "$qdest/quoxplan.db" | cut -f1)) - integrity_check before trusting a restore"
            else
                warn "Skipping quoxplan_db - both VACUUM INTO and docker cp failed"
                record_store "quoxplan_db" "sqlite" "databases/quoxplan.db" "failed" "\"service\":\"quoxplan\",\"path\":\"/data/quoxplan.db\""
            fi
        fi
    else
        info "Skipping quoxplan_db - quoxplan container not running (optional, profile with-quoxplan/full)"
        record_store "quoxplan_db" "sqlite" "databases/quoxplan.db" "skipped" "\"service\":\"quoxplan\",\"path\":\"/data/quoxplan.db\""
    fi

    # 11. Action-Q config (from collector container)
    if [ -n "${collector_ctr:-}" ]; then
        backup_docker_path "action-q-data" "$collector_ctr" "/var/lib/quox/actions/" "collector" || \
            warn "Skipping action-q-data — path not found in collector"
    else
        record_store "action-q-data" "dir" "action-q-data/actions" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/actions/\""
    fi

    # 12. WARD signing keys (from collector container)
    if [ -n "${collector_ctr:-}" ]; then
        backup_docker_path "ward-keys" "$collector_ctr" "/var/lib/quox/ward-keys/" "collector" || \
            warn "Skipping ward-keys — path not found in collector"
    else
        record_store "ward-keys" "dir" "ward-keys/ward-keys" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/ward-keys/\""
    fi

    # 11. n8n data (docker_cp) — optional, behind --profile with-n8n
    local n8n_ctr
    n8n_ctr=$(get_container "n8n") && \
        backup_docker_path "n8n-data" "$n8n_ctr" "/home/node/.n8n/" "n8n" || {
        warn "Skipping n8n-data — container not found (optional)"
        record_store "n8n-data" "dir" "n8n-data/.n8n" "skipped" "\"service\":\"n8n\",\"path\":\"/home/node/.n8n/\""
    }
}

# ============================================================================
# GIT REPOS (full only)
# ============================================================================

backup_git_repos() {
    info "Backing up git repositories..."

    local git_backup="${BACKUP_DIR}/git-bundles"
    mkdir -p "$git_backup"

    # Overridable for deploys where sibling repos aren't checked out under
    # /opt/quoxcore (e.g. /opt/quoxcore on public boxes) — see
    # docs/PUBLIC_DEPLOY_RUNBOOK.md.
    local repos_root="${QUOX_REPOS_ROOT:-/opt/quoxcore}"

    local repos=(
        "quox-dashboard"
        "quoxagent"
        "quox-website"
        "quoxflow"
        "QuoxBastion"
        "quoxmcp"
    )

    for repo in "${repos[@]}"; do
        if [ -d "${repos_root}/${repo}/.git" ]; then
            bundle_git_repo "$repos_root" "$repo" "$git_backup"
        fi
    done
}

# >>> git-bundles (extracted verbatim by scripts/tests/backup-resilience.test.sh)
# bundle_git_repo <repos_root> <repo> <dest_dir>
# The script runs as the auth container's user (uid 1001), not the repo owner,
# so git refuses every repo as "dubious ownership" unless the path is trusted
# for this one call. That failed silently every night from at least
# 2026-09-27 because stderr went to /dev/null (quox#738). Trust is scoped to
# the exact repo path, and git's own error is logged on failure.
bundle_git_repo() {
    local root=$1 repo=$2 dest=$3 path err
    path="${root}/${repo}"
    mkdir -p "$dest"
    if err=$(cd "$path" && git -c safe.directory="$path" bundle create "$dest/${repo}.bundle" --all 2>&1 >/dev/null); then
        record_component "git-${repo}" "ok" ""
        success "Created git bundle for $repo"
    else
        err=$(printf '%s' "$err" | grep -v '^warning:' | tail -2 | tr '\n' ' ')
        record_component "git-${repo}" "failed" "$err"
        warn "Git bundle failed for $repo: ${err:-no error output}"
    fi
}
# <<< git-bundles

# ============================================================================
# CREATE MANIFEST
# ============================================================================

create_manifest() {
    local manifest="${BACKUP_DIR}/MANIFEST.txt"

    {
        echo "Quox Backup Manifest"
        echo "======================="
        echo "Timestamp: $TIMESTAMP"
        echo "Date: $(date)"
        echo "Hostname: $(hostname)"
        echo "User: $(whoami)"
        echo "Version: D.1b (26 components)"
        echo ""
        echo "Contents:"
        echo "---------"
        # One find, not one du per file: since GRIPE-710 (de962e853) the
        # quoxflow evidence component adds ~190k files, and a du fork per file
        # took the manifest from ~2 min to 30+ min, pushing every run past its
        # timeout (#727/#728). Sizes are apparent bytes in B/K/M/G/T.
        find "$BACKUP_DIR" -type f -printf '%s %P\n' | LC_ALL=C sort -k2 | awk '{
            s = $1; p = substr($0, length($1) + 2); split("B K M G T", u, " "); i = 1
            while (s >= 1024 && i < 5) { s /= 1024; i++ }
            printf "  %s  %s\n", (i == 1 ? sprintf("%d%s", s, u[i]) : sprintf("%.1f%s", s, u[i])), p
        }'
        echo ""
        echo "Total Size: $(du -sh "$BACKUP_DIR" | cut -f1)"
    } > "$manifest"

    info "Created manifest: $manifest"

    # JSON manifest with database counts and checksums
    create_json_manifest
}

# build_stores_json — render the store ledger as manifest.json .stores[], and
# cache each store file's sha256 in STORE_SHA so the legacy per-component
# checksums below reuse it instead of hashing multi-GB databases twice.
# Sets STORES_JSON (a global: command substitution would drop STORE_SHA).
declare -A STORE_SHA=()
STORES_JSON=""
build_stores_json() {
    local rec name kind file status extra sha abs bytes entry
    local out=""
    for rec in ${STORE_RECORDS[@]+"${STORE_RECORDS[@]}"}; do
        IFS='|' read -r name kind file status extra <<< "$rec"
        sha=""
        bytes=0
        abs="${BACKUP_DIR}/${file}"
        if [ "$status" = "ok" ] && [ -f "$abs" ]; then
            sha=$(sha256sum "$abs" 2>/dev/null | cut -d' ' -f1)
            bytes=$(stat -c %s "$abs" 2>/dev/null || echo 0)
            STORE_SHA["$file"]="$sha"
        elif [ "$status" = "ok" ] && [ -d "$abs" ]; then
            # Directories and the qdrant volume tree are size-accounted only:
            # a tree-wide hash on a multi-GB store would cost more than it is
            # worth here, and the restore verifies those by presence + count.
            bytes=$(du -sb "$abs" 2>/dev/null | cut -f1)
        fi
        entry="    { \"name\": \"${name}\", \"kind\": \"${kind}\", \"file\": \"${file}\", \"status\": \"${status}\", \"sha256\": \"${sha}\", \"size_bytes\": ${bytes:-0}"
        [ -n "$extra" ] && entry="${entry}, ${extra}"
        entry="${entry} }"
        if [ -z "$out" ]; then
            out="$entry"
        else
            out="${out},
${entry}"
        fi
    done
    STORES_JSON="$out"
}

# sha_for — checksum of a run-dir-relative file, reusing build_stores_json's
# work when the file was recorded as a store.
sha_for() {
    local rel=$1
    if [ -n "${STORE_SHA[$rel]:-}" ]; then
        echo "${STORE_SHA[$rel]}"
    elif [ -f "${BACKUP_DIR}/${rel}" ]; then
        sha256sum "${BACKUP_DIR}/${rel}" 2>/dev/null | cut -d' ' -f1
    fi
}

create_json_manifest() {
    local json_manifest="${BACKUP_DIR}/manifest.json"
    classify_degraded
    local total_size
    total_size=$(du -sb "$BACKUP_DIR" 2>/dev/null | cut -f1)

    # Count records via containers (more reliable than host sqlite3)
    local users=0 memories=0 objectives=0 tasks=0 envelopes=0 volt_entries=0 ward_entries=0

    local auth_ctr collector_ctr memory_ctr tasks_ctr
    auth_ctr=$(get_container "auth" 2>/dev/null) || true
    collector_ctr=$(get_container "collector" 2>/dev/null) || true
    memory_ctr=$(get_container "memory" 2>/dev/null) || true
    tasks_ctr=$(get_container "tasks" 2>/dev/null) || true

    [ -n "$auth_ctr" ] && users=$(docker exec "$auth_ctr" sqlite3 /var/lib/quox/auth.db "SELECT COUNT(*) FROM users" 2>/dev/null || echo 0)
    [ -n "$memory_ctr" ] && memories=$(docker exec "$memory_ctr" sqlite3 /var/lib/quox/memory.db "SELECT COUNT(*) FROM memories" 2>/dev/null || echo 0)
    [ -n "$tasks_ctr" ] && objectives=$(docker exec "$tasks_ctr" sqlite3 /var/lib/quox/tasks.db "SELECT COUNT(*) FROM objectives" 2>/dev/null || echo 0)
    [ -n "$tasks_ctr" ] && tasks=$(docker exec "$tasks_ctr" sqlite3 /var/lib/quox/tasks.db "SELECT COUNT(*) FROM tasks" 2>/dev/null || echo 0)
    [ -n "$collector_ctr" ] && envelopes=$(docker exec "$collector_ctr" sqlite3 /var/lib/quox/aee.db "SELECT COUNT(*) FROM envelopes" 2>/dev/null || echo 0)
    [ -n "$collector_ctr" ] && volt_entries=$(docker exec "$collector_ctr" sqlite3 /var/lib/quox/volt.db "SELECT COUNT(*) FROM volt_events" 2>/dev/null || echo 0)
    [ -n "$collector_ctr" ] && ward_entries=$(docker exec "$collector_ctr" sqlite3 /var/lib/quox/ward.db "SELECT COUNT(*) FROM ward_entries" 2>/dev/null || echo 0)

    # Render the store ledger first: it hashes every captured store file and
    # caches the result, so the per-component checksums below are lookups.
    build_stores_json

    # Compute SHA-256 for each database file
    local auth_sha="" mem_sha="" tasks_sha="" aee_sha="" volt_sha="" ward_sha="" fb_sha=""
    auth_sha=$(sha_for "databases/auth.db")
    mem_sha=$(sha_for "databases/memory.db")
    tasks_sha=$(sha_for "databases/tasks.db")
    aee_sha=$(sha_for "databases/aee.db")
    volt_sha=$(sha_for "databases/volt.db")
    ward_sha=$(sha_for "databases/ward.db")
    fb_sha=$(sha_for "databases/feedback.db")

    cat > "$json_manifest" <<MANIFEST_EOF
{
  "version": "1.0",
  "schema_version": 1,
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "timestamp": "$TIMESTAMP",
  "source_instance": "$(hostname)",
  "backup_script_version": "D.1b",
  "container_prefix": "${CONTAINER_PREFIX}",
  "total_size_bytes": ${total_size:-0},
  "degraded": ${DEGRADED},
  "skipped_required": $(json_str_array ${SKIPPED_REQUIRED[@]+"${SKIPPED_REQUIRED[@]}"}),
  "degraded_reasons": $(json_str_array ${DEGRADED_REASONS[@]+"${DEGRADED_REASONS[@]}"}),
  "stores": [
${STORES_JSON}
  ],
  "components": {
    "auth_db": { "file": "databases/auth.db", "users": $users, "checksum": "$auth_sha" },
    "memory_db": { "file": "databases/memory.db", "memories": $memories, "checksum": "$mem_sha" },
    "tasks_db": { "file": "databases/tasks.db", "objectives": $objectives, "tasks": $tasks, "checksum": "$tasks_sha" },
    "aee_db": { "file": "databases/aee.db", "envelopes": $envelopes, "checksum": "$aee_sha" },
    "volt_db": { "file": "databases/volt.db", "entries": $volt_entries, "checksum": "$volt_sha", "skipped_bytes": ${VOLT_SKIPPED_BYTES:-0} },
    "ward_db": { "file": "databases/ward.db", "receipts": $ward_entries, "checksum": "$ward_sha" },
    "feedback_db": { "file": "databases/feedback.db", "checksum": "$fb_sha" }
  }
}
MANIFEST_EOF

    success "Created JSON manifest with record counts and checksums"
}

# ============================================================================
# CLEANUP / COMPRESS
# ============================================================================

# Reap ABANDONED run directories: a run dir with no matching .tar.gz never
# finished, so nothing will ever use it.
#
# 2026-08-19: 60 of these were holding 60GB. They accumulate because
# cleanup_old_backups runs at the END of a successful run, so a backup that
# dies partway never cleans up — and once backups start failing, every
# subsequent failure adds another directory that nothing will ever remove. The
# disk pressure that was degrading builds all week was substantially this.
#
# Runs at the START (see main), not the end, precisely because the end is the
# part that was never reached. Same age policy as retention, so this only ever
# removes what retention would have removed had it run.
# Delete one backup path. A plain rm cannot remove root-owned files that a
# throwaway container wrote (qdrant-data); fall back to a root container on the
# same bind mount. Returns non-zero if the path still exists afterwards, so the
# callers COUNT failures instead of swallowing them (2>/dev/null || true hid a
# 37 GB leak on prod until the disk filled, 2026-10-11).
remove_backup_path() {
    local target="$1"
    rm -rf "$target" 2>/dev/null
    if [ -e "$target" ] && command -v docker >/dev/null 2>&1; then
        local parent base
        parent=$(dirname "$target"); base=$(basename "$target")
        docker run --rm -v "$parent":/b alpine rm -rf "/b/$base" >/dev/null 2>&1
    fi
    [ ! -e "$target" ]
}

reap_abandoned_runs() {
    info "Reaping abandoned run directories (no archive, older than $RETENTION_DAYS days)..."
    local reaped=0 reap_failed=0
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        local base
        base=$(basename "$dir")
        # A dir WITH an archive is a completed run; leave it to retention.
        [ -f "${BACKUP_ROOT}/${base}.tar.gz" ] && continue
        if remove_backup_path "$dir"; then reaped=$((reaped + 1)); else reap_failed=$((reap_failed + 1)); fi
    done < <(find "$BACKUP_ROOT" -maxdepth 1 -type d -name '20*' -mtime +$RETENTION_DAYS 2>/dev/null)
    if [ "$reaped" -gt 0 ]; then
        success "Reaped $reaped abandoned run directory(ies)"
    else
        info "No abandoned run directories to reap"
    fi
    if [ "$reap_failed" -gt 0 ]; then
        error "Could NOT reap $reap_failed abandoned run directory(ies) under $BACKUP_ROOT: disk will keep filling"
    fi
}

cleanup_old_backups() {
    info "Cleaning up backups older than $RETENTION_DAYS days..."
    local removed=0 failed=0
    while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        if remove_backup_path "$dir"; then removed=$((removed + 1)); else failed=$((failed + 1)); fi
    done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +$RETENTION_DAYS 2>/dev/null)
    # Delete each aged archive WITH its .sha256 sidecar: a sidecar left behind
    # is an integrity record for an archive that no longer exists, which reads
    # as "we have a verified backup" when we do not.
    find "$BACKUP_ROOT" -maxdepth 1 -name '*.tar.gz' -mtime +$RETENTION_DAYS -exec rm -f {} "{}.sha256" \; 2>/dev/null || true
    if [ "$failed" -gt 0 ]; then
        error "Retention could NOT delete $failed backup dir(s) older than $RETENTION_DAYS days under $BACKUP_ROOT (removed $removed): disk will keep filling"
    else
        success "Cleanup complete (removed $removed old backup dir(s))"
    fi
}

compress_backup() {
    info "Compressing backup..."
    local archive="${BACKUP_ROOT}/${TIMESTAMP}.tar.gz"
    tar -czf "$archive" -C "$BACKUP_ROOT" "$TIMESTAMP"
    # Staging cleanup must never fail the backup: some staged data is docker-cp'd
    # from containers running as other uids (e.g. qdrant as root), so this uid
    # can't rm those files. The archive is already built above — a cleanup rm
    # failure is not a backup failure. (Leaves foreign-owned staging behind; a
    # proper fix — chown-before-rm via a privileged helper, or streaming qdrant
    # straight into tar — is BR-stream work. See docs/PHASE4_DEMO_FINDINGS.md.)
    if ! remove_backup_path "$BACKUP_DIR"; then
        error "Could NOT remove staging dir $BACKUP_DIR after archiving: disk will keep filling"
    fi

    # Integrity sidecar (G2d): restore-quox.sh verifies the archive against this
    # BEFORE extracting, and refuses to run without it unless --no-verify is
    # passed. Written with the bare filename (cwd = BACKUP_ROOT) so a plain
    # `sha256sum -c 20260917_020000.tar.gz.sha256` works after a copy elsewhere.
    if (cd "$BACKUP_ROOT" && sha256sum "${TIMESTAMP}.tar.gz" > "${TIMESTAMP}.tar.gz.sha256"); then
        info "Wrote checksum sidecar: ${archive}.sha256"
    else
        warn "Could not write checksum sidecar for $archive — restore will need --no-verify"
    fi

    BACKUP_DIR="$archive"
    success "Created archive: $archive ($(du -h "$archive" | cut -f1))"
}

# ============================================================================
# MAIN BACKUP
# ============================================================================

# preflight_free_space (2026-10-09): never START a backup the disk cannot hold.
# A run writes the raw copy AND the compressed archive before the raw copy is
# removed, so it needs roughly 2.5x the last archive. On 2026-10-08/09 failed
# runs and a full root disk took down transcript writes and a CLI config; a run
# that refuses up front leaves the box usable and says exactly why.
preflight_free_space() {
    local last_bytes need_bytes avail_bytes min_bytes
    last_bytes=$(find "$BACKUP_ROOT" -maxdepth 1 -name '*.tar.gz' -printf '%T@ %s\n' 2>/dev/null | sort -n | tail -1 | awk '{print $2}')
    min_bytes=$(( ${BACKUP_MIN_FREE_GB:-20} * 1073741824 ))
    need_bytes=$(( ${last_bytes:-0} * 5 / 2 ))
    [ "$need_bytes" -lt "$min_bytes" ] && need_bytes=$min_bytes
    avail_bytes=$(( $(df -Pk "$BACKUP_ROOT" | awk 'NR==2{print $4}') * 1024 ))
    if [ "$avail_bytes" -lt "$need_bytes" ]; then
        echo "[FAIL] Not starting backup: $((avail_bytes / 1073741824))G free on $(df -P "$BACKUP_ROOT" | awk 'NR==2{print $6}'), need about $((need_bytes / 1073741824))G (2.5x last archive, min ${BACKUP_MIN_FREE_GB:-20}G). Free space or move BACKUP_ROOT to a larger disk." >&2
        exit 3
    fi
    info "Free space OK: $((avail_bytes / 1073741824))G free, need about $((need_bytes / 1073741824))G"
}

run_backup() {
    local mode=${1:-full}

    info "Starting $mode backup (D.1b — 26 components)..."

    # Reap FIRST, not last. cleanup_old_backups sits at the end of this
    # function, which is exactly the part a failing run never reaches, so
    # abandoned directories accumulated until they held 60GB. Reclaiming space
    # before writing more of it is also the right order on a box under disk
    # pressure.
    reap_abandoned_runs
    preflight_free_space

    mkdir -p "$BACKUP_DIR"

    # ---- Core databases ----
    backup_databases

    # Path roots — env-overridable so /opt/quoxcore (and other non-/opt/quoxcore
    # layouts) back up their real dirs instead of silently skipping. repos_root
    # holds sibling repos; dash_dir is this dashboard checkout (== QUOX_COMPOSE_DIR).
    local repos_root="${QUOX_REPOS_ROOT:-/opt/quoxcore}"
    local dash_dir="${QUOX_COMPOSE_DIR:-/opt/quoxcore}"

    # ---- Memory system (directory rsync) ----
    backup_component "quox-memory" "${repos_root}/quox-memory"

    # ---- User uploads ----
    backup_component "user-uploads" "${QUOX_UPLOADS_DIR:-${repos_root}/uploads}"

    # ---- Organization logos (in auth container uploads dir) ----
    local auth_ctr
    auth_ctr=$(get_container "auth") && \
        backup_docker_path "org-logos" "$auth_ctr" "/var/lib/quox/uploads/" "auth" || {
        warn "Skipping org-logos — auth container not found"
        record_store "org-logos" "dir" "org-logos/uploads" "skipped" "\"service\":\"auth\",\"path\":\"/var/lib/quox/uploads/\""
    }

    # ---- File objects (content-addressed blobs; NotesQ attachments etc.) ----
    # AUTH_FILES_ROOT default. Rows live in auth.db; blobs live only here.
    local auth_files_ctr
    auth_files_ctr=$(get_container "auth") && \
        backup_docker_path "file_objects" "$auth_files_ctr" "/var/lib/quox/file-objects/" "auth" || {
        warn "Skipping file_objects — auth container not found"
        record_store "file_objects" "dir" "file_objects/file-objects" "skipped" "\"service\":\"auth\",\"path\":\"/var/lib/quox/file-objects/\""
    }

    # ---- AI-generated images (from collector container) ----
    local collector_imgs_ctr
    collector_imgs_ctr=$(get_container "collector") && \
        backup_docker_path "collector-images" "$collector_imgs_ctr" "/var/lib/quox/images/" "collector" || {
        warn "Skipping collector-images — collector container not found or no images"
        record_store "collector-images" "dir" "collector-images/images" "skipped" "\"service\":\"collector\",\"path\":\"/var/lib/quox/images/\""
    }

    # ---- QuoxFlow evidence (docker_cp from quoxflow container) ----
    local flow_ctr
    # The real path is the container's EVIDENCE_PATH (docker-compose sets
    # /var/lib/quoxflow/evidence); /app/evidence/ never existed. Read the env
    # from the container, fall back to the compose default.
    flow_ctr=$(get_container "quoxflow") || flow_ctr=""
    local flow_evidence_path=""
    if [ -n "$flow_ctr" ]; then
        flow_evidence_path=$(docker exec "$flow_ctr" printenv EVIDENCE_PATH 2>/dev/null || true)
    fi
    flow_evidence_path=${flow_evidence_path:-/var/lib/quoxflow/evidence}
    flow_evidence_path="${flow_evidence_path%/}/"
    [ -n "$flow_ctr" ] && \
        backup_docker_path "quoxflow-evidence" "$flow_ctr" "$flow_evidence_path" "quoxflow" || {
        warn "Skipping quoxflow-evidence — quoxflow container not found"
        record_store "quoxflow-evidence" "dir" "quoxflow-evidence/$(basename "${flow_evidence_path%/}")" "skipped" "\"service\":\"quoxflow\",\"path\":\"${flow_evidence_path}\""
    }

    # ---- QuoxAgent playbooks & configs (fixed paths) ----
    backup_component "quoxagent-playbooks" "${repos_root}/quoxagent/playbooks"
    backup_component "quoxagent-configs" "${repos_root}/quoxagent/configs"

    # ---- QuoxSEO URL warehouse (org-scoped SQLite, witnessed SEO history) ----
    backup_component "quox-seo-data" "${repos_root}/quox-seo/data"

    # ---- Dashboard config & data ----
    backup_component "dashboard-data" "${dash_dir}/data" info
    backup_component "dashboard-public" "${dash_dir}/public"
    backup_component "plugin-configs" "${dash_dir}/src/config/plugins"
    backup_component "agent-definitions" "${dash_dir}/src/config/entities/assistants"
    backup_component "tool-definitions" "${dash_dir}/src/config/entities/tools"

    # ---- Environment secrets (copy) ----
    local env_dest="${BACKUP_DIR}/env-secrets"
    mkdir -p "$env_dest"
    for envf in \
        "${dash_dir}/services/auth/.env" \
        "${dash_dir}/.env" \
        "${dash_dir}/.env.local"; do
        if [ -f "$envf" ]; then
            cp "$envf" "$env_dest/" 2>/dev/null || true
        fi
    done
    success "Backed up environment secrets"

    # ---- Host configs (copy) ----
    if [ -f "${dash_dir}/src/config/hosts.js" ]; then
        mkdir -p "${BACKUP_DIR}/host-configs"
        cp "${dash_dir}/src/config/hosts.js" "${BACKUP_DIR}/host-configs/" 2>/dev/null && \
            success "Backed up host configs" || \
            warn "Skipping host configs — copy failed"
    fi

    # ---- SSL certificates ----
    local ssl_dest="${BACKUP_DIR}/ssl-certs"
    mkdir -p "$ssl_dest"
    [ -d "/etc/ssl/quox" ] && cp -r /etc/ssl/quox/* "$ssl_dest/" 2>/dev/null || true
    [ -d "${dash_dir}/certs" ] && cp -r "${dash_dir}"/certs/* "$ssl_dest/" 2>/dev/null || true
    if [ "$(ls -A "$ssl_dest" 2>/dev/null)" ]; then
        success "Backed up SSL certificates"
    else
        warn "No SSL certificates found"
        rmdir "$ssl_dest" 2>/dev/null || true
    fi

    # ---- SSH keys ----
    local ssh_dest="${BACKUP_DIR}/ssh-keys"
    mkdir -p "$ssh_dest"
    local quox_home="${QUOX_HOME:-/opt/quoxcore}"
    if [ -d "${quox_home}/.ssh" ] && [ -r "${quox_home}/.ssh" ]; then
        # Copy keys but exclude known_hosts and sockets
        rsync -a --exclude='known_hosts*' --exclude='*.sock' --exclude='sockets/' \
              "${quox_home}/.ssh/" "$ssh_dest/" 2>/dev/null && \
            success "Backed up SSH keys" || \
            warn "Skipping SSH keys — permission denied (expected inside container)"
    else
        warn "Skipping SSH keys — not found or not readable"
    fi

    # ---- Bastion fleet registry ----
    local bastion_dest="${BACKUP_DIR}/bastion-fleet"
    mkdir -p "$bastion_dest"
    [ -f "${repos_root}/QuoxBastion/data/fleet.json" ] && \
        cp "${repos_root}/QuoxBastion/data/fleet.json" "$bastion_dest/" 2>/dev/null || true
    [ -d "${repos_root}/QuoxBastion/data/hosts" ] && \
        cp -r "${repos_root}/QuoxBastion/data/hosts" "$bastion_dest/" 2>/dev/null || true
    if [ "$(ls -A "$bastion_dest" 2>/dev/null)" ]; then
        success "Backed up bastion fleet registry"
    else
        warn "No bastion fleet data found"
        rmdir "$bastion_dest" 2>/dev/null || true
    fi

    # ---- Bastion audit logs (rsync from bastion if reachable) ----
    local bastion_audit_dest="${BACKUP_DIR}/bastion-audit-logs"
    mkdir -p "$bastion_audit_dest"
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ubuntu@192.0.2.247 true 2>/dev/null; then
        rsync -a --timeout=30 ubuntu@192.0.2.247:/var/log/quoxbastion/ "$bastion_audit_dest/" 2>/dev/null && \
            success "Backed up bastion audit logs" || \
            warn "Bastion audit log rsync failed"
    else
        warn "Skipping bastion audit logs — bastion unreachable"
    fi

    # ---- Claude config ----
    backup_component "claude-config" "${quox_home}/.claude.json"
    backup_component "claude-plans" "${quox_home}/.claude/plans"
    backup_component "claude-settings" "${quox_home}/.claude/settings.json"

    # ---- Full backup includes git repos ----
    if [ "$mode" == "full" ]; then
        backup_git_repos
    fi

    # Create manifest and compress
    create_manifest
    compress_backup

    # Cleanup old backups
    cleanup_old_backups

    echo ""
    if [ "$DEGRADED" = true ]; then
        warn "Backup is DEGRADED: required components NOT in this archive: ${SKIPPED_REQUIRED[*]}"
        local r
        for r in "${DEGRADED_REASONS[@]}"; do warn "  - $r"; done
        # Machine-readable line for backups.js / backupScheduler.js.
        echo "DEGRADED: skipped_required=$(IFS=,; echo "${SKIPPED_REQUIRED[*]}")"
        echo ""
        return $EXIT_DEGRADED
    fi
    success "Backup complete: $BACKUP_DIR"
    echo ""
}

# Parse arguments
case "${1:-full}" in
    --list|-l)
        list_backups
        ;;
    --quick|-q)
        run_backup "quick"
        ;;
    --full|-f|*)
        run_backup "full"
        ;;
esac

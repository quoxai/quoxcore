#!/bin/bash
#
# Quox System Restore — G2d
#
# The sibling of backup-quox.sh: rebuilds an instance from an archive that
# script produced. Everything here is shaped by one rule:
#
#   A SILENT PARTIAL RESTORE IS WORSE THAN A LOUD FAILURE.
#
# A backup that half-restores looks like a working instance and is trusted as
# one, right up until the missing rows matter. So: dry-run is the default, the
# archive is checksum-verified before a byte of it is trusted, every store the
# manifest claims must be present before anything is touched, the live target
# is snapshotted aside before it is overwritten, and the first store that fails
# stops the run with an explicit statement of what did and did not land.
#
# Usage:
#   restore-quox.sh --archive <path> [--dry-run] [--execute] [--stores a,b,c]
#                   [--container-prefix <p>] [--backup-root <dir>]
#                   [--no-verify] [--list]
#
#   --dry-run            plan and verify only (DEFAULT — no flag needed)
#   --execute            actually restore; required for any mutation
#   --stores a,b,c       restore only these manifest store names
#   --container-prefix   target stack prefix (default: quox)
#   --backup-root        where archives live and where scratch is written
#   --no-verify          proceed without an archive checksum sidecar (LOUD)
#   --list               print the archive's manifest stores and exit
#
# Requires manifest schema_version 1 (backup-quox.sh 2026-09-17 or later).
# Archives older than that predate the restore contract and are refused rather
# than guessed at.
#

set -euo pipefail

# ============================================================================
# DEFAULTS / ARGS
# ============================================================================

ARCHIVE=""
BACKUP_ROOT="${BACKUP_ROOT:-/opt/quoxcore/backups}"
CONTAINER_PREFIX="${CONTAINER_PREFIX:-quox}"
COMPOSE_DIR="${QUOX_COMPOSE_DIR:-/opt/quoxcore}"
HELPER_IMAGE="${RESTORE_HELPER_IMAGE:-alpine}"
WAIT_TIMEOUT="${RESTORE_WAIT_TIMEOUT:-120}"

MODE="dry-run"
DRY_SET=0
EXEC_SET=0
LIST_ONLY=0
VERIFY=1
STORES_FILTER=""

usage() {
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --archive)          ARCHIVE="${2:-}"; shift 2 ;;
        --archive=*)        ARCHIVE="${1#*=}"; shift ;;
        --stores)           STORES_FILTER="${2:-}"; shift 2 ;;
        --stores=*)         STORES_FILTER="${1#*=}"; shift ;;
        --container-prefix) CONTAINER_PREFIX="${2:-}"; shift 2 ;;
        --container-prefix=*) CONTAINER_PREFIX="${1#*=}"; shift ;;
        --backup-root)      BACKUP_ROOT="${2:-}"; shift 2 ;;
        --backup-root=*)    BACKUP_ROOT="${1#*=}"; shift ;;
        --dry-run)          DRY_SET=1; shift ;;
        --execute)          EXEC_SET=1; shift ;;
        --no-verify)        VERIFY=0; shift ;;
        --list|-l)          LIST_ONLY=1; shift ;;
        -h|--help)          usage 0 ;;
        *)
            echo "restore-quox: unknown argument: $1" >&2
            usage 2
            ;;
    esac
done

if [ "$DRY_SET" = 1 ] && [ "$EXEC_SET" = 1 ]; then
    echo "restore-quox: --dry-run and --execute are mutually exclusive. Pick one." >&2
    exit 2
fi
[ "$EXEC_SET" = 1 ] && MODE="execute"

if [ -z "$ARCHIVE" ]; then
    echo "restore-quox: --archive <path> is required." >&2
    usage 2
fi

RESTORE_ID="$(date +%Y%m%d_%H%M%S)_$$"
LOG_FILE="/dev/null"

# ============================================================================
# LOGGING
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    local level=$1
    shift
    echo -e "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" | tee -a "$LOG_FILE"
}
info()    { log "INFO" "$*"; }
warn()    { log "WARN" "${YELLOW}$*${NC}"; }
error()   { log "ERROR" "${RED}$*${NC}"; }
success() { log "OK" "${GREEN}$*${NC}"; }
plain()   { echo -e "$*" | tee -a "$LOG_FILE"; }

die() {
    error "$*"
    plain "RESTORE FAILED"
    exit 1
}

# ============================================================================
# JSON ACCESS
# ============================================================================

JSON_TOOL=""
if command -v python3 >/dev/null 2>&1; then
    JSON_TOOL="python3"
elif command -v jq >/dev/null 2>&1; then
    JSON_TOOL="jq"
fi

PY_SRC='
import json, sys
mode = sys.argv[1]
try:
    m = json.load(open(sys.argv[2]))
except Exception as e:
    sys.stderr.write("manifest parse error: %s\n" % e)
    sys.exit(3)
def s(v):
    if v is True: return "true"
    if v is False: return "false"
    if v is None: return ""
    return str(v)
if mode == "schema":
    print(s(m.get("schema_version", "")))
elif mode == "has_stores":
    print("yes" if isinstance(m.get("stores"), list) else "no")
elif mode == "field":
    print(s(m.get(sys.argv[3], "")))
elif mode == "count":
    comp = m.get("components") or {}
    print(s((comp.get(sys.argv[3]) or {}).get(sys.argv[4], "")))
elif mode == "stores":
    for st in (m.get("stores") or []):
        row = [s(st.get(k, "")) for k in
               ("name","kind","file","status","sha256","size_bytes",
                "service","path","database","volume","verified")]
        # Unit separator, NOT tab: bash treats tab as IFS whitespace and
        # collapses runs of it, so a store with an empty sha256 would shift
        # every later column left and silently mis-target the restore.
        print("\x1f".join(x.replace("\x1f", " ") for x in row))
else:
    sys.exit(4)
'

json_q() {
    # json_q <mode> <manifest> [args...]
    local mode=$1 mf=$2
    shift 2
    case "$JSON_TOOL" in
        python3)
            python3 -c "$PY_SRC" "$mode" "$mf" "$@"
            ;;
        jq)
            case "$mode" in
                schema)     jq -r '.schema_version // ""' "$mf" ;;
                has_stores) jq -r 'if (.stores | type) == "array" then "yes" else "no" end' "$mf" ;;
                field)      jq -r --arg k "$1" '.[$k] // ""' "$mf" ;;
                count)      jq -r --arg c "$1" --arg f "$2" '.components[$c][$f] // ""' "$mf" ;;
                stores)     jq -r '.stores[] | [ (.name//""), (.kind//""), (.file//""), (.status//""), (.sha256//""), (.size_bytes//0), (.service//""), (.path//""), (.database//""), (.volume//""), (if .verified == null then "" else (.verified|tostring) end) ] | map(tostring) | join("\u001f")' "$mf" ;;
                *)          return 4 ;;
            esac
            ;;
        *)
            echo "restore-quox: need python3 or jq to read manifest.json" >&2
            return 5
            ;;
    esac
}

# ============================================================================
# --list (read-only, no lock, no extraction of payload)
# ============================================================================

read_manifest_from_archive() {
    # Pulls just manifest.json out of the tarball. Works for both the
    # <timestamp>/manifest.json layout backup-quox.sh writes and a flat one.
    local out=$1
    tar -xzOf "$ARCHIVE" --wildcards '*/manifest.json' > "$out" 2>/dev/null || true
    [ -s "$out" ] && return 0
    tar -xzOf "$ARCHIVE" manifest.json > "$out" 2>/dev/null || true
    [ -s "$out" ] && return 0
    return 1
}

print_store_table() {
    # print_store_table <manifest>
    local mf=$1
    local name kind file status sha size service path database volume verified
    printf '%-24s %-9s %-9s %12s  %s\n' "STORE" "KIND" "STATUS" "SIZE" "FILE"
    printf '%s\n' "--------------------------------------------------------------------------------"
    while IFS=$'\x1f' read -r name kind file status sha size service path database volume verified; do
        [ -n "$name" ] || continue
        printf '%-24s %-9s %-9s %12s  %s\n' "$name" "$kind" "$status" "${size:-0}" "$file"
    done < <(json_q stores "$mf")
    return 0
}

if [ "$LIST_ONLY" = 1 ]; then
    [ -f "$ARCHIVE" ] || { echo "restore-quox: archive not found: $ARCHIVE" >&2; exit 1; }
    tmp_manifest=$(mktemp "${TMPDIR:-/tmp}/quox-restore-manifest.XXXXXX" 2>/dev/null) \
        || tmp_manifest="${BACKUP_ROOT}/.restore-manifest-$$.json"
    trap 'rm -f "$tmp_manifest"' EXIT
    read_manifest_from_archive "$tmp_manifest" \
        || { echo "restore-quox: no manifest.json inside $ARCHIVE" >&2; exit 1; }
    schema=$(json_q schema "$tmp_manifest" || true)
    echo "Archive: $ARCHIVE"
    echo "Created: $(json_q field "$tmp_manifest" created || true)"
    echo "Source instance: $(json_q field "$tmp_manifest" source_instance || true)"
    echo "Backup container prefix: $(json_q field "$tmp_manifest" container_prefix || true)"
    echo "Manifest schema_version: ${schema:-<none>}"
    echo ""
    if [ "$(json_q has_stores "$tmp_manifest" || echo no)" != "yes" ]; then
        echo "This archive has no stores[] ledger: it predates the restore contract" >&2
        echo "and restore-quox.sh will refuse to restore it." >&2
        exit 1
    fi
    print_store_table "$tmp_manifest"
    exit 0
fi

# ============================================================================
# SETUP: log file + single-run lock
# ============================================================================

mkdir -p "$BACKUP_ROOT"
LOG_FILE="${BACKUP_ROOT}/restore-${RESTORE_ID}.log"
: > "$LOG_FILE"

# SAME lock file backup-quox.sh uses. A backup running mid-restore would
# capture a half-restored instance and archive it as if it were real state;
# a restore running mid-backup would rewrite the files being read. Neither may
# ever happen, so the two share one lock.
LOCK_FILE="${BACKUP_ROOT}/.backup-quox.lock"
exec 9<>"$LOCK_FILE"
if ! flock -n 9; then
    holder=$(head -n1 "$LOCK_FILE" 2>/dev/null || true)
    error "another backup or restore is running (pid ${holder:-unknown}); refusing to start."
    plain "RESTORE FAILED"
    exit 1
fi
: >"$LOCK_FILE"
echo $$ >&9

umask 077

plain "Restore id: ${RESTORE_ID}"
info "Mode: ${MODE}"
info "Archive: ${ARCHIVE}"
info "Container prefix: ${CONTAINER_PREFIX}"
info "Backup root: ${BACKUP_ROOT}"
info "Log: ${LOG_FILE}"

EXTRACT_DIR="${BACKUP_ROOT}/.restore-${RESTORE_ID}"
SNAP_DIR="${BACKUP_ROOT}/.pre-restore-${RESTORE_ID}"
RUN_DIR=""
MANIFEST=""

# ============================================================================
# PRE-FLIGHT
# ============================================================================

verify_archive_checksum() {
    local sidecar="${ARCHIVE}.sha256"
    if [ -f "$sidecar" ]; then
        local expected actual
        expected=$(awk 'NR==1 {print $1}' "$sidecar" 2>/dev/null || true)
        [ -n "$expected" ] || die "checksum sidecar $sidecar is empty or unreadable"
        info "Verifying archive against $sidecar ..."
        actual=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
        if [ "${expected,,}" != "${actual,,}" ]; then
            error "ARCHIVE CHECKSUM MISMATCH — this archive is not the one that was written."
            error "  expected: $expected"
            error "  actual:   $actual"
            die "refusing to restore from a corrupt or substituted archive"
        fi
        success "Archive checksum verified ($actual)"
        return 0
    fi

    if [ "$VERIFY" = 1 ]; then
        error "No checksum sidecar found at ${sidecar}."
        error "An unverified archive may be truncated, corrupt or substituted, and a"
        error "restore from one produces an instance nobody can vouch for."
        die "refusing to restore without verification (pass --no-verify to override deliberately)"
    fi

    warn "################################################################"
    warn "# --no-verify: restoring from an archive with NO checksum.     #"
    warn "# Nothing here proves these bytes are the bytes that were      #"
    warn "# backed up. Per-store checksums below are the only integrity  #"
    warn "# evidence this run will have.                                 #"
    warn "################################################################"
}

extract_archive() {
    info "Extracting archive to ${EXTRACT_DIR} ..."
    mkdir -p "$EXTRACT_DIR"
    tar -xzf "$ARCHIVE" -C "$EXTRACT_DIR" || die "extraction failed for $ARCHIVE"

    if [ -f "${EXTRACT_DIR}/manifest.json" ]; then
        RUN_DIR="$EXTRACT_DIR"
    else
        local dirs=()
        while IFS= read -r d; do dirs+=("$d"); done < <(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d)
        [ "${#dirs[@]}" -eq 1 ] || die "unexpected archive layout: expected one top-level directory, found ${#dirs[@]}"
        RUN_DIR="${dirs[0]}"
    fi

    MANIFEST="${RUN_DIR}/manifest.json"
    [ -f "$MANIFEST" ] || die "archive contains no manifest.json (looked in ${RUN_DIR})"
    success "Extracted to ${RUN_DIR}"
}

# Plan arrays, index-aligned.
P_NAME=(); P_KIND=(); P_FILE=(); P_STATUS=(); P_SHA=(); P_SIZE=()
P_SERVICE=(); P_PATH=(); P_DB=(); P_VOL=(); P_VERIFIED=()
P_SELECTED=(); P_RESULT=(); P_NOTE=()

store_index() {
    local want=$1 i
    for i in "${!P_NAME[@]}"; do
        [ "${P_NAME[$i]}" = "$want" ] && { echo "$i"; return 0; }
    done
    return 1
}

load_manifest() {
    local schema has
    schema=$(json_q schema "$MANIFEST" 2>/dev/null) || die "manifest.json is not valid JSON"
    has=$(json_q has_stores "$MANIFEST" 2>/dev/null || echo no)

    if [ -z "$schema" ] || [ "$has" != "yes" ]; then
        error "This archive has no schema_version / stores[] ledger."
        error "It predates the restore contract (backup-quox.sh, 2026-09-17), so there"
        error "is no record of which stores it actually captured, which ones were"
        error "skipped, or where they belong. Restoring it would be guesswork."
        die "refusing to restore a pre-contract archive"
    fi
    if [ "$schema" != "1" ]; then
        die "unsupported manifest schema_version: ${schema} (this restore engine speaks version 1)"
    fi
    info "Manifest schema_version 1, written by $(json_q field "$MANIFEST" source_instance || true) at $(json_q field "$MANIFEST" created || true)"

    local name kind file status sha size service path database volume verified
    while IFS=$'\x1f' read -r name kind file status sha size service path database volume verified; do
        [ -n "$name" ] || continue
        P_NAME+=("$name");         P_KIND+=("$kind")
        P_FILE+=("$file");         P_STATUS+=("$status")
        P_SHA+=("$sha");           P_SIZE+=("${size:-0}")
        P_SERVICE+=("$service");   P_PATH+=("$path")
        P_DB+=("$database");       P_VOL+=("$volume")
        P_VERIFIED+=("$verified")
        P_SELECTED+=(0); P_RESULT+=("pending"); P_NOTE+=("")
    done < <(json_q stores "$MANIFEST")

    [ "${#P_NAME[@]}" -gt 0 ] || die "manifest stores[] is empty: this archive captured nothing"
    info "Manifest lists ${#P_NAME[@]} store(s)"
    return 0
}

select_stores() {
    local i want idx
    if [ -n "$STORES_FILTER" ]; then
        local requested missing=()
        IFS=',' read -r -a requested <<< "$STORES_FILTER"
        for want in "${requested[@]}"; do
            want="$(echo "$want" | tr -d '[:space:]')"
            [ -n "$want" ] || continue
            if idx=$(store_index "$want"); then
                if [ "${P_STATUS[$idx]}" != "ok" ]; then
                    die "requested store '${want}' was not captured by this backup (status=${P_STATUS[$idx]}); there is nothing to restore from"
                fi
                P_SELECTED[$idx]=1
            else
                missing+=("$want")
            fi
        done
        if [ "${#missing[@]}" -gt 0 ]; then
            die "requested store(s) not present in this archive's manifest: ${missing[*]}"
        fi
    else
        for i in "${!P_NAME[@]}"; do
            [ "${P_STATUS[$i]}" = "ok" ] && P_SELECTED[$i]=1
        done
    fi

    local n=0
    for i in "${!P_NAME[@]}"; do
        if [ "${P_SELECTED[$i]}" = "1" ]; then
            n=$((n + 1))
        else
            P_RESULT[$i]="not-selected"
            P_NOTE[$i]="manifest status=${P_STATUS[$i]}"
        fi
    done
    [ "$n" -gt 0 ] || die "no restorable stores selected (every store in this archive is skipped or failed)"
    info "Selected ${n} store(s) for restore"
    return 0
}

check_completeness() {
    # Every store the manifest says it captured must actually be in the
    # extraction. A manifest that promises a store the tarball does not hold is
    # the exact silent-partial shape this engine exists to refuse.
    local i missing=()
    for i in "${!P_NAME[@]}"; do
        [ "${P_STATUS[$i]}" = "ok" ] || continue
        [ -e "${RUN_DIR}/${P_FILE[$i]}" ] || missing+=("${P_NAME[$i]} (${P_FILE[$i]})")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        error "Archive is INCOMPLETE. The manifest claims these stores were captured,"
        error "but their files are not in the archive:"
        local m
        for m in "${missing[@]}"; do error "  - $m"; done
        die "refusing to restore from an incomplete archive"
    fi
    success "Completeness check passed: every 'ok' store in the manifest is present"
    return 0
}

# ============================================================================
# TARGET RESOLUTION
# ============================================================================

container_project() {
    # The compose project a container belongs to (empty if none / not found).
    docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$1" 2>/dev/null
}

TARGET_PROJECT_CACHE=""
TARGET_PROJECT_RESOLVED=0
target_compose_project() {
    # The compose project of the stack we are restoring INTO, derived from any
    # container carrying the --container-prefix. Cached. Empty if none exists
    # (e.g. a fresh stack whose containers are not created yet), in which case
    # only the exact prefixed name is trusted and the looser fallbacks refuse.
    [ "$TARGET_PROJECT_RESOLVED" = 1 ] && { echo "$TARGET_PROJECT_CACHE"; return 0; }
    TARGET_PROJECT_RESOLVED=1
    local id=""
    [ -n "$CONTAINER_PREFIX" ] && id=$(docker ps -aq --filter "name=^/${CONTAINER_PREFIX}-" 2>/dev/null | head -1)
    [ -n "$id" ] && TARGET_PROJECT_CACHE=$(container_project "$id")
    echo "$TARGET_PROJECT_CACHE"
}

resolve_container() {
    # resolve_container <service> — matches STOPPED containers too, because a
    # restore has to be able to run against a stack that is not up yet.
    #
    # SAFETY: on a host running more than one stack, an unprefixed container
    # name is GLOBAL. A naive bare-name match (or a compose-ps against the wrong
    # COMPOSE_DIR) can resolve to a DIFFERENT stack's container and restore into
    # it. So the two looser paths accept a hit ONLY if it belongs to the target
    # stack's compose project. The exact prefixed name is inherently in-stack.
    local service=$1
    local named="${CONTAINER_PREFIX}-${service}"
    local cid proj tproj
    # 1) Exact prefixed name — by construction this IS the target stack.
    if docker inspect --format '{{.Id}}' "$named" >/dev/null 2>&1; then
        echo "$named"; return 0
    fi
    tproj=$(target_compose_project)
    # 2) Compose service name in COMPOSE_DIR — only if project-matched.
    cid=$(cd "$COMPOSE_DIR" && DOCKER_GID="${DOCKER_GID:-0}" docker compose ps -aq "$service" 2>/dev/null | head -1) || true
    if [ -n "$cid" ]; then
        proj=$(container_project "$cid")
        if [ -n "$tproj" ] && [ "$proj" = "$tproj" ]; then
            echo "$cid"; return 0
        fi
    fi
    # 3) Bare name (qdrant, plugin-spatial and friends run unprefixed in some
    #    deployments) — only if it belongs to the target project.
    if docker inspect --format '{{.Id}}' "$service" >/dev/null 2>&1; then
        proj=$(container_project "$service")
        if [ -n "$tproj" ] && [ "$proj" = "$tproj" ]; then
            echo "$service"; return 0
        fi
        warn "refusing bare container '${service}': not in the target stack (target project '${tproj:-unknown}', that container's project '${proj:-none}'). Prefix it or exclude it with --stores."
    fi
    return 1
}

store_target() {
    # Human-readable target for the plan table.
    local i=$1
    case "${P_KIND[$i]}" in
        volume) echo "volume ${P_VOL[$i]:-${CONTAINER_PREFIX}-qdrant-data}" ;;
        postgres) echo "${CONTAINER_PREFIX}-${P_SERVICE[$i]}:${P_DB[$i]}" ;;
        *) echo "${CONTAINER_PREFIX}-${P_SERVICE[$i]}:${P_PATH[$i]}" ;;
    esac
}

store_action() {
    local i=$1
    case "${P_KIND[$i]}" in
        sqlite)   echo "stop container, docker cp db, clear -wal/-shm, start, quick_check" ;;
        postgres) echo "pg_restore --clean --if-exists --no-owner" ;;
        volume)   echo "stop container, replace volume contents, start" ;;
        dir)      echo "stop container, clear target dir, docker cp contents" ;;
        *)        echo "UNKNOWN KIND — cannot restore" ;;
    esac
}

human_size() {
    local b=${1:-0}
    case "$b" in ''|*[!0-9]*) echo "${b:-0}"; return 0 ;; esac
    if [ "$b" -ge 1073741824 ]; then echo "$((b / 1073741824))G"
    elif [ "$b" -ge 1048576 ]; then echo "$((b / 1048576))M"
    elif [ "$b" -ge 1024 ]; then echo "$((b / 1024))K"
    else echo "${b}B"; fi
}

# ============================================================================
# PER-STORE FILE VERIFICATION (runs in BOTH modes — that is the point of
# dry-run: the checksums are checked before anyone commits to a restore)
# ============================================================================

VERIFY_FAILURES=0

verify_store_files() {
    local i src actual
    for i in "${!P_NAME[@]}"; do
        [ "${P_SELECTED[$i]}" = "1" ] || continue
        src="${RUN_DIR}/${P_FILE[$i]}"

        case "${P_KIND[$i]}" in
            sqlite|postgres)
                if [ ! -f "$src" ]; then
                    P_NOTE[$i]="MISSING FILE"
                    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
                    continue
                fi
                if [ -z "${P_SHA[$i]}" ]; then
                    P_NOTE[$i]="NO CHECKSUM IN MANIFEST"
                    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
                    continue
                fi
                actual=$(sha256sum "$src" | cut -d' ' -f1)
                if [ "$actual" = "${P_SHA[$i]}" ]; then
                    P_NOTE[$i]="sha256 ok"
                    [ "${P_VERIFIED[$i]}" = "false" ] && \
                        P_NOTE[$i]="sha256 ok / CAPTURED UNVERIFIED"
                else
                    P_NOTE[$i]="SHA256 MISMATCH"
                    error "${P_NAME[$i]}: checksum mismatch (manifest ${P_SHA[$i]}, file ${actual})"
                    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
                fi
                ;;
            volume|dir)
                if [ ! -d "$src" ]; then
                    P_NOTE[$i]="MISSING DIRECTORY"
                    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
                    continue
                fi
                local count
                count=$(find "$src" -type f 2>/dev/null | wc -l)
                P_NOTE[$i]="${count} file(s), no tree checksum"
                ;;
            *)
                P_NOTE[$i]="UNKNOWN KIND '${P_KIND[$i]}'"
                VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
                ;;
        esac

        # A sqlite/dir/postgres store MUST have a target container to restore
        # into; a volume can be recreated without one. Resolve it now, in BOTH
        # modes, so a store targeting a container this stack does not have
        # (e.g. spatial_backend_db -> plugin-spatial on a stack with no spatial
        # plugin) fails the DRY RUN instead of aborting mid-execute.
        case "${P_KIND[$i]}" in
            sqlite|dir|postgres)
                if ! resolve_container "${P_SERVICE[$i]}" >/dev/null 2>&1; then
                    P_NOTE[$i]="${P_NOTE[$i]:+${P_NOTE[$i]} / }NO CONTAINER '${CONTAINER_PREFIX}-${P_SERVICE[$i]}'"
                    error "${P_NAME[$i]}: no container for service '${P_SERVICE[$i]}' (prefix ${CONTAINER_PREFIX}) — cannot restore this store here"
                    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
                fi
                ;;
        esac
    done
    return 0
}

print_plan_table() {
    local i size
    plain ""
    printf '%-22s %-9s %-40s %8s  %-28s %s\n' "STORE" "KIND" "TARGET" "SIZE" "VERIFY" "PLANNED ACTION" | tee -a "$LOG_FILE"
    printf '%s\n' "$(printf '%.0s-' {1..150})" | tee -a "$LOG_FILE"
    for i in "${!P_NAME[@]}"; do
        if [ "${P_SELECTED[$i]}" != "1" ]; then
            printf '%-22s %-9s %-40s %8s  %-28s %s\n' \
                "${P_NAME[$i]}" "${P_KIND[$i]}" "-" "-" "-" \
                "SKIP (${P_NOTE[$i]})" | tee -a "$LOG_FILE"
            continue
        fi
        size=$(human_size "${P_SIZE[$i]}")
        printf '%-22s %-9s %-40s %8s  %-28s %s\n' \
            "${P_NAME[$i]}" "${P_KIND[$i]}" "$(store_target "$i")" "$size" \
            "${P_NOTE[$i]}" "$(store_action "$i")" | tee -a "$LOG_FILE"
    done
    plain ""
    return 0
}

# ============================================================================
# EXECUTE HELPERS
# ============================================================================

container_running() {
    docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null | grep -q true
}

WAIT_FAIL_REASON=""

wait_container_up() {
    # Running, and healthy if the image declares a health check. On failure sets
    # WAIT_FAIL_REASON so the caller reports WHY (an unhealthy container fails
    # fast, long before the timeout — reporting "within Ns" then is a lie that
    # sent a real drill chasing a timeout that never happened).
    local ctr=$1 deadline=$((SECONDS + WAIT_TIMEOUT)) state health
    WAIT_FAIL_REASON=""
    while [ "$SECONDS" -lt "$deadline" ]; do
        state=$(docker inspect --format '{{.State.Running}}' "$ctr" 2>/dev/null || echo false)
        if [ "$state" = "true" ]; then
            health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$ctr" 2>/dev/null || echo none)
            case "$health" in
                none|healthy) return 0 ;;
                unhealthy)    WAIT_FAIL_REASON="became unhealthy after $((SECONDS - (deadline - WAIT_TIMEOUT)))s"; return 1 ;;
            esac
        fi
        sleep 2
    done
    WAIT_FAIL_REASON="did not become running/healthy within ${WAIT_TIMEOUT}s"
    return 1
}

helper_in_container() {
    # Run a shell command against a container's own mounts. Works while the
    # container is STOPPED, which docker exec cannot do — and stopped is
    # exactly when -wal/-shm must be cleared and target dirs emptied.
    local ctr=$1 script=$2
    docker run --rm --volumes-from "$ctr" "$HELPER_IMAGE" sh -c "$script"
}

path_exists_in_container() {
    local ctr=$1 path=$2
    helper_in_container "$ctr" "[ -e '$path' ]" >/dev/null 2>&1
}

capture_owner() {
    # Echo "<uid> <gid> <mode>" for a path inside a (possibly STOPPED) container,
    # so a restored file can be given back the ownership and mode the container
    # runtime expects. docker cp preserves the HOST operator's uid (e.g. 1000)
    # and a 0600 mode; a container whose process runs as another uid (auth runs
    # as quox=1001) then cannot open the restored database (SQLITE_CANTOPEN) and
    # crash-loops. We read the ownership BEFORE overwriting: from the existing
    # target if present, else from its parent directory (the data dir is owned
    # by the runtime user), which is the correct owner for a fresh file too.
    local ctr=$1 path=$2 out
    out=$(helper_in_container "$ctr" \
        "if [ -e '$path' ]; then stat -c '%u %g %a' '$path'; else stat -c '%u %g %a' \"\$(dirname '$path')\"; fi" \
        2>/dev/null | tr -d '\r' | head -1)
    # A directory's mode (e.g. 755) is wrong for a db file; the caller decides
    # the mode. We only rely on uid/gid here; mode is advisory.
    echo "$out"
}

apply_owner() {
    # Chown (and optionally chmod) a restored path inside a STOPPED container,
    # via the helper (docker exec cannot reach a stopped container; the helper
    # runs as root over --volumes-from and can). Returns non-zero on failure so
    # the caller can abort rather than start a container onto an unreadable file.
    local ctr=$1 path=$2 uid=$3 gid=$4 mode=$5
    [ -n "$uid" ] && [ -n "$gid" ] || { warn "no owner captured for ${path}; leaving as-is"; return 0; }
    local script="chown -R '${uid}:${gid}' '${path}'"
    [ -n "$mode" ] && script="${script} && chmod '${mode}' '${path}'"
    helper_in_container "$ctr" "$script" >/dev/null 2>&1
}

# ---- snapshots ------------------------------------------------------------

snapshot_store() {
    # Copy the CURRENT live target aside before anything overwrites it. A store
    # that cannot be snapshotted aborts the whole run before the first
    # mutation: the point of a snapshot is that it exists before it is needed.
    local i=$1
    local name="${P_NAME[$i]}" kind="${P_KIND[$i]}" service="${P_SERVICE[$i]}"
    local dest="${SNAP_DIR}/${name}"
    local ctr vol pg_user

    mkdir -p "$dest"

    case "$kind" in
        sqlite|dir)
            ctr=$(resolve_container "$service") || {
                error "${name}: no container found for service '${service}' (prefix ${CONTAINER_PREFIX})"
                return 1
            }
            if ! path_exists_in_container "$ctr" "${P_PATH[$i]}"; then
                info "${name}: nothing live at ${ctr}:${P_PATH[$i]} — fresh target, no snapshot needed"
                echo "absent at snapshot time" > "${dest}/.absent"
                return 0
            fi
            docker cp "${ctr}:${P_PATH[$i]}" "${dest}/" >/dev/null 2>&1 || {
                error "${name}: could not snapshot ${ctr}:${P_PATH[$i]}"
                return 1
            }
            if [ "$kind" = "sqlite" ]; then
                # The -wal is part of the live state; without it the snapshot
                # rolls back to the last checkpoint if it is ever restored.
                docker cp "${ctr}:${P_PATH[$i]}-wal" "${dest}/" >/dev/null 2>&1 || true
                docker cp "${ctr}:${P_PATH[$i]}-shm" "${dest}/" >/dev/null 2>&1 || true
            fi
            ;;
        postgres)
            ctr=$(resolve_container "$service") || {
                error "${name}: no container found for service '${service}'"
                return 1
            }
            if ! container_running "$ctr"; then
                docker start "$ctr" >/dev/null 2>&1 || true
                wait_container_up "$ctr" || { error "${name}: postgres container ${ctr} will not start"; return 1; }
            fi
            pg_user=$(docker exec "$ctr" printenv POSTGRES_USER 2>/dev/null || echo postgres)
            if docker exec "$ctr" pg_dump -U "$pg_user" --format=custom --no-owner "${P_DB[$i]}" > "${dest}/${P_DB[$i]}.pgdump" 2>/dev/null; then
                [ -s "${dest}/${P_DB[$i]}.pgdump" ] || {
                    rm -f "${dest}/${P_DB[$i]}.pgdump"
                    echo "empty or absent at snapshot time" > "${dest}/.absent"
                }
            else
                rm -f "${dest}/${P_DB[$i]}.pgdump"
                info "${name}: no existing '${P_DB[$i]}' database to snapshot — treating as fresh target"
                echo "absent at snapshot time" > "${dest}/.absent"
            fi
            ;;
        volume)
            vol="${P_VOL[$i]:-${CONTAINER_PREFIX}-qdrant-data}"
            if ! docker volume inspect "$vol" >/dev/null 2>&1; then
                info "${name}: volume ${vol} does not exist yet — fresh target, no snapshot needed"
                echo "absent at snapshot time" > "${dest}/.absent"
                return 0
            fi
            docker run --rm -v "${vol}":/q:ro -v "${dest}":/dest "$HELPER_IMAGE" \
                tar -czf "/dest/${name}.tar.gz" -C /q . >/dev/null 2>&1 || {
                error "${name}: could not snapshot volume ${vol}"
                return 1
            }
            ;;
        *)
            error "${name}: unknown kind '${kind}', refusing to snapshot or restore"
            return 1
            ;;
    esac
    success "Snapshotted ${name} -> ${dest}"
    return 0
}

# ---- restore primitives ---------------------------------------------------

restore_sqlite_store() {
    # Container must already be STOPPED by the caller.
    local i=$1 ctr=$2
    local src="${RUN_DIR}/${P_FILE[$i]}" path="${P_PATH[$i]}"

    # Capture the runtime owner BEFORE docker cp overwrites the file (docker cp
    # would otherwise leave it owned by the host operator uid and mode 0600,
    # unreadable by a container running as another user).
    local owner uid gid
    owner=$(capture_owner "$ctr" "$path"); read -r uid gid _ <<< "$owner"

    docker cp "$src" "${ctr}:${path}" || { error "${P_NAME[$i]}: docker cp into ${ctr}:${path} failed"; return 1; }
    # A stale WAL/SHM beside a freshly restored database is how a restore
    # silently reverts part of itself on first open.
    helper_in_container "$ctr" "rm -f '${path}-wal' '${path}-shm'" >/dev/null 2>&1 || {
        error "${P_NAME[$i]}: could not clear ${path}-wal / ${path}-shm"
        return 1
    }
    # Hand the file back to the container's runtime user. 0644: owner writes,
    # group/other read — matches how the engines create their databases.
    apply_owner "$ctr" "$path" "$uid" "$gid" "0644" || {
        error "${P_NAME[$i]}: could not set ownership on ${ctr}:${path} (would crash-loop the container)"
        return 1
    }
    return 0
}

restore_dir_store() {
    # Container must already be STOPPED by the caller. Mirrors the backup
    # direction exactly (backup did docker cp OUT, so this is docker cp IN),
    # and clears the target first so the restore is a replacement and not a
    # merge over whatever the live instance happened to be holding.
    local i=$1 ctr=$2
    local src="${RUN_DIR}/${P_FILE[$i]}" path="${P_PATH[$i]%/}"

    # Capture the runtime owner of the target dir before clearing it, so the
    # docker-cp'd contents can be handed back to the container's user.
    local owner uid gid
    owner=$(capture_owner "$ctr" "$path"); read -r uid gid _ <<< "$owner"

    helper_in_container "$ctr" "rm -rf '${path}' && mkdir -p '${path}'" >/dev/null 2>&1 || {
        error "${P_NAME[$i]}: could not clear ${ctr}:${path}"
        return 1
    }
    docker cp "${src}/." "${ctr}:${path}" || {
        error "${P_NAME[$i]}: docker cp into ${ctr}:${path} failed"
        return 1
    }
    # Recursively hand the restored tree back to the runtime user (docker cp
    # stamps the host operator uid onto every file otherwise). Mode left as the
    # copied files carry it.
    apply_owner "$ctr" "$path" "$uid" "$gid" "" || {
        error "${P_NAME[$i]}: could not set ownership on ${ctr}:${path}"
        return 1
    }
    return 0
}

restore_postgres_store() {
    local i=$1
    local src="${RUN_DIR}/${P_FILE[$i]}" db="${P_DB[$i]}" service="${P_SERVICE[$i]}"
    local ctr pg_user out

    ctr=$(resolve_container "$service") || { error "${P_NAME[$i]}: no container for service '${service}'"; return 1; }
    if ! container_running "$ctr"; then
        info "${P_NAME[$i]}: starting ${ctr} (pg_restore needs a live server)"
        docker start "$ctr" >/dev/null 2>&1 || { error "${P_NAME[$i]}: ${ctr} will not start"; return 1; }
    fi
    wait_container_up "$ctr" || { error "${P_NAME[$i]}: ${ctr} did not come up"; return 1; }
    pg_user=$(docker exec "$ctr" printenv POSTGRES_USER 2>/dev/null || echo postgres)

    if ! out=$(docker exec -i "$ctr" pg_restore -U "$pg_user" -d "$db" --clean --if-exists --no-owner < "$src" 2>&1); then
        error "${P_NAME[$i]}: pg_restore failed"
        plain "$out"
        return 1
    fi
    [ -n "$out" ] && info "${P_NAME[$i]}: pg_restore notices: $(echo "$out" | head -5 | tr '\n' ' ')"
    return 0
}

restore_volume_store() {
    local i=$1
    local src="${RUN_DIR}/${P_FILE[$i]}" service="${P_SERVICE[$i]}"
    local ctr was_running=0 vol=""

    if ctr=$(resolve_container "$service"); then
        # Restore into the DESTINATION stack's real volume, resolved from the
        # target container's /qdrant/storage mount — NOT the manifest's SOURCE
        # volume name (P_VOL), which names the volume on the backed-up box and
        # is usually wrong for the box being rebuilt.
        vol=$(docker inspect "$ctr" \
            --format '{{range .Mounts}}{{if eq .Destination "/qdrant/storage"}}{{.Name}}{{end}}{{end}}' 2>/dev/null)
        if container_running "$ctr"; then
            was_running=1
            info "${P_NAME[$i]}: stopping ${ctr}"
            docker stop "$ctr" >/dev/null 2>&1 || { error "${P_NAME[$i]}: could not stop ${ctr}"; return 1; }
        fi
    else
        ctr=""
        warn "${P_NAME[$i]}: no container found for service '${service}'; restoring the volume anyway"
    fi
    # Fall back to the manifest name / prefix guess only when the target
    # container did not reveal a volume (e.g. no destination container yet).
    [ -z "$vol" ] && vol="${P_VOL[$i]:-${CONTAINER_PREFIX}-qdrant-data}"
    # State the ACTUAL destination volume: the plan-table label shows the
    # archive's recorded (source) name, which is not where this writes.
    info "${P_NAME[$i]}: writing into destination volume ${vol}"

    docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create "$vol" >/dev/null 2>&1 || {
        error "${P_NAME[$i]}: volume ${vol} missing and could not be created"
        return 1
    }

    if ! docker run --rm -v "${vol}":/q -v "$(dirname "$src")":/src:ro "$HELPER_IMAGE" \
        sh -c 'rm -rf /q/..?* /q/.[!.]* /q/* 2>/dev/null; cp -a "/src/$1/." /q/ && [ -n "$(ls -A /q 2>/dev/null)" ]' \
        sh "$(basename "$src")"; then
        error "${P_NAME[$i]}: volume content replacement failed or produced an empty volume"
        return 1
    fi

    if [ -n "$ctr" ] && [ "$was_running" = 1 ]; then
        docker start "$ctr" >/dev/null 2>&1 || { error "${P_NAME[$i]}: ${ctr} did not restart"; return 1; }
        wait_container_up "$ctr" || { error "${P_NAME[$i]}: ${ctr} did not come back up healthy"; return 1; }
    fi
    return 0
}

# ---- post-restore verification -------------------------------------------

sqlite_quick_check() {
    # Returns 0 on 'ok'. Tries the container's own sqlite3 first (the backup
    # used VACUUM INTO through it, so it is normally there); falls back to a
    # host python3 check on a copy pulled back OUT of the container, which
    # still verifies the restored bytes rather than the archive's.
    local ctr=$1 path=$2 out tmp
    if out=$(docker exec "$ctr" sqlite3 "$path" "PRAGMA quick_check" 2>/dev/null); then
        [ "$(echo "$out" | head -1)" = "ok" ] && return 0
        error "quick_check on ${ctr}:${path} returned: $(echo "$out" | head -3 | tr '\n' ' ')"
        return 1
    fi
    command -v python3 >/dev/null 2>&1 || { error "no sqlite3 in ${ctr} and no host python3 to fall back to"; return 1; }
    tmp="${EXTRACT_DIR}/.verify-$(basename "$path")"
    docker cp "${ctr}:${path}" "$tmp" >/dev/null 2>&1 || { error "could not pull ${ctr}:${path} back for verification"; return 1; }
    out=$(python3 -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA quick_check').fetchone()[0])" "$tmp" 2>/dev/null || echo "check failed")
    rm -f "$tmp"
    [ "$out" = "ok" ] && return 0
    error "host quick_check on ${path} returned: ${out}"
    return 1
}

sqlite_count() {
    local ctr=$1 path=$2 table=$3
    docker exec "$ctr" sqlite3 "$path" "SELECT COUNT(*) FROM ${table}" 2>/dev/null || echo ""
}

count_spec() {
    # <store> -> "<table> <manifest component> <manifest field>"
    case "$1" in
        auth_db)          echo "users auth_db users" ;;
        memory_db)        echo "memories memory_db memories" ;;
        tasks_db)         echo "tasks tasks_db tasks" ;;
        collector_aee_db) echo "envelopes aee_db envelopes" ;;
        volt_db)          echo "volt_events volt_db entries" ;;
        ward_db)          echo "ward_entries ward_db receipts" ;;
        *)                echo "" ;;
    esac
}

# ============================================================================
# EXECUTE
# ============================================================================

FAILED_STORE=""

recovery_block() {
    local i restored=() not_restored=()
    for i in "${!P_NAME[@]}"; do
        case "${P_RESULT[$i]}" in
            # 'restored' means the bytes are in place but the group's container
            # had not been restarted yet when the run stopped. It is restored
            # data either way, and an operator must know that.
            ok)       restored+=("${P_NAME[$i]}") ;;
            restored) restored+=("${P_NAME[$i]} [data in place, container not restarted]") ;;
            not-selected) : ;;
            *) [ "${P_SELECTED[$i]}" = "1" ] && not_restored+=("${P_NAME[$i]} (${P_RESULT[$i]}${P_NOTE[$i]:+: ${P_NOTE[$i]}})") ;;
        esac
    done
    plain ""
    error "======================= RECOVERY INFORMATION ======================="
    error "Restore id:        ${RESTORE_ID}"
    error "Failed at store:   ${FAILED_STORE:-unknown}"
    if [ "${#restored[@]}" -gt 0 ]; then
        error "RESTORED (now holding archive data): ${restored[*]}"
    else
        error "RESTORED: none"
    fi
    if [ "${#not_restored[@]}" -gt 0 ]; then
        error "NOT RESTORED (still holding whatever was live): ${not_restored[*]}"
    else
        error "NOT RESTORED: none"
    fi
    error "Pre-restore snapshots of every selected store: ${SNAP_DIR}"
    error "Extracted archive kept for inspection:         ${RUN_DIR}"
    error "Log:                                           ${LOG_FILE}"
    error "This instance is in a MIXED state. Do not put it back into service"
    error "until the listed stores are reconciled by hand from the snapshots."
    error "==================================================================="
}

abort_restore() {
    FAILED_STORE="$1"
    recovery_block
    plain "RESTORE FAILED after ${FAILED_STORE}"
    exit 1
}

group_of() {
    local i=$1
    case "${P_KIND[$i]}" in
        volume)   echo "volume:${P_SERVICE[$i]:-qdrant}" ;;
        postgres) echo "postgres:${P_SERVICE[$i]:-postgres}" ;;
        *)        echo "container:${P_SERVICE[$i]}" ;;
    esac
}

execute_restore() {
    local i g

    # --- Phase 1: snapshot EVERYTHING selected, before touching anything ---
    info "Phase 1/3: pre-restore snapshots -> ${SNAP_DIR}"
    mkdir -p "$SNAP_DIR"
    for i in "${!P_NAME[@]}"; do
        [ "${P_SELECTED[$i]}" = "1" ] || continue
        if ! snapshot_store "$i"; then
            error "Pre-restore snapshot failed for ${P_NAME[$i]}."
            error "NOTHING has been modified — aborting while that is still true."
            plain "RESTORE FAILED"
            exit 1
        fi
    done
    success "All pre-restore snapshots written"

    # --- Phase 2: mutate, grouped by target, consumers stopped first ---
    info "Phase 2/3: restoring stores"

    local groups=() seen existing
    local preferred=("container:auth" "container:memory" "container:tasks" "container:collector" \
                     "container:quoxflow" "container:n8n" "container:plugin-spatial")
    for g in "${preferred[@]}"; do
        for i in "${!P_NAME[@]}"; do
            [ "${P_SELECTED[$i]}" = "1" ] || continue
            [ "$(group_of "$i")" = "$g" ] && { groups+=("$g"); break; }
        done
    done
    for i in "${!P_NAME[@]}"; do
        [ "${P_SELECTED[$i]}" = "1" ] || continue
        g=$(group_of "$i")
        seen=0
        for existing in ${groups[@]+"${groups[@]}"}; do
            [ "$existing" = "$g" ] && { seen=1; break; }
        done
        [ "$seen" = 0 ] && groups+=("$g")
    done

    for g in "${groups[@]}"; do
        case "$g" in
            container:*)  restore_container_group "${g#container:}" ;;
            postgres:*)   restore_postgres_group "${g#postgres:}" ;;
            volume:*)     restore_volume_group "${g#volume:}" ;;
        esac
    done

    # --- Phase 3: verify what landed ---
    info "Phase 3/3: post-restore verification"
    verify_restored_sqlite
    return 0
}

restore_container_group() {
    local service=$1 ctr i was_running=0

    ctr=$(resolve_container "$service") || {
        for i in "${!P_NAME[@]}"; do
            [ "${P_SELECTED[$i]}" = "1" ] && [ "$(group_of "$i")" = "container:${service}" ] && {
                P_RESULT[$i]="failed"; P_NOTE[$i]="no container for service ${service}"
                error "No container for service '${service}' (prefix ${CONTAINER_PREFIX})"
                abort_restore "${P_NAME[$i]}"
            }
        done
        return 0
    }

    if container_running "$ctr"; then
        was_running=1
        info "Stopping ${ctr} before touching its data"
        docker stop "$ctr" >/dev/null 2>&1 || {
            error "Could not stop ${ctr}"
            abort_restore "container ${ctr} (stop)"
        }
    else
        info "${ctr} is already stopped"
    fi

    for i in "${!P_NAME[@]}"; do
        [ "${P_SELECTED[$i]}" = "1" ] || continue
        [ "$(group_of "$i")" = "container:${service}" ] || continue
        info "Restoring ${P_NAME[$i]} -> ${ctr}:${P_PATH[$i]}"
        case "${P_KIND[$i]}" in
            sqlite) restore_sqlite_store "$i" "$ctr" || { P_RESULT[$i]="failed"; abort_restore "${P_NAME[$i]}"; } ;;
            dir)    restore_dir_store    "$i" "$ctr" || { P_RESULT[$i]="failed"; abort_restore "${P_NAME[$i]}"; } ;;
            *)      P_RESULT[$i]="failed"; error "unsupported kind ${P_KIND[$i]} in container group"; abort_restore "${P_NAME[$i]}" ;;
        esac
        P_RESULT[$i]="restored"
        success "Restored ${P_NAME[$i]}"
    done

    # Always start, even if the container was already down when we arrived: the
    # restored database is not proven until quick_check has run against it
    # inside the container, and that needs the container up.
    info "Starting ${ctr}"
    docker start "$ctr" >/dev/null 2>&1 || { error "${ctr} did not start"; abort_restore "container ${ctr} (start)"; }
    wait_container_up "$ctr" || { error "${ctr} ${WAIT_FAIL_REASON} after restore (likely the restored file's ownership or an app-level fault — check: docker logs ${ctr})"; abort_restore "container ${ctr} (health)"; }
    success "${ctr} is up"
    [ "$was_running" = 1 ] || info "${ctr} was down before this restore; it is running now"

    for i in "${!P_NAME[@]}"; do
        [ "${P_RESULT[$i]}" = "restored" ] && [ "$(group_of "$i")" = "container:${service}" ] && P_RESULT[$i]="ok"
    done
    return 0
}

restore_postgres_group() {
    local service=$1 i
    for i in "${!P_NAME[@]}"; do
        [ "${P_SELECTED[$i]}" = "1" ] || continue
        [ "$(group_of "$i")" = "postgres:${service}" ] || continue
        info "Restoring ${P_NAME[$i]} (pg_restore into ${P_DB[$i]})"
        if restore_postgres_store "$i"; then
            P_RESULT[$i]="ok"
            success "Restored ${P_NAME[$i]}"
        else
            P_RESULT[$i]="failed"
            abort_restore "${P_NAME[$i]}"
        fi
    done
    return 0
}

restore_volume_group() {
    local service=$1 i
    for i in "${!P_NAME[@]}"; do
        [ "${P_SELECTED[$i]}" = "1" ] || continue
        [ "$(group_of "$i")" = "volume:${service}" ] || continue
        info "Restoring ${P_NAME[$i]} (volume ${P_VOL[$i]:-${CONTAINER_PREFIX}-qdrant-data})"
        if restore_volume_store "$i"; then
            P_RESULT[$i]="ok"
            success "Restored ${P_NAME[$i]}"
        else
            P_RESULT[$i]="failed"
            abort_restore "${P_NAME[$i]}"
        fi
    done
    return 0
}

verify_restored_sqlite() {
    local i ctr spec table comp field expected actual
    for i in "${!P_NAME[@]}"; do
        [ "${P_RESULT[$i]}" = "ok" ] || continue
        [ "${P_KIND[$i]}" = "sqlite" ] || continue
        ctr=$(resolve_container "${P_SERVICE[$i]}") || { warn "${P_NAME[$i]}: container vanished before verification"; continue; }

        if sqlite_quick_check "$ctr" "${P_PATH[$i]}"; then
            success "${P_NAME[$i]}: quick_check ok"
        else
            P_RESULT[$i]="failed"
            error "${P_NAME[$i]}: RESTORED FILE FAILS INTEGRITY CHECK"
            abort_restore "${P_NAME[$i]} (post-restore quick_check)"
        fi

        spec=$(count_spec "${P_NAME[$i]}")
        [ -n "$spec" ] || continue
        read -r table comp field <<< "$spec"
        expected=$(json_q count "$MANIFEST" "$comp" "$field" 2>/dev/null || echo "")
        actual=$(sqlite_count "$ctr" "${P_PATH[$i]}" "$table")
        if [ -z "$expected" ] || [ -z "$actual" ]; then
            warn "${P_NAME[$i]}: could not compare ${table} counts (manifest='${expected}', live='${actual}')"
        elif [ "$expected" = "$actual" ]; then
            success "${P_NAME[$i]}: ${table} count matches manifest (${actual})"
        else
            warn "${P_NAME[$i]}: ${table} COUNT MISMATCH — manifest says ${expected}, restored database has ${actual}"
            warn "  (the manifest counts the LIVE source at backup time; a hot database that took writes"
            warn "   during capture can differ legitimately, but a large gap means data did not land)"
            P_NOTE[$i]="count ${actual} vs manifest ${expected}"
        fi
    done
    return 0
}

# ============================================================================
# SUMMARY
# ============================================================================

print_summary() {
    local i ok=0 skipped=0 other=0
    plain ""
    plain "=== RESTORE SUMMARY (id ${RESTORE_ID}, mode ${MODE}) ==="
    printf '%-24s %-9s %-14s %s\n' "STORE" "KIND" "RESULT" "NOTE" | tee -a "$LOG_FILE"
    printf '%s\n' "--------------------------------------------------------------------------------" | tee -a "$LOG_FILE"
    for i in "${!P_NAME[@]}"; do
        printf '%-24s %-9s %-14s %s\n' "${P_NAME[$i]}" "${P_KIND[$i]}" "${P_RESULT[$i]}" "${P_NOTE[$i]}" | tee -a "$LOG_FILE"
        case "${P_RESULT[$i]}" in
            ok|would-restore) ok=$((ok + 1)) ;;
            not-selected) skipped=$((skipped + 1)) ;;
            *) other=$((other + 1)) ;;
        esac
    done
    local verb="restored"
    [ "$MODE" = "dry-run" ] && verb="would be restored"
    plain ""
    plain "Stores: ${ok} ${verb}, ${skipped} not selected, ${other} other, ${#P_NAME[@]} total"
    if [ "$MODE" = "execute" ]; then
        plain "Pre-restore snapshots: ${SNAP_DIR}"
    fi
    return 0
}

# ============================================================================
# MAIN
# ============================================================================

verify_archive_checksum
extract_archive
load_manifest
select_stores
check_completeness
verify_store_files
print_plan_table

if [ "$MODE" = "dry-run" ]; then
    for i in "${!P_NAME[@]}"; do
        [ "${P_SELECTED[$i]}" = "1" ] || continue
        case "${P_NOTE[$i]}" in
            *MISMATCH*|*MISSING*|*"NO CHECKSUM"*|*UNKNOWN*) P_RESULT[$i]="verify-failed" ;;
            *) P_RESULT[$i]="would-restore" ;;
        esac
    done
    print_summary
    if [ "$VERIFY_FAILURES" -gt 0 ]; then
        error "${VERIFY_FAILURES} store(s) failed verification — this archive is NOT safe to restore as-is."
        plain "RESTORE FAILED"
        exit 1
    fi
    success "All pre-flight checks passed"
    plain "Extracted copy left at ${RUN_DIR} (remove when done)"
    plain "DRY RUN COMPLETE — no changes made."
    exit 0
fi

if [ "$VERIFY_FAILURES" -gt 0 ]; then
    error "${VERIFY_FAILURES} store(s) failed verification — refusing to execute."
    plain "RESTORE FAILED"
    exit 1
fi

warn "EXECUTE mode: this will overwrite live data on the '${CONTAINER_PREFIX}' stack."
execute_restore
print_summary

# Extraction is disposable once every store is in place; the snapshots are not.
rm -rf "$EXTRACT_DIR" 2>/dev/null || true

success "Restore finished (id ${RESTORE_ID})"
plain "RESTORE COMPLETE"
exit 0

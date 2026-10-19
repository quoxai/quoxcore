# Build policy for setup.sh, sourced (functions only, no side effects). Tested by src/test/buildPolicy.test.js.

# Parallel image builds on a small box fail at random: concurrent npm ci downloads reset (Z2H-R2 on 2 cores;
# proving VM 9203 on 4 cores, 2026-10-16). Prints the COMPOSE_PARALLEL_LIMIT to use, or nothing for no limit.
build_parallel_limit() {
    local cores=${1:-4}
    if [ "$cores" -le 2 ]; then echo 1; elif [ "$cores" -le 4 ]; then echo 2; fi
}

# Network or buildkit errors worth a retry. A collapsed "npm ci did not complete" counts too (the real npm error
# is often not in the tail), unless the log shows a deterministic npm usage/lockfile error, which a retry cannot fix.
BUILD_TRANSIENT_RE='ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ENOTFOUND|TLS handshake timeout|50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)|unexpected HTTP status: 50[234]|error reading from server: EOF|failed to extract layer|rpc error: code = Unavailable|connection reset by peer|failed to solve:.*EOF|process "/bin/sh -c npm ci" did not complete successfully'
BUILD_DETERMINISTIC_RE='npm error code (EUSAGE|ELOCKVERIFY|EJSONPARSE|ERESOLVE)|npm ci. command can only install'
is_transient_build_failure() {
    local log=$1
    local tail200
    tail200=$(tail -200 "$log" 2>/dev/null) || return 1
    printf '%s\n' "$tail200" | grep -qE "$BUILD_DETERMINISTIC_RE" && return 1
    printf '%s\n' "$tail200" | grep -qE "$BUILD_TRANSIENT_RE"
}

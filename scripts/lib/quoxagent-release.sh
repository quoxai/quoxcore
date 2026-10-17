# shellcheck shell=bash
# REL-423 (4.2.3 dry-run, finding 1): a LOCALLY built install could not enrol hosts. The collector serves
# GET /install and /download/quoxagent-* from /app/quoxagent-release, which only the CI image build staged
# (images.yml). setup.sh now stages the same signed release before the local image build, through the SAME
# verifier (scripts/release/quoxagent/fetch-quoxagent-release.mjs: Ed25519 signature over SHA256SUMS by the
# pinned Quox key plus every pinned SHA-256). It fails CLOSED on a mismatch and fails LOUD when offline.
# No Node on the host is needed: without one it runs in the node image the collector Dockerfile pins.
#
# Knobs: QUOXAGENT_RELEASE_BASE_URL=<http(s) URL or a local directory holding the release assets> for an
#        air-gapped install; QUOX_AGENT_RELEASE=skip to build without it (said loudly: hosts cannot enrol).
# Sourced by setup.sh; run from the repo root. Returns non-zero when setup must stop.

QA_STAGE_DIR="services/collector/quoxagent-release"
QA_FETCH="scripts/release/quoxagent/fetch-quoxagent-release.mjs"

_qa_say() { local lvl="$1"; shift; if declare -F "$lvl" >/dev/null; then "$lvl" "$*"; else echo "[setup] $*" >&2; fi; }

# The node image the collector build already pins (so this pulls nothing the build would not).
qa_node_image() {
    grep -m1 -oE '^FROM node:[^ ]+@sha256:[0-9a-f]{64}' services/collector/Dockerfile 2>/dev/null | cut -d' ' -f2
}

_qa_host_node_ok() {
    [ "${QA_FORCE_CONTAINER:-0}" = "1" ] && return 1
    command -v node >/dev/null 2>&1 || return 1
    local major; major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
    [ "${major:-0}" -ge 18 ]
}

# Run the verifier with host Node (>=18) or, failing that, in the pinned node image. Exit code passes through;
# a docker run that cannot start (125: image unavailable, typically offline) reads as a download failure (3).
qa_run_fetch() {
    if _qa_host_node_ok; then node "$QA_FETCH" "$@"; return $?; fi
    local img; img=$(qa_node_image)
    if [ -z "$img" ]; then _qa_say err "  cannot find the pinned node image in services/collector/Dockerfile"; return 1; fi
    local base="${QUOXAGENT_RELEASE_BASE_URL:-}"
    local -a extra=()
    if [ -n "$base" ] && ! [[ "$base" =~ ^https?:// ]]; then
        base=$(cd "$base" 2>/dev/null && pwd) || { _qa_say err "  QUOXAGENT_RELEASE_BASE_URL directory not found: ${QUOXAGENT_RELEASE_BASE_URL}"; return 3; }
        extra+=(-v "$base:/quoxagent-release-src:ro"); base=/quoxagent-release-src
    fi
    [ -n "$base" ] && extra+=(-e "QUOXAGENT_RELEASE_BASE_URL=$base")
    docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/src" -w /src "${extra[@]}" "$img" node "$QA_FETCH" "$@"
    local rc=$?
    [ "$rc" -eq 125 ] && return 3
    return "$rc"
}

stage_quoxagent_release() {
    if [ "${QUOX_AGENT_RELEASE:-}" = "skip" ]; then
        _qa_say warn "  QUOX_AGENT_RELEASE=skip: building WITHOUT the signed quoxagent release."
        _qa_say warn "  This install cannot enrol hosts: GET /install and /download/quoxagent-* will answer 503 until you re-run setup online."
        return 0
    fi
    _qa_say info "  Staging the signed quoxagent release (signature + pinned hashes) for the collector image..."
    qa_run_fetch "$QA_STAGE_DIR"
    local rc=$?
    if [ "$rc" -eq 0 ]; then
        _qa_say log "  quoxagent release verified and staged: this install can enrol hosts (GET /install)"
        return 0
    fi
    if [ "$rc" -eq 3 ]; then
        if [ -f "$QA_STAGE_DIR/deploy/install.sh" ] && qa_run_fetch --verify-staged "$QA_STAGE_DIR"; then
            _qa_say warn "  offline: reusing the quoxagent release staged and verified on an earlier run (re-verified just now)"
            return 0
        fi
        _qa_say err "  Could not download the signed quoxagent release (offline, or GitHub unreachable). Nothing was installed."
        _qa_say err "  Without it this install cannot enrol hosts. Choose one, then re-run ./scripts/setup.sh:"
        _qa_say err "    - connect this machine to the internet; or"
        _qa_say err "    - air-gapped: put the release assets (install.sh, quoxagent-linux-amd64, quoxagent-linux-arm64,"
        _qa_say err "      SHA256SUMS, SHA256SUMS.sig.json) in a directory and set QUOXAGENT_RELEASE_BASE_URL=<that directory>; or"
        _qa_say err "    - set QUOX_AGENT_RELEASE=skip to install without host enrolment."
        return 1
    fi
    _qa_say err "  The quoxagent release FAILED verification (signature or pinned hash mismatch). Refusing to build an"
    _qa_say err "  image that would hand hosts an unverified agent. Nothing was staged."
    return 1
}

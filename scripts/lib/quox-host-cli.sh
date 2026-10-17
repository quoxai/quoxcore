# shellcheck shell=bash
# REL-423 (4.2.3 dry-run, finding 4; owner rule: CLI first): after setup.sh a fresh server had NO `quox`: no Node
# on the host, so `quox -p local setup` and `quox setup license link` were unreachable. setup.sh now installs a
# host `quox` by default: a small wrapper that runs the CLI baked into this stack's own collector image
# (/opt/quox-cli), so the host needs Docker only. Config stays in ~/.config/quox on the host, the install's own
# certificate is trusted (no --insecure), and the `local` profile is pointed at this install.
# `./scripts/setup.sh --no-cli` skips it. Sourced by setup.sh; run from the repo root.

QUOX_WRAPPER_MARK="# quox-host-wrapper: installed by QuoxCORE scripts/setup.sh"

_qc_say() { local lvl="$1"; shift; if declare -F "$lvl" >/dev/null; then "$lvl" "$*"; else echo "[setup] $*" >&2; fi; }

# write_quox_wrapper <dest> <install-dir> <fallback-image>
write_quox_wrapper() {
    local dest="$1" dir="$2" img="$3"
    cat > "$dest" <<WRAP
#!/usr/bin/env bash
$QUOX_WRAPPER_MARK
# Runs the quox CLI from this QuoxCORE install's collector image; the host needs Docker, not Node.
# Install: $dir   Remove: delete this file (and ~/.config/quox if you want your profiles gone too).
set -euo pipefail
QUOX_INSTALL_DIR='$dir'
QUOX_CLI_IMAGE_FALLBACK='$img'
img=\$(docker inspect -f '{{.Config.Image}}' quox-collector 2>/dev/null || true)
img=\${img:-\$QUOX_CLI_IMAGE_FALLBACK}
if [ -z "\$img" ]; then
    echo "quox: cannot find this install's collector image. Start the stack: cd \$QUOX_INSTALL_DIR && docker compose up -d" >&2
    exit 1
fi
home="\${HOME:?quox: HOME is not set}"
mkdir -p "\$home/.config/quox"
args=(run --rm -i --init --network host --user "\$(id -u):\$(id -g)" -e "HOME=\$home" -e "USER=\${USER:-\$(id -un)}" -v "\$home:\$home")
case "\$PWD/" in
    "\$home"/*) args+=(-w "\$PWD") ;;
    /) args+=(-w "\$home") ;;
    *) args+=(-v "\$PWD:\$PWD" -w "\$PWD") ;;
esac
if [ -t 0 ] && [ -t 1 ]; then args+=(-t); fi
crt="\$QUOX_INSTALL_DIR/ssl/quox.crt"
if [ -r "\$crt" ]; then args+=(-v "\$crt:/etc/quox/quox.crt:ro" -e NODE_EXTRA_CA_CERTS=/etc/quox/quox.crt); fi
while IFS= read -r v; do args+=(-e "\$v"); done < <(compgen -e | grep -E '^(QUOX_[A-Z0-9_]*|NO_COLOR|FORCE_COLOR|TERM|COLUMNS|LINES)\$' || true)
exec docker "\${args[@]}" --entrypoint node "\$img" /opt/quox-cli/bin/quox.js "\$@"
WRAP
    chmod 0755 "$dest"
}

# Point the `local` profile at this install's edge, keeping any sign-in. Leaves an operator's own URL alone.
# point_local_profile <quox-binary> <edge-url>
point_local_profile() {
    local q="$1" url="$2" cur
    cur=$("$q" -p local config get url 2>/dev/null | tail -1 | tr -d '[:space:]') || cur=""
    if [ "$cur" = "$url" ]; then
        _qc_say log "  quox profile 'local' -> $url"
        return 0
    fi
    if [ -z "$cur" ]; then
        "$q" config profile add local --url "$url" >/dev/null || return 1
    elif [ "$cur" = "http://localhost:3000" ]; then
        # the CLI's built-in default: plain http, which this install's TLS edge does not answer
        "$q" -p local config set url "$url" >/dev/null || return 1
    else
        _qc_say warn "  quox profile 'local' already points at $cur; left as is (this install is $url)"
        return 0
    fi
    cur=$("$q" -p local config get url 2>/dev/null | tail -1 | tr -d '[:space:]')
    [ "$cur" = "$url" ] || { _qc_say err "  could not point quox profile 'local' at $url (it reads '$cur')"; return 1; }
    _qc_say log "  quox profile 'local' -> $url"
}

# install_host_cli <install-dir> <edge-url>   (env: NO_CLI=true, QUOX_CLI_DEST, AUTO_YES)
install_host_cli() {
    local dir="$1" url="$2"
    if [ "${NO_CLI:-false}" = true ]; then
        _qc_say info "  --no-cli: not installing the host quox command"
        return 0
    fi
    local dest="${QUOX_CLI_DEST:-/usr/local/bin/quox}"
    local existing; existing=$(command -v quox 2>/dev/null || true)
    if [ -n "$existing" ] && ! grep -qF "$QUOX_WRAPPER_MARK" "$existing" 2>/dev/null; then
        _qc_say warn "  a quox command is already installed at $existing (not set up by this script); left it alone"
        point_local_profile "$existing" "$url" || true
        return 0
    fi
    local img; img=$(docker inspect -f '{{.Config.Image}}' quox-collector 2>/dev/null || true)
    local tmp; tmp=$(mktemp "${dir}/.quox-wrapper.XXXXXX")
    write_quox_wrapper "$tmp" "$dir" "$img"
    if mkdir -p "$(dirname "$dest")" 2>/dev/null && [ -w "$(dirname "$dest")" ]; then
        install -m 0755 "$tmp" "$dest"
    elif command -v sudo >/dev/null 2>&1 && { [ "${AUTO_YES:-false}" != true ] || sudo -n true 2>/dev/null; } \
         && sudo install -m 0755 "$tmp" "$dest"; then
        :
    else
        dest="$HOME/.local/bin/quox"
        mkdir -p "$(dirname "$dest")" && install -m 0755 "$tmp" "$dest"
        case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) _qc_say warn "  installed quox at $dest: add $HOME/.local/bin to your PATH" ;; esac
    fi
    rm -f "$tmp"
    local ver
    # no pipe here: a pipeline's status is its last command's, which would hide a wrapper that cannot run
    if ! ver=$("$dest" --version 2>&1) || [ -z "$ver" ]; then
        _qc_say err "  the quox command at $dest does not run: '$(printf '%s' "$ver" | tail -1)'"
        return 1
    fi
    ver=$(printf '%s' "$ver" | tail -1)
    _qc_say log "  quox CLI: $dest ($ver, runs from the collector image; config in ~/.config/quox)"
    point_local_profile "$dest" "$url"
}

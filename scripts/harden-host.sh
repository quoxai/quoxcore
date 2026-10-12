#!/usr/bin/env bash
# harden-host.sh — ENFORCE the SSH hardening that PUBLIC_DEPLOY_RUNBOOK.md §1
# only describes in prose.
#
# Closes quoxai/quox#411: a fresh golden-VM deploy shipped
# `PasswordAuthentication yes` and SHA-1 HMAC algorithms because the runbook
# documented the fix but nothing enforced it, and deploy-instance.sh explicitly
# scoped OS hardening out. This is the enforcement step: an idempotent sshd
# drop-in, validated before it is trusted, that any deploy path can run.
#
# What it enforces (each line maps to a confirmed QUOX-SECURITY finding):
#   - PasswordAuthentication no        (nuclei ssh-password-auth)
#   - KbdInteractiveAuthentication no  (the other interactive-password door)
#   - PermitRootLogin prohibit-password
#   - MACs: SHA-2 + ETM only, SHA-1 dropped   (nuclei ssh-sha1-hmac-algo)
#   - modern KexAlgorithms + Ciphers, legacy dropped
#   - DebianBanner no                  (trims version enumeration; note below)
#
# Modes:
#   --emit    print the drop-in config to stdout and exit. No changes, no root.
#             This is the contract the tests assert against.
#   --check   print the current live sshd posture for the hardened keys
#             (`sshd -T`) and exit. No changes.
#   (default) apply: write the drop-in, `sshd -t` validate the MERGED config,
#             then reload sshd.
#
# Flags:
#   --force   skip the lockout guard (see below).
#
# LOCKOUT GUARD: disabling password auth on a box whose login user has no
# authorized_keys locks that user out. Apply mode refuses unless the invoking
# user (SUDO_USER, else $USER) has a non-empty authorized_keys, or --force is
# given. deploy-instance.sh reaches the target over key-based ssh, so the
# deploy user always has a key there and the guard passes cleanly.
#
# NOTE on version enumeration: OpenSSH still advertises its version string in
# the protocol banner; `DebianBanner no` only drops the distro suffix. Fully
# hiding the version needs a recompile and is out of scope — tracked as the
# residual on #411.

set -euo pipefail

DROPIN_PATH="/etc/ssh/sshd_config.d/99-quox-hardening.conf"
MAIN_CONFIG="/etc/ssh/sshd_config"
MODE="apply"
FORCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --emit) MODE="emit"; shift ;;
    --check) MODE="check"; shift ;;
    --force) FORCE=true; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[harden] ERROR: unknown flag: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[harden] $*"; }
die() { echo "[harden] FATAL: $*" >&2; exit 1; }

# The managed drop-in. Quoted heredoc: no interpolation, deterministic output
# so the content-contract test can assert against it byte for byte.
emit_config() {
  cat <<'CONF'
# Managed by quox scripts/harden-host.sh (quoxai/quox#411).
# Do not edit by hand; re-run the script to regenerate.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
# Drop SHA-1 HMACs (nuclei ssh-sha1-hmac-algo): SHA-2 + ETM only.
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com
# Modern key exchange only; drop legacy SHA-1 group exchanges.
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group16-sha512,diffie-hellman-group-exchange-sha256
# Modern ciphers only.
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr
# Trim the distro version suffix from the banner (see script note on residual).
DebianBanner no
CONF
}

if [[ "$MODE" == "emit" ]]; then
  emit_config
  exit 0
fi

# sudo only when not already root, so the script runs as-is under both a
# root deploy shell and a sudo-capable non-root user.
SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  command -v sudo >/dev/null || die "not root and sudo not available"
  SUDO="sudo"
fi

if [[ "$MODE" == "check" ]]; then
  $SUDO sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|macs|kexalgorithms|ciphers) ' \
    || die "could not read sshd effective config (sshd -T)"
  exit 0
fi

# ── apply ──────────────────────────────────────────────────────────────────

# Lockout guard.
if [[ "$FORCE" != true ]]; then
  target_user="${SUDO_USER:-$USER}"
  home_dir="$(getent passwd "$target_user" | cut -d: -f6 || true)"
  ak="${home_dir}/.ssh/authorized_keys"
  if [[ -z "$home_dir" || ! -s "$ak" ]]; then
    die "user '$target_user' has no authorized_keys ($ak) — disabling PasswordAuthentication would lock you out. Add a key, or re-run with --force."
  fi
  log "lockout guard OK: $target_user has authorized_keys"
fi

# The drop-in only takes effect if the main config Includes sshd_config.d. It
# does on Ubuntu 22.04+/Debian 12+ by default, but enforce it rather than
# assume: a drop-in that is never read is a silent no-op, the exact class of
# "documented but not enforced" bug this script exists to kill.
if ! $SUDO grep -qE '^\s*Include\s+/etc/ssh/sshd_config\.d/\*\.conf' "$MAIN_CONFIG"; then
  log "main sshd_config does not Include sshd_config.d — prepending the Include"
  $SUDO sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' "$MAIN_CONFIG"
fi

log "writing $DROPIN_PATH"
$SUDO install -d -m 755 /etc/ssh/sshd_config.d
emit_config | $SUDO tee "$DROPIN_PATH" >/dev/null
$SUDO chmod 644 "$DROPIN_PATH"

log "validating merged sshd config (sshd -t)..."
$SUDO sshd -t || die "sshd -t rejected the config after writing the drop-in — NOT reloading. Inspect $DROPIN_PATH."

log "reloading sshd..."
$SUDO systemctl reload ssh 2>/dev/null \
  || $SUDO systemctl reload sshd 2>/dev/null \
  || $SUDO service ssh reload 2>/dev/null \
  || die "wrote and validated the drop-in but could not reload sshd — reload it manually"

log "done. Verify with: sudo sshd -T | grep -Ei 'passwordauth|macs '"

'use strict';

/**
 * Per-turn credential checks at /api/v1/tools/execute that hold whatever tool the model names (the Claude CLI path
 * can call any tool by name). 2026-10-16 (cards 01M53AC9…, 01M53E5Y…): a security read with no shell ask must never
 * run a shell sweep, so a credential carrying no_shell drops ssh_exec. Returns the route's JSON body, or null.
 *
 * QUOXON 2026-10-19: a no_shell turn still lets through a command the injection-proof fleet-read allowlist proves
 * read-only (uptime, `claude --version`, `command -v claude`, ...). Those run direct with no approval card, so the
 * shell sweep and the approval spam no_shell exists to stop cannot happen; without this a version recon (no docker_*
 * or security_* tool runs a binary) dead-ended with no path at all.
 */
function execGateDrop(user, toolName) {
  if (!user) return null;
  if (user.no_shell && toolName === 'ssh_exec') {
    return {
      success: false,
      dropped: true,
      error: 'Dropped: ssh_exec was not run because this is a security read and the user did not ask for a shell. Use the security_* tools with a fleet host id (fleet_status lists them), or ask the user which host. A single read-only probe with no && or pipes (for example `claude --version`, `command -v claude`, `docker exec <container> claude --version`, uptime, df) does run on this turn, on one host or a hosts list, with no approval.',
    };
  }
  return null;
}

let _isRead = null;
function _classifier() {
  if (_isRead) return _isRead;
  for (const p of ['../../shared/fleetReadAllowlist.cjs', '../services-shared/fleetReadAllowlist.cjs']) {
    try {
      const m = require(p);
      if (m && typeof m.isAllowlistedFleetRead === 'function') { _isRead = m.isAllowlistedFleetRead; return _isRead; }
    } catch { /* try the next layout */ }
  }
  return () => false; // unresolvable: fail CLOSED (nothing counts as a read)
}

/** True iff the ssh_exec input's command is a provably read-only fleet read (the shared allowlist). */
function allowlistedRead(input) {
  if (!input || typeof input !== 'object' || typeof input.command !== 'string') return false;
  return _classifier()(input.command) === true;
}

/** The route's full check: execGateDrop, except an allowlisted read is never dropped. */
function execGateDropFor(user, toolName, input) {
  if (toolName === 'ssh_exec' && allowlistedRead(input)) return null;
  return execGateDrop(user, toolName);
}

module.exports = { execGateDrop, execGateDropFor, allowlistedRead };

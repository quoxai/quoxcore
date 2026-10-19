'use strict';
/**
 * #914 follow-up (2026-10-14): the Wazuh alerts/vulns routes ssh through BASTION_HOST and curl the indexer
 * with `-u 'user:password'` on the command line. When the exec failed, err.message (which holds the whole
 * command) was logged verbatim, so the indexer password reached the collector log on every failure; and
 * with BASTION_HOST unset every read failed as `ssh ubuntu@ "..."` with a generic 500.
 */

/** Replace any `-u 'user:pass'` / `-u user:pass` credential in a command or error text. */
function redactIndexerCreds(text) {
  return String(text == null ? '' : text)
    .replace(/(-u\s+)'[^']*'/g, "$1'***'")
    .replace(/(-u\s+)"[^"]*"/g, '$1"***"')
    .replace(/(-u\s+)(?!['"])\S+/g, '$1***');
}

/** A plain refusal when the jump host is not configured, instead of running `ssh ubuntu@`. */
function bastionNotConfigured() {
  return { success: false, error: 'wazuh_not_configured', message: 'Wazuh reads need the SSH jump host (BASTION_HOST) and it is not set on this install.' };
}

module.exports = { redactIndexerCreds, bastionNotConfigured };

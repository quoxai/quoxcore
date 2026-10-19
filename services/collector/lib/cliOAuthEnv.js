'use strict';
/**
 * QUOXON-ASK J2 (quox#852): how a Claude CLI spawn gets its subscription credential.
 *
 * CLAUDE_CODE_OAUTH_TOKEN is a fixed access token the CLI cannot refresh. When the token
 * the collector resolved IS the CLI's own credentials-file token (HOME/.claude/
 * .credentials.json), passing it by env turned an expired-but-refreshable token into a
 * hard 401 and "CLI exited with code 1" (live, 2026-10-14). So that token is left in the
 * file, where the CLI reads and refreshes it itself. Any other token (vault/instance
 * config, no file copy) still goes by env.
 */
const fs = require('fs');
const path = require('path');

function fileAccessToken(home) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'));
    return (creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken) || null;
  } catch {
    return null;
  }
}

function cliOAuthEnv(token, { home } = {}) {
  if (!token) return { env: {}, source: 'none' };
  if (home && fileAccessToken(home) === token) return { env: {}, source: 'credentials_file' };
  return { env: { CLAUDE_CODE_OAUTH_TOKEN: token }, source: 'env' };
}

module.exports = { cliOAuthEnv };

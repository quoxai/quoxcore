/**
 * forgeFeedLog.js — QDIS-NEXT #439 phase 3: real "VULCAN opened a PR" event log.
 *
 * A single durable append point, called only after github_create_pull_request's
 * approval-gated action really executed (a real PR got opened), never on the
 * pending/denied/error responses.
 *
 * Written to the collector-data named volume (/var/lib/quox, docker-compose
 * volume `collector-data`), NOT the read-only ~:ro bind mount —
 * the collector container cannot write under ~, and the
 * original implementation of this hook shelled out to
 * ~/bin/session-mail (a host CLI script under that same read-only mount),
 * which cannot have worked in the deployed container. Same fix already
 * applied to gripeFeedLog.js; this mirrors it exactly for forge-feed.
 *
 * The host-side ops/forge-feed.sh script (quox-discord-pro) reads this file
 * via `docker exec quox-collector tail ...` (line-count baseline, same
 * pattern as ops/gripe-feed.sh) and relays new lines into the forge-feed
 * session-mail inbox, which bridgeRelay.js's tick() then posts to the bound
 * Discord channel.
 */
'use strict';

const fs = require('fs');

const FORGE_FEED_LOG = process.env.FORGE_FEED_LOG_PATH || '/var/lib/quox/forge-feed.jsonl';

/**
 * Append one real PR-opened event. Never throws — a feed-log write must
 * never break the actual tool response returned to the caller.
 * @param {{repo: string, number: number|string, title: string, url: string}} evt
 */
function logForgePrOpened(evt) {
  try {
    const { repo, number, title, url } = evt || {};
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      repo: repo || null,
      number: number ?? null,
      title: title || null,
      url: url || null,
    });
    fs.appendFileSync(FORGE_FEED_LOG, line + '\n');
  } catch (err) {
    console.warn('[forgeFeedLog] append failed (non-fatal):', err.message);
  }
}

module.exports = { logForgePrOpened, FORGE_FEED_LOG };

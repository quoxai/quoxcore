/**
 * gripeFeedLog.js — QDIS-NEXT #439: real gripe issue-filing event log.
 *
 * A single durable append point for "a gripe complaint actually became a
 * filed GitHub issue" — never on every gripe call, only on a real
 * connector-bridge success. Two real completion points call this:
 *  - services/collector/lib/agentTools.js's executeTool() connector-routing
 *    branch, gated to ctx.agentId === 'gripe' (the chat/Discord/Telegram
 *    GRIPE agent's github_create_issue call, same connector-bridge path
 *    BOB also shares — see CONNECTOR_FAMILIES in agentTools.js).
 *  - services/collector/lib/fleetGripeHandler.js's
 *    createFleetGripeFileIssueHandler() (fleet-host dev.gripe capability).
 *
 * Written to the collector-data named volume (/var/lib/quox, docker-compose
 * volume `collector-data`), NOT the read-only ~:ro bind mount —
 * the collector container cannot write under ~. The host-side
 * ops/gripe-feed.sh script (quox-discord-pro) reads this file via
 * `docker exec quox-collector tail ...` (line-count baseline, same pattern
 * as ops/qlarity-feed.sh / ops/build-feed.sh) and relays new lines into the
 * gripe-feed session-mail inbox, which bridgeRelay.js's tick() then posts to
 * the bound Discord channel.
 */
'use strict';

const fs = require('fs');

const GRIPE_FEED_LOG = process.env.GRIPE_FEED_LOG_PATH || '/var/lib/quox/gripe-feed.jsonl';

/**
 * Append one real issue-filed event. Never throws — a feed-log write must
 * never break the actual issue-filing response returned to the caller.
 * @param {{source: string, repo: string, number: number, title: string, url: string}} evt
 */
function logGripeIssueFiled(evt) {
  try {
    const { source, repo, number, title, url } = evt || {};
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source: source || 'unknown',
      repo: repo || null,
      number: number ?? null,
      title: title || null,
      url: url || null,
    });
    fs.appendFileSync(GRIPE_FEED_LOG, line + '\n');
  } catch (err) {
    console.warn('[gripeFeedLog] append failed (non-fatal):', err.message);
  }
}

module.exports = { logGripeIssueFiled, GRIPE_FEED_LOG };

#!/usr/bin/env node
'use strict';
/**
 * D2 one-off sweep: delete Claude CLI session files that predate org tagging.
 *
 * Files under RUNTIME_HOME/.claude/projects/<slug>/<uuid>.jsonl written before
 * chat_cli_session_files existed carry no owner, so neither GDPR purge nor the
 * TTL prune can find them. This deletes the ones older than the chat history TTL
 * (CHAT_SESSION_TURNS_TTL_DAYS, default 7) that no table knows. Tagged files and
 * younger files are kept. Never touches anything outside the projects dir.
 *
 * DRY RUN BY DEFAULT. Run inside the collector container:
 *   node scripts/cli-session-sweep.js            # counts only
 *   node scripts/cli-session-sweep.js --apply    # deletes
 *   [--root <projects dir>] [--db <chat-session-turns.db>]
 */

const path = require('path');
const { resolveRuntimeHomeDir } = require('../utils/runtimePaths.js');
const files = require('../lib/cliSessionFiles.js');
const store = require('../lib/chatSessionHistory.js');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

const apply = process.argv.includes('--apply');
const root = arg('--root') || path.join(resolveRuntimeHomeDir(), '.claude', 'projects');
const dbPath = arg('--db') || undefined;
const days = parseInt(process.env.CHAT_SESSION_TURNS_TTL_DAYS, 10);
const ttlMs = (Number.isFinite(days) && days > 0 ? days : 7) * 86400000;

const counts = files.sweepOrphans({
  root,
  ttlMs,
  dryRun: !apply,
  isKnown: (id) => store.isKnownCliSession(id, { dbPath }),
});
console.log(`[cli-session-sweep] root=${root} ttl_days=${ttlMs / 86400000} ${files.describeCounts(counts)}`);
process.exitCode = counts.skipped || counts.errors ? 1 : 0;

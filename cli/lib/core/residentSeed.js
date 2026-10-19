/**
 * Resident seed prompt — QUOXPERTICUS-REVISIT P3 "Resident lifecycle v1".
 *
 * The seed is the one line of text typed into a freshly-deployed interactive
 * `claude` tmux pane (via the dev-sessions `keys` route) that turns a bare
 * shell into the host's resident: read the revival kit before acting, claim
 * the slot, then say a short hello. This encodes the proven 2026-09-04
 * revival recipe (read MEMORY.md + indexed memories + NOTES_TO_SELF.md
 * before acting, then claim, then greet) as a template, parameterized by
 * host and slot.
 *
 * `keys` is a single line per call (the collector appends Enter — see
 * services/collector/lib/devSessionsProxy.js MAX_KEYS_LENGTH=4096), so the
 * rendered seed collapses to ONE line: no literal newlines, which would
 * otherwise submit a half-typed prompt early.
 *
 * LATER PHASE SEAM: a collector-stored per-org/per-host seed override is a
 * follow-up (dashboard-editable, versioned). Until that lands,
 * `loadSeedOverride()` is the only override point, reading a local file on
 * the CONTROL side (the box running `quox dev resident deploy`) verbatim.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultSeedOverridePath() {
  return join(homedir(), '.quox', 'resident', 'seed.md');
}

/**
 * Read a local seed override file, if present. Returns null when the file
 * is missing, unreadable, or empty — never throws, since a missing override
 * simply means "use the built-in template", not an error.
 *
 * SEAM: a later phase replaces/augments this with a collector-stored
 * config record (org/host-scoped, dashboard-editable). This function is the
 * one place that phase needs to change.
 */
export function loadSeedOverride(path = defaultSeedOverridePath()) {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    return content && content.trim() ? content : null;
  } catch {
    return null;
  }
}

/** Collapse arbitrary text to one line safe for a single `keys` send. */
function oneLine(text) {
  return String(text || '').replace(/\s*\r?\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function builtInTemplate({ hostId, slotName }) {
  // #1021: Claude names a project dir by its path with separators turned into '-'.
  const projectDirName = (process.env.QUOX_HOST_HOME || homedir()).replace(/[\\/]/g, '-');
  const claimCmd = `quox slot checkout ${slotName} --session resident-${slotName} --kind interactive --host ${hostId} --create`;
  return (
    `You are the resident Claude session for host ${hostId} (slot ${slotName}). ` +
    `Before doing anything else: read ~/.claude/projects/${projectDirName}/memory/MEMORY.md and every ` +
    `memory file it indexes, then read ~/NOTES_TO_SELF.md if it exists, then read any identity or ` +
    `onboarding docs in your home directory for this host. Read all of it before you act on anything. ` +
    `Once you have read everything, claim your slot with: ${claimCmd}. ` +
    `Then post one short hello (1-2 lines, no em dashes, lead with outcome) into the slot channel ` +
    `confirming you are up and what you found.`
  );
}

/**
 * Render the seed prompt for a host/slot pair, as one line.
 * @param {object} params
 * @param {string} params.hostId
 * @param {string} params.slotName
 * @param {string} [params.overrideText] - test seam; when omitted, falls
 *   back to loadSeedOverride().
 */
export function renderSeedPrompt({ hostId, slotName, overrideText } = {}) {
  if (!hostId) throw new Error('renderSeedPrompt: hostId is required');
  if (!slotName) throw new Error('renderSeedPrompt: slotName is required');

  const override = overrideText !== undefined ? overrideText : loadSeedOverride();
  if (override) {
    return oneLine(
      override.replace(/\{\{?\s*hostId\s*\}?\}/g, hostId).replace(/\{\{?\s*slotName\s*\}?\}/g, slotName)
    );
  }
  return oneLine(builtInTemplate({ hostId, slotName }));
}

/**
 * Split a one-line seed into <= maxLen chunks, each sent as its own `keys`
 * call (each call appends its own Enter). Under maxLen this is a single
 * chunk — the preferred, normal path. Splitting a seed that overflows
 * maxLen means the resident receives it as multiple separate turns rather
 * than one line, which is a documented degrade, not silent truncation.
 */
export function chunkSeedText(text, maxLen = 4000) {
  const s = String(text || '');
  if (s.length <= maxLen) return [s];
  const chunks = [];
  for (let i = 0; i < s.length; i += maxLen) {
    chunks.push(s.slice(i, i + maxLen));
  }
  return chunks;
}

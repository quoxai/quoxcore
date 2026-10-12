/**
 * Agent display-name alias resolution — DEVSUITE-GRIPE-P7 / quox#567 (CLI
 * half only; server-side alias resolution stays open in #567).
 *
 * `quox agent attach vulcan` failed because the registry id is `forge` —
 * "VULCAN" is only the agent's display name (identity.name in
 * src/config/entities/assistants/forge.json), never sent to any API. This
 * module resolves a non-matching agent id case-insensitively against the
 * core assistants roster BEFORE the attach/detach/attach-status/
 * attach-heartbeat/exec/grant-attach commands call the real API, so the
 * canonical registry id is always what goes over the wire.
 *
 * Two sources, combined:
 *   - the collector's no-auth-gate `/api/v1/tools/agents` route, which is
 *     the live, authoritative list of agent ids this deployment currently
 *     recognises (but carries NO display names — it's a tool-permission
 *     map keyed by id);
 *   - the bundled assistants roster (src/config/entities/assistants/*.json,
 *     shipped inside this same repo checkout) for identity.name /
 *     identity.shortName, the only source of display names.
 * A live-roster failure (network down, route not deployed yet) degrades to
 * the bundled roster's own id set rather than blocking alias resolution
 * entirely.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEndpoint } from '../api/endpoints.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// cli/lib/core/agentAlias.js -> cli/lib -> cli -> repo root -> src/config/...
const DEFAULT_ASSISTANTS_DIR = path.resolve(__dirname, '../../../src/config/entities/assistants');

/**
 * Read the bundled assistants roster. Tolerant of a missing directory (a
 * standalone CLI install without the dashboard source tree alongside it)
 * and of individual malformed files — one bad entry must never break alias
 * resolution for every other agent.
 *
 * @returns {Array<{id: string, name: string|null, shortName: string|null}>}
 */
export function loadBundledAssistantsRoster(dir = DEFAULT_ASSISTANTS_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const roster = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (raw?.id) {
        roster.push({
          id: raw.id,
          name: raw.identity?.name || null,
          shortName: raw.identity?.shortName || null,
        });
      }
    } catch {
      // Skip an unreadable/malformed file rather than failing the whole load.
    }
  }
  return roster;
}

/**
 * Pure resolver, exported for unit tests: no filesystem or network access.
 *
 * @param {string} requestedId - what the user typed
 * @param {Set<string>} validIds - agent ids this deployment currently recognises
 * @param {Array<{id: string, name: string|null, shortName: string|null}>} roster
 * @returns {{id: string, aliasLabel: string|null}} aliasLabel is the display
 *   name to print (`alias: <aliasLabel> -> <id>`), or null when the input
 *   was already a valid id (no alias happened).
 */
export function resolveAgentAliasPure(requestedId, validIds, roster) {
  if (!requestedId || typeof requestedId !== 'string') {
    throw new Error('Agent id is required.');
  }

  // Exact, case-sensitive match against a known id: pass through untouched.
  // This is the common case and must never be affected by alias lookup.
  if (validIds.has(requestedId)) {
    return { id: requestedId, aliasLabel: null };
  }

  const lower = requestedId.toLowerCase();
  for (const entry of roster) {
    // Never alias to an id this deployment doesn't currently recognise.
    if (!validIds.has(entry.id)) continue;
    const name = entry.name?.toLowerCase();
    const shortName = entry.shortName?.toLowerCase();
    if (name === lower || shortName === lower) {
      return { id: entry.id, aliasLabel: entry.name || entry.shortName || requestedId.toUpperCase() };
    }
  }

  throw new Error(
    `Unknown agent "${requestedId}": not a registry id, and no matching display name in the assistants roster. `
    + 'Run `quox agent list` to see valid ids.'
  );
}

/**
 * Resolve a possibly-display-name agent id against the live collector
 * roster plus the bundled assistants roster, printing exactly one
 * `alias: <NAME> -> <id>` line on a hit. Callers must use the RETURNED
 * canonical id for every subsequent call — the display name is never sent
 * to the API.
 *
 * Printed unconditionally (never suppressed under -o json/quiet, unlike
 * printInfo): a silent semantic remap of what agent id you are talking to
 * is exactly the kind of thing a scripted/JSON caller most needs to see.
 *
 * @param {object} client - the CLI's HTTP client (ctx.client)
 * @param {string} requestedId
 * @param {{print?: (line: string) => void, rosterDir?: string}} [opts]
 * @returns {Promise<string>} the canonical agent id
 */
export async function resolveAgentId(client, requestedId, opts = {}) {
  const print = opts.print || ((line) => console.log(line));
  const roster = loadBundledAssistantsRoster(opts.rosterDir);

  // CORTEX-BENCH: an exact core id resolves to itself whatever the live list
  // says (absent from it, it passes through as a custom id and the server
  // decides), so skip the round trip that cost every exec 60ms-1.4s.
  if (roster.some((r) => r.id === requestedId)) return requestedId;

  let validIds = null;
  try {
    const ep = resolveEndpoint('v1.tools.agents.list');
    const data = await client.get(ep.path, { service: ep.service, noAuth: true });
    const ids = Object.keys(data?.agentTools || {});
    if (ids.length > 0) validIds = new Set(ids);
  } catch {
    // Live lookup is an optimisation, not a hard requirement -- fall
    // through to the bundled roster's own id set below.
  }
  if (!validIds) validIds = new Set(roster.map((r) => r.id));

  let resolved;
  try {
    resolved = resolveAgentAliasPure(requestedId, validIds, roster);
  } catch (err) {
    // A non-empty id that matches neither a core-registry id nor a display
    // name may be a user/org-created custom assistant (auth `assistants`
    // table) — the core roster this resolver knows never lists those.
    // QUOXIDENTITY custom-attach (CLI half): the client must not gate an id
    // the server can now resolve. Pass it through and let the server be the
    // authority — the attach-kit endpoint resolves a custom assistant
    // org-scoped, or returns a clean 404 for a genuine typo. (An empty id
    // still throws the original 'Agent id is required.' error.)
    if (!requestedId || typeof requestedId !== 'string') throw err;
    print(`note: "${requestedId}" is not a core registry agent, trying it as a custom/org assistant (server resolves or rejects).`);
    return requestedId;
  }
  if (resolved.aliasLabel) print(`alias: ${resolved.aliasLabel} -> ${resolved.id}`);
  return resolved.id;
}

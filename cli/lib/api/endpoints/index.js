/**
 * QuoxCLI endpoint map — aggregated from per-domain fragment files.
 *
 * Generated as part of WP0.1 (Stream CLI-PARITY, docs/STREAM_CLI_PARITY_PLAN.md §3.2 option C),
 * refactored into per-domain fragments so parallel command work packages can add endpoints
 * without colliding on one shared file. This is a PURE, behavior-preserving extraction: every
 * entry reproduces the exact method + service + path that the corresponding call site used
 * before migration. Do not "fix" a path here without also verifying the change against the
 * real route handler — see the plan doc's correctness table (§2.2) for entries that were
 * already corrected.
 *
 * Shape: name -> { method, service, path, tags }
 *   - method: HTTP verb (or 'STREAM' for SSE via client.stream()).
 *   - service: one of the SERVICE_PORTS keys in core/config.js (auth, files, memory,
 *     orchestrator, tasks, collector).
 *   - path: either a zero-arg function returning a static path, or a function of a params
 *     object returning the interpolated path (mirrors the original template literal).
 *   - tags: coarse live-contract tags (WP0.3/WP1.2 refine these).
 *       'live-safe'  — GET, safe to fire against a live stack with no side effects.
 *       'live-write' — mutating (POST/PUT/PATCH/DELETE), needs a create/verify/delete
 *                       cycle or a sandboxed org before it can run live.
 *       'skip-live'  — /internal/* or otherwise out of scope for the live contract test.
 *
 * Naming convention: '<resource>.<action>' (dot-separated for nested resources), where
 * action is one of list/get/create/update/delete/stream, or the literal trailing verb
 * segment of the route (e.g. 'vault.rotate', 'assistants.deploy') when the route itself
 * is an action rather than plain CRUD.
 *
 * Anti-drift rule: no new call site may use a raw path literal — resolve it through this
 * map via resolveEndpoint(name, params) instead. Enforced by test/api/endpoints-lint.test.js.
 *
 * FRAGMENT CONVENTION (read this before adding new endpoints):
 *   Every entry lives in a per-domain fragment file under this directory, named after the
 *   dot-prefix of its endpoint names (the segment before the first '.', e.g. all 'runs.*'
 *   entries live in './runs.js', all 'vault.*' entries live in './vault.js'). Each fragment
 *   exports a single plain object named after its domain (camelCased if the domain contains
 *   a hyphen, e.g. 'backup-schedules.js' exports 'backupSchedules').
 *
 *   To add a brand-new domain: create ONE new file './endpoints/<domain>.js' exporting its
 *   object, then add ONE import + ONE spread line to this file (index.js). That is the only
 *   shared file a new command work package needs to touch — no other fragment file changes,
 *   so parallel work packages adding different domains cannot collide.
 *
 *   To add an endpoint to an EXISTING domain: edit only that domain's fragment file.
 *
 *   Fragments are merged below with object spread in file order. test/api/endpoints-fragments.test.js
 *   asserts (a) no duplicate keys across fragments — spreading would otherwise silently let a
 *   later fragment overwrite an earlier one — and (b) every key exported by a fragment is
 *   actually prefixed by that fragment's own domain, so a misplaced entry fails loudly instead
 *   of silently landing in the wrong file.
 */

import { admin } from './admin.js';
import { aee } from './aee.js';
import { agentAttach } from './agent-attach.js';
import { agents } from './agents.js';
import { assistants } from './assistants.js';
import { audit } from './audit.js';
import { auth } from './auth.js';
import { awareness } from './awareness.js';
import { lucid } from './lucid.js';
import { invites } from './invites.js';
import { backupSchedules } from './backup-schedules.js';
import { backups } from './backups.js';
import { brain } from './brain.js';
import { budgets } from './budgets.js';
import { calendarq } from './calendarq.js';
import { catalog } from './catalog.js';
import { chat } from './chat.js';
import { consent } from './consent.js';
import { conversations } from './conversations.js';
import { customRoles } from './custom-roles.js';
import { divisions } from './divisions.js';
import { domains } from './domains.js';
import { engagement } from './engagement.js';
import { entity } from './entity.js';
import { executions } from './executions.js';
import { file } from './file.js';
import { files } from './files.js';
import { governance } from './governance.js';
import { inbox } from './inbox.js';
import { inboxq } from './inboxq.js';
import { notesq } from './notesq.js';
import { contactsq } from './contactsq.js';
import { x } from './x.js';
import { llmPolicy } from './llm-policy.js';
import { hat } from './hat.js';
import { members } from './members.js';
import { memory } from './memory.js';
import { mfa } from './mfa.js';
import { mon } from './mon.js';
import { objectives } from './objectives.js';
import { orgs } from './orgs.js';
import { plugins } from './plugins.js';
import { powers } from './powers.js';
import { prompts } from './prompts.js';
import { quoxbox } from './quoxbox.js';
import { quoxchat } from './quoxchat.js';
import { quoxflow } from './quoxflow.js';
import { quoxplan } from './quoxplan.js';
import { qlarity } from './qlarity.js';
import { quoxseo } from './quoxseo.js';
import { telephony } from './telephony.js';
import { voice } from './voice.js';
import { reach } from './reach.js';
import { github } from './github.js';
import { runs } from './runs.js';
import { scim } from './scim.js';
import { scopes } from './scopes.js';
import { security } from './security.js';
import { setup } from './setup.js';
import { skills } from './skills.js';
import { sso } from './sso.js';
import { tags } from './tags.js';
import { teams } from './teams.js';
import { tg } from './tg.js';
import { tools } from './tools.js';
import { traces } from './traces.js';
import { triggers } from './triggers.js';
import { userLibrary } from './user-library.js';
import { users } from './users.js';
import { v1 } from './v1.js';
import { vault } from './vault.js';
import { volt } from './volt.js';
import { safety } from './safety.js';
import { ward } from './ward.js';
import { webhooks } from './webhooks.js';
import { workflows } from './workflows.js';

export const ENDPOINTS = {
  ...admin,
  ...aee,
  ...agentAttach,
  ...agents,
  ...assistants,
  ...audit,
  ...auth,
  ...awareness,
  ...lucid,
  ...invites,
  ...backupSchedules,
  ...backups,
  ...brain,
  ...budgets,
  ...calendarq,
  ...catalog,
  ...chat,
  ...consent,
  ...conversations,
  ...customRoles,
  ...divisions,
  ...domains,
  ...engagement,
  ...entity,
  ...executions,
  ...file,
  ...files,
  ...governance,
  ...inbox,
  ...inboxq,
  ...notesq,
  ...contactsq,
  ...x,
  ...llmPolicy,
  ...hat,
  ...members,
  ...memory,
  ...mfa,
  ...mon,
  ...objectives,
  ...orgs,
  ...plugins,
  ...powers,
  ...prompts,
  ...quoxbox,
  ...quoxchat,
  ...quoxflow,
  ...quoxplan,
  ...qlarity,
  ...quoxseo,
  ...telephony,
  ...voice,
  ...reach,
  ...github,
  ...runs,
  ...scim,
  ...scopes,
  ...security,
  ...setup,
  ...skills,
  ...sso,
  ...tags,
  ...teams,
  ...tg,
  ...tools,
  ...traces,
  ...triggers,
  ...userLibrary,
  ...users,
  ...v1,
  ...vault,
  ...volt,
  ...safety,
  ...ward,
  ...webhooks,
  ...workflows,
};

/**
 * Resolve an endpoint by name to its concrete { method, service, path } for this call.
 *
 * @param {string} name - key into ENDPOINTS, e.g. 'agents.list'
 * @param {object} [params] - path params, e.g. { orgId, agentId }
 * @returns {{ method: string, service: string, path: string }}
 */
export function resolveEndpoint(name, params = {}) {
  const entry = ENDPOINTS[name];
  if (!entry) {
    throw new Error(`Unknown endpoint: "${name}" (no entry in cli/lib/api/endpoints/)`);
  }
  return {
    method: entry.method,
    service: entry.service,
    path: entry.path(params),
  };
}

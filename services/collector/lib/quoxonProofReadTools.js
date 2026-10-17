'use strict';
/**
 * QUOXON-PROOF lane I: read-only agent tools for questions chat could not answer
 * although the CLI could (quox#822 LLM status/policy, #823 backups, #824 live
 * sessions, #825 prompt library).
 *
 * Rules every tool here keeps (same as reachReadTools.js):
 *  - READ-ONLY. Nothing here runs, verifies, restores or edits anything.
 *  - The org is ctx.orgId (the turn identity), never a model argument.
 *  - The caller's own bearer (ctx.token) is forwarded, so the backing route applies
 *    the same membership checks it applies to the CLI.
 *  - A non-2xx (or an error body) is reported as an error with its status, never "none".
 */

const turnModel = require('./turnModelContext');

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}/api`;
const COLLECTOR_SELF = () => `http://127.0.0.1:${process.env.COLLECTOR_PORT || process.env.PORT || 9848}`;
const TIMEOUT_MS = 15000;
const BACKUP_LIMIT = 50;
const MAX_SESSIONS_PER_GROUP = 15;
const MAX_PROMPTS = 50;
const MAX_PROMPT_BODY = 4000;

// In-process providers registered by server.js (configureProofReads). Unconfigured
// (tests, another process) llm_status falls back to the HTTP route.
let deps = null;
function configureProofReads(d) {
  deps = d && typeof d === 'object' ? d : null;
}

function needOrgAndUser(ctx, tool) {
  if (!ctx || !ctx.orgId || !ctx.token) {
    return { success: false, error: 'org_context_required', message: `${tool} needs an authenticated user session with organization context.` };
  }
  return null;
}

async function getJson(url, token) {
  const resp = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, body, url };
}

/**
 * SESSIONS (2026-10-15, transcript finding HIGH): a bare "authentication_required" let the
 * model tell the owner to log in again while their login was fine; the refused call was this
 * tool's own server-side hop. The error names the tool, service, method, path (never the
 * query, which carries the org id) and status, and says it was a server-side call.
 */
function httpError(r, tool) {
  let endpoint = null;
  try { endpoint = new URL(r.url).pathname; } catch { /* no url */ }
  const service = r.url && String(r.url).startsWith(AUTH_BASE_URL) ? 'auth' : 'collector';
  const code = (r.body && (r.body.error || r.body.message)) || null;
  const where = `GET ${endpoint || '(unknown path)'} on the ${service === 'auth' ? 'auth service' : 'collector'}`;
  const out = {
    success: false,
    error: `${tool}: ${where} returned HTTP ${r.status}${code ? ` (${code})` : ''}`,
    status: r.status,
    service,
    method: 'GET',
    endpoint,
  };
  if (r.status === 401 || r.status === 403) {
    out.cause = `Server-side: the ${tool} tool's own call to the ${service === 'auth' ? 'auth service' : 'collector'} was refused. `
      + 'Report the service, endpoint and status as the failure. Do not tell the user to log in again: '
      + 'their session reached this tool, so it is not shown to be the cause.';
  }
  return out;
}

function parseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

// ---------------------------------------------------------------- backups ----

const SIZE_OK = (b) => Number.isFinite(Number(b.archive_size_bytes)) && Number(b.archive_size_bytes) > 0;
const SUCCESS_STATES = new Set(['completed', 'verified']);

/**
 * One backup row as the model sees it. A 'completed'/'verified' row with no archive
 * bytes backed nothing up (the 2026-10-11 weekly full: a lock skip recorded as
 * completed). Its status is reported as failed, with the recorded status kept beside it.
 */
function backupView(b) {
  if (!b) return null;
  const empty = SUCCESS_STATES.has(b.status) && !SIZE_OK(b);
  return {
    id: b.id,
    name: b.name || null,
    type: b.backup_type || null,
    status: empty ? 'failed' : b.status,
    ...(empty ? { recorded_status: b.status, note: 'Recorded as completed but the archive is 0 bytes: nothing was backed up. Treat it as failed.' } : {}),
    size_bytes: b.archive_size_bytes ?? null,
    verified: b.status === 'verified',
    started_at: b.created_at || null,
    completed_at: b.completed_at || null,
    ...(b.error_message ? { error: String(b.error_message).slice(0, 300) } : {}),
  };
}

const isRealSuccess = (b) => SUCCESS_STATES.has(b.status) && SIZE_OK(b);
const ts = (b) => String(b.completed_at || b.created_at || '');
const newestFirst = (a, b) => (ts(a) < ts(b) ? 1 : ts(a) > ts(b) ? -1 : 0);

function rowsForSchedule(rows, s) {
  const desc = `Auto-triggered by schedule: ${s.name}`;
  return rows.filter((b) => b.description === desc || b.id === s.last_backup_id || (typeof b.name === 'string' && b.name.startsWith(`Scheduled: ${s.name} (`)));
}

// --------------------------------------------------------------- the tools ----

const QUOXON_PROOF_READ_TOOLS = {
  llm_status: {
    name: 'llm_status',
    description: 'Which AI provider and model THIS turn is running on (as recorded when the turn started, never guessed), plus provider status: which providers are connected (OpenAI, Anthropic API, Claude subscription, Ollama), whether the primary is degraded, and the failover target. Read-only. For the routing policy (defaults and fallback chain per capability) use llm_policy.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      if (!ctx || !ctx.orgId) return { success: false, error: 'org_context_required', message: 'llm_status needs an organization context.' };
      const conversationId = turnModel.conversationIdFromCtx(ctx);
      const thisTurn = turnModel.lookupTurnModel({ orgId: ctx.orgId, conversationId });
      try {
        let status;
        if (deps && typeof deps.chatStatus === 'function') {
          status = await deps.chatStatus(ctx.orgId);
        } else {
          if (!ctx.token) return { success: false, error: 'org_context_required', message: 'llm_status needs an authenticated user session.' };
          const r = await getJson(`${COLLECTOR_SELF()}/chat/status`, ctx.token);
          if (!r.ok) return httpError(r, 'llm_status');
          status = r.body;
        }
        if (!status || typeof status !== 'object') return { success: false, error: 'unexpected response from the chat status check' };
        // The status route answers 200 with ready:false + error when its own check failed.
        if (status.error) return { success: false, error: String(status.error).slice(0, 200) };
        let ollama = null;
        if (deps && typeof deps.ollamaStatus === 'function') {
          try { ollama = await deps.ollamaStatus(ctx.orgId); } catch (e) { ollama = { connected: null, error: `could not read: ${e.message}` }; }
        }
        const p = status.providers || {};
        return {
          success: true,
          this_turn: thisTurn,
          ...(thisTurn ? {} : { this_turn_note: conversationId ? 'This turn\'s provider and model were not recorded, so they are unknown. Do not guess them from the defaults.' : 'This call carries no conversation id, so this turn\'s provider and model are unknown.' }),
          chat_ready: !!(status.chat_ready ?? status.ready),
          primary_auth_method: status.auth_method || null,
          degraded: !!status.degraded,
          degraded_reason: status.degraded_reason || null,
          degraded_until: status.degraded_until || null,
          fallback: status.fallback_hint || null,
          providers: {
            openai: !!p.openai_api_key,
            anthropic_api_key: !!p.anthropic_api_key,
            claude_subscription: !!p.cli_credentials,
            vault_oauth: !!p.vault_oauth,
            ollama: ollama ? ollama.connected === true : null,
          },
          ...(ollama ? { ollama } : {}),
          claude_subscription: status.cli_credentials ? {
            authenticated: !!status.cli_credentials.authenticated,
            expires_in_minutes: status.cli_credentials.expires_in_minutes ?? null,
          } : null,
          codex_cli: status.codex_cli || null,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  llm_policy: {
    name: 'llm_policy',
    description: "This org's LLM routing policy: the system default provider and model, each capability's primary and its fallback chain, and whether users may override. Read-only; changing it is a CLI action (quox llm-policy set). For what THIS turn runs on and whether a provider is degraded use llm_status.",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      const refused = needOrgAndUser(ctx, 'llm_policy');
      if (refused) return refused;
      try {
        const r = await getJson(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/llm-routing-policy`, ctx.token);
        if (!r.ok) return httpError(r, 'llm_policy');
        // The auth route answers { source, policy, record } (getEffectiveLlmRoutingPolicy); read
        // the policy inside it, still accepting a flat policy body.
        const raw = r.body;
        const b = raw && typeof raw === 'object' && raw.policy && typeof raw.policy === 'object' ? raw.policy : raw;
        if (!b || typeof b !== 'object') return { success: false, error: 'unexpected response from the routing policy store' };
        const pick = (x) => (x && typeof x === 'object' ? { provider: x.provider || null, model: x.model || null } : null);
        const caps = b.capabilities && typeof b.capabilities === 'object' ? b.capabilities : {};
        return {
          success: true,
          policy_id: b.policy_id || null,
          enabled: b.enabled !== false,
          system_default: pick(b.system_default),
          enforcement: b.enforcement || null,
          capabilities: Object.entries(caps).map(([capability, c]) => ({
            capability,
            label: (c && (c.capabilityLabel || c.policyLabel)) || null,
            primary: pick(c && c.primary),
            fallbacks: (Array.isArray(c && c.fallbacks) ? c.fallbacks : []).map(pick),
          })),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  backup_overview: {
    name: 'backup_overview',
    description: 'When this Quox was last backed up, from the live backup record (the same data quox backup list reads), never from memory notes: the last successful and last verified backup, and for each backup job (schedule) its last run with size, status and verified flag, plus the next run. A run recorded as completed with 0 bytes is reported as failed. Read-only; running, verifying or restoring a backup is a CLI or approval action.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      const refused = needOrgAndUser(ctx, 'backup_overview');
      if (refused) return refused;
      const org = encodeURIComponent(ctx.orgId);
      try {
        const [list, sched] = await Promise.all([
          getJson(`${AUTH_BASE_URL}/orgs/${org}/backups?limit=${BACKUP_LIMIT}`, ctx.token),
          getJson(`${AUTH_BASE_URL}/orgs/${org}/backup-schedules`, ctx.token),
        ]);
        if (!list.ok) return httpError(list, 'backup_overview');
        const rows = list.body && (list.body.items || list.body.backups || list.body.data);
        if (!Array.isArray(rows)) return { success: false, error: 'unexpected response from the backup store' };
        const sorted = [...rows].sort(newestFirst);
        const lastSuccessful = sorted.find(isRealSuccess) || null;
        const lastVerified = sorted.find((b) => b.status === 'verified' && SIZE_OK(b)) || null;
        let jobs = null;
        let jobsError = null;
        const schedules = sched.ok && sched.body && Array.isArray(sched.body.schedules) ? sched.body.schedules : null;
        if (!schedules) {
          jobsError = sched.ok ? 'unexpected response from the schedule store' : `backup schedules returned HTTP ${sched.status}`;
        } else {
          jobs = schedules.map((s) => {
            const mine = rowsForSchedule(sorted, s);
            return {
              name: s.name,
              schedule: s.schedule_type || null,
              type: s.backup_type || null,
              enabled: !!s.enabled,
              next_run_at: s.next_run_at || null,
              last_run: backupView(mine[0] || null),
              last_successful_run: backupView(mine.find(isRealSuccess) || null),
            };
          });
        }
        const running = sorted.filter((b) => b.status === 'running').map(backupView);
        return {
          success: true,
          last_successful: backupView(lastSuccessful),
          last_verified: backupView(lastVerified),
          ...(running.length ? { running } : {}),
          jobs,
          ...(jobsError ? { jobs_error: jobsError } : {}),
          suspect_runs: sorted.filter((b) => SUCCESS_STATES.has(b.status) && !SIZE_OK(b)).map((b) => ({ id: b.id, name: b.name || null, recorded_status: b.status, size_bytes: b.archive_size_bytes ?? null, completed_at: b.completed_at || null })),
          recent: sorted.slice(0, 10).map(backupView),
          scanned: rows.length,
          ...(rows.length >= BACKUP_LIMIT ? { note: `Only the newest ${BACKUP_LIMIT} backups were read.` } : {}),
          ...(rows.length === 0 ? { note: 'No backups are recorded for this org.' } : {}),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  live_sessions: {
    name: 'live_sessions',
    description: "Everything live in this org right now, grouped by agent (what quox sessions shows): terminal sessions, chat conversations, held slots, objectives and executions, each with its state (working, waiting, resting, failing) and last activity. Read-only. Sources that could not be read are named, never dropped silently.",
    input_schema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Optional: only this agent\'s group.' } },
      required: [],
    },
    execute: async (input, ctx) => {
      const refused = needOrgAndUser(ctx, 'live_sessions');
      if (refused) return refused;
      try {
        const r = await getJson(`${COLLECTOR_SELF()}/api/v1/sessions?org_id=${encodeURIComponent(ctx.orgId)}`, ctx.token);
        if (!r.ok) return httpError(r, 'live_sessions');
        const b = r.body;
        if (!b || !Array.isArray(b.groups)) return { success: false, error: 'unexpected response from the sessions index' };
        const want = input && typeof input.agent === 'string' && input.agent.trim() ? input.agent.trim().toLowerCase() : null;
        const groups = b.groups
          .filter((g) => !want || String(g.agent || '').toLowerCase() === want)
          .map((g) => {
            const rows = Array.isArray(g.rows) ? g.rows : [];
            return {
              agent: g.agent || null,
              count: rows.length,
              sessions: rows.slice(0, MAX_SESSIONS_PER_GROUP).map((s) => ({
                id: s.id, kind: s.kind || null, name: s.name || null, state: s.state || null,
                ...(s.state_reason ? { state_reason: String(s.state_reason).slice(0, 160) } : {}),
                host: s.host || null, last_active: s.last_active || null,
                ...(s.unread ? { unread: s.unread } : {}),
              })),
              ...(rows.length > MAX_SESSIONS_PER_GROUP ? { truncated: true } : {}),
            };
          });
        const sources = Array.isArray(b.sources) ? b.sources : [];
        return {
          success: true,
          generated_at: b.generated_at || null,
          counts: b.counts || null,
          groups,
          unreadable_sources: sources.filter((s) => s && s.state && s.state !== 'ok').map((s) => s.label || s.id),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  prompt_list: {
    name: 'prompt_list',
    description: "List the saved prompts in this org's prompt library (your own plus org-visible ones): id, name, description, category, visibility and tags. Optional search on name and body, or a tag filter. Read-only; use prompt_read for one prompt's full text. Creating or editing prompts is a CLI action (quox prompt).",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional substring search on prompt name and body.' },
        tags: { type: 'string', description: 'Optional comma-separated tags (match any).' },
      },
      required: [],
    },
    execute: async (input, ctx) => {
      const refused = needOrgAndUser(ctx, 'prompt_list');
      if (refused) return refused;
      try {
        const q = new URLSearchParams({ org_id: ctx.orgId });
        if (input && typeof input.search === 'string' && input.search.trim()) q.set('q', input.search.trim().slice(0, 200));
        if (input && typeof input.tags === 'string' && input.tags.trim()) q.set('tags', input.tags.trim().slice(0, 200));
        const r = await getJson(`${AUTH_BASE_URL}/prompts?${q}`, ctx.token);
        if (!r.ok) return httpError(r, 'prompt_list');
        const rows = r.body && r.body.prompts;
        if (!Array.isArray(rows)) return { success: false, error: 'unexpected response from the prompt library' };
        return {
          success: true,
          count: rows.length,
          prompts: rows.slice(0, MAX_PROMPTS).map((p) => ({
            id: p.id, name: p.name || null, description: p.description || null, category: p.category || null,
            visibility: p.visibility || null, tags: parseList(p.tags), updated_at: p.updated_at || null,
          })),
          ...(rows.length > MAX_PROMPTS ? { truncated: true } : {}),
          ...(rows.length === 0 ? { note: 'No saved prompts match.' } : {}),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  prompt_read: {
    name: 'prompt_read',
    description: "Read one saved prompt from the prompt library by id: its full text, variables, tags and where it is deployed. Read-only. Find ids with prompt_list.",
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Prompt id from prompt_list.' } },
      required: ['id'],
    },
    execute: async (input, ctx) => {
      const refused = needOrgAndUser(ctx, 'prompt_read');
      if (refused) return refused;
      const id = input && typeof input.id === 'string' ? input.id.trim() : '';
      if (!id) return { success: false, error: 'id is required (find it with prompt_list)' };
      try {
        const r = await getJson(`${AUTH_BASE_URL}/prompts/${encodeURIComponent(id)}?org_id=${encodeURIComponent(ctx.orgId)}`, ctx.token);
        if (!r.ok) return httpError(r, 'prompt_read');
        const p = r.body && r.body.prompt;
        if (!p) return { success: false, error: 'unexpected response from the prompt library' };
        const body = typeof p.body === 'string' ? p.body : '';
        return {
          success: true,
          prompt: {
            id: p.id, name: p.name || null, description: p.description || null, category: p.category || null,
            visibility: p.visibility || null, tags: parseList(p.tags), variables: parseList(p.variables),
            deploy_targets: parseList(p.deploy_targets),
            body: body.slice(0, MAX_PROMPT_BODY),
            ...(body.length > MAX_PROMPT_BODY ? { body_truncated: true } : {}),
            updated_at: p.updated_at || null,
          },
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

module.exports = { QUOXON_PROOF_READ_TOOLS, configureProofReads, backupView };

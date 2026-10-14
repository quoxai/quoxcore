'use strict';
/**
 * QUOXON-REACH lane G (gap 4): read-only agent tools for domains that had a CLI
 * but no agent tool on the orchestrator (plugins, spend, identity, install).
 *
 * Rules every tool here keeps:
 *  - READ-ONLY. Nothing here enables, buys, edits or deletes; those stay on the
 *    CLI or an approval path.
 *  - The org is ctx.orgId (the turn identity), never a model argument. No tool
 *    declares an org parameter, and any org-ish input the model sends is ignored.
 *  - The caller's own bearer (ctx.token) is forwarded, so the backing route applies
 *    the same membership and role checks it applies to the CLI. A service key is
 *    never sent with a model-supplied id.
 *  - A non-2xx is reported as an error with its status, never as "none".
 */

const AUTH_BASE_URL = `http://${process.env.AUTH_HOST || 'auth'}:${process.env.AUTH_PORT || '3101'}/api`;
const QUOXFLOW_URL = process.env.QUOXFLOW_URL || 'http://quoxflow:3200';
const COLLECTOR_SELF = () => `http://127.0.0.1:${process.env.COLLECTOR_PORT || process.env.PORT || 9848}`;
const TIMEOUT_MS = 10000;
const MAX_BUDGETS = 10;

function needOrgAndUser(ctx, tool) {
  if (!ctx || !ctx.orgId || !ctx.token) {
    return { success: false, error: 'org_context_required', message: `${tool} needs an authenticated user session with organization context.` };
  }
  return null;
}

async function getJson(url, headers) {
  const resp = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, body };
}

function httpError(r) {
  return { success: false, error: (r.body && (r.body.error || r.body.message)) || `HTTP ${r.status}`, status: r.status };
}

const microToUsd = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) / 1e6 : null);

const REACH_READ_TOOLS = {
  plugin_list: {
    name: 'plugin_list',
    description: "List this org's installed plugins: id, name, version, tier and whether each is enabled. Read-only; enabling or disabling a plugin is a CLI/dashboard action.",
    input_schema: {
      type: 'object',
      properties: { enabled_only: { type: 'boolean', description: 'Only list enabled plugins.' } },
      required: [],
    },
    execute: async (input, ctx) => {
      const refused = needOrgAndUser(ctx, 'plugin_list');
      if (refused) return refused;
      try {
        const r = await getJson(`${AUTH_BASE_URL}/orgs/${encodeURIComponent(ctx.orgId)}/plugins`, { Authorization: `Bearer ${ctx.token}` });
        if (!r.ok) return httpError(r);
        if (!r.body || !Array.isArray(r.body.plugins)) return { success: false, error: 'unexpected response from the plugin registry' };
        let plugins = r.body.plugins.map((p) => ({
          plugin_id: p.plugin_id,
          name: (p.manifest && (p.manifest.displayName || p.manifest.name)) || p.plugin_id,
          version: p.version || null,
          enabled: !!p.is_enabled,
          tier: (p.manifest && p.manifest.tier) || null,
          installed_at: p.installed_at || null,
        }));
        if (input && input.enabled_only) plugins = plugins.filter((p) => p.enabled);
        return { success: true, count: plugins.length, enabled: plugins.filter((p) => p.enabled).length, plugins };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  spend_status: {
    name: 'spend_status',
    description: "AI spend against this org's budgets: each budget's scope, cap, period, hard stop, and the cost and tokens used so far. Read-only; creating or changing a budget is a CLI action (quox budget).",
    input_schema: {
      type: 'object',
      properties: { scope: { type: 'string', description: 'Optional budget scope filter: org, objective, execution or iteration.' } },
      required: [],
    },
    execute: async (input, ctx) => {
      if (!ctx || !ctx.orgId) return { success: false, error: 'org_context_required', message: 'spend_status needs an organization context.' };
      const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
      const headers = {
        ...(ctx.token ? { Authorization: `Bearer ${ctx.token}` } : {}),
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
        'X-Org-ID': ctx.orgId,
      };
      try {
        const q = new URLSearchParams({ org_id: ctx.orgId });
        if (input && typeof input.scope === 'string' && /^(org|objective|execution|iteration)$/.test(input.scope)) q.set('scope', input.scope);
        const list = await getJson(`${QUOXFLOW_URL}/api/budgets?${q}`, headers);
        if (!list.ok) return httpError(list);
        const rows = (list.body && ((list.body.data && list.body.data.budgets) || list.body.budgets)) || null;
        if (!Array.isArray(rows)) return { success: false, error: 'unexpected response from the budget store' };
        if (rows.length === 0) return { success: true, count: 0, budgets: [], note: 'No budgets are set for this org, so spend is not capped. quox budget create sets one.' };
        const budgets = [];
        for (const b of rows.slice(0, MAX_BUDGETS)) {
          // The budget id comes from the server's own list for ctx.orgId, never from the model.
          const u = await getJson(`${QUOXFLOW_URL}/api/budgets/${encodeURIComponent(b.id)}/usage?${new URLSearchParams({ org_id: ctx.orgId })}`, headers);
          const usage = u.ok ? ((u.body && ((u.body.data && u.body.data.usage) || u.body.usage)) || null) : null;
          const max = microToUsd(b.max_cost_usd_micro);
          const spent = usage ? microToUsd(usage.cost_usd_micro) : null;
          budgets.push({
            id: b.id,
            scope: b.scope_kind,
            scope_id: b.scope_id,
            period_start: b.period_start || null,
            period_end: b.period_end || null,
            hard_stop: !!b.hard_stop,
            max_cost_usd: max,
            max_tokens: b.max_tokens ?? null,
            spent_cost_usd: spent,
            tokens_in: usage ? usage.tokens_in ?? null : null,
            tokens_out: usage ? usage.tokens_out ?? null : null,
            used_pct: max && spent !== null ? Math.round((spent / max) * 1000) / 10 : null,
            ...(u.ok ? {} : { usage_error: `HTTP ${u.status}` }),
          });
        }
        return { success: true, count: rows.length, budgets, ...(rows.length > MAX_BUDGETS ? { truncated: true } : {}) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  identity_status: {
    name: 'identity_status',
    description: 'Who the current user is: account, MFA, the current organization and their role in it, and the other organizations they belong to. Read-only; members, roles and SSO are changed from the CLI or dashboard.',
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      if (!ctx || !ctx.token) {
        return { success: false, error: 'user_session_required', message: 'identity_status reads your own session; it needs a signed-in user, not a service call.' };
      }
      try {
        const r = await getJson(`${AUTH_BASE_URL}/auth/me`, { Authorization: `Bearer ${ctx.token}` });
        if (!r.ok) return httpError(r);
        const u = r.body && r.body.user;
        if (!u) return { success: false, error: 'unexpected response from the auth service' };
        const org = u.org || r.body.current_org || null;
        return {
          success: true,
          user: { id: u.id, email: u.email || null, display_name: u.display_name || null, mfa_enabled: !!u.mfa_enabled, instance_admin: !!u.instance_admin_role },
          current_org: org ? { id: org.id, name: org.name || null, slug: org.slug || null, role: org.role || null } : null,
          organizations: (Array.isArray(r.body.organizations) ? r.body.organizations : []).map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role, plan: o.plan || null })),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  install_status: {
    name: 'install_status',
    description: "This Quox install's version and release, how long it has run, and the health of each platform service (ok, degraded or down). Read-only; updating or restarting is a CLI action (quox server).",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => {
      const refused = needOrgAndUser(ctx, 'install_status');
      if (refused) return refused;
      try {
        const v = await getJson(`${COLLECTOR_SELF()}/version`, {});
        const version = v.ok && v.body ? {
          version: v.body.version || null,
          release: v.body.release || null,
          stamped: !!v.body.stamped,
          uptime_seconds: v.body.uptime_seconds ?? null,
        } : null;
        // The aggregate route is gated by the optional instance read token (QUOXCORE_READ_TOKEN),
        // not the user JWT; it stays server-side and never reaches the result.
        const h = await getJson(`${COLLECTOR_SELF()}/api/v1/health/aggregate`, { Authorization: `Bearer ${process.env.QUOXCORE_READ_TOKEN || ctx.token}` });
        if (!h.ok || !h.body || typeof h.body.services !== 'object' || h.body.services === null) {
          return { success: true, version, services: null, health_error: h.ok ? 'unexpected health response' : `health check returned HTTP ${h.status}` };
        }
        const services = Object.entries(h.body.services).map(([service, s]) => ({
          service,
          status: (s && s.status) || 'unknown',
          ...(s && s.error ? { error: String(s.error).slice(0, 120) } : {}),
        }));
        return {
          success: true,
          version,
          health_score: h.body.score ?? h.body.health_score ?? null,
          services,
          down: services.filter((s) => s.status === 'down').map((s) => s.service),
          ...(version ? {} : { version_error: `version returned HTTP ${v.status}` }),
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

module.exports = { REACH_READ_TOOLS };

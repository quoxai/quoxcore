/**
 * QLarity Agent Tools (DEVSUITE-CLARIFY Phase 3 dogfood slice)
 *
 * QLarity (the productised clarify-mcp, ~/qlarity) is a governed headless-
 * Chromium service. Phases 1+2 of DEVSUITE-CLARIFY already shipped the real
 * thing: a containerized service with default-deny egress, per-org session
 * isolation, and the collector's own `/api/v1/qlarity/*` proxy (server.js
 * ~:9036), which is license-gated (`isPluginLicensedForOrg(orgId, 'qlarity')`)
 * and AEE-witnessed. This module is the missing piece: agent tools so
 * in-dashboard agents (and, later, Bob — DEVSUITE-HUB's not-yet-built
 * dev-suite agent) can drive that same governed service the way clarify-mcp
 * lets an interactive Claude Code session drive it.
 *
 * Scope, deliberately narrow: this wires the container-native slice ("P1 and
 * P2 do not need DevMode — they inspect origins reachable from the
 * container", per the plan doc) — i.e. origins the collector's own container
 * can already reach. `dev.clarify` on an arbitrary REMOTE managed host via
 * quoxagent is a separate, bigger piece (internal/plugins/dev's dev.clarify
 * capability is a reserved name with no logic yet, commit 865a17b) and is
 * explicitly OUT OF SCOPE here.
 *
 * Shape mirrors quoxplanTools.js's write-tool pattern: every call routes
 * through the collector's OWN `/api/v1/qlarity/*` proxy (never QLARITY_URL
 * directly), authenticated with X-Service-Key (INTERNAL_SERVICE_KEY), which
 * requireServiceOrUserAuth() (utils/httpAuth.js) accepts as a service-to-
 * service caller. The proxy's own org resolution (resolveNucleusOrgId ->
 * feedApiHandlers.resolveOrgId) reads org_id from the query string OR body
 * for a service caller (never from a header for req.service), so org_id is
 * always sent as a query parameter here — for every method, including GET
 * and DELETE — rather than split across query/body by verb.
 *
 * Real request shapes below are read off the real QLarity service
 * (~/qlarity/src/app.js), not guessed:
 *   POST   /sessions                    -> { id, created_at }
 *   POST   /sessions/:id/open           <- { url, wait_until?, extra_wait_ms? }
 *   POST   /sessions/:id/inspect        <- { inspector, selector?, properties?, name? }
 *   GET    /sessions/:id/console        ?level=
 *   GET    /sessions/:id/network
 *   GET    /sessions/:id/blocked
 *   POST   /sessions/:id/screenshot     <- { full_page?, selector? }
 *   POST   /sessions/:id/eval           <- { script }  ALWAYS 202 awaiting_approval (or 501 if no HITL sink)
 *   DELETE /sessions/:id
 *
 * HITL on eval — CONFIRMED enforced at the QLarity SERVICE itself, not just
 * the proxy or this tool layer. ~/qlarity/src/app.js's POST /eval route never
 * runs the script inline: it always calls hitl.requestApproval(...) and
 * returns 202 { status: 'awaiting_approval', inbox_item_id }, or throws a 501
 * if no HITL sink is configured at all ("a gate that degrades open is not a
 * gate" — the route's own comment). There is deliberately no "probably safe"
 * read-only-eval tier: DEVSUITE-CLARIFY's plan notes record that a v1 design
 * assuming you can statically tell read-only JS from mutating JS was wrong
 * and was replaced with the named parameterised inspectors (qlarity_inspect's
 * action:'dom') plus this single always-HITL raw-eval verb. So qlarity_eval
 * below does NOT duplicate any gating — it has nothing to gate, because the
 * service can only ever hand back an approval ticket, never a result.
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const FETCH_TIMEOUT_MS = 20000; // browser automation is slower than a typical API call

const DOM_INSPECTORS = ['computed_style', 'pseudo_style', 'text_content', 'attribute', 'count', 'bounding_box', 'storage', 'dom_summary', 'layout_health', 'responsive_sweep', 'expect'];

/** Shared request helper — every call goes through the collector's own
 * governed `/api/v1/qlarity/*` proxy (never QLARITY_URL directly), the same
 * discipline as quoxplanTools.js's quoxplanWrite. org_id always travels as a
 * query param (works uniformly for GET/POST/DELETE against the proxy's
 * resolveNucleusOrgId, which for a service caller only reads query/body, no
 * header). Network failures, timeouts and non-2xx responses all become one
 * readable Error whose .message is safe to hand back to the agent. */
async function qlarityCall(method, path, { orgId, body } = {}) {
  if (!orgId) {
    throw new Error('org_context_required: QLarity tools need an authenticated org context to resolve at the governed proxy.');
  }
  const sep = path.includes('?') ? '&' : '?';
  const url = `${COLLECTOR_URL}/api/v1/qlarity${path}${sep}org_id=${encodeURIComponent(orgId)}`;
  const headers = { 'Content-Type': 'application/json' };
  if (INTERNAL_SERVICE_KEY) headers['X-Service-Key'] = INTERNAL_SERVICE_KEY;
  const hasBody = !['GET', 'HEAD'].includes(method);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(body || {}) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`QLarity governed proxy unreachable (${err.message}). Is the collector running on ${COLLECTOR_URL}?`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* body may be empty/non-JSON */ }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `${res.status} ${res.statusText}`;
    throw new Error(`QLarity request failed (${res.status}): ${detail}`);
  }
  return json;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const QLARITY_TOOLS = {

  qlarity_open: {
    name: 'qlarity_open',
    description: 'Open a URL in a governed QLarity browser session (headless Chromium, per-org isolated, default-deny egress allowlist — the same service clarify-mcp exposes for interactive Claude Code use, now callable by agents). Creates a new session automatically if session_id is omitted; pass an existing session_id to navigate that session to a new URL instead of opening a fresh one. Returns the session_id — reuse it with qlarity_inspect / qlarity_eval, and close it with qlarity_close when done.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open. Must be reachable from the collector container and pass the QLarity egress allowlist (default-deny).' },
        session_id: { type: 'string', description: 'Optional existing QLarity session id to reuse instead of opening a new session.' },
        wait_until: { type: 'string', description: "Playwright navigation wait condition, e.g. 'load' (default), 'domcontentloaded', 'networkidle'." },
        extra_wait_ms: { type: 'number', description: 'Optional extra settle time in ms after navigation (capped at 10000 by the service).' },
      },
      required: ['url'],
    },
    execute: async ({ url, session_id, wait_until, extra_wait_ms }, ctx) => {
      if (!url || !String(url).trim()) return { success: false, error: 'url is required' };
      try {
        let sessionId = session_id;
        if (!sessionId) {
          const created = await qlarityCall('POST', '/sessions', { orgId: ctx && ctx.orgId });
          sessionId = created && created.id;
          if (!sessionId) return { success: false, error: 'QLarity did not return a session id' };
        }
        const body = { url };
        if (wait_until) body.wait_until = wait_until;
        if (extra_wait_ms !== undefined && extra_wait_ms !== null) body.extra_wait_ms = extra_wait_ms;
        const result = await qlarityCall('POST', `/sessions/${encodeURIComponent(sessionId)}/open`, { orgId: ctx && ctx.orgId, body });
        return {
          success: true,
          session_id: sessionId,
          url: result ? result.url : null,
          status: result ? result.status : null,
          title: result ? result.title : null,
          blocked: (result && result.blocked) || [],
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  qlarity_inspect: {
    name: 'qlarity_inspect',
    description: 'Inspect a page in an already-open QLarity session: screenshot, console messages, network events, blocked-navigation log, or a named DOM read. DOM inspectors: computed_style, pseudo_style, text_content, attribute, count, bounding_box, storage, dom_summary (depth-limited DOM tree), layout_health (overflow/zero-size/off-screen findings), responsive_sweep (per-viewport-width overflow + selector box), expect (structured assertion — exists|visible|text_contains|count_equals|attribute_equals|…). All of these are the free/safe read tier — for arbitrary JavaScript use qlarity_eval instead, which is always human-approval-gated. Use qlarity_open first to get a session_id.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'QLarity session id from qlarity_open' },
        action: { type: 'string', enum: ['screenshot', 'console', 'network', 'blocked', 'dom'], description: "'screenshot' (viewport or full-page PNG, base64+sha256), 'console' (recorded console messages), 'network' (recorded network events), 'blocked' (egress-allowlist-blocked navigations), or 'dom' (one named read via the `inspector` field)." },
        full_page: { type: 'boolean', description: "action='screenshot' only: capture the full scrollable page instead of just the viewport." },
        selector: { type: 'string', description: "CSS selector. Used by action='screenshot' (element screenshot) and most action='dom' inspectors." },
        level: { type: 'string', description: "action='console' only: filter to one console message type, e.g. 'error'." },
        inspector: { type: 'string', enum: DOM_INSPECTORS, description: "action='dom' only: which named inspector to run." },
        properties: { type: 'array', items: { type: 'string' }, description: "action='dom' only: narrows computed_style/pseudo_style to specific CSS property names." },
        name: { type: 'string', description: "action='dom' with inspector='attribute' or 'expect' (attribute_equals): the attribute name." },
        assert: { type: 'string', description: "action='dom' with inspector='expect': the assertion — exists|not_exists|visible|hidden|text_contains|text_equals|count_equals|attribute_equals." },
        value: { description: "action='dom' with inspector='expect': the expected value (text substring, count, or attribute value)." },
        widths: { type: 'array', items: { type: 'number' }, description: "action='dom' with inspector='responsive_sweep': viewport widths to sweep (default 375,768,1024,1440)." },
        depth: { type: 'number', description: "action='dom' with inspector='dom_summary': tree depth (default 4)." },
      },
      required: ['session_id', 'action'],
    },
    execute: async (input, ctx) => {
      const { session_id, action } = input || {};
      if (!session_id) return { success: false, error: 'session_id is required' };
      if (!action) return { success: false, error: 'action is required' };
      const orgId = ctx && ctx.orgId;
      const sid = encodeURIComponent(session_id);
      try {
        switch (action) {
          case 'screenshot': {
            const body = {};
            if (input.full_page !== undefined) body.full_page = input.full_page;
            if (input.selector) body.selector = input.selector;
            const result = await qlarityCall('POST', `/sessions/${sid}/screenshot`, { orgId, body });
            return { success: true, action, ...result };
          }
          case 'console': {
            const qs = input.level ? `?level=${encodeURIComponent(input.level)}` : '';
            const result = await qlarityCall('GET', `/sessions/${sid}/console${qs}`, { orgId });
            return { success: true, action, ...result };
          }
          case 'network': {
            const result = await qlarityCall('GET', `/sessions/${sid}/network`, { orgId });
            return { success: true, action, ...result };
          }
          case 'blocked': {
            const result = await qlarityCall('GET', `/sessions/${sid}/blocked`, { orgId });
            return { success: true, action, ...result };
          }
          case 'dom': {
            if (!input.inspector) {
              return { success: false, error: `inspector is required for action="dom" (one of: ${DOM_INSPECTORS.join(', ')})` };
            }
            const body = { inspector: input.inspector };
            if (input.selector) body.selector = input.selector;
            if (input.properties) body.properties = input.properties;
            if (input.name) body.name = input.name;
            // clarify-parity inspector args (expect / responsive_sweep / dom_summary).
            if (input.assert) body.assert = input.assert;
            if (input.value !== undefined) body.value = input.value;
            if (input.widths) body.widths = input.widths;
            if (input.depth !== undefined) body.depth = input.depth;
            const result = await qlarityCall('POST', `/sessions/${sid}/inspect`, { orgId, body });
            return { success: true, action, ...result };
          }
          default:
            return { success: false, error: `Unknown action "${action}". Use screenshot, console, network, blocked, or dom.` };
        }
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  qlarity_eval: {
    name: 'qlarity_eval',
    description: 'Request arbitrary JavaScript execution in a QLarity session. This NEVER runs the script directly and NEVER returns a result: the QLarity service files an owner approval in the HITL inbox and returns immediately with an "awaiting_approval" status — the script only runs if/when the owner approves it separately. There is no lower-risk "read-only eval" tier (statically telling read-only JS from mutating JS is not implementable); for reads, use qlarity_inspect with action="dom" and a named inspector instead.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'QLarity session id from qlarity_open' },
        script: { type: 'string', description: 'JavaScript to run in the page, pending owner approval.' },
      },
      required: ['session_id', 'script'],
    },
    execute: async ({ session_id, script }, ctx) => {
      if (!session_id) return { success: false, error: 'session_id is required' };
      if (!script || !String(script).trim()) return { success: false, error: 'script is required' };
      try {
        const result = await qlarityCall('POST', `/sessions/${encodeURIComponent(session_id)}/eval`, {
          orgId: ctx && ctx.orgId,
          body: { script },
        });
        const inboxItemId = result ? result.inbox_item_id : null;
        return {
          success: true,
          session_id,
          status: (result && result.status) || 'awaiting_approval',
          inbox_item_id: inboxItemId,
          message: `Eval request for session ${session_id} queued for owner approval${inboxItemId ? ` (inbox item ${inboxItemId})` : ''}. QLarity never executes eval scripts without approval.`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  qlarity_close: {
    name: 'qlarity_close',
    description: 'Close a QLarity browser session, releasing the underlying browser context. Call this when finished with a session opened via qlarity_open.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'QLarity session id to close' },
      },
      required: ['session_id'],
    },
    execute: async ({ session_id }, ctx) => {
      if (!session_id) return { success: false, error: 'session_id is required' };
      try {
        const result = await qlarityCall('DELETE', `/sessions/${encodeURIComponent(session_id)}`, { orgId: ctx && ctx.orgId });
        return { success: true, session_id, closed: (result && result.closed) || session_id };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

function getQlarityToolDefinitions() {
  return Object.values(QLARITY_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function executeQlarityTool(name, input, ctx) {
  const tool = QLARITY_TOOLS[name];
  if (!tool) throw new Error(`Unknown qlarity tool: ${name}`);
  return tool.execute(input || {}, ctx || {});
}

module.exports = {
  QLARITY_TOOLS,
  getQlarityToolDefinitions,
  executeQlarityTool,
};

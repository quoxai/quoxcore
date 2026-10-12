/**
 * CommanderQ Write Tools (COMMANDERQ-P2, WRITE — governance-gated)
 *
 * Six write tools wiring CommanderQ (QUOX orchestrator) to mutation routes
 * for QuoxLens, GRC compliance and governance policy state, matching the
 * self-fetch discipline of the READ sibling (lib/commanderqReachTools.js):
 * every call is a loopback self-fetch to the collector's OWN routes
 * (http://localhost:9848) authenticated with X-Service-Key
 * (INTERNAL_SERVICE_KEY) plus x-org-id forwarded from ctx, and
 * writeCollector() never throws past a tool — network failure, timeout,
 * non-2xx status and bad JSON all resolve to an inspectable value.
 *
 * These tools are SENSITIVE. An orchestrator that auto-mutates compliance
 * state or approves policy is a serious defect, so each tool carries an
 * EXPLICIT discipline, not a default:
 *
 *  - quoxlens_accept_risk  — DIRECT, bounded (requires a real future expiry;
 *    an accepted-risk decision without one is exactly the silent-permanent-
 *    exemption failure mode the underlying route already refuses).
 *  - quoxlens_apply        — DIRECT, bounded (a judgment run, never
 *    unbounded: a hard 50,000-token budget ceiling is enforced here
 *    regardless of what the caller asks for).
 *  - compliance_create     — DIRECT, but creates a DRAFT shell only (no
 *    assertions/answers beyond what the route itself defaults to) and
 *    always follows up with an info card to the HITL inbox, because these
 *    compliance-create routes emit no AEE of their own.
 *  - compliance_update     — GATED. Content edits (fields) are direct;
 *    any status advance towards approved/complete/review is refused
 *    in-tool and filed as an approval card instead — mirrors
 *    quoxplanTools.js's quoxplan_set_status refuse-and-propose pattern.
 *  - governance_propose_policy — PROPOSE-ONLY, always. POST /api/v1/policies
 *    has no staging for creates, so this tool NEVER calls it — it only
 *    ever files an inbox proposal for a human to create the policy.
 *  - governance_change_policy  — SERVER-STAGED. PATCH/DELETE always force
 *    enforce_4eyes: true (never accepted from the caller), so the server's
 *    own 4-eyes gate stages the change (202 pending_approval) rather than
 *    applying it; a 200 (applied immediately) is surfaced as a warning.
 *
 * Intentionally NOT implemented (do not add tools for these — read the
 * reason before "fixing" this):
 *  - POST /api/v1/policies/templates/:packId/enable — enabling a policy
 *    pack has no staging path and a huge blast radius (every policy in the
 *    pack, org-wide, at once). governance_read's pack_conflicts action
 *    already gives a dry-run preview; enabling stays human-only.
 *  - POST /api/v1/policies/approvals/:entryId/resolve — resolving a 4-eyes
 *    approval is the entire point of the second-approver gate. An
 *    orchestrator resolving its own (or another agent's) staged approval
 *    would collapse the gate it is supposed to be gated by.
 */

const COLLECTOR_URL = process.env.COLLECTOR_URL || 'http://localhost:9848';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';
const { mintInboxItem } = require('./inboxMint.js');
// QUOXTRUST v1.1 PB3: authenticated ctx.orgId MUST win over caller-supplied
// input.org_id on these compliance WRITE tools (see commanderqReachTools.js).
const { resolveToolOrgId } = require('./toolExecuteOrgScope.js');
const FETCH_TIMEOUT_MS = 15000;

/** Self-fetch helper: GET/POST/PUT/PATCH/DELETE the collector's own routes
 * on loopback. Returns { ok, status, data } — `ok` mirrors res.ok, `data`
 * is the parsed JSON body (or a { raw } wrapper if the body isn't JSON).
 * Never throws; network/timeout failures resolve to
 * { ok: false, status: 0, data: { error } }. Same shape as
 * commanderqReachTools.js's readCollector — kept as a separate copy here
 * (rather than a shared import) so the read and write tool families stay
 * independently reviewable. */
async function writeCollector(path, ctx, { method = 'POST', body } = {}) {
  const url = `${COLLECTOR_URL}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Service-Key': INTERNAL_SERVICE_KEY,
    ...(ctx && ctx.orgId ? { 'x-org-id': ctx.orgId } : {}),
    ...(ctx && ctx.token ? { 'Authorization': `Bearer ${ctx.token}` } : {}),
  };
  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      try { data = { raw: await res.text() }; } catch { data = null; }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: `Collector unreachable (${err.message}). Is it running on ${COLLECTOR_URL}?` } };
  }
}

/** Files an HITL Inbox card. Mirrors quoxplanTools.js's pushQuoxplanApproval
 * shape exactly: POST to the auth service's internal inbox endpoint with
 * the service key, the given `kind` (e.g. 'approval', 'info'), and a
 * payload carrying `source: 'commanderq'` plus whatever extra fields the
 * caller wants surfaced. Returns { ok, itemId, error }; never throws. */
async function fileInboxCard({ orgId, title, bodyMd, kind = 'info', priority = 'normal', payload = {} } = {}) {
  if (!INTERNAL_SERVICE_KEY) {
    console.error('[CommanderQ write] INTERNAL_SERVICE_KEY not set — cannot file inbox card');
    return { ok: false, itemId: null, error: 'INTERNAL_SERVICE_KEY not configured' };
  }
  const org = orgId || 'system';
  // quox#562: mechanics live in lib/inboxMint.js.
  const r = await mintInboxItem({
    orgId: org, title, bodyMd, kind, priority,
    payload: { source: 'commanderq', ...payload },
  }, { authBaseUrl: AUTH_SERVICE_URL, serviceKey: INTERNAL_SERVICE_KEY });
  return { ok: r.ok, itemId: r.itemId, error: r.error };
}

// Hard ceiling for quoxlens_apply — a Lens judgment run is never allowed to
// be unbounded regardless of what the caller requests.
const MAX_APPLY_BUDGET_TOKENS = 50000;

// compliance_update: statuses that count as "advancing towards a decision"
// per artifact family — any of these must be proposed via the inbox, never
// written directly.
const GATED_STATUSES = {
  soa: ['approved', 'review'],
  dpia: ['approved', 'complete'],
  classification: ['approved', 'complete'],
};

const COMMANDERQ_WRITE_TOOLS = {

  quoxlens_accept_risk: {
    name: 'quoxlens_accept_risk',
    description: 'Record a human-reviewed "we know, we accept this, revisit later" decision on one persisted QuoxLens finding (DIRECT write, bounded — requires a real future expiry; a permanent/no-expiry acceptance is refused). Identify the finding by its stable fingerprint plus the sweep/target findings scope it belongs to.',
    input_schema: {
      type: 'object',
      properties: {
        sweep: { type: 'string', description: 'Findings sweep name' },
        target: { type: 'string', description: 'Findings target name' },
        fingerprint: { type: 'string', description: 'Stable fingerprint of the finding to accept' },
        reason: { type: 'string', description: 'Non-empty reason for accepting this risk' },
        until: { type: 'string', description: 'ISO date the acceptance expires — MUST be in the future' },
      },
      required: ['sweep', 'target', 'fingerprint', 'reason', 'until'],
    },
    execute: async (input, ctx) => {
      const { sweep, target, fingerprint, reason, until } = input;
      if (!sweep || !target || !fingerprint) return { success: false, error: 'sweep, target and fingerprint are all required' };
      if (!reason || !String(reason).trim()) return { success: false, error: 'reason is required and must be non-empty' };
      if (!until) return { success: false, error: 'until is required: an accepted risk must have an expiry' };
      const untilEpoch = new Date(until).getTime();
      if (Number.isNaN(untilEpoch)) return { success: false, error: `until is not a valid date: "${until}"` };
      if (untilEpoch <= Date.now()) return { success: false, error: `until ("${until}") must be a future date, not past or now` };
      try {
        const path = `/api/v1/lens/findings/${encodeURIComponent(sweep)}/${encodeURIComponent(target)}/accept-risk`;
        const { ok, status, data } = await writeCollector(path, ctx, { method: 'POST', body: { fingerprint, reason, until } });
        if (!ok) return { success: false, error: `QuoxLens accept-risk returned ${status}`, status, data };
        return { success: true, scope: `${sweep}/${target}`, finding: data && data.finding, summary: data && data.summary };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  quoxlens_apply: {
    name: 'quoxlens_apply',
    description: `Run one QuoxLens judgment lens against an artifact (DIRECT write, but never unbounded — a hard ${MAX_APPLY_BUDGET_TOKENS}-token budget ceiling is enforced here regardless of what is requested). Returns the verdict, findings and applied metadata for a single-lens run; panel mode is not supported.`,
    input_schema: {
      type: 'object',
      properties: {
        lens_id: { type: 'string', description: 'Lens id to apply' },
        artifact: {
          type: 'object',
          description: 'Artifact to judge: { id, kind ("text" or "record"), content }',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['id'],
        },
        depth: { type: 'string', description: 'Optional depth profile (defaults to "standard")' },
        budget: { type: 'number', description: `Optional token budget ceiling; missing or over ${MAX_APPLY_BUDGET_TOKENS} is clamped to ${MAX_APPLY_BUDGET_TOKENS}` },
      },
      required: ['lens_id', 'artifact'],
    },
    execute: async (input, ctx) => {
      const { lens_id, artifact, depth } = input;
      if (!lens_id) return { success: false, error: 'lens_id is required' };
      if (!artifact || typeof artifact !== 'object' || !artifact.id) return { success: false, error: 'artifact.id is required' };
      // Hard ceiling — never accept an unbounded or over-ceiling budget from the caller.
      const requestedBudget = typeof input.budget === 'number' ? input.budget : undefined;
      const budgetTokens = (requestedBudget === undefined || requestedBudget > MAX_APPLY_BUDGET_TOKENS)
        ? MAX_APPLY_BUDGET_TOKENS
        : requestedBudget;
      try {
        const { ok, status, data } = await writeCollector('/api/v1/lens/apply', ctx, {
          method: 'POST',
          body: { mode: 'single', lens_id, artifact, depth: depth || 'standard', budget: { max_tokens: budgetTokens } },
        });
        if (!ok) return { success: false, error: `QuoxLens apply returned ${status}`, status, data };
        return { success: true, budget_tokens_used_ceiling: budgetTokens, verdict: data && data.verdict, findings: data && data.findings, applied: data && data.applied };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  compliance_create: {
    name: 'compliance_create',
    description: 'Create a new GRC compliance artifact shell (soa, dpia, or classification) as a DRAFT — DIRECT write, but only ever a blank/draft shell, no assertions. After a successful create, files an info card to the HITL inbox so a human is notified (these create routes emit no AEE of their own).',
    input_schema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', enum: ['soa', 'dpia', 'classification'], description: 'Which compliance artifact family to create' },
        org_id: { type: 'string', description: 'Org to create under (defaults to caller org)' },
        framework: { type: 'string', description: 'soa only: framework id (defaults server-side to iso27001_2022)' },
        processing_name: { type: 'string', description: 'dpia only: name of the processing activity' },
        system_name: { type: 'string', description: 'classification only: system name' },
        answers: { type: 'object', description: 'classification only: initial answers object' },
      },
      required: ['artifact'],
    },
    execute: async (input, ctx) => {
      const { artifact } = input;
      const orgId = resolveToolOrgId(ctx, input);
      if (!['soa', 'dpia', 'classification'].includes(artifact)) return { success: false, error: `Unknown artifact "${artifact}"` };
      try {
        let path, body;
        if (artifact === 'soa') {
          path = '/api/v1/compliance/soa';
          body = { org_id: orgId, framework: input.framework };
        } else if (artifact === 'dpia') {
          path = '/api/v1/compliance/dpia';
          body = { org_id: orgId, processing_name: input.processing_name };
        } else {
          path = '/api/v1/compliance/classification';
          body = { org_id: orgId, system_name: input.system_name, answers: input.answers || {} };
        }
        const { ok, status, data } = await writeCollector(path, ctx, { method: 'POST', body });
        if (!ok) return { success: false, error: `Compliance create returned ${status}`, status, data };
        const created = (data && (data.assessment || data.dpia || data.classification)) || null;
        const createdId = created && created.id;

        const card = await fileInboxCard({
          orgId,
          title: `CommanderQ created a draft ${artifact}`,
          bodyMd: [
            `**CommanderQ created a new draft compliance artifact**`,
            '',
            `| Field | Value |`,
            `|-------|-------|`,
            `| Artifact | \`${artifact}\` |`,
            `| Id | \`${createdId || 'unknown'}\` |`,
            `| Org | \`${orgId || 'unknown'}\` |`,
            '',
            'This is a blank draft shell only — no content, controls or answers have been asserted. Review it from the dashboard.',
          ].join('\n'),
          kind: 'info',
          payload: { action: 'compliance.artifact.created', artifact, artifact_id: createdId, org_id: orgId },
        });

        return {
          success: true,
          artifact,
          created,
          info_card_filed: card.ok,
          info_card_id: card.itemId,
          note: card.ok
            ? 'A draft was created and an info card was filed to the HITL inbox so a human is notified.'
            : `A draft was created, but filing the notification card failed: ${card.error}`,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  compliance_update: {
    name: 'compliance_update',
    description: 'Update a GRC compliance artifact (soa, dpia, or classification). GATED: content edits (fields) at draft go through directly, but any status change advancing towards review/approved/complete is REFUSED here and filed as an HITL approval proposal instead — it is never written directly. Non-advancing status changes (e.g. back to draft) go through directly alongside field edits.',
    input_schema: {
      type: 'object',
      properties: {
        artifact: { type: 'string', enum: ['soa', 'dpia', 'classification'], description: 'Which compliance artifact family to update' },
        id: { type: 'string', description: 'Artifact id to update' },
        fields: { type: 'object', description: 'Content fields to update: controls (soa), sections (dpia), or answers/system_name (classification)' },
        status: { type: 'string', description: 'Optional new status' },
        org_id: { type: 'string', description: 'Org id, used only for the approval card if status is gated (defaults to caller org)' },
      },
      required: ['artifact', 'id'],
    },
    execute: async (input, ctx) => {
      const { artifact, id, fields } = input;
      const orgId = resolveToolOrgId(ctx, input);
      if (!['soa', 'dpia', 'classification'].includes(artifact)) return { success: false, error: `Unknown artifact "${artifact}"` };
      if (!id) return { success: false, error: 'id is required' };

      const status = input.status !== undefined && input.status !== null ? String(input.status).trim().toLowerCase() : undefined;
      const gatedList = GATED_STATUSES[artifact] || [];
      if (status && gatedList.includes(status)) {
        const card = await fileInboxCard({
          orgId,
          title: `CommanderQ requests ${artifact} ${id} -> ${status}`,
          bodyMd: [
            `**CommanderQ requests a compliance status change**`,
            '',
            `| Field | Value |`,
            `|-------|-------|`,
            `| Artifact | \`${artifact}\` |`,
            `| Id | \`${id}\` |`,
            `| Requested status | \`${status}\` |`,
            `| Org | \`${orgId || 'unknown'}\` |`,
            fields ? `| Fields also proposed | \`${Object.keys(fields).join(', ')}\` |` : '',
            '',
            'This status change was NOT applied. Apply it from the dashboard if approved.',
          ].filter(Boolean).join('\n'),
          kind: 'approval',
          priority: 'high',
          payload: { action: 'compliance.artifact.status_change', artifact, artifact_id: id, requested_status: status, fields: fields || null, org_id: orgId },
        });
        if (!card.ok) return { success: false, error: `Status change requires approval but filing the inbox card failed: ${card.error}` };
        return {
          success: true,
          proposed: true,
          inbox_item_id: card.itemId,
          message: 'Status change requires human approval; filed to inbox — apply from the dashboard.',
        };
      }

      try {
        const path = `/api/v1/compliance/${artifact}/${encodeURIComponent(id)}`;
        let body;
        if (artifact === 'soa') {
          body = { ...(fields && fields.controls !== undefined ? { controls: fields.controls } : fields), ...(status ? { status } : {}) };
        } else if (artifact === 'dpia') {
          body = { ...(fields && fields.sections !== undefined ? { sections: fields.sections } : fields), ...(status ? { status } : {}) };
        } else {
          body = { ...(fields || {}) };
        }
        const { ok, status: httpStatus, data } = await writeCollector(path, ctx, { method: 'PUT', body });
        if (!ok) return { success: false, error: `Compliance update returned ${httpStatus}`, status: httpStatus, data };
        return { success: true, artifact, updated: (data && (data.assessment || data.dpia || data.classification)) || data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },

  governance_propose_policy: {
    name: 'governance_propose_policy',
    description: 'Propose a NEW governance policy (PROPOSE-ONLY, always). This tool NEVER creates a policy directly — POST /api/v1/policies has no staging path for creates, so a direct call here would create a live policy with zero human review. It only ever files an HITL inbox proposal for a human to review and create from the dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Proposed policy name' },
        category: { type: 'string', description: 'Policy category' },
        effect: { type: 'string', description: 'Proposed effect (e.g. "allow" or "deny")' },
        org_id: { type: 'string', description: 'Org this policy would apply to (defaults to caller org)' },
        reason: { type: 'string', description: 'Why this policy is being proposed' },
        scope: { type: 'object', description: 'Optional proposed scope' },
        conditions: { type: 'object', description: 'Optional proposed conditions' },
        priority: { type: 'number', description: 'Optional proposed priority' },
        framework_mapping: { type: 'array', description: 'Optional proposed framework mapping' },
      },
      required: ['name', 'category', 'effect', 'reason'],
    },
    execute: async (input, ctx) => {
      const { name, category, effect, reason } = input;
      if (!name || !category || !effect) return { success: false, error: 'name, category and effect are all required' };
      if (!reason || !String(reason).trim()) return { success: false, error: 'reason is required' };
      const orgId = resolveToolOrgId(ctx, input);
      const extraFields = { ...input };
      delete extraFields.name; delete extraFields.category; delete extraFields.effect; delete extraFields.reason; delete extraFields.org_id;

      const card = await fileInboxCard({
        orgId,
        title: `CommanderQ proposes new policy: ${name}`,
        bodyMd: [
          '**CommanderQ proposes a new governance policy**',
          '',
          '| Field | Value |',
          '|-------|-------|',
          `| Name | \`${name}\` |`,
          `| Category | \`${category}\` |`,
          `| Effect | \`${effect}\` |`,
          `| Org | \`${orgId || 'unknown'}\` |`,
          `| Reason | ${reason} |`,
          Object.keys(extraFields).length > 0 ? `| Other proposed fields | \`${JSON.stringify(extraFields)}\` |` : '',
          '',
          'No policy has been created. Create it from the dashboard if approved.',
        ].filter(Boolean).join('\n'),
        kind: 'approval',
        priority: 'high',
        payload: { action: 'governance.policy.create_proposed', name, category, effect, reason, org_id: orgId, ...extraFields },
      });

      if (!card.ok) return { success: false, error: `Failed to file policy proposal: ${card.error}` };
      return {
        success: true,
        proposed: true,
        inbox_item_id: card.itemId,
        message: 'New policy filed as an inbox proposal for a human to review and create.',
      };
    },
  },

  governance_change_policy: {
    name: 'governance_change_policy',
    description: 'Update or delete an existing governance policy (SERVER-STAGED). Always forces enforce_4eyes: true server-side (never accepted from the caller), so the server\'s own second-approver gate stages the change (202 pending_approval) rather than applying it immediately. If the server unexpectedly returns 200 (applied without staging), that is surfaced as a warning, not treated as a normal success.',
    input_schema: {
      type: 'object',
      properties: {
        policy_id: { type: 'string', description: 'Policy id to change' },
        updates: { type: 'object', description: 'Fields to update (ignored if delete=true)' },
        delete: { type: 'boolean', description: 'true to delete the policy instead of updating it' },
        reason: { type: 'string', description: 'Why this change is being made' },
      },
      required: ['policy_id', 'reason'],
    },
    execute: async (input, ctx) => {
      const { policy_id, reason } = input;
      if (!policy_id) return { success: false, error: 'policy_id is required' };
      if (!reason || !String(reason).trim()) return { success: false, error: 'reason is required' };
      const isDelete = input.delete === true;
      try {
        const path = `/api/v1/policies/${encodeURIComponent(policy_id)}`;
        // enforce_4eyes is ALWAYS forced true here — never read from input —
        // so the server's second-approver gate always stages this change.
        const body = isDelete
          ? { reason, enforce_4eyes: true }
          : { ...(input.updates || {}), reason, enforce_4eyes: true };
        const { ok, status, data } = await writeCollector(path, ctx, { method: isDelete ? 'DELETE' : 'PATCH', body });
        if (!ok) return { success: false, error: `Governance ${isDelete ? 'delete' : 'update'} returned ${status}`, status, data };

        if (status === 202 && data && data.pending_approval) {
          return { success: true, staged: true, pending_approval: data.pending_approval, message: data.message || 'Change staged; awaiting second-approver review.' };
        }
        // Server returned 200/201 rather than 202 — the change was applied
        // without staging. Surface this as a warning rather than a plain
        // success: it means the 4-eyes gate did not engage as expected.
        return {
          success: true,
          staged: false,
          warning: `Expected the server to stage this change (202 pending_approval) but it returned ${status}: the change may have been applied immediately without a second approver.`,
          data,
        };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  },
};

module.exports = { COMMANDERQ_WRITE_TOOLS, fileInboxCard };

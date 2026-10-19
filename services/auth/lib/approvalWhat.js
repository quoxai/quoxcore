/**
 * APPROVAL-WHAT: every approval item must say WHAT will happen and to WHAT.
 *
 * Found 2026-10-15: the owner bulk-approved an item whose title read
 * "QUOX (API) wants to: Approval required ... (action)" with no target, so the
 * terminal showed "Approval requir…" and nothing else. Approving something you
 * cannot identify is not a decision.
 *
 * Contract, carried on the item as payload.what:
 *   action       the verb or tool ("run gemini_generate_content", "send email")
 *   target       what it acts on (host, recipient, id), OR
 *   target_none  an explicit reason there is no target ("no target: a model call
 *                that touches no host")
 *   summary      one human line saying what will happen
 *
 * An approval that cannot fill this is refused at creation (422), never minted
 * blank. Two structured shapes are still derived here because they are concrete:
 * the QuoxFlow workflow approval (separate repo: workflow, step and execution
 * ids) and a collector approval_context naming both a tool and a target.
 * This module only DESCRIBES an item; it never changes who may approve it.
 */

const GENERIC = /^(?:approval(?:\s+(?:required|needed|requested|request))?|action|n\/?a|none|unknown|tool|run(?:\s+tool)?|approve|todo|tbd)\b[\s.:!-]*$/i;
const LIMITS = { action: 120, target: 200, target_none: 200, summary: 280 };

const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function generic(s) {
  return !s || GENERIC.test(s) || /^approval (?:required|needed)\b/i.test(s);
}

/** Validate and normalise a payload.what. Returns { ok, what } or { ok:false, error }. */
export function validateWhat(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'payload.what is missing: an approval must carry { action, target or target_none, summary }' };
  }
  const action = str(raw.action);
  const target = str(raw.target);
  const targetNone = str(raw.target_none);
  const summary = str(raw.summary);
  if (generic(action)) return { ok: false, error: `payload.what.action must name the action or tool (got ${JSON.stringify(raw.action ?? null)})` };
  if (!target && !targetNone) return { ok: false, error: 'payload.what needs a target (host, recipient, id) or target_none saying why there is none' };
  if (generic(summary) || summary.length < 4) return { ok: false, error: `payload.what.summary must say in one line what will happen (got ${JSON.stringify(raw.summary ?? null)})` };
  const what = {
    action: clip(action, LIMITS.action),
    target: target ? clip(target, LIMITS.target) : null,
    ...(target ? {} : { target_none: clip(targetNone, LIMITS.target_none) }),
    summary: clip(summary, LIMITS.summary),
  };
  return { ok: true, what };
}

/** The QuoxFlow workflow approval shape (quoxflow/src/server.ts onApprovalCreated). */
function deriveQuoxflow(payload, execId) {
  const wf = str(payload.workflow_id);
  const exec = str(payload.execution_id) || str(execId);
  if (!wf || !exec || !str(payload.approval_id)) return null;
  const step = str(payload.node_id);
  return {
    action: 'continue workflow',
    target: `workflow ${wf}, execution ${exec}`,
    summary: `let workflow ${wf} continue${step ? ` past step ${step}` : ''} (execution ${exec})`,
  };
}

/**
 * The collector's structured approval_context, when it names BOTH a tool and a target. A context with
 * a tool and no target (the 2026-10-15 live blank) is not enough: it still needs an explicit payload.what.
 */
function deriveContext(payload) {
  const c = payload.approval_context;
  if (!c || typeof c !== 'object') return null;
  const m = c.method && typeof c.method === 'object' ? c.method : {};
  const tool = str(m.tool);
  const target = str(c.target) || str(m.target);
  if (!tool || !target) return null;
  const detail = str(m.command) || str(m.args);
  return { action: tool, target, summary: `${tool} on ${target}${detail ? `: ${clip(detail, 160)}` : ''}` };
}

/**
 * Resolve the description for a new approval item.
 * @returns {{ok:true, what:object}|{ok:false, error:string}}
 */
export function resolveApprovalWhat({ payload, quoxflow_execution_id = null } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (p.what != null) return validateWhat(p.what);
  const derived = deriveQuoxflow(p, quoxflow_execution_id) || deriveContext(p);
  if (derived) return validateWhat(derived);
  return validateWhat(null);
}

/** Express helper: for kind 'approval', returns the payload with `what` set, or sends 422 and returns null. */
export function describedApprovalPayload(req, res, { kind, payload, quoxflow_execution_id = null }) {
  if (kind !== 'approval') return payload;
  const r = resolveApprovalWhat({ payload, quoxflow_execution_id });
  if (!r.ok) {
    res.status(422).json({ error: 'approval_undescribed', message: `Refusing to create an approval nobody can identify: ${r.error}` });
    return null;
  }
  return { ...(payload && typeof payload === 'object' ? payload : {}), what: r.what };
}

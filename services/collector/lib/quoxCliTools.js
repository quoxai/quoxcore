'use strict';
/**
 * QUOXON-ASK lane J: the conversation can run any real quox CLI leaf for the caller.
 * Owner, 2026-10-14: "nobody is going to learn 846 commands ... lets make it do everything."
 *
 * One capability, two registered names, so every existing name-keyed governance layer
 * applies natively and nothing re-decides authorization inline (/quoxify: no parallel
 * enforcement path):
 *   quox_cli        READ leaves only. In the Default hat. D3 classes it a read.
 *   quox_cli_write  WRITE leaves, always through the shared approval gate
 *                   (AGENT_ALWAYS_PROPOSE_TOOLS), which lets a direct human ask for THIS
 *                   change run with no card (J2, approvalGate.quoxCliDirectAuthorizes);
 *                   IMMEDIATE leaves (safety estop) run at once. Privileged hats only.
 *                   D3 classes it a write.
 * NEVER leaves are refused by both, with the reason.
 *
 * Identity: the caller's own bearer and org (ctx.token, ctx.orgId), in a private temp
 * profile, never the service key, never a model-supplied org (lib/quoxCli/runner.js).
 * Validation: the CLI's own command tree (lib/quoxCli/validate.js). Policy:
 * lib/quoxCli/policy.js. Output: capped and redacted (lib/quoxCli/redact.js).
 *
 * An approved write executes on the caller's NEXT turn (re-invoked with _approvalId),
 * because only a live turn carries the caller's bearer; the async inbox resume leaves the
 * grant unclaimed for it (toolResume.js CALLER_SESSION_RESUME_TOOLS). The grant stays
 * bound to the approved input, the tool, the org and the user who asked, and runs once.
 *
 * Evidence, per call (executed, refused or held): a content-free receipt on the
 * mandatory channel (system.tools: leaf, option names, argv digest, class, caller, org,
 * exit code, duration) and the full argv on the transcript channel (audit.system), both
 * WARD-witnessed by storeAuditEnvelope. Output is never witnessed.
 */

const crypto = require('node:crypto');
const { loadTree, loadPolicy, classifyLeaf, classifyCall } = require('./quoxCli/policy.js');
const { buildCall, displayCommand } = require('./quoxCli/validate.js');
const { runCli } = require('./quoxCli/runner.js');
const { redactOutput, scrubString } = require('./quoxCli/redact.js');

const READ_TOOL = 'quox_cli';
const WRITE_TOOL = 'quox_cli_write';
const STDERR_RETURN = 2000;

let _storeAuditEnvelope = () => {};
/** Wire in the server's storeAuditEnvelope (WARD-witnessed). Call once at startup. */
function setQuoxCliAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

// One quox_cli call at a time per turn (keyed by the conversation/session).
const inFlight = new Set();
function turnKey(ctx) {
  return String(ctx.conversationId || ctx.session_id || ctx.turnId || `${ctx.orgId}:${ctx.userId || ''}`);
}

/**
 * Why the turn's bearer must not be forwarded, or null when it is the caller's own
 * session token for this org. A pre-flight only: the services verify the token on every
 * request the CLI makes; this stops the wrong KIND of bearer ever reaching the CLI.
 *  - a service key that arrived as the bearer (POST /api/v1/tools/execute service callers);
 *  - anything that is not a JWT;
 *  - the Claude CLI turn token (aud quox:tools-execute, lib/turnToken.js): it is scoped to
 *    tool execution, not the caller's whole session, so the CLI cannot act on it;
 *  - a token bound to another org than the turn's.
 */
function callerBearerProblem(ctx) {
  const token = String(ctx.token || '');
  const serviceKeys = [process.env.INTERNAL_SERVICE_KEY, process.env.QUOX_SERVICE_KEY].filter(Boolean);
  if (serviceKeys.includes(token)) return 'quox_cli never uses a service key; it runs only with a signed-in user\'s own session.';
  const parts = token.split('.');
  if (parts.length !== 3) return 'quox_cli needs a signed-in user\'s session token.';
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return 'quox_cli needs a signed-in user\'s session token.'; }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.includes('quox:tools-execute')) {
    // QUOXON-ASK J2: tools/execute swaps a live turn's token for the caller's held bearer
    // (lib/turnBearerStore.js). Reaching here means the turn has ended or expired.
    return 'quox_cli could not run: the conversation turn that asked for it has ended or expired. Ask again.';
  }
  if (claims.org_id && String(claims.org_id) !== String(ctx.orgId)) return 'Your session token is for a different organization than this conversation; quox_cli runs only in the conversation\'s organization.';
  return null;
}

function stripControl(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/** The full argv: forced --json (and --yes for an approved or immediate write), globally and at the leaf when it declares its own. */
function fullArgv(built, cls) {
  const leafArgv = [...built.leafArgv];
  const pathLen = built.leaf.path.length;
  const leafHas = (long) => built.leaf.options.some((o) => o.long === long);
  const injectAtLeaf = [];
  if (leafHas('--json') && !leafArgv.includes('--json')) injectAtLeaf.push('--json');
  const runsNonInteractive = cls.class === 'write' || cls.class === 'immediate';
  if (runsNonInteractive && leafHas('--yes') && !leafArgv.includes('--yes')) injectAtLeaf.push('--yes');
  leafArgv.splice(pathLen, 0, ...injectAtLeaf);
  return ['--json', ...(runsNonInteractive ? ['--yes'] : []), ...leafArgv];
}

function witness({ toolName, ctx, built, cls, argv, disposition, exitCode = null, durationMs = null, truncated = false, outputBytes = null, approvalId = null, reason = null }) {
  const common = {
    tool: toolName,
    leaf: built ? `quox ${built.pathKey}` : null,
    class: cls ? cls.class : null,
    class_source: cls ? cls.source : null,
    disposition,
    caller: ctx.userId || null,
    org: ctx.orgId || null,
    agent: ctx.agentId || null,
    conversation: ctx.conversationId || ctx.session_id || null,
    exit_code: exitCode,
    duration_ms: durationMs,
    ...(approvalId ? { approval_id: approvalId } : {}),
    ...(reason ? { reason: String(reason).slice(0, 200) } : {}),
  };
  try {
    // Mandatory, content-free: what ran, never what it said.
    _storeAuditEnvelope({
      intent: `quox.cli.${disposition}`,
      from: `agent.${ctx.agentId || 'quox'}`,
      to: 'system.tools',
      org_id: ctx.orgId || null,
      corr: ctx.conversationId || ctx.session_id || undefined,
      payload: {
        ...common,
        option_names: argv ? argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]) : [],
        argv_sha256: argv ? crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex') : null,
        output_bytes: outputBytes,
        truncated,
      },
    });
    // The exact command line, on the transcript channel (follows the org privacy setting).
    if (argv) {
      _storeAuditEnvelope({
        intent: `quox.cli.${disposition}.argv`,
        from: `agent.${ctx.agentId || 'quox'}`,
        to: 'audit.system',
        org_id: ctx.orgId || null,
        corr: ctx.conversationId || ctx.session_id || undefined,
        payload: { ...common, argv: ['quox', ...argv] },
      });
    }
  } catch (err) {
    console.warn('[quox_cli] evidence emit failed (non-fatal):', err && err.message);
  }
}

/** The last line(s) of a CLI failure worth showing: an error JSON's message, else the text tail. */
function failureText(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i !== -1 && j > i) {
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      const m = o && ((typeof o.message === 'string' && o.message) || (typeof o.error === 'string' && o.error) || (o.error && typeof o.error.message === 'string' && o.error.message));
      if (m) return String(m);
    } catch { /* not JSON: use the text */ }
  }
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^at\s/.test(l));
  return lines.slice(-3).join(' ').replace(/^(?:Error|error):\s*/, '');
}

/**
 * quox#882: a failed run always says which command, how it ended and why, so the model and
 * the tool.finished receipt never read an empty "failed".
 */
function failureReason(built, r, secrets) {
  const cmd = `quox ${built.pathKey}`;
  if (r.timedOut) return `${cmd} ran past its time limit (${Math.round((r.durationMs || 0) / 1000)} s) and was stopped.`;
  if (r.error) return `${cmd} could not start: ${scrubString(String(r.error), secrets).slice(0, 300)}`;
  const how = r.exitCode != null ? `exited with code ${r.exitCode}` : `was stopped by ${r.signal || 'a signal'}`;
  const why = scrubString(failureText(r.stderr) || failureText(r.stdout), secrets).slice(0, 400);
  return `${cmd} ${how}: ${why || 'no output'}`;
}

function refuse(toolName, ctx, { built = null, cls = null, argv = null, error, reason, extra = {} }) {
  witness({ toolName, ctx, built, cls, argv, disposition: 'refused', reason: reason || error });
  return { success: false, refused: true, error, ...extra };
}

/**
 * Plan one call without running it: validation, class and the exact argv. Shared by
 * execute and by the approval card (approvalGate.buildAgentGateProposal).
 */
function planCall(input, { tree = loadTree(), policy = loadPolicy() } = {}) {
  const built = buildCall(stripControl(input), { tree });
  if (!built.ok) return { ok: false, error: built.error };
  const leafCls = classifyLeaf(built.pathKey, { tree, policy });
  if (built.help) {
    // --help only prints the leaf's usage: a read on any leaf except a never one (the floor stands).
    if (leafCls.class === 'never') return { ok: true, built, cls: leafCls, argv: [...built.leafArgv] };
    return { ok: true, built, cls: { class: 'read', reason: 'prints the command\'s help only', source: 'help' }, argv: [...built.leafArgv] };
  }
  const cls = classifyCall(leafCls, built.leafArgv, built.pathKey);
  return { ok: true, built, cls, argv: fullArgv(built, cls) };
}

async function executeQuoxCli(toolName, input, ctx = {}, deps = {}) {
  const run = deps.runCli || runCli;
  const gate = deps.withApprovalGate || ((...a) => require('./approvalGate.js').withApprovalGate(...a));
  const store = deps.toolApprovalStore || require('./toolApprovalStore.js');

  if (!ctx.orgId || !ctx.token) {
    return refuse(toolName, ctx, { error: 'quox_cli runs as the signed-in user: it needs a user session with an organization, and never uses a service key.', reason: 'no_user_session' });
  }
  const bearerProblem = callerBearerProblem(ctx);
  if (bearerProblem) return refuse(toolName, ctx, { error: bearerProblem, reason: 'bearer_refused' });
  const plan = planCall(input || {}, deps);
  if (!plan.ok) {
    // J2: answer a wrong guess with the closest real commands (lib/quoxCli/candidates.js).
    let candidates = [];
    try {
      const ask = [...((input && input.path) || []), ...((input && input.positional) || [])].join(' ');
      candidates = require('./quoxCli/candidates.js').rankCandidateLeaves(ask, { k: 5 }).candidates.map(({ leaf, class: cls, description }) => ({ leaf, class: cls, description }));
    } catch { /* suggestions are best-effort */ }
    return refuse(toolName, ctx, { error: plan.error, reason: 'invalid', extra: candidates.length ? { candidates } : {} });
  }
  const { built, cls, argv } = plan;
  const cmd = displayCommand(argv);

  if (cls.class === 'never') {
    return refuse(toolName, ctx, { built, cls, argv, error: `quox ${built.pathKey} is not available from a conversation: ${cls.reason}.`, reason: cls.reason });
  }
  if (toolName === READ_TOOL && cls.class !== 'read') {
    return refuse(toolName, ctx, {
      built, cls, argv,
      error: `quox ${built.pathKey} changes state (${cls.reason}). Use quox_cli_write with the same input; it asks for your approval first${cls.class === 'immediate' ? ' (an emergency stop runs at once)' : ''}.`,
      reason: 'needs_write_tool',
      extra: { use_tool: WRITE_TOOL },
    });
  }
  if (toolName === WRITE_TOOL && cls.class === 'read') {
    return refuse(toolName, ctx, { built, cls, argv, error: `quox ${built.pathKey} only reads. Use quox_cli with the same input.`, reason: 'needs_read_tool', extra: { use_tool: READ_TOOL } });
  }

  const execute = async (approvalId = null) => {
    const key = turnKey(ctx);
    if (inFlight.has(key)) {
      return refuse(toolName, ctx, { built, cls, argv, error: 'Another quox_cli call is still running in this turn. Wait for its result, then call again.', reason: 'concurrent_call' });
    }
    inFlight.add(key);
    try {
      const r = await run({ argv, token: ctx.token, orgId: ctx.orgId, ...(deps.runOptions || {}) });
      const secrets = [ctx.token];
      const red = redactOutput(r.stdout, { exactSecrets: secrets, truncated: r.truncated });
      const disposition = r.timedOut ? 'timed_out' : 'executed';
      witness({ toolName, ctx, built, cls, argv, disposition, exitCode: r.exitCode, durationMs: r.durationMs, truncated: r.truncated, outputBytes: red.bytes, approvalId });
      // The runner SIGKILLs the child at the output cap (truncated, no exit code): that is a
      // complete-enough read with a narrow-it note, not a failure (quox#882: `voice calls` failed first, then
      // the model retried narrower).
      const cappedByRunner = r.truncated && r.exitCode == null && r.signal === 'SIGKILL';
      const ok = (r.exitCode === 0 || cappedByRunner) && !r.timedOut && !r.error;
      const failure = ok ? null : failureReason(built, r, secrets);
      return {
        success: ok,
        command: cmd,
        class: cls.class,
        exit_code: r.exitCode,
        duration_ms: r.durationMs,
        output: red.output,
        format: red.format,
        ...(r.truncated ? { truncated: true, note: `Output stopped at ${Math.round(red.bytes / 1024)} KB; narrow the query (--limit, filters).` } : {}),
        ...(failure ? { error: failure } : {}),
        ...(!ok && r.stderr ? { stderr: scrubString(r.stderr, secrets).slice(0, STDERR_RETURN) } : {}),
        ...(approvalId ? { _approval: { id: approvalId, status: 'approved' } } : {}),
      };
    } finally {
      inFlight.delete(key);
    }
  };

  if (cls.class === 'read' || cls.class === 'immediate') return execute();

  // WRITE: the shared approval gate decides; this closure runs only once a human approved.
  const approvalId = input && input._approvalId ? String(input._approvalId) : null;
  const result = await gate(WRITE_TOOL, input, async () => {
    if (approvalId) {
      const row = store.getByApprovalId(approvalId);
      if (row && row.user_id && ctx.userId && String(row.user_id) !== String(ctx.userId)) {
        return refuse(toolName, ctx, { built, cls, argv, error: 'This approval was given for another person\'s request; it runs only in their session.', reason: 'approval_user_mismatch' });
      }
    }
    return execute(approvalId);
  }, ctx);
  if (result && result.pending) {
    witness({ toolName, ctx, built, cls, argv, disposition: 'held', approvalId: result.approvalId || (result._approval && result._approval.id) || null });
    return {
      ...result,
      command: cmd,
      class: 'write',
      message: `${result.message || 'Approval required.'} Nothing has run. Once it is approved, call quox_cli_write again with the same input plus _approvalId to run it once, as you.`,
    };
  }
  return result;
}

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'array', items: { type: 'string' }, description: 'The command words, e.g. ["inbox","list"] for `quox inbox list`. To learn a command\'s options, send args {"help":true} alone (works on any command that is not refused).' },
    args: { type: 'object', description: 'Named flags by long name without dashes, e.g. {"status":"pending","limit":5}; true for a bare flag.' },
    positional: { type: 'array', items: { type: 'string' }, description: 'Positional arguments in order, e.g. an id.' },
  },
  required: ['path'],
};

const QUOX_CLI_TOOLS = {
  [READ_TOOL]: {
    name: READ_TOOL,
    description: 'Run a read-only quox CLI command as the signed-in user, in this org, and get its JSON output. Use it for anything the CLI can read that no dedicated tool covers; prefer a dedicated tool when one exists. Commands that change state are refused here (use quox_cli_write). Answer straight from the JSON it returns and never post-process it with a shell (no jq, grep, python, cat, sed, awk or pipes). Large output: use --select/--summary, never a shell pipe.',
    input_schema: INPUT_SCHEMA,
    execute: (input, ctx) => executeQuoxCli(READ_TOOL, input, ctx || {}),
  },
  [WRITE_TOOL]: {
    name: WRITE_TOOL,
    description: 'Run a quox CLI command that changes state, as the signed-in user, in this org. When the user asked for this change themselves it runs at once; otherwise it files an approval card first and runs once after approval (an emergency stop runs at once). Use it when the user asks for a change and no dedicated tool does it. It already runs as them: do not ask who they are, and use the names they gave (slot, session, host) as given. Answer straight from the JSON it returns and never post-process it with a shell (no jq, grep, python, cat, sed, awk or pipes). Large output: use --select/--summary, never a shell pipe.',
    input_schema: { ...INPUT_SCHEMA, properties: { ...INPUT_SCHEMA.properties, _approvalId: { type: 'string', description: 'After approval: the approval id, to run the approved command.' } } },
    execute: (input, ctx) => executeQuoxCli(WRITE_TOOL, input, ctx || {}),
  },
};

/** The approval card for quox_cli_write: the exact command line, what it does, who it runs as. */
function describeProposal(input, ctx = {}) {
  const agentLabel = String(ctx.agentId || 'agent').toUpperCase();
  const plan = planCall(input || {});
  if (!plan.ok) {
    return { targetId: 'quox CLI', reason: '', title: `${agentLabel} proposes a quox CLI command`, bodyMd: `**${agentLabel}** proposes a quox CLI command that did not validate (${plan.error}). Deny it.` };
  }
  const cmd = displayCommand(plan.argv);
  const longestTicks = Math.max(2, ...(cmd.match(/`+/g) || ['']).map((t) => t.length));
  const fence = '`'.repeat(longestTicks + 1);
  const what = plan.built.leaf.description || `quox ${plan.built.pathKey}`;
  const bodyMd = `**${agentLabel}** asks to run this command for you:\n\n${fence}\n${cmd}\n${fence}\n\n`
    + `- What it does: ${what}\n- Why it needs approval: ${plan.cls.reason}\n`
    + '- Runs once, as you, in this organization, non-interactively (--yes). Nothing has run yet.\n\n'
    + 'Approve to let it run on your next message in that conversation, or deny it.';
  return { targetId: `quox ${plan.built.pathKey}`, reason: '', title: `${agentLabel} proposes: quox ${plan.built.pathKey}`, bodyMd };
}

const SECRET_FLAG = /(token|secret|password|passwd|key|pin|otp|credential|auth|bearer|jwt|cookie)/i;
/** One masked line for a card: `quox contacts add-id C1 --email x`. Never throws. */
function summarizeWriteCall(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const plan = planCall(inp);
  const q = (a) => (/^[A-Za-z0-9_./:@,+-]+$/.test(a) ? a : JSON.stringify(a));
  if (!plan.ok) {
    const words = [...(Array.isArray(inp.path) ? inp.path : []), ...(Array.isArray(inp.positional) ? inp.positional : [])].map(String);
    return words.length ? displayCommand(words) : null;
  }
  const path = [], pos = [], flags = [];
  let afterDash = false;
  for (const raw of plan.built.leafArgv) {
    const a = String(raw);
    if (afterDash) { pos.push(a); continue; }
    if (a === '--') { afterDash = true; continue; }
    const m = a.match(/^(--[^=]+)(?:=([\s\S]*))?$/);
    if (m) flags.push(m[2] === undefined ? m[1] : `${m[1]} ${SECRET_FLAG.test(m[1]) ? '[hidden]' : q(m[2])}`);
    else if (!flags.length) path.push(a);
    else pos.push(a);
  }
  return ['quox', ...path, ...pos.map(q), ...flags].join(' ');
}

module.exports = {
  summarizeWriteCall,
  QUOX_CLI_TOOLS,
  READ_TOOL,
  WRITE_TOOL,
  executeQuoxCli,
  callerBearerProblem,
  planCall,
  describeProposal,
  setQuoxCliAuditFn,
  _inFlight: inFlight,
};

'use strict';

/**
 * QUOX-SECURITY Phase 1: the real capability tools (subfinder/httpx/nuclei/
 * dig/openssl), wiring checkEngagementPolicy (Phase 0's real policy gate,
 * built but never exercised by a real capability call until this file) to
 * securityCliExecutor (Phase 1's real command builder).
 *
 * Every call: (1) resolves org_id from ctx only, never agent input, (2)
 * checks policy against the real engagement/target state in security.db,
 * (3) on denial returns { success:false, allowed:false, error } WITHOUT
 * ever building or attempting a command, (4) on approval, builds the real
 * shell command and calls the configured scan host via bastion.
 *
 * No SECURITY_SCAN_HOST exists tonight (no real target, deferred to when
 * sectest.quox.ai lands). An approved call surfaces an honest "not
 * configured" error rather than a fabricated success, this is Phase 1's
 * actual safety boundary in the absence of a target, not a coverage gap.
 *
 * All 3 tools are capped at discovery/safe_active risk (matches the plan's
 * own Phase 1 Core scope: "staging/dev targets only, risk_ceiling capped at
 * discovery/safe_active"), so none crosses requiresApprovalForRisk's
 * intrusive threshold, no HITL wiring needed for this increment.
 */

const securityEngagement = require('./securityEngagement.js');
const securityScanJobs = require('./securityScanJobs.js');
const securityEngagementSchedules = require('./securityEngagementSchedules.js');
const { executeCliTool } = require('./securityCliExecutor.js');
const { diffScanResults } = require('./securityScanDiff.js');
const { alertOnNewFindings: defaultAlertOnNewFindings } = require('./securityScheduleAlerts.js');
const securityScheduledFindings = require('./securityScheduledFindings.js');

// 2026-08-11: 6 more tools added (nmap/sslscan/whatweb/ffuf/gitleaks/trivy),
// same policy-gate-before-command discipline as the original 5. See each
// tool's own comments for anything tool-specific (ffuf's fixed wordlist,
// gitleaks'/trivy's honest target-type gap).
const BASTION_URL = process.env.BASTION_URL || '';
const BASTION_TOKEN = process.env.BASTION_API_TOKEN || '';
const { BASTION_UNAVAILABLE_MESSAGE } = require('./bastionUnavailable');

// Sync-path default. Found live 2026-08-10/11: a real sectest_vuln_scan
// (nuclei) default-template run genuinely takes longer than this, that's
// exactly why the async job path (runCapabilityJobInBackground) exists and
// requests ASYNC_JOB_TIMEOUT_MS instead, not a reason to raise this one,
// which still bounds every synchronous, HTTP-response-blocking call.
const DEFAULT_CALL_TIMEOUT_MS = 30000;
// Generous, not unlimited: an async job still shouldn't hang forever if
// bastion itself wedges. 5 minutes covers a real nuclei default-template
// scan against one host with headroom.
const ASYNC_JOB_TIMEOUT_MS = 300000;

/** Same logic as callBastion in agentTools.js / bastionSshExecutor.js,
 * duplicated to avoid circular deps (established pattern in this codebase). */
async function defaultCallBastion(hostId, command, options = {}) {
  if (!BASTION_URL || !BASTION_TOKEN) {
    return { success: false, error: BASTION_UNAVAILABLE_MESSAGE };
  }
  try {
    // Found live 2026-08-10/11: passing timeoutMs to AbortSignal.timeout()
    // only bounds how long THIS client waits, it does not change Bastion's
    // own server-side exec deadline (internal/config's CommandTimeout,
    // 60s default), which was silently killing the connection first on a
    // real nuclei run. Bastion's /api/v1/exec accepts an optional `timeout`
    // (whole seconds) in the request body specifically to override that;
    // must be sent whenever a caller wants more than Bastion's own default.
    const body = { targets: [hostId], command };
    if (options.timeoutMs !== undefined) body.timeout = Math.ceil(options.timeoutMs / 1000);
    // QUOXTRUST T4/T9 (#626): attach the collector-signed HITL approval grant
    // when the caller minted one (makeGrantAwareSecurityCallBastion). Omitted
    // entirely when absent — a mode:risky bastion then 403s honestly, which is
    // the fail-closed outcome, never a fabricated pass.
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${BASTION_TOKEN}` };
    if (options.grant) headers['X-Bastion-Approval-Grant'] = options.grant;
    const resp = await fetch(`${BASTION_URL}/api/v1/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return require("./bastionRefusal.js").bastionHttpErrorResult(resp.status, text); // #815: a 403 is a refusal, never an approval card
    }
    const data = await resp.json();
    const r = data.results && data.results[0];
    if (!r) return data;
    return {
      success: r.exit_code === 0,
      exit_code: r.exit_code,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error || (r.exit_code !== 0 ? r.stderr : undefined),
      duration_ms: r.duration_ms,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * QUOXTRUST T4/T9 (#626): wrap a base callBastion so a scan that runs under an
 * approved HITL item (ctx.hitlApprovedItemId) mints a collector-signed grant
 * bound to the EXACT command + resolved scan host and threads it into the base
 * call's options (defaultCallBastion attaches it as X-Bastion-Approval-Grant).
 * The security-path twin of makeGrantAwareCallBastion in agentTools.js, adapted
 * to securityCliExecutor's (host, command, options) callBastion contract.
 *
 * FAIL CLOSED: a mint that throws grant_mint_failed (auth unreachable / stale /
 * denied approved item) returns an error WITHOUT calling bastion — never an
 * ungranted exec. No approved item -> mintFn returns null -> the base call runs
 * grant-less and a mode:risky bastion enforces (an honest 403), never a
 * fabricated pass. Any other mint error is re-thrown (never swallowed, still no
 * ungranted exec).
 *
 * mintFn defaults to bastionSshExecutor's mintGrantForCtx, lazily required to
 * avoid a module-init cycle (agentTools.js requires this module at load).
 */
function makeGrantAwareSecurityCallBastion(ctx, baseCallBastion, mintFn) {
  let mint = mintFn;
  if (!mint) {
    // Lazy require: this module is required by agentTools.js at load, so a
    // top-level require of bastionSshExecutor could cycle. Resolving here (at
    // scan-execution time) is cycle-safe.
    mint = require('./bastionSshExecutor.js')._internal.mintGrantForCtx;
  }
  return async function grantAwareSecurityCallBastion(host, command, options = {}) {
    let grant = null;
    try {
      grant = await mint(ctx, { action: 'exec', command, targets: [host] });
    } catch (err) {
      if (err && err.code === 'grant_mint_failed') {
        return { success: false, error: `approval grant mint failed: ${err.message}` };
      }
      throw err;
    }
    return baseCallBastion(host, command, grant ? { ...options, grant } : options);
  };
}

/**
 * QUOXTRUST #626 (A): build the mintFn that makeGrantAwareSecurityCallBastion
 * calls. A governed scan is anchored to its ACTIVE engagement (not a HITL inbox
 * item — discovery/safe_active scans raise no card), so this mints via the
 * engagement path (auth re-validates the engagement authorization before
 * signing). FAIL CLOSED: a null/failed mint throws grant_mint_failed, which the
 * wrapper turns into a refusal WITHOUT calling bastion (no ungranted scan).
 * Lazily requires bastionSshExecutor to avoid the module-init cycle.
 */
function makeEngagementMintFn({ engagementId, target, capabilityRisk }) {
  return async function engagementMint(ctx, spec) {
    // Injectable (tests) with a lazy fallback to the real minter (avoids the
    // module-init cycle: agentTools.js requires this module).
    const mint = (_deps && _deps.mintEngagementGrant)
      || require('./bastionSshExecutor.js')._internal.mintEngagementGrant;
    const grant = await mint({
      orgId: ctx && ctx.orgId,
      engagementId,
      command: spec.command,
      targets: spec.targets,
      target,
      capabilityRisk,
    });
    if (!grant) {
      // FAIL CLOSED: a governed scan is authorized by its engagement, so an
      // un-mintable grant (auth down/denied) must not run — never an ungranted
      // scan. The wrapper turns this into a refusal without calling bastion.
      const err = new Error(
        `engagement grant mint failed for engagement ${engagementId} (target ${target}, risk ${capabilityRisk}) — refusing to run an ungranted scan.`,
      );
      err.code = 'grant_mint_failed';
      throw err;
    }
    return grant;
  };
}

// Fixed, not caller-suppliable (see sectest_fuzz_content's buildInput
// comment). dirb's bundled common.txt is a standard Kali/most-distros path;
// see the kali01-as-scan-host recommendation in the report.
const FFUF_DEFAULT_WORDLIST = '/usr/share/wordlists/dirb/common.txt';

// QUOX-SECURITY COVERAGE Phase 2: the curated set sectest_discover_app_ports
// probes on a bare host. Deliberately a fixed, config-authored list (not
// caller-suppliable), same reasoning as FFUF_DEFAULT_WORDLIST: it keeps the
// argument surface httpx sees fully known. Covers the standard web ports plus
// the common app-dev ports a nuclei :80/:443-only sweep silently misses,
// including 3000+3001 (the .60 app ports that read false-clean pre-Phase-1).
const DEFAULT_WEB_PORTS = '80,443,3000,3001,4200,5000,5173,8000,8008,8080,8443,8888,9000,9090';

let _deps = { db: null, callBastion: defaultCallBastion, scanHost: process.env.SECURITY_SCAN_HOST || '', mintEngagementGrant: null };

/** @param {{db, callBastion?: Function, scanHost?: string}} deps */
function configure(deps) {
  _deps = { ..._deps, ...deps };
}

function requireDb() {
  if (!_deps.db) throw new Error('security.db not configured (call configure({db}) at server boot)');
  return _deps.db;
}

/**
 * Resolves the GitHub token/fetch pair the scheduled-findings auto-filer needs,
 * in the same vault->config->env chain routes/github-proxy.js owns. Injected
 * deps win (tests), then configured deps, then a lazy require of the proxy
 * (mirrors how server.js pulls these inline rather than importing at module
 * top, avoiding a heavy/circular load path). Returns undefineds when the proxy
 * can't be loaded; the auto-filer fails soft on that.
 */
function resolveGithubFns(deps = {}) {
  if (deps.getGitHubToken && deps.ghFetch) {
    return { getGitHubToken: deps.getGitHubToken, ghFetch: deps.ghFetch };
  }
  if (_deps.getGitHubToken && _deps.ghFetch) {
    return { getGitHubToken: _deps.getGitHubToken, ghFetch: _deps.ghFetch };
  }
  try {
    const gh = require('../routes/github-proxy.js');
    return { getGitHubToken: gh.getGitHubToken, ghFetch: gh.ghFetch };
  } catch {
    return { getGitHubToken: undefined, ghFetch: undefined };
  }
}

// Duplicated cli/parameters shape rather than read from an entity JSON,
// matching bastionSshExecutor.js's established convention: entity JSON (if
// any) is agent-discovery metadata, the executor JS is the actual execution
// logic, independently maintained.
const CAPABILITY_TOOLS = {
  sectest_discover_hosts: {
    name: 'sectest_discover_hosts',
    description: 'Passive subdomain enumeration (subfinder) for a verified, in-scope target. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'Reconnaissance',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope domain to enumerate' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'subfinder', arg_template: ['-d', '{target}', '-silent'], output_format: 'lines' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_probe_http: {
    name: 'sectest_probe_http',
    description: 'HTTP/HTTPS service probing (httpx) for a verified, in-scope target. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'Web & TLS',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope host or domain to probe' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'httpx', arg_template: ['-u', '{target}', '-silent', '-json'], output_format: 'lines' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_discover_app_ports: {
    name: 'sectest_discover_app_ports',
    description: 'App-port discovery (httpx over a curated port set) for a verified, in-scope host. Finds which common web/app ports actually serve HTTP(S), so a scan hits the real surface instead of only :80/:443. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'Reconnaissance',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope bare host or CIDR to probe (not a url-type value)' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'httpx', arg_template: ['-u', '{target}', '-p', '{ports}', '-json', '-silent', '-follow-redirects'], output_format: 'lines' },
    parameters: { target: { type: 'string', required: true }, ports: { type: 'string', required: true } },
    // The port list is fixed and config-authored, never caller-suppliable
    // (same reasoning as sectest_fuzz_content's wordlist): keeps httpx's
    // argument surface fully known. buildInput composes the two whole-segment
    // values the arg_template substitutes; the stored/scoped target stays the
    // bare host, which is exactly what httpx -u wants.
    buildInput: (rawTarget) => ({ target: rawTarget, ports: DEFAULT_WEB_PORTS }),
  },

  sectest_vuln_scan: {
    name: 'sectest_vuln_scan',
    description: 'Template-based vulnerability scanning (nuclei) for a verified, in-scope target. Requires an engagement whose risk_ceiling is safe_active or above (more invasive than passive discovery).',
    capabilityRisk: 'safe_active',
    category: 'Offensive',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope host or URL to scan' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'nuclei', arg_template: ['-u', '{target}', '-silent', '-jsonl'], output_format: 'lines' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_resolve_dns: {
    name: 'sectest_resolve_dns',
    description: 'DNS resolution (dig +short) for a verified, in-scope target. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'Reconnaissance',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope domain to resolve' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'dig', arg_template: ['+short', '{target}'], output_format: 'lines' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_inspect_tls: {
    name: 'sectest_inspect_tls',
    description: 'TLS/certificate inspection (openssl s_client) for a verified, in-scope target on port 443. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'Web & TLS',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope host to inspect (port 443 assumed)' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'openssl', arg_template: ['s_client', '-connect', '{target}', '-servername', '{servername}'], output_format: 'raw' },
    parameters: { target: { type: 'string', required: true }, servername: { type: 'string', required: true } },
    // openssl s_client's -connect takes host:port as one token, buildCommand
    // only substitutes a whole templated segment, it cannot concatenate a
    // literal ":443" onto a placeholder mid-string. Constructing the two
    // distinct values (target:443, and the bare hostname for -servername)
    // here, in the caller, keeps securityCliExecutor's substitution rule
    // simple (whole-segment only) rather than growing it a string-interp
    // feature for one tool.
    buildInput: (rawTarget) => ({ target: `${rawTarget}:443`, servername: rawTarget }),
  },

  sectest_port_scan: {
    name: 'sectest_port_scan',
    description: 'Network port/service version scan (nmap -sV, top ports) for a verified, in-scope target. Requires an engagement whose risk_ceiling is safe_active or above (actively connects to many ports, more than passive discovery).',
    capabilityRisk: 'safe_active',
    category: 'Network',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope host or CIDR to scan' },
      },
      required: ['engagement_id', 'target'],
    },
    // -sV: service/version detection. -T4: faster timing (still safe_active,
    // not exploit_emulation). --top-ports 100: bounded scope rather than a
    // full 65535-port sweep, matching this tool's declared safe_active risk.
    cli: { binary: 'nmap', arg_template: ['-sV', '-T4', '--top-ports', '100', '{target}'], output_format: 'raw' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_ssl_scan: {
    name: 'sectest_ssl_scan',
    description: 'Deep TLS/cipher-suite inspection (sslscan) for a verified, in-scope target. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'Web & TLS',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope host to inspect (sslscan defaults to port 443 if none given)' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'sslscan', arg_template: ['--no-colour', '{target}'], output_format: 'raw' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_fingerprint_web: {
    name: 'sectest_fingerprint_web',
    description: 'Web technology fingerprinting (whatweb) for a verified, in-scope target. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'Reconnaissance',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope host or URL to fingerprint' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: { binary: 'whatweb', arg_template: ['--color=never', '{target}'], output_format: 'raw' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_fuzz_content: {
    name: 'sectest_fuzz_content',
    // Arguably intrusive (many requests against every discovered path), but
    // kept at safe_active for Phase 1 scope per the plan's own "staging/dev
    // targets only, risk_ceiling capped at discovery/safe_active" language;
    // revisit if/when an intrusive tier actually ships (Phase 4).
    description: 'HTTP content/directory discovery (ffuf) against a verified, in-scope target using a bundled wordlist. Requires an engagement whose risk_ceiling is safe_active or above (actively requests many paths, more than passive discovery).',
    capabilityRisk: 'safe_active',
    category: 'Web & TLS',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope base URL to fuzz (FUZZ keyword appended automatically)' },
      },
      required: ['engagement_id', 'target'],
    },
    cli: {
      binary: 'ffuf',
      arg_template: ['-u', '{fuzz_url}', '-w', '{wordlist}', '-mc', '200,204,301,302,307,401,403', '-s'],
      output_format: 'lines',
    },
    parameters: { fuzz_url: { type: 'string', required: true }, wordlist: { type: 'string', required: true } },
    // wordlist is fixed, never caller-suppliable: an attacker-controlled
    // wordlist path would be an unnecessary widening of the
    // argument-injection surface securityCliExecutor already guards against
    // for "-"-prefixed values. FFUF_DEFAULT_WORDLIST is a common dirb-style
    // path; see the kali01-as-scan-host note in the report for why this is
    // likely to already exist there rather than needing hand-installing.
    buildInput: (rawTarget) => ({ fuzz_url: `${rawTarget.replace(/\/$/, '')}/FUZZ`, wordlist: FFUF_DEFAULT_WORDLIST }),
  },

  // --- DevSecOps (2026-08-11): both participate in the exact same
  // checkEngagementPolicy gate as every tool above (it matches purely on
  // targetValue string against security_targets, type-agnostic), so no
  // policy-layer change was needed to support repo/cloud_account-typed
  // targets, they already exist in TARGET_TYPES (securityEngagement.js).
  // What's genuinely NOT solved here, on purpose (see each tool's comment
  // and the report): a real per-target-type command shape. That would touch
  // either the scan host (repo cloning) or the shared, single-arg-template
  // executeCliTool contract (securityCliExecutor.js) — both out of this
  // file's scope, left honest rather than papered over.

  sectest_scan_secrets: {
    name: 'sectest_scan_secrets',
    description: 'Git repository secret scanning (gitleaks) for a verified, in-scope repo target. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'DevSecOps',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope repo target value (see gap note: must be a local path on the scan host, not a bare URL)' },
      },
      required: ['engagement_id', 'target'],
    },
    // GAP (honest, not solved here): gitleaks' `--source` expects a local
    // filesystem path to an already-cloned repo, it does not clone a remote
    // URL itself. `repo`-typed security_targets store whatever value the
    // caller verified (typically a URL). Until something clones the target
    // onto the scan host first, this tool will genuinely fail against a
    // URL-valued target with gitleaks' own honest error, not a fabricated
    // scan. Solving that needs either a clone-then-scan step on the scan
    // host or a multi-command executor contract, both out of this file's
    // scope this pass.
    cli: { binary: 'gitleaks', arg_template: ['detect', '--source', '{target}', '--no-banner', '--report-format', 'json', '--report-path', '-'], output_format: 'json' },
    parameters: { target: { type: 'string', required: true } },
  },

  sectest_scan_image: {
    name: 'sectest_scan_image',
    description: 'Repository CVE scanning (trivy repo) for a verified, in-scope repo target. Requires an engagement whose risk_ceiling is discovery or above.',
    capabilityRisk: 'discovery',
    category: 'DevSecOps',
    input_schema: {
      type: 'object',
      properties: {
        engagement_id: { type: 'string' },
        target: { type: 'string', description: 'The in-scope repo URL to scan (trivy clones it itself)' },
      },
      required: ['engagement_id', 'target'],
    },
    // Unlike gitleaks above, trivy's `repo` subcommand clones a git URL
    // itself, so a repo-typed target's stored URL value works directly here,
    // no gap for that case. The partial gap: a `cloud_account`-typed target
    // (e.g. a registry image reference) needs `trivy image`, a different
    // subcommand, not `trivy repo` — this tool's single fixed arg_template
    // only covers the repo shape. Per-target-type subcommand routing does
    // not exist in this generic 1:1 cli-block executor and isn't added here
    // (same class of gap as gitleaks' clone step); a cloud_account target
    // run through this tool today would get an honest trivy error against a
    // malformed invocation, not a fabricated scan.
    cli: { binary: 'trivy', arg_template: ['repo', '{target}', '--format', 'json', '--quiet'], output_format: 'json' },
    parameters: { target: { type: 'string', required: true } },
  },
};

/**
 * Catalog for UI/agent-discovery surfaces that need to show what's available
 * and how risky/likely-to-work each tool is, without exposing internals like
 * arg_template. `tool` is the short name a caller passes to the REST route
 * (`/capability/:tool`, e.g. "resolve_dns"), the full TOOL_DEFS/CLI name has
 * the "sectest_" prefix stripped for that reason.
 */
function getCapabilityToolCatalog() {
  return Object.values(CAPABILITY_TOOLS).map((t) => ({
    tool: t.name.replace(/^sectest_/, ''),
    name: t.name,
    description: t.description,
    capabilityRisk: t.capabilityRisk,
    binary: t.cli.binary,
    category: t.category,
  }));
}

/**
 * Shared by both the sync and async entry points: resolve the tool def and
 * run the real policy check. Never builds or attempts a command itself.
 * @returns {{toolDef:object}|{denied:true, response:object}}
 */
function checkPolicyForCall(name, input, ctx) {
  const toolDef = CAPABILITY_TOOLS[name];
  if (!toolDef) throw new Error(`Unknown security capability tool: ${name}`);

  const { engagement_id, target } = input || {};
  if (!ctx || !ctx.orgId) {
    return { denied: true, response: { success: false, error: 'org_id could not be derived from the calling context (ctx.orgId missing)' } };
  }

  let decision;
  try {
    decision = securityEngagement.checkEngagementPolicy(
      { engagementId: engagement_id, orgId: ctx.orgId, targetValue: target, capabilityRisk: toolDef.capabilityRisk },
      { db: requireDb() }
    );
  } catch (err) {
    return { denied: true, response: { success: false, allowed: false, error: err.message } };
  }

  if (!decision.allowed) {
    return { denied: true, response: { success: false, allowed: false, requiresApproval: decision.requiresApproval, error: decision.reason } };
  }

  return { toolDef, engagement_id, target };
}

async function executeSecurityCapabilityTool(name, input, ctx) {
  const checked = checkPolicyForCall(name, input, ctx);
  if (checked.denied) return checked.response;
  const { toolDef, engagement_id, target } = checked;

  if (!_deps.scanHost) {
    return {
      success: false,
      allowed: true,
      error: 'Scan host not configured (SECURITY_SCAN_HOST unset). No live capability provider is reachable yet, this is expected until a bastion-managed scan host is provisioned.',
    };
  }

  const cliInput = typeof toolDef.buildInput === 'function' ? toolDef.buildInput(target) : { target };
  // QUOXTRUST #626 (A): mint + attach the engagement-anchored grant a mode:risky
  // bastion requires (auth re-validates the engagement before signing).
  // Fail-closed on mint failure — no ungranted scan.
  const callBastion = makeGrantAwareSecurityCallBastion(
    ctx, _deps.callBastion,
    makeEngagementMintFn({ engagementId: engagement_id, target, capabilityRisk: toolDef.capabilityRisk }),
  );
  const result = await executeCliTool(toolDef, cliInput, { callBastion, host: _deps.scanHost });
  return { allowed: true, ...result };
}

/**
 * Async entry point: for tools that can genuinely outrun a single blocking
 * HTTP request (found live 2026-08-10/11 running sectest_vuln_scan/nuclei,
 * a real default-template scan exceeds defaultCallBastion's 30s budget).
 * Same policy gate as the sync path, same "deny before building anything"
 * discipline, but on approval creates a security_scan_jobs row and returns
 * job_id immediately without waiting for the command to finish. The actual
 * execution continues in the background; the caller polls getJob/listJobs.
 *
 * The returned object carries a non-serializable `_backgroundPromise` so
 * tests can await completion deterministically; a real HTTP handler just
 * ignores it (JSON.stringify silently drops it) and lets it run detached.
 *
 * `input.schedule_id` / `input.created_by` are optional pass-throughs onto
 * the created job (QUOX-SECURITY-SCHED Phase 2: the scan scheduler is the
 * only caller that sets them today, tagging jobs it fires with the
 * schedule that fired them). Every existing caller omits both, so this is
 * additive: schedule_id stays null, created_by keeps its prior
 * agent-derived value.
 */
async function executeSecurityCapabilityToolAsync(name, input, ctx) {
  const checked = checkPolicyForCall(name, input, ctx);
  if (checked.denied) return checked.response;
  const { toolDef, engagement_id, target } = checked;

  const scheduleId = input && input.schedule_id ? input.schedule_id : null;
  const createdBy = (input && input.created_by)
    || (ctx.agentId ? `agent:${ctx.agentId}` : null);

  const job = securityScanJobs.createJob(
    { engagement_id, org_id: ctx.orgId, tool: name, target, created_by: createdBy, schedule_id: scheduleId },
    { db: requireDb() }
  );

  // QUOXTRUST #626 (A): carry the engagement context into the background run so
  // the grant is minted AT EXECUTION TIME (freshness bound to when the scan
  // actually runs, not when it was queued), bound to the exact command + host.
  const backgroundPromise = runCapabilityJobInBackground(job.id, toolDef, target, ctx, engagement_id);

  return { allowed: true, success: true, job_id: job.id, status: 'queued', _backgroundPromise: backgroundPromise };
}

/**
 * QUOX-SECURITY-SCHED Phase 3: scan-result diff + new-finding HITL alert,
 * run after a SCHEDULED job (job.schedule_id set) succeeds. Extracted as
 * its own exported function so it's directly unit-testable with fake
 * deps/alertFn, without running a real scan. Loads the schedule's previous
 * successful run, diffs against the job that just succeeded, records the
 * (compact) diff summary on the schedule, and alerts only when new
 * high/critical findings are present.
 *
 * Deliberately does not touch job status — that's already decided by the
 * caller (runCapabilityJobInBackground) before this runs.
 *
 * IS the whole hook, including the try/catch: this function NEVER throws
 * or rejects — a diff/alert bug must never fail or crash the scan job that
 * has already been recorded as succeeded by the time this runs. Errors are
 * logged via console.warn and swallowed.
 *
 * @param {{job: object, deps?: {db, alertFn?: Function}}} args
 *   `job` is the succeeded job row (id, schedule_id, org_id, tool, target,
 *   result_json, created_at — the shape markSucceeded returns).
 */
async function runScheduleDiffAndAlert({ job, deps = {} }) {
  try {
    if (!job || !job.schedule_id) return;
    const db = deps.db || requireDb();
    const alertFn = deps.alertFn || defaultAlertOnNewFindings;

    const schedule = securityEngagementSchedules.getSchedule(job.schedule_id, job.org_id, { db });
    if (!schedule) return;

    const prevJob = securityScanJobs.getPreviousSucceededJobForSchedule(job.schedule_id, job.created_at, { db });
    const diff = diffScanResults(prevJob ? prevJob.result_json : null, job.result_json, job.tool);

    const updatedSchedule = securityEngagementSchedules.recordDiff(job.schedule_id, diff, { db });

    if (diff.newHighSeverity.length > 0) {
      // Keep the existing informational inbox alert.
      await alertFn({ schedule: updatedSchedule || schedule, diff });

      // QUOX-SECURITY-SCHED Phase 6: ALSO persist the new high/critical diff
      // items as durable security_findings rows and auto-file them as GitHub
      // issues, so the finding survives beyond the ephemeral diff and does not
      // need a human to manually re-file it. This is inside the same try/catch
      // that makes the whole hook non-fatal (see the header): a persist/file
      // bug can never fail the scan job that already succeeded.
      const persistFn = deps.persistScheduledFindings
        || securityScheduledFindings.persistAndFileScheduledFindings;
      const gh = resolveGithubFns(deps);
      await persistFn(
        { job, diff },
        { db, getGitHubToken: gh.getGitHubToken, ghFetch: gh.ghFetch }
      );
    }
  } catch (err) {
    console.warn('[securityCapabilityTools] schedule diff/alert failed (non-fatal):', err && err.message);
  }
}

async function runCapabilityJobInBackground(jobId, toolDef, target, ctx = {}, engagementId) {
  const db = requireDb();
  securityScanJobs.markRunning(jobId, { db });

  if (!_deps.scanHost) {
    securityScanJobs.markFailed(
      jobId,
      'Scan host not configured (SECURITY_SCAN_HOST unset). No live capability provider is reachable yet, this is expected until a bastion-managed scan host is provisioned.',
      { db }
    );
    return;
  }

  try {
    const cliInput = typeof toolDef.buildInput === 'function' ? toolDef.buildInput(target) : { target };
    const callBastion = makeGrantAwareSecurityCallBastion(
      ctx, _deps.callBastion,
      makeEngagementMintFn({ engagementId, target, capabilityRisk: toolDef.capabilityRisk }),
    );
    const result = await executeCliTool(toolDef, cliInput, { callBastion, host: _deps.scanHost, timeoutMs: ASYNC_JOB_TIMEOUT_MS });
    let job;
    if (result.success) {
      job = securityScanJobs.markSucceeded(jobId, result, { db });
    } else {
      job = securityScanJobs.markFailed(jobId, result.error || 'command failed', { db });
    }

    // QUOX-SECURITY-SCHED Phase 3: only scheduled jobs (schedule_id set)
    // get diffed/alerted, and only on success — a failed run has no
    // result_json worth comparing. runScheduleDiffAndAlert IS the whole
    // hook including its own try/catch (see its header), so a diff/alert
    // bug can never fail or crash the scan job itself.
    if (result.success && job && job.schedule_id) {
      await runScheduleDiffAndAlert({ job, deps: { db } });
    }
  } catch (err) {
    securityScanJobs.markFailed(jobId, err.message, { db });
  }
}

function getSecurityCapabilityToolDefinitions() {
  return Object.values(CAPABILITY_TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

module.exports = {
  SECURITY_CAPABILITY_TOOLS: CAPABILITY_TOOLS,
  configure,
  getSecurityCapabilityToolDefinitions,
  getCapabilityToolCatalog,
  executeSecurityCapabilityTool,
  executeSecurityCapabilityToolAsync,
  getScanJob: securityScanJobs.getJob,
  listScanJobs: securityScanJobs.listJobs,
  // Exported for direct unit testing (defaultCallBastion's own request-body
  // shape, e.g. that it forwards timeoutMs to Bastion as `timeout` seconds),
  // not because callers should reach for it over configure({callBastion}).
  defaultCallBastion,
  // QUOXTRUST T4/T9 (#626): exported for the invariant regression (w-t4-security-
  // scan-grant.test.js). The executors below wrap _deps.callBastion with this so
  // an approved scan attaches the grant a mode:risky bastion requires.
  makeGrantAwareSecurityCallBastion,
  // QUOXTRUST #626 (A): builds the engagement-anchored mintFn (fail-closed).
  makeEngagementMintFn,
  // QUOX-SECURITY-SCHED Phase 3: exported for direct unit testing with fake
  // deps/alertFn, not because callers should reach for it over the
  // background hook (runCapabilityJobInBackground) that calls it.
  runScheduleDiffAndAlert,
};

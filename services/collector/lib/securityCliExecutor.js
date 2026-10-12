'use strict';

/**
 * QUOX-SECURITY Phase 1: generic CLI-executor for scanner-shaped security
 * tools (nmap, subfinder, httpx, etc). One executor instead of a bespoke
 * mikrotikExecutor-style module per provider, confirmed in the plan's own
 * research: dozens of CLI scanners with structured output fit this pattern;
 * only daemon/API-shaped tools (ZAP, Trivy server, BloodHound) need bespoke
 * executors.
 *
 * Reads a tool's declared `cli` block (binary, arg_template, output_format)
 * plus its standard `parameters` schema to build a safe argv, executes via
 * the SAME governed bastion-SSH path every other host-touching tool in this
 * codebase uses (callBastion, injected as a dep), and parses stdout per the
 * declared output_format.
 *
 * SAFETY, the actual point of this module:
 * - No raw shell interpolation of caller input. Every substituted value is
 *   shell-quoted (shQuote, same single-quote-escape convention already used
 *   in toolExecutors/proxmox.js), never concatenated directly.
 * - Every {placeholder} in arg_template must reference a declared parameter
 *   (a template referencing an undeclared param is a config bug, fails
 *   loud, not silently ignored). Every supplied input key must be consumed
 *   by the template (an unreferenced key is either a caller bug or a
 *   smuggling attempt, never silently dropped).
 * - Argument-injection guard: a substituted value cannot start with "-"
 *   unless its parameter explicitly declares allow_flag_like:true. Without
 *   this, a "target" field could smuggle an extra flag into the invoked
 *   binary (e.g. nmap --script=vuln) even though the shell-quoting itself
 *   is airtight.
 * - This module has NO knowledge of engagement scope. Callers (the future
 *   Recon/Web specialists) are responsible for having already passed
 *   checkEngagementPolicy (securityEngagement.js) before reaching this
 *   executor, the same layering withApprovalGate already sits above every
 *   other native tool executor in this codebase.
 */

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * @param {{id:string, cli:{binary:string, arg_template:string[], output_format?:string}, parameters?:object}} tool
 * @param {object} input
 * @returns {string} a shell command string safe to pass to callBastion
 */
function buildCommand(tool, input) {
  const cli = tool.cli;
  if (!cli || !cli.binary || !Array.isArray(cli.arg_template)) {
    throw new Error(`Tool "${tool.id}" has no cli.binary/cli.arg_template declared`);
  }

  const params = tool.parameters || {};
  const usedParams = new Set();
  const parts = [shQuote(cli.binary)];

  for (const rawArg of cli.arg_template) {
    const match = rawArg.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
    if (!match) {
      // A literal flag/segment (e.g. "-p", "--json"), config-authored, not
      // caller-controlled, still quoted for defence-in-depth.
      parts.push(shQuote(rawArg));
      continue;
    }
    const paramName = match[1];
    if (!(paramName in params)) {
      throw new Error(`arg_template references undeclared parameter "{${paramName}}" on tool "${tool.id}"`);
    }
    usedParams.add(paramName);
    const paramDef = params[paramName];
    const value = (input || {})[paramName];
    if (value === undefined || value === null) {
      if (paramDef.required) {
        throw new Error(`Missing required parameter "${paramName}" for tool "${tool.id}"`);
      }
      continue; // optional and absent: drop this template slot entirely, no empty arg emitted
    }
    const strValue = String(value);
    if (strValue.startsWith('-') && !paramDef.allow_flag_like) {
      throw new Error(
        `Parameter "${paramName}" value starts with "-" ("${strValue}"), refusing to pass to ${cli.binary} ` +
        `(argument-injection guard; set allow_flag_like:true on the parameter if this is intentional)`
      );
    }
    parts.push(shQuote(strValue));
  }

  for (const key of Object.keys(input || {})) {
    if (!usedParams.has(key) && key in params) {
      throw new Error(`Parameter "${key}" was supplied but is not referenced in tool "${tool.id}"'s arg_template`);
    }
  }

  return parts.join(' ');
}

function parseOutput(tool, stdout) {
  const format = tool.cli?.output_format || 'raw';
  const text = stdout || '';
  if (format === 'json') {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse ${tool.id} output as JSON: ${err.message}`);
    }
  }
  if (format === 'lines') {
    return text.split('\n').map((l) => l.trim()).filter(Boolean);
  }
  return text;
}

/**
 * @param {object} tool
 * @param {object} input
 * @param {{callBastion: Function, host: string, timeoutMs?: number}} deps -
 *   timeoutMs is optional and only meaningful to callBastion implementations
 *   that read it (e.g. defaultCallBastion in securityCapabilityTools.js);
 *   the async job path passes a longer budget than the sync path's default
 *   since nothing blocks an HTTP response waiting for it.
 */
async function executeCliTool(tool, input, deps = {}) {
  const { callBastion, host, timeoutMs } = deps;
  if (!host) throw new Error('host is required (which bastion-managed host runs this capability)');
  if (typeof callBastion !== 'function') throw new Error('callBastion dependency is required');

  const command = buildCommand(tool, input);
  const result = await callBastion(host, command, timeoutMs !== undefined ? { timeoutMs } : {});

  if (result.success === false) {
    return { success: false, host, tool: tool.id, error: result.error || 'command failed', exit_code: result.exit_code };
  }

  let parsed;
  try {
    parsed = parseOutput(tool, result.stdout);
  } catch (err) {
    return { success: false, host, tool: tool.id, error: err.message, raw_stdout: (result.stdout || '').slice(0, 2000) };
  }

  return { success: true, host, tool: tool.id, output: parsed, duration_ms: result.duration_ms };
}

module.exports = { buildCommand, parseOutput, executeCliTool, shQuote };

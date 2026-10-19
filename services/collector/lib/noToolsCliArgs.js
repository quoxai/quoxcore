/**
 * argv for a NO-TOOLS headless `claude` run (the no_tools fast path of /api/internal/agents/invoke).
 * --tools "" disables every built-in tool (Bash, Read, Write, WebFetch...) and --strict-mcp-config with no
 * --mcp-config loads no MCP server, so --dangerously-skip-permissions has nothing left to skip. Without these
 * a "no tools" call could run commands inside the collector container (reproduced 2026-10-17). Prompt via stdin.
 */
function noToolsCliArgs({ sysPrompt, model = null }) {
  const args = ['--output-format', 'json', '--dangerously-skip-permissions', '--tools', '', '--strict-mcp-config', '--system-prompt', sysPrompt];
  if (model) args.push('--model', model);
  args.push('-p');
  return args;
}

module.exports = { noToolsCliArgs };

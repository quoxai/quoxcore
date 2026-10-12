function buildTerminalCapabilityStatus({ ptyAvailable, ptyError = null, cliHealth = null }) {
  if (!ptyAvailable) {
    return {
      available: false,
      reason: 'node_pty_unavailable',
      recommendation: 'Claude terminal login is unavailable because PTY support is not installed in the collector runtime. Install build tooling so node-pty can compile, or use the supported container deployment.',
      detail: ptyError || null,
    };
  }

  if (cliHealth && !cliHealth.ok) {
    const reason = String(cliHealth.error || '').includes('ENOENT')
      ? 'claude_cli_missing'
      : 'claude_cli_unhealthy';

    return {
      available: false,
      reason,
      recommendation: reason === 'claude_cli_missing'
        ? 'Claude terminal login is unavailable because the Claude CLI is not installed. Install Claude Code CLI, or use an OpenAI or Anthropic API key instead.'
        : 'Claude terminal login is unavailable because the Claude CLI is not responding correctly. Repair the CLI runtime, or use an OpenAI or Anthropic API key instead.',
      detail: cliHealth.error || null,
    };
  }

  return {
    available: true,
    reason: null,
    recommendation: null,
    detail: null,
  };
}

module.exports = {
  buildTerminalCapabilityStatus,
};

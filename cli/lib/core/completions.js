/**
 * Shell completion generator for QuoxCLI
 *
 * Generates completion scripts for bash, zsh, and fish shells.
 * Install with: quox completion bash >> ~/.bashrc
 */

const COMMANDS = [
  'login', 'logout', 'whoami', 'signup', 'mfa',
  'org', 'team', 'department', 'agent', 'tool', 'workflow', 'assistant',
  'fleet', 'chat', 'memory', 'entity', 'conversation',
  'backup', 'inbox', 'run', 'file', 'admin', 'aee',
  'integration', 'consent', 'setup', 'service', 'config',
  'tag', 'scope', 'notification', 'watch', 'llm', 'quoxchat', 'tg',
];

const SUBCOMMANDS = {
  org: ['list', 'get', 'create', 'update', 'delete', 'switch', 'members', 'divisions', 'audit'],
  team: ['list', 'get', 'create', 'update', 'delete', 'provision-room', 'members'],
  department: ['list', 'get', 'create', 'update', 'delete'],
  agent: ['list', 'get', 'create', 'update', 'delete', 'activate', 'deactivate', 'tool'],
  tool: ['list', 'get', 'create', 'update', 'delete', 'catalog', 'install', 'publish'],
  workflow: ['list', 'get', 'create', 'update', 'delete', 'run', 'publish', 'steps'],
  assistant: ['list', 'get', 'create', 'update', 'delete', 'deploy', 'fork'],
  fleet: ['status', 'summary', 'agents', 'tools', 'exec', 'watch'],
  chat: ['send', 'stream', 'status'],
  memory: ['list', 'get', 'create', 'update', 'delete', 'search', 'stats', 'export'],
  entity: ['list', 'get', 'create', 'search', 'relate'],
  backup: ['list', 'get', 'create', 'delete', 'verify', 'restore', 'schedule'],
  inbox: ['list', 'get', 'respond', 'stats'],
  run: ['list', 'get', 'create', 'cancel', 'resume'],
  file: ['upload', 'download', 'list', 'delete', 'stats'],
  admin: ['config', 'key', 'service', 'logs', 'stats', 'retention'],
  aee: ['store', 'get', 'query', 'conversations', 'stats'],
  integration: ['list', 'get', 'create', 'update', 'delete', 'test'],
  consent: ['list', 'grant', 'history'],
  setup: ['status', 'admin', 'config', 'license'],
  service: ['health'],
  config: ['profile'],
  mfa: ['setup', 'verify', 'disable', 'backup-codes'],
  tag: ['list', 'create', 'update', 'delete'],
  scope: ['list', 'create', 'update', 'delete'],
  notification: ['channels'],
  watch: ['fleet', 'services'],
  llm: ['status'],
  quoxchat: ['widgets', 'availability', 'conversations', 'transcript', 'reply'],
  tg: ['status', 'bind-owner', 'leases', 'webhook-info', 'setup'],
};

const GLOBAL_FLAGS = [
  '--output', '--json', '--quiet', '--org', '--profile',
  '--no-color', '--verbose', '--debug', '--dry-run', '--yes', '--insecure',
];

export function generateBashCompletion() {
  const cmds = COMMANDS.join(' ');
  const subcmdCases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `      ${cmd}) COMPREPLY=($(compgen -W "${subs.join(' ')}" -- "$cur")) ;;`)
    .join('\n');

  return `# QuoxCLI bash completion
# Install: quox completion bash >> ~/.bashrc

_quox_completions() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="${cmds}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$commands ${GLOBAL_FLAGS.join(' ')}" -- "$cur"))
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
${subcmdCases}
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${GLOBAL_FLAGS.join(' ')}" -- "$cur"))
  fi
}

complete -F _quox_completions quox
complete -F _quox_completions quoxcli
`;
}

export function generateZshCompletion() {
  const subcmdCases = Object.entries(SUBCOMMANDS)
    .map(([cmd, subs]) => `    ${cmd}) compadd ${subs.join(' ')} ;;`)
    .join('\n');

  return `#compdef quox quoxcli
# QuoxCLI zsh completion
# Install: quox completion zsh > ~/.zsh/completions/_quox

_quox() {
  local -a commands
  commands=(
${COMMANDS.map(c => `    '${c}:${c} commands'`).join('\n')}
  )

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
${subcmdCases}
      esac
      ;;
  esac
}

_quox "$@"
`;
}

export function generateFishCompletion() {
  const lines = ['# QuoxCLI fish completion', '# Install: quox completion fish > ~/.config/fish/completions/quox.fish', ''];

  // Top-level commands
  for (const cmd of COMMANDS) {
    lines.push(`complete -c quox -n '__fish_use_subcommand' -a '${cmd}' -d '${cmd} commands'`);
  }
  lines.push('');

  // Subcommands
  for (const [cmd, subs] of Object.entries(SUBCOMMANDS)) {
    for (const sub of subs) {
      lines.push(`complete -c quox -n '__fish_seen_subcommand_from ${cmd}' -a '${sub}'`);
    }
  }
  lines.push('');

  // Global flags
  lines.push(`complete -c quox -l output -s o -d 'Output format (table|json|csv|quiet)'`);
  lines.push(`complete -c quox -l json -d 'JSON output'`);
  lines.push(`complete -c quox -l quiet -s q -d 'Quiet mode (IDs only)'`);
  lines.push(`complete -c quox -l org -d 'Override active org'`);
  lines.push(`complete -c quox -l profile -d 'Use named config profile'`);
  lines.push(`complete -c quox -l verbose -s v -d 'Verbose output'`);
  lines.push(`complete -c quox -l debug -d 'Debug HTTP requests'`);
  lines.push(`complete -c quox -l dry-run -d 'Show what would happen'`);
  lines.push(`complete -c quox -l yes -s y -d 'Skip confirmations'`);

  return lines.join('\n') + '\n';
}

export function generateCompletion(shell) {
  switch (shell) {
    case 'bash': return generateBashCompletion();
    case 'zsh': return generateZshCompletion();
    case 'fish': return generateFishCompletion();
    default: throw new Error(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
  }
}

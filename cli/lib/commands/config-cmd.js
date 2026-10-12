/**
 * Config/profile management commands
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';

export function registerConfigCommands(program, ctx) {
  const { config } = ctx;

  const cfg = program
    .command('config')
    .description('Manage CLI configuration and profiles');

  // quox config profile list
  const profile = cfg
    .command('profile')
    .description('Manage connection profiles');

  profile
    .command('list')
    .description('List all profiles')
    .action(() => {
      const profiles = config.listProfiles();
      formatOutput({
        columns: ['name', 'url', 'active', 'loggedIn', 'email'],
        headers: ['Name', 'URL', 'Active', 'Logged In', 'Email'],
        rows: profiles.map(p => ({
          ...p,
          active: p.active ? 'yes' : '',
          loggedIn: p.loggedIn ? 'yes' : '',
        })),
      }, { format: program.opts().output });
    });

  profile
    .command('add')
    .description('Add a new profile')
    .argument('<name>', 'profile name')
    .requiredOption('--url <url>', 'API base URL')
    .action((name, options) => {
      config.addProfile(name, { url: options.url });
      printSuccess(`Profile "${name}" added.`);
    });

  profile
    .command('use')
    .description('Switch active profile')
    .argument('<name>', 'profile name')
    .action((name) => {
      config.setActiveProfile(name);
      printSuccess(`Switched to profile "${name}".`);
    });

  profile
    .command('remove')
    .description('Remove a profile')
    .argument('<name>', 'profile name')
    .action((name) => {
      config.removeProfile(name);
      printSuccess(`Profile "${name}" removed.`);
    });

  // quox config get <key>
  cfg
    .command('get')
    .description('Get a config value')
    .argument('[key]', 'config key (omit to show all)')
    .action((key) => {
      if (!key) {
        const profile = config.getActiveProfile();
        const auth = config.getAuth();
        formatDetail({
          profile: config.getActiveProfileName(),
          url: profile?.url || 'not set',
          email: auth?.email || 'not logged in',
          org: auth?.org_slug || 'none',
        }, {
          format: program.opts().output,
          labels: {
            profile: 'Profile',
            url: 'API URL',
            email: 'Email',
            org: 'Org',
          },
        });
      } else {
        const value = config.get(key);
        if (program.opts().output === 'json') {
          console.log(JSON.stringify({ [key]: value }));
        } else {
          console.log(value ?? '');
        }
      }
    });

  // quox config set <key> <value>
  cfg
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'config key')
    .argument('<value>', 'config value')
    .action((key, value) => {
      config.set(key, value);
      printSuccess(`Set ${key} = ${value}`);
    });
}

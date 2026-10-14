/**
 * Auth commands: login, logout, whoami, signup, mfa
 */

import chalk from 'chalk';
import { formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { loadResidentProfile, residentLogin, resolveResidentBaseUrl } from '../core/residentAuth.js';
import { readStoredKit, resolveMyAttach, sessionKey, myAttachState } from './agentAttach.js';
import { resolveActing } from '../core/actingAs.js';

export function registerAuthCommands(program, ctx) {
  const { config, auth, client } = ctx;

  // quox login
  program
    .command('login')
    .description('Authenticate with QuoxCORE')
    .option('--email <email>', 'email address')
    .option('--password <password>', 'password (prefer --password-stdin: argv is visible in process lists)')
    .option('--password-stdin', 'read the password from stdin (one line) — no secret in argv or shell history')
    .option('--mfa-code <code>', 'TOTP code for MFA')
    .option('--org <orgId>', 'organization to log into')
    .option('--resident', 'authenticate as a resident agent using the on-disk Ed25519 identity, no password, no human')
    .option('--resident-profile <path>', 'path to the resident bootstrap profile (default: ~/.config/quox/resident-profile.json)')
    .action(async (options) => {
      // Resident agent path: signed-challenge exchange with an Ed25519 key
      // on disk, entirely separate from the email/password flow below.
      if (options.resident) {
        const ora = (await import('ora')).default;
        const spinner = ora('Authenticating (resident identity)...').start();
        try {
          const profile = loadResidentProfile(options.residentProfile);
          const baseUrl = resolveResidentBaseUrl(config, profile);
          const tokenData = await residentLogin({ baseUrl, profile });

          const authData = {
            access_token: tokenData.access_token,
            refresh_token: null,
            user_id: tokenData.user?.id || null,
            email: tokenData.user?.email || null,
            display_name: tokenData.user?.display_name || null,
            org_id: profile.org_id,
            org_name: null,
            org_slug: null,
            org_role: tokenData.user?.role || null,
            actor_type: tokenData.user?.actor_type || null,
            host_id: tokenData.user?.host_id || profile.host_id,
            kind: 'resident',
            resident_profile_path: profile._path,
            expires_at: Date.now() + (tokenData.expires_in || 900) * 1000,
          };
          config.setAuth(authData);

          // quox#455: persist the bootstrap's reach-back URLs onto this
          // profile so every later command (collector, slots, dev) resolves
          // services from what this host actually reaches, never a
          // port/scheme guess. Only fill the profile URL when it is still
          // the local default; an explicit URL a human set always wins.
          const active = typeof config.getActiveProfile === 'function' ? config.getActiveProfile() : null;
          // Any loopback URL counts as "not deliberately set". An exact-string
          // check against http://localhost:3000 missed https://localhost:3000
          // and left the profile base pointing at the host's own empty
          // instance, which only stayed invisible because the per-service
          // overrides below happen to cover the services in use today.
          const urlIsDefault = (() => {
            if (!active?.url) return true;
            try {
              return ['localhost', '127.0.0.1', '::1'].includes(new URL(active.url).hostname);
            } catch {
              return true;
            }
          })();
          // quox#455 follow-up / quox#469: stamp AUTH as well as collector.
          // Stamping only collector left every auth-service call (whoami, and
          // the token refresh itself) resolving through getServiceUrl('auth'),
          // which port-swaps the edge to loopback :3101 and is unreachable
          // from any remote host. The acceptance owner hit exactly that:
          // login worked zero-override while whoami and slot ops still needed
          // manual QUOX_AUTH_URL/QUOX_COLLECTOR_URL.
          const services = {};
          if (profile.collector_url) services.collector = profile.collector_url;
          if (profile.instance_url) services.auth = profile.instance_url;
          config.setProfileConnection({
            ...(urlIsDefault && profile.instance_url ? { url: profile.instance_url } : {}),
            ...(Object.keys(services).length ? { services } : {}),
          });

          spinner.stop();
          printSuccess(`Logged in as resident agent ${authData.email || authData.user_id || authData.host_id} (host ${authData.host_id})`);
        } catch (err) {
          spinner.fail('Resident login failed');
          throw err;
        }
        return;
      }

      let { email, password, mfaCode } = options;
      const orgId = options.org || program.opts().org;

      // SVC-AUTH #447 bridge: non-interactive automation reads the secret
      // from stdin (or QUOX_LOGIN_PASSWORD / QUOX_LOGIN_EMAIL env), never
      // argv, so no credential lands in process lists or shell history.
      if (!email && process.env.QUOX_LOGIN_EMAIL) email = process.env.QUOX_LOGIN_EMAIL;
      if (!password && options.passwordStdin) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        password = Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
        if (!password) {
          console.error('Error: --password-stdin given but stdin was empty');
          process.exit(1);
        }
      }
      if (!password && process.env.QUOX_LOGIN_PASSWORD) password = process.env.QUOX_LOGIN_PASSWORD;

      // Interactive prompts if not provided
      if (!email || !password) {
        const { default: inquirer } = await import('inquirer');

        if (!email) {
          const ans = await inquirer.prompt([{
            type: 'input',
            name: 'email',
            message: 'Email:',
            validate: v => v.includes('@') || 'Please enter a valid email',
          }]);
          email = ans.email;
        }

        if (!password) {
          const ans = await inquirer.prompt([{
            type: 'password',
            name: 'password',
            message: 'Password:',
            mask: '*',
          }]);
          password = ans.password;
        }
      }

      const baseUrl = config.getServiceUrl('auth');
      const ora = (await import('ora')).default;
      const spinner = ora('Authenticating...').start();

      try {
        const result = await auth.login(baseUrl, email, password, orgId);
        spinner.stop();

        // Handle MFA
        if (result.mfa_required) {
          if (!mfaCode) {
            printInfo('MFA required. Check your authenticator app.');
            const { default: inquirer } = await import('inquirer');
            const ans = await inquirer.prompt([{
              type: 'input',
              name: 'code',
              message: 'TOTP code:',
            }]);
            mfaCode = ans.code;
          }

          const mfaSpinner = ora('Verifying MFA...').start();
          await auth.verifyMfa(baseUrl, result.access_token, mfaCode);
          mfaSpinner.succeed('MFA verified');
        }

        const authData = config.getAuth();
        // quox#647: login resolves and SETS the active org, silently overriding
        // any prior `quox org switch` (the root cause of wrong-org actions).
        // Always surface the resulting active org so the reset is visible
        // (owner: "at least print 'active org set to X'"). Fall back
        // org_name -> org_id like whoami, since resident logins carry org_id but
        // no org_name (quox#463) and this line used to blank out entirely.
        const orgLabel = authData.org_name
          ? `${authData.org_name} (${authData.org_slug})`
          : (authData.org_id || 'unknown');
        printSuccess(`Logged in as ${authData.email}`);
        printInfo(`Active org set to ${orgLabel}`);
      } catch (err) {
        spinner.fail('Login failed');
        throw err;
      }
    });

  // quox logout
  program
    .command('logout')
    .description('End current session')
    .action(async () => {
      const baseUrl = config.getServiceUrl('auth');
      await auth.logout(baseUrl);
      printSuccess('Logged out. Tokens cleared.');
    });

  // quox whoami
  program
    .command('whoami')
    .description('Show current user and session info')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('auth.me.list').path, { service: resolveEndpoint('auth.me.list').service });
      const authData = config.getAuth();

      // quox#463: resident logins carry org_id but no org_name (the
      // bootstrap has only the id), and this rendered a real membership as
      // 'none'. Fall back to the id rather than claiming no org.
      //
      // quox#463 follow-up: some resident sessions have no active org_id in
      // the stored session/profile at all, even though `quox org list` on
      // the same session shows a real membership. Whoami is a read verb, so
      // when the active org is unset we resolve it by fetching the caller's
      // org memberships through the exact same endpoint `quox org list`
      // uses, and display the single membership (or the first, marked as
      // resolved from membership) instead of the literal 'none'. Only an
      // empty membership list still says 'none'. This never writes back to
      // stored auth state; it only changes what is displayed.
      let orgDisplay;
      if (authData.org_name) {
        orgDisplay = `${authData.org_name} (${authData.org_slug})`;
      } else if (authData.org_id) {
        orgDisplay = authData.org_id;
      } else {
        let memberships = [];
        try {
          const orgsEp = resolveEndpoint('orgs.list');
          const orgsData = await client.get(orgsEp.path, { service: orgsEp.service });
          const list = orgsData.organizations || orgsData.orgs || orgsData;
          memberships = Array.isArray(list) ? list : [];
        } catch {
          memberships = [];
        }
        if (memberships.length > 0) {
          const m = memberships[0];
          const label = m.name || m.id;
          orgDisplay = `${label}${m.slug ? ` (${m.slug})` : ''} (resolved from membership)`;
        } else {
          orgDisplay = 'none';
        }
      }

      const info = {
        user: data.user?.display_name || data.user?.email || authData.email,
        email: data.user?.email || authData.email,
        user_id: data.user?.id || authData.user_id,
        org: orgDisplay,
        role: authData.org_role || 'n/a',
        mfa: data.user?.mfa_enabled ? 'enabled' : 'disabled',
        // Z2H-3c: expires_at is the ACCESS token. With a refresh token the sign-in outlives it, so do not
        // present it as the session ending (a fresh owner read "expires in 60m" right after logging in).
        session: authData.expires_at
          ? (authData.refresh_token
            ? `active, auto-renews (token refresh in ${Math.max(0, Math.round((authData.expires_at - Date.now()) / 60000))}m)`
            : `expires in ${Math.max(0, Math.round((authData.expires_at - Date.now()) / 60000))}m`)
          : 'unknown',
        profile: config.getActiveProfileName(),
      };
      const fields = ['user', 'email', 'user_id', 'org', 'role', 'mfa', 'session', 'profile'];
      const labels = {
        user: 'User',
        email: 'Email',
        user_id: 'User ID',
        org: 'Org',
        role: 'Role',
        mfa: 'MFA',
        session: 'Session',
        profile: 'Profile',
      };

      // Resident agent identity (quox#453 phase 15): only shown when the
      // stored identity actually carries it, so a normal human login is
      // unaffected.
      const actorType = data.user?.actor_type || authData.actor_type;
      const hostId = data.user?.host_id || authData.host_id;
      if (actorType) {
        info.actor_type = actorType;
        labels.actor_type = 'Actor Type';
        fields.splice(fields.indexOf('role') + 1, 0, 'actor_type');
      }
      if (hostId) {
        info.host_id = hostId;
        labels.host_id = 'Host ID';
        fields.splice(fields.indexOf('mfa'), 0, 'host_id');
      }

      formatDetail(info, {
        format: program.opts().output,
        fields,
        labels,
      });

      // F4 (QuoxIdentity CLI finding-fix): whoami answered "who is this
      // token" but not "is this session also attached as an agent identity".
      // QUOXIDENTITY P9: report only THIS session's agent (resolved
      // session-scoped), not every attach on the box — the old scan listed
      // every session's lease, which is exactly the "single resident sees all"
      // flaw. A scan failure must never fail whoami itself.
      try {
        // Show what PLAIN verbs would act as (whoami itself is exempt from the default).
        const acting = await resolveActing({ argv: process.argv.slice(2).filter((x) => x !== 'whoami') .concat(['_probe']) });
        if (acting.source === 'flag' || acting.source === 'env' || acting.source === 'default') {
          const askit = readStoredKit(acting.name);
          const why = acting.source === 'flag' ? '--as' : acting.source === 'env' ? 'QUOX_AS' : 'default: attached session';
          printInfo(
            `  Acting as ${acting.name} (${why})`
            + (askit?.lease?.id ? ` (attach lease ${askit.lease.id}, expires ${askit.lease.expires_at || 'unknown'})` : '')
          );
        } else if (acting.source === 'self') {
          printInfo('  Acting as yourself (--as self)');
        } else if (acting.source === 'profile') {
          printInfo('  Acting as yourself (-p/--profile given)');
        } else if (myAttachState().state === 'ambiguous') {
          printInfo('  Acting as yourself: this session has more than one attach (ambiguous), so no agent default applies. Pick one with --as <agent>.');
        }
      } catch {
        // Best effort only.
      }
      try {
        const mine = resolveMyAttach();
        if (mine) {
          const kit = readStoredKit(mine.agentId);
          const key = sessionKey();
          printInfo(
            `  attached as ${mine.agentId}`
            + (kit?.lease?.id ? ` (lease ${String(kit.lease.id).slice(0, 8)}, expires ${kit.lease.expires_at || 'unknown'})` : '')
            + (key ? ` · session ${key}` : '')
          );
        }
      } catch {
        // Best effort only: never fail whoami on an attach-state scan error.
      }
    });

  // quox signup
  program
    .command('signup')
    .description('Create a new user account')
    .requiredOption('--email <email>', 'email address')
    .requiredOption('--password <password>', 'password')
    .requiredOption('--name <name>', 'display name')
    .action(async (options) => {
      const data = await client.post(resolveEndpoint('auth.signup').path, {
        service: resolveEndpoint('auth.signup').service,
        body: {
          email: options.email,
          password: options.password,
          display_name: options.name,
        },
        noAuth: true,
      });
      printSuccess(`Account created for ${options.email}. Check your email for verification.`);
    });

  // quox mfa
  const mfa = program
    .command('mfa')
    .description('Manage multi-factor authentication');

  mfa
    .command('setup')
    .description('Enable MFA for your account')
    .action(async () => {
      auth.requireAuth();
      const data = await client.post(resolveEndpoint('mfa.setup').path, { service: resolveEndpoint('mfa.setup').service });
      if (data.qr_code || data.secret) {
        console.log(chalk.bold('MFA Setup'));
        if (data.secret) console.log(`Secret: ${data.secret}`);
        if (data.qr_code) console.log(`QR URL: ${data.qr_code}`);
        printInfo('Enter the code from your authenticator app to verify.');
      } else {
        printSuccess('MFA setup initiated. Check the response for setup instructions.');
      }
    });

  mfa
    .command('verify')
    .description('Verify MFA setup with a code')
    .requiredOption('--code <code>', 'TOTP verification code')
    .action(async (options) => {
      auth.requireAuth();
      await client.post(resolveEndpoint('mfa.verify-setup').path, {
        service: resolveEndpoint('mfa.verify-setup').service,
        body: { code: options.code },
      });
      printSuccess('MFA enabled successfully.');
    });

  mfa
    .command('disable')
    .description('Disable MFA for your account')
    .requiredOption('--code <code>', 'TOTP code to confirm')
    .action(async (options) => {
      auth.requireAuth();
      await client.post(resolveEndpoint('mfa.disable').path, {
        service: resolveEndpoint('mfa.disable').service,
        body: { code: options.code },
      });
      printSuccess('MFA disabled.');
    });

  mfa
    .command('backup-codes')
    .description('View MFA backup codes')
    .action(async () => {
      auth.requireAuth();
      const data = await client.get(resolveEndpoint('mfa.backup-codes.list').path, { service: resolveEndpoint('mfa.backup-codes.list').service });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(chalk.bold('Backup Codes'));
        console.log(chalk.dim('Save these somewhere safe:\n'));
        for (const code of (data.codes || data.backup_codes || [])) {
          console.log(`  ${code}`);
        }
      }
    });

  // ── quox account ────────────────────────────────────────────────────────
  // fleet #390: PATCH /api/auth/me/password existed, worked and audited, but
  // no command exposed it — so rotating your own password on a headless box
  // meant hand-crafting a curl with a bearer token. Credential rotation is
  // basic hygiene; making the correct action harder than doing nothing is
  // the wrong incentive for a governance product.
  const account = program
    .command('account')
    .description('Your own account (password, session)');

  account
    .command('password')
    .description('Change your password')
    // Values are prompted by default. --current/--new exist for automation,
    // but they land in argv and shell history, so the help says so plainly
    // rather than presenting them as equivalent.
    .option('--current <password>', 'current password (WARNING: visible in argv/shell history — prefer the prompt)')
    .option('--new <password>', 'new password (same warning)')
    .action(async (options) => {
      auth.requireAuth();

      let current = options.current;
      let next = options.new;

      if (!current || !next) {
        const { default: inquirer } = await import('inquirer');
        if (!current) {
          const a = await inquirer.prompt([{ type: 'password', name: 'v', message: 'Current password:', mask: '*' }]);
          current = a.v;
        }
        if (!next) {
          const a = await inquirer.prompt([{ type: 'password', name: 'v', message: 'New password:', mask: '*' }]);
          const b = await inquirer.prompt([{ type: 'password', name: 'v', message: 'Confirm new password:', mask: '*' }]);
          if (a.v !== b.v) throw new Error('New passwords do not match.');
          next = a.v;
        }
      }

      const ep = resolveEndpoint('auth.me.password');
      await client.patch(ep.path, {
        service: ep.service,
        body: { current_password: current, new_password: next },
      });
      printSuccess('Password changed. Existing sessions elsewhere may need re-authentication.');
    });
}

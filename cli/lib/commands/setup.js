/**
 * Setup commands: status, admin, config, license
 */

import chalk from 'chalk';
import { formatDetail, printSuccess, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxApiError, QuoxValidationError } from '../core/errors.js';
import { confirmDestructive } from '../core/confirm.js';

/**
 * LICENSE-LAUNCH LL-8: read a license-key-v2 JSON object from a file or
 * stdin, never from argv.
 *
 * Secret hygiene, same rule as `vault create` (fleet #391): argv is visible
 * in the process list and lands in shell history, so there is deliberately no
 * `--key <json>` flag. A file can be 0600 and shredded afterwards; stdin
 * never touches disk.
 *
 * The RAW text is what gets posted, not a re-serialisation of the parsed
 * object: the key is Ed25519-signed over its own bytes, and re-emitting it
 * with different key order or spacing would invalidate the signature. The
 * parse here is validation only.
 *
 * @returns {Promise<string>} the trimmed raw license key text
 */
async function readLicenseKey(options) {
  let raw;
  let source;

  if (options.stdin) {
    source = 'stdin';
    raw = await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => { buf += c; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
  } else if (options.keyFile) {
    source = options.keyFile;
    const { readFile } = await import('node:fs/promises');
    try {
      raw = await readFile(options.keyFile, 'utf8');
    } catch (err) {
      throw new QuoxValidationError(`Could not read license key from ${options.keyFile}: ${err.message}`);
    }
  } else {
    // No prompt, ever. This runs from boot scripts on headless instances,
    // where an inquirer prompt is a hang, not a question.
    throw new QuoxValidationError(
      'No license key supplied. Pass --key-file <path>, or pipe the key and pass --stdin. '
      + 'There is no --key flag: argv is visible in the process list and shell history.'
    );
  }

  const text = (raw || '').trim();
  if (!text) {
    throw new QuoxValidationError(`License key from ${source} is empty.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new QuoxValidationError(
      `License key from ${source} is not valid JSON: ${err.message}. `
      + 'Paste the whole license-key-v2 object from your purchase email.'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new QuoxValidationError(`License key from ${source} must be a JSON object.`);
  }

  return text;
}

/** Best available human name for one entry of a `bound` seat list. */
function boundEntryName(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.instance_name
    || entry?.bound_instance_name
    || entry?.hostname
    || entry?.instance_id
    || 'unknown instance';
}

/**
 * LICENSE-LAUNCH LL-3d: render the seat context the licensing endpoints send.
 *
 * The control plane's 409 carries `bound_instance_name`, and (after LL-2a)
 * a `bound` list plus `max_servers`; the 402 carries the unlicensed `plugin`.
 * core/client.js now hangs the whole body on `err.body`, so say WHICH box
 * holds the seat and HOW MANY of the licensed servers are in use, instead of
 * "Request failed with status 409". The raw body rides along on the returned
 * error, so `--output json` still emits exactly what the server said.
 *
 * Returns the error unchanged when it carries no licensing context.
 */
function enrichLicenseError(err) {
  if (!(err instanceof QuoxApiError)) return err;

  const body = err.body && typeof err.body === 'object' ? err.body : {};
  const code = err.code || body.error;
  const lines = [];

  if (code === 'seat_taken' || code === 'seat_limit_reached') {
    lines.push(code === 'seat_limit_reached'
      ? 'This licence has no free seats left.'
      : 'This licence seat is already bound to another instance.');

    if (body.bound_instance_name) {
      lines.push(`  Seat held by: ${body.bound_instance_name}`);
    }

    const bound = Array.isArray(body.bound) ? body.bound : [];
    const maxServers = Number.isFinite(Number(body.max_servers)) && body.max_servers != null
      ? Number(body.max_servers)
      : null;
    if (bound.length) {
      lines.push(maxServers != null
        ? `  Seats: ${bound.length} of ${maxServers} servers in use`
        : `  Seats: ${bound.length} servers in use`);
      for (const entry of bound) lines.push(`    - ${boundEntryName(entry)}`);
    } else if (maxServers != null) {
      lines.push(`  Seats: ${maxServers} servers allowed by this licence`);
    }

    lines.push('Run `quox setup license deactivate` on the instance holding the seat '
      + '(or release it in the quox.ai admin), then retry.');
  } else if (code === 'LICENSE_REQUIRED') {
    const plugin = body.plugin || body.requiredPlugin;
    lines.push(plugin
      ? `A licence entitlement is required for \`${plugin}\`.`
      : 'A licence entitlement is required for this capability.');
    lines.push('Activate a licence that covers it with `quox setup license activate --key-file <path>`, '
      + 'then confirm with `quox setup license status`.');
  } else {
    return err;
  }

  return new QuoxApiError(err.status, err.code || code, lines.join('\n'), err.detail, err.body);
}

/** Pull whatever bound-server identity the activate response carries. */
function boundServerFields(lease, data) {
  const out = {};
  for (const key of ['instance_id', 'instance_name', 'bound_instance_name', 'server_id', 'hostname']) {
    const value = lease?.[key] ?? data?.[key];
    if (value != null && value !== '') out[key] = value;
  }
  return out;
}

/**
 * LICENSE-LAUNCH LL-8-dash: how long a `link` run waits between polls when the
 * server sends no interval. The control plane's own floor is 5s.
 */
const DEFAULT_LINK_INTERVAL_SECONDS = 5;

export function registerSetupCommands(program, ctx) {
  const { client, config, auth } = ctx;
  // Injectable so tests drive the poll loop without waiting real seconds
  // (same seam as devSupervisor.js).
  const sleepFn = ctx.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const setup = program
    .command('setup')
    .description('First-time setup and configuration');

  setup
    .command('status')
    .description('Check setup status')
    .action(async () => {
      const data = await client.get(resolveEndpoint('setup.status.list').path, { service: resolveEndpoint('setup.status.list').service, noAuth: true });
      formatDetail(data, {
        format: program.opts().output,
        title: 'Setup Status',
      });
    });

  setup
    .command('admin')
    .description('Create the initial admin account')
    .option('--email <email>', 'admin email')
    .option('--password <password>', 'admin password')
    .option('--name <name>', 'admin display name')
    .action(async (options) => {
      let { email, password, name } = options;

      if (!email || !password || !name) {
        const { default: inquirer } = await import('inquirer');

        if (!email) {
          const ans = await inquirer.prompt([{
            type: 'input', name: 'email', message: 'Admin email:',
            validate: v => v.includes('@') || 'Enter a valid email',
          }]);
          email = ans.email;
        }
        if (!name) {
          const ans = await inquirer.prompt([{
            type: 'input', name: 'name', message: 'Display name:',
          }]);
          name = ans.name;
        }
        if (!password) {
          const ans = await inquirer.prompt([{
            type: 'password', name: 'password', message: 'Password:', mask: '*',
          }]);
          password = ans.password;
        }
      }

      // services/auth/routes/setup.js POST /admin destructures `name` (not
      // `display_name`) from req.body — sending only display_name silently
      // dropped the admin's name (fell back to 'Admin'). Send both: `name`
      // is what the endpoint actually reads; `display_name` is kept for
      // forward-compat / any other consumer that expects it.
      const data = await client.post(resolveEndpoint('setup.admin').path, {
        service: resolveEndpoint('setup.admin').service,
        body: { email, password, name, display_name: name },
        noAuth: true,
      });
      printSuccess(`Admin account created for ${email}.`);
      printInfo('Run `quox login` to authenticate.');
    });

  setup
    .command('config')
    .description('Configure platform settings')
    .option('--key <key>', 'config key')
    .option('--value <value>', 'config value')
    .action(async (options) => {
      if (options.key && options.value) {
        await client.post(resolveEndpoint('setup.config').path, {
          service: resolveEndpoint('setup.config').service,
          body: { [options.key]: options.value },
          noAuth: true,
        });
        printSuccess(`Setup config ${options.key} set.`);
      } else {
        const data = await client.get(resolveEndpoint('setup.config.list').path, { service: resolveEndpoint('setup.config.list').service, noAuth: true });
        formatDetail(data.config || data, { format: program.opts().output, title: 'Setup Config' });
      }
    });

  // ── LICENSE-LAUNCH LL-8: license activation from the terminal ────────────
  // Parity with the Settings > License surface in the dashboard, so a
  // headless instance (the demo box redeploys every 15 minutes and comes
  // back unactivated) can activate itself from a boot script.
  const license = setup
    .command('license')
    .description('Activate, inspect and release this instance licence');

  license
    .command('activate')
    .description('Activate a license-key-v2 key on this instance (instance admin)')
    .option('--key-file <path>', 'read the license key JSON from a file (keep it 0600)')
    .option('--stdin', 'read the license key JSON from stdin (never touches disk)')
    .action(async (options) => {
      auth.requireAuth();
      const licenseKey = await readLicenseKey(options);

      const ep = resolveEndpoint('setup.licensing.activate');
      let data;
      try {
        data = await client.post(ep.path, { service: ep.service, body: { license_key: licenseKey } });
      } catch (err) {
        // The 409 body is { error: 'seat_taken'|'seat_limit_reached', ... }
        // with no `message`. Say what the caller can DO, and name the box
        // holding the seat, instead of "Request failed with status 409".
        throw enrichLicenseError(err);
      }

      const lease = data.lease || {};
      const summary = {
        license_id: lease.license_id || null,
        entitlements: lease.entitlements || [],
        lease_expires_at: lease.expires_at || null,
        ...boundServerFields(lease, data),
      };
      formatDetail(summary, { format: program.opts().output, title: 'Licence activated' });
    });

  // LICENSE-LAUNCH LL-8-dash: activation with nothing pasted into the box.
  // The instance asks quox.ai for a code pair (through the auth service, so
  // the device_code never leaves the server), prints the short code and the
  // link, and polls until a logged-in customer approves it. Nothing prompts:
  // this is meant to run in a boot script on a headless instance.
  license
    .command('link')
    .description('Activate this instance by approving a short code on quox.ai (no key paste)')
    .action(async () => {
      auth.requireAuth();
      const json = program.opts().output === 'json';
      const emit = (event) => { if (json) console.log(JSON.stringify(event)); };

      const startEp = resolveEndpoint('setup.licensing.device.start');
      let started;
      try {
        started = await client.post(startEp.path, { service: startEp.service, body: {} });
      } catch (err) {
        throw enrichLicenseError(err);
      }

      const deviceCode = started.device_code;
      if (!deviceCode || !started.user_code) {
        throw new QuoxApiError(502, 'malformed_device_start',
          'The instance did not return an activation code pair. Check that it can reach the licence server.');
      }

      let interval = Number(started.interval) > 0 ? Number(started.interval) : DEFAULT_LINK_INTERVAL_SECONDS;
      const expiresIn = Number(started.expires_in) > 0 ? Number(started.expires_in) : 900;
      const deadline = Date.now() + expiresIn * 1000;

      emit({
        state: 'started',
        user_code: started.user_code,
        verification_url: started.verification_url || null,
        expires_in: expiresIn,
        interval,
      });

      if (!json) {
        printInfo(`Open ${started.verification_url || 'https://quox.ai/link'} and enter this code:`);
        console.log('');
        console.log(chalk.bold.cyan(`    ${started.user_code}`));
        console.log('');
        printInfo(`The code is good for ${Math.round(expiresIn / 60)} minutes. Waiting for approval...`);
      }

      const pollEp = resolveEndpoint('setup.licensing.device.poll');
      let lastState = 'started';

      while (Date.now() < deadline) {
        await sleepFn(interval * 1000);

        let result;
        try {
          result = await client.post(pollEp.path, {
            service: pollEp.service,
            body: { device_code: deviceCode, interval },
          });
        } catch (err) {
          // 503 means quox.ai blipped, NOT that the activation died: the code
          // is still live upstream and the customer may still be approving it.
          // Anything else (409 seat_limit_reached, 403, 400) is terminal.
          if (err instanceof QuoxApiError && err.status === 503) {
            if (lastState !== 'unreachable') {
              emit({ state: 'unreachable', message: err.message });
              if (!json) printInfo('The licence server is unreachable right now. Still waiting...');
              lastState = 'unreachable';
            }
            continue;
          }
          throw enrichLicenseError(err);
        }

        const state = result.state || 'pending';

        if (state === 'slow_down') {
          interval = Number(result.interval) > 0 ? Number(result.interval) : interval + 5;
        } else if (Number(result.interval) > 0) {
          interval = Number(result.interval);
        }

        if (state !== lastState) {
          emit({ state, interval, ...(result.error ? { error: result.error } : {}) });
          lastState = state;
        }

        if (state === 'approved') {
          const lease = result.lease || {};
          emit({ state: 'approved', lease });
          if (!json) {
            formatDetail({
              license_id: lease.license_id || null,
              entitlements: lease.entitlements || [],
              lease_expires_at: lease.expires_at || null,
            }, { format: program.opts().output, title: 'Licence activated' });
            printSuccess('This instance is activated. No key was ever pasted into it.');
          }
          return;
        }

        if (state === 'denied') {
          throw new QuoxApiError(403, 'access_denied',
            'The activation was denied on quox.ai. Nothing was activated on this instance.');
        }
        if (state === 'expired') {
          throw new QuoxApiError(410, 'expired_token',
            'The code expired before it was approved. Run `quox setup license link` again for a fresh one.');
        }
        if (state === 'consumed') {
          throw new QuoxApiError(409, 'consumed',
            'That code was already used. Run `quox setup license link` again for a fresh one.');
        }
        if (state === 'activation_failed') {
          throw new QuoxApiError(502, result.error || 'activation_failed',
            `The approval landed but the licence could not be stored on this instance: ${result.message || result.error || 'unknown error'}. `
            + 'Run `quox setup license link` again.');
        }
        if (state === 'error') {
          throw new QuoxApiError(502, result.error || 'device_poll_failed',
            result.message || 'Device activation failed.');
        }
      }

      throw new QuoxApiError(410, 'expired_token',
        'The code expired before it was approved. Run `quox setup license link` again for a fresh one.');
    });

  license
    .command('status')
    .description('Show this instance licence state: entitlements, lease expiry, freshness')
    .action(async () => {
      auth.requireAuth();
      // Same read the dashboard licence gate uses
      // (src/services/licenseValidator.js -> GET /api/setup/licensing/entitlements):
      // verified, instance-bound, unexpired leases only.
      const ep = resolveEndpoint('setup.licensing.entitlements.list');
      let data;
      try {
        data = await client.get(ep.path, { service: ep.service });
      } catch (err) {
        throw enrichLicenseError(err);
      }

      const now = Date.now();
      const licenses = (data.licenses || []).map((row) => {
        const leaseExpiry = Date.parse(row.lease_expires_at);
        let leaseStatus = 'unknown';
        if (Number.isFinite(leaseExpiry)) {
          const hours = Math.round((leaseExpiry - now) / 3600000);
          leaseStatus = hours > 0 ? `fresh, renews within ${hours}h` : `stale, expired ${Math.abs(hours)}h ago`;
        }
        return {
          license_id: row.license_id,
          entitlements: row.entitlements || [],
          expires_at: row.expires_at || null,
          lease_expires_at: row.lease_expires_at || null,
          lease_status: leaseStatus,
        };
      });

      const summary = {
        activated: licenses.length > 0,
        instance_id: data.instance_id || null,
        entitlements: data.entitlements || [],
        licenses,
      };

      // LICENSE-LAUNCH LL-4c: the response carries the signed product catalogue
      // (display metadata, present only once the owner installs the artifact
      // generated on quox.ai) and the LL-3b org bands. Both are rendered as
      // ADDITIVE fields: absent server-side means absent here, never a guessed
      // tier or a fabricated band, and every pre-existing field is untouched so
      // scripts parsing --json keep working.
      const catalogTiers = new Map(
        (Array.isArray(data.catalog) ? data.catalog : [])
          .filter((row) => row && typeof row.id === 'string' && row.tier)
          .map((row) => [row.id, row.tier])
      );
      if (catalogTiers.size > 0) {
        summary.entitlement_tiers = summary.entitlements.map((id) => {
          const tier = catalogTiers.get(id);
          return tier ? `${id} (${tier})` : id;
        });
      }

      const bands = (data.org_bands && typeof data.org_bands === 'object') ? data.org_bands : {};
      const bandIds = Object.keys(bands);
      if (bandIds.length > 0) {
        if (data.org_id) summary.org_id = data.org_id;
        summary.org_bands = bandIds.map((id) => {
          const band = bands[id] || {};
          // org_licensed is tri-state: true/false for a caller with org
          // context, null for an instance-scoped session (see hasPlugin).
          const state = band.org_licensed === true ? 'this org licensed'
            : band.org_licensed === false ? 'this org NOT licensed'
              : 'no org context';
          return `${id}: ${band.assigned_count ?? 0} of ${band.allowance ?? 0} orgs (${state})`;
        });
      }

      formatDetail(summary, { format: program.opts().output, title: 'Licence Status' });
    });

  license
    .command('deactivate')
    .description('Release this instance seat so the licence can be activated elsewhere')
    .option('--license-id <id>', 'licence to release (required when several are held)')
    .option('--yes', 'skip the confirmation prompt (for boot scripts and CI)')
    .action(async (options) => {
      auth.requireAuth();

      let licenseId = options.licenseId;
      if (!licenseId) {
        const readEp = resolveEndpoint('setup.licensing.entitlements.list');
        let state;
        try {
          state = await client.get(readEp.path, { service: readEp.service });
        } catch (err) {
          throw enrichLicenseError(err);
        }
        const held = state.licenses || [];
        if (held.length === 0) {
          throw new QuoxValidationError('No active license on this instance, so there is no seat to release.');
        }
        if (held.length > 1) {
          throw new QuoxValidationError(
            `This instance holds ${held.length} licences (${held.map(l => l.license_id).join(', ')}). `
            + 'Pass --license-id <id> to say which seat to release.'
          );
        }
        licenseId = held[0].license_id;
      }

      const confirmed = await confirmDestructive(
        program,
        { force: options.yes },
        `Release the seat for ${licenseId} on this instance?`
      );
      if (!confirmed) {
        printInfo('Aborted.');
        return;
      }

      const ep = resolveEndpoint('setup.licensing.deactivate');
      let data;
      try {
        data = await client.post(ep.path, { service: ep.service, body: { license_id: licenseId } });
      } catch (err) {
        throw enrichLicenseError(err);
      }
      printSuccess(
        data.remote
          ? `Seat released for ${licenseId} (control plane updated).`
          : `Seat released locally for ${licenseId}. The control plane was not reachable, so the seat may still be held remotely.`
      );
    });
}

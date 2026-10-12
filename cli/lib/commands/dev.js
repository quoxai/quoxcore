/**
 * Dev commands — DEVSUITE-HUB Phase 2.
 *
 * `quox dev enable` is the CLI surface for the "register as dev server"
 * trigger: constructs, signs, and delivers a quoxagent dev.CapabilityProfile
 * onto a target fleet host via the collector's
 * POST /api/internal/dev-profiles/enable (see
 * services/collector/lib/devCapabilityProfileIssuer.js). Only
 * `dev.register` is granted by default, matching what's real today in
 * quoxagent's dev plugin family (internal/plugins/dev) — pass
 * `--capabilities` to grant additional dev.* names.
 */

import { formatDetail, formatOutput, printSuccess, printWarning, printInfo } from '../core/output.js';
import { shortLicenceLabel, matchesLicenceFilter } from './skillRightsFormat.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxApiError } from '../core/errors.js';
import { registerDevSupervisorCommands } from './devSupervisor.js';
import { registerDevResidentCommands } from './devResident.js';

export function registerDevCommands(program, ctx) {
  const { client, auth, config } = ctx;

  const dev = program
    .command('dev')
    .description('Manage dev-mode (DEVSUITE) fleet hosts');

  dev
    .command('enable')
    .description('Register a fleet host as a dev server (signs + delivers a quoxagent capability profile)')
    .argument('<hostId>', 'target host_id (matches the running quoxagent\'s agent.host_id)')
    .option('--capabilities <list>', 'comma-separated dev.* capability names (default: dev.register)')
    .option('--max-concurrent-sessions <n>', 'max concurrent dev.sessions tmux sessions', (v) => parseInt(v, 10))
    .option('--ttl-seconds <n>', 'profile expiry, in seconds from now (default: no expiry)', (v) => parseInt(v, 10))
    .option('--no-wait-pack', 'do not wait for the skill-pack install to be confirmed')
    .action(async (hostId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      // fleet #472: the collector's dev-enable admin gate evaluates the
      // JWT's ACTIVE org, not the org named by --org, so a mismatched flag
      // is silently mischecked and 403s even the target org's own owner.
      // Until the server gate can check membership in the TARGET org,
      // reject the mismatch loudly and name the working path.
      const flagOrg = program.opts().org;
      const sessionOrg = auth.getOrgId();
      if (flagOrg && sessionOrg && flagOrg !== sessionOrg) {
        throw new Error(
          `--org ${flagOrg} differs from your active org context (${sessionOrg}). ` +
          `The dev-enable admin check runs against the ACTIVE org, so this request would 403 ` +
          `even for the target org's owner (fleet #472). ` +
          `Run 'quox org switch ${flagOrg}' first, then re-run dev enable.`
        );
      }

      const body = { host_id: hostId, org_id: orgId };
      // quox#455: tell the provisioner which edge URL this working admin
      // session actually uses, so the resident bootstrap lands with a real
      // instance_url. A loopback hostname is fine to send: the collector
      // swaps it for the host-reachable address server-side.
      const enableBaseUrl = typeof config.getBaseUrl === 'function' ? config.getBaseUrl() : null;
      if (enableBaseUrl) body.instance_url = enableBaseUrl;
      if (options.capabilities) {
        body.capabilities = options.capabilities.split(',').map((c) => c.trim()).filter(Boolean);
      }
      if (Number.isInteger(options.maxConcurrentSessions)) {
        body.max_concurrent_sessions = options.maxConcurrentSessions;
      }
      if (Number.isInteger(options.ttlSeconds)) {
        body.ttl_seconds = options.ttlSeconds;
      }

      const endpoint = resolveEndpoint('v1.dev.profiles.enable');
      let data;
      try {
        data = await client.post(endpoint.path, { service: endpoint.service, body });
      } catch (err) {
        // quoxbastion#12 / quox#588: against a bastion in approval mode 'risky'
        // the collector relays a "present a collector-signed
        // X-Bastion-Approval-Grant" refusal, but there is no CLI path yet to
        // mint/present that grant. Turn the dead-end 502 into an actionable
        // failure rather than a raw relayed error the operator can't act on.
        const detail = `${err?.message || ''} ${(() => { try { return JSON.stringify(err?.body || ''); } catch { return ''; } })()}`;
        if (/X-Bastion-Approval-Grant|approval required/i.test(detail)) {
          printWarning(`Bastion is in approval mode 'risky': dev enable needs a collector-signed approval grant, and the CLI cannot mint or present one yet.`);
          printInfo(`Known gap, tracked as quoxai/quox#588 (and quoxbastion#12) — the HITL grant-mint + auto-retry path is not built.`);
          printInfo(`Until it ships, a bastion/org admin can lower this bastion's approval mode below 'risky', then re-run:`);
          printInfo(`  quox dev enable ${hostId}`);
        }
        throw err;
      }

      formatDetail(data, { format: program.opts().output, title: `Dev profile delivered to ${hostId}` });
      if (data && data.delivered) {
        printSuccess(`${hostId} registered as a dev server (capabilities: ${(data.capabilities || []).join(', ')}).`);
      }

      // 2026-08-19: DELIVERED IS NOT LIVE. quoxagent loads the signed dev
      // capability profile ONCE AT STARTUP (internal/agent/agent.go, see
      // LoadDevCapabilityProfile) with no reload and no watch, so a profile
      // that lands on disk is not adopted until the agent restarts. This
      // command happily printed "registered as a dev server (capabilities:
      // dev.register, dev.build, dev.sessions, dev.plan)" while the host went
      // on reporting the previous three, on a heartbeat seconds old. The
      // capability pill did not render and nothing said why.
      //
      // Exactly the bug the skill-pack block below was written to kill, one
      // layer up: "success" meant the WRITE succeeded, never that the thing
      // took effect. So do what that block does — go and look.
      if (data && data.delivered && Array.isArray(data.capabilities) && data.capabilities.length) {
        const signed = [...data.capabilities].sort();
        let adopted = null;
        try {
          const listEp = resolveEndpoint('v1.dev.servers.list');
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 5000));
            let list = null;
            try {
              // org_id is REQUIRED: the dev-servers handler fails closed rather
              // than falling back to an unscoped list (fixed 2026-08-19, it used
              // to list across orgs). Omitting it here got a refusal, which this
              // block then reported as "registry unreadable".
              list = await client.get(listEp.path, { service: listEp.service, query: { org_id: orgId } });
            } catch { list = null; }
            const rows = Array.isArray(list?.servers) ? list.servers : [];
            const row = rows.find((h) => (h.host_id || h.hostId) === hostId);
            const caps = row && (row.enabled_capabilities || row.enabledCapabilities);
            const parsed = typeof caps === 'string' ? JSON.parse(caps) : caps;
            if (Array.isArray(parsed)) {
              adopted = [...parsed].sort();
              if (signed.every((c) => adopted.includes(c))) break;
            }
          }
        } catch { adopted = null; }

        if (adopted === null) {
          console.error(`Could not confirm ${hostId} adopted the new profile (registry unreadable). Verify with: quox dev doctor ${hostId}`);
        } else {
          const missing = signed.filter((c) => !adopted.includes(c));
          if (missing.length) {
            // Phase 7: the collector restarts the agent itself now (see
            // agent_refresh in the response), so a lingering mismatch means
            // either the restart was deferred for live sessions, or
            // something on the host is genuinely wrong.
            const refresh = data.agent_refresh || {};
            if (refresh.deferred_live_sessions > 0) {
              console.error(
                `NOT LIVE YET: ${hostId} still reports [${adopted.join(', ')}]. The agent restart was deferred because ` +
                `${refresh.deferred_live_sessions} live session(s) would die with it. The profile and binary are delivered; ` +
                `the next agent restart adopts them. Force it when the sessions are done:\n` +
                `  systemctl --user restart quoxagent   (user service on dev VMs)\n` +
                `Then confirm with: quox dev doctor ${hostId}`
              );
            } else {
              // #462 (footgun 4, exampleestate-website 2026-08-22): the most
              // common cause of delivered+restarted+still-empty is the agent
              // being UNABLE TO VERIFY the profile: the signing-key fetch
              // needs org/collector/service-key env in the unit. The
              // collector's verifier-env leg stamps the two non-secret vars
              // and reports whether the seam key file exists; name that
              // diagnosis here instead of sending the operator to the
              // journal blind.
              let hint = `Check the agent journal on the host, then: quox dev doctor ${hostId}`;
              if (refresh.seam_key === 'missing') {
                hint = `DIAGNOSIS: the host has no seam service key file, so the agent cannot fetch the org signing key ` +
                  `and cannot verify the profile (profile_verified stays false). Provision the key file the env drop-in ` +
                  `points at (see quoxpert-dev-servers footgun 4), then restart the agent.`;
              } else if (refresh.verifier_env === 'error') {
                hint = `DIAGNOSIS: stamping the signing-key-fetch env onto the unit failed (${refresh.verifier_env_error || 'unknown'}). ` +
                  `Without QUOXAGENT_ORG_ID and QUOXAGENT_COLLECTOR_URL in the agent unit the profile cannot be verified.`;
              }
              console.error(
                `NOT LIVE: ${hostId} still reports [${adopted.join(', ')}] and has not adopted [${missing.join(', ')}] ` +
                `even though the enable ${refresh.restarted ? 'restarted the agent' : 'could not restart the agent'} ` +
                `(agent_refresh: ${JSON.stringify(refresh)}). ${hint}`
              );
            }
          } else {
            printSuccess(`Host has adopted the profile: ${adopted.join(', ')}.`);
          }
        }
      }

      // DEVSUITE-SKILLS P6f: the pack install fires async behind enable, and
      // "success" used to mean only the profile landed — the arg-limit bug
      // shipped broken packs behind a green enable for exactly that reason.
      // Poll the durable pack status until confirmed (or say plainly that it
      // is not confirmed and name the follow-up verb).
      if (data && data.delivered && options.waitPack !== false) {
        const statusEp = resolveEndpoint('v1.dev.skills.status', { hostId });
        const deadline = Date.now() + 90000;
        process.stdout.write('Waiting for skill-pack install confirmation');
        let pack = null;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          process.stdout.write('.');
          try {
            pack = await client.get(statusEp.path, { service: statusEp.service });
          } catch { pack = null; }
          if (pack && pack.status && pack.status !== 'unknown') break;
        }
        process.stdout.write('\n');
        if (pack && (pack.status === 'current' || pack.installedVersion)) {
          printSuccess(`Skill pack v${pack.installedVersion || '?'} confirmed on ${hostId} (${pack.status}).`);
        } else {
          console.error(`Skill pack NOT confirmed on ${hostId} within 90s — the profile is live, the pack is not proven. Check with: quox dev skills status ${hostId} (or force it: quox dev skills sync ${hostId})`);
        }
      }
    });

  // QUOXPERTICUS P5: skill-pack parity (the pack routes existed with no verb).
  const skills = dev
    .command('skills')
    .description('Dev skill-pack delivery (signed core dev pack)');

  skills
    .command('status')
    .description('Show the installed pack version/hash on a dev host vs current, with SkillRights labels')
    .argument('<hostId>', 'target host_id')
    .option('--rights [licence]', 'list per-skill SkillRights declarations; optionally filter by open|notrain|reserved|undeclared or a full identifier')
    .action(async (hostId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.dev.skills.status', { hostId });
      const data = await client.get(ep.path, { service: ep.service });

      // SKILLRIGHTS #478 phase 11 (pricing-free): rights are load-bearing
      // data, so render them deliberately rather than dumping the raw
      // object. Summary always; per-skill table behind --rights, with an
      // optional licence filter (the CLI half of the marketplace's
      // "licence filter").
      const { rights, installedRights, ...core } = data;
      formatDetail(core, { format: program.opts().output, title: `Skill pack status: ${hostId}` });
      if (rights) {
        const byLicence = Object.entries(rights.byLicense || {})
          .map(([id, n]) => `${shortLicenceLabel(id)} x${n}`)
          .join(', ');
        printInfo(`Rights: ${rights.declared}/${rights.total} declared${byLicence ? ` (${byLicence})` : ''}${rights.undeclared ? `, ${rights.undeclared} undeclared` : ''}.`);
      }
      if (options.rights) {
        const filter = typeof options.rights === 'string' ? options.rights : null;
        const entries = (rights && rights.entries) || [];
        const rows = entries
          .filter((e) => matchesLicenceFilter(e.license, filter))
          .map((e) => ({ skill: e.ref, licence: shortLicenceLabel(e.license) }));
        formatOutput({
          columns: ['skill', 'licence'],
          headers: ['Skill', 'Licence'],
          rows,
        }, { format: program.opts().output, emptyMessage: filter ? `No skills matching licence filter '${filter}'.` : 'No rights entries.' });
        if (installedRights && Array.isArray(installedRights)) {
          const drifted = entries.length !== installedRights.length
            || entries.some((e) => {
              const got = installedRights.find((i) => i.ref === e.ref);
              return !got || got.license !== e.license;
            });
          if (drifted) printWarning('Declared rights differ from what this host RECEIVED at last confirmed sync (installedRights); re-sync to update the host-side rights manifest.');
        }
      }
    });

  skills
    .command('sync')
    .description('Install or update the signed core dev pack on a dev host')
    .argument('<hostId>', 'target host_id')
    .action(async (hostId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.dev.skills.sync', { hostId });
      let data;
      try {
        data = await client.post(ep.path, { service: ep.service, body: {} });
      } catch (err) {
        // SKILLRIGHTS #478 Phase 11: under the require-acceptance policy the
        // collector refuses the download until a person has accepted the
        // terms. Name the exact command rather than leaving a bare 409: an
        // unactionable refusal is how a governance control becomes a thing
        // people route around.
        if (err && err.body && err.body.error === 'acceptance_required') {
          printWarning(`Refused: nobody in this org has accepted the current terms for pack '${err.body.packId}'.`);
          printInfo(`Accept them (as a user, not a service credential), then re-run the sync:`);
          printInfo(`  quox dev skills accept ${err.body.packId}`);
          printInfo(`  quox dev skills sync ${hostId}`);
        }
        throw err;
      }
      const { rightsNotice, ...detail } = data;
      formatDetail(detail, { format: program.opts().output, title: `Skill pack sync: ${hostId}` });
      // The distribution terms travel with every sync (phase 11 contract
      // enforcement): show them, do not bury them in the JSON.
      if (rightsNotice) printInfo(rightsNotice);
    });

  // SKILLRIGHTS #478 Phase 11 — AFFIRMATIVE ACCEPTANCE. The whole point of
  // this command is that a human reads the terms and says yes: it PRINTS the
  // terms in full, then requires an interactive confirmation or an explicit
  // --i-accept. It never accepts silently, and a service credential is
  // refused server-side (user_assent_required), so automation cannot stand in
  // for a person here.
  skills
    .command('accept')
    .description('Read the QuoxSkills distribution terms for a pack and record your acceptance of them')
    .argument('<packId>', 'pack id (e.g. quox-core-dev-pack)')
    .option('--i-accept', 'accept without the interactive prompt (still records YOU as the accepting user)')
    .action(async (packId, options) => {
      auth.requireAuth();

      const offerEp = resolveEndpoint('skills.acceptance.offer', { packId });
      const offer = await client.get(offerEp.path, { service: offerEp.service });

      // The terms, in full. Not a link, not a summary: an acceptance of text
      // the actor was never shown is not evidence of anything.
      printInfo(`Terms for pack '${offer.packId}'${offer.packVersion ? ` (version ${offer.packVersion})` : ''}:`);
      console.log('');
      console.log(offer.termsBytes);
      console.log('');

      const rights = offer.rights || {};
      const byLicence = Object.entries(rights.byLicense || {})
        .map(([id, n]) => `${shortLicenceLabel(id)} x${n}`)
        .join(', ');
      printInfo(`Declared rights: ${rights.declared ?? 0}/${rights.total ?? 0} declared${byLicence ? ` (${byLicence})` : ''}${rights.undeclared ? `, ${rights.undeclared} undeclared` : ''}.`);
      printInfo(`Pack content hash: ${offer.contentHash}`);
      printInfo(`Declared rights hash: ${offer.rightsSha256}`);
      printInfo(`Terms hash: ${offer.termsSha256} (presentation ${offer.presentationVersion})`);

      if (!options.iAccept) {
        const { default: inquirer } = await import('inquirer');
        const ans = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Do you accept these terms, on behalf of your organisation, for exactly this pack content?`,
          default: false,
        }]);
        if (!ans.confirm) {
          printInfo('Not accepted. Nothing was recorded.');
          return;
        }
      }

      const recordEp = resolveEndpoint('skills.acceptance.record');
      const result = await client.post(recordEp.path, {
        service: recordEp.service,
        body: {
          challenge: offer.challenge,
          termsSha256: offer.termsSha256,
          contentHash: offer.contentHash,
          rightsSha256: offer.rightsSha256,
        },
      });

      printSuccess(`Acceptance recorded (id ${result.acceptanceId}).`);
      // The honest claim, verbatim from the server, plus its limits. No
      // surface may say more than this sentence says.
      printInfo(result.honestClaim);
      if (result.claimLimits) printInfo(result.claimLimits);
      if (!result.envelopeId) {
        printWarning('No evidence envelope was recorded for this acceptance (transcript storage disabled?). The acceptance row stands; the AEE reference does not.');
      }
    });

  // SLOTS-TMUX step B: interactive tmux sessions on a dev host. quoxagent's
  // five dev.sessions methods had NO caller (note #2877): no collector route,
  // no quox verb. These are the verbs. Each one is a single short signed
  // envelope delivered over Bastion; the session itself lives on the host's
  // tmux server between calls, so it survives detach and outlives any one
  // command here.
  const sessions = dev
    .command('sessions')
    .description('Interactive tmux sessions on a dev host (survive detach; drive with send/pane)');

  sessions
    .command('list')
    .description('List live tmux sessions on a dev host')
    .argument('<hostId>', 'target host_id')
    .action(async (hostId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.dev.sessions.list', { hostId });
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output, title: `tmux sessions: ${hostId}` });
    });

  sessions
    .command('new')
    .description('Create a tmux session on a dev host')
    .argument('<hostId>', 'target host_id')
    .option('--name <name>', 'session name (default: agent-generated)')
    .option('--backend <backend>', 'what runs in the pane: shell | claude | codex', 'shell')
    .action(async (hostId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('v1.dev.sessions.new', { hostId });
      const body = { backend: options.backend };
      if (options.name) body.name = options.name;
      const data = await client.post(ep.path, { service: ep.service, body });
      formatDetail(data, { format: program.opts().output, title: `tmux session created on ${hostId}` });
      if (data && data.session_id) {
        printSuccess(`Session ${data.session_id} (${data.name || 'unnamed'}) is live. Drive it with:`);
        printInfo(`  quox dev sessions send ${hostId} ${data.session_id} "<command>"`);
        printInfo(`  quox dev sessions pane ${hostId} ${data.session_id}`);
      }
    });

  // quox#451: `new --name X` makes X the tmux session NAME, but send/pane/kill
  // resolved only the agent's internal id, so reusing the name you just typed
  // 422'd "session not found". On exactly that refusal, retry once by name.
  // An explicit --by-name skips straight to the name lookup, as before.
  async function withNameFallback(byName, call) {
    try {
      return await call(byName);
    } catch (err) {
      const said = [err && err.message, err && err.code, err && err.body && err.body.error].filter(Boolean).join(' ');
      if (!byName && err instanceof QuoxApiError && err.status === 422 && /session not found/i.test(said)) {
        return call(true);
      }
      throw err;
    }
  }

  sessions
    .command('send')
    .description('Send one line of input to a session (Enter is appended)')
    .argument('<hostId>', 'target host_id')
    .argument('<sessionId>', 'session id from `new` or `list` (or tmux name with --by-name)')
    .argument('<keys>', 'the line to type into the pane')
    .option('--by-name', 'treat the identifier as the tmux session NAME (orphaned sessions have no id)')
    .action(async (hostId, sessionId, keys, options) => {
      auth.requireAuth();
      const data = await withNameFallback(!!options.byName, (byName) => {
        const ep = resolveEndpoint('v1.dev.sessions.keys', { hostId, sessionId, byName });
        return client.post(ep.path, { service: ep.service, body: { keys } });
      });
      if (data && data.sent) printSuccess(`Sent to ${sessionId} on ${hostId}.`);
      else formatDetail(data, { format: program.opts().output });
    });

  sessions
    .command('pane')
    .description('Read the current pane contents of a session')
    .argument('<hostId>', 'target host_id')
    .argument('<sessionId>', 'session id (or tmux session name with --by-name)')
    .option('--by-name', 'treat the identifier as the tmux session NAME (orphaned sessions have no id)')
    .action(async (hostId, sessionId, options) => {
      auth.requireAuth();
      const data = await withNameFallback(!!options.byName, (byName) => {
        const ep = resolveEndpoint('v1.dev.sessions.pane', { hostId, sessionId, byName });
        return client.get(ep.path, { service: ep.service });
      });
      if (program.opts().output === 'json') {
        formatDetail(data, { format: 'json' });
      } else {
        // The pane IS the output: print it raw, trailing blank lines trimmed.
        process.stdout.write(String(data && data.pane || '').replace(/\n+$/, '') + '\n');
      }
    });

  sessions
    .command('kill')
    .description('Kill a tmux session on a dev host')
    .argument('<hostId>', 'target host_id')
    .argument('<sessionId>', 'session id (or tmux session name with --by-name)')
    .option('--by-name', 'treat the identifier as the tmux session NAME (orphaned sessions have no id)')
    .action(async (hostId, sessionId, options) => {
      auth.requireAuth();
      const data = await withNameFallback(!!options.byName, (byName) => {
        const ep = resolveEndpoint('v1.dev.sessions.kill', { hostId, sessionId, byName });
        return client.delete(ep.path, { service: ep.service });
      });
      if (data && data.killed) printSuccess(`Session ${sessionId} killed on ${hostId}.`);
      else formatDetail(data, { format: program.opts().output });
    });

  // DEVSUITE phase 9: "a quox dev doctor verb (pack version, rules block, MCP
  // health, session freshness) so 'is it even taking?' has a product answer".
  //
  // The question this exists to kill: an operator runs `quox dev enable`, gets
  // a success line, and then has no way to tell whether the host is actually a
  // working dev server. Every check below reads REAL registry state and reports
  // what it found; nothing is inferred from the enable having returned 200,
  // because a 200 from the enable is exactly the evidence that was already
  // insufficient.
  //
  // Read-only by construction. A doctor that changes things cannot be run
  // freely when you are unsure, which is precisely when you want to run it.
  dev
    .command('doctor')
    .description('Check whether a host is really working as a dev server')
    .argument('[hostId]', 'target host_id (default: every registered dev server)')
    .action(async (hostId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const listEp = resolveEndpoint('v1.dev.servers.list');
      const list = await client.get(listEp.path, { service: listEp.service, query: { org_id: orgId } });
      const all = Array.isArray(list?.servers) ? list.servers : [];
      const targets = hostId ? all.filter((s) => s.host_id === hostId) : all;

      if (hostId && targets.length === 0) {
        // Do not say "unhealthy": the host is not registered to this org at
        // all, which is a different problem with a different fix.
        printWarning(`${hostId} is not a registered dev server for this org.`);
        printInfo('  Register it with `quox dev enable ' + hostId + '`.');
        return;
      }
      if (targets.length === 0) {
        printWarning('No dev servers are registered for this org.');
        return;
      }

      const report = [];
      for (const s of targets) {
        const findings = [];

        // 1. Did the signed capability profile verify? An unverified profile
        //    means the host is registered but not trusted to act.
        if (!s.profile_verified) findings.push('profile not verified');

        // 2. Is it still beating? A host that registered once and went quiet
        //    looks identical to a working one in a plain listing.
        const ageMs = s.last_seen_at ? Date.now() - Number(s.last_seen_at) : null;
        const staleMin = ageMs === null ? null : Math.round(ageMs / 60000);
        if (staleMin === null) findings.push('never seen');
        else if (staleMin > 15) findings.push(`last seen ${staleMin}m ago`);

        // 3. Did anything actually get enabled? A profile with no capabilities
        //    is a dev server that can do nothing.
        const enabled = Array.isArray(s.enabled_capabilities) ? s.enabled_capabilities : [];
        if (enabled.length === 0) findings.push('no capabilities enabled');

        // 3b. Did resident identity provisioning (quox#453 phase 15) land?
        //    A host with capabilities enabled but no resident identity can
        //    still deliver profiles, but nothing that needs the resident
        //    keypair (host-native signing) works. resident_state is only
        //    checked when the host has capabilities at all, matching #3's
        //    gate: an unenabled host has nothing resident identity is for
        //    yet.
        if (enabled.length > 0 && s.resident_state !== 'provisioned') {
          let finding = 'resident identity not provisioned (re-run quox dev enable)';
          if (s.resident_state === 'failed' && s.resident_detail) {
            finding += ` (${s.resident_detail})`;
          }
          findings.push(finding);
        }

        // 4. Is the skill pack on and current? This is the half of "enable"
        //    that silently does not happen, and the reason the verb exists.
        let pack = null;
        try {
          const packEp = resolveEndpoint('v1.dev.skills.status', { hostId: s.host_id });
          pack = await client.get(packEp.path, { service: packEp.service });
          if (pack?.status === 'missing') findings.push('skill pack not installed');
          else if (pack?.drifted) findings.push(`skill pack v${pack.installedVersion} behind v${pack.currentVersion}`);
        } catch (err) {
          // Unknown, not broken. Saying "pack missing" because a probe failed
          // is the class of lie this whole verb is meant to prevent.
          findings.push(`skill pack status unknown (${err.message})`);
        }

        // 5. Headless supervisor (quox#453 phase 15 follow-on, DEVSUITE-
        //    DEVMODE) — read-only status line, NOT a health finding. Most
        //    hosts legitimately run with the supervisor off; the switch is a
        //    human decision (server-side requireHumanAdmin() gate on the
        //    write endpoint, `quox dev supervisor` doctor's write-free
        //    sibling), not something this read-only verb should flag as a
        //    problem either way.
        let supervisor = null;
        try {
          const supEp = resolveEndpoint('v1.dev.supervisor.get', { hostId: s.host_id });
          const sup = await client.get(supEp.path, { service: supEp.service });
          supervisor = { enabled: !!sup?.enabled, slot: sup?.slot || null };
        } catch (err) {
          // Unknown, not off. Same "don't invent a finding from a probe
          // failure" posture as the skill-pack status check above.
          supervisor = { enabled: null, slot: null, error: err.message };
        }

        report.push({
          host_id: s.host_id,
          healthy: findings.length === 0,
          capabilities: enabled.length,
          pack: pack ? (pack.status || 'unknown') : 'unknown',
          last_seen_minutes: staleMin,
          supervisor,
          findings,
        });
      }

      if (program.opts().output === 'json') {
        formatDetail({ dev_servers: report }, { format: 'json' });
        return;
      }

      for (const r of report) {
        if (r.healthy) {
          printSuccess(`${r.host_id}: ready (${r.capabilities} capabilities, pack ${r.pack})`);
        } else {
          printWarning(`${r.host_id}: ${r.findings.length} problem${r.findings.length === 1 ? '' : 's'}`);
          for (const f of r.findings) printInfo(`  - ${f}`);
        }
        const sup = r.supervisor;
        if (sup && sup.error) {
          printInfo(`  supervisor: unknown (${sup.error})`);
        } else if (sup && sup.enabled) {
          printInfo(`  supervisor: enabled${sup.slot ? ` (slot ${sup.slot})` : ''}`);
        } else {
          printInfo('  supervisor: disabled');
        }
      }
    });

  // DEVSUITE-DEVMODE (quox#453 phase 15 follow-on) — `quox dev supervisor`
  // (see lib/commands/devSupervisor.js). Headless: a resident agent answers
  // its slot channel with no interactive session open.
  registerDevSupervisorCommands(dev, ctx);

  // QUOXPERTICUS-REVISIT P3 — `quox dev resident` (see
  // lib/commands/devResident.js). A FULL INTERACTIVE claude session as the
  // resident, not the headless supervisor above: deploy/reboot/retire it
  // through the governed tmux + slots planes, no ssh.
  registerDevResidentCommands(dev, ctx);
}

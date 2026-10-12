/**
 * `quox dev resident`, QUOXPERTICUS-REVISIT P3 "Resident lifecycle v1".
 *
 * Deploy/reboot a FULL INTERACTIVE claude session as the resident of a dev
 * host, without anyone ssh-ing, using ONLY existing governed surfaces:
 *   - the governed tmux plane (`quox dev sessions`, dev.js/devSessionsProxy.js)
 *   - the slots checkout/assign plane (`quox slot`, devSlotsStore.js)
 *   - the seed prompt template (lib/core/residentSeed.js), which encodes the
 *     proven 2026-09-04 revival recipe: read the revival kit before acting,
 *     claim the slot, then say a short hello.
 *
 * deploy: POST tmux new (backend: claude) -> wait for the pane to answer ->
 *   inject the seed prompt via the keys route (chunked if it overflows one
 *   line's 4096-char cap) -> slot checkout (--create, holder_kind
 *   interactive, holder_session = the tmux session id) -> best-effort
 *   assigned_to earmark (`v1.slots.assign`) naming the resident identity
 *   (`resident:<hostId>`, the same identity buildSelfIdentity() gives the
 *   headless supervisor, so both lifecycles name the same logical resident).
 * reboot: release the slot, kill the tmux session, then run deploy again.
 * retire: release the slot and kill the tmux session; no redeploy.
 * status: read-only — tmux presence, a pane tail, and the slot's hold state.
 * seed: render (or --print) the seed prompt with no network call at all.
 */

import { formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';
import { loadResidentProfile } from '../core/residentAuth.js';
import { buildSelfIdentity } from '../core/supervisorEngine.js';
import { renderSeedPrompt, chunkSeedText } from '../core/residentSeed.js';

const PANE_TAIL_LINES = 15;

function loadResidentProfileSafely(explicitPath) {
  try {
    return loadResidentProfile(explicitPath);
  } catch {
    return null;
  }
}

function resolveHostId(options) {
  const profile = loadResidentProfileSafely(options.residentProfile);
  const hostId = options.host || profile?.host_id || null;
  if (!hostId) {
    throw new Error('No host id: pass --host <hostId>, or provision a resident bootstrap profile with host_id.');
  }
  return hostId;
}

// A resident's slot defaults to a host-named slot ("one resident slot per
// host") when neither --slot nor the resident bootstrap profile names one —
// this never throws, unlike devSupervisor's resolveSlotName, because a
// resident deploy is meant to work from a bare --host on a fresh box before
// any profile exists.
function resolveSlotName(options, hostId) {
  const profile = loadResidentProfileSafely(options.residentProfile);
  return options.slot || profile?.slot || hostId;
}

function defaultSessionName(slotName) {
  return `resident-${slotName}`;
}

export function registerDevResidentCommands(dev, ctx) {
  const { client, auth, program } = ctx;

  const resident = dev
    .command('resident')
    .description('Deploy/reboot a full interactive claude session as a dev host\'s resident (governed tmux + slots, no ssh)');

  const sleepFn = ctx.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const waitAttempts = Number.isInteger(ctx.waitAttempts) ? ctx.waitAttempts : 5;
  const waitDelayMs = Number.isInteger(ctx.waitDelayMs) ? ctx.waitDelayMs : 2000;

  /** Poll the pane until the new session answers, or give up after waitAttempts. */
  async function waitForSession({ hostId, sessionId }) {
    let lastErr = null;
    for (let i = 0; i < waitAttempts; i++) {
      try {
        const ep = resolveEndpoint('v1.dev.sessions.pane', { hostId, sessionId });
        await client.get(ep.path, { service: ep.service });
        return;
      } catch (err) {
        lastErr = err;
        if (i < waitAttempts - 1) await sleepFn(waitDelayMs);
      }
    }
    throw new Error(
      `session ${sessionId} on ${hostId} never answered a pane read after ${waitAttempts} attempt(s)`
      + (lastErr ? `: ${lastErr.message}` : '')
    );
  }

  /** Send the seed prompt, chunked across multiple keys calls if it overflows one line. */
  async function sendSeed({ hostId, sessionId, seedText }) {
    const chunks = chunkSeedText(seedText);
    for (const chunk of chunks) {
      const ep = resolveEndpoint('v1.dev.sessions.keys', { hostId, sessionId });
      await client.post(ep.path, { service: ep.service, body: { keys: chunk } });
    }
    return chunks.length;
  }

  async function deploy(options) {
    auth.requireAuth();
    const orgId = resolveOrgId(auth, program);
    const hostId = resolveHostId(options);
    const slotName = resolveSlotName(options, hostId);
    const sessionName = options.sessionName || defaultSessionName(slotName);

    const newEp = resolveEndpoint('v1.dev.sessions.new', { hostId });
    const newData = await client.post(newEp.path, {
      service: newEp.service,
      body: { name: sessionName, backend: 'claude' },
    });
    const sessionId = newData && newData.session_id;
    if (!sessionId) {
      throw new Error(`tmux new-session on ${hostId} did not return a session_id (got: ${JSON.stringify(newData)})`);
    }

    await waitForSession({ hostId, sessionId });

    const seedText = renderSeedPrompt({ hostId, slotName, overrideText: ctx.seedOverrideText });
    const seedChunksSent = await sendSeed({ hostId, sessionId, seedText });

    const checkoutEp = resolveEndpoint('v1.slots.checkout', { name: slotName });
    const checkoutData = await client.post(checkoutEp.path, {
      service: checkoutEp.service,
      body: {
        holder_session: sessionId, holder_kind: 'interactive', host_id: hostId,
        org_id: orgId, create: true, force: options.force === true,
      },
    });

    const identity = buildSelfIdentity(hostId);
    let assignedTo = null;
    try {
      const assignEp = resolveEndpoint('v1.slots.assign', { name: slotName });
      await client.post(assignEp.path, { service: assignEp.service, body: { assigned_to: identity, org_id: orgId } });
      assignedTo = identity;
    } catch (err) {
      // The earmark is a nicety (who this slot belongs to when free), never
      // the thing that makes the resident live. A failure here must not
      // undo an already-successful deploy.
      printWarning(`Could not set the assigned_to earmark for ${slotName} (deploy still succeeded): ${err.message}`);
    }

    return {
      host_id: hostId,
      slot_name: slotName,
      session_id: sessionId,
      session_name: sessionName,
      seed_chunks_sent: seedChunksSent,
      assigned_to: assignedTo,
      slot: checkoutData && checkoutData.slot || checkoutData,
    };
  }

  /** Release the slot (best-effort) then kill the tmux session (best-effort). Shared by reboot + retire. */
  async function releaseAndKill(options) {
    const orgId = resolveOrgId(auth, program);
    const hostId = resolveHostId(options);
    const slotName = resolveSlotName(options, hostId);
    const sessionName = options.sessionName || defaultSessionName(slotName);

    try {
      const releaseEp = resolveEndpoint('v1.slots.release', { name: slotName });
      await client.post(releaseEp.path, { service: releaseEp.service, body: { org_id: orgId, force: true } });
    } catch (err) {
      printWarning(`Releasing ${slotName} failed (continuing): ${err.message}`);
    }

    try {
      const killEp = resolveEndpoint('v1.dev.sessions.kill', { hostId, sessionId: sessionName, byName: true });
      await client.delete(killEp.path, { service: killEp.service });
    } catch (err) {
      printWarning(`Killing tmux session ${sessionName} on ${hostId} failed (continuing): ${err.message}`);
    }

    return { host_id: hostId, slot_name: slotName, session_name: sessionName };
  }

  resident
    .command('deploy')
    .description('Deploy a fresh interactive resident: tmux new (claude) -> seed prompt -> slot checkout')
    .option('--host <hostId>', 'target host_id (default: resident bootstrap profile)')
    .option('--slot <name>', 'slot to claim (default: resident bootstrap profile, else the host_id itself)')
    .option('--session-name <n>', 'tmux session name (default: resident-<slot>)')
    .option('--force', 'take the slot even if assigned to another session')
    .option('--resident-profile <path>', 'resident bootstrap profile path')
    .action(async (options) => {
      const report = await deploy(options);
      formatDetail(report, { format: program.opts().output, title: `Resident deployed on ${report.host_id}` });
      printSuccess(
        `Resident live on ${report.host_id}: tmux session ${report.session_id} (${report.session_name}), `
        + `slot ${report.slot_name} held.`
      );
      printInfo(`  quox dev resident status --host ${report.host_id} --slot ${report.slot_name}`);
    });

  resident
    .command('status')
    .description('Read-only: tmux presence, a pane tail, and the slot hold state')
    .option('--host <hostId>', 'target host_id (default: resident bootstrap profile)')
    .option('--slot <name>', 'slot (default: resident bootstrap profile, else the host_id itself)')
    .option('--session-name <n>', 'tmux session name (default: resident-<slot>)')
    .option('--resident-profile <path>', 'resident bootstrap profile path')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const hostId = resolveHostId(options);
      const slotName = resolveSlotName(options, hostId);
      const sessionName = options.sessionName || defaultSessionName(slotName);

      let sessions = [];
      try {
        const listEp = resolveEndpoint('v1.dev.sessions.list', { hostId });
        const data = await client.get(listEp.path, { service: listEp.service });
        sessions = (data && data.sessions) || [];
      } catch (err) {
        printWarning(`Could not list tmux sessions on ${hostId}: ${err.message}`);
      }
      const match = sessions.find((s) => s.name === sessionName) || null;

      let paneTail = null;
      if (match) {
        try {
          const paneEp = resolveEndpoint('v1.dev.sessions.pane', {
            hostId, sessionId: match.session_id || sessionName, byName: !match.session_id,
          });
          const paneData = await client.get(paneEp.path, { service: paneEp.service });
          const lines = String((paneData && paneData.pane) || '').split('\n');
          paneTail = lines.slice(-PANE_TAIL_LINES).join('\n');
        } catch (err) {
          printWarning(`Could not read pane for ${sessionName} on ${hostId}: ${err.message}`);
        }
      }

      let slotRow = null;
      try {
        const slotsEp = resolveEndpoint('v1.slots.list');
        const slotsData = await client.get(slotsEp.path, { service: slotsEp.service, query: { org_id: orgId } });
        slotRow = ((slotsData && slotsData.slots) || []).find((s) => s.name === slotName) || null;
      } catch (err) {
        printWarning(`Could not read slot ${slotName}: ${err.message}`);
      }

      const report = {
        host_id: hostId,
        slot_name: slotName,
        session_name: sessionName,
        session_present: !!match,
        session: match,
        pane_tail: paneTail,
        slot: slotRow,
      };
      formatDetail(report, { format: program.opts().output, title: `Resident status: ${hostId}` });

      if (match) printSuccess(`  tmux session ${sessionName} is live on ${hostId}.`);
      else printWarning(`  tmux session ${sessionName} was not found on ${hostId}.`);
      if (slotRow && slotRow.state === 'held') printSuccess(`  slot ${slotName} is held by ${slotRow.holder_session}.`);
      else printWarning(`  slot ${slotName} is not held.`);
      if (paneTail) printInfo(`  pane tail:\n${paneTail}`);
    });

  resident
    .command('reboot')
    .description('Release the slot, kill the tmux session, then redeploy')
    .option('--host <hostId>', 'target host_id (default: resident bootstrap profile)')
    .option('--slot <name>', 'slot (default: resident bootstrap profile, else the host_id itself)')
    .option('--session-name <n>', 'tmux session name (default: resident-<slot>)')
    .option('--force', 'take the slot even if assigned to another session, on redeploy')
    .option('--resident-profile <path>', 'resident bootstrap profile path')
    .action(async (options) => {
      auth.requireAuth();
      await releaseAndKill(options);
      const report = await deploy(options);
      formatDetail(report, { format: program.opts().output, title: `Resident rebooted on ${report.host_id}` });
      printSuccess(`Resident rebooted on ${report.host_id}: tmux session ${report.session_id}, slot ${report.slot_name} held.`);
    });

  resident
    .command('retire')
    .description('Release the slot and kill the tmux session; does not redeploy')
    .option('--host <hostId>', 'target host_id (default: resident bootstrap profile)')
    .option('--slot <name>', 'slot (default: resident bootstrap profile, else the host_id itself)')
    .option('--session-name <n>', 'tmux session name (default: resident-<slot>)')
    .option('--resident-profile <path>', 'resident bootstrap profile path')
    .action(async (options) => {
      auth.requireAuth();
      const report = await releaseAndKill(options);
      formatDetail(report, { format: program.opts().output, title: `Resident retired on ${report.host_id}` });
      printSuccess(`Resident retired on ${report.host_id}: slot ${report.slot_name} released, session ${report.session_name} killed.`);
    });

  resident
    .command('seed')
    .description('Render the seed prompt for a host/slot (no network call)')
    .option('--host <hostId>', 'target host_id (default: resident bootstrap profile)')
    .option('--slot <name>', 'slot (default: resident bootstrap profile, else the host_id itself)')
    .option('--print', 'print the raw seed text (default behavior; explicit for scripting clarity)')
    .option('--resident-profile <path>', 'resident bootstrap profile path')
    .action((options) => {
      const hostId = resolveHostId(options);
      const slotName = resolveSlotName(options, hostId);
      const text = renderSeedPrompt({ hostId, slotName, overrideText: ctx.seedOverrideText });
      if (program.opts().output === 'json' && !options.print) {
        formatDetail({ host_id: hostId, slot_name: slotName, seed: text, chunks: chunkSeedText(text).length }, { format: 'json' });
      } else {
        process.stdout.write(`${text}\n`);
      }
    });
}
